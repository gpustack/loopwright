import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { admitTask, identifyManifest, isWritablePath, validateDocument, type ArtifactManifest, type ArtifactRef, type Subject } from '@loopwright/core';
import { canonical, digestValue, hash, id, integer, list, record, same, text, type Json } from './schema.js';
import { checkedRef } from './storage.js';
import { parsePrivateJson } from './parser.js';
import { ControllerFailure, refuse } from './errors.js';
export const HEADER_BYTES = 16384, PACKET_BYTES = 1048576, JSON_FILE_BYTES = 1032184, ALLOCATION_BYTES = 8388608;
export type ByteHandler = 'scope.v1' | 'no-change.v1' | 'json-artifact.v1';
export interface ManifestDescriptor { readonly metadataId: string; readonly ref: ArtifactRef; readonly entryCount: number }
export interface VerifierHeader {
  readonly version: 1; readonly jobId: string; readonly handler: ByteHandler; readonly handlerVersion: 1; readonly handlerDigest: import('@loopwright/core').Digest;
  readonly checkId: string; readonly producerNonce: string; readonly operationId: string; readonly dispatchId: string; readonly generation: number;
  readonly subject: Subject; readonly source: ManifestDescriptor; readonly candidate: ManifestDescriptor; readonly parameters: Readonly<Record<string, Json>>; readonly payloadKind: 'inventories' | 'json';
}
export interface VerifierReply {
  readonly version: 1; readonly jobId: string; readonly handler: ByteHandler; readonly handlerDigest: import('@loopwright/core').Digest; readonly checkId: string;
  readonly producerNonce: string; readonly operationId: string; readonly dispatchId: string; readonly generation: number; readonly subject: Subject; readonly packetDigest: import('@loopwright/core').Digest;
  readonly status: 'passed' | 'failed'; readonly reason: null | 'outside_scope' | 'candidate_changed' | 'missing_file' | 'invalid_json' | 'property_missing' | 'property_mismatch';
  readonly method: 'verify_scope' | 'verify_no_change' | 'verify_json'; readonly allocationBytes: number;
}
export class AllocationQuota {
  used = 0;
  charge(length: number): void { integer(length, 0, ALLOCATION_BYTES); this.used += length; if (this.used > ALLOCATION_BYTES) refuse('OUTPUT_LIMIT', '', 'verification'); }
  allocate(length: number): Uint8Array<ArrayBuffer> { this.charge(length); return new Uint8Array(length); }
}
export function ownedBytes(value: Uint8Array, maximum: number): Uint8Array<ArrayBuffer> {
  if (!ArrayBuffer.isView(value) || types.isProxy(value) || ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(value)) || types.isSharedArrayBuffer(value.buffer) || value.byteLength > maximum) refuse('ARTIFACT_INVALID', '', 'verification');
  return new Uint8Array(value);
}
export function fileHash(bytes: Uint8Array) { const digest = createHash('sha256'); for (let offset = 0; offset < bytes.byteLength; offset += 65536) digest.update(bytes.subarray(offset, offset + 65536)); return { algorithm: 'sha256' as const, hex: digest.digest('hex') }; }
export function descriptor(manifest: ArtifactManifest, ref: ArtifactRef): ManifestDescriptor {
  const identified = identifyManifest(manifest), encoded = canonical(manifest);
  if (!identified.ok || Buffer.byteLength(encoded) > 32768 || ref.byteLength !== Buffer.byteLength(encoded) || !same(ref.digest, hash(encoded))) refuse('ARTIFACT_INVALID', '', 'verification');
  return { metadataId: manifest.metadata.id, ref: checkedRef(ref), entryCount: manifest.spec.entries.length };
}
function document(raw: unknown, expected: ManifestDescriptor, quota: AllocationQuota): ArtifactManifest {
  const identified = identifyManifest(raw); if (!identified.ok) refuse('ARTIFACT_INVALID', '', 'verification');
  const manifest = identified.value.manifest, encoded = canonical(manifest), length = Buffer.byteLength(encoded); quota.charge(length);
  if (length > 32768 || manifest.metadata.id !== expected.metadataId || manifest.spec.entries.length !== expected.entryCount || length !== expected.ref.byteLength || !same(hash(encoded), expected.ref.digest)) refuse('ARTIFACT_INVALID', '', 'verification'); return manifest;
}
export function encodeInventory(manifest: ArtifactManifest): Uint8Array<ArrayBuffer> {
  const size = 4 + manifest.spec.entries.reduce((sum, entry) => sum + 42 + Buffer.byteLength(entry.name), 0); if (size > 32772) refuse('OUTPUT_LIMIT', '', 'verification');
  const bytes = new Uint8Array(size), view = new DataView(bytes.buffer); view.setUint32(0, manifest.spec.entries.length); let offset = 4;
  for (const entry of manifest.spec.entries) {
    const length = Buffer.byteLength(entry.name); if (!length || length > 4096) refuse('OUTPUT_LIMIT', '', 'verification');
    view.setUint16(offset, length); offset += 2; Buffer.from(bytes.buffer).write(entry.name, offset, length, 'utf8'); offset += length;
    view.setBigUint64(offset, BigInt(entry.byteLength)); offset += 8;
    for (let index = 0; index < 32; index++) bytes[offset++] = Number.parseInt(entry.digest.hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
function inventory(bytes: Uint8Array, start: number, expected: ManifestDescriptor, quota: AllocationQuota) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let offset = start;
  const take = (length: number): number => { if (offset + length > bytes.byteLength) refuse('ARTIFACT_INVALID', '', 'verification'); const at = offset; offset += length; return at; };
  const count = view.getUint32(take(4)); if (count > 256 || count !== expected.entryCount) refuse('ARTIFACT_INVALID', '', 'verification');
  const entries: ArtifactRef[] = []; let total = 0;
  for (let index = 0; index < count; index++) {
    const length = view.getUint16(take(2)); if (!length || length > 4096) refuse('ARTIFACT_INVALID', '', 'verification');
    const at = take(length); let name: string; try { name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(at, at + length)); } catch { refuse('ARTIFACT_INVALID', '', 'verification'); }
    const wide = view.getBigUint64(take(8)); if (wide > 4194304n || (total += Number(wide)) > 4194304) refuse('ARTIFACT_INVALID', '', 'verification');
    const digestAt = take(32), hex = Buffer.from(bytes.buffer, bytes.byteOffset + digestAt, 32).toString('hex');
    entries.push({ name, byteLength: Number(wide), digest: { algorithm: 'sha256', hex } });
  }
  return { manifest: document({ apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: expected.metadataId }, spec: { entries } }, expected, quota), offset };
}
function checkedDescriptor(raw: unknown): ManifestDescriptor {
  const value = record(raw, ['metadataId', 'ref', 'entryCount']); return { metadataId: id(value.metadataId), ref: checkedRef(value.ref), entryCount: integer(value.entryCount, 0, 256) };
}
export function checkedHeader(raw: unknown): VerifierHeader {
  const value = record(raw, ['version', 'jobId', 'handler', 'handlerVersion', 'handlerDigest', 'checkId', 'producerNonce', 'operationId', 'dispatchId', 'generation', 'subject', 'source', 'candidate', 'parameters', 'payloadKind']);
  if (value.version !== 1 || value.handlerVersion !== 1 || !['scope.v1', 'no-change.v1', 'json-artifact.v1'].includes(text(value.handler)) || !/^[a-f0-9]{32}$/.test(text(value.producerNonce))
    || value.payloadKind !== (value.handler === 'json-artifact.v1' ? 'json' : 'inventories')) refuse('ARTIFACT_INVALID', '', 'verification');
  const subjectCheck = validateDocument({ apiVersion: 'loopwright.dev/v1alpha1', kind: 'Evidence', metadata: { id: 'header' }, spec: { checkId: 'header', observedStatus: 'blocked', producerId: 'header', method: 'header', level: 'local_execution', subject: value.subject, artifacts: [], reason: 'header validation' } }, 'Evidence');
  if (!subjectCheck.ok) refuse('ARTIFACT_INVALID', '', 'verification');
  return { version: 1, jobId: id(value.jobId), handler: value.handler as ByteHandler, handlerVersion: 1, handlerDigest: digestValue(value.handlerDigest), checkId: id(value.checkId), producerNonce: text(value.producerNonce), operationId: id(value.operationId), dispatchId: id(value.dispatchId),
    generation: integer(value.generation, 0, 16), subject: subjectCheck.value.spec.subject, source: checkedDescriptor(value.source), candidate: checkedDescriptor(value.candidate), parameters: value.parameters as VerifierHeader['parameters'], payloadKind: value.payloadKind as VerifierHeader['payloadKind'] };
}
export function packetSize(header: VerifierHeader, payloadBytes: number, maximalFraming = true): number {
  integer(payloadBytes, 0, PACKET_BYTES);
  const sized = maximalFraming ? { ...header, jobId: 'x'.repeat(64), operationId: 'x'.repeat(64), dispatchId: 'x'.repeat(64), generation: 16 } : header;
  if (Buffer.byteLength(canonical(sized)) > HEADER_BYTES) refuse('OUTPUT_LIMIT', '', 'verification');
  const total = 4 + HEADER_BYTES + payloadBytes;
  if (total > PACKET_BYTES || total > 81932 && header.payloadKind === 'inventories') refuse('OUTPUT_LIMIT', '', 'verification'); return total;
}
export function encodePacket(header: VerifierHeader, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const size = packetSize(header, payload.byteLength, false), bytes = new Uint8Array(size), encoded = canonical(header), view = new DataView(bytes.buffer);
  view.setUint32(0, Buffer.byteLength(encoded)); Buffer.from(bytes.buffer).write(encoded, 4, HEADER_BYTES, 'utf8'); bytes.set(payload, 4 + HEADER_BYTES); return bytes;
}
export function evaluatePacket(bytes: Uint8Array): VerifierReply {
  if (!(bytes instanceof Uint8Array) || types.isSharedArrayBuffer(bytes.buffer) || bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength || bytes.byteLength < 16392 || bytes.byteLength > PACKET_BYTES) refuse('ARTIFACT_INVALID', '', 'verification');
  const quota = new AllocationQuota(); quota.charge(bytes.byteLength); const view = new DataView(bytes.buffer), length = view.getUint32(0); if (!length || length > HEADER_BYTES) refuse('ARTIFACT_INVALID', '', 'verification');
  for (let index = 4 + length; index < 4 + HEADER_BYTES; index++) if (bytes[index] !== 0) refuse('ARTIFACT_INVALID', '', 'verification');
  const raw = parsePrivateJson(bytes.subarray(4, 4 + length), HEADER_BYTES, 256), header = checkedHeader(raw); if (canonical(raw) !== canonical(header) || Buffer.byteLength(canonical(raw)) !== length) refuse('ARTIFACT_INVALID', '', 'verification');
  packetSize(header, bytes.byteLength - 4 - HEADER_BYTES, false);
  let reason: VerifierReply['reason'] = null, method: VerifierReply['method'];
  let source: ArtifactManifest, candidate: ArtifactManifest;
  if (header.payloadKind === 'inventories') {
    const first = inventory(bytes, 4 + HEADER_BYTES, header.source, quota), second = inventory(bytes, first.offset, header.candidate, quota);
    if (second.offset !== bytes.byteLength) refuse('ARTIFACT_INVALID', '', 'verification'); source = first.manifest; candidate = second.manifest;
    const allNames = new Set([...source.spec.entries.map(entry => entry.name), ...candidate.spec.entries.map(entry => entry.name)]);
    const changed = [...allNames].filter(name => !same(source.spec.entries.find(entry => entry.name === name) ?? null, candidate.spec.entries.find(entry => entry.name === name) ?? null));
    if (header.handler === 'no-change.v1') { record(header.parameters, []); method = 'verify_no_change'; if (changed.length) reason = 'candidate_changed'; }
    else {
      const parameters = record(header.parameters, ['contract']), contract = validateDocument(parameters.contract, 'TaskContract'); if (!contract.ok) refuse('ARTIFACT_INVALID', '', 'verification');
      const admitted = admitTask(contract.value, { admissionId: 'header', runId: 'header' }); if (!admitted.ok || !same(admitted.value.spec.contractHash, header.subject.contractHash)) refuse('ARTIFACT_INVALID', '', 'verification');
      method = 'verify_scope'; for (const name of changed) { const allowed = isWritablePath(contract.value, name); if (!allowed.ok) refuse('ARTIFACT_INVALID', '', 'verification'); if (!allowed.value) reason = 'outside_scope'; }
    }
  } else {
    const parameters = record(header.parameters, ['path', 'expected', 'required', 'equals', 'sourceManifest', 'candidateManifest']);
    source = document(parameters.sourceManifest, header.source, quota); candidate = document(parameters.candidateManifest, header.candidate, quota);
    const path = text(parameters.path, '', 1024), selected = candidate.spec.entries.find(entry => entry.name === path) ?? null;
    if (!same(parameters.expected, selected)) refuse('ARTIFACT_INVALID', '', 'verification');
    const count = view.getUint32(4 + HEADER_BYTES), offset = 8 + HEADER_BYTES; if (count > JSON_FILE_BYTES || offset + count !== bytes.byteLength) refuse('ARTIFACT_INVALID', '', 'verification');
    method = 'verify_json';
    if (selected === null) { if (count !== 0) refuse('ARTIFACT_INVALID', '', 'verification'); reason = 'missing_file'; }
    else {
      if (count !== selected.byteLength || !same(fileHash(bytes.subarray(offset)), selected.digest)) refuse('ARTIFACT_INVALID', '', 'verification');
      const required = list(parameters.required, '', 128).map(item => text(item, '', 128)), equals = parameters.equals;
      if (equals === null || typeof equals !== 'object' || Array.isArray(equals) || Object.keys(equals).length > 128 || Object.values(equals).some(value => value !== null && !['string', 'boolean', 'number'].includes(typeof value))) refuse('ARTIFACT_INVALID', '', 'verification');
      let value: Json | undefined; try { value = parsePrivateJson(bytes.subarray(offset), JSON_FILE_BYTES, 128); } catch (error) { if (!(error instanceof ControllerFailure)) throw error; reason = 'invalid_json'; }
      if (reason === null) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) reason = 'invalid_json';
        else {
          const object = value as Readonly<Record<string, Json>>;
          if (required.some(key => !Object.hasOwn(object, key))) reason = 'property_missing';
          else if (Object.entries(equals).some(([key, expected]) => !Object.hasOwn(object, key) || !same(object[key], expected))) reason = 'property_mismatch';
        }
      }
    }
  }
  const identified = identifyManifest(candidate); if (!identified.ok || !same(identified.value.digest, header.subject.candidateDigest)) refuse('ARTIFACT_INVALID', '', 'verification');
  // Both manifests have been independently validated; source is deliberately retained through this point.
  if (source.spec.entries.length !== header.source.entryCount) refuse('ARTIFACT_INVALID', '', 'verification');
  return { version: 1, jobId: header.jobId, handler: header.handler, handlerDigest: header.handlerDigest, checkId: header.checkId, producerNonce: header.producerNonce, operationId: header.operationId, dispatchId: header.dispatchId, generation: header.generation, subject: header.subject,
    packetDigest: hash(bytes), status: reason === null ? 'passed' : 'failed', reason, method, allocationBytes: quota.used };
}
