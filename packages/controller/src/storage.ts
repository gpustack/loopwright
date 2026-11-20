import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { types } from 'node:util';
import {
  OVERLAY_LIMITS,
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
  if (sha.digest('hex') !== pointer.sha256) {
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

async function syncDirectory(dirPath: string): Promise<void> {
  const dirHandle = await open(dirPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
}

export async function cleanCasTempFilesInDirectory(artifactsDir: string, owner: ControllerOwner): Promise<number> {
  await owner.assertCurrent();
  const blobsDir = join(artifactsDir, 'blobs');
  const sha256Dir = join(blobsDir, 'sha256');
  try {
    const info = await lstat(sha256Dir);
    if (info.isSymbolicLink() || !info.isDirectory()) refuse('ARTIFACT_INVALID', '', 'recovery');
  } catch (error) {
    if (error instanceof ControllerFailure) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
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
    if (!stat.isSymbolicLink() && stat.isFile()) {
      await unlink(candidatePath).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      removed++;
    }
  }
  if (removed > 0) {
    await syncDirectory(sha256Dir);
  }
  return removed;
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
    let tmpClosed = false;
    let tmpUnlinked = false;

    try {
      await streamSource(async slice => {
        if (slice.byteLength === 0) return;
        byteLength += slice.byteLength;
        if (byteLength > maxBytes) refuse('OUTPUT_LIMIT', logicalName, 'execution');
        streamChecker.push(slice);
        sha.update(slice);
        await writeAllToHandle(tmpHandle, slice);
      });
      streamChecker.finish();

      await tmpHandle.chmod(0o400);
      await tmpHandle.sync();

      await this.owner.assertCurrent();

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
        await unlink(tmpPath);
        tmpUnlinked = true;
        await tmpHandle.close();
        tmpClosed = true;
      } else {
        await tmpHandle.close();
        tmpClosed = true;
        await unlink(tmpPath);
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
    } finally {
      streamChecker.finish();
      if (!tmpClosed) {
        await tmpHandle.close().catch(() => {});
      }
      if (!tmpUnlinked) {
        await unlink(tmpPath).catch(() => {});
      }
    }
  }
}
