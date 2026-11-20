import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { PiFailure, refuse } from './errors.js';
import type { PiCandidateStreamChecker, PiErrorCode } from './types.js';

export const CAS_CHUNK_BYTES = 1_048_576;
export const RAW_ARTIFACT_MAX_BYTES = 67_108_864;
export const RAW_AGGREGATE_MAX_BYTES = 268_435_456;
export const WORKSPACE_NDJSON_MAX_BYTES = 33_554_432;

const UNBOUNDED_GENERIC_SECRET_PATTERNS: readonly RegExp[] = Object.freeze([
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  /sk-(?:ant-|proj-)[A-Za-z0-9_-]{20,}/,
]);

const BOUNDED_GENERIC_SECRET_PATTERNS: readonly RegExp[] = Object.freeze([
  /(?<![0-9A-Za-z])AKIA[0-9A-Z]{16}(?![0-9A-Za-z])/g,
]);

function derivePiSecretFormBuffers(secrets: Iterable<string>): readonly Buffer[] {
  const formSet = new Set<string>();
  for (const token of secrets) {
    if (typeof token !== 'string' || token.length === 0) continue;
    const jsonEscaped = JSON.stringify(token).slice(1, -1);
    formSet.add(token);
    formSet.add(jsonEscaped);
    formSet.add(jsonEscaped.replaceAll('/', '\\/'));
    try {
      formSet.add(encodeURIComponent(token));
    } catch {
      // Ignore lone-surrogate URIError on untrusted standalone inputs.
    }
    formSet.add(Buffer.from(token, 'utf8').toString('base64'));
  }
  formSet.delete('');
  return Object.freeze([...formSet].map(form => Buffer.from(form, 'utf8')));
}

function hasGenericSecretPattern(bytes: Buffer, isFinal: boolean, minMatchEnd = 0): boolean {
  const textWindow = bytes.toString('latin1');
  if (UNBOUNDED_GENERIC_SECRET_PATTERNS.some(pattern => pattern.test(textWindow))) {
    return true;
  }
  for (const pattern of BOUNDED_GENERIC_SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(textWindow)) !== null) {
      const matchEnd = match.index + match[0].length;
      if (matchEnd < minMatchEnd) continue;
      if (isFinal || matchEnd < textWindow.length) {
        return true;
      }
    }
  }
  return false;
}

export function createBuiltInPiStreamChecker(
  resolvedSecrets: ReadonlySet<string>,
  options?: { readonly includeGeneric?: boolean | undefined },
): PiCandidateStreamChecker {
  const includeGeneric = options?.includeGeneric !== false;
  const formBuffers = derivePiSecretFormBuffers(resolvedSecrets);
  const maxDerivedFormByteLength = formBuffers.reduce((max, buf) => Math.max(max, buf.byteLength), 0);
  const overlap = Math.max(16_384, maxDerivedFormByteLength);
  let carryTail: Buffer = Buffer.alloc(0);

  return Object.freeze({
    push: (chunk: Uint8Array): void => {
      if (chunk.byteLength === 0) return;
      const view = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      const prevCarryLen = carryTail.byteLength;
      const combined = prevCarryLen === 0 ? view : Buffer.concat([carryTail, view]);
      if (
        formBuffers.some(form => combined.includes(form))
        || (includeGeneric && hasGenericSecretPattern(combined, false, prevCarryLen))
      ) {
        if (carryTail.byteLength > 0) carryTail.fill(0);
        carryTail = Buffer.alloc(0);
        refuse('CONTEXT_UNSAFE', '/candidate/artifacts', { phase: 'restore' });
      }
      const keep = Math.min(overlap, combined.byteLength);
      if (carryTail.byteLength > 0) carryTail.fill(0);
      carryTail = Buffer.from(combined.subarray(combined.byteLength - keep));
    },
    finish: (): void => {
      const tail = carryTail;
      carryTail = Buffer.alloc(0);
      try {
        if (
          tail.byteLength > 0
          && (
            formBuffers.some(form => tail.includes(form))
            || (includeGeneric && hasGenericSecretPattern(tail, true, tail.byteLength))
          )
        ) {
          refuse('CONTEXT_UNSAFE', '/candidate/artifacts', { phase: 'restore' });
        }
      } finally {
        if (tail.byteLength > 0) tail.fill(0);
      }
    },
  });
}

