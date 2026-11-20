import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { ControllerFailure, refuse, type ControllerDiagnostic } from './errors.js';

export const STREAM_CHUNK_BYTES = 1_048_576;

export function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

export async function canonicalComponents(path: string, owned = true): Promise<void> {
  const code = owned ? 'REGISTRY_UNTRUSTED' : 'CONFIG_SYNTAX';
  const path_ = owned ? '/registry' : '/config';
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 4096 || /[\0\r\n]/.test(path)) refuse(code, path_);
  let current = path, count = 0;
  while (true) {
    if (++count > 128 || (await lstat(current)).isSymbolicLink()) refuse(code, path_);
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  if (await realpath(path) !== path) refuse(code, path_);
}

export async function readBoundedFile(path: string, maximum: number, owned: boolean): Promise<Buffer> {
  try {
    await canonicalComponents(path, owned);
    const before = await lstat(path);
    if (!before.isFile() || before.nlink !== 1 || before.size > maximum) refuse(before.size > maximum ? 'CONFIG_LIMIT' : owned ? 'REGISTRY_UNTRUSTED' : 'CONFIG_SYNTAX', owned ? '/registry' : '/config');
    if (owned) {
      const parent = await lstat(dirname(path));
      if (before.uid !== process.getuid?.() || before.mode & 0o077 || parent.uid !== process.getuid?.() || parent.mode & 0o077) refuse('REGISTRY_UNTRUSTED', '/registry');
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat(); if (info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size || info.nlink !== 1 || !info.isFile()) refuse(owned ? 'REGISTRY_UNTRUSTED' : 'CONFIG_SYNTAX', owned ? '/registry' : '/config');
      const bytes = Buffer.alloc(info.size + 1); let size = 0;
      while (size < bytes.length) { const next = await file.read(bytes, size, bytes.length - size, size); if (!next.bytesRead) break; size += next.bytesRead; }
      const after = await file.stat(), current = await lstat(path);
      if (size !== info.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs || current.dev !== info.dev || current.ino !== info.ino || after.size !== info.size) refuse(owned ? 'REGISTRY_UNTRUSTED' : 'CONFIG_SYNTAX', owned ? '/registry' : '/config');
      return bytes.subarray(0, size);
    } finally { await file.close(); }
  } catch (error) { if (error instanceof ControllerFailure) throw error; refuse(owned ? 'REGISTRY_UNTRUSTED' : 'CONFIG_SYNTAX', owned ? '/registry' : '/config'); }
}

export async function writeAllToHandle(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let written = 0;
  while (written < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, written, chunk.byteLength - written);
    if (bytesWritten <= 0) throw new Error('Short write returned zero bytesWritten');
    written += bytesWritten;
  }
}

export interface StreamRegularFileOptions {
  readonly maxBytes?: number | undefined;
  readonly expectedBytes?: number | undefined;
  readonly owned?: boolean | undefined;
  readonly requireReadOnly?: boolean | undefined;
  readonly verifyCanonicalPath?: boolean | undefined;
  readonly code?: ControllerDiagnostic['code'] | undefined;
  readonly limitCode?: ControllerDiagnostic['code'] | undefined;
  readonly path?: string | undefined;
  readonly phase?: ControllerDiagnostic['phase'] | undefined;
  readonly onOpen?: ((info: { readonly byteLength: number }) => void) | undefined;
}

