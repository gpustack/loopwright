import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { types } from 'node:util';
import {
  OVERLAY_LIMITS,
  SecretScrubber,
  VERIFIER_ARTIFACT_LIMITS,
  digestArtifact,
  digestArtifactFromMetadata,
  validateRelativePath,
  type ArtifactRef,
} from '@loopwright/core';
import type { StateResult } from '@loopwright/state';
import { ControllerFailure, refuse, type ControllerDiagnostic } from './errors.js';
import {
  STREAM_CHUNK_BYTES,
  canonicalComponents,
  inside,
  readBoundedFile,
  streamRegularFile,
  writeAllToHandle,
} from './files.js';
import { canonical, checkedRef, hash, isRecord, same } from './schema.js';
export { checkedRef };
import type { ControllerOwner } from './ownership.js';
import type { CredentialVault } from './credentials.js';

const EMPTY_SHA256_HEX = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface VerifiedCasSeal {
  readonly blobPath: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly sha256: string;
  readonly gitOid: string | null;
  readonly objectFormat: 'sha1' | 'sha256';
}

export interface PutCasBlobOptions {
  readonly gitObjectFormat?: 'sha1' | 'sha256' | undefined;
}

export interface IngestVerifiedCasBlobOptions {
  readonly logicalName: string;
  readonly expectedSha256: string;
  readonly expectedByteLength: number;
  readonly mediaType?: string | null | undefined;
  readonly maxBytes?: number | undefined;
  readonly phase?: ControllerDiagnostic['phase'] | undefined;
  readonly extraSecrets?: Iterable<string> | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: (() => void | Promise<void>) | undefined;
}

export const MAX_EXTRA_SECRET_LENGTH = 4_096;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const MARKER_TMP_FILE_RE = /\.(?:binding|proof|reconcile-receipt)\.json\.tmp-[0-9a-f]{12,64}$/;

function deriveExtraSecretBuffers(
  extraSecrets: Iterable<string> | undefined,
  scrubber: SecretScrubber,
  phase: ControllerDiagnostic['phase'],
): readonly Buffer[] {
  if (extraSecrets === undefined) return Object.freeze([]);
  const formSet = new Set<string>();
  for (const secret of extraSecrets) {
    if (typeof secret !== 'string' || secret.length === 0) continue;
    if (secret.length > MAX_EXTRA_SECRET_LENGTH || LONE_SURROGATE_RE.test(secret)) {
      refuse('CONFIG_CREDENTIAL_INVALID', '/spec/credentials', phase);
    }
    scrubber.register(secret);
    const jsonEscaped = JSON.stringify(secret).slice(1, -1);
    const candidates = [
      secret,
      jsonEscaped,
      jsonEscaped.replaceAll('/', '\\/'),
      encodeURIComponent(secret),
      Buffer.from(secret, 'utf8').toString('base64'),
    ];
    for (const form of candidates) {
      if (form.length > 0 && (form === secret || form.length >= 8)) {
        formSet.add(form);
      }
    }
  }
  return Object.freeze([...formSet].map(form => Buffer.from(form, 'utf8')));
}

export function createBinarySecretStreamScanner(
  vault: CredentialVault,
  logicalName: string,
  phase: ControllerDiagnostic['phase'],
  extraSecrets?: Iterable<string>,
): {
  readonly push: (chunk: Uint8Array) => void;
  readonly finish: () => void;
  readonly overlapBytes: number;
  readonly maxObservedWindowBytes: number;
} {
  const vaultChecker = vault.createStreamChecker();
  const scrubber = new SecretScrubber();
  const extraFormBuffers = deriveExtraSecretBuffers(extraSecrets, scrubber, phase);
  const maxFormBytes = extraFormBuffers.reduce((max, buf) => Math.max(max, buf.byteLength), 0);
  const overlap = Math.min(262_144, Math.max(16_384, maxFormBytes, vaultChecker.overlapBytes ?? 16_384));
  const maxWindowSlice = STREAM_CHUNK_BYTES - overlap;
  let carryTail: Buffer = Buffer.alloc(0);
  let maxWindowBytes = 0;

  const hasRegisteredOrGenericSecret = (windowBuf: Buffer): boolean => {
    if (extraFormBuffers.some(form => windowBuf.includes(form))) return true;
    if (scrubber.containsSecret(windowBuf.toString('latin1'))) return true;
    if (scrubber.containsSecret(windowBuf.toString('utf8'))) return true;
    return false;
  };

  return Object.freeze({
    overlapBytes: overlap,
    get maxObservedWindowBytes(): number {
      return Math.max(maxWindowBytes, vaultChecker.maxObservedWindowBytes ?? 0);
    },
    push: (chunk: Uint8Array): void => {
      if (chunk.byteLength === 0) return;
      const view = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      for (let offset = 0; offset < view.byteLength; offset += maxWindowSlice) {
        const sub = view.subarray(offset, Math.min(view.byteLength, offset + maxWindowSlice));
        try {
          vaultChecker.push(sub);
        } catch (error) {
          if (carryTail.byteLength > 0) carryTail.fill(0);
          carryTail = Buffer.alloc(0);
          if (error instanceof ControllerFailure && error.diagnostic.code === 'CONFIG_CREDENTIAL_INVALID') {
            refuse('ARTIFACT_INVALID', logicalName, phase);
          }
          throw error;
        }
        const combined = carryTail.byteLength === 0 ? sub : Buffer.concat([carryTail, sub]);
        if (combined.byteLength > maxWindowBytes) {
          maxWindowBytes = combined.byteLength;
        }
        if (hasRegisteredOrGenericSecret(combined)) {
          if (carryTail.byteLength > 0) carryTail.fill(0);
          carryTail = Buffer.alloc(0);
          refuse('ARTIFACT_INVALID', logicalName, phase);
        }
        const keep = Math.min(overlap, combined.byteLength);
        if (carryTail.byteLength > 0) carryTail.fill(0);
        carryTail = Buffer.from(combined.subarray(combined.byteLength - keep));
      }
    },
    finish: (): void => {
      const tail = carryTail;
      carryTail = Buffer.alloc(0);
      try {
        try {
          vaultChecker.finish();
        } catch (error) {
          if (error instanceof ControllerFailure && error.diagnostic.code === 'CONFIG_CREDENTIAL_INVALID') {
            refuse('ARTIFACT_INVALID', logicalName, phase);
          }
          throw error;
        }
        if (tail.byteLength > maxWindowBytes) {
          maxWindowBytes = tail.byteLength;
        }
        if (tail.byteLength > 0 && hasRegisteredOrGenericSecret(tail)) {
          refuse('ARTIFACT_INVALID', logicalName, phase);
        }
      } finally {
        if (tail.byteLength > 0) tail.fill(0);
      }
    },
  });
}

export interface CasBlobPointer {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly blobRef: ArtifactRef;
  readonly verifiedSeal?: VerifiedCasSeal | undefined;
}

export interface CasBlobVerificationTarget {
  readonly name?: string | undefined;
  readonly sha256: string;
  readonly byteLength: number;
  readonly uri?: string | null | undefined;
  readonly path?: string | undefined;
  readonly blobRef?: ArtifactRef | undefined;
}

