import { LIMITS, OVERLAY_LIMITS } from './limits.js';
import { fail } from './diagnostics.js';

export const API_VERSION = 'loopwright.dev/v1alpha1' as const;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface SnapshotBounds {
  readonly inputBytes?: number;
  readonly nodes?: number;
  readonly collection?: number;
}

export function overlaySnapshotBounds(maxFiles?: number): SnapshotBounds | undefined {
  if (maxFiles === undefined || maxFiles <= LIMITS.overlayEntries) return undefined;
  const capped = Math.min(maxFiles, OVERLAY_LIMITS.maxMaxFiles);
  const extra = capped - LIMITS.overlayEntries;
  return {
    collection: Math.max(LIMITS.collection, capped + 1),
    nodes: LIMITS.nodes + extra * 16,
    inputBytes: LIMITS.inputBytes + extra * 4_608,
  };
}

const MAX_DEFERRED_MANIFEST_BYTES = overlaySnapshotBounds(OVERLAY_LIMITS.maxMaxFiles)!.inputBytes!;

function validString(value: string): void {
  if (value.length > LIMITS.string) fail('LIMIT_STRING');
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) fail('INPUT_UNSUPPORTED');
}

const JSON_TOKEN_PATTERN = /(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;

// The scanner rejects duplicate decoded keys and bounds work before native parsing.
function readJson(text: string, bounds?: SnapshotBounds, startDepth = 1): unknown {
  const maxInputBytes = bounds?.inputBytes ?? LIMITS.inputBytes;
  const maxNodes = bounds?.nodes ?? LIMITS.nodes;
  const maxCollection = bounds?.collection ?? LIMITS.collection;
  if (text.length > maxInputBytes || Buffer.byteLength(text) > maxInputBytes) fail('LIMIT_BYTES');
  type Frame = { kind: 'object' | 'array'; state: string; keys: Set<string>; count: number };
  const stack: Frame[] = [];
  let offset = 0, nodes = 0, rootDone = false;
  const space = () => { while (offset < text.length && /[\x20\t\r\n]/.test(text[offset]!)) offset++; };
  const string = (): string => {
    const start = offset++;
    let closed = false;
    while (offset < text.length) {
      const char = text[offset++];
      if (char === '"') { closed = true; break; }
      if (char === '\\') offset++;
    }
    if (!closed) fail('JSON_SYNTAX');
    let value: unknown;
    try { value = JSON.parse(text.slice(start, offset)); } catch { fail('JSON_SYNTAX'); }
    if (typeof value !== 'string') fail('JSON_SYNTAX');
    validString(value);
    return value;
  };
  const value = () => {
    if (++nodes > maxNodes) fail('LIMIT_NODES');
    // Depth counts the root as one, including primitive leaves.
    if (stack.length + startDepth > LIMITS.depth) fail('LIMIT_DEPTH');
    const char = text[offset];
    if (char === '{' || char === '[') {
      stack.push({ kind: char === '{' ? 'object' : 'array', state: char === '{' ? 'keyOrEnd' : 'valueOrEnd', keys: new Set(), count: 0 });
      offset++; return;
    }
    if (char === '"') { string(); return; }
    JSON_TOKEN_PATTERN.lastIndex = offset;
    const token = JSON_TOKEN_PATTERN.exec(text);
    if (!token) fail('JSON_SYNTAX');
    offset += token[0].length;
  };
  while (true) {
    space();
    const frame = stack.at(-1);
    if (!frame) {
      if (rootDone) { if (offset !== text.length) fail('JSON_SYNTAX'); break; }
      rootDone = true; value(); continue;
    }
    const char = text[offset];
    if (frame.state === 'colon') {
      if (char !== ':') fail('JSON_SYNTAX');
      offset++; frame.state = 'value'; continue;
    }
    if (frame.state === 'commaOrEnd') {
      if (char === (frame.kind === 'object' ? '}' : ']')) { stack.pop(); offset++; continue; }
      if (char !== ',') fail('JSON_SYNTAX');
      offset++; frame.state = frame.kind === 'object' ? 'key' : 'value'; continue;
    }
    if (frame.state === 'keyOrEnd' && char === '}') { stack.pop(); offset++; continue; }
    if (frame.state === 'valueOrEnd' && char === ']') { stack.pop(); offset++; continue; }
    if (frame.kind === 'object' && (frame.state === 'keyOrEnd' || frame.state === 'key')) {
      if (char !== '"') fail('JSON_SYNTAX');
      const key = string();
      if (frame.keys.has(key)) fail('JSON_DUPLICATE_MEMBER');
      frame.keys.add(key);
      if (++frame.count > LIMITS.properties) fail('LIMIT_COLLECTION');
      frame.state = 'colon'; continue;
    }
    if (frame.kind === 'array' && ++frame.count > maxCollection) fail('LIMIT_COLLECTION');
    frame.state = 'commaOrEnd'; value();
  }
  try { return JSON.parse(text); } catch { fail('JSON_SYNTAX'); }
}

// Locate the first JSON value slice at root.trusted.candidateManifest without widening bounds for the rest of the text.
function extractDeferredJsonManifest(text: string): { readonly restText: string; readonly fieldText: string } | undefined {
  const maxCombinedBytes = LIMITS.inputBytes + MAX_DEFERRED_MANIFEST_BYTES;
  if (text.length > maxCombinedBytes || Buffer.byteLength(text) > maxCombinedBytes) fail('LIMIT_BYTES');
  let offset = 0;
  const space = () => { while (offset < text.length && /[\x20\t\r\n]/.test(text[offset]!)) offset++; };
  const readRawString = (): string | undefined => {
    if (text[offset] !== '"') return undefined;
    const start = offset++;
    let closed = false;
    while (offset < text.length) {
      const char = text[offset++];
      if (char === '"') { closed = true; break; }
      if (char === '\\') offset++;
    }
    if (!closed) return undefined;
    try {
      const parsed: unknown = JSON.parse(text.slice(start, offset));
      return typeof parsed === 'string' ? parsed : undefined;
    } catch { return undefined; }
  };
  const skipValue = (startDepth: number): boolean => {
    type Frame = { kind: 'object' | 'array'; state: string };
    const stack: Frame[] = [];
    let rootDone = false;
    const pushValue = (): boolean => {
      if (stack.length + startDepth > LIMITS.depth) fail('LIMIT_DEPTH');
      const char = text[offset];
      if (char === '{' || char === '[') {
        stack.push({ kind: char === '{' ? 'object' : 'array', state: char === '{' ? 'keyOrEnd' : 'valueOrEnd' });
        offset++; return true;
      }
      if (char === '"') {
        offset++;
        while (offset < text.length) {
          const c = text[offset++];
          if (c === '"') return true;
          if (c === '\\') { if (offset >= text.length) return false; offset++; }
        }
        return false;
      }
      JSON_TOKEN_PATTERN.lastIndex = offset;
      const token = JSON_TOKEN_PATTERN.exec(text);
      if (!token) return false;
      offset += token[0].length;
      return true;
    };
    while (true) {
      space();
      const frame = stack.at(-1);
      if (!frame) {
        if (rootDone) return true;
        rootDone = true;
        if (!pushValue()) return false;
        continue;
      }
      const char = text[offset];
      if (frame.state === 'colon') {
        if (char !== ':') return false;
        offset++; frame.state = 'value'; continue;
      }
      if (frame.state === 'commaOrEnd') {
        if (char === (frame.kind === 'object' ? '}' : ']')) { stack.pop(); offset++; continue; }
        if (char !== ',') return false;
        offset++; frame.state = frame.kind === 'object' ? 'key' : 'value'; continue;
      }
      if (frame.state === 'keyOrEnd' && char === '}') { stack.pop(); offset++; continue; }
      if (frame.state === 'valueOrEnd' && char === ']') { stack.pop(); offset++; continue; }
      if (frame.kind === 'object' && (frame.state === 'keyOrEnd' || frame.state === 'key')) {
        if (char !== '"') return false;
        offset++;
        let closed = false;
        while (offset < text.length) {
          const c = text[offset++];
          if (c === '"') { closed = true; break; }
          if (c === '\\') { if (offset >= text.length) return false; offset++; }
        }
        if (!closed) return false;
        frame.state = 'colon'; continue;
      }
      frame.state = 'commaOrEnd';
      if (!pushValue()) return false;
    }
  };

  space();
  if (text[offset] !== '{') return undefined;
  offset++;
  let rootProps = 0;
  while (true) {
    space();
    if (text[offset] === '}') return undefined;
    const key = readRawString();
    if (key === undefined || ++rootProps > LIMITS.properties) return undefined;
    space();
    if (text[offset] !== ':') return undefined;
    offset++;
    space();
    if (key === 'trusted' && text[offset] === '{') {
      offset++;
      let trustedProps = 0;
      while (true) {
        space();
        if (text[offset] === '}') break;
        const innerKey = readRawString();
        if (innerKey === undefined || ++trustedProps > LIMITS.properties) return undefined;
        space();
        if (text[offset] !== ':') return undefined;
        offset++;
        space();
        if (innerKey === 'candidateManifest') {
          const valStart = offset;
          if (!skipValue(3)) return undefined;
          const valEnd = offset;
          const fieldText = text.slice(valStart, valEnd);
          if (Buffer.byteLength(fieldText) > MAX_DEFERRED_MANIFEST_BYTES) fail('LIMIT_BYTES');
          return { restText: text.slice(0, valStart) + 'null' + text.slice(valEnd), fieldText };
        }
        if (!skipValue(3)) return undefined;
        space();
        if (text[offset] === ',') { offset++; continue; }
        if (text[offset] === '}') break;
        return undefined;
      }
      return undefined;
    }
    if (!skipValue(2)) return undefined;
    space();
    if (text[offset] === ',') { offset++; continue; }
    return undefined;
  }
}

interface SnapshotInternalOptions {
  readonly bounds?: SnapshotBounds | undefined;
  readonly startDepth?: number;
  readonly seen?: WeakSet<object>;
  readonly deferTrustedManifest?: boolean;
}

function snapshotTree(
  input: unknown,
  options: SnapshotInternalOptions = {},
): { readonly value: Json; readonly deferredManifest?: { readonly present: true; readonly raw: unknown } } {
  const bounds = options.bounds;
  const startDepth = options.startDepth ?? 1;
  const maxInputBytes = bounds?.inputBytes ?? LIMITS.inputBytes;
  const maxNodes = bounds?.nodes ?? LIMITS.nodes;
  const maxCollection = bounds?.collection ?? LIMITS.collection;
  const source = typeof input === 'string' ? readJson(input, bounds, startDepth) : input;
  let result: Json = null, nodes = 0, bytes = 0;
  let deferredManifest: { readonly present: true; readonly raw: unknown } | undefined;
  const seen = options.seen ?? new WeakSet<object>(), active = new WeakSet<object>();
  type Job =
    | { input: unknown; depth: number; put: (value: Json) => void; role?: 'root' | 'trusted' }
    | { exit: object };
  const jobs: Job[] = [{
    input: source,
    depth: startDepth,
    put: value => { result = value; },
    ...(options.deferTrustedManifest ? { role: 'root' as const } : {}),
  }];
  const account = (count: number) => { bytes += count; if (bytes > maxInputBytes) fail('LIMIT_BYTES'); };
  while (jobs.length) {
    const job = jobs.pop()!;
    if ('exit' in job) { active.delete(job.exit); continue; }
    if (++nodes > maxNodes) fail('LIMIT_NODES');
    if (job.depth > LIMITS.depth) fail('LIMIT_DEPTH');
    const value = job.input;
    if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
      if (typeof value === 'string') validString(value);
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) fail('VALUE_RANGE');
        const normalized = Object.is(value, -0) ? 0 : value;
        account(Buffer.byteLength(JSON.stringify(normalized)));
        job.put(normalized); continue;
      }
      account(Buffer.byteLength(JSON.stringify(value)));
      job.put(value); continue;
    }
    if (typeof value !== 'object') fail('INPUT_UNSUPPORTED');
    if (active.has(value)) fail('INPUT_CYCLE');
    if (seen.has(value)) fail('INPUT_ALIAS');
    seen.add(value); active.add(value);
    const array = Array.isArray(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail('INPUT_UNSUPPORTED');
    let length = 0;
    if (array) {
      length = Object.getOwnPropertyDescriptor(value, 'length')!.value as number;
      if (length > maxCollection) fail('LIMIT_COLLECTION');
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some(key => typeof key === 'symbol')) fail('INPUT_UNSUPPORTED');
    if (ownKeys.length > (array ? length + 1 : LIMITS.properties)) fail(array ? 'INPUT_UNSUPPORTED' : 'LIMIT_COLLECTION');
    const keys = array ? Array.from({ length }, (_, index) => String(index)) : (ownKeys as string[]).sort();
    if (array && ownKeys.length !== length + 1) fail('INPUT_UNSUPPORTED');
    const output: Json[] | { [key: string]: Json } = array ? new Array<Json>(length) : Object.create(null) as { [key: string]: Json };
    job.put(output);
    account(2 + Math.max(0, keys.length - 1));
    jobs.push({ exit: value });
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]!;
      validString(key);
      if (!array) account(Buffer.byteLength(JSON.stringify(key)) + 1);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('INPUT_UNSUPPORTED');
      if (!array && job.role === 'trusted' && key === 'candidateManifest') {
        const rawManifest: unknown = descriptor.value;
        if (typeof rawManifest === 'object' && rawManifest !== null && active.has(rawManifest)) fail('INPUT_CYCLE');
        deferredManifest = { present: true, raw: rawManifest };
        (output as { [key: string]: Json })[key] = null;
        continue;
      }
      const childRole = !array && job.role === 'root' && key === 'trusted' ? 'trusted' as const : undefined;
      jobs.push({
        input: descriptor.value,
        depth: job.depth + 1,
        ...(childRole ? { role: childRole } : {}),
        put: child => {
          if (Array.isArray(output)) output[Number(key)] = child;
          else output[key] = child;
        },
      });
    }
  }
  return deferredManifest ? { value: result, deferredManifest } : { value: result };
}

