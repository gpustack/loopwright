import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { snapshot, type Json } from './boundary.js';
import {
  artifactRefSchema, arrayOf, branch, document, enumeration, nameSchema,
  object, record, text, type ArtifactRef, type Digest, type Infer, type Schema,
} from './contracts.js';
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
export interface BaseTreeAnchor {
  readonly objectFormat: 'sha1' | 'sha256';
  readonly commitOid: string;
  readonly treeOid: string;
}

const baseTreeShape = record({
  objectFormat: enumeration('sha1', 'sha256'),
  commitOid: text(40, 64),
  treeOid: text(40, 64),
});

function baseTreeSchema(value: Json, path: string): BaseTreeAnchor {
  const anchor = baseTreeShape(value, path);
  const pattern = anchor.objectFormat === 'sha1' ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/;
  if (!pattern.test(anchor.commitOid)) fail('VALUE_RANGE', `${path}/commitOid`);
  if (!pattern.test(anchor.treeOid)) fail('VALUE_RANGE', `${path}/treeOid`);
  return anchor;
}

const classicSpecShape = record({ entries: arrayOf(artifactRefSchema, 0, LIMITS.manifest) });
const overlaySpecShape = record({
  baseTree: baseTreeSchema,
  entries: arrayOf(artifactRefSchema, 0, LIMITS.overlayEntries),
  deleted: arrayOf(nameSchema, 0, LIMITS.overlayEntries),
});
const manifestSpecShape: Schema<
  | { readonly entries: readonly ArtifactRef[]; readonly baseTree?: undefined; readonly deleted?: undefined }
  | { readonly baseTree: BaseTreeAnchor; readonly entries: readonly ArtifactRef[]; readonly deleted: readonly string[] }
> = branch(
  input => Object.hasOwn(input, 'baseTree') || Object.hasOwn(input, 'deleted'),
  overlaySpecShape,
  classicSpecShape,
);
const manifestShape = document('ArtifactManifest', manifestSpecShape);
export type ArtifactManifest = Infer<typeof manifestShape>;

function validateGitPath(name: string, path: string): void {
  for (const segment of name.split('/')) {
    if (segment.toLowerCase() === '.git' || Buffer.byteLength(segment, 'utf8') > 255) {
      fail('PATH_INVALID', path);
    }
  }
}

function requireAscending<T>(
  items: readonly T[],
  nameOf: (item: T) => string,
  elementPath: (index: number) => string,
): void {
  for (let index = 1; index < items.length; index++) {
    if (nameOf(items[index - 1]!) >= nameOf(items[index]!)) {
      fail('MANIFEST_AMBIGUOUS', elementPath(index));
    }
  }
}

export function manifestSchema(value: Json, path = ''): ArtifactManifest {
  const manifest = manifestShape(value, path);
  const spec = manifest.spec;
  if (spec.baseTree) {
    spec.entries.forEach((entry, index) => {
      validateGitPath(entry.name, `${path}/spec/entries/${index}/name`);
    });
    spec.deleted.forEach((name, index) => {
      validateGitPath(name, `${path}/spec/deleted/${index}`);
    });
    requireAscending(spec.entries, entry => entry.name, index => `${path}/spec/entries/${index}/name`);
    requireAscending(spec.deleted, name => name, index => `${path}/spec/deleted/${index}`);
  }
  // nameSchema (relativeName) restricts segments to ASCII [A-Za-z0-9._-], so normalize('NFC') is defense-in-depth for canonical folding.
  const normalizeName = (rawName: string) => rawName.normalize('NFC').toLowerCase();
  const names = new Set<string>();
  const register = (rawName: string, elementPath: string) => {
    const normalized = normalizeName(rawName);
    if (names.has(normalized)) fail('MANIFEST_AMBIGUOUS', elementPath);
    names.add(normalized);
  };
  const checkPrefixes = (rawName: string, elementPath: string) => {
    const segments = normalizeName(rawName).split('/');
    for (let count = 1; count < segments.length; count++) {
      if (names.has(segments.slice(0, count).join('/'))) fail('MANIFEST_AMBIGUOUS', elementPath);
    }
  };
  spec.entries.forEach((entry, index) => register(entry.name, `${path}/spec/entries/${index}/name`));
  if (spec.baseTree) spec.deleted.forEach((name, index) => register(name, `${path}/spec/deleted/${index}`));
  spec.entries.forEach((entry, index) => checkPrefixes(entry.name, `${path}/spec/entries/${index}/name`));
  if (spec.baseTree) spec.deleted.forEach((name, index) => checkPrefixes(name, `${path}/spec/deleted/${index}`));
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
