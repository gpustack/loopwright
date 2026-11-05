import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { snapshot, type Json } from './boundary.js';
import { artifactRefSchema, arrayOf, document, nameSchema, object, record, type ArtifactRef, type Digest, type Infer } from './contracts.js';
import { attempt, fail, type DiagnosticCode, type Result } from './diagnostics.js';
import { LIMITS } from './limits.js';

export function byteDigest(bytes: Uint8Array): Digest {
  return { algorithm: 'sha256', hex: createHash('sha256').update(bytes).digest('hex') };
}
const typedArrayPrototype: object = Object.getPrototypeOf(Uint8Array.prototype) as object;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const lengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const offsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;

function byteView(input: unknown, path: string): Uint8Array {
  if (!ArrayBuffer.isView(input)) fail('INPUT_UNSUPPORTED', path);
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype) fail('INPUT_UNSUPPORTED', path);
  const buffer = bufferGetter.call(input) as ArrayBufferLike;
  if (types.isSharedArrayBuffer(buffer)) fail('INPUT_UNSUPPORTED', path);
  const length = lengthGetter.call(input) as number;
  if (length > LIMITS.artifactBytes) fail('LIMIT_ARTIFACT_BYTES', path);
  return new Uint8Array(buffer, offsetGetter.call(input) as number, length);
}
export function digestArtifact(name: unknown, bytes: Uint8Array): Result<ArtifactRef> {
  return attempt(() => {
    const validName = nameSchema(object(snapshot({ name }), '').name!, '/name');
    const owned = byteView(bytes, '/bytes').slice();
    return { name: validName, digest: byteDigest(owned), byteLength: owned.byteLength };
  });
}
const manifestShape = document('ArtifactManifest', record({ entries: arrayOf(artifactRefSchema, 0, LIMITS.manifest) }));
export type ArtifactManifest = Infer<typeof manifestShape>;
export function manifestSchema(value: Json, path = ''): ArtifactManifest {
  const manifest = manifestShape(value, path);
  const names = new Set<string>();
  manifest.spec.entries.forEach((entry, index) => {
    const name = entry.name.toLowerCase();
    if (names.has(name)) fail('MANIFEST_AMBIGUOUS', `${path}/spec/entries/${index}/name`);
    names.add(name);
  });
  manifest.spec.entries.forEach((entry, index) => {
    const segments = entry.name.toLowerCase().split('/');
    for (let count = 1; count < segments.length; count++) {
      if (names.has(segments.slice(0, count).join('/'))) fail('MANIFEST_AMBIGUOUS', `${path}/spec/entries/${index}/name`);
    }
  });
  return manifest;
}
export interface ResolvedArtifact { readonly name: string; readonly bytes: Uint8Array }
export interface ArtifactBytes { readonly byteLength: number; readonly digest: Digest }

/** Validate inventory shape and all byte limits before copying or hashing. */
export function resolveInventory(input: readonly ResolvedArtifact[]): ReadonlyMap<string, ArtifactBytes> {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) fail('INPUT_UNSUPPORTED', '/artifacts');
  const count = Object.getOwnPropertyDescriptor(input, 'length')!.value as number;
  if (count > LIMITS.resolvedArtifacts) fail('LIMIT_COLLECTION', '/artifacts');
  if (Reflect.ownKeys(input).length !== count + 1) fail('INPUT_UNSUPPORTED', '/artifacts');
  const names = new Set<string>(), views: { name: string; view: Uint8Array }[] = [];
  let total = 0;
  for (let index = 0; index < count; index++) {
    const path = `/artifacts/${index}`;
    const itemDescriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!itemDescriptor || !('value' in itemDescriptor) || !itemDescriptor.enumerable) fail('INPUT_UNSUPPORTED', path);
    const item: unknown = itemDescriptor.value;
    if (item === null || typeof item !== 'object') fail('INPUT_UNSUPPORTED', path);
    const prototype: unknown = Object.getPrototypeOf(item);
    if (prototype !== null && prototype !== Object.prototype) fail('INPUT_UNSUPPORTED', path);
    const keys = Reflect.ownKeys(item);
    if (keys.length !== 2 || !keys.includes('name') || !keys.includes('bytes')) fail('INPUT_UNSUPPORTED', path);
    const nameDescriptor = Object.getOwnPropertyDescriptor(item, 'name')!;
    const bytesDescriptor = Object.getOwnPropertyDescriptor(item, 'bytes')!;
    if (!('value' in nameDescriptor) || !nameDescriptor.enumerable || !('value' in bytesDescriptor) || !bytesDescriptor.enumerable) fail('INPUT_UNSUPPORTED', path);
    const name = nameSchema(object(snapshot({ name: nameDescriptor.value }), '').name!, `${path}/name`);
    if (names.has(name.toLowerCase())) fail('ARTIFACT_DUPLICATE', `${path}/name`);
    names.add(name.toLowerCase());
    const view = byteView(bytesDescriptor.value, `${path}/bytes`);
    total += view.byteLength;
    if (total > LIMITS.resolvedBytes) fail('LIMIT_RESOLVED_BYTES', path);
    views.push({ name, view });
  }
  return new Map(views.map(({ name, view }) => {
    const owned = view.slice();
    return [name, { byteLength: owned.byteLength, digest: byteDigest(owned) }];
  }));
}
export interface ArtifactIssue {
  readonly code: Extract<DiagnosticCode, 'ARTIFACT_MISSING' | 'ARTIFACT_LENGTH_MISMATCH' | 'ARTIFACT_DIGEST_MISMATCH'>;
  readonly path: string;
}
export function artifactIssue(refs: readonly ArtifactRef[], inventory: ReadonlyMap<string, ArtifactBytes>, path: string): ArtifactIssue | null {
  for (let index = 0; index < refs.length; index++) {
    const ref = refs[index]!, bytes = inventory.get(ref.name), location = `${path}/${index}`;
    if (!bytes) return { code: 'ARTIFACT_MISSING', path: location };
    if (bytes.byteLength !== ref.byteLength) return { code: 'ARTIFACT_LENGTH_MISMATCH', path: location };
    if (bytes.digest.hex !== ref.digest.hex) return { code: 'ARTIFACT_DIGEST_MISMATCH', path: location };
  }
  return null;
}
