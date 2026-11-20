import type { ArtifactManifest, ArtifactRef, Digest, Subject, TaskLock } from '@loopwright/core';
import { bindSubject } from '@loopwright/core';
import { ControllerFailure, refuse } from './errors.js';
import { checkedRef } from './storage.js';
import { canonical, digestValue, freeze, hash, id, integer, record, same } from './schema.js';
import {
  HEADER_BYTES,
  JSON_FILE_BYTES,
  maxPacketBytes,
  overlayProtocolBounds,
  type ManifestDescriptor,
  type VerifierHeader,
} from './verifier-protocol.js';
import type { CompiledPlan, VerifierRefusalRow } from './types.js';

export interface SizingDescription {
  readonly reason: 'header_bytes' | 'json_file_bytes' | 'inventory_bytes' | 'packet_bytes' | 'tree_proof_bytes' | 'tree_proof_depth';
  readonly actual: number;
  readonly allowed: number;
  readonly headerBytes: number;
  readonly payloadBytes: number;
  readonly packetBytes: number;
}

/** Created only by complete, pure job sizing after original byte validation. Never a general OUTPUT_LIMIT catch. */
export class VerifierSizingFailure extends ControllerFailure {
  constructor(readonly sizing: SizingDescription) {
    super({ version: 1, code: 'OUTPUT_LIMIT', phase: 'verification', path: '', stateCode: null, piCode: null, effect: 'none', retryable: false });
  }
}

export function sizeJob(
  header: VerifierHeader,
  payloadBytes: number,
  jsonBytes: number | null,
  merkle?: { readonly treeCount: number; readonly treeProofBytes: number },
  inventoryBytes?: { readonly firstBytes: number; readonly secondBytes: number },
): void {
  integer(payloadBytes, 0, Number.MAX_SAFE_INTEGER);
  const headerBytes = Buffer.byteLength(
    canonical({ ...header, jobId: 'x'.repeat(64), operationId: 'x'.repeat(64), dispatchId: 'x'.repeat(64), generation: 256 }),
  );
  const packetBytes = 4 + HEADER_BYTES + payloadBytes;
  const bounds = overlayProtocolBounds(header.overlay);
  const limit = maxPacketBytes(header);
  const maxInvActual = inventoryBytes !== undefined ? Math.max(inventoryBytes.firstBytes, inventoryBytes.secondBytes) : 0;
  const refusal: SizingDescription | null =
    jsonBytes !== null && jsonBytes > JSON_FILE_BYTES
      ? {
          reason: 'json_file_bytes',
          actual: jsonBytes,
          allowed: JSON_FILE_BYTES,
          headerBytes,
          payloadBytes: 4 + jsonBytes,
          packetBytes: 4 + HEADER_BYTES + 4 + jsonBytes,
        }
      : headerBytes > HEADER_BYTES
        ? { reason: 'header_bytes', actual: headerBytes, allowed: HEADER_BYTES, headerBytes, payloadBytes, packetBytes }
        : inventoryBytes !== undefined && maxInvActual > bounds.inventoryMaxBytes
          ? { reason: 'inventory_bytes', actual: maxInvActual, allowed: bounds.inventoryMaxBytes, headerBytes, payloadBytes, packetBytes }
          : merkle !== undefined && merkle.treeCount > 16
            ? { reason: 'tree_proof_depth', actual: merkle.treeCount, allowed: 16, headerBytes, payloadBytes, packetBytes }
            : merkle !== undefined && merkle.treeProofBytes > 262_144
              ? { reason: 'tree_proof_bytes', actual: merkle.treeProofBytes, allowed: 262_144, headerBytes, payloadBytes, packetBytes }
              : packetBytes > limit
                ? { reason: 'packet_bytes', actual: packetBytes, allowed: limit, headerBytes, payloadBytes, packetBytes }
                : null;
  if (refusal) throw new VerifierSizingFailure(freeze(refusal));
}

export interface RefusalRecord {
  readonly version: 1;
  readonly kind: 'controller_preflight_refusal';
  readonly planDigest: Digest;
  readonly handlerDigest: Digest;
  readonly slotId: string;
  readonly checkId: string;
  readonly generation: number;
  readonly prospectiveOperationId: string;
  readonly producerNonce: string;
  readonly subject: Subject;
  readonly source: ManifestDescriptor;
  readonly candidate: ManifestDescriptor;
  readonly code: 'OUTPUT_LIMIT';
  readonly limits: SizingDescription;
}

function checkedDescriptor(input: unknown, maxEntries: number): ManifestDescriptor {
  const value = record(input, ['metadataId', 'ref', 'entryCount']);
  return { metadataId: id(value.metadataId), ref: checkedRef(value.ref), entryCount: integer(value.entryCount, 0, maxEntries) };
}

const PROBE_MANIFEST: ArtifactManifest = Object.freeze({
  apiVersion: 'loopwright.dev/v1alpha1',
  kind: 'ArtifactManifest',
  metadata: Object.freeze({ id: 'probe' }),
  spec: Object.freeze({ entries: Object.freeze([]) }),
});

export function checkedRefusalSubject(input: unknown, lock: TaskLock): Subject {
  const value = record(input, ['lockHash', 'contractHash', 'repository', 'baseRevision', 'sourceRevision', 'candidateDigest', 'targetMatrixDigest']);
  const contract = lock.spec.contract;
  const target = contract.spec.target;
  if (contract.spec.acceptance.checks.some(check => check.allowedEvidenceLevels.includes('hardware_execution'))) {
    refuse('RECOVERY_REQUIRED', '', 'recovery');
  }
  const probe = bindSubject(lock, PROBE_MANIFEST);
  if (!probe.ok) refuse('RECOVERY_REQUIRED', '', 'recovery');
  if (value.targetMatrixDigest !== null) digestValue(value.targetMatrixDigest);
  if (
    !same(value.lockHash, lock.spec.lockHash) ||
    !same(value.contractHash, lock.spec.contractHash) ||
    value.repository !== target.repository ||
    value.baseRevision !== target.baseRevision ||
    value.sourceRevision !== target.sourceRevision ||
    !same(value.targetMatrixDigest, probe.value.targetMatrixDigest)
  ) {
    refuse('RECOVERY_REQUIRED', '', 'recovery');
  }
  digestValue(value.candidateDigest);
  return input as Subject;
}

