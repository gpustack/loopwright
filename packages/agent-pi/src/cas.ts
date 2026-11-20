import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PiFailure, refuse } from './errors.js';
import type { PiErrorCode } from './types.js';

export const CAS_CHUNK_BYTES = 65_536;
export const RAW_ARTIFACT_MAX_BYTES = 67_108_864;
export const RAW_AGGREGATE_MAX_BYTES = 268_435_456;
export const WORKSPACE_NDJSON_MAX_BYTES = 16_777_216;

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

export async function verifyCasSha256Dir(artifactsDirectory: string, errorPath = '/artifactsDirectory'): Promise<string> {
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
    const chunkBuf = Buffer.allocUnsafe(CAS_CHUNK_BYTES);
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

export async function verifyCasBlobAsync(
  blobPath: string,
  expected: { readonly byteLength: number; readonly sha256Hex: string; readonly collectBytes?: boolean },
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
    const chunkBuf = Buffer.allocUnsafe(CAS_CHUNK_BYTES);
    let totalRead = 0;
    for (;;) {
      const part = await fd.read(chunkBuf, 0, chunkBuf.length, totalRead);
      if (part.bytesRead === 0) break;
      const slice = chunkBuf.subarray(0, part.bytesRead);
      if (totalRead + slice.length > expected.byteLength) {
        refuse('RESOURCE_MISMATCH', errorPath, { phase: 'restore' });
      }
      if (collected !== null) {
        slice.copy(collected, totalRead);
      }
      totalRead += slice.length;
      sha256.update(slice);
    }

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
): Promise<string> {
  if (signal.aborted) refuse('CANCELLED', '', { phase: 'restore' });
  const tmpPath = join(sha256Dir, '.tmp-' + randomBytes(16).toString('hex'));
  let sourceFd: FileHandle | null = null;
  let tmpHandle: FileHandle | null = null;
  let tmpCreated = false;
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

    const hash = createHash('sha256');
    const chunkBuf = Buffer.allocUnsafe(CAS_CHUNK_BYTES);
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
      hash.update(slice);
      await writeAll(tmpHandle, slice);
    }

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
      try {
        await verifyCasBlobAsync(finalPath, { byteLength: expected.byteLength, sha256Hex: hex, collectBytes: false });
      } catch (error) {
        if (error instanceof PiFailure) refuse('RECOVERY_REQUIRED', '', { phase: 'restore' });
        refuse('RECOVERY_REQUIRED', '', { phase: 'restore' });
      }
    }

    return finalPath;
  } finally {
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

export async function streamCopyVerifiedBlob(
  sourcePath: string,
  targetPath: string,
  expected: { readonly byteLength: number; readonly sha256Hex: string },
  mode: number,
): Promise<void> {
  let linfo;
  try {
    linfo = await lstat(sourcePath);
  } catch {
    refuse('RECOVERY_REQUIRED', '/candidate');
  }
  if (linfo.isSymbolicLink() || !linfo.isFile() || linfo.nlink !== 1 || linfo.size !== expected.byteLength) {
    refuse('RECOVERY_REQUIRED', '/candidate');
  }

  let srcFd: FileHandle | null = null;
  let dstFd: FileHandle | null = null;
  let dstCreated = false;
  try {
    try {
      srcFd = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      refuse('RECOVERY_REQUIRED', '/candidate');
    }
    const before = await srcFd.stat();
    if (
      !before.isFile()
      || before.nlink !== 1
      || before.dev !== linfo.dev
      || before.ino !== linfo.ino
      || before.size !== expected.byteLength
    ) {
      refuse('RECOVERY_REQUIRED', '/candidate');
    }

    dstFd = await open(targetPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    dstCreated = true;

    const hash = createHash('sha256');
    const chunkBuf = Buffer.allocUnsafe(CAS_CHUNK_BYTES);
    let totalRead = 0;
    for (;;) {
      const part = await srcFd.read(chunkBuf, 0, chunkBuf.length, totalRead);
      if (part.bytesRead === 0) break;
      const slice = chunkBuf.subarray(0, part.bytesRead);
      totalRead += slice.length;
      if (totalRead > expected.byteLength) {
        refuse('RESOURCE_MISMATCH', '/candidate');
      }
      hash.update(slice);
      await writeAll(dstFd, slice);
    }

    const after = await srcFd.stat();
    if (
      !after.isFile()
      || after.nlink !== 1
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
    ) {
      refuse('RECOVERY_REQUIRED', '/candidate');
    }
    if (totalRead !== expected.byteLength || hash.digest('hex') !== expected.sha256Hex) {
      refuse('RESOURCE_MISMATCH', '/candidate');
    }

    await dstFd.chmod(mode);
    await dstFd.close();
    dstFd = null;
    dstCreated = false;
  } finally {
    if (srcFd) {
      await srcFd.close().catch(() => {});
    }
    if (dstFd) {
      await dstFd.close().catch(() => {});
    }
    if (dstCreated) {
      await unlink(targetPath).catch(error => {
        if (!absent(error)) throw error;
      });
    }
  }
}
