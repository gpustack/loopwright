import { createHash } from 'node:crypto';
import { types } from 'node:util';
import {
  LIMITS,
  admitTask,
  identifyManifest,
  isWritablePath,
  resolveOverlayLimits,
  validateDocument,
  validateRelativePath,
  type ArtifactManifest,
  type ArtifactRef,
  type BaseTreeAnchor,
  type MetricsMap,
  type OverlayLimitOptions,
  type OverlayLimits,
  type OverlayLimitsInput,
  type StructuredFinding,
  type Subject,
} from '@loopwright/core';
import { canonical, checkedRef, digestValue, freeze, hash, id, integer, isRecord, list, record, same, text, type Json } from './schema.js';
import { parsePrivateJson } from './parser.js';
import { gitObjectOid, parseGitTreeEntries } from './git-objects.js';
import { ControllerFailure, refuse } from './errors.js';

export const HEADER_BYTES = 16384;
export const PACKET_BYTES = 1048576;
export const JSON_FILE_BYTES = 1032184;
export const ALLOCATION_BYTES = 8388608;
export const OVERLAY_INVENTORY_MAGIC = 0x4c574f56;
const MAX_ABSOLUTE_PACKET_BYTES = 41_943_040;
const URI_FLAG = 0x4000;
const MEDIA_TYPE_FLAG = 0x8000;
const NAME_LEN_MASK = 0x3fff;
export const RFC6901_POINTER_PATTERN = /^(?:\/(?:[^~/]|~[01])*)+$/;
const LONE_SURROGATE_PATTERN = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

export type ByteHandler =
  | 'scope.v1'
  | 'no-change.v1'
  | 'json-artifact.v1'
  | 'json-keys-guard.v1'
  | 'line-section-guard.v1';

export type VerifierReason =
  | 'outside_scope'
  | 'candidate_changed'
  | 'missing_file'
  | 'invalid_json'
  | 'property_missing'
  | 'property_mismatch'
  | 'disallowed_json_pointer'
  | 'invalid_utf8'
  | 'missing_markers'
  | 'unbalanced_markers'
  | 'outside_section_modified';

export type VerifierMethod =
  | 'verify_scope'
  | 'verify_no_change'
  | 'verify_json'
  | 'verify_json_keys_guard'
  | 'verify_line_section_guard';

export interface ManifestDescriptor {
  readonly metadataId: string;
  readonly ref: ArtifactRef;
  readonly entryCount: number;
}

export interface VerifierHeader {
  readonly version: 1;
  readonly jobId: string;
  readonly handler: ByteHandler;
  readonly handlerVersion: 1;
  readonly handlerDigest: import('@loopwright/core').Digest;
  readonly checkId: string;
  readonly producerNonce: string;
  readonly operationId: string;
  readonly dispatchId: string;
  readonly generation: number;
  readonly subject: Subject;
  readonly source: ManifestDescriptor;
  readonly candidate: ManifestDescriptor;
  readonly parameters: Readonly<Record<string, Json>>;
  readonly payloadKind: 'inventories' | 'json' | 'guard';
  readonly overlay?: OverlayLimits;
}

export interface VerifierReply {
  readonly version: 1;
  readonly jobId: string;
  readonly handler: ByteHandler;
  readonly handlerDigest: import('@loopwright/core').Digest;
  readonly checkId: string;
  readonly producerNonce: string;
  readonly operationId: string;
  readonly dispatchId: string;
  readonly generation: number;
  readonly subject: Subject;
  readonly packetDigest: import('@loopwright/core').Digest;
  readonly status: 'passed' | 'failed';
  readonly reason: null | VerifierReason;
  readonly method: VerifierMethod;
  readonly allocationBytes: number;
  readonly detail?: string | null;
  readonly metrics?: MetricsMap;
  readonly findings?: readonly StructuredFinding[];
}

export interface OverlayProtocolBounds {
  readonly maxOverlayEntries: number;
  readonly maxClassicEntries: number;
  readonly maxManifestEntries: number;
  readonly maxTotalBytes: number;
  readonly manifestMaxBytes: number;
  readonly inventoryMaxBytes: number;
  readonly allocationMaxBytes: number;
  readonly options: OverlayLimitOptions | undefined;
}

export function overlayProtocolBounds(overlay?: OverlayLimitsInput): OverlayProtocolBounds {
  if (overlay === undefined) {
    return {
      maxOverlayEntries: 128,
      maxClassicEntries: 256,
      maxManifestEntries: 256,
      maxTotalBytes: 4_194_304,
      manifestMaxBytes: 32_768,
      inventoryMaxBytes: 32_772,
      allocationMaxBytes: ALLOCATION_BYTES,
      options: undefined,
    };
  }
  const resolved = resolveOverlayLimits(overlay);
  if (!resolved.ok) refuse('ARTIFACT_INVALID', '', 'verification');
  const { maxFiles, maxBytes } = resolved.value;
  const extraFiles = Math.max(0, maxFiles - 128);
  const manifestMaxBytes = maxFiles <= 128 ? 32_768 : Math.min(20_971_520, 32_768 + extraFiles * 4_608);
  const inventoryMaxBytes = maxFiles <= 128 ? 32_772 : Math.min(20_971_520, 32_772 + extraFiles * 4_608);
  const maxWidePacketEstimate = Math.min(
    MAX_ABSOLUTE_PACKET_BYTES,
    4 + HEADER_BYTES + 2 * inventoryMaxBytes + 2 * (4 + JSON_FILE_BYTES) + 262_212,
  );
  const allocationMaxBytes =
    maxFiles <= 128
      ? ALLOCATION_BYTES
      : Math.max(ALLOCATION_BYTES, Math.max(maxWidePacketEstimate, maxFiles >= 4_096 ? MAX_ABSOLUTE_PACKET_BYTES : 0) + 2 * manifestMaxBytes + 4_194_304);
  return {
    maxOverlayEntries: maxFiles,
    maxClassicEntries: 256,
    maxManifestEntries: Math.max(256, maxFiles),
    maxTotalBytes: maxBytes,
    manifestMaxBytes,
    inventoryMaxBytes,
    allocationMaxBytes,
    options: { overlay: { maxFiles, maxBytes } },
  };
}

export function maxPacketBytes(header: Pick<VerifierHeader, 'payloadKind' | 'overlay'>): number {
  const bounds = overlayProtocolBounds(header.overlay);
  const inventoriesBytes = 4 + HEADER_BYTES + 2 * bounds.inventoryMaxBytes;
  if (header.payloadKind === 'inventories') return Math.min(MAX_ABSOLUTE_PACKET_BYTES, inventoriesBytes);
  if (header.payloadKind === 'json') {
    return Math.min(MAX_ABSOLUTE_PACKET_BYTES, inventoriesBytes + 4 + JSON_FILE_BYTES + 262_212);
  }
  return Math.min(MAX_ABSOLUTE_PACKET_BYTES, inventoriesBytes + 2 * (4 + JSON_FILE_BYTES) + 262_212);
}

export function packetAllocationLimit(bytes: Uint8Array): number {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 4 + HEADER_BYTES) return ALLOCATION_BYTES;
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (!len || len > HEADER_BYTES) return ALLOCATION_BYTES;
  try {
    const header = checkedHeader(parsePrivateJson(bytes.subarray(4, 4 + len), HEADER_BYTES, 256));
    return overlayProtocolBounds(header.overlay).allocationMaxBytes;
  } catch {
    return ALLOCATION_BYTES;
  }
}

export class AllocationQuota {
  used = 0;
  constructor(readonly limit: number = ALLOCATION_BYTES) {}
  charge(length: number): void {
    integer(length, 0, this.limit);
    this.used += length;
    if (this.used > this.limit) refuse('OUTPUT_LIMIT', '', 'verification');
  }
  allocate(length: number): Uint8Array<ArrayBuffer> {
    this.charge(length);
    return new Uint8Array(length);
  }
}