const MAX_REFUSAL_METRIC = 1_073_741_824;

export function checkedRefusalRecord(input: unknown, plan: CompiledPlan, lock: TaskLock, row: VerifierRefusalRow): RefusalRecord {
  const value = record(input, [
    'version', 'kind', 'planDigest', 'handlerDigest', 'slotId', 'checkId',
    'generation', 'prospectiveOperationId', 'producerNonce', 'subject', 'source', 'candidate', 'code', 'limits',
  ]);
  const slot = plan.verifierSlots.find(s => s.id === row.slot);
  const limits = record(value.limits, ['reason', 'actual', 'allowed', 'headerBytes', 'payloadBytes', 'packetBytes']);
  for (const key of ['actual', 'allowed', 'headerBytes', 'payloadBytes', 'packetBytes']) {
    integer(limits[key], 0, MAX_REFUSAL_METRIC);
  }
  const overlay = lock.spec.contract.spec.budgets.overlay;
  const bounds = overlayProtocolBounds(overlay);
  const impl = slot?.handler.implementation;
  const isFileHandler = impl === 'json-artifact.v1' || impl === 'json-keys-guard.v1' || impl === 'line-section-guard.v1';
  const payloadKind: VerifierHeader['payloadKind'] =
    impl === 'json-artifact.v1' ? 'json' : impl === 'json-keys-guard.v1' || impl === 'line-section-guard.v1' ? 'guard' : 'inventories';
  const packetAllowed = maxPacketBytes({ payloadKind, ...(overlay ? { overlay } : {}) });

  const expectedAllowed =
    limits.reason === 'json_file_bytes'
      ? JSON_FILE_BYTES
      : limits.reason === 'header_bytes'
        ? HEADER_BYTES
        : limits.reason === 'inventory_bytes'
          ? bounds.inventoryMaxBytes
          : limits.reason === 'tree_proof_bytes'
            ? 262_144
            : limits.reason === 'tree_proof_depth'
              ? 16
              : limits.reason === 'packet_bytes'
                ? packetAllowed
                : -1;

  if (
    !slot ||
    value.version !== 1 ||
    value.kind !== 'controller_preflight_refusal' ||
    value.code !== 'OUTPUT_LIMIT' ||
    limits.allowed !== expectedAllowed ||
    (limits.actual as number) <= expectedAllowed ||
    limits.packetBytes !== 4 + HEADER_BYTES + (limits.payloadBytes as number) ||
    (limits.reason === 'json_file_bytes' && (!isFileHandler || limits.actual !== (limits.payloadBytes as number) - 4)) ||
    (limits.reason === 'header_bytes' && limits.actual !== limits.headerBytes) ||
    (limits.reason === 'packet_bytes' && limits.actual !== limits.packetBytes) ||
    ((limits.reason === 'tree_proof_bytes' || limits.reason === 'tree_proof_depth') && !isFileHandler) ||
    !same(value.planDigest, plan.planDigest) ||
    !same(value.handlerDigest, slot.handler.digest) ||
    value.slotId !== row.slot ||
    value.checkId !== slot.checkId ||
    value.generation !== row.generation ||
    value.prospectiveOperationId !== row.prospectiveOperationId ||
    value.producerNonce !== row.producerNonce ||
    !same(value.subject, row.subject) ||
    !same(row.subject.lockHash, lock.spec.lockHash) ||
    !same(row.subject.contractHash, lock.spec.contractHash)
  ) {
    refuse('RECOVERY_REQUIRED', '', 'recovery');
  }
  checkedRefusalSubject(value.subject, lock);
  digestValue(value.planDigest);
  digestValue(value.handlerDigest);
  checkedDescriptor(value.source, bounds.maxManifestEntries);
  checkedDescriptor(value.candidate, bounds.maxManifestEntries);
  return input as RefusalRecord;
}

export function refusalSubject(
  lock: TaskLock,
  manifest: ArtifactManifest,
  row: VerifierRefusalRow,
  recordVal: RefusalRecord,
  sourceRef: ArtifactRef,
  candidateRef: ArtifactRef,
  sourceManifest: ArtifactManifest,
): void {
  const overlayOpts = lock.spec.contract.spec.budgets.overlay ? { overlay: lock.spec.contract.spec.budgets.overlay } : undefined;
  const subject = bindSubject(lock, manifest, overlayOpts);
  if (
    !subject.ok ||
    !same(subject.value, row.subject) ||
    !same(recordVal.subject, row.subject) ||
    !same(recordVal.source.ref, sourceRef) ||
    !same(recordVal.candidate.ref, candidateRef) ||
    recordVal.source.metadataId !== sourceManifest.metadata.id ||
    recordVal.source.entryCount !== sourceManifest.spec.entries.length ||
    recordVal.candidate.metadataId !== manifest.metadata.id ||
    recordVal.candidate.entryCount !== manifest.spec.entries.length ||
    recordVal.candidate.ref.byteLength !== Buffer.byteLength(canonical(manifest)) ||
    !same(recordVal.candidate.ref.digest, hash(canonical(manifest)))
  ) {
    refuse('RECOVERY_REQUIRED', '', 'recovery');
  }
}