export function composeCandidateStreamCheckers(
  primary: PiCandidateStreamChecker | undefined,
  secondary: PiCandidateStreamChecker,
): PiCandidateStreamChecker {
  if (!primary) return secondary;
  return Object.freeze({
    push: (chunk: Uint8Array): void => {
      primary.push(chunk);
      secondary.push(chunk);
    },
    finish: (): void => {
      let firstError: unknown = null;
      try {
        primary.finish();
      } catch (error) {
        firstError = error;
      }
      try {
        secondary.finish();
      } catch (error) {
        if (firstError === null) firstError = error;
      }
      if (firstError !== null) throw firstError;
    },
  });
}

const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

export async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const written = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (written.bytesWritten <= 0) refuse('RECOVERY_REQUIRED', '', { phase: 'restore' });
    offset += written.bytesWritten;
  }
}

export async function fsyncDir(dirPath: string): Promise<void> {
  const fd = await open(dirPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}

function checkOwnerAndMode(uid: number, mode: number, forbiddenBits: number): boolean {
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && uid !== currentUid) return false;
  return (mode & forbiddenBits) === 0;
}

export async function ensureCasSha256Dir(artifactsDirectory: string): Promise<string> {
  const rootInfo = await lstat(artifactsDirectory).catch(() => null);
  if (
    !rootInfo
    || !rootInfo.isDirectory()
    || rootInfo.isSymbolicLink()
    || !checkOwnerAndMode(rootInfo.uid, rootInfo.mode, 0o022)
    || (await realpath(artifactsDirectory)) !== resolve(artifactsDirectory)
  ) {
    refuse('INPUT_INVALID', '/host/artifactsDirectory', { phase: 'restore' });
  }
  const blobsDir = join(artifactsDirectory, 'blobs');
  try {
    await mkdir(blobsDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const blobsInfo = await lstat(blobsDir);
  if (!blobsInfo.isDirectory() || blobsInfo.isSymbolicLink() || !checkOwnerAndMode(blobsInfo.uid, blobsInfo.mode, 0o077)) {
    refuse('RECOVERY_REQUIRED', '/host/artifactsDirectory', { phase: 'restore' });
  }
  const sha256Dir = join(blobsDir, 'sha256');
  try {
    await mkdir(sha256Dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const sha256Info = await lstat(sha256Dir);
  if (!sha256Info.isDirectory() || sha256Info.isSymbolicLink() || !checkOwnerAndMode(sha256Info.uid, sha256Info.mode, 0o077)) {
    refuse('RECOVERY_REQUIRED', '/host/artifactsDirectory', { phase: 'restore' });
  }
  return sha256Dir;
}

export async function verifyCasSha256DirAsync(artifactsDirectory: string, errorPath = '/artifactsDirectory'): Promise<string> {
  let rootInfo;
  try {
    rootInfo = await lstat(artifactsDirectory);
  } catch {
    refuse('RECOVERY_REQUIRED', errorPath, { phase: 'restore' });
  }
  if (
    !rootInfo.isDirectory()
    || rootInfo.isSymbolicLink()
    || !checkOwnerAndMode(rootInfo.uid, rootInfo.mode, 0o022)
    || (await realpath(artifactsDirectory).catch(() => '')) !== resolve(artifactsDirectory)
  ) {
    refuse('RECOVERY_REQUIRED', errorPath, { phase: 'restore' });
  }
  const blobsDir = join(artifactsDirectory, 'blobs');
  const sha256Dir = join(blobsDir, 'sha256');
  for (const dir of [blobsDir, sha256Dir]) {
    let info;
    try {
      info = await lstat(dir);
    } catch {
      refuse('RECOVERY_REQUIRED', errorPath, { phase: 'restore' });
    }
    if (!info.isDirectory() || info.isSymbolicLink() || !checkOwnerAndMode(info.uid, info.mode, 0o077)) {
      refuse('RECOVERY_REQUIRED', errorPath, { phase: 'restore' });
    }
  }
  return sha256Dir;
}

export const verifyCasSha256Dir = verifyCasSha256DirAsync;

export function verifyCasSha256DirSync(artifactsDirectory: string, errorPath = '/restore'): string {
  let rootInfo;
  try {
    rootInfo = lstatSync(artifactsDirectory);
  } catch {
    refuse('RECOVERY_REQUIRED', errorPath, { phase: 'restore' });
  }
  let resolvedRoot = '';
  try {
    resolvedRoot = realpathSync(artifactsDirectory);
  } catch {
    refuse('RECOVERY_REQUIRED', errorPath, { phase: 'restore' });
  }
  if (
    !rootInfo.isDirectory()
    || rootInfo.isSymbolicLink()
    || !checkOwnerAndMode(rootInfo.uid, rootInfo.mode, 0o022)
    || resolvedRoot !== resolve(artifactsDirectory)
  ) {
    refuse('RECOVERY_REQUIRED', errorPath, { phase: 'restore' });
  }
  const blobsDir = join(artifactsDirectory, 'blobs');
  const sha256Dir = join(blobsDir, 'sha256');
  for (const dir of [blobsDir, sha256Dir]) {
    let info;
    try {
      info = lstatSync(dir);
    } catch {
      refuse('RECOVERY_REQUIRED', errorPath, { phase: 'restore' });
    }
    if (!info.isDirectory() || info.isSymbolicLink() || !checkOwnerAndMode(info.uid, info.mode, 0o077)) {
      refuse('RECOVERY_REQUIRED', errorPath, { phase: 'restore' });
    }
  }
  return sha256Dir;
}

export interface VerifyFileSyncOptions {
  readonly byteLength: number;
  readonly sha256Hex: string;
  readonly requireReadOnly: boolean;
  readonly gitObjectFormat?: 'sha1' | 'sha256' | undefined;
  readonly structuralCode: PiErrorCode;
  readonly contentCode: PiErrorCode;
  readonly errorPath: string;
}

export function verifyRegularFileSync(filePath: string, options: VerifyFileSyncOptions): { readonly gitOid: string | null } {
  let linfo;
  try {
    linfo = lstatSync(filePath);
  } catch {
    refuse(options.structuralCode, options.errorPath);
  }
  if (linfo.isSymbolicLink() || !linfo.isFile() || linfo.nlink !== 1) {
    refuse(options.structuralCode, options.errorPath);
  }
  if (options.requireReadOnly && (linfo.mode & 0o222) !== 0) {
    refuse(options.structuralCode, options.errorPath);
  }
  if (linfo.size !== options.byteLength) {
    refuse(options.contentCode, options.errorPath);
  }

  let fd: number;
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    refuse(options.structuralCode, options.errorPath);
  }
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile()
      || before.nlink !== 1
      || before.dev !== linfo.dev
      || before.ino !== linfo.ino
      || (options.requireReadOnly && (before.mode & 0o222) !== 0)
    ) {
      refuse(options.structuralCode, options.errorPath);
    }
    if (before.size !== options.byteLength) {
      refuse(options.contentCode, options.errorPath);
    }

    const sha256 = createHash('sha256');
    const gitHash = options.gitObjectFormat
      ? createHash(options.gitObjectFormat).update(`blob ${options.byteLength}\0`)
      : null;
    const chunkBuf = Buffer.allocUnsafe(Math.min(CAS_CHUNK_BYTES, Math.max(1, options.byteLength + 1)));
    let totalRead = 0;
    for (;;) {
      const n = readSync(fd, chunkBuf, 0, chunkBuf.length, totalRead);
      if (n === 0) break;
      const slice = chunkBuf.subarray(0, n);
      totalRead += n;
      if (totalRead > options.byteLength) {
        refuse(options.contentCode, options.errorPath);
      }
      sha256.update(slice);
      gitHash?.update(slice);
    }

    const after = fstatSync(fd);
    if (
      !after.isFile()
      || after.nlink !== 1
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
      || (options.requireReadOnly && (after.mode & 0o222) !== 0)
    ) {
      refuse(options.structuralCode, options.errorPath);
    }
    if (totalRead !== options.byteLength || sha256.digest('hex') !== options.sha256Hex) {
      refuse(options.contentCode, options.errorPath);
    }
    return { gitOid: gitHash ? gitHash.digest('hex') : null };
  } finally {
    closeSync(fd);
  }
}

export type VerifyFileOptions = VerifyFileSyncOptions;

export async function verifyRegularFileAsync(
  filePath: string,
  options: VerifyFileOptions,
): Promise<{ readonly gitOid: string | null }> {
  let linfo;
  try {
    linfo = await lstat(filePath);
  } catch {
    refuse(options.structuralCode, options.errorPath);
  }
  if (linfo.isSymbolicLink() || !linfo.isFile() || linfo.nlink !== 1) {
    refuse(options.structuralCode, options.errorPath);
  }
  if (options.requireReadOnly && (linfo.mode & 0o222) !== 0) {
    refuse(options.structuralCode, options.errorPath);
  }
  if (linfo.size !== options.byteLength) {
    refuse(options.contentCode, options.errorPath);
  }

  let fh: FileHandle;
  try {
    fh = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    refuse(options.structuralCode, options.errorPath);
  }
  try {
    const before = await fh.stat();
    if (
      !before.isFile()
      || before.nlink !== 1
      || before.dev !== linfo.dev
      || before.ino !== linfo.ino
      || (options.requireReadOnly && (before.mode & 0o222) !== 0)
    ) {
      refuse(options.structuralCode, options.errorPath);
    }
    if (before.size !== options.byteLength) {
      refuse(options.contentCode, options.errorPath);
    }

    const sha256 = createHash('sha256');
    const gitHash = options.gitObjectFormat
      ? createHash(options.gitObjectFormat).update(`blob ${options.byteLength}\0`)
      : null;
    const chunkBuf = Buffer.allocUnsafe(Math.min(CAS_CHUNK_BYTES, Math.max(1, options.byteLength)));
    let totalRead = 0;
    while (totalRead < options.byteLength) {
      const toRead = Math.min(chunkBuf.length, options.byteLength - totalRead);
      const { bytesRead } = await fh.read(chunkBuf, 0, toRead, totalRead);
      if (bytesRead <= 0) break;
      const slice = chunkBuf.subarray(0, bytesRead);
      totalRead += bytesRead;
      sha256.update(slice);
      gitHash?.update(slice);
    }

    const probe = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytes } = await fh.read(probe, 0, 1, totalRead);
    if (extraBytes !== 0) {
      refuse(options.contentCode, options.errorPath);
    }

    const after = await fh.stat();
    if (
      !after.isFile()
      || after.nlink !== 1
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
      || (options.requireReadOnly && (after.mode & 0o222) !== 0)
    ) {
      refuse(options.structuralCode, options.errorPath);
    }
    if (totalRead !== options.byteLength || sha256.digest('hex') !== options.sha256Hex) {
      refuse(options.contentCode, options.errorPath);
    }
    return { gitOid: gitHash ? gitHash.digest('hex') : null };
  } finally {
    await fh.close();
  }
}

