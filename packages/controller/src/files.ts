import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { ControllerFailure, refuse } from './errors.js';
export function inside(path: string, root: string): boolean { return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep); }
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
