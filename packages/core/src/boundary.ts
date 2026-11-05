import { LIMITS } from './limits.js';
import { fail } from './diagnostics.js';

export const API_VERSION = 'loopwright.dev/v1alpha1' as const;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function validString(value: string): void {
  if (value.length > LIMITS.string) fail('LIMIT_STRING');
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) fail('INPUT_UNSUPPORTED');
}

// The scanner rejects duplicate decoded keys and bounds work before native parsing.
function readJson(text: string): unknown {
  if (text.length > LIMITS.inputBytes || Buffer.byteLength(text) > LIMITS.inputBytes) fail('LIMIT_BYTES');
  type Frame = { kind: 'object' | 'array'; state: string; keys: Set<string>; count: number };
  const stack: Frame[] = [];
  let offset = 0, nodes = 0, rootDone = false;
  const tokenPattern = /(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;
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
    if (++nodes > LIMITS.nodes) fail('LIMIT_NODES');
    // Depth counts the root as one, including primitive leaves.
    if (stack.length + 1 > LIMITS.depth) fail('LIMIT_DEPTH');
    const char = text[offset];
    if (char === '{' || char === '[') {
      stack.push({ kind: char === '{' ? 'object' : 'array', state: char === '{' ? 'keyOrEnd' : 'valueOrEnd', keys: new Set(), count: 0 });
      offset++; return;
    }
    if (char === '"') { string(); return; }
    tokenPattern.lastIndex = offset;
    const token = tokenPattern.exec(text);
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
    if (frame.kind === 'array' && ++frame.count > LIMITS.collection) fail('LIMIT_COLLECTION');
    frame.state = 'commaOrEnd'; value();
  }
  try { return JSON.parse(text); } catch { fail('JSON_SYNTAX'); }
}

/** Own a supported JSON tree without running ordinary getters or toJSON. */
export function snapshot(input: unknown): Json {
  const source = typeof input === 'string' ? readJson(input) : input;
  let result: Json = null, nodes = 0, bytes = 0;
  const seen = new WeakSet<object>(), active = new WeakSet<object>();
  type Job = { input: unknown; depth: number; put: (value: Json) => void } | { exit: object };
  const jobs: Job[] = [{ input: source, depth: 1, put: value => { result = value; } }];
  const account = (count: number) => { bytes += count; if (bytes > LIMITS.inputBytes) fail('LIMIT_BYTES'); };
  while (jobs.length) {
    const job = jobs.pop()!;
    if ('exit' in job) { active.delete(job.exit); continue; }
    if (++nodes > LIMITS.nodes) fail('LIMIT_NODES');
    if (job.depth > LIMITS.depth) fail('LIMIT_DEPTH');
    const value = job.input;
    if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
      if (typeof value === 'string') validString(value);
      if (typeof value === 'number' && (!Number.isSafeInteger(value) || Object.is(value, -0))) fail('VALUE_RANGE');
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
      if (length > LIMITS.collection) fail('LIMIT_COLLECTION');
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
      jobs.push({ input: descriptor.value, depth: job.depth + 1, put: child => {
        if (Array.isArray(output)) output[Number(key)] = child;
        else output[key] = child;
      } });
    }
  }
  return result;
}