export interface StreamedFileSummary {
  readonly byteLength: number;
  readonly mode: '100644' | '100755';
  readonly rawMode: number;
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export async function streamRegularFile(
  path: string,
  options: StreamRegularFileOptions = {},
  onChunk?: (chunk: Uint8Array) => Promise<void> | void,
): Promise<StreamedFileSummary> {
  const phase = options.phase ?? 'execution';
  const diagPath = options.path ?? '';
  const code = options.code ?? 'ARTIFACT_INVALID';
  const limitCode = options.limitCode ?? 'OUTPUT_LIMIT';
  const fail = (overrideCode: ControllerDiagnostic['code'] = code): never => refuse(overrideCode, diagPath, phase);

  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || /[\0\r\n]/.test(path)) {
    return fail();
  }

  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    if (options.verifyCanonicalPath) {
      await canonicalComponents(path, options.owned ?? true);
    }
    before = await lstat(path);
  } catch (error) {
    if (error instanceof ControllerFailure && error.diagnostic.code === code && error.diagnostic.phase === phase) {
      throw error;
    }
    return fail();
  }

  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) return fail();
  if (options.owned && before.uid !== process.getuid?.()) return fail();
  if (options.requireReadOnly && (before.mode & 0o222) !== 0) return fail();
  if (options.maxBytes !== undefined && before.size > options.maxBytes) return fail(limitCode);
  if (options.expectedBytes !== undefined && before.size !== options.expectedBytes) return fail();

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return fail();
  }

  try {
    let info: Awaited<ReturnType<typeof handle.stat>>;
    try {
      info = await handle.stat();
    } catch {
      return fail();
    }
    if (
      !info.isFile()
      || info.nlink !== 1
      || info.dev !== before.dev
      || info.ino !== before.ino
      || info.size !== before.size
    ) {
      return fail();
    }
    if (options.owned && info.uid !== process.getuid?.()) return fail();
    if (options.requireReadOnly && (info.mode & 0o222) !== 0) return fail();
    if (options.maxBytes !== undefined && info.size > options.maxBytes) return fail(limitCode);
    if (options.expectedBytes !== undefined && info.size !== options.expectedBytes) return fail();
    options.onOpen?.({ byteLength: info.size });

    const buffer = Buffer.allocUnsafe(Math.min(STREAM_CHUNK_BYTES, Math.max(1, info.size)));
    let offset = 0;
    while (offset < info.size) {
      let bytesRead = 0;
      try {
        const res = await handle.read(buffer, 0, Math.min(buffer.byteLength, info.size - offset), offset);
        bytesRead = res.bytesRead;
      } catch {
        return fail();
      }
      if (bytesRead <= 0) break;
      offset += bytesRead;
      if (onChunk !== undefined) {
        await onChunk(buffer.subarray(0, bytesRead));
      }
    }

    let extraBytesRead = 0;
    let after: Awaited<ReturnType<typeof handle.stat>>;
    try {
      const probe = Buffer.allocUnsafe(1);
      extraBytesRead = (await handle.read(probe, 0, 1, offset)).bytesRead;
      after = await handle.stat();
    } catch {
      return fail();
    }
    if (
      extraBytesRead !== 0
      || offset !== info.size
      || !after.isFile()
      || after.nlink !== 1
      || after.dev !== info.dev
      || after.ino !== info.ino
      || after.size !== info.size
      || after.mtimeMs !== info.mtimeMs
      || after.ctimeMs !== info.ctimeMs
      || (options.requireReadOnly && (after.mode & 0o222) !== 0)
    ) {
      return fail();
    }
    return {
      byteLength: after.size,
      mode: (after.mode & 0o111) !== 0 ? '100755' : '100644',
      rawMode: after.mode,
      dev: after.dev,
      ino: after.ino,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
    };
  } finally {
    await handle.close();
  }
}

export interface CopyVerifiedFileOptions {
  readonly maxBytes?: number | undefined;
  readonly expectedBytes?: number | undefined;
  readonly expectedSha256?: string | undefined;
  readonly mode?: number | undefined;
  readonly ownedSource?: boolean | undefined;
  readonly requireReadOnlySource?: boolean | undefined;
  readonly verifyCanonicalSource?: boolean | undefined;
  readonly disableReflink?: boolean | undefined;
  readonly code?: ControllerDiagnostic['code'] | undefined;
  readonly limitCode?: ControllerDiagnostic['code'] | undefined;
  readonly path?: string | undefined;
  readonly phase?: ControllerDiagnostic['phase'] | undefined;
}

export interface CopiedVerifiedFile {
  readonly byteLength: number;
  readonly sha256: string;
  readonly sourceMode: '100644' | '100755';
}