export async function readBlobChunkAsync(
  blobPath: string,
  expectedLength: number,
  offset: number,
  length: number,
): Promise<Buffer> {
  let fh: FileHandle;
  try {
    fh = await open(blobPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    refuse('RECOVERY_REQUIRED', '/restore/workspace');
  }
  try {
    const before = await fh.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size !== expectedLength) {
      refuse('RECOVERY_REQUIRED', '/restore/workspace');
    }
    const buf = Buffer.allocUnsafe(length);
    let readTotal = 0;
    while (readTotal < length) {
      const toRead = Math.min(CAS_CHUNK_BYTES, length - readTotal);
      const { bytesRead } = await fh.read(buf, readTotal, toRead, offset + readTotal);
      if (bytesRead <= 0) refuse('RESOURCE_MISMATCH', '/restore/workspace');
      readTotal += bytesRead;
    }
    const after = await fh.stat();
    if (
      !after.isFile()
      || after.nlink !== 1
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
    ) {
      refuse('RECOVERY_REQUIRED', '/restore/workspace');
    }
    return buf;
  } finally {
    await fh.close();
  }
}

export async function verifyCasBlobAsync(
  blobPath: string,
  expected: {
    readonly byteLength: number;
    readonly sha256Hex: string;
    readonly collectBytes?: boolean;
    readonly streamChecker?: PiCandidateStreamChecker | undefined;
  },
  errorPath = '/workspace',
): Promise<Buffer | null> {
  let linfo;
  try {
    linfo = await lstat(blobPath);
  } catch {
    refuse('RECOVERY_REQUIRED', errorPath, { phase: 'restore' });
  }
  if (linfo.isSymbolicLink() || !linfo.isFile() || linfo.nlink !== 1 || (linfo.mode & 0o222) !== 0) {
    refuse('RECOVERY_REQUIRED', errorPath, { phase: 'restore' });
  }
  if (linfo.size !== expected.byteLength) {
    refuse('RESOURCE_MISMATCH', errorPath, { phase: 'restore' });
  }

  let fd: FileHandle;
  try {
    fd = await open(blobPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    refuse('RECOVERY_REQUIRED', errorPath, { phase: 'restore' });
  }
  try {
    const before = await fd.stat();
    if (
      !before.isFile()
      || before.nlink !== 1
      || (before.mode & 0o222) !== 0
      || before.dev !== linfo.dev
      || before.ino !== linfo.ino
    ) {
      refuse('RECOVERY_REQUIRED', errorPath, { phase: 'restore' });
    }
    if (before.size !== expected.byteLength) {
      refuse('RESOURCE_MISMATCH', errorPath, { phase: 'restore' });
    }

    const sha256 = createHash('sha256');
    const collected = expected.collectBytes ? Buffer.allocUnsafe(expected.byteLength) : null;
    const chunkBuf = Buffer.allocUnsafe(Math.min(CAS_CHUNK_BYTES, Math.max(1, expected.byteLength + 1)));
    let totalRead = 0;
    for (;;) {
      const part = await fd.read(chunkBuf, 0, chunkBuf.length, totalRead);
      if (part.bytesRead === 0) break;
      const slice = chunkBuf.subarray(0, part.bytesRead);
      if (totalRead + slice.length > expected.byteLength) {
        refuse('RESOURCE_MISMATCH', errorPath, { phase: 'restore' });
      }
      expected.streamChecker?.push(slice);
      if (collected !== null) {
        slice.copy(collected, totalRead);
      }
      totalRead += slice.length;
      sha256.update(slice);
    }
    expected.streamChecker?.finish();

    const after = await fd.stat();
    if (
      !after.isFile()
      || after.nlink !== 1
      || (after.mode & 0o222) !== 0
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
    ) {
      refuse('RECOVERY_REQUIRED', errorPath, { phase: 'restore' });
    }
    if (totalRead !== expected.byteLength || sha256.digest('hex') !== expected.sha256Hex) {
      refuse('RESOURCE_MISMATCH', errorPath, { phase: 'restore' });
    }
    return collected;
  } finally {
    await fd.close();
  }
}

export async function publishCandidateFileToCas(
  sourcePath: string,
  sha256Dir: string,
  expected: { readonly byteLength: number; readonly sha256Hex: string },
  signal: AbortSignal,
  createCandidateStreamChecker: () => PiCandidateStreamChecker = () => createBuiltInPiStreamChecker(new Set()),
): Promise<string> {
  if (signal.aborted) refuse('CANCELLED', '', { phase: 'restore' });
  const tmpPath = join(sha256Dir, '.tmp-' + randomBytes(16).toString('hex'));
  let sourceFd: FileHandle | null = null;
  let tmpHandle: FileHandle | null = null;
  let tmpCreated = false;
  let checker: PiCandidateStreamChecker | null = null;
  let checkerFinished = false;
  try {
    try {
      sourceFd = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      refuse('RECOVERY_REQUIRED', '', { phase: 'restore' });
    }
    const before = await sourceFd.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size !== expected.byteLength) {
      refuse('RECOVERY_REQUIRED', '', { phase: 'restore' });
    }

    tmpHandle = await open(tmpPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    tmpCreated = true;

    checker = createCandidateStreamChecker();
    const hash = createHash('sha256');
    const chunkBuf = Buffer.allocUnsafe(Math.min(CAS_CHUNK_BYTES, Math.max(1, expected.byteLength + 1)));
    let totalRead = 0;
    for (;;) {
      if (signal.aborted) refuse('CANCELLED', '', { phase: 'restore' });
      const part = await sourceFd.read(chunkBuf, 0, chunkBuf.length, totalRead);
      if (part.bytesRead === 0) break;
      const slice = chunkBuf.subarray(0, part.bytesRead);
      totalRead += slice.length;
      if (totalRead > expected.byteLength) {
        refuse('RECOVERY_REQUIRED', '', { phase: 'restore' });
      }
      checker.push(slice);
      hash.update(slice);
      await writeAll(tmpHandle, slice);
    }
    checker.finish();
    checkerFinished = true;

    const after = await sourceFd.stat();
    const hex = hash.digest('hex');
    if (
      !after.isFile()
      || after.nlink !== 1
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
      || totalRead !== expected.byteLength
      || hex !== expected.sha256Hex
    ) {
      refuse('RECOVERY_REQUIRED', '', { phase: 'restore' });
    }

    await tmpHandle.chmod(0o400);
    await tmpHandle.sync();
    await tmpHandle.close();
    tmpHandle = null;

    if (signal.aborted) refuse('CANCELLED', '', { phase: 'restore' });

    const finalPath = join(sha256Dir, hex);
    let linked = false;
    try {
      await link(tmpPath, finalPath);
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        refuse('RECOVERY_REQUIRED', '', { phase: 'restore' });
      }
    }
    await unlink(tmpPath);
    tmpCreated = false;

    if (!linked) {
      // Allow a racing publisher's link()+unlink() pair to settle nlink from 2 -> 1.
      for (let attempt = 0; attempt < 20; attempt++) {
        if (signal.aborted) refuse('CANCELLED', '', { phase: 'restore' });
        const st = await lstat(finalPath).catch(() => null);
        if (st === null || st.isSymbolicLink() || !st.isFile() || st.nlink <= 1) {
          break;
        }
        await new Promise<void>(resolveDelay => setTimeout(resolveDelay, 5));
      }
      if (signal.aborted) refuse('CANCELLED', '', { phase: 'restore' });
      const dedupChecker = createCandidateStreamChecker();
      let dedupCheckerError: unknown = null;
      let dedupCheckerFinished = false;
      const wrappedChecker: PiCandidateStreamChecker = {
        push: chunk => {
          try {
            dedupChecker.push(chunk);
          } catch (err) {
            dedupCheckerError = err;
            throw err;
          }
        },
        finish: () => {
          try {
            dedupChecker.finish();
            dedupCheckerFinished = true;
          } catch (err) {
            dedupCheckerError = err;
            throw err;
          }
        },
      };
      try {
        await verifyCasBlobAsync(finalPath, {
          byteLength: expected.byteLength,
          sha256Hex: hex,
          collectBytes: false,
          streamChecker: wrappedChecker,
        });
      } catch (error) {
        if (!dedupCheckerFinished) {
          try {
            dedupChecker.finish();
          } catch {
            // Ignore cleanup error after stream verification failure.
          }
        }
        if (dedupCheckerError !== null) throw dedupCheckerError;
        if (error instanceof PiFailure) refuse('RECOVERY_REQUIRED', '', { phase: 'restore' });
        refuse('RECOVERY_REQUIRED', '', { phase: 'restore' });
      }
    }

    return finalPath;
  } finally {
    if (checker && !checkerFinished) {
      try {
        checker.finish();
      } catch {
        // Ignore cleanup error after ingestion failure.
      }
    }
    if (sourceFd) {
      await sourceFd.close().catch(() => {});
    }
    if (tmpHandle) {
      await tmpHandle.close().catch(() => {});
    }
    if (tmpCreated) {
      await unlink(tmpPath).catch(error => {
        if (!absent(error)) throw error;
      });
    }
  }
}

