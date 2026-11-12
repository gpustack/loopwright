import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { stringify } from 'yaml';
import { GitHubAppError } from './types.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Read a regular non-symlink file with `O_NOFOLLOW` and a strict `maxBytes` cap (`size + 1` bounded read loop).
 * Invokes `onInvalid` if the path is missing, a symlink, not a regular file, exceeds `maxBytes`, or mutates while reading.
 */
export async function readBoundedRegularFile(
  filePath: string,
  maxBytes: number,
  onInvalid: (message: string) => never,
): Promise<Uint8Array> {
  const before = await lstat(filePath).catch(() => null);
  if (before === null || before.isSymbolicLink() || !before.isFile()) {
    onInvalid('file must be a regular non-symlink file');
  }
  if (before.size > maxBytes) {
    onInvalid(`file exceeds ${maxBytes} bytes`);
  }
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(filePath, constants.O_RDONLY | noFollow).catch(() => null);
  if (handle === null) {
    onInvalid('file could not be opened');
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== before.size || info.size > maxBytes) {
      onInvalid('file changed size while loading or exceeds the byte limit');
    }
    const buf = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < buf.length) {
      const read = await handle.read(buf, size, buf.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size !== info.size) {
      onInvalid('file changed while loading');
    }
    return buf.subarray(0, size);
  } finally {
    await handle.close();
  }
}

function assertValidYamlValue(value: unknown): void {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', 'YAML serializer requires finite numbers');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertValidYamlValue(item);
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(k)) {
        throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', `forbidden key "${k}"`);
      }
      if (v !== undefined) assertValidYamlValue(v);
    }
    return;
  }
  throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', `unsupported YAML value type: ${typeof value}`);
}

/**
 * Deterministic two-space YAML 1.2 core-schema serializer for JSON-compatible values.
 * Uses `yaml` (`stringify(value, { indent: 2, schema: 'core', lineWidth: 0 })`).
 */
export function serializePrettyYaml(value: unknown): string {
  assertValidYamlValue(value);
  return stringify(value, { indent: 2, schema: 'core', lineWidth: 0 });
}