export async function copyVerifiedFileReadOnly(
  srcPath: string,
  destPath: string,
  options: CopyVerifiedFileOptions = {},
): Promise<CopiedVerifiedFile> {
  const phase = options.phase ?? 'execution';
  const diagPath = options.path ?? '';
  const code = options.code ?? 'ARTIFACT_INVALID';
  const limitCode = options.limitCode ?? 'OUTPUT_LIMIT';
  const targetMode = options.mode ?? 0o400;
  const fail = (overrideCode: ControllerDiagnostic['code'] = code): never => refuse(overrideCode, diagPath, phase);

  if (
    typeof srcPath !== 'string'
    || !isAbsolute(srcPath)
    || srcPath.length > 4096
    || /[\0\r\n]/.test(srcPath)
    || typeof destPath !== 'string'
    || !isAbsolute(destPath)
    || destPath.length > 4096
    || /[\0\r\n]/.test(destPath)
  ) {
    return fail();
  }

  let destExists = false;
  try {
    await lstat(destPath);
    destExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') return fail();
  }
  if (destExists) return fail();

  const tmpPath = join(dirname(destPath), `.lw-stage-${randomBytes(12).toString('hex')}`);
  let srcHandle: Awaited<ReturnType<typeof open>> | null = null;
  let tmpHandle: Awaited<ReturnType<typeof open>> | null = null;
  let destVerify: Awaited<ReturnType<typeof open>> | null = null;
  let tmpCreated = false;
  let tmpUnlinked = false;

  try {
    if (options.verifyCanonicalSource) {
      await canonicalComponents(srcPath, options.ownedSource ?? true);
    }

    srcHandle = await open(srcPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const srcBefore = await srcHandle.stat();
    if (srcBefore.isSymbolicLink() || !srcBefore.isFile() || srcBefore.nlink !== 1) return fail();
    if (options.ownedSource && srcBefore.uid !== process.getuid?.()) return fail();
    if (options.requireReadOnlySource && (srcBefore.mode & 0o222) !== 0) return fail();
    if (options.maxBytes !== undefined && srcBefore.size > options.maxBytes) return fail(limitCode);
    if (options.expectedBytes !== undefined && srcBefore.size !== options.expectedBytes) return fail();
    const sourceMode: '100644' | '100755' = (srcBefore.mode & 0o111) !== 0 ? '100755' : '100644';

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
      return fail();
    }

    const buf = Buffer.allocUnsafe(Math.min(STREAM_CHUNK_BYTES, Math.max(1, srcBefore.size)));
    const writeSha = createHash('sha256');
    let writtenBytes = 0;
    while (writtenBytes < srcBefore.size) {
      const toRead = Math.min(buf.byteLength, srcBefore.size - writtenBytes);
      const { bytesRead } = await srcHandle.read(buf, 0, toRead, writtenBytes);
      if (bytesRead <= 0) break;
      const slice = buf.subarray(0, bytesRead);
      writtenBytes += bytesRead;
      if (options.maxBytes !== undefined && writtenBytes > options.maxBytes) {
        return fail(limitCode);
      }
      writeSha.update(slice);
      await writeAllToHandle(tmpHandle, slice);
    }

    const probe = Buffer.allocUnsafe(1);
    const extraSrcRead = (await srcHandle.read(probe, 0, 1, writtenBytes)).bytesRead;
    const srcAfter = await srcHandle.stat();
    const writeShaHex = writeSha.digest('hex');
    if (
      extraSrcRead !== 0
      || !srcAfter.isFile()
      || srcAfter.isSymbolicLink()
      || srcAfter.nlink !== 1
      || srcAfter.dev !== srcBefore.dev
      || srcAfter.ino !== srcBefore.ino
      || srcAfter.size !== srcBefore.size
      || srcAfter.mtimeMs !== srcBefore.mtimeMs
      || srcAfter.ctimeMs !== srcBefore.ctimeMs
      || (options.requireReadOnlySource && (srcAfter.mode & 0o222) !== 0)
      || writtenBytes !== srcBefore.size
    ) {
      return fail();
    }
    if (options.expectedSha256 !== undefined && writeShaHex !== options.expectedSha256) {
      return fail();
    }

    const storedSha = createHash('sha256');
    let readOffset = 0;
    while (readOffset < writtenBytes) {
      const toRead = Math.min(buf.byteLength, writtenBytes - readOffset);
      const { bytesRead } = await tmpHandle.read(buf, 0, toRead, readOffset);
      if (bytesRead <= 0) break;
      storedSha.update(buf.subarray(0, bytesRead));
      readOffset += bytesRead;
    }
    const extraTmpRead = (await tmpHandle.read(probe, 0, 1, readOffset)).bytesRead;
    const tmpAfterRead = await tmpHandle.stat();
    if (
      extraTmpRead !== 0
      || readOffset !== writtenBytes
      || storedSha.digest('hex') !== writeShaHex
      || !tmpAfterRead.isFile()
      || tmpAfterRead.isSymbolicLink()
      || tmpAfterRead.dev !== createdStat.dev
      || tmpAfterRead.ino !== createdStat.ino
      || tmpAfterRead.nlink !== 1
      || tmpAfterRead.size !== writtenBytes
    ) {
      return fail();
    }

    await tmpHandle.chmod(targetMode);
    await tmpHandle.sync();
    const sealedStat = await tmpHandle.stat();
    if (
      !sealedStat.isFile()
      || sealedStat.isSymbolicLink()
      || sealedStat.dev !== createdStat.dev
      || sealedStat.ino !== createdStat.ino
      || sealedStat.nlink !== 1
      || sealedStat.size !== writtenBytes
      || (sealedStat.mode & 0o777) !== (targetMode & 0o777)
    ) {
      return fail();
    }

    await link(tmpPath, destPath);
    await unlink(tmpPath);
    tmpUnlinked = true;

    destVerify = await open(destPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const destStat = await destVerify.stat();
    const pinnedStat = await tmpHandle.stat();
    if (
      !destStat.isFile()
      || destStat.isSymbolicLink()
      || destStat.nlink !== 1
      || destStat.dev !== createdStat.dev
      || destStat.ino !== createdStat.ino
      || destStat.size !== writtenBytes
      || (destStat.mode & 0o777) !== (targetMode & 0o777)
      || pinnedStat.nlink !== 1
    ) {
      return fail();
    }

    await destVerify.close();
    destVerify = null;
    await tmpHandle.close();
    tmpHandle = null;

    return {
      byteLength: writtenBytes,
      sha256: writeShaHex,
      sourceMode,
    };
  } catch (error) {
    if (error instanceof ControllerFailure && error.diagnostic.code === code && error.diagnostic.phase === phase) {
      throw error;
    }
    if (error instanceof ControllerFailure && error.diagnostic.code === limitCode && error.diagnostic.phase === phase) {
      throw error;
    }
    return fail();
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
