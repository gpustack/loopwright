import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { CST, isAlias, isMap, isScalar, isSeq, Lexer, parseDocument, stringify } from 'yaml';
import { TaskpackError } from './types.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// Twin yaml@2.9.1 AST traversal caps shared with packages/decisions/src/schema.ts (4096 nodes, depth 16, 512 collection items, 8192 string chars).
const MAX_NODES = 4096;
const MAX_DEPTH = 16;
const MAX_COLLECTION = 512;
const MAX_STRING = 8192;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function yamlInvalid(message: string, path: string): never {
  throw new TaskpackError('TASKPACK_MANIFEST_INVALID', message, path);
}

/**
 * Deterministic YAML 1.2 core-schema parser via `yaml`, rejecting anchors, aliases,
 * merge keys, duplicate keys, tags, non-finite numbers, and bounded AST/token limits.
 */
export function parseYamlDocument(source: string): Json {
  let flow = 0, tokens = 0, scalar = false, inlineSequence = 0;
  for (const token of new Lexer().lex(source)) {
    if (scalar) { scalar = false; continue; }
    const kind = CST.tokenType(token);
    if (kind === 'scalar') scalar = true;
    if (kind === 'newline') inlineSequence = 0;
    if (kind === 'seq-item-ind' && ++inlineSequence > 32) yamlInvalid('YAML inline sequence exceeds depth limits', '/');
    if (kind === 'flow-map-start' || kind === 'flow-seq-start') { if (++flow > 32) yamlInvalid('YAML flow collection exceeds depth limits', '/'); }
    if (kind === 'flow-map-end' || kind === 'flow-seq-end') flow--;
    if (!['space', 'newline', 'comment'].includes(kind ?? '') && ++tokens > 65536) yamlInvalid('YAML document exceeds token limits', '/');
  }
  const document = parseDocument(source, { version: '1.2', schema: 'core', uniqueKeys: true, merge: false, strict: true, customTags: [] });
  if (document.errors.length > 0) {
    yamlInvalid(document.errors[0]?.message ?? 'invalid YAML syntax', '/');
  }
  let nodes = 0;
  function visit(node: unknown, depth: number, path: string): void {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) yamlInvalid('YAML document exceeds node or depth limits', path);
    if (node === null) return;
    if (
      isAlias(node) || !node || typeof node !== 'object' ||
      ('tag' in node && node.tag !== undefined) ||
      ('anchor' in node && node.anchor !== undefined)
    ) {
      yamlInvalid('YAML aliases, anchors, and tags are unsupported', path);
    }
    if (isMap(node)) {
      if (node.items.length > MAX_COLLECTION) yamlInvalid('YAML mapping exceeds collection limits', path);
      const seen = new Set<string>();
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || pair.key.value === '<<' || pair.key.value.length > MAX_STRING) {
          yamlInvalid('YAML mapping key must be a valid string', path);
        }
        const key = pair.key.value;
        if (FORBIDDEN_KEYS.has(key)) yamlInvalid(`forbidden key "${key}"`, path);
        if (seen.has(key)) yamlInvalid(`duplicate key "${key}"`, `${path}/${key}`);
        seen.add(key);
        visit(pair.key, depth + 1, `${path}/${key}`);
        visit(pair.value, depth + 1, `${path}/${key}`);
      }
    } else if (isSeq(node)) {
      if (node.items.length > MAX_COLLECTION) yamlInvalid('YAML sequence exceeds collection limits', path);
      for (const [idx, child] of node.items.entries()) visit(child, depth + 1, `${path}/${idx}`);
    } else {
      if (!isScalar(node) || (node.value !== null && !['string', 'boolean', 'number'].includes(typeof node.value))) {
        yamlInvalid('unsupported YAML scalar value', path);
      }
      if (typeof node.value === 'string' && node.value.length > MAX_STRING) {
        yamlInvalid('YAML string exceeds length limits', path);
      }
      if (typeof node.value === 'number' && (!Number.isFinite(node.value) || Object.is(node.value, -0))) {
        yamlInvalid('YAML number out of bounds', path);
      }
    }
  }
  visit(document.contents, 1, '/');
  return document.toJS({ maxAliasCount: 0 }) as Json;
}

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
      throw new TaskpackError('TASKPACK_MANIFEST_INVALID', 'YAML serializer requires finite numbers');
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
        throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `forbidden key "${k}"`);
      }
      if (v !== undefined) assertValidYamlValue(v);
    }
    return;
  }
  throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `unsupported YAML value type: ${typeof value}`);
}

/**
 * Deterministic two-space YAML 1.2 core-schema serializer for JSON-compatible values.
 * Uses `yaml` (`stringify(value, { indent: 2, schema: 'core', lineWidth: 0 })`).
 */
export function serializePrettyYaml(value: unknown): string {
  assertValidYamlValue(value);
  return stringify(value, { indent: 2, schema: 'core', lineWidth: 0, aliasDuplicateObjects: false });
}
