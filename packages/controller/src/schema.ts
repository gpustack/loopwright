import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { validateDocument, type ArtifactRef, type Digest } from '@loopwright/core';
import { refuse } from './errors.js';
export type Scalar = string | number | boolean | null;
export type Json = Scalar | readonly Json[] | { readonly [key: string]: Json };
export function record(value: unknown, keys: readonly string[], path = ''): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) refuse('CONFIG_SCHEMA', path);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length || Object.keys(descriptors).some(key => !keys.includes(key) || !('value' in descriptors[key]!))) refuse('CONFIG_SCHEMA', path);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) { const item = descriptors[key]; if (!item || !('value' in item)) refuse('CONFIG_SCHEMA', path); output[key] = item.value; }
  return output;
}
export function text(value: unknown, path = '', max = 16384): string {
  if (typeof value !== 'string' || value.length > max) refuse('CONFIG_SCHEMA', path); return value;
}
export function id(value: unknown, path = ''): string {
  const name = text(value, path, 64); if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(name)) refuse('CONFIG_SCHEMA', path); return name;
}
export function integer(value: unknown, min: number, max: number, path = ''): number {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || (value as number) < min || (value as number) > max) refuse('CONFIG_SCHEMA', path); return value as number;
}
export function list(value: unknown, path = '', max = 128): readonly unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || value.length > max) refuse('CONFIG_SCHEMA', path); return value;
}
export function digestValue(value: unknown, path = ''): Digest {
  const item = record(value, ['algorithm', 'hex'], path);
  if (item.algorithm !== 'sha256' || typeof item.hex !== 'string' || !/^[0-9a-f]{64}$/.test(item.hex)) refuse('CONFIG_SCHEMA', path); return { algorithm: 'sha256', hex: item.hex };
}
export function hash(bytes: Uint8Array | string): Digest { return { algorithm: 'sha256', hex: createHash('sha256').update(bytes).digest('hex') }; }
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
}
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value;
}
export function same(left: unknown, right: unknown): boolean { return canonical(left) === canonical(right); }
export function checkedRef(value: unknown): ArtifactRef {
  const manifest = validateDocument({ apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'reference' }, spec: { entries: [value] } }, 'ArtifactManifest');
  if (!manifest.ok) refuse('ARTIFACT_INVALID', '', 'recovery'); return manifest.value.spec.entries[0]!;
}
