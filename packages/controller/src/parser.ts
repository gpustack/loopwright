import { parseDocument, isAlias, isMap, isSeq, isScalar, Lexer, CST } from 'yaml';
import { refuse } from './errors.js';
import type { Json } from './schema.js';
export const DOCUMENT_BYTES = 1048576;
/** Lex before JSON.parse so duplicate names and hostile nesting cannot disappear during conversion. */
function json(source: string, collectionLimit = 128, nodeLimit = 8192): Json {
  let offset = 0, nodes = 0;
  const space = () => { while (/[\t\n\r ]/.test(source[offset] ?? '') && offset < source.length) offset++; };
  const string = (): string => {
    const start = offset++;
    while (offset < source.length) {
      const char = source[offset++];
      if (char === '\\') { offset++; continue; }
      if (char === '"') {
        let value: unknown; try { value = JSON.parse(source.slice(start, offset)); } catch { refuse('CONFIG_SYNTAX'); }
        if (typeof value !== 'string' || value.length > 16384) refuse('CONFIG_LIMIT'); return value;
      }
    }
    refuse('CONFIG_SYNTAX');
  };
  const value = (depth: number): void => {
    if (++nodes > nodeLimit || depth > 32) refuse('CONFIG_LIMIT'); space();
    const char = source[offset];
    if (char === '"') { string(); return; }
    if (char === '{' || char === '[') {
      offset++; space(); const close = char === '{' ? '}' : ']', names = new Set<string>(); let count = 0;
      if (source[offset] === close) { offset++; return; }
      while (true) {
        if (++count > collectionLimit) refuse('CONFIG_LIMIT'); space();
        if (char === '{') {
          if (source[offset] !== '"') refuse('CONFIG_SYNTAX'); const name = string();
          if (names.has(name)) refuse('CONFIG_DUPLICATE_KEY'); names.add(name); space(); if (source[offset++] !== ':') refuse('CONFIG_SYNTAX');
        }
        value(depth + 1); space(); const delimiter = source[offset++];
        if (delimiter === close) return; if (delimiter !== ',') refuse('CONFIG_SYNTAX');
      }
    }
    const literal = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(offset));
    if (!literal) refuse('CONFIG_SYNTAX'); offset += literal[0].length;
    if (!['true', 'false', 'null'].includes(literal[0])) { const number = Number(literal[0]); if (!Number.isSafeInteger(number) || Object.is(number, -0)) refuse('CONFIG_LIMIT'); }
  };
  value(1); space(); if (offset !== source.length) refuse('CONFIG_SYNTAX');
  try { return JSON.parse(source) as Json; } catch { refuse('CONFIG_SYNTAX'); }
}
function yaml(source: string): Json {
  let flow = 0, tokens = 0, scalar = false, inlineSequence = 0;
  for (const token of new Lexer().lex(source)) {
    if (scalar) { scalar = false; continue; }
    const kind = CST.tokenType(token);
    if (kind === 'scalar') scalar = true;
    if (kind === 'newline') inlineSequence = 0;
    if (kind === 'seq-item-ind' && ++inlineSequence > 32) refuse('CONFIG_LIMIT');
    if (kind === 'flow-map-start' || kind === 'flow-seq-start') { if (++flow > 32) refuse('CONFIG_LIMIT'); }
    if (kind === 'flow-map-end' || kind === 'flow-seq-end') flow--;
    if (!['space', 'newline', 'comment'].includes(kind ?? '') && ++tokens > 65536) refuse('CONFIG_LIMIT');
  }
  const document = parseDocument(source, { version: '1.2', schema: 'core', uniqueKeys: true, merge: false, strict: true, customTags: [] });
  if (document.errors.length) refuse(document.errors.some(error => error.code === 'DUPLICATE_KEY') ? 'CONFIG_DUPLICATE_KEY' : 'CONFIG_SYNTAX');
  let nodes = 0;
  function visit(node: unknown, depth: number): void {
    if (++nodes > 8192 || depth > 32) refuse('CONFIG_LIMIT');
    if (node === null) return;
    if (isAlias(node) || !node || typeof node !== 'object' || 'tag' in node && node.tag !== undefined || 'anchor' in node && node.anchor !== undefined) refuse('CONFIG_SYNTAX');
    if (isMap(node)) {
      if (node.items.length > 128) refuse('CONFIG_LIMIT');
      for (const pair of node.items) { if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || pair.key.value === '<<' || pair.key.value.length > 16384) refuse('CONFIG_SYNTAX'); visit(pair.key, depth + 1); visit(pair.value, depth + 1); }
    } else if (isSeq(node)) { if (node.items.length > 128) refuse('CONFIG_LIMIT'); for (const child of node.items) visit(child, depth + 1); }
    else {
      if (!isScalar(node) || node.value !== null && !['string', 'boolean', 'number'].includes(typeof node.value)) refuse('CONFIG_SYNTAX');
      if (typeof node.value === 'string' && node.value.length > 16384 || typeof node.value === 'number' && (!Number.isSafeInteger(node.value) || Object.is(node.value, -0))) refuse('CONFIG_LIMIT');
    }
  }
  visit(document.contents, 1); return document.toJS({ maxAliasCount: 0 }) as Json;
}
export function parseDocumentBytes(bytes: Uint8Array, format: 'json' | 'yaml'): Json {
  if (bytes.byteLength > DOCUMENT_BYTES) refuse('CONFIG_LIMIT');
  let source: string; try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { refuse('CONFIG_SYNTAX'); }
  return format === 'json' ? json(source) : yaml(source);
}
/** Private immutable records have their own explicit collection bound; authoring config keeps the default 128. */
export function parsePrivateJson(bytes: Uint8Array, maximum: number, collectionLimit = 256): Json {
  if (bytes.byteLength > maximum || maximum > 8388608 || collectionLimit > 2048) refuse('ARTIFACT_INVALID', '', 'recovery');
  try { return json(new TextDecoder('utf-8', { fatal: true }).decode(bytes), collectionLimit, 65536); }
  catch { refuse('ARTIFACT_INVALID', '', 'recovery'); }
}
