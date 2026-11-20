import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { snapshot, type Json } from './boundary.js';
import {
  artifactRefSchema, artifactUri, arrayOf, branch, digestSchema, document, enumeration, mediaType, nameSchema,
  nullable, object, optional, record, resolveOverlayOptions, text,
  type ArtifactRef, type Digest, type Infer, type Schema,
} from './contracts.js';
import { attempt, fail, type DiagnosticCode, type Result } from './diagnostics.js';
import { LIMITS, OVERLAY_LIMITS, type OverlayLimitOptions } from './limits.js';

const EMPTY_SHA256_HEX = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

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
export interface ArtifactRefOptions {
  readonly uri?: string | null;
  readonly mediaType?: string | null;
}

export interface ArtifactMetadataInput {
  readonly digest: Digest;
  readonly byteLength: number;
  readonly uri?: string | null | undefined;
  readonly mediaType?: string | null | undefined;
}

const artifactOptionsSchema = record({
  uri: optional(nullable(artifactUri)),
  mediaType: optional(nullable(mediaType)),
});

function parseArtifactMetadataFields(
  validName: string,
  metadataInput: unknown,
  metadataPath: string,
  maxFileBytes: number,
): ArtifactRef {
  if (metadataInput === undefined) fail('INPUT_UNSUPPORTED', metadataPath);
  if (metadataInput === null || typeof metadataInput !== 'object' || Array.isArray(metadataInput)) {
    fail('VALUE_TYPE', metadataPath);
  }
  const prototype: unknown = Object.getPrototypeOf(metadataInput);
  if (prototype !== null && prototype !== Object.prototype) fail('INPUT_UNSUPPORTED', metadataPath);
  const rawKeys = Reflect.ownKeys(metadataInput);
  if (rawKeys.some(key => typeof key === 'symbol')) fail('INPUT_UNSUPPORTED', metadataPath);
  const keys = (rawKeys as string[]).sort();
  const ownValues: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(metadataInput, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('INPUT_UNSUPPORTED', metadataPath);
    ownValues[key] = descriptor.value;
  }
  for (const requiredKey of ['digest', 'byteLength'] as const) {
    if (!Object.hasOwn(ownValues, requiredKey)) fail('FIELD_REQUIRED', `${metadataPath}/${requiredKey}`);
  }
  for (const key of keys) {
    if (key !== 'digest' && key !== 'byteLength' && key !== 'uri' && key !== 'mediaType') {
      fail('FIELD_UNKNOWN', metadataPath);
    }
  }
  if (typeof ownValues.byteLength === 'number' && !Number.isFinite(ownValues.byteLength)) {
    fail('VALUE_RANGE', `${metadataPath}/byteLength`);
  }
  const sanitized: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  sanitized.digest = ownValues.digest;
  sanitized.byteLength = ownValues.byteLength;
  if (Object.hasOwn(ownValues, 'uri') && ownValues.uri !== undefined) sanitized.uri = ownValues.uri;
  if (Object.hasOwn(ownValues, 'mediaType') && ownValues.mediaType !== undefined) sanitized.mediaType = ownValues.mediaType;
  const snapshotted = object(snapshot(sanitized), metadataPath);
  const validDigest = digestSchema(snapshotted.digest!, `${metadataPath}/digest`);
  const rawByteLength = snapshotted.byteLength!;
  if (typeof rawByteLength !== 'number') fail('VALUE_TYPE', `${metadataPath}/byteLength`);
  if (!Number.isSafeInteger(rawByteLength) || Object.is(rawByteLength, -0) || rawByteLength < 0) {
    fail('VALUE_RANGE', `${metadataPath}/byteLength`);
  }
  if (rawByteLength > maxFileBytes) fail('LIMIT_ARTIFACT_BYTES', `${metadataPath}/byteLength`);
  if ((rawByteLength === 0) !== (validDigest.hex === EMPTY_SHA256_HEX)) {
    fail('ARTIFACT_DIGEST_MISMATCH', `${metadataPath}/digest`);
  }
  const ref: Record<string, unknown> = {
    name: validName,
    digest: { algorithm: validDigest.algorithm, hex: validDigest.hex },
    byteLength: rawByteLength,
  };
  if (Object.hasOwn(snapshotted, 'uri')) {
    const parsedUri = nullable(artifactUri)(snapshotted.uri!, `${metadataPath}/uri`);
    if (parsedUri !== null) ref.uri = parsedUri;
  }
  if (Object.hasOwn(snapshotted, 'mediaType')) {
    const parsedMediaType = nullable(mediaType)(snapshotted.mediaType!, `${metadataPath}/mediaType`);
    if (parsedMediaType !== null) ref.mediaType = parsedMediaType;
  }
  return ref as ArtifactRef;
}