export function stateValue<T>(result: StateResult<T>): T {
  if (result.ok) return result.value;
  const code = result.error.commit === 'unknown' || /CLOCK/.test(result.error.code) ? 'RECOVERY_REQUIRED' : /OWNER|AUTHORITY/.test(result.error.code) ? 'AUTHORITY_REFUSED'
    : /DEADLINE/.test(result.error.code) ? 'DEADLINE' : /BUDGET|LIMIT/.test(result.error.code) ? 'BUDGET_EXHAUSTED' : 'STATE_UNAVAILABLE';
  refuse(code, '', 'recovery', { stateCode: result.error.code, effect: result.error.commit === 'unknown' ? 'possible' : 'none', retryable: result.error.retryable });
}

export async function privateDirectory(path: string, excluded: readonly string[] = []): Promise<void> {
  if (resolve(path) !== path || excluded.some(root => inside(path, resolve(root)))) refuse('ARTIFACT_INVALID', '', 'admission');
  await mkdir(path, { recursive: true, mode: 0o700 }); await canonicalComponents(path);
  const info = await lstat(path); if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o077) refuse('ARTIFACT_INVALID', '', 'admission');
}

export function parseCasUri(uri: string, phase: ControllerDiagnostic['phase'] = 'verification'): string {
  if (typeof uri !== 'string') refuse('ARTIFACT_INVALID', '', phase);
  const match = /^cas:\/\/sha256\/([0-9a-f]{64})$/.exec(uri);
  if (!match) refuse('ARTIFACT_INVALID', '', phase);
  return match[1]!;
}

export async function resolveCanonicalCasBlobPath(
  artifactsDir: string,
  sha256Hex: string,
  hintedPath?: string,
  phase: ControllerDiagnostic['phase'] = 'verification',
): Promise<string> {
  if (
    typeof artifactsDir !== 'string'
    || !isAbsolute(artifactsDir)
    || resolve(artifactsDir) !== artifactsDir
    || typeof sha256Hex !== 'string'
    || !/^[0-9a-f]{64}$/.test(sha256Hex)
  ) {
    refuse('ARTIFACT_INVALID', '', phase);
  }
  const canonicalPath = join(artifactsDir, 'blobs', 'sha256', sha256Hex);
  if (!inside(canonicalPath, artifactsDir) || canonicalPath === artifactsDir) {
    refuse('ARTIFACT_INVALID', '', phase);
  }
  if (hintedPath !== undefined) {
    if (typeof hintedPath !== 'string' || !isAbsolute(hintedPath) || resolve(hintedPath) !== canonicalPath) {
      refuse('ARTIFACT_INVALID', '', phase);
    }
  }
  try {
    await canonicalComponents(canonicalPath, true);
  } catch {
    refuse('ARTIFACT_INVALID', '', phase);
  }
  return canonicalPath;
}

async function streamVerifiedCasBlobWithSummary(
  artifactsDir: string,
  pointer: CasBlobVerificationTarget,
  onChunk?: (chunk: Uint8Array) => Promise<void> | void,
  phase: ControllerDiagnostic['phase'] = 'verification',
  gitObjectFormat?: 'sha1' | 'sha256' | undefined,
): Promise<{
  readonly canonicalBlobPath: string;
  readonly summary: import('./files.js').StreamedFileSummary;
  readonly gitOid: string | null;
}> {
  if (
    !isRecord(pointer)
    || typeof pointer.sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(pointer.sha256)
    || !Number.isSafeInteger(pointer.byteLength)
    || Object.is(pointer.byteLength, -0)
    || pointer.byteLength < 0
    || pointer.byteLength > OVERLAY_LIMITS.maxMaxBytes
    || (pointer.byteLength === 0) !== (pointer.sha256 === EMPTY_SHA256_HEX)
  ) {
    refuse('ARTIFACT_INVALID', '', phase);
  }
  if (pointer.name !== undefined && !validateRelativePath(pointer.name).ok) {
    refuse('ARTIFACT_INVALID', '', phase);
  }
  const expectedUri = 'cas://sha256/' + pointer.sha256;
  if (pointer.uri !== undefined && pointer.uri !== expectedUri) {
    refuse('ARTIFACT_INVALID', '', phase);
  }
  if (pointer.blobRef !== undefined) {
    if (!isRecord(pointer.blobRef)) refuse('ARTIFACT_INVALID', '', phase);
    for (const key of Reflect.ownKeys(pointer.blobRef)) {
      if (typeof key !== 'string' || !['name', 'digest', 'byteLength', 'uri', 'mediaType'].includes(key)) {
        refuse('ARTIFACT_INVALID', '', phase);
      }
    }
    const refMetadata = {
      digest: pointer.blobRef.digest,
      byteLength: pointer.blobRef.byteLength,
      ...(pointer.blobRef.uri !== undefined ? { uri: pointer.blobRef.uri } : {}),
      ...(pointer.blobRef.mediaType !== undefined ? { mediaType: pointer.blobRef.mediaType } : {}),
    };
    const refCheck = digestArtifactFromMetadata(pointer.blobRef.name, refMetadata);
    if (
      !refCheck.ok
      || pointer.blobRef.digest.algorithm !== 'sha256'
      || pointer.blobRef.digest.hex !== pointer.sha256
      || pointer.blobRef.byteLength !== pointer.byteLength
      || (pointer.blobRef.uri !== undefined && pointer.blobRef.uri !== expectedUri)
      || (pointer.name !== undefined && pointer.blobRef.name !== pointer.name)
    ) {
      refuse('ARTIFACT_INVALID', '', phase);
    }
  }

  const canonicalBlobPath = await resolveCanonicalCasBlobPath(artifactsDir, pointer.sha256, pointer.path, phase);
  let beforeStat: Awaited<ReturnType<typeof lstat>>;
  try {
    beforeStat = await lstat(canonicalBlobPath);
  } catch {
    refuse('ARTIFACT_INVALID', '', phase);
  }
  if (
    beforeStat.isSymbolicLink()
    || !beforeStat.isFile()
    || beforeStat.nlink !== 1
    || beforeStat.uid !== process.getuid?.()
    || (beforeStat.mode & 0o7777) !== 0o400
    || beforeStat.size !== pointer.byteLength
  ) {
    refuse('ARTIFACT_INVALID', '', phase);
  }
  const sha = createHash('sha256');
  const gitHasher =
    gitObjectFormat !== undefined
      ? createHash(gitObjectFormat).update(`blob ${pointer.byteLength}\0`, 'utf8')
      : null;
  const summary = await streamRegularFile(
    canonicalBlobPath,
    {
      expectedBytes: pointer.byteLength,
      maxBytes: OVERLAY_LIMITS.maxMaxBytes,
      owned: true,
      requireReadOnly: true,
      code: 'ARTIFACT_INVALID',
      limitCode: 'ARTIFACT_INVALID',
      phase,
    },
    async slice => {
      sha.update(slice);
      gitHasher?.update(slice);
      if (onChunk !== undefined) {
        await onChunk(slice);
      }
    },
  );
  if ((summary.rawMode & 0o7777) !== 0o400 || summary.dev !== beforeStat.dev || summary.ino !== beforeStat.ino || sha.digest('hex') !== pointer.sha256) {
    refuse('ARTIFACT_INVALID', '', phase);
  }
  return {
    canonicalBlobPath,
    summary,
    gitOid: gitHasher !== null ? gitHasher.digest('hex') : null,
  };
}

