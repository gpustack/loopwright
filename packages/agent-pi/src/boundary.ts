import { types } from 'node:util';
import { createHash } from 'node:crypto';
import { refuse } from './errors.js';
import type { Digest } from '@loopwright/core';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export function snapshot(input: unknown): Json {
  let nodes = 0, bytes = 0; const seen = new Set<object>();
  const copy = (value: unknown, depth: number): Json => {
    if (++nodes > 65536 || depth > 64) refuse('INPUT_INVALID');
    if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') {
      if (typeof value === 'number' && (!Number.isSafeInteger(value) || Object.is(value, -0))) refuse('INPUT_INVALID');
      if (typeof value === 'string' && (value.length > 16384 || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))) refuse('INPUT_INVALID');
      bytes += Buffer.byteLength(JSON.stringify(value)); if (bytes > 1048576) refuse('INPUT_INVALID'); return value;
    }
    if (typeof value !== 'object' || types.isProxy(value) || seen.has(value)) refuse('INPUT_INVALID'); seen.add(value);
    const isArray = Array.isArray(value), prototype: unknown = Object.getPrototypeOf(value);
    if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) refuse('INPUT_INVALID');
    const keys = Reflect.ownKeys(value); if (keys.some(key => typeof key !== 'string')) refuse('INPUT_INVALID');
    const length = isArray ? Object.getOwnPropertyDescriptor(value, 'length')!.value as number : keys.length;
    if (length > (isArray ? 1024 : 128) || isArray && keys.length !== length + 1) refuse('INPUT_INVALID');
    const output: Json[] | Record<string, Json> = isArray ? [] : Object.create(null) as Record<string, Json>;
    bytes += 2 + length; if (bytes > 1048576) refuse('INPUT_INVALID');
    for (const key of isArray ? Array.from({ length }, (_, index) => String(index)) : keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) refuse('INPUT_INVALID');
      if (!isArray) { bytes += Buffer.byteLength(JSON.stringify(key)) + 1; if (bytes > 1048576) refuse('INPUT_INVALID'); }
      const child = copy(descriptor.value, depth + 1);
      if (Array.isArray(output)) output.push(child); else output[key] = child;
    }
    return output;
  };
  return copy(input, 1);
}
export function object(input: unknown, fields: readonly string[], path = ''): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input)) refuse('INPUT_INVALID', path);
  const proto: unknown = Object.getPrototypeOf(input); if (proto !== Object.prototype && proto !== null) refuse('INPUT_INVALID', path);
  const keys = Reflect.ownKeys(input); if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key))) refuse('INPUT_INVALID', path);
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of fields) { const desc = Object.getOwnPropertyDescriptor(input, key); if (!desc || !desc.enumerable || !('value' in desc)) refuse('INPUT_INVALID', path + '/' + key); out[key] = desc.value; }
  return out;
}
export function list(input: unknown, max: number, path = ''): unknown[] {
  if (!Array.isArray(input) || types.isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype) refuse('INPUT_INVALID', path);
  const length = Object.getOwnPropertyDescriptor(input, 'length')!.value as number;
  if (length > max || Reflect.ownKeys(input).length !== length + 1) refuse('INPUT_INVALID', path);
  return Array.from({ length }, (_, index) => { const descriptor = Object.getOwnPropertyDescriptor(input, String(index)); if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) refuse('INPUT_INVALID', path); return descriptor.value as unknown; });
}
export function text(input: unknown, path = '', max = 16384): string {
  if (typeof input !== 'string' || !input.length || Buffer.byteLength(input) > max) refuse('INPUT_INVALID', path); return input;
}
export function id(input: unknown, path = ''): string { const value = text(input, path, 64); if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value)) refuse('INPUT_INVALID', path); return value; }
export function integer(input: unknown, min: number, max: number, path = ''): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || Object.is(input, -0) || input < min || input > max) refuse('INPUT_INVALID', path); return input;
}
export function digest(bytes: Uint8Array): Digest { return { algorithm: 'sha256', hex: createHash('sha256').update(bytes).digest('hex') }; }
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const record = value as Record<string, unknown>; return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
}
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value;
}
