import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { ControllerFailure, refuse, type ControllerDiagnostic } from './errors.js';

export const STREAM_CHUNK_BYTES = 65_536;

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
}

export interface StreamedFileSummary {
  readonly byteLength: number;
  readonly mode: '100644' | '100755';
  readonly rawMode: number;
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
      || after.nlink !== 1
      || after.size !== info.size
      || after.mtimeMs !== info.mtimeMs
      || after.ctimeMs !== info.ctimeMs
    ) {
      return fail();
    }
    return {
      byteLength: info.size,
      mode: (info.mode & 0o111) !== 0 ? '100755' : '100644',
      rawMode: info.mode,
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
  const fail = (): never => refuse(code, diagPath, phase);

  if (typeof destPath !== 'string' || !isAbsolute(destPath) || destPath.length > 4096 || /[\0\r\n]/.test(destPath)) {
    return fail();
  }

  let destHandle: Awaited<ReturnType<typeof open>>;
  try {
    destHandle = await open(
      destPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    return fail();
  }

  let closed = false;
  let committed = false;
  try {
    const sha = createHash('sha256');
    const summary = await streamRegularFile(
      srcPath,
      {
        maxBytes: options.maxBytes,
        expectedBytes: options.expectedBytes,
        owned: options.ownedSource,
        requireReadOnly: options.requireReadOnlySource,
        verifyCanonicalPath: options.verifyCanonicalSource,
        code,
        limitCode: options.limitCode,
        path: diagPath,
        phase,
      },
      async chunk => {
        sha.update(chunk);
        try {
          await writeAllToHandle(destHandle, chunk);
        } catch {
          return fail();
        }
      },
    );
    const sha256 = sha.digest('hex');
    if (options.expectedSha256 !== undefined && sha256 !== options.expectedSha256) {
      return fail();
    }
    try {
      await destHandle.chmod(options.mode ?? 0o400);
      await destHandle.sync();
      await destHandle.close();
      closed = true;
    } catch {
      return fail();
    }
    committed = true;
    return {
      byteLength: summary.byteLength,
      sha256,
      sourceMode: summary.mode,
    };
  } finally {
    if (!closed) {
      await destHandle.close().catch(() => {});
    }
    if (!committed) {
      await unlink(destPath).catch(() => {});
    }
  }
}