export function ownedBytes(value: Uint8Array, maximum: number): Uint8Array<ArrayBuffer> {
  if (
    !ArrayBuffer.isView(value) ||
    types.isProxy(value) ||
    ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(value)) ||
    types.isSharedArrayBuffer(value.buffer) ||
    value.byteLength > maximum
  ) {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
  return new Uint8Array(value);
}

export function fileHash(bytes: Uint8Array) {
  const digest = createHash('sha256');
  for (let offset = 0; offset < bytes.byteLength; offset += 65536) digest.update(bytes.subarray(offset, offset + 65536));
  return { algorithm: 'sha256' as const, hex: digest.digest('hex') };
}

export function descriptor(manifest: ArtifactManifest, ref: ArtifactRef, overlay?: OverlayLimitsInput): ManifestDescriptor {
  const bounds = overlayProtocolBounds(overlay);
  const identified = identifyManifest(manifest, bounds.options);
  const encoded = canonical(manifest);
  if (
    !identified.ok ||
    Buffer.byteLength(encoded) > bounds.manifestMaxBytes ||
    ref.byteLength !== Buffer.byteLength(encoded) ||
    !same(ref.digest, hash(encoded))
  ) {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
  return { metadataId: manifest.metadata.id, ref: checkedRef(ref), entryCount: manifest.spec.entries.length };
}

function document(raw: unknown, expected: ManifestDescriptor, quota: AllocationQuota, bounds: OverlayProtocolBounds): ArtifactManifest {
  const identified = identifyManifest(raw, bounds.options);
  if (!identified.ok) refuse('ARTIFACT_INVALID', '', 'verification');
  const manifest = identified.value.manifest;
  const encoded = canonical(manifest);
  const length = Buffer.byteLength(encoded);
  quota.charge(length);
  if (
    length > bounds.manifestMaxBytes ||
    manifest.metadata.id !== expected.metadataId ||
    manifest.spec.entries.length !== expected.entryCount ||
    length !== expected.ref.byteLength ||
    !same(hash(encoded), expected.ref.digest)
  ) {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
  return manifest;
}

function writeHexBytes(target: Uint8Array, offset: number, hex: string, byteLength: number): number {
  if (hex.length !== byteLength * 2 || !/^[0-9a-f]+$/.test(hex)) refuse('ARTIFACT_INVALID', '', 'verification');
  for (let index = 0; index < byteLength; index++) target[offset + index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return offset + byteLength;
}

function entryWireBytes(entry: ArtifactRef): number {
  const hasUri = Object.hasOwn(entry, 'uri') && entry.uri !== undefined;
  const hasMedia = Object.hasOwn(entry, 'mediaType') && entry.mediaType !== undefined;
  let size = 42 + Buffer.byteLength(entry.name);
  if (hasUri) size += 2 + (entry.uri === null ? 0 : Buffer.byteLength(entry.uri));
  if (hasMedia) size += 2 + (entry.mediaType === null ? 0 : Buffer.byteLength(entry.mediaType));
  return size;
}

function encodeEntries(bytes: Uint8Array, view: DataView, start: number, entries: readonly ArtifactRef[]): number {
  let offset = start;
  for (const entry of entries) {
    const length = Buffer.byteLength(entry.name);
    if (!length || length > 4096) refuse('OUTPUT_LIMIT', '', 'verification');
    const hasUri = Object.hasOwn(entry, 'uri') && entry.uri !== undefined;
    const hasMedia = Object.hasOwn(entry, 'mediaType') && entry.mediaType !== undefined;
    const headerWord = length | (hasUri ? URI_FLAG : 0) | (hasMedia ? MEDIA_TYPE_FLAG : 0);
    view.setUint16(offset, headerWord);
    offset += 2;
    Buffer.from(bytes.buffer).write(entry.name, offset, length, 'utf8');
    offset += length;
    view.setBigUint64(offset, BigInt(entry.byteLength));
    offset += 8;
    offset = writeHexBytes(bytes, offset, entry.digest.hex, 32);
    if (hasUri) {
      if (entry.uri === null) {
        view.setInt16(offset, -1);
        offset += 2;
      } else {
        const uriLen = Buffer.byteLength(entry.uri);
        if (uriLen > LIMITS.artifactUri) refuse('OUTPUT_LIMIT', '', 'verification');
        view.setInt16(offset, uriLen);
        offset += 2;
        Buffer.from(bytes.buffer).write(entry.uri, offset, uriLen, 'utf8');
        offset += uriLen;
      }
    }
    if (hasMedia) {
      if (entry.mediaType === null) {
        view.setInt16(offset, -1);
        offset += 2;
      } else {
        const mediaLen = Buffer.byteLength(entry.mediaType);
        if (mediaLen > LIMITS.mediaType) refuse('OUTPUT_LIMIT', '', 'verification');
        view.setInt16(offset, mediaLen);
        offset += 2;
        Buffer.from(bytes.buffer).write(entry.mediaType, offset, mediaLen, 'utf8');
        offset += mediaLen;
      }
    }
  }
  return offset;
}

export function inventoryEncodedBytes(manifest: ArtifactManifest): number {
  const baseTree = manifest.spec.baseTree;
  if (!baseTree) {
    return 4 + manifest.spec.entries.reduce((sum, entry) => sum + entryWireBytes(entry), 0);
  }
  const deleted = manifest.spec.deleted ?? [];
  const oidBytes = baseTree.objectFormat === 'sha256' ? 32 : 20;
  return (
    4 +
    1 +
    oidBytes * 2 +
    4 +
    manifest.spec.entries.reduce((sum, entry) => sum + entryWireBytes(entry), 0) +
    4 +
    deleted.reduce((sum, name) => sum + 2 + Buffer.byteLength(name), 0)
  );
}

export function encodeInventory(manifest: ArtifactManifest, overlay?: OverlayLimitsInput): Uint8Array<ArrayBuffer> {
  const bounds = overlayProtocolBounds(overlay);
  const baseTree = manifest.spec.baseTree;
  const size = inventoryEncodedBytes(manifest);
  if (!baseTree) {
    if (manifest.spec.entries.length > bounds.maxClassicEntries) refuse('OUTPUT_LIMIT', '', 'verification');
    if (size > bounds.inventoryMaxBytes) refuse('OUTPUT_LIMIT', '', 'verification');
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, manifest.spec.entries.length);
    encodeEntries(bytes, view, 4, manifest.spec.entries);
    return bytes;
  }
  const deleted = manifest.spec.deleted ?? [];
  if (manifest.spec.entries.length > bounds.maxOverlayEntries || deleted.length > bounds.maxOverlayEntries) {
    refuse('OUTPUT_LIMIT', '', 'verification');
  }
  const oidBytes = baseTree.objectFormat === 'sha256' ? 32 : 20;
  if (size > bounds.inventoryMaxBytes) refuse('OUTPUT_LIMIT', '', 'verification');
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, OVERLAY_INVENTORY_MAGIC);
  bytes[4] = baseTree.objectFormat === 'sha256' ? 2 : 1;
  let offset = writeHexBytes(bytes, 5, baseTree.commitOid, oidBytes);
  offset = writeHexBytes(bytes, offset, baseTree.treeOid, oidBytes);
  view.setUint32(offset, manifest.spec.entries.length);
  offset += 4;
  offset = encodeEntries(bytes, view, offset, manifest.spec.entries);
  view.setUint32(offset, deleted.length);
  offset += 4;
  for (const name of deleted) {
    const length = Buffer.byteLength(name);
    if (!length || length > 4096) refuse('OUTPUT_LIMIT', '', 'verification');
    view.setUint16(offset, length);
    offset += 2;
    Buffer.from(bytes.buffer).write(name, offset, length, 'utf8');
    offset += length;
  }
  return bytes;
}

function inventoryEntries(
  bytes: Uint8Array,
  view: DataView,
  take: (length: number) => number,
  count: number,
  bounds: OverlayProtocolBounds,
): ArtifactRef[] {
  const entries: ArtifactRef[] = [];
  let total = 0;
  const maxTotalBig = BigInt(bounds.maxTotalBytes);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let index = 0; index < count; index++) {
    const headerWord = view.getUint16(take(2));
    const hasUri = (headerWord & URI_FLAG) !== 0;
    const hasMedia = (headerWord & MEDIA_TYPE_FLAG) !== 0;
    const length = headerWord & NAME_LEN_MASK;
    if (!length || length > 4096) refuse('ARTIFACT_INVALID', '', 'verification');
    const at = take(length);
    let name: string;
    try {
      name = decoder.decode(bytes.subarray(at, at + length));
    } catch {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }
    const wide = view.getBigUint64(take(8));
    if (wide > maxTotalBig || (total += Number(wide)) > bounds.maxTotalBytes) refuse('ARTIFACT_INVALID', '', 'verification');
    const digestAt = take(32);
    const hex = Buffer.from(bytes.buffer, bytes.byteOffset + digestAt, 32).toString('hex');
    const entry: Record<string, unknown> = { name, byteLength: Number(wide), digest: { algorithm: 'sha256', hex } };
    if (hasUri) {
      const uriLen = view.getInt16(take(2));
      if (uriLen === -1) entry.uri = null;
      else if (uriLen < 1 || uriLen > LIMITS.artifactUri) refuse('ARTIFACT_INVALID', '', 'verification');
      else {
        const uriAt = take(uriLen);
        try {
          entry.uri = decoder.decode(bytes.subarray(uriAt, uriAt + uriLen));
        } catch {
          refuse('ARTIFACT_INVALID', '', 'verification');
        }
      }
    }
    if (hasMedia) {
      const mediaLen = view.getInt16(take(2));
      if (mediaLen === -1) entry.mediaType = null;
      else if (mediaLen < 1 || mediaLen > LIMITS.mediaType) refuse('ARTIFACT_INVALID', '', 'verification');
      else {
        const mediaAt = take(mediaLen);
        try {
          entry.mediaType = decoder.decode(bytes.subarray(mediaAt, mediaAt + mediaLen));
        } catch {
          refuse('ARTIFACT_INVALID', '', 'verification');
        }
      }
    }
    entries.push(entry as unknown as ArtifactRef);
  }
  return entries;
}