/** Own a supported JSON tree without running ordinary getters or toJSON. */
export function snapshot(input: unknown, bounds?: SnapshotBounds): Json {
  return snapshotTree(input, { bounds }).value;
}

export interface DeferredManifestSnapshot {
  readonly root: Json;
  readonly resolveManifest: (bounds?: SnapshotBounds) => Json;
}

/**
 * Snapshot outer envelope and all non-manifest subtrees under strict default LIMITS,
 * deferring only `trusted.candidateManifest` until `expectedLock` hashes have been verified.
 */
export function snapshotWithDeferredManifest(input: unknown): DeferredManifestSnapshot {
  if (typeof input === 'string') {
    const extracted = extractDeferredJsonManifest(input);
    if (!extracted) {
      const root = snapshot(input);
      return { root, resolveManifest: () => null };
    }
    const root = snapshot(extracted.restText);
    return {
      root,
      resolveManifest: (bounds?: SnapshotBounds) => snapshotTree(extracted.fieldText, { bounds, startDepth: 3 }).value,
    };
  }
  const seen = new WeakSet<object>();
  const { value: root, deferredManifest } = snapshotTree(input, { seen, deferTrustedManifest: true });
  return {
    root,
    resolveManifest: (bounds?: SnapshotBounds) => {
      if (!deferredManifest) return null;
      return snapshotTree(deferredManifest.raw, { bounds, startDepth: 3, seen }).value;
    },
  };
}
