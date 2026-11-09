import type { ArtifactManifest, ArtifactRef, Digest, Subject, TaskLock } from '@loopwright/core';
import { bindSubject } from '@loopwright/core';
import { ControllerFailure, refuse } from './errors.js';
import { checkedRef } from './storage.js';
import { canonical, digestValue, freeze, hash, id, integer, record, same } from './schema.js';
import { HEADER_BYTES, JSON_FILE_BYTES, PACKET_BYTES, type ManifestDescriptor, type VerifierHeader } from './verifier-protocol.js';
import type { CompiledPlan, VerifierRefusalRow } from './types.js';
export interface SizingDescription {
  readonly reason: 'json_file_bytes' | 'header_bytes' | 'packet_bytes'; readonly actual: number; readonly allowed: number;
  readonly headerBytes: number; readonly payloadBytes: number; readonly packetBytes: number;
}
/** Created only by complete, pure job sizing after original byte validation. Never a general OUTPUT_LIMIT catch. */
export class VerifierSizingFailure extends ControllerFailure {
  constructor(readonly sizing: SizingDescription) { super({ version: 1, code: 'OUTPUT_LIMIT', phase: 'verification', path: '', stateCode: null, piCode: null, effect: 'none', retryable: false }); }
}
export function sizeJob(header: VerifierHeader, payloadBytes: number, jsonBytes: number | null): void {
  integer(payloadBytes, 0, 4194308);
  const headerBytes = Buffer.byteLength(canonical({ ...header, jobId: 'x'.repeat(64), operationId: 'x'.repeat(64), dispatchId: 'x'.repeat(64), generation: 16 })), packetBytes = 4 + HEADER_BYTES + payloadBytes;
  const limit = header.payloadKind === 'inventories' ? 81932 : PACKET_BYTES;
  const refusal: SizingDescription | null = jsonBytes !== null && jsonBytes > JSON_FILE_BYTES ? { reason: 'json_file_bytes', actual: jsonBytes, allowed: JSON_FILE_BYTES, headerBytes, payloadBytes, packetBytes }
    : headerBytes > HEADER_BYTES ? { reason: 'header_bytes', actual: headerBytes, allowed: HEADER_BYTES, headerBytes, payloadBytes, packetBytes }
    : packetBytes > limit ? { reason: 'packet_bytes', actual: packetBytes, allowed: limit, headerBytes, payloadBytes, packetBytes } : null;
  if (refusal) throw new VerifierSizingFailure(freeze(refusal));
}
export interface RefusalRecord {
  readonly version: 1; readonly kind: 'controller_preflight_refusal'; readonly planDigest: Digest; readonly handlerDigest: Digest;
  readonly slotId: string; readonly checkId: string; readonly generation: number; readonly prospectiveOperationId: string; readonly producerNonce: string;
  readonly subject: Subject; readonly source: ManifestDescriptor; readonly candidate: ManifestDescriptor; readonly code: 'OUTPUT_LIMIT'; readonly limits: SizingDescription;
}
function checkedDescriptor(input: unknown): ManifestDescriptor {
  const value = record(input, ['metadataId', 'ref', 'entryCount']); return { metadataId: id(value.metadataId), ref: checkedRef(value.ref), entryCount: integer(value.entryCount, 0, 256) };
}
export function checkedRefusalSubject(input: unknown, lock: TaskLock): Subject {
  const value = record(input, ['lockHash', 'contractHash', 'repository', 'baseRevision', 'sourceRevision', 'candidateDigest', 'targetMatrixDigest']);
  const target = lock.spec.contract.spec.target;
  if (!same(value.lockHash, lock.spec.lockHash) || !same(value.contractHash, lock.spec.contractHash) || value.repository !== target.repository || value.baseRevision !== target.baseRevision || value.sourceRevision !== target.sourceRevision || value.targetMatrixDigest !== null) refuse('RECOVERY_REQUIRED', '', 'recovery');
  digestValue(value.candidateDigest); return input as Subject;
}
export function checkedRefusalRecord(input: unknown, plan: CompiledPlan, lock: TaskLock, row: VerifierRefusalRow): RefusalRecord {
  const value = record(input, ['version', 'kind', 'planDigest', 'handlerDigest', 'slotId', 'checkId', 'generation', 'prospectiveOperationId', 'producerNonce', 'subject', 'source', 'candidate', 'code', 'limits']);
  const slot = plan.verifierSlots.find(slot => slot.id === row.slot), limits = record(value.limits, ['reason', 'actual', 'allowed', 'headerBytes', 'payloadBytes', 'packetBytes']);
  for (const key of ['actual', 'allowed', 'headerBytes', 'payloadBytes', 'packetBytes']) integer(limits[key], 0, 8388608);
  const expectedAllowed = limits.reason === 'json_file_bytes' ? JSON_FILE_BYTES : limits.reason === 'header_bytes' ? HEADER_BYTES : limits.reason === 'packet_bytes' ? slot?.handler.implementation === 'json-artifact.v1' ? PACKET_BYTES : 81932 : -1;
  if (!slot || value.version !== 1 || value.kind !== 'controller_preflight_refusal' || value.code !== 'OUTPUT_LIMIT' || limits.allowed !== expectedAllowed || (limits.actual as number) <= expectedAllowed
    || limits.packetBytes !== 4 + HEADER_BYTES + (limits.payloadBytes as number) || limits.reason === 'json_file_bytes' && (slot.handler.implementation !== 'json-artifact.v1' || limits.actual !== (limits.payloadBytes as number) - 4)
    || limits.reason === 'header_bytes' && limits.actual !== limits.headerBytes || limits.reason === 'packet_bytes' && limits.actual !== limits.packetBytes
    || !same(value.planDigest, plan.planDigest) || !same(value.handlerDigest, slot.handler.digest) || value.slotId !== row.slot || value.checkId !== slot.checkId || value.generation !== row.generation
    || value.prospectiveOperationId !== row.prospectiveOperationId || value.producerNonce !== row.producerNonce || !same(value.subject, row.subject) || !same(row.subject.lockHash, lock.spec.lockHash) || !same(row.subject.contractHash, lock.spec.contractHash)) refuse('RECOVERY_REQUIRED', '', 'recovery');
  digestValue(value.planDigest); digestValue(value.handlerDigest);
  checkedDescriptor(value.source); checkedDescriptor(value.candidate); return input as RefusalRecord;
}
export function refusalSubject(lock: TaskLock, manifest: ArtifactManifest, row: VerifierRefusalRow, record: RefusalRecord, sourceRef: ArtifactRef, candidateRef: ArtifactRef, sourceManifest: ArtifactManifest): void {
  const subject = bindSubject(lock, manifest);
  if (!subject.ok || !same(subject.value, row.subject) || !same(record.subject, row.subject) || !same(record.source.ref, sourceRef) || !same(record.candidate.ref, candidateRef)
    || record.source.metadataId !== sourceManifest.metadata.id || record.source.entryCount !== sourceManifest.spec.entries.length || record.candidate.metadataId !== manifest.metadata.id || record.candidate.entryCount !== manifest.spec.entries.length
    || record.candidate.ref.byteLength !== Buffer.byteLength(canonical(manifest)) || !same(record.candidate.ref.digest, hash(canonical(manifest)))) refuse('RECOVERY_REQUIRED', '', 'recovery');
}