export function inventory(
  bytes: Uint8Array,
  start: number,
  expected: ManifestDescriptor,
  quota: AllocationQuota,
  overlay?: OverlayLimitsInput,
) {
  const bounds = overlayProtocolBounds(overlay);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = start;
  const take = (length: number): number => {
    if (offset + length > bytes.byteLength || offset - start + length > bounds.inventoryMaxBytes) {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }
    const at = offset;
    offset += length;
    return at;
  };
  const firstWord = view.getUint32(take(4));
  if (firstWord !== OVERLAY_INVENTORY_MAGIC) {
    if (firstWord > bounds.maxClassicEntries || firstWord !== expected.entryCount) refuse('ARTIFACT_INVALID', '', 'verification');
    const entries = inventoryEntries(bytes, view, take, firstWord, bounds);
    return {
      manifest: document({ apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: expected.metadataId }, spec: { entries } }, expected, quota, bounds),
      offset,
    };
  }
  const formatByte = bytes[take(1)];
  if (formatByte !== 1 && formatByte !== 2) refuse('ARTIFACT_INVALID', '', 'verification');
  const objectFormat: BaseTreeAnchor['objectFormat'] = formatByte === 2 ? 'sha256' : 'sha1';
  const oidBytes = formatByte === 2 ? 32 : 20;
  const commitOid = Buffer.from(bytes.buffer, bytes.byteOffset + take(oidBytes), oidBytes).toString('hex');
  const treeOid = Buffer.from(bytes.buffer, bytes.byteOffset + take(oidBytes), oidBytes).toString('hex');
  const count = view.getUint32(take(4));
  if (count > bounds.maxOverlayEntries || count !== expected.entryCount) refuse('ARTIFACT_INVALID', '', 'verification');
  const entries = inventoryEntries(bytes, view, take, count, bounds);
  const deletedCount = view.getUint32(take(4));
  if (deletedCount > bounds.maxOverlayEntries) refuse('ARTIFACT_INVALID', '', 'verification');
  const deleted: string[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let index = 0; index < deletedCount; index++) {
    const length = view.getUint16(take(2));
    if (!length || length > 4096) refuse('ARTIFACT_INVALID', '', 'verification');
    const at = take(length);
    let name: string;
    try {
      name = decoder.decode(bytes.subarray(at, at + length));
    } catch {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }
    deleted.push(name);
  }
  const baseTree: BaseTreeAnchor = { objectFormat, commitOid, treeOid };
  return {
    manifest: document(
      { apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: expected.metadataId }, spec: { baseTree, entries, deleted } },
      expected,
      quota,
      bounds,
    ),
    offset,
  };
}

function checkedDescriptor(raw: unknown, maxEntries: number): ManifestDescriptor {
  const value = record(raw, ['metadataId', 'ref', 'entryCount']);
  return { metadataId: id(value.metadataId), ref: checkedRef(value.ref), entryCount: integer(value.entryCount, 0, maxEntries) };
}

function checkedOverlayField(raw: unknown): OverlayLimits {
  const obj = record(raw, ['maxFiles', 'maxBytes']);
  const maxFiles = integer(obj.maxFiles, 1, 4096);
  const maxBytes = integer(obj.maxBytes, 1024, 67_108_864);
  return { maxFiles, maxBytes };
}

function expectedPayloadKind(handler: ByteHandler): VerifierHeader['payloadKind'] {
  if (handler === 'json-artifact.v1') return 'json';
  if (handler === 'json-keys-guard.v1' || handler === 'line-section-guard.v1') return 'guard';
  return 'inventories';
}

export function checkedHeader(raw: unknown): VerifierHeader {
  if (!isRecord(raw)) refuse('ARTIFACT_INVALID', '', 'verification');
  const hasOverlay = Object.hasOwn(raw, 'overlay') && raw.overlay !== undefined;
  const value = record(raw, [
    'version', 'jobId', 'handler', 'handlerVersion', 'handlerDigest', 'checkId', 'producerNonce',
    'operationId', 'dispatchId', 'generation', 'subject', 'source', 'candidate', 'parameters', 'payloadKind',
    ...(hasOverlay ? ['overlay' as const] : []),
  ]);
  const handlerStr = text(value.handler);
  if (
    value.version !== 1 ||
    value.handlerVersion !== 1 ||
    !['scope.v1', 'no-change.v1', 'json-artifact.v1', 'json-keys-guard.v1', 'line-section-guard.v1'].includes(handlerStr) ||
    !/^[a-f0-9]{32}$/.test(text(value.producerNonce)) ||
    value.payloadKind !== expectedPayloadKind(handlerStr as ByteHandler)
  ) {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
  const overlay = hasOverlay ? checkedOverlayField(value.overlay) : undefined;
  const bounds = overlayProtocolBounds(overlay);
  const subjectCheck = validateDocument(
    {
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'Evidence',
      metadata: { id: 'header' },
      spec: {
        checkId: 'header',
        observedStatus: 'blocked',
        producerId: 'header',
        method: 'header',
        level: 'local_execution',
        subject: value.subject,
        artifacts: [],
        reason: 'header validation',
      },
    },
    'Evidence',
  );
  if (!subjectCheck.ok) refuse('ARTIFACT_INVALID', '', 'verification');
  return {
    version: 1,
    jobId: id(value.jobId),
    handler: handlerStr as ByteHandler,
    handlerVersion: 1,
    handlerDigest: digestValue(value.handlerDigest),
    checkId: id(value.checkId),
    producerNonce: text(value.producerNonce),
    operationId: id(value.operationId),
    dispatchId: id(value.dispatchId),
    generation: integer(value.generation, 0, 256),
    subject: subjectCheck.value.spec.subject,
    source: checkedDescriptor(value.source, bounds.maxManifestEntries),
    candidate: checkedDescriptor(value.candidate, bounds.maxManifestEntries),
    parameters: value.parameters as VerifierHeader['parameters'],
    payloadKind: value.payloadKind as VerifierHeader['payloadKind'],
    ...(overlay !== undefined ? { overlay } : {}),
  };
}

export function packetSize(header: VerifierHeader, payloadBytes: number, maximalFraming = true): number {
  const limit = maxPacketBytes(header);
  integer(payloadBytes, 0, limit);
  const sized = maximalFraming
    ? { ...header, jobId: 'x'.repeat(64), operationId: 'x'.repeat(64), dispatchId: 'x'.repeat(64), generation: 256 }
    : header;
  if (Buffer.byteLength(canonical(sized)) > HEADER_BYTES) refuse('OUTPUT_LIMIT', '', 'verification');
  const total = 4 + HEADER_BYTES + payloadBytes;
  if (total > limit) refuse('OUTPUT_LIMIT', '', 'verification');
  return total;
}

export function encodePacket(header: VerifierHeader, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const size = packetSize(header, payload.byteLength, false);
  const bytes = new Uint8Array(size);
  const encoded = canonical(header);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, Buffer.byteLength(encoded));
  Buffer.from(bytes.buffer).write(encoded, 4, HEADER_BYTES, 'utf8');
  bytes.set(payload, 4 + HEADER_BYTES);
  return bytes;
}