export function digestArtifact(name: unknown, bytes: Uint8Array, options?: ArtifactRefOptions): Result<ArtifactRef> {
  return attempt(() => {
    const validName = nameSchema(object(snapshot({ name }), '').name!, '/name');
    const owned = byteView(bytes, '/bytes').slice();
    const ref: Record<string, unknown> = { name: validName, digest: byteDigest(owned), byteLength: owned.byteLength };
    if (options !== undefined) {
      const parsedOptions = artifactOptionsSchema(object(snapshot({ options }), '').options!, '');
      if (Object.hasOwn(parsedOptions, 'uri')) ref.uri = parsedOptions.uri;
      if (Object.hasOwn(parsedOptions, 'mediaType')) ref.mediaType = parsedOptions.mediaType;
    }
    return ref as ArtifactRef;
  });
}

export function digestArtifactFromMetadata(name: unknown, metadata: ArtifactMetadataInput): Result<ArtifactRef> {
  return attempt(() => {
    const validName = nameSchema(object(snapshot({ name }), '').name!, '/name');
    return parseArtifactMetadataFields(validName, metadata, '/metadata', Number.MAX_SAFE_INTEGER);
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
function overlaySpecShape(maxOverlayEntries: number) {
  return record({
    baseTree: baseTreeSchema,
    entries: arrayOf(artifactRefSchema, 0, maxOverlayEntries),
    deleted: arrayOf(nameSchema, 0, maxOverlayEntries),
  });
}
function createManifestShape(maxOverlayEntries: number) {
  const specShape: Schema<
    | { readonly entries: readonly ArtifactRef[]; readonly baseTree?: undefined; readonly deleted?: undefined }
    | { readonly baseTree: BaseTreeAnchor; readonly entries: readonly ArtifactRef[]; readonly deleted: readonly string[] }
  > = branch(
    input => Object.hasOwn(input, 'baseTree') || Object.hasOwn(input, 'deleted'),
    overlaySpecShape(maxOverlayEntries),
    classicSpecShape,
  );
  return document('ArtifactManifest', specShape);
}
const defaultManifestShape = createManifestShape(LIMITS.overlayEntries);
export type ArtifactManifest = Infer<typeof defaultManifestShape>;

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

export function manifestSchema(value: Json, path = '', maxOverlayEntries: number = LIMITS.overlayEntries): ArtifactManifest {
  const shape = maxOverlayEntries === LIMITS.overlayEntries ? defaultManifestShape : createManifestShape(maxOverlayEntries);
  const manifest = shape(value, path);
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
export interface VerifiedArtifactDescriptor {
  readonly name: string;
  readonly byteLength: number;
  readonly digest: Digest;
}
export type ResolvedArtifactInput = ResolvedArtifact | VerifiedArtifactDescriptor;
export interface ArtifactBytes { readonly byteLength: number; readonly digest: Digest }

const NON_OVERLAY_ARTIFACTS = LIMITS.resolvedArtifacts - LIMITS.overlayEntries;

type PendingInventoryEntry =
  | { readonly kind: 'raw'; readonly name: string; readonly view: Uint8Array }
  | { readonly kind: 'verified'; readonly name: string; readonly bytes: ArtifactBytes };

/** Validate inventory shape and all byte limits before copying or hashing. */
export function resolveInventory(
  input: readonly ResolvedArtifactInput[],
  options?: OverlayLimitOptions,
): ReadonlyMap<string, ArtifactBytes> {
  const overlay = resolveOverlayOptions(options);
  const maxArtifacts = overlay ? Math.max(LIMITS.resolvedArtifacts, overlay.maxFiles + NON_OVERLAY_ARTIFACTS) : LIMITS.resolvedArtifacts;
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) fail('INPUT_UNSUPPORTED', '/artifacts');
  const count = Object.getOwnPropertyDescriptor(input, 'length')!.value as number;
  if (count > maxArtifacts) fail('LIMIT_COLLECTION', '/artifacts');
  if (Reflect.ownKeys(input).length !== count + 1) fail('INPUT_UNSUPPORTED', '/artifacts');
  const names = new Set<string>(), entries: PendingInventoryEntry[] = [];
  let rawTotal = 0;
  let verifiedTotal = 0;
  for (let index = 0; index < count; index++) {
    const path = `/artifacts/${index}`;
    const itemDescriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!itemDescriptor || !('value' in itemDescriptor) || !itemDescriptor.enumerable) fail('INPUT_UNSUPPORTED', path);
    const item: unknown = itemDescriptor.value;
    if (item === null || typeof item !== 'object') fail('INPUT_UNSUPPORTED', path);
    const prototype: unknown = Object.getPrototypeOf(item);
    if (prototype !== null && prototype !== Object.prototype) fail('INPUT_UNSUPPORTED', path);
    const keys = Reflect.ownKeys(item);
    const isRaw = keys.length === 2 && keys.includes('name') && keys.includes('bytes');
    const isVerified = keys.length === 3 && keys.includes('name') && keys.includes('byteLength') && keys.includes('digest');
    if (!isRaw && !isVerified) fail('INPUT_UNSUPPORTED', path);
    const nameDescriptor = Object.getOwnPropertyDescriptor(item, 'name')!;
    if (!('value' in nameDescriptor) || !nameDescriptor.enumerable) fail('INPUT_UNSUPPORTED', path);
    if (isRaw) {
      const bytesDescriptor = Object.getOwnPropertyDescriptor(item, 'bytes')!;
      if (!('value' in bytesDescriptor) || !bytesDescriptor.enumerable) fail('INPUT_UNSUPPORTED', path);
      const name = nameSchema(object(snapshot({ name: nameDescriptor.value }), '').name!, `${path}/name`);
      if (names.has(name.toLowerCase())) fail('ARTIFACT_DUPLICATE', `${path}/name`);
      names.add(name.toLowerCase());
      const view = byteView(bytesDescriptor.value, `${path}/bytes`);
      if (view.byteLength > LIMITS.resolvedBytes - rawTotal) fail('LIMIT_RESOLVED_BYTES', path);
      rawTotal += view.byteLength;
      entries.push({ kind: 'raw', name, view });
    } else {
      const byteLengthDescriptor = Object.getOwnPropertyDescriptor(item, 'byteLength')!;
      const digestDescriptor = Object.getOwnPropertyDescriptor(item, 'digest')!;
      if (
        !('value' in byteLengthDescriptor) || !byteLengthDescriptor.enumerable
        || !('value' in digestDescriptor) || !digestDescriptor.enumerable
      ) {
        fail('INPUT_UNSUPPORTED', path);
      }
      const name = nameSchema(object(snapshot({ name: nameDescriptor.value }), '').name!, `${path}/name`);
      if (names.has(name.toLowerCase())) fail('ARTIFACT_DUPLICATE', `${path}/name`);
      names.add(name.toLowerCase());
      const metadataObj: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      metadataObj.digest = digestDescriptor.value;
      metadataObj.byteLength = byteLengthDescriptor.value;
      const verified = parseArtifactMetadataFields(name, metadataObj, path, OVERLAY_LIMITS.maxMaxBytes);
      const verifiedBudget = overlay?.maxBytes ?? OVERLAY_LIMITS.maxMaxBytes;
      if (verified.byteLength > verifiedBudget - verifiedTotal) fail('LIMIT_RESOLVED_BYTES', path);
      verifiedTotal += verified.byteLength;
      entries.push({
        kind: 'verified',
        name: verified.name,
        bytes: { byteLength: verified.byteLength, digest: verified.digest },
      });
    }
  }
  return new Map(entries.map(entry => {
    if (entry.kind === 'verified') return [entry.name, entry.bytes];
    const owned = entry.view.slice();
    return [entry.name, { byteLength: owned.byteLength, digest: byteDigest(owned) }];
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