export interface StreamCopyVerifiedBlobOptions {
  readonly disableReflink?: boolean | undefined;
}

export async function streamCopyVerifiedBlob(
  sourcePath: string,
  targetPath: string,
  expected: { readonly byteLength: number; readonly sha256Hex: string },
  mode: number,
  options?: StreamCopyVerifiedBlobOptions,
): Promise<void> {
  void options;
  if (
    typeof sourcePath !== 'string'
    || !isAbsolute(sourcePath)
    || sourcePath.length > 4096
    || /[\0\r\n]/.test(sourcePath)
    || typeof targetPath !== 'string'
    || !isAbsolute(targetPath)
    || targetPath.length > 4096
    || /[\0\r\n]/.test(targetPath)
  ) {
    refuse('RECOVERY_REQUIRED', '/candidate');
  }

  let targetExists = false;
  try {
    await lstat(targetPath);
    targetExists = true;
  } catch (error) {
    if (!absent(error)) refuse('RECOVERY_REQUIRED', '/candidate');
  }
  if (targetExists) {
    refuse('RECOVERY_REQUIRED', '/candidate');
  }

  const tmpPath = join(dirname(targetPath), `.lw-stage-${randomBytes(12).toString('hex')}`);
  let srcHandle: FileHandle | null = null;
  let tmpHandle: FileHandle | null = null;
  let destVerify: FileHandle | null = null;
  let tmpCreated = false;
  let tmpUnlinked = false;
  try {
    srcHandle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const srcBefore = await srcHandle.stat();
    if (
      srcBefore.isSymbolicLink()
      || !srcBefore.isFile()
      || srcBefore.nlink !== 1
      || !checkOwnerAndMode(srcBefore.uid, 0, 0)
      || srcBefore.size !== expected.byteLength
    ) {
      refuse('RECOVERY_REQUIRED', '/candidate');
    }

    tmpHandle = await open(
      tmpPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    tmpCreated = true;
    const createdStat = await tmpHandle.stat();
    if (
      !createdStat.isFile()
      || createdStat.isSymbolicLink()
      || createdStat.nlink !== 1
      || createdStat.ino === srcBefore.ino
    ) {
      refuse('RECOVERY_REQUIRED', '/candidate');
    }

    const buf = Buffer.allocUnsafe(Math.min(CAS_CHUNK_BYTES, Math.max(1, expected.byteLength + 1)));
    const writeSha = createHash('sha256');
    let writtenBytes = 0;
    for (;;) {
      const part = await srcHandle.read(buf, 0, buf.length, writtenBytes);
      if (part.bytesRead === 0) break;
      const slice = buf.subarray(0, part.bytesRead);
      writtenBytes += slice.length;
      if (writtenBytes > expected.byteLength) {
        refuse('RESOURCE_MISMATCH', '/candidate');
      }
      writeSha.update(slice);
      await writeAll(tmpHandle, slice);
    }

    const srcAfter = await srcHandle.stat();
    if (
      !srcAfter.isFile()
      || srcAfter.isSymbolicLink()
      || srcAfter.nlink !== 1
      || srcAfter.dev !== srcBefore.dev
      || srcAfter.ino !== srcBefore.ino
      || srcAfter.size !== srcBefore.size
      || srcAfter.mtimeMs !== srcBefore.mtimeMs
      || srcAfter.ctimeMs !== srcBefore.ctimeMs
    ) {
      refuse('RECOVERY_REQUIRED', '/candidate');
    }
    const writeShaHex = writeSha.digest('hex');
    if (writtenBytes !== expected.byteLength || writeShaHex !== expected.sha256Hex) {
      refuse('RESOURCE_MISMATCH', '/candidate');
    }

    const storedSha = createHash('sha256');
    let readOffset = 0;
    while (readOffset < writtenBytes) {
      const toRead = Math.min(buf.byteLength, writtenBytes - readOffset);
      const part = await tmpHandle.read(buf, 0, toRead, readOffset);
      if (part.bytesRead === 0) break;
      storedSha.update(buf.subarray(0, part.bytesRead));
      readOffset += part.bytesRead;
    }
    const probe = Buffer.allocUnsafe(1);
    const extraTmpRead = (await tmpHandle.read(probe, 0, 1, readOffset)).bytesRead;
    const tmpAfterRead = await tmpHandle.stat();
    if (
      extraTmpRead !== 0
      || readOffset !== writtenBytes
      || !tmpAfterRead.isFile()
      || tmpAfterRead.isSymbolicLink()
      || tmpAfterRead.dev !== createdStat.dev
      || tmpAfterRead.ino !== createdStat.ino
      || tmpAfterRead.nlink !== 1
      || tmpAfterRead.size !== writtenBytes
    ) {
      refuse('RECOVERY_REQUIRED', '/candidate');
    }
    if (storedSha.digest('hex') !== writeShaHex) {
      refuse('RESOURCE_MISMATCH', '/candidate');
    }

    await tmpHandle.chmod(mode);
    await tmpHandle.sync();
    const sealedStat = await tmpHandle.stat();
    if (
      !sealedStat.isFile()
      || sealedStat.isSymbolicLink()
      || sealedStat.dev !== createdStat.dev
      || sealedStat.ino !== createdStat.ino
      || sealedStat.nlink !== 1
      || sealedStat.size !== writtenBytes
      || (sealedStat.mode & 0o777) !== (mode & 0o777)
    ) {
      refuse('RECOVERY_REQUIRED', '/candidate');
    }

    await link(tmpPath, targetPath);
    await unlink(tmpPath);
    tmpUnlinked = true;

    destVerify = await open(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const destStat = await destVerify.stat();
    const pinnedStat = await tmpHandle.stat();
    if (
      !destStat.isFile()
      || destStat.isSymbolicLink()
      || destStat.nlink !== 1
      || destStat.dev !== createdStat.dev
      || destStat.ino !== createdStat.ino
      || destStat.size !== writtenBytes
      || (destStat.mode & 0o777) !== (mode & 0o777)
      || pinnedStat.nlink !== 1
    ) {
      refuse('RECOVERY_REQUIRED', '/candidate');
    }

    await destVerify.close();
    destVerify = null;
    await tmpHandle.close();
    tmpHandle = null;
  } catch (error) {
    if (error instanceof PiFailure) throw error;
    refuse('RECOVERY_REQUIRED', '/candidate');
  } finally {
    if (destVerify) {
      await destVerify.close().catch(() => {});
    }
    if (tmpHandle) {
      await tmpHandle.close().catch(() => {});
    }
    if (srcHandle) {
      await srcHandle.close().catch(() => {});
    }
    if (tmpCreated && !tmpUnlinked) {
      await unlink(tmpPath).catch(() => {});
    }
  }
}