function verifyJsonPayload(blobSlice: Uint8Array, required: readonly string[], equals: Readonly<Record<string, Json>>): VerifierReply['reason'] {
  let value: Json | undefined;
  try {
    value = parsePrivateJson(blobSlice, JSON_FILE_BYTES, 128);
  } catch (error) {
    if (!(error instanceof ControllerFailure)) throw error;
    return 'invalid_json';
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'invalid_json';
  const object = value as Readonly<Record<string, Json>>;
  if (required.some(key => !Object.hasOwn(object, key))) return 'property_missing';
  if (Object.entries(equals).some(([key, expected]) => !Object.hasOwn(object, key) || !same(object[key], expected))) return 'property_mismatch';
  return null;
}

function assertMatchingManifestShapes(source: ArtifactManifest, candidate: ArtifactManifest): void {
  if (
    (source.spec.baseTree === undefined) !== (candidate.spec.baseTree === undefined) ||
    !same(source.spec.baseTree ?? null, candidate.spec.baseTree ?? null)
  ) {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
}

function verifyMerkleBlobSlice(
  bytes: Uint8Array,
  view: DataView,
  startPos: number,
  path: string,
  baseTree: BaseTreeAnchor,
  expectedRaw: unknown,
  quota: AllocationQuota,
): { readonly blobSlice: Uint8Array; readonly nextPos: number } {
  const expected = record(expectedRaw, ['mode', 'oid', 'byteLength', ...(isRecord(expectedRaw) && Object.hasOwn(expectedRaw, 'baseline') ? ['baseline' as const] : []), ...(isRecord(expectedRaw) && Object.hasOwn(expectedRaw, 'kind') ? ['kind' as const] : [])]);
  const expectedMode = expected.mode;
  const expectedOid = text(expected.oid);
  const expectedByteLength = integer(expected.byteLength, 0, JSON_FILE_BYTES);
  const oidPattern = baseTree.objectFormat === 'sha256' ? /^[0-9a-f]{64}$/ : /^[0-9a-f]{40}$/;
  if ((expectedMode !== '100644' && expectedMode !== '100755') || !oidPattern.test(expectedOid)) {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
  let pos = startPos;
  if (pos + 4 > bytes.byteLength) refuse('ARTIFACT_INVALID', '', 'verification');
  const blobLen = view.getUint32(pos);
  pos += 4;
  if (blobLen !== expectedByteLength || blobLen > JSON_FILE_BYTES || pos + blobLen + 4 > bytes.byteLength) {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
  const blobSlice = bytes.subarray(pos, pos + blobLen);
  pos += blobLen;
  const treeCount = view.getUint32(pos);
  pos += 4;
  const segments = path.split('/');
  if (treeCount !== segments.length || treeCount < 1 || treeCount > 16) refuse('ARTIFACT_INVALID', '', 'verification');
  const oidByteLength = baseTree.objectFormat === 'sha256' ? 32 : 20;
  let currentTreeOid = baseTree.treeOid;
  let totalTreeBytes = 0;
  for (let index = 0; index < treeCount; index++) {
    if (pos + 4 > bytes.byteLength) refuse('ARTIFACT_INVALID', '', 'verification');
    const treeLen = view.getUint32(pos);
    pos += 4;
    if (!treeLen || treeLen > 262144 || (totalTreeBytes += treeLen) > 262144 || pos + treeLen > bytes.byteLength) {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }
    quota.charge(treeLen);
    const treeSlice = bytes.subarray(pos, pos + treeLen);
    pos += treeLen;
    if (gitObjectOid(baseTree.objectFormat, 'tree', treeSlice) !== currentTreeOid) refuse('ARTIFACT_INVALID', '', 'verification');
    const treeEntries = parseGitTreeEntries(treeSlice, oidByteLength, 'verification', 'ARTIFACT_INVALID');
    const match = treeEntries.find(entry => entry.name === segments[index]);
    if (!match) refuse('ARTIFACT_INVALID', '', 'verification');
    if (index < treeCount - 1) {
      if (match.mode !== '40000') refuse('ARTIFACT_INVALID', '', 'verification');
      currentTreeOid = match.oid;
    } else {
      if (match.mode !== expectedMode || match.oid !== expectedOid) refuse('ARTIFACT_INVALID', '', 'verification');
      if (gitObjectOid(baseTree.objectFormat, 'blob', blobSlice) !== match.oid) refuse('ARTIFACT_INVALID', '', 'verification');
    }
  }
  return { blobSlice, nextPos: pos };
}

type GuardJson = null | boolean | number | string | readonly GuardJson[] | { readonly [key: string]: GuardJson };

function isPlainGuardObject(val: GuardJson): val is { readonly [key: string]: GuardJson } {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

/** Strict null-prototype JSON parser rejecting duplicate keys, trailing tokens, and non-finite numbers. */
function parseStrictGuardJson(bytes: Uint8Array): { readonly ok: true; readonly value: GuardJson } | { readonly ok: false; readonly message: string } {
  if (bytes.byteLength > JSON_FILE_BYTES) return { ok: false, message: 'JSON file exceeds byte limit' };
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, message: 'Invalid UTF-8 encoding in JSON file' };
  }
  let offset = 0;
  let nodes = 0;
  const skipSpace = () => {
    while (offset < source.length) {
      const ch = source.charCodeAt(offset);
      if (ch !== 0x20 && ch !== 0x09 && ch !== 0x0a && ch !== 0x0d) break;
      offset++;
    }
  };
  const parseStr = (): string => {
    const start = offset++;
    while (offset < source.length) {
      const ch = source[offset++];
      if (ch === '\\') {
        offset++;
        continue;
      }
      if (ch === '"') {
        const parsed: unknown = JSON.parse(source.slice(start, offset));
        if (typeof parsed !== 'string') throw new Error('Invalid string');
        if (LONE_SURROGATE_PATTERN.test(parsed)) throw new Error('Invalid lone UTF-16 surrogate in JSON string');
        return parsed;
      }
    }
    throw new Error('Unterminated JSON string');
  };
  const parseVal = (depth: number): GuardJson => {
    if (++nodes > 131_072 || depth > 64) throw new Error('JSON complexity limit exceeded');
    skipSpace();
    if (offset >= source.length) throw new Error('Unexpected end of JSON input');
    const ch = source[offset];
    if (ch === '"') return parseStr();
    if (ch === '{') {
      offset++;
      skipSpace();
      const obj = Object.create(null) as Record<string, GuardJson>;
      const seen = new Set<string>();
      if (source[offset] === '}') {
        offset++;
        return obj;
      }
      let count = 0;
      for (;;) {
        if (++count > 16_384) throw new Error('JSON object property limit exceeded');
        skipSpace();
        if (source[offset] !== '"') throw new Error('Expected JSON property name');
        const key = parseStr();
        if (seen.has(key)) throw new Error(`Duplicate JSON key "${key}"`);
        seen.add(key);
        skipSpace();
        if (source[offset++] !== ':') throw new Error('Expected ":" after property name');
        obj[key] = parseVal(depth + 1);
        skipSpace();
        const delim = source[offset++];
        if (delim === '}') return obj;
        if (delim !== ',') throw new Error('Expected "," or "}" in JSON object');
      }
    }
    if (ch === '[') {
      offset++;
      skipSpace();
      const arr: GuardJson[] = [];
      if (source[offset] === ']') {
        offset++;
        return arr;
      }
      let count = 0;
      for (;;) {
        if (++count > 16_384) throw new Error('JSON array length limit exceeded');
        arr.push(parseVal(depth + 1));
        skipSpace();
        const delim = source[offset++];
        if (delim === ']') return arr;
        if (delim !== ',') throw new Error('Expected "," or "]" in JSON array');
      }
    }
    const lit = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(offset));
    if (!lit) throw new Error('Invalid JSON token');
    offset += lit[0].length;
    if (lit[0] === 'true') return true;
    if (lit[0] === 'false') return false;
    if (lit[0] === 'null') return null;
    const num = Number(lit[0]);
    if (!Number.isFinite(num)) throw new Error('Non-finite JSON number');
    return Object.is(num, -0) ? 0 : num;
  };
  try {
    const val = parseVal(1);
    skipSpace();
    if (offset !== source.length) return { ok: false, message: 'Unexpected trailing tokens in JSON file' };
    return { ok: true, value: val };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Invalid JSON' };
  }
}

function guardJsonSame(a: GuardJson, b: GuardJson): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const arrB = b as readonly GuardJson[];
    if (a.length !== arrB.length) return false;
    for (let i = 0; i < a.length; i++) if (!guardJsonSame(a[i]!, arrB[i]!)) return false;
    return true;
  }
  const objA = a as Record<string, GuardJson>;
  const objB = b as Record<string, GuardJson>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!Object.hasOwn(objB, k) || !guardJsonSame(objA[k]!, objB[k]!)) return false;
  }
  return true;
}