export async function streamVerifiedCasBlob(
  artifactsDir: string,
  pointer: CasBlobVerificationTarget,
  onChunk?: (chunk: Uint8Array) => Promise<void> | void,
  phase: ControllerDiagnostic['phase'] = 'verification',
): Promise<void> {
  await streamVerifiedCasBlobWithSummary(artifactsDir, pointer, onChunk, phase);
}

export async function syncDirectory(dirPath: string): Promise<void> {
  const dirHandle = await open(dirPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
}

export async function unlinkIfOwnedInode(targetPath: string, expectedDev: number, expectedIno: number): Promise<boolean> {
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (
    st.isSymbolicLink()
    || !st.isFile()
    || st.dev !== expectedDev
    || st.ino !== expectedIno
    || st.uid !== process.getuid?.()
  ) {
    return false;
  }
  try {
    await unlink(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function cleanMarkerTempFilesInDirectory(artifactsDir: string, owner: ControllerOwner): Promise<number> {
  await owner.assertCurrent();
  try {
    const info = await lstat(artifactsDir);
    if (info.isSymbolicLink() || !info.isDirectory()) refuse('ARTIFACT_INVALID', '', 'recovery');
  } catch (error) {
    if (error instanceof ControllerFailure) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    refuse('ARTIFACT_INVALID', '', 'recovery');
  }
  try {
    await canonicalComponents(artifactsDir, true);
  } catch {
    refuse('ARTIFACT_INVALID', '', 'recovery');
  }
  const entries = await readdir(artifactsDir);
  let removed = 0;
  for (const entry of entries) {
    if (!MARKER_TMP_FILE_RE.test(entry)) continue;
    const candidatePath = join(artifactsDir, entry);
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(candidatePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isSymbolicLink() && stat.isFile() && stat.uid === process.getuid?.()) {
      await unlink(candidatePath).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      removed++;
    }
  }
  if (removed > 0) {
    await syncDirectory(artifactsDir);
  }
  return removed;
}

export async function publishAtomicMarker(
  targetPath: string,
  value: unknown,
  vault: { assertClean: (value: Uint8Array | string | object) => void },
  phase: ControllerDiagnostic['phase'],
): Promise<void> {
  const bytes = Buffer.from(canonical(value), 'utf8');
  if (bytes.byteLength > 1_048_576) refuse('OUTPUT_LIMIT', '', phase);
  vault.assertClean(bytes);

  const parentDir = dirname(targetPath);
  const tmpPath = `${targetPath}.tmp-${randomBytes(16).toString('hex')}`;
  const tmpHandle = await open(
    tmpPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  let tmpClosed = false;
  let tmpUnlinked = false;
  let createdDev = -1;
  let createdIno = -1;

  try {
    const createdInfo = await tmpHandle.stat();
    createdDev = createdInfo.dev;
    createdIno = createdInfo.ino;
    if (
      !createdInfo.isFile()
      || createdInfo.isSymbolicLink()
      || createdInfo.uid !== process.getuid?.()
      || createdInfo.nlink !== 1
    ) {
      refuse('RECOVERY_REQUIRED', '', phase);
    }
    await writeAllToHandle(tmpHandle, bytes);
    await tmpHandle.sync();
    const sealedInfo = await tmpHandle.stat();
    if (
      !sealedInfo.isFile()
      || sealedInfo.isSymbolicLink()
      || sealedInfo.dev !== createdDev
      || sealedInfo.ino !== createdIno
      || sealedInfo.uid !== process.getuid?.()
      || sealedInfo.nlink !== 1
      || sealedInfo.size !== bytes.byteLength
      || (sealedInfo.mode & 0o7777) !== 0o600
    ) {
      refuse('RECOVERY_REQUIRED', '', phase);
    }

    const beforeLink = await lstat(tmpPath).catch(() => null);
    if (
      !beforeLink
      || beforeLink.isSymbolicLink()
      || !beforeLink.isFile()
      || beforeLink.dev !== createdDev
      || beforeLink.ino !== createdIno
    ) {
      tmpUnlinked = true;
      refuse('RECOVERY_REQUIRED', '', phase);
    }

    let linked = false;
    try {
      await link(tmpPath, targetPath);
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    if (linked) {
      await unlinkIfOwnedInode(tmpPath, createdDev, createdIno);
      tmpUnlinked = true;
      let verifyHandle: Awaited<ReturnType<typeof open>> | null = null;
      try {
        verifyHandle = await open(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        const committed = await verifyHandle.stat();
        const pinned = await tmpHandle.stat();
        if (
          !committed.isFile()
          || committed.isSymbolicLink()
          || committed.dev !== createdDev
          || committed.ino !== createdIno
          || committed.uid !== process.getuid?.()
          || committed.nlink !== 1
          || committed.size !== bytes.byteLength
          || (committed.mode & 0o7777) !== 0o600
          || pinned.dev !== createdDev
          || pinned.ino !== createdIno
          || pinned.nlink !== 1
        ) {
          if (committed.dev === createdDev && committed.ino === createdIno && committed.uid === process.getuid?.()) {
            await unlinkIfOwnedInode(targetPath, createdDev, createdIno);
          }
          refuse('RECOVERY_REQUIRED', '', phase);
        }
      } finally {
        if (verifyHandle) await verifyHandle.close().catch(() => {});
      }
      await tmpHandle.close();
      tmpClosed = true;
      await syncDirectory(parentDir);
      return;
    }

    await tmpHandle.close();
    tmpClosed = true;
    await unlinkIfOwnedInode(tmpPath, createdDev, createdIno);
    tmpUnlinked = true;

    // If an interrupted prior publish left a sibling .tmp-* hardlink (nlink === 2), drop only sibling .tmp-* links.
    const existingStat = await lstat(targetPath).catch(() => null);
    if (existingStat && !existingStat.isSymbolicLink() && existingStat.isFile() && existingStat.nlink > 1) {
      const basePrefix = basename(targetPath) + '.tmp-';
      const siblings = await readdir(parentDir).catch(() => [] as string[]);
      for (const sib of siblings) {
        if (sib.startsWith(basePrefix) && MARKER_TMP_FILE_RE.test(sib)) {
          await unlinkIfOwnedInode(join(parentDir, sib), existingStat.dev, existingStat.ino);
        }
      }
    }

    let existingBytes: Buffer;
    try {
      existingBytes = await readBoundedFile(targetPath, 1_048_576, true, 0o600);
    } catch {
      refuse('RECOVERY_REQUIRED', '', phase);
    }
    if (!Buffer.from(existingBytes).equals(bytes)) {
      refuse('RECOVERY_REQUIRED', '', phase);
    }
    await syncDirectory(parentDir);
  } finally {
    if (!tmpClosed) {
      await tmpHandle.close().catch(() => {});
    }
    if (!tmpUnlinked && createdDev !== -1) {
      await unlinkIfOwnedInode(tmpPath, createdDev, createdIno).catch(() => {});
    }
  }
}

/** Atomically replaces an existing controller marker JSON file via fsynced temp + rename + parent dir sync. */
export async function overwriteAtomicMarker(
  targetPath: string,
  value: unknown,
  vault: { assertClean: (value: Uint8Array | string | object) => void },
  phase: ControllerDiagnostic['phase'],
): Promise<void> {
  const bytes = Buffer.from(canonical(value), 'utf8');
  if (bytes.byteLength > 1_048_576) refuse('OUTPUT_LIMIT', '', phase);
  vault.assertClean(bytes);

  const parentDir = dirname(targetPath);
  const tmpPath = `${targetPath}.tmp-${randomBytes(16).toString('hex')}`;
  const tmpHandle = await open(
    tmpPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  let tmpClosed = false;
  let renamed = false;
  let createdDev = -1;
  let createdIno = -1;
  try {
    const initStat = await tmpHandle.stat();
    createdDev = initStat.dev;
    createdIno = initStat.ino;
    if (!initStat.isFile() || initStat.uid !== process.getuid?.() || initStat.nlink !== 1) {
      refuse('RECOVERY_REQUIRED', '', phase);
    }
    await writeAllToHandle(tmpHandle, bytes);
    await tmpHandle.sync();
    const sealedInfo = await tmpHandle.stat();
    if (
      !sealedInfo.isFile()
      || sealedInfo.isSymbolicLink()
      || sealedInfo.dev !== createdDev
      || sealedInfo.ino !== createdIno
      || sealedInfo.uid !== process.getuid?.()
      || sealedInfo.nlink !== 1
      || sealedInfo.size !== bytes.byteLength
      || (sealedInfo.mode & 0o7777) !== 0o600
    ) {
      refuse('RECOVERY_REQUIRED', '', phase);
    }
    await rename(tmpPath, targetPath);
    renamed = true;
    let verifyHandle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      verifyHandle = await open(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const committed = await verifyHandle.stat();
      const pinned = await tmpHandle.stat();
      if (
        !committed.isFile()
        || committed.isSymbolicLink()
        || committed.dev !== createdDev
        || committed.ino !== createdIno
        || committed.uid !== process.getuid?.()
        || committed.nlink !== 1
        || committed.size !== bytes.byteLength
        || (committed.mode & 0o7777) !== 0o600
        || !pinned.isFile()
        || pinned.dev !== createdDev
        || pinned.ino !== createdIno
        || pinned.uid !== process.getuid?.()
        || pinned.nlink !== 1
        || pinned.size !== bytes.byteLength
        || (pinned.mode & 0o7777) !== 0o600
      ) {
        refuse('RECOVERY_REQUIRED', '', phase);
      }
    } catch (error) {
      if (error instanceof ControllerFailure) throw error;
      refuse('RECOVERY_REQUIRED', '', phase);
    } finally {
      if (verifyHandle) await verifyHandle.close().catch(() => {});
    }
    await tmpHandle.close();
    tmpClosed = true;
    await syncDirectory(parentDir);
  } finally {
    if (!tmpClosed) {
      await tmpHandle.close().catch(() => {});
    }
    if (!renamed && createdDev !== -1) {
      await unlinkIfOwnedInode(tmpPath, createdDev, createdIno).catch(() => {});
    }
  }
}

export async function cleanCasTempFilesInDirectory(artifactsDir: string, owner: ControllerOwner): Promise<number> {
  const markerRemoved = await cleanMarkerTempFilesInDirectory(artifactsDir, owner);
  await owner.assertCurrent();
  const blobsDir = join(artifactsDir, 'blobs');
  const sha256Dir = join(blobsDir, 'sha256');
  try {
    const info = await lstat(sha256Dir);
    if (info.isSymbolicLink() || !info.isDirectory()) refuse('ARTIFACT_INVALID', '', 'recovery');
  } catch (error) {
    if (error instanceof ControllerFailure) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return markerRemoved;
    refuse('ARTIFACT_INVALID', '', 'recovery');
  }
  try {
    await canonicalComponents(sha256Dir, true);
  } catch {
    refuse('ARTIFACT_INVALID', '', 'recovery');
  }
  const entries = await readdir(sha256Dir);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.startsWith('.tmp-')) continue;
    const candidatePath = join(sha256Dir, entry);
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(candidatePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isSymbolicLink() && stat.isFile() && stat.uid === process.getuid?.()) {
      await unlink(candidatePath).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      removed++;
    }
  }
  if (removed > 0) {
    await syncDirectory(sha256Dir);
  }
  return markerRemoved + removed;
}

export interface ArtifactReader { read(ref: ArtifactRef, maximum?: number): Promise<Uint8Array> }

export async function readArtifact(directory: string, unowned: ArtifactRef, maximum = 8388608): Promise<Uint8Array> {
  const ref = checkedRef(unowned); if (ref.name.length > 128 || ref.byteLength > maximum || maximum > 100_663_296) refuse('ARTIFACT_INVALID', '', 'recovery');
  try {
    const bytes = await readBoundedFile(join(directory, ref.name), maximum, true), actual = digestArtifact(ref.name, bytes);
    if (!actual.ok || !same(actual.value, ref)) refuse('ARTIFACT_INVALID', '', 'recovery'); return new Uint8Array(bytes);
  } catch (error) { if (error instanceof ControllerFailure && error.diagnostic.code === 'ARTIFACT_INVALID') throw error; refuse('ARTIFACT_INVALID', '', 'recovery'); }
}

export class ArtifactStore {
  constructor(readonly directory: string, readonly owner: ControllerOwner, readonly vault: CredentialVault) {}

  async put(kind: string, bytes: Uint8Array, maximum = 8388608): Promise<ArtifactRef> {
    await this.owner.assertCurrent();
    if (!/^[a-z][a-z0-9-]{0,23}$/.test(kind) || bytes.byteLength > maximum || maximum > 100_663_296) refuse('OUTPUT_LIMIT', '', 'execution');
    this.vault.assertClean(bytes);
    const name = kind + '-' + hash('loopwright.dev/controller/artifact/' + kind + '/v1\0' + hash(bytes).hex).hex + '.bin';
    const ref = digestArtifact(name, bytes); if (!ref.ok) refuse('ARTIFACT_INVALID', '', 'execution');
    let file: Awaited<ReturnType<typeof open>>;
    try { file = await open(join(this.directory, name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const known = await this.read(ref.value, maximum); if (!Buffer.from(known).equals(Buffer.from(bytes))) refuse('ARTIFACT_INVALID', '', 'recovery'); return ref.value;
    }
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await syncDirectory(this.directory);
    return ref.value;
  }

  json(kind: string, value: unknown, maximum = 65536): Promise<ArtifactRef> {
    return this.put(kind, Buffer.from(canonical(value)), maximum);
  }

  async read(unowned: ArtifactRef, maximum = 8388608): Promise<Uint8Array> {
    return readArtifact(this.directory, unowned, maximum);
  }

  async putCasBlobFromFile(
    logicalName: string,
    sourcePath: string,
    maxBytes: number = OVERLAY_LIMITS.maxMaxBytes,
    options?: PutCasBlobOptions,
  ): Promise<CasBlobPointer> {
    return this.#ingestCasBlob(logicalName, maxBytes, async consumeChunk => {
      await streamRegularFile(
        sourcePath,
        {
          maxBytes,
          code: 'ARTIFACT_INVALID',
          limitCode: 'OUTPUT_LIMIT',
          path: logicalName,
          phase: 'execution',
        },
        consumeChunk,
      );
    }, options);
  }

  async putCasBlobFromBytes(
    logicalName: string,
    bytes: Uint8Array,
    maxBytes: number = OVERLAY_LIMITS.maxMaxBytes,
    options?: PutCasBlobOptions,
  ): Promise<CasBlobPointer> {
    if (
      !ArrayBuffer.isView(bytes)
      || types.isProxy(bytes)
      || ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(bytes))
      || types.isSharedArrayBuffer(bytes.buffer)
    ) {
      refuse('ARTIFACT_INVALID', logicalName, 'execution');
    }
    const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return this.#ingestCasBlob(logicalName, maxBytes, async consumeChunk => {
      if (view.byteLength > maxBytes) refuse('OUTPUT_LIMIT', logicalName, 'execution');
      for (let offset = 0; offset < view.byteLength; offset += STREAM_CHUNK_BYTES) {
        await consumeChunk(view.subarray(offset, Math.min(view.byteLength, offset + STREAM_CHUNK_BYTES)));
      }
    }, options);
  }

  async tryReuseCasBlob(
    logicalName: string,
    sha256: string,
    expectedByteLength: number,
    options?: PutCasBlobOptions,
  ): Promise<CasBlobPointer | null> {
    await this.owner.assertCurrent();
    if (
      typeof sha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(sha256)
      || !Number.isSafeInteger(expectedByteLength)
      || Object.is(expectedByteLength, -0)
      || expectedByteLength < 0
      || expectedByteLength > OVERLAY_LIMITS.maxMaxBytes
      || (expectedByteLength === 0) !== (sha256 === EMPTY_SHA256_HEX)
    ) {
      refuse('ARTIFACT_INVALID', logicalName, 'execution');
    }
    const blobRefRes = digestArtifactFromMetadata(logicalName, {
      digest: { algorithm: 'sha256', hex: sha256 },
      byteLength: expectedByteLength,
      uri: 'cas://sha256/' + sha256,
    });
    if (!blobRefRes.ok) {
      refuse('ARTIFACT_INVALID', logicalName, 'execution');
    }

    const canonicalPath = join(this.directory, 'blobs', 'sha256', sha256);
    if (!inside(canonicalPath, this.directory) || canonicalPath === this.directory) {
      refuse('ARTIFACT_INVALID', logicalName, 'execution');
    }
    try {
      await lstat(canonicalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      refuse('ARTIFACT_INVALID', logicalName, 'execution');
    }

    const gitObjectFormat = options?.gitObjectFormat;
    const streamChecker = this.vault.createStreamChecker();
    let verified: Awaited<ReturnType<typeof streamVerifiedCasBlobWithSummary>>;
    try {
      verified = await streamVerifiedCasBlobWithSummary(
        this.directory,
        {
          name: logicalName,
          sha256,
          byteLength: expectedByteLength,
          uri: blobRefRes.value.uri,
          path: canonicalPath,
          blobRef: blobRefRes.value,
        },
        chunk => {
          streamChecker.push(chunk);
        },
        'execution',
        gitObjectFormat,
      );
      streamChecker.finish();
    } finally {
      streamChecker.finish();
    }

    const verifiedSeal: VerifiedCasSeal | undefined = gitObjectFormat !== undefined
      ? Object.freeze({
          blobPath: verified.canonicalBlobPath,
          dev: verified.summary.dev,
          ino: verified.summary.ino,
          size: verified.summary.byteLength,
          mtimeMs: verified.summary.mtimeMs,
          ctimeMs: verified.summary.ctimeMs,
          sha256,
          gitOid: verified.gitOid,
          objectFormat: gitObjectFormat,
        })
      : undefined;

    return Object.freeze({
      path: canonicalPath,
      sha256,
      byteLength: expectedByteLength,
      blobRef: blobRefRes.value,
      ...(verifiedSeal !== undefined ? { verifiedSeal } : {}),
    });
  }

  async cleanCasTempFiles(): Promise<number> {
    return cleanCasTempFilesInDirectory(this.directory, this.owner);
  }

  async #verifyExistingVerifierCasBlob(
    options: IngestVerifiedCasBlobOptions,
  ): Promise<{ readonly pointer: CasBlobPointer; readonly summary: import('./files.js').StreamedFileSummary } | null> {
    const phase = options.phase ?? 'verification';
    const maxBytes = options.maxBytes ?? VERIFIER_ARTIFACT_LIMITS.maxFileBytes;
    const { logicalName, expectedSha256, expectedByteLength, mediaType, extraSecrets } = options;
    await this.owner.assertCurrent();
    if (
      typeof expectedSha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(expectedSha256)
      || !Number.isSafeInteger(expectedByteLength)
      || Object.is(expectedByteLength, -0)
      || expectedByteLength < 0
      || expectedByteLength > maxBytes
      || maxBytes > VERIFIER_ARTIFACT_LIMITS.maxFileBytes
      || (expectedByteLength === 0) !== (expectedSha256 === EMPTY_SHA256_HEX)
    ) {
      refuse('ARTIFACT_INVALID', logicalName, phase);
    }
    const blobRefRes = digestArtifactFromMetadata(logicalName, {
      digest: { algorithm: 'sha256', hex: expectedSha256 },
      byteLength: expectedByteLength,
      uri: 'cas://sha256/' + expectedSha256,
      ...(mediaType !== undefined ? { mediaType } : {}),
    });
    if (!blobRefRes.ok) {
      refuse('ARTIFACT_INVALID', logicalName, phase);
    }
    const canonicalPath = join(this.directory, 'blobs', 'sha256', expectedSha256);
    if (!inside(canonicalPath, this.directory) || canonicalPath === this.directory) {
      refuse('ARTIFACT_INVALID', logicalName, phase);
    }
    try {
      const st = await lstat(canonicalPath);
      if (
        st.isSymbolicLink()
        || !st.isFile()
        || st.nlink !== 1
        || st.uid !== process.getuid?.()
        || (st.mode & 0o7777) !== 0o400
        || st.size !== expectedByteLength
      ) {
        refuse('ARTIFACT_INVALID', logicalName, phase);
      }
    } catch (error) {
      if (error instanceof ControllerFailure) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      refuse('ARTIFACT_INVALID', logicalName, phase);
    }
    if (options.signal?.aborted) {
      refuse('CANCELLED', '', phase);
    }
    if (options.onProgress) {
      await options.onProgress();
    }
    const scanner = createBinarySecretStreamScanner(this.vault, logicalName, phase, extraSecrets);
    let finished = false;
    let verified: Awaited<ReturnType<typeof streamVerifiedCasBlobWithSummary>>;
    try {
      verified = await streamVerifiedCasBlobWithSummary(
        this.directory,
        {
          name: logicalName,
          sha256: expectedSha256,
          byteLength: expectedByteLength,
          uri: blobRefRes.value.uri,
          path: canonicalPath,
          blobRef: blobRefRes.value,
        },
        async chunk => {
          if (options.signal?.aborted) {
            refuse('CANCELLED', '', phase);
          }
          if (options.onProgress) {
            await options.onProgress();
          }
          scanner.push(chunk);
        },
        phase,
      );
      if (options.signal?.aborted) {
        refuse('CANCELLED', '', phase);
      }
      if (options.onProgress) {
        await options.onProgress();
      }
      scanner.finish();
      finished = true;
    } finally {
      if (!finished) {
        try {
          scanner.finish();
        } catch {
          // Ignore cleanup error after failure.
        }
      }
    }
    return {
      pointer: Object.freeze({
        path: canonicalPath,
        sha256: expectedSha256,
        byteLength: expectedByteLength,
        blobRef: blobRefRes.value,
      }),
      summary: verified.summary,
    };
  }

  async verifyOrReuseVerifierCasBlob(options: IngestVerifiedCasBlobOptions): Promise<CasBlobPointer | null> {
    const verified = await this.#verifyExistingVerifierCasBlob(options);
    return verified ? verified.pointer : null;
  }

  async ingestVerifiedCasBlobStream(
    options: IngestVerifiedCasBlobOptions,
    streamSource: (consumeChunk: (chunk: Uint8Array) => Promise<void>) => Promise<void>,
  ): Promise<CasBlobPointer> {
    const phase = options.phase ?? 'verification';
    const maxBytes = options.maxBytes ?? VERIFIER_ARTIFACT_LIMITS.maxFileBytes;
    const { logicalName, expectedSha256, expectedByteLength, mediaType, extraSecrets } = options;
    await this.owner.assertCurrent();
    if (
      !Number.isSafeInteger(maxBytes)
      || Object.is(maxBytes, -0)
      || maxBytes < 0
      || maxBytes > VERIFIER_ARTIFACT_LIMITS.maxFileBytes
      || typeof expectedSha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(expectedSha256)
      || !Number.isSafeInteger(expectedByteLength)
      || Object.is(expectedByteLength, -0)
      || expectedByteLength < 0
      || expectedByteLength > maxBytes
      || (expectedByteLength === 0) !== (expectedSha256 === EMPTY_SHA256_HEX)
    ) {
      refuse('ARTIFACT_INVALID', logicalName, phase);
    }
    const blobRefRes = digestArtifactFromMetadata(logicalName, {
      digest: { algorithm: 'sha256', hex: expectedSha256 },
      byteLength: expectedByteLength,
      uri: 'cas://sha256/' + expectedSha256,
      ...(mediaType !== undefined ? { mediaType } : {}),
    });
    if (!blobRefRes.ok) {
      refuse('ARTIFACT_INVALID', logicalName, phase);
    }

    const blobsDir = join(this.directory, 'blobs');
    const sha256Dir = join(blobsDir, 'sha256');
    await privateDirectory(blobsDir);
    await privateDirectory(sha256Dir);

    // Fast path for already-sealed 0o400 CAS blobs: still stream, secret-scan, and SHA-256 verify the incoming
    // payload end-to-end, while binding return strictly to the originally verified inode + timestamps.
    const existingVerified = await this.#verifyExistingVerifierCasBlob(options);
    if (existingVerified !== null) {
      const dupScanner = createBinarySecretStreamScanner(this.vault, logicalName, phase, extraSecrets);
      const dupSha = createHash('sha256');
      let dupByteLength = 0;
      let dupFinished = false;
      try {
        await streamSource(async rawChunk => {
          if (rawChunk.byteLength === 0) return;
          for (let offset = 0; offset < rawChunk.byteLength; offset += STREAM_CHUNK_BYTES) {
            if (options.signal?.aborted) {
              refuse('CANCELLED', '', phase);
            }
            if (options.onProgress) {
              await options.onProgress();
            }
            const slice = rawChunk.subarray(offset, Math.min(rawChunk.byteLength, offset + STREAM_CHUNK_BYTES));
            dupByteLength += slice.byteLength;
            if (dupByteLength > expectedByteLength || dupByteLength > maxBytes) {
              refuse('ARTIFACT_INVALID', logicalName, phase);
            }
            dupScanner.push(slice);
            dupSha.update(slice);
          }
        });
        dupScanner.finish();
        dupFinished = true;
      } finally {
        if (!dupFinished) {
          try {
            dupScanner.finish();
          } catch {
            // Ignore cleanup error after failure.
          }
        }
      }
      if (dupByteLength !== expectedByteLength || dupSha.digest('hex') !== expectedSha256) {
        refuse('ARTIFACT_INVALID', logicalName, phase);
      }
      await this.owner.assertCurrent();
      const postSt = await lstat(existingVerified.pointer.path).catch(() => null);
      if (
        !postSt
        || postSt.isSymbolicLink()
        || !postSt.isFile()
        || postSt.nlink !== 1
        || postSt.uid !== process.getuid?.()
        || (postSt.mode & 0o7777) !== 0o400
        || postSt.size !== expectedByteLength
        || postSt.dev !== existingVerified.summary.dev
        || postSt.ino !== existingVerified.summary.ino
        || postSt.mtimeMs !== existingVerified.summary.mtimeMs
        || postSt.ctimeMs !== existingVerified.summary.ctimeMs
      ) {
        refuse('ARTIFACT_INVALID', logicalName, phase);
      }
      let verifyHandle: Awaited<ReturnType<typeof open>> | null = null;
      try {
        verifyHandle = await open(existingVerified.pointer.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const fdSt = await verifyHandle.stat();
        if (
          !fdSt.isFile()
          || fdSt.isSymbolicLink()
          || fdSt.nlink !== 1
          || fdSt.uid !== process.getuid?.()
          || (fdSt.mode & 0o7777) !== 0o400
          || fdSt.size !== expectedByteLength
          || fdSt.dev !== existingVerified.summary.dev
          || fdSt.ino !== existingVerified.summary.ino
          || fdSt.mtimeMs !== existingVerified.summary.mtimeMs
          || fdSt.ctimeMs !== existingVerified.summary.ctimeMs
        ) {
          refuse('ARTIFACT_INVALID', logicalName, phase);
        }
      } catch (error) {
        if (error instanceof ControllerFailure && error.diagnostic.code === 'ARTIFACT_INVALID') throw error;
        refuse('ARTIFACT_INVALID', logicalName, phase);
      } finally {
        if (verifyHandle) await verifyHandle.close().catch(() => {});
      }
      return existingVerified.pointer;
    }

    const tmpPath = join(sha256Dir, '.tmp-' + randomBytes(16).toString('hex'));
    const tmpHandle = await open(
      tmpPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    const scanner = createBinarySecretStreamScanner(this.vault, logicalName, phase, extraSecrets);
    const sha = createHash('sha256');
    let byteLength = 0;
    let scannerFinished = false;
    let tmpClosed = false;
    let tmpUnlinked = false;
    let createdDev = -1;
    let createdIno = -1;

    try {
      const createdInfo = await tmpHandle.stat();
      createdDev = createdInfo.dev;
      createdIno = createdInfo.ino;
      if (
        !createdInfo.isFile()
        || createdInfo.isSymbolicLink()
        || createdInfo.uid !== process.getuid?.()
        || createdInfo.nlink !== 1
      ) {
        refuse('ARTIFACT_INVALID', logicalName, phase);
      }

      await streamSource(async rawChunk => {
        if (rawChunk.byteLength === 0) return;
        for (let offset = 0; offset < rawChunk.byteLength; offset += STREAM_CHUNK_BYTES) {
          if (options.signal?.aborted) {
            refuse('CANCELLED', '', phase);
          }
          if (options.onProgress) {
            await options.onProgress();
          }
          const slice = rawChunk.subarray(offset, Math.min(rawChunk.byteLength, offset + STREAM_CHUNK_BYTES));
          byteLength += slice.byteLength;
          if (byteLength > expectedByteLength || byteLength > maxBytes) {
            refuse('ARTIFACT_INVALID', logicalName, phase);
          }
          scanner.push(slice);
          sha.update(slice);
          await writeAllToHandle(tmpHandle, slice);
        }
      });
      scanner.finish();
      scannerFinished = true;

      const observedSha256 = sha.digest('hex');
      if (byteLength !== expectedByteLength || observedSha256 !== expectedSha256) {
        refuse('ARTIFACT_INVALID', logicalName, phase);
      }

      await tmpHandle.chmod(0o400);
      await tmpHandle.sync();
      const sealedInfo = await tmpHandle.stat();
      if (
        !sealedInfo.isFile()
        || sealedInfo.isSymbolicLink()
        || sealedInfo.dev !== createdDev
        || sealedInfo.ino !== createdIno
        || sealedInfo.uid !== process.getuid?.()
        || sealedInfo.nlink !== 1
        || sealedInfo.size !== expectedByteLength
        || (sealedInfo.mode & 0o7777) !== 0o400
      ) {
        refuse('ARTIFACT_INVALID', logicalName, phase);
      }

      await this.owner.assertCurrent();

      const beforeLink = await lstat(tmpPath).catch(() => null);
      if (
        !beforeLink
        || beforeLink.isSymbolicLink()
        || !beforeLink.isFile()
        || beforeLink.dev !== sealedInfo.dev
        || beforeLink.ino !== sealedInfo.ino
        || beforeLink.uid !== process.getuid?.()
      ) {
        tmpUnlinked = true;
        refuse('ARTIFACT_INVALID', logicalName, phase);
      }

      const finalHexPath = join(sha256Dir, expectedSha256);
      let linked = false;
      try {
        await link(tmpPath, finalHexPath);
        linked = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }

      if (linked) {
        await unlinkIfOwnedInode(tmpPath, sealedInfo.dev, sealedInfo.ino);
        tmpUnlinked = true;
        let finalVerifyHandle: Awaited<ReturnType<typeof open>> | null = null;
        try {
          finalVerifyHandle = await open(finalHexPath, constants.O_RDONLY | constants.O_NOFOLLOW);
          const committed = await finalVerifyHandle.stat();
          const pinned = await tmpHandle.stat();
          if (
            committed.isSymbolicLink()
            || !committed.isFile()
            || committed.dev !== sealedInfo.dev
            || committed.ino !== sealedInfo.ino
            || committed.uid !== process.getuid?.()
            || committed.nlink !== 1
            || committed.size !== expectedByteLength
            || (committed.mode & 0o7777) !== 0o400
            || !pinned.isFile()
            || pinned.dev !== sealedInfo.dev
            || pinned.ino !== sealedInfo.ino
            || pinned.uid !== process.getuid?.()
            || pinned.nlink !== 1
            || pinned.size !== expectedByteLength
            || (pinned.mode & 0o7777) !== 0o400
          ) {
            if (
              committed.dev === sealedInfo.dev
              && committed.ino === sealedInfo.ino
              && committed.uid === process.getuid?.()
            ) {
              await unlinkIfOwnedInode(finalHexPath, sealedInfo.dev, sealedInfo.ino);
            }
            refuse('ARTIFACT_INVALID', logicalName, phase);
          }
        } catch (error) {
          if (error instanceof ControllerFailure && error.diagnostic.code === 'ARTIFACT_INVALID') throw error;
          refuse('ARTIFACT_INVALID', logicalName, phase);
        } finally {
          if (finalVerifyHandle) await finalVerifyHandle.close().catch(() => {});
        }
        await tmpHandle.close();
        tmpClosed = true;
      } else {
        await tmpHandle.close();
        tmpClosed = true;
        await unlinkIfOwnedInode(tmpPath, sealedInfo.dev, sealedInfo.ino);
        tmpUnlinked = true;
        for (let attempt = 0; attempt < 20; attempt++) {
          const st = await lstat(finalHexPath).catch(() => null);
          if (!st || st.isSymbolicLink() || !st.isFile() || st.nlink <= 1) break;
          await new Promise(resolveDelay => setTimeout(resolveDelay, 5));
        }
        const existingCheck = await this.verifyOrReuseVerifierCasBlob(options);
        if (!existingCheck) refuse('ARTIFACT_INVALID', logicalName, phase);
      }

      await syncDirectory(sha256Dir);
      return Object.freeze({
        path: finalHexPath,
        sha256: expectedSha256,
        byteLength: expectedByteLength,
        blobRef: blobRefRes.value,
      });
    } finally {
      if (!scannerFinished) {
        try {
          scanner.finish();
        } catch {
          // Ignore cleanup error after failure.
        }
      }
      if (!tmpClosed) {
        await tmpHandle.close().catch(() => {});
      }
      if (!tmpUnlinked && createdDev !== -1) {
        await unlinkIfOwnedInode(tmpPath, createdDev, createdIno).catch(() => {});
      }
    }
  }

  async #ingestCasBlob(
    logicalName: string,
    maxBytes: number,
    streamSource: (
      consumeChunk: (chunk: Uint8Array) => Promise<void>,
    ) => Promise<void>,
    options?: PutCasBlobOptions,
  ): Promise<CasBlobPointer> {
    await this.owner.assertCurrent();
    if (!Number.isSafeInteger(maxBytes) || Object.is(maxBytes, -0) || maxBytes < 0 || maxBytes > OVERLAY_LIMITS.maxMaxBytes) {
      refuse('OUTPUT_LIMIT', logicalName, 'execution');
    }
    const nameCheck = digestArtifactFromMetadata(logicalName, {
      digest: { algorithm: 'sha256', hex: EMPTY_SHA256_HEX },
      byteLength: 0,
      uri: 'cas://sha256/' + EMPTY_SHA256_HEX,
    });
    if (!nameCheck.ok) {
      refuse('ARTIFACT_INVALID', logicalName, 'execution');
    }

    const blobsDir = join(this.directory, 'blobs');
    const sha256Dir = join(blobsDir, 'sha256');
    await privateDirectory(blobsDir);
    await privateDirectory(sha256Dir);

    const tmpPath = join(sha256Dir, '.tmp-' + randomBytes(16).toString('hex'));
    const tmpHandle = await open(
      tmpPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    const streamChecker = this.vault.createStreamChecker();
    const sha = createHash('sha256');
    const gitObjectFormat = options?.gitObjectFormat;
    let byteLength = 0;
    let checkerFinished = false;
    let tmpClosed = false;
    let tmpUnlinked = false;
    let createdDev = -1;
    let createdIno = -1;

    try {
      const createdInfo = await tmpHandle.stat();
      createdDev = createdInfo.dev;
      createdIno = createdInfo.ino;
      if (
        !createdInfo.isFile()
        || createdInfo.isSymbolicLink()
        || createdInfo.uid !== process.getuid?.()
        || createdInfo.nlink !== 1
      ) {
        refuse('ARTIFACT_INVALID', logicalName, 'execution');
      }

      await streamSource(async slice => {
        if (slice.byteLength === 0) return;
        byteLength += slice.byteLength;
        if (byteLength > maxBytes) refuse('OUTPUT_LIMIT', logicalName, 'execution');
        streamChecker.push(slice);
        sha.update(slice);
        await writeAllToHandle(tmpHandle, slice);
      });
      streamChecker.finish();
      checkerFinished = true;

      await tmpHandle.chmod(0o400);
      await tmpHandle.sync();
      const sealedInfo = await tmpHandle.stat();
      if (
        !sealedInfo.isFile()
        || sealedInfo.isSymbolicLink()
        || sealedInfo.dev !== createdDev
        || sealedInfo.ino !== createdIno
        || sealedInfo.uid !== process.getuid?.()
        || sealedInfo.nlink !== 1
        || sealedInfo.size !== byteLength
        || (sealedInfo.mode & 0o7777) !== 0o400
      ) {
        refuse('ARTIFACT_INVALID', logicalName, 'execution');
      }

      await this.owner.assertCurrent();

      const beforeLink = await lstat(tmpPath).catch(() => null);
      if (
        !beforeLink
        || beforeLink.isSymbolicLink()
        || !beforeLink.isFile()
        || beforeLink.dev !== sealedInfo.dev
        || beforeLink.ino !== sealedInfo.ino
        || beforeLink.uid !== process.getuid?.()
      ) {
        tmpUnlinked = true;
        refuse('ARTIFACT_INVALID', logicalName, 'execution');
      }

      const sha256 = sha.digest('hex');
      const finalHexPath = join(sha256Dir, sha256);
      const blobRefRes = digestArtifactFromMetadata(logicalName, {
        digest: { algorithm: 'sha256', hex: sha256 },
        byteLength,
        uri: 'cas://sha256/' + sha256,
      });
      if (!blobRefRes.ok) refuse('ARTIFACT_INVALID', logicalName, 'execution');

      let verifiedSeal: VerifiedCasSeal | undefined;
      let linked = false;
      try {
        await link(tmpPath, finalHexPath);
        linked = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }

      if (linked) {
        // Fresh-write winner: never mint verifiedSeal from the pre-chmod writable write stream.
        // The first verifier (assertCanonicalMinimalOverlay) will hash the finalized 0o400
        // nlink===1 descriptor and attach VERIFIED_CAS_SEAL for subsequent O(1) reuse.
        await unlinkIfOwnedInode(tmpPath, sealedInfo.dev, sealedInfo.ino);
        tmpUnlinked = true;
        let finalVerifyHandle: Awaited<ReturnType<typeof open>> | null = null;
        try {
          finalVerifyHandle = await open(finalHexPath, constants.O_RDONLY | constants.O_NOFOLLOW);
          const committed = await finalVerifyHandle.stat();
          const pinned = await tmpHandle.stat();
          if (
            committed.isSymbolicLink()
            || !committed.isFile()
            || committed.dev !== sealedInfo.dev
            || committed.ino !== sealedInfo.ino
            || committed.uid !== process.getuid?.()
            || committed.nlink !== 1
            || committed.size !== byteLength
            || (committed.mode & 0o7777) !== 0o400
            || !pinned.isFile()
            || pinned.dev !== sealedInfo.dev
            || pinned.ino !== sealedInfo.ino
            || pinned.uid !== process.getuid?.()
            || pinned.nlink !== 1
            || pinned.size !== byteLength
            || (pinned.mode & 0o7777) !== 0o400
          ) {
            if (
              committed.dev === sealedInfo.dev
              && committed.ino === sealedInfo.ino
              && committed.uid === process.getuid?.()
            ) {
              await unlinkIfOwnedInode(finalHexPath, sealedInfo.dev, sealedInfo.ino);
            }
            refuse('ARTIFACT_INVALID', logicalName, 'execution');
          }
        } finally {
          if (finalVerifyHandle) await finalVerifyHandle.close().catch(() => {});
        }
        await tmpHandle.close();
        tmpClosed = true;
      } else {
        await tmpHandle.close();
        tmpClosed = true;
        await unlinkIfOwnedInode(tmpPath, sealedInfo.dev, sealedInfo.ino);
        tmpUnlinked = true;
        // Allow a racing writer's link()+unlink() pair to finish dropping nlink from 2 -> 1.
        for (let attempt = 0; attempt < 20; attempt++) {
          const st = await lstat(finalHexPath).catch(() => null);
          if (!st || st.isSymbolicLink() || !st.isFile() || st.nlink <= 1) break;
          await new Promise(resolveDelay => setTimeout(resolveDelay, 5));
        }
        const verified = await streamVerifiedCasBlobWithSummary(
          this.directory,
          { name: logicalName, sha256, byteLength, uri: blobRefRes.value.uri, path: finalHexPath },
          undefined,
          'execution',
          gitObjectFormat,
        );
        if (gitObjectFormat !== undefined) {
          verifiedSeal = Object.freeze({
            blobPath: verified.canonicalBlobPath,
            dev: verified.summary.dev,
            ino: verified.summary.ino,
            size: verified.summary.byteLength,
            mtimeMs: verified.summary.mtimeMs,
            ctimeMs: verified.summary.ctimeMs,
            sha256,
            gitOid: verified.gitOid,
            objectFormat: gitObjectFormat,
          });
        }
      }

      await syncDirectory(sha256Dir);
      return Object.freeze({
        path: finalHexPath,
        sha256,
        byteLength,
        blobRef: blobRefRes.value,
        ...(verifiedSeal !== undefined ? { verifiedSeal } : {}),
      });
    } catch (err) {
      if (!checkerFinished) {
        checkerFinished = true;
        streamChecker.finish();
      }
      throw err;
    } finally {
      if (!checkerFinished) {
        try {
          streamChecker.finish();
        } catch {
          // Ignore cleanup error after failure.
        }
      }
      if (!tmpClosed) {
        await tmpHandle.close().catch(() => {});
      }
      if (!tmpUnlinked && createdDev !== -1) {
        await unlinkIfOwnedInode(tmpPath, createdDev, createdIno).catch(() => {});
      }
    }
  }
}