function encodeRfc6901(tokens: readonly string[]): string {
  if (tokens.length === 0) return '';
  return '/' + tokens.map(tok => tok.replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
}

function decodeRfc6901(pointer: string): readonly string[] {
  return pointer
    .slice(1)
    .split('/')
    .map(tok => tok.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function isTokensCovered(tokens: readonly string[], allowedList: readonly (readonly string[])[]): boolean {
  if (tokens.length === 0) return false;
  return allowedList.some(allowed => allowed.length <= tokens.length && allowed.every((seg, idx) => seg === tokens[idx]));
}

function clipText(input: string, maxChars: number): string {
  const safe = input.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu, '\uFFFD');
  return safe.length <= maxChars ? safe : Array.from(safe).slice(0, maxChars).join('');
}

function makeGuardFinding(title: string, path: string, evidence: string, line?: number): StructuredFinding {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  out.title = clipText(title, LIMITS.findingTitle);
  out.severity = 'high';
  out.path = path;
  if (line !== undefined) out.line = line;
  out.evidence = clipText(evidence, LIMITS.findingEvidence);
  return freeze(out as unknown as StructuredFinding);
}

function boundGuardFindings(findings: readonly StructuredFinding[]): readonly StructuredFinding[] {
  const capped: StructuredFinding[] = [];
  let bytes = 0;
  for (const item of findings.slice(0, LIMITS.findings)) {
    const itemBytes = Buffer.byteLength(canonical(item));
    if (bytes + itemBytes > 32_000 && capped.length > 0) break;
    bytes += itemBytes;
    capped.push(item);
  }
  return freeze(capped);
}

function evaluateJsonKeysGuard(
  path: string,
  allowedPointers: readonly string[],
  baselineBytes: Uint8Array | null,
  candidateBytes: Uint8Array | null,
): { readonly reason: VerifierReason | null; readonly detail?: string; readonly findings?: readonly StructuredFinding[] } {
  if (baselineBytes === null || candidateBytes === null) {
    const which = baselineBytes === null ? 'baseline' : 'candidate';
    return {
      reason: 'missing_file',
      detail: `Guarded JSON file "${path}" is missing in ${which}`,
      findings: boundGuardFindings([makeGuardFinding(`Missing guarded JSON file (${which})`, path, `File "${path}" is missing in ${which}`)]),
    };
  }
  const parsedBase = parseStrictGuardJson(baselineBytes);
  if (!parsedBase.ok) {
    return {
      reason: 'invalid_json',
      detail: `Baseline JSON "${path}" is invalid: ${parsedBase.message}`,
      findings: boundGuardFindings([makeGuardFinding('Invalid baseline JSON', path, parsedBase.message)]),
    };
  }
  const parsedCand = parseStrictGuardJson(candidateBytes);
  if (!parsedCand.ok) {
    return {
      reason: 'invalid_json',
      detail: `Candidate JSON "${path}" is invalid: ${parsedCand.message}`,
      findings: boundGuardFindings([makeGuardFinding('Invalid candidate JSON', path, parsedCand.message)]),
    };
  }

  const allowedDecoded = allowedPointers.map(decodeRfc6901);
  const violations: { readonly pointer: string; readonly kind: 'added' | 'removed' | 'modified' }[] = [];

  const recordIfDisallowed = (targetTokens: readonly string[], kind: 'added' | 'removed'): void => {
    if (violations.length >= LIMITS.findings) return;
    if (isTokensCovered(targetTokens, allowedDecoded)) return;
    violations.push({ pointer: encodeRfc6901(targetTokens), kind });
  };

  const diffValues = (baseVal: GuardJson, candVal: GuardJson, tokens: readonly string[]): void => {
    if (violations.length >= LIMITS.findings) return;
    if (guardJsonSame(baseVal, candVal)) return;
    if (isTokensCovered(tokens, allowedDecoded)) return;
    if (isPlainGuardObject(baseVal) && isPlainGuardObject(candVal)) {
      const unionKeys = [...new Set([...Object.keys(baseVal), ...Object.keys(candVal)])].sort();
      for (const k of unionKeys) {
        if (violations.length >= LIMITS.findings) return;
        const inBase = Object.hasOwn(baseVal, k);
        const inCand = Object.hasOwn(candVal, k);
        if (!inBase) recordIfDisallowed([...tokens, k], 'added');
        else if (!inCand) recordIfDisallowed([...tokens, k], 'removed');
        else diffValues(baseVal[k]!, candVal[k]!, [...tokens, k]);
      }
      return;
    }
    if (Array.isArray(baseVal) && Array.isArray(candVal)) {
      const maxLen = Math.max(baseVal.length, candVal.length);
      for (let i = 0; i < maxLen; i++) {
        if (violations.length >= LIMITS.findings) return;
        if (i >= baseVal.length) recordIfDisallowed([...tokens, String(i)], 'added');
        else if (i >= candVal.length) recordIfDisallowed([...tokens, String(i)], 'removed');
        else diffValues(baseVal[i]!, candVal[i]!, [...tokens, String(i)]);
      }
      return;
    }
    violations.push({ pointer: encodeRfc6901(tokens), kind: 'modified' });
  };

  diffValues(parsedBase.value, parsedCand.value, []);
  if (violations.length === 0) return { reason: null };

  const findings = boundGuardFindings(
    violations.map(v =>
      makeGuardFinding(
        `Disallowed JSON edit at ${v.pointer}`,
        path,
        `JSON pointer "${v.pointer}" was ${v.kind} outside allowedPointers`,
      ),
    ),
  );
  const preview = violations.slice(0, 8).map(v => v.pointer).join(', ');
  return {
    reason: 'disallowed_json_pointer',
    detail: clipText(`Disallowed JSON edits outside allowedPointers in ${path}: ${preview}`, 1024),
    findings,
  };
}

interface OutsideLine {
  readonly text: string;
  readonly line: number;
}

function extractOutsideSegments(
  content: string,
  startMarker: string,
  endMarker: string,
  label: 'baseline' | 'candidate',
  path: string,
): { readonly ok: true; readonly segments: readonly (readonly OutsideLine[])[] } | { readonly ok: false; readonly reason: VerifierReason; readonly detail: string; readonly finding: StructuredFinding } {
  const lines = content.split('\n');
  const segments: OutsideLine[][] = [[]];
  let inSection = false;
  let openStartLine = 0;
  let sectionCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    const lineNoCr = line.endsWith('\r') ? line.slice(0, -1) : line;
    const trimmed = lineNoCr.trim();
    const isStart = lineNoCr === startMarker || trimmed === startMarker;
    const isEnd = lineNoCr === endMarker || trimmed === endMarker;

    if (isStart) {
      if (inSection) {
        const msg = `Nested startMarker "${startMarker}" in ${label} at line ${lineNo} (section opened at line ${openStartLine})`;
        return { ok: false, reason: 'unbalanced_markers', detail: clipText(msg, 1024), finding: makeGuardFinding('Nested startMarker in guarded file', path, msg, lineNo) };
      }
      segments.at(-1)!.push({ text: lineNoCr, line: lineNo });
      inSection = true;
      openStartLine = lineNo;
      sectionCount++;
    } else if (isEnd) {
      if (!inSection) {
        const msg = `Unmatched endMarker "${endMarker}" without startMarker in ${label} at line ${lineNo}`;
        return { ok: false, reason: 'unbalanced_markers', detail: clipText(msg, 1024), finding: makeGuardFinding('Unmatched endMarker in guarded file', path, msg, lineNo) };
      }
      inSection = false;
      segments.push([{ text: lineNoCr, line: lineNo }]);
    } else if (!inSection) {
      segments.at(-1)!.push({ text: line, line: lineNo });
    }
  }

  if (inSection) {
    const msg = `Unclosed startMarker "${startMarker}" in ${label} opened at line ${openStartLine}`;
    return { ok: false, reason: 'unbalanced_markers', detail: clipText(msg, 1024), finding: makeGuardFinding('Unclosed startMarker in guarded file', path, msg, openStartLine) };
  }
  if (sectionCount === 0) {
    const msg = `No "${startMarker}" .. "${endMarker}" section found in ${label}`;
    return { ok: false, reason: 'missing_markers', detail: clipText(msg, 1024), finding: makeGuardFinding('Missing section markers in guarded file', path, msg, 1) };
  }
  return { ok: true, segments };
}

function evaluateLineSectionGuard(
  path: string,
  startMarker: string,
  endMarker: string,
  baselineBytes: Uint8Array | null,
  candidateBytes: Uint8Array | null,
): { readonly reason: VerifierReason | null; readonly detail?: string; readonly findings?: readonly StructuredFinding[] } {
  if (baselineBytes === null || candidateBytes === null) {
    const which = baselineBytes === null ? 'baseline' : 'candidate';
    return {
      reason: 'missing_file',
      detail: `Guarded file "${path}" is missing in ${which}`,
      findings: boundGuardFindings([makeGuardFinding(`Missing guarded file (${which})`, path, `File "${path}" is missing in ${which}`)]),
    };
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let baseText: string;
  let candText: string;
  try {
    baseText = decoder.decode(baselineBytes);
  } catch {
    return {
      reason: 'invalid_utf8',
      detail: `Baseline file "${path}" is not valid UTF-8`,
      findings: boundGuardFindings([makeGuardFinding('Invalid UTF-8 in baseline file', path, `Baseline "${path}" failed UTF-8 decoding`)]),
    };
  }
  try {
    candText = decoder.decode(candidateBytes);
  } catch {
    return {
      reason: 'invalid_utf8',
      detail: `Candidate file "${path}" is not valid UTF-8`,
      findings: boundGuardFindings([makeGuardFinding('Invalid UTF-8 in candidate file', path, `Candidate "${path}" failed UTF-8 decoding`)]),
    };
  }

  const baseExtracted = extractOutsideSegments(baseText, startMarker, endMarker, 'baseline', path);
  if (!baseExtracted.ok) {
    return { reason: baseExtracted.reason, detail: baseExtracted.detail, findings: boundGuardFindings([baseExtracted.finding]) };
  }
  const candExtracted = extractOutsideSegments(candText, startMarker, endMarker, 'candidate', path);
  if (!candExtracted.ok) {
    return { reason: candExtracted.reason, detail: candExtracted.detail, findings: boundGuardFindings([candExtracted.finding]) };
  }

  const baseSegs = baseExtracted.segments;
  const candSegs = candExtracted.segments;
  const maxSegs = Math.max(baseSegs.length, candSegs.length);

  for (let s = 0; s < maxSegs; s++) {
    if (s >= baseSegs.length || s >= candSegs.length) {
      const lineNo = candSegs[s]?.[0]?.line ?? candSegs.at(-1)?.at(-1)?.line ?? 1;
      const msg = `Guarded section count changed in "${path}" (baseline: ${baseSegs.length - 1}, candidate: ${candSegs.length - 1})`;
      return {
        reason: 'outside_section_modified',
        detail: clipText(msg, 1024),
        findings: boundGuardFindings([makeGuardFinding('Guarded section structure modified', path, msg, lineNo)]),
      };
    }
    const bSeg = baseSegs[s]!;
    const cSeg = candSegs[s]!;
    const maxLines = Math.max(bSeg.length, cSeg.length);
    for (let j = 0; j < maxLines; j++) {
      if (j >= bSeg.length) {
        const added = cSeg[j]!;
        const msg = `Line ${added.line} added outside guarded section in "${path}": ${clipText(added.text, 200)}`;
        return {
          reason: 'outside_section_modified',
          detail: clipText(msg, 1024),
          findings: boundGuardFindings([makeGuardFinding('Line added outside guarded section', path, msg, added.line)]),
        };
      }
      if (j >= cSeg.length) {
        const removed = bSeg[j]!;
        const reportLine = cSeg.at(-1)?.line ?? 1;
        const msg = `Baseline line ${removed.line} removed outside guarded section in "${path}": ${clipText(removed.text, 200)}`;
        return {
          reason: 'outside_section_modified',
          detail: clipText(msg, 1024),
          findings: boundGuardFindings([makeGuardFinding('Line removed outside guarded section', path, msg, reportLine)]),
        };
      }
      if (bSeg[j]!.text !== cSeg[j]!.text) {
        const bLine = bSeg[j]!;
        const cLine = cSeg[j]!;
        const msg = `Out-of-section edit at line ${cLine.line} (baseline line ${bLine.line}) in "${path}": expected ${JSON.stringify(clipText(bLine.text, 120))}, got ${JSON.stringify(clipText(cLine.text, 120))}`;
        return {
          reason: 'outside_section_modified',
          detail: clipText(msg, 1024),
          findings: boundGuardFindings([makeGuardFinding('Line modified outside guarded section', path, msg, cLine.line)]),
        };
      }
    }
  }
  return { reason: null };
}

export function evaluatePacket(bytes: Uint8Array): VerifierReply {
  if (
    !(bytes instanceof Uint8Array) ||
    types.isSharedArrayBuffer(bytes.buffer) ||
    bytes.byteOffset !== 0 ||
    bytes.byteLength !== bytes.buffer.byteLength ||
    bytes.byteLength < 16392 ||
    bytes.byteLength > MAX_ABSOLUTE_PACKET_BYTES
  ) {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
  const view = new DataView(bytes.buffer);
  const length = view.getUint32(0);
  if (!length || length > HEADER_BYTES) refuse('ARTIFACT_INVALID', '', 'verification');
  for (let index = 4 + length; index < 4 + HEADER_BYTES; index++) if (bytes[index] !== 0) refuse('ARTIFACT_INVALID', '', 'verification');
  const raw = parsePrivateJson(bytes.subarray(4, 4 + length), HEADER_BYTES, 256);
  const header = checkedHeader(raw);
  if (canonical(raw) !== canonical(header) || Buffer.byteLength(canonical(raw)) !== length) refuse('ARTIFACT_INVALID', '', 'verification');
  packetSize(header, bytes.byteLength - 4 - HEADER_BYTES, false);

  const bounds = overlayProtocolBounds(header.overlay);
  const quota = new AllocationQuota(bounds.allocationMaxBytes);
  quota.charge(bytes.byteLength);

  const first = inventory(bytes, 4 + HEADER_BYTES, header.source, quota, header.overlay);
  const second = inventory(bytes, first.offset, header.candidate, quota, header.overlay);
  const source = first.manifest;
  const candidate = second.manifest;
  assertMatchingManifestShapes(source, candidate);

  let reason: VerifierReply['reason'] = null;
  let method: VerifierReply['method'];
  let detail: string | undefined;
  let findings: readonly StructuredFinding[] | undefined;

  if (header.payloadKind === 'inventories') {
    if (second.offset !== bytes.byteLength) refuse('ARTIFACT_INVALID', '', 'verification');
    const sourceByName = new Map(source.spec.entries.map(entry => [entry.name, entry]));
    const candByName = new Map(candidate.spec.entries.map(entry => [entry.name, entry]));
    const allEntryNames = new Set([...sourceByName.keys(), ...candByName.keys()]);
    const entryChanged = [...allEntryNames].filter(name => !same(sourceByName.get(name) ?? null, candByName.get(name) ?? null));
    const sourceDeleted = new Set(source.spec.deleted ?? []);
    const candidateDeleted = new Set(candidate.spec.deleted ?? []);
    const allDeletedNames = new Set([...sourceDeleted, ...candidateDeleted]);
    const deletedChanged = [...allDeletedNames].filter(name => sourceDeleted.has(name) !== candidateDeleted.has(name));
    const changed = [...new Set([...entryChanged, ...deletedChanged])];
    if (header.handler === 'no-change.v1') {
      record(header.parameters, []);
      method = 'verify_no_change';
      if (changed.length) reason = 'candidate_changed';
    } else {
      const parameters = record(header.parameters, ['contract']);
      const contract = validateDocument(parameters.contract, 'TaskContract');
      if (!contract.ok) refuse('ARTIFACT_INVALID', '', 'verification');
      if (!same(contract.value.spec.budgets.overlay ?? null, header.overlay ?? null)) refuse('ARTIFACT_INVALID', '', 'verification');
      const admitted = admitTask(contract.value, { admissionId: 'header', runId: 'header' });
      if (!admitted.ok || !same(admitted.value.spec.contractHash, header.subject.contractHash)) refuse('ARTIFACT_INVALID', '', 'verification');
      method = 'verify_scope';
      for (const name of changed) {
        const allowed = isWritablePath(contract.value, name);
        if (!allowed.ok) refuse('ARTIFACT_INVALID', '', 'verification');
        if (!allowed.value) reason = 'outside_scope';
      }
    }
  } else if (header.payloadKind === 'json') {
    const parameters = record(header.parameters, ['path', 'expected', 'required', 'equals']);
    const path = text(parameters.path, '', 1024);
    const vPath = validateRelativePath(path);
    if (!vPath.ok) refuse('ARTIFACT_INVALID', '', 'verification');
    const selected = candidate.spec.entries.find(entry => entry.name === path) ?? null;
    const required = list(parameters.required, '', 128).map(item => text(item, '', 128));
    const equals = parameters.equals;
    if (
      equals === null ||
      typeof equals !== 'object' ||
      Array.isArray(equals) ||
      Object.keys(equals).length > 128 ||
      Object.values(equals).some(value => value !== null && !['string', 'boolean', 'number'].includes(typeof value))
    ) {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }
    method = 'verify_json';
    const baseTree = candidate.spec.baseTree;
    const startPos = second.offset;
    if (!baseTree) {
      if (!same(parameters.expected, selected)) refuse('ARTIFACT_INVALID', '', 'verification');
      if (startPos + 4 > bytes.byteLength) refuse('ARTIFACT_INVALID', '', 'verification');
      const count = view.getUint32(startPos);
      const offset = startPos + 4;
      if (count > JSON_FILE_BYTES || offset + count !== bytes.byteLength) refuse('ARTIFACT_INVALID', '', 'verification');
      if (selected === null) {
        if (count !== 0) refuse('ARTIFACT_INVALID', '', 'verification');
        reason = 'missing_file';
      } else {
        if (count !== selected.byteLength || !same(fileHash(bytes.subarray(offset)), selected.digest)) refuse('ARTIFACT_INVALID', '', 'verification');
        reason = verifyJsonPayload(bytes.subarray(offset), required, equals as Readonly<Record<string, Json>>);
      }
    } else if (selected !== null) {
      if (!same(parameters.expected, selected)) refuse('ARTIFACT_INVALID', '', 'verification');
      if (startPos + 4 > bytes.byteLength) refuse('ARTIFACT_INVALID', '', 'verification');
      const count = view.getUint32(startPos);
      const offset = startPos + 4;
      if (count > JSON_FILE_BYTES || offset + count !== bytes.byteLength) refuse('ARTIFACT_INVALID', '', 'verification');
      if (count !== selected.byteLength || !same(fileHash(bytes.subarray(offset)), selected.digest)) refuse('ARTIFACT_INVALID', '', 'verification');
      reason = verifyJsonPayload(bytes.subarray(offset), required, equals as Readonly<Record<string, Json>>);
    } else if ((candidate.spec.deleted ?? []).includes(path)) {
      if (parameters.expected !== null || startPos + 4 > bytes.byteLength) refuse('ARTIFACT_INVALID', '', 'verification');
      const count = view.getUint32(startPos);
      const offset = startPos + 4;
      if (count !== 0 || offset !== bytes.byteLength) refuse('ARTIFACT_INVALID', '', 'verification');
      reason = 'missing_file';
    } else if (parameters.expected === null) {
      if (startPos + 4 > bytes.byteLength) refuse('ARTIFACT_INVALID', '', 'verification');
      const count = view.getUint32(startPos);
      const offset = startPos + 4;
      if (count !== 0 || offset !== bytes.byteLength) refuse('ARTIFACT_INVALID', '', 'verification');
      reason = 'missing_file';
    } else {
      const expectedCheck = record(parameters.expected, ['baseline', 'mode', 'oid', 'byteLength']);
      if (expectedCheck.baseline !== true) refuse('ARTIFACT_INVALID', '', 'verification');
      const verified = verifyMerkleBlobSlice(bytes, view, startPos, path, baseTree, parameters.expected, quota);
      if (verified.nextPos !== bytes.byteLength) refuse('ARTIFACT_INVALID', '', 'verification');
      reason = verifyJsonPayload(verified.blobSlice, required, equals as Readonly<Record<string, Json>>);
    }
  } else {
    const isJsonKeys = header.handler === 'json-keys-guard.v1';
    const parameters = record(
      header.parameters,
      isJsonKeys ? ['path', 'baseline', 'candidate', 'allowedPointers'] : ['path', 'baseline', 'candidate', 'startMarker', 'endMarker'],
    );
    const path = text(parameters.path, '', 1024);
    if (!validateRelativePath(path).ok) refuse('ARTIFACT_INVALID', '', 'verification');

    const baseTree = candidate.spec.baseTree;
    const sourceSelected = source.spec.entries.find(entry => entry.name === path) ?? null;
    const sourceDeleted = (source.spec.deleted ?? []).includes(path);
    const candSelected = candidate.spec.entries.find(entry => entry.name === path) ?? null;
    const candDeleted = (candidate.spec.deleted ?? []).includes(path);

    let pos = second.offset;
    let baselineBytes: Uint8Array | null = null;
    if (!isRecord(parameters.baseline)) refuse('ARTIFACT_INVALID', '', 'verification');
    const baseKind = text(parameters.baseline.kind, '', 32);
    if (!baseTree) {
      if (baseKind === 'missing') {
        record(parameters.baseline, ['kind']);
        if (sourceSelected !== null) refuse('ARTIFACT_INVALID', '', 'verification');
      } else if (baseKind === 'overlay') {
        const bSpec = record(parameters.baseline, ['kind', 'entry']);
        if (sourceSelected === null || !same(bSpec.entry, sourceSelected) || pos + 4 > bytes.byteLength) refuse('ARTIFACT_INVALID', '', 'verification');
        const len = view.getUint32(pos);
        pos += 4;
        if (len > JSON_FILE_BYTES || len !== sourceSelected.byteLength || pos + len > bytes.byteLength) refuse('ARTIFACT_INVALID', '', 'verification');
        const slice = bytes.subarray(pos, pos + len);
        pos += len;
        if (!same(fileHash(slice), sourceSelected.digest)) refuse('ARTIFACT_INVALID', '', 'verification');
        baselineBytes = slice;
      } else {
        refuse('ARTIFACT_INVALID', '', 'verification');
      }
    } else if (sourceSelected !== null) {
      const bSpec = record(parameters.baseline, ['kind', 'entry']);
      if (baseKind !== 'overlay' || !same(bSpec.entry, sourceSelected) || pos + 4 > bytes.byteLength) refuse('ARTIFACT_INVALID', '', 'verification');
      const len = view.getUint32(pos);
      pos += 4;
      if (len > JSON_FILE_BYTES || len !== sourceSelected.byteLength || pos + len > bytes.byteLength) refuse('ARTIFACT_INVALID', '', 'verification');
      const slice = bytes.subarray(pos, pos + len);
      pos += len;
      if (!same(fileHash(slice), sourceSelected.digest)) refuse('ARTIFACT_INVALID', '', 'verification');
      baselineBytes = slice;
    } else if (sourceDeleted) {
      record(parameters.baseline, ['kind']);
      if (baseKind !== 'missing') refuse('ARTIFACT_INVALID', '', 'verification');
    } else if (baseKind === 'missing') {
      record(parameters.baseline, ['kind']);
    } else if (baseKind === 'merkle_blob') {
      const verified = verifyMerkleBlobSlice(bytes, view, pos, path, source.spec.baseTree!, parameters.baseline, quota);
      baselineBytes = verified.blobSlice;
      pos = verified.nextPos;
    } else {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }

    let candidateBytes: Uint8Array | null = null;
    if (!isRecord(parameters.candidate)) refuse('ARTIFACT_INVALID', '', 'verification');
    const candKind = text(parameters.candidate.kind, '', 32);
    if (!baseTree) {
      if (candKind === 'missing') {
        record(parameters.candidate, ['kind']);
        if (candSelected !== null) refuse('ARTIFACT_INVALID', '', 'verification');
      } else if (candKind === 'overlay') {
        const cSpec = record(parameters.candidate, ['kind', 'entry']);
        if (candSelected === null || !same(cSpec.entry, candSelected) || pos + 4 > bytes.byteLength) refuse('ARTIFACT_INVALID', '', 'verification');
        const len = view.getUint32(pos);
        pos += 4;
        if (len > JSON_FILE_BYTES || len !== candSelected.byteLength || pos + len > bytes.byteLength) refuse('ARTIFACT_INVALID', '', 'verification');
        const slice = bytes.subarray(pos, pos + len);
        pos += len;
        if (!same(fileHash(slice), candSelected.digest)) refuse('ARTIFACT_INVALID', '', 'verification');
        candidateBytes = slice;
      } else {
        refuse('ARTIFACT_INVALID', '', 'verification');
      }
    } else if (candSelected !== null) {
      const cSpec = record(parameters.candidate, ['kind', 'entry']);
      if (candKind !== 'overlay' || !same(cSpec.entry, candSelected) || pos + 4 > bytes.byteLength) refuse('ARTIFACT_INVALID', '', 'verification');
      const len = view.getUint32(pos);
      pos += 4;
      if (len > JSON_FILE_BYTES || len !== candSelected.byteLength || pos + len > bytes.byteLength) refuse('ARTIFACT_INVALID', '', 'verification');
      const slice = bytes.subarray(pos, pos + len);
      pos += len;
      if (!same(fileHash(slice), candSelected.digest)) refuse('ARTIFACT_INVALID', '', 'verification');
      candidateBytes = slice;
    } else if (candDeleted) {
      record(parameters.candidate, ['kind']);
      if (candKind !== 'deleted') refuse('ARTIFACT_INVALID', '', 'verification');
      candidateBytes = null;
    } else {
      record(parameters.candidate, ['kind']);
      if (candKind !== 'unchanged_baseline') refuse('ARTIFACT_INVALID', '', 'verification');
      candidateBytes = baselineBytes;
    }

    if (pos !== bytes.byteLength) refuse('ARTIFACT_INVALID', '', 'verification');

    if (isJsonKeys) {
      const allowedPointers = list(parameters.allowedPointers, '', 128).map(item => text(item, '', 256));
      if (allowedPointers.length < 1 || allowedPointers.some(ptr => !RFC6901_POINTER_PATTERN.test(ptr))) {
        refuse('ARTIFACT_INVALID', '', 'verification');
      }
      method = 'verify_json_keys_guard';
      const guardRes = evaluateJsonKeysGuard(path, allowedPointers, baselineBytes, candidateBytes);
      reason = guardRes.reason;
      detail = guardRes.detail;
      findings = guardRes.findings;
    } else {
      const startMarker = text(parameters.startMarker, '', 256);
      const endMarker = text(parameters.endMarker, '', 256);
      if (
        startMarker.length < 1 ||
        endMarker.length < 1 ||
        startMarker === endMarker ||
        /[\r\n]/.test(startMarker) ||
        /[\r\n]/.test(endMarker)
      ) {
        refuse('ARTIFACT_INVALID', '', 'verification');
      }
      method = 'verify_line_section_guard';
      const guardRes = evaluateLineSectionGuard(path, startMarker, endMarker, baselineBytes, candidateBytes);
      reason = guardRes.reason;
      detail = guardRes.detail;
      findings = guardRes.findings;
    }
  }

  const identified = identifyManifest(candidate, bounds.options);
  if (!identified.ok || !same(identified.value.digest, header.subject.candidateDigest)) refuse('ARTIFACT_INVALID', '', 'verification');
  if (source.spec.entries.length !== header.source.entryCount) refuse('ARTIFACT_INVALID', '', 'verification');

  return {
    version: 1,
    jobId: header.jobId,
    handler: header.handler,
    handlerDigest: header.handlerDigest,
    checkId: header.checkId,
    producerNonce: header.producerNonce,
    operationId: header.operationId,
    dispatchId: header.dispatchId,
    generation: header.generation,
    subject: header.subject,
    packetDigest: hash(bytes),
    status: reason === null ? 'passed' : 'failed',
    reason,
    method,
    allocationBytes: quota.used,
    ...(detail !== undefined ? { detail } : {}),
    ...(findings !== undefined ? { findings } : {}),
  };
}
