import { Worker } from 'node:worker_threads';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bindSubject,
  digestArtifact,
  validateDocument,
  type ArtifactManifest,
  type ArtifactRef,
  type BaseTreeAnchor,
  type Digest,
  type Evidence,
  type MetricsMap,
  type OverlayLimitsInput,
  type StructuredFinding,
  type Subject,
  type TaskLock,
} from '@loopwright/core';
import type { Authority, DispatchPermit, LocalRunStore, OperationReceipt } from '@loopwright/state';
import { ArtifactStore, checkedRef, stateValue } from './storage.js';
import { readBoundedFile } from './files.js';
import {
  descriptor,
  encodeInventory,
  encodePacket,
  EVOLVE_BLOCK_LIMITS,
  fileHash,
  inventoryEncodedBytes,
  isValidEvolveBlockId,
  isValidEvolveGuardPath,
  JSON_FILE_BYTES,
  maxPacketBytes,
  overlayProtocolBounds,
  ownedBytes,
  packetSize,
  checkedHeader,
  HEADER_BYTES,
  RFC6901_POINTER_PATTERN,
  type VerifierHeader,
  type VerifierReply,
  type ByteHandler,
  type VerifierMethod,
  type VerifierReason,
} from './verifier-protocol.js';
import { checkedDetail, checkedFindings, checkedMetrics } from './gate.js';
import type { BaselineMerkleProof } from './source.js';
import { canonical, freeze, hash, integer, isRecord, list, record, same, text } from './schema.js';
import { parsePrivateJson } from './parser.js';
import { ControllerFailure, refuse } from './errors.js';
import { verifierOperationId, phaseCheckpointId, ProgressStore, validateProgress, journal } from './progress.js';
import { sizeJob, VerifierSizingFailure, checkedRefusalRecord, type RefusalRecord } from './refusal-record.js';
import type { CandidateFileEntry, CompiledPlan, VerifierSlot, VerifierRefusalRow } from './types.js';

export interface ByteInventory {
  readonly manifest: ArtifactManifest;
  readonly ref: ArtifactRef;
  readonly files: readonly CandidateFileEntry[];
  readonly baselineProofs?: Readonly<Record<string, BaselineMerkleProof>> | undefined;
}

export interface PreparedVerification {
  readonly version: 1;
  readonly slotId: string;
  readonly generation: number;
  readonly operationId: string;
  readonly producerNonce: string;
  readonly packetBytes: number;
  readonly requestDigest: import('@loopwright/core').Digest;
}

interface Prepared {
  readonly header: VerifierHeader;
  readonly payload: Uint8Array;
  readonly slot: VerifierSlot;
}

const preparedJobs = new WeakMap<PreparedVerification, Prepared>();

function validateInventoryAlignment(input: ByteInventory, overlay?: OverlayLimitsInput): ReadonlyMap<string, CandidateFileEntry> {
  const bounds = overlayProtocolBounds(overlay);
  descriptor(input.manifest, input.ref, overlay);
  const maxEntries = input.manifest.spec.baseTree !== undefined ? bounds.maxOverlayEntries : bounds.maxClassicEntries;
  if (
    input.files.length !== input.manifest.spec.entries.length ||
    input.files.length > maxEntries
  ) {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
  const byName = new Map<string, CandidateFileEntry>();
  for (const file of input.files) {
    if (byName.has(file.name)) refuse('ARTIFACT_INVALID', '', 'verification');
    byName.set(file.name, file);
  }
  let total = 0;
  const validated = new Map<string, CandidateFileEntry>();
  for (const entry of input.manifest.spec.entries) {
    const file = byName.get(entry.name);
    if (!file || (total += entry.byteLength) > bounds.maxTotalBytes) refuse('ARTIFACT_INVALID', '', 'verification');
    if ('bytes' in file) {
      if ('blobPath' in file) refuse('ARTIFACT_INVALID', '', 'verification');
      const bytes = ownedBytes(file.bytes, bounds.maxTotalBytes);
      if (bytes.byteLength !== entry.byteLength || !same(fileHash(bytes), entry.digest)) refuse('ARTIFACT_INVALID', '', 'verification');
      validated.set(entry.name, { name: entry.name, bytes });
    } else {
      if (
        typeof file.blobPath !== 'string' ||
        !isAbsolute(file.blobPath) ||
        file.blobPath.length > 4096 ||
        /[\0\r\n]/.test(file.blobPath) ||
        file.byteLength !== entry.byteLength ||
        !same(file.digest, entry.digest)
      ) {
        refuse('ARTIFACT_INVALID', '', 'verification');
      }
      validated.set(entry.name, file);
    }
  }
  return validated;
}

function resolveTargetOverlayFileSync(file: CandidateFileEntry): { readonly logicalBytes: number; readonly bytes: Uint8Array | null } {
  if ('bytes' in file) {
    return {
      logicalBytes: file.bytes.byteLength,
      bytes: file.bytes.byteLength > JSON_FILE_BYTES ? null : file.bytes,
    };
  }
  if (file.byteLength > JSON_FILE_BYTES) {
    return { logicalBytes: file.byteLength, bytes: null };
  }
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(file.blobPath);
  } catch {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1 ||
    before.uid !== process.getuid?.() ||
    (before.mode & 0o222) !== 0 ||
    before.size !== file.byteLength
  ) {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
  let fd: number;
  try {
    fd = openSync(file.blobPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.dev !== before.dev ||
      info.ino !== before.ino ||
      info.size !== file.byteLength ||
      (info.mode & 0o222) !== 0
    ) {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }
    const raw = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < raw.length) {
      const bytesRead = readSync(fd, raw, offset, raw.length - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    const after = fstatSync(fd);
    if (
      offset !== info.size ||
      after.nlink !== 1 ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs
    ) {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }
    const slice = new Uint8Array(raw.buffer, raw.byteOffset, offset);
    if (!same(fileHash(slice), file.digest)) refuse('ARTIFACT_INVALID', '', 'verification');
    return { logicalBytes: slice.byteLength, bytes: slice };
  } finally {
    closeSync(fd);
  }
}

interface ValidatedProof {
  readonly mode: '100644' | '100755';
  readonly oid: string;
  readonly byteLength: number;
  readonly blob: Uint8Array;
  readonly trees: readonly Uint8Array[];
  readonly merkle: { readonly treeCount: number; readonly treeProofBytes: number };
  readonly logicalBytes: number;
}

function validateBaselineProof(proof: BaselineMerkleProof, baseTree: BaseTreeAnchor): ValidatedProof {
  const blobBytes = ownedBytes(proof.blob, 8_388_608);
  const treeBytes = proof.trees.map(tree => ownedBytes(tree, 4_194_304));
  const oidPattern = baseTree.objectFormat === 'sha256' ? /^[0-9a-f]{64}$/ : /^[0-9a-f]{40}$/;
  if (!Number.isSafeInteger(proof.byteLength) || proof.byteLength < 0 || !oidPattern.test(proof.oid)) {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
  if (proof.mode !== '100644' && proof.mode !== '100755') refuse('ARTIFACT_INVALID', '', 'verification');
  if (proof.treeCount !== undefined && (!Number.isSafeInteger(proof.treeCount) || proof.treeCount < 0)) {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
  if (proof.treeProofBytes !== undefined && (!Number.isSafeInteger(proof.treeProofBytes) || proof.treeProofBytes < 0)) {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
  const treeCount = proof.treeCount ?? treeBytes.length;
  const treeProofBytes = proof.treeProofBytes ?? treeBytes.reduce((sum, tree) => sum + tree.byteLength, 0);
  const isOversizeProof = treeCount > 16 || treeProofBytes > 262_144 || proof.byteLength > 4_194_304;
  if (!isOversizeProof && blobBytes.byteLength !== proof.byteLength) refuse('ARTIFACT_INVALID', '', 'verification');
  return {
    mode: proof.mode,
    oid: proof.oid,
    byteLength: proof.byteLength,
    blob: blobBytes,
    trees: treeBytes,
    merkle: { treeCount, treeProofBytes },
    logicalBytes: proof.byteLength > blobBytes.byteLength ? proof.byteLength : blobBytes.byteLength,
  };
}

function writeProofSection(payload: Uint8Array, view: DataView, startOffset: number, proof: ValidatedProof): number {
  let offset = startOffset;
  view.setUint32(offset, proof.blob.byteLength);
  offset += 4;
  payload.set(proof.blob, offset);
  offset += proof.blob.byteLength;
  view.setUint32(offset, proof.trees.length);
  offset += 4;
  for (const tree of proof.trees) {
    view.setUint32(offset, tree.byteLength);
    offset += 4;
    payload.set(tree, offset);
    offset += tree.byteLength;
  }
  return offset;
}

export function verifierProofPaths(slots: readonly VerifierSlot[]): readonly string[] {
  const paths: string[] = [];
  for (const slot of slots) {
    const impl = slot.handler.implementation;
    if (impl === 'json-artifact.v1' || impl === 'json-keys-guard.v1' || impl === 'line-section-guard.v1') {
      paths.push(text(slot.handler.parameters.path));
    } else if (impl === 'evolve-block-guard.v1') {
      for (const item of list(slot.handler.parameters.files, '', EVOLVE_BLOCK_LIMITS.maxFiles)) {
        paths.push(text(item, '', 1024));
      }
    }
  }
  return [...new Set(paths)];
}

/** Pure byte preflight: no owner, state intent, Worker, timer, credential or network operation. */
export function prepareVerification(
  plan: CompiledPlan,
  lock: TaskLock,
  slotId: string,
  source: ByteInventory,
  candidate: ByteInventory,
  generation: number,
  producerNonce: string,
): PreparedVerification {
  if (!same(plan.task, lock.spec.contract) || !/^[a-f0-9]{32}$/.test(producerNonce)) refuse('ARTIFACT_INVALID', '', 'verification');
  integer(generation, 0, plan.capacity.V - 1);
  const slot = plan.verifierSlots.find(item => item.id === slotId);
  if (!slot || slot.handler.kind !== 'check') refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
  const overlay = lock.spec.contract.spec.budgets.overlay;
  const overlayOpts = overlay ? { overlay } : undefined;
  const sourceFiles = validateInventoryAlignment(source, overlay);
  const files = validateInventoryAlignment(candidate, overlay);
  const subject = bindSubject(lock, candidate.manifest, overlayOpts);
  if (!subject.ok) refuse('ARTIFACT_INVALID', '', 'verification');
  if (
    (source.manifest.spec.baseTree === undefined) !== (candidate.manifest.spec.baseTree === undefined) ||
    !same(source.manifest.spec.baseTree ?? null, candidate.manifest.spec.baseTree ?? null)
  ) {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }

  const operationId = verifierOperationId(lock.spec.runId, slotId, generation);
  const handler = slot.handler.implementation as ByteHandler;
  const firstInvBytes = inventoryEncodedBytes(source.manifest);
  const secondInvBytes = inventoryEncodedBytes(candidate.manifest);
  const invSizing = { firstBytes: firstInvBytes, secondBytes: secondInvBytes };

  let parameters: VerifierHeader['parameters'];
  let payload: Uint8Array;
  let payloadKind: VerifierHeader['payloadKind'];
  let jsonBytes: number;
  let merkle: { readonly treeCount: number; readonly treeProofBytes: number } | undefined;

  if (handler === 'json-artifact.v1') {
    payloadKind = 'json';
    const path = text(slot.handler.parameters.path);
    const overlaySelected = candidate.manifest.spec.entries.find(entry => entry.name === path) ?? null;
    const baseTree = candidate.manifest.spec.baseTree;
    const isDeleted = (candidate.manifest.spec.deleted ?? []).includes(path);
    const rawProof =
      !overlaySelected && !isDeleted && baseTree !== undefined && source.baselineProofs && Object.hasOwn(source.baselineProofs, path)
        ? source.baselineProofs[path] ?? null
        : null;

    let expected: unknown = overlaySelected;
    let selected: Uint8Array | null | undefined;
    let validatedProof: ValidatedProof | null = null;

    if (baseTree !== undefined && !overlaySelected) {
      if (isDeleted || rawProof === null) {
        expected = null;
        jsonBytes = 0;
      } else {
        validatedProof = validateBaselineProof(rawProof, baseTree);
        expected = { baseline: true, mode: validatedProof.mode, oid: validatedProof.oid, byteLength: validatedProof.byteLength };
        jsonBytes = validatedProof.logicalBytes;
        merkle = validatedProof.merkle;
      }
    } else if (overlaySelected) {
      const resolved = resolveTargetOverlayFileSync(files.get(path)!);
      selected = resolved.bytes;
      jsonBytes = resolved.logicalBytes;
    } else {
      selected = undefined;
      jsonBytes = 0;
    }

    parameters = {
      path,
      expected,
      required: slot.handler.parameters.required,
      equals: slot.handler.parameters.equals,
    } as unknown as VerifierHeader['parameters'];

    const targetBytes =
      validatedProof !== null
        ? 4 + validatedProof.blob.byteLength + 4 + validatedProof.trees.reduce((sum, tree) => sum + 4 + tree.byteLength, 0)
        : 4 + jsonBytes;
    const sizedPayloadBytes = firstInvBytes + secondInvBytes + targetBytes;
    const header = checkedHeader({
      version: 1,
      jobId: 'job.' + hash(operationId + '\0' + producerNonce).hex.slice(0, 40),
      handler,
      handlerVersion: 1,
      handlerDigest: slot.handler.digest,
      checkId: slot.checkId,
      producerNonce,
      operationId,
      dispatchId: 'unbound',
      generation,
      subject: subject.value,
      source: descriptor(source.manifest, source.ref, overlay),
      candidate: descriptor(candidate.manifest, candidate.ref, overlay),
      parameters,
      payloadKind,
      ...(overlay !== undefined ? { overlay } : {}),
    });
    sizeJob(header, sizedPayloadBytes, jsonBytes, merkle, invSizing);

    const firstInv = encodeInventory(source.manifest, overlay);
    const secondInv = encodeInventory(candidate.manifest, overlay);
    payload = new Uint8Array(sizedPayloadBytes);
    const view = new DataView(payload.buffer);
    let offset = 0;
    payload.set(firstInv, offset);
    offset += firstInv.byteLength;
    payload.set(secondInv, offset);
    offset += secondInv.byteLength;
    if (validatedProof !== null) {
      writeProofSection(payload, view, offset, validatedProof);
    } else {
      view.setUint32(offset, selected?.byteLength ?? 0);
      offset += 4;
      if (selected) payload.set(selected, offset);
    }

    const packetBytes = packetSize(header, payload.byteLength);
    const requestDigest = hash('loopwright.dev/controller/verifier-request/v1\0' + canonical({ planDigest: plan.planDigest, header, payloadDigest: hash(payload) }));
    const sealed = freeze(checkedHeader(parsePrivateJson(Buffer.from(canonical(header)), HEADER_BYTES)));
    const value: PreparedVerification = freeze({ version: 1, slotId, generation, operationId, producerNonce, packetBytes, requestDigest });
    preparedJobs.set(value, { header: sealed, payload, slot });
    return value;
  }

  if (handler === 'json-keys-guard.v1' || handler === 'line-section-guard.v1') {
    payloadKind = 'guard';
    const path = text(slot.handler.parameters.path);
    const baseTree = candidate.manifest.spec.baseTree;
    const sourceSelected = source.manifest.spec.entries.find(entry => entry.name === path) ?? null;
    const sourceDeleted = (source.manifest.spec.deleted ?? []).includes(path);
    const candSelected = candidate.manifest.spec.entries.find(entry => entry.name === path) ?? null;
    const candDeleted = (candidate.manifest.spec.deleted ?? []).includes(path);

    let baselineParam: Record<string, unknown>;
    let baseOverlayBytes: Uint8Array | null | undefined;
    let hasBaseOverlay = false;
    let validatedProof: ValidatedProof | null = null;
    let baseLogicalBytes = 0;

    if (!baseTree) {
      if (sourceSelected !== null) {
        const resolved = resolveTargetOverlayFileSync(sourceFiles.get(path)!);
        baseOverlayBytes = resolved.bytes;
        hasBaseOverlay = true;
        baselineParam = { kind: 'overlay', entry: sourceSelected };
        baseLogicalBytes = resolved.logicalBytes;
      } else {
        baselineParam = { kind: 'missing' };
      }
    } else if (sourceSelected !== null) {
      const resolved = resolveTargetOverlayFileSync(sourceFiles.get(path)!);
      baseOverlayBytes = resolved.bytes;
      hasBaseOverlay = true;
      baselineParam = { kind: 'overlay', entry: sourceSelected };
      baseLogicalBytes = resolved.logicalBytes;
    } else if (sourceDeleted) {
      baselineParam = { kind: 'missing' };
    } else {
      const rawProof = source.baselineProofs && Object.hasOwn(source.baselineProofs, path) ? source.baselineProofs[path] ?? null : null;
      if (rawProof === null) {
        baselineParam = { kind: 'missing' };
      } else {
        validatedProof = validateBaselineProof(rawProof, source.manifest.spec.baseTree!);
        baselineParam = { kind: 'merkle_blob', mode: validatedProof.mode, oid: validatedProof.oid, byteLength: validatedProof.byteLength };
        baseLogicalBytes = validatedProof.logicalBytes;
        merkle = validatedProof.merkle;
      }
    }

    let candidateParam: Record<string, unknown>;
    let candOverlayBytes: Uint8Array | null | undefined;
    let hasCandOverlay = false;
    let candLogicalBytes = 0;

    if (!baseTree) {
      if (candSelected !== null) {
        const resolved = resolveTargetOverlayFileSync(files.get(path)!);
        candOverlayBytes = resolved.bytes;
        hasCandOverlay = true;
        candidateParam = { kind: 'overlay', entry: candSelected };
        candLogicalBytes = resolved.logicalBytes;
      } else {
        candidateParam = { kind: 'missing' };
      }
    } else if (candSelected !== null) {
      const resolved = resolveTargetOverlayFileSync(files.get(path)!);
      candOverlayBytes = resolved.bytes;
      hasCandOverlay = true;
      candidateParam = { kind: 'overlay', entry: candSelected };
      candLogicalBytes = resolved.logicalBytes;
    } else if (candDeleted) {
      candidateParam = { kind: 'deleted' };
    } else {
      candidateParam = { kind: 'unchanged_baseline' };
    }

    jsonBytes = Math.max(baseLogicalBytes, candLogicalBytes);
    parameters = (
      handler === 'json-keys-guard.v1'
        ? { path, baseline: baselineParam, candidate: candidateParam, allowedPointers: slot.handler.parameters.allowedPointers }
        : {
            path,
            baseline: baselineParam,
            candidate: candidateParam,
            startMarker: slot.handler.parameters.startMarker,
            endMarker: slot.handler.parameters.endMarker,
          }
    ) as unknown as VerifierHeader['parameters'];

    const baseSectionBytes =
      validatedProof !== null
        ? 4 + validatedProof.blob.byteLength + 4 + validatedProof.trees.reduce((sum, tree) => sum + 4 + tree.byteLength, 0)
        : hasBaseOverlay
          ? 4 + baseLogicalBytes
          : 0;
    const candSectionBytes = hasCandOverlay ? 4 + candLogicalBytes : 0;
    const sizedPayloadBytes = firstInvBytes + secondInvBytes + baseSectionBytes + candSectionBytes;

    const header = checkedHeader({
      version: 1,
      jobId: 'job.' + hash(operationId + '\0' + producerNonce).hex.slice(0, 40),
      handler,
      handlerVersion: 1,
      handlerDigest: slot.handler.digest,
      checkId: slot.checkId,
      producerNonce,
      operationId,
      dispatchId: 'unbound',
      generation,
      subject: subject.value,
      source: descriptor(source.manifest, source.ref, overlay),
      candidate: descriptor(candidate.manifest, candidate.ref, overlay),
      parameters,
      payloadKind,
      ...(overlay !== undefined ? { overlay } : {}),
    });
    sizeJob(header, sizedPayloadBytes, jsonBytes, merkle, invSizing);

    const firstInv = encodeInventory(source.manifest, overlay);
    const secondInv = encodeInventory(candidate.manifest, overlay);
    payload = new Uint8Array(sizedPayloadBytes);
    const view = new DataView(payload.buffer);
    let offset = 0;
    payload.set(firstInv, offset);
    offset += firstInv.byteLength;
    payload.set(secondInv, offset);
    offset += secondInv.byteLength;
    if (validatedProof !== null) {
      offset = writeProofSection(payload, view, offset, validatedProof);
    } else if (baseOverlayBytes) {
      view.setUint32(offset, baseOverlayBytes.byteLength);
      offset += 4;
      payload.set(baseOverlayBytes, offset);
      offset += baseOverlayBytes.byteLength;
    }
    if (candOverlayBytes) {
      view.setUint32(offset, candOverlayBytes.byteLength);
      offset += 4;
      payload.set(candOverlayBytes, offset);
    }

    const packetBytes = packetSize(header, payload.byteLength);
    const requestDigest = hash('loopwright.dev/controller/verifier-request/v1\0' + canonical({ planDigest: plan.planDigest, header, payloadDigest: hash(payload) }));
    const sealed = freeze(checkedHeader(parsePrivateJson(Buffer.from(canonical(header)), HEADER_BYTES)));
    const value: PreparedVerification = freeze({ version: 1, slotId, generation, operationId, producerNonce, packetBytes, requestDigest });
    preparedJobs.set(value, { header: sealed, payload, slot });
    return value;
  }

  if (handler === 'evolve-block-guard.v1') {
    payloadKind = 'guard';
    const rawParams = slot.handler.parameters;
    const filesParam = list(rawParams.files, '', EVOLVE_BLOCK_LIMITS.maxFiles).map(item => text(item, '', 1024));
    const hasAllowedBlockIds = Object.hasOwn(rawParams, 'allowedBlockIds');
    const hasMaxBlockBytes = Object.hasOwn(rawParams, 'maxBlockBytes');
    const baseTree = candidate.manifest.spec.baseTree;

    interface PreparedEvolveFile {
      readonly spec: { readonly baseline: Record<string, unknown>; readonly candidate: Record<string, unknown> };
      readonly baseProof: ValidatedProof | null;
      readonly baseOverlayBytes: Uint8Array | null | undefined;
      readonly hasBaseOverlay: boolean;
      readonly candOverlayBytes: Uint8Array | null | undefined;
      readonly hasCandOverlay: boolean;
      readonly sectionBytes: number;
      readonly maxLogicalBytes: number;
    }

    const preparedFiles: PreparedEvolveFile[] = [];
    let maxLogicalFileBytes = 0;
    let totalFilesPayloadBytes = 0;
    let maxMerkleTreeCount = 0;
    let totalMerkleProofBytes = 0;
    let sawMerkle = false;

    for (const path of filesParam) {
      const sourceSelected = source.manifest.spec.entries.find(entry => entry.name === path) ?? null;
      const sourceDeleted = (source.manifest.spec.deleted ?? []).includes(path);
      const candSelected = candidate.manifest.spec.entries.find(entry => entry.name === path) ?? null;
      const candDeleted = (candidate.manifest.spec.deleted ?? []).includes(path);

      let baselineParam: Record<string, unknown>;
      let baseOverlayBytes: Uint8Array | null | undefined;
      let hasBaseOverlay = false;
      let validatedProof: ValidatedProof | null = null;
      let baseLogicalBytes = 0;

      if (sourceSelected !== null) {
        const sourceFileEntry = sourceFiles.get(path);
        if (sourceFileEntry === undefined) {
          refuse('ARTIFACT_INVALID', `/spec/parameters/files/${path}`, 'verification');
        }
        const resolved = resolveTargetOverlayFileSync(sourceFileEntry);
        baseOverlayBytes = resolved.bytes;
        hasBaseOverlay = true;
        baselineParam = { kind: 'overlay' };
        baseLogicalBytes = resolved.logicalBytes;
      } else if (!baseTree || sourceDeleted) {
        baselineParam = { kind: 'missing' };
      } else {
        const rawProof =
          source.baselineProofs && Object.hasOwn(source.baselineProofs, path) ? source.baselineProofs[path] ?? null : null;
        if (rawProof === null) {
          baselineParam = { kind: 'missing' };
        } else {
          validatedProof = validateBaselineProof(rawProof, source.manifest.spec.baseTree!);
          baselineParam = {
            kind: 'merkle_blob',
            mode: validatedProof.mode,
            oid: validatedProof.oid,
            byteLength: validatedProof.byteLength,
          };
          baseLogicalBytes = validatedProof.logicalBytes;
          sawMerkle = true;
          maxMerkleTreeCount = Math.max(maxMerkleTreeCount, validatedProof.merkle.treeCount);
          totalMerkleProofBytes += validatedProof.merkle.treeProofBytes;
          if (totalMerkleProofBytes > EVOLVE_BLOCK_LIMITS.maxMerkleTreeProofBytes) {
            refuse('ARTIFACT_INVALID', `/spec/parameters/files/${path}`, 'verification');
          }
        }
      }

      let candidateParam: Record<string, unknown>;
      let candOverlayBytes: Uint8Array | null | undefined;
      let hasCandOverlay = false;
      let candLogicalBytes = 0;

      if (candSelected !== null) {
        const candFileEntry = files.get(path);
        if (candFileEntry === undefined) {
          refuse('ARTIFACT_INVALID', `/spec/parameters/files/${path}`, 'verification');
        }
        const resolved = resolveTargetOverlayFileSync(candFileEntry);
        candOverlayBytes = resolved.bytes;
        hasCandOverlay = true;
        candidateParam = { kind: 'overlay' };
        candLogicalBytes = resolved.logicalBytes;
      } else if (!baseTree) {
        candidateParam = { kind: 'missing' };
      } else if (candDeleted) {
        candidateParam = { kind: 'deleted' };
      } else {
        candidateParam = { kind: 'unchanged_baseline' };
      }

      const maxLogical = Math.max(baseLogicalBytes, candLogicalBytes);
      maxLogicalFileBytes = Math.max(maxLogicalFileBytes, maxLogical);
      const baseSectionBytes =
        validatedProof !== null
          ? 4 + validatedProof.blob.byteLength + 4 + validatedProof.trees.reduce((sum, tree) => sum + 4 + tree.byteLength, 0)
          : hasBaseOverlay
            ? 4 + baseLogicalBytes
            : 0;
      const candSectionBytes = hasCandOverlay ? 4 + candLogicalBytes : 0;
      const sectionBytes = baseSectionBytes + candSectionBytes;
      totalFilesPayloadBytes += sectionBytes;

      preparedFiles.push({
        spec: { baseline: baselineParam, candidate: candidateParam },
        baseProof: validatedProof,
        baseOverlayBytes,
        hasBaseOverlay,
        candOverlayBytes,
        hasCandOverlay,
        sectionBytes,
        maxLogicalBytes: maxLogical,
      });
    }

    if (sawMerkle) {
      merkle = { treeCount: maxMerkleTreeCount, treeProofBytes: totalMerkleProofBytes };
    }
    jsonBytes = maxLogicalFileBytes;
    parameters = {
      files: filesParam,
      fileSpecs: preparedFiles.map(item => item.spec),
      ...(hasAllowedBlockIds ? { allowedBlockIds: rawParams.allowedBlockIds } : {}),
      ...(hasMaxBlockBytes ? { maxBlockBytes: rawParams.maxBlockBytes } : {}),
    } as unknown as VerifierHeader['parameters'];

    const sizedPayloadBytes = firstInvBytes + secondInvBytes + totalFilesPayloadBytes;
    const header = checkedHeader({
      version: 1,
      jobId: 'job.' + hash(operationId + '\0' + producerNonce).hex.slice(0, 40),
      handler,
      handlerVersion: 1,
      handlerDigest: slot.handler.digest,
      checkId: slot.checkId,
      producerNonce,
      operationId,
      dispatchId: 'unbound',
      generation,
      subject: subject.value,
      source: descriptor(source.manifest, source.ref, overlay),
      candidate: descriptor(candidate.manifest, candidate.ref, overlay),
      parameters,
      payloadKind,
      ...(overlay !== undefined ? { overlay } : {}),
    });
    sizeJob(header, sizedPayloadBytes, jsonBytes, merkle, invSizing);

    const firstInv = encodeInventory(source.manifest, overlay);
    const secondInv = encodeInventory(candidate.manifest, overlay);
    payload = new Uint8Array(sizedPayloadBytes);
    const view = new DataView(payload.buffer);
    let offset = 0;
    payload.set(firstInv, offset);
    offset += firstInv.byteLength;
    payload.set(secondInv, offset);
    offset += secondInv.byteLength;
    for (const item of preparedFiles) {
      if (item.baseProof !== null) {
        offset = writeProofSection(payload, view, offset, item.baseProof);
      } else if (item.baseOverlayBytes) {
        view.setUint32(offset, item.baseOverlayBytes.byteLength);
        offset += 4;
        payload.set(item.baseOverlayBytes, offset);
        offset += item.baseOverlayBytes.byteLength;
      }
      if (item.candOverlayBytes) {
        view.setUint32(offset, item.candOverlayBytes.byteLength);
        offset += 4;
        payload.set(item.candOverlayBytes, offset);
        offset += item.candOverlayBytes.byteLength;
      }
    }

    const packetBytes = packetSize(header, payload.byteLength);
    const requestDigest = hash('loopwright.dev/controller/verifier-request/v1\0' + canonical({ planDigest: plan.planDigest, header, payloadDigest: hash(payload) }));
    const sealed = freeze(checkedHeader(parsePrivateJson(Buffer.from(canonical(header)), HEADER_BYTES)));
    const value: PreparedVerification = freeze({ version: 1, slotId, generation, operationId, producerNonce, packetBytes, requestDigest });
    preparedJobs.set(value, { header: sealed, payload, slot });
    return value;
  }

  if (!['scope.v1', 'no-change.v1'].includes(handler)) refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
  payloadKind = 'inventories';
  parameters = handler === 'scope.v1' ? ({ contract: plan.task } as unknown as VerifierHeader['parameters']) : {};
  const sizedPayloadBytes = firstInvBytes + secondInvBytes;

  const header = checkedHeader({
    version: 1,
    jobId: 'job.' + hash(operationId + '\0' + producerNonce).hex.slice(0, 40),
    handler,
    handlerVersion: 1,
    handlerDigest: slot.handler.digest,
    checkId: slot.checkId,
    producerNonce,
    operationId,
    dispatchId: 'unbound',
    generation,
    subject: subject.value,
    source: descriptor(source.manifest, source.ref, overlay),
    candidate: descriptor(candidate.manifest, candidate.ref, overlay),
    parameters,
    payloadKind,
    ...(overlay !== undefined ? { overlay } : {}),
  });
  sizeJob(header, sizedPayloadBytes, null, undefined, invSizing);
  const firstInv = encodeInventory(source.manifest, overlay);
  const secondInv = encodeInventory(candidate.manifest, overlay);
  payload = new Uint8Array(sizedPayloadBytes);
  payload.set(firstInv, 0);
  payload.set(secondInv, firstInv.byteLength);
  const packetBytes = packetSize(header, payload.byteLength);
  const requestDigest = hash('loopwright.dev/controller/verifier-request/v1\0' + canonical({ planDigest: plan.planDigest, header, payloadDigest: hash(payload) }));
  const sealed = freeze(checkedHeader(parsePrivateJson(Buffer.from(canonical(header)), HEADER_BYTES)));
  const value: PreparedVerification = freeze({ version: 1, slotId, generation, operationId, producerNonce, packetBytes, requestDigest });
  preparedJobs.set(value, { header: sealed, payload, slot });
  return value;
}

export interface PreparedRefusal {
  readonly slotId: string;
  readonly generation: number;
  readonly prospectiveOperationId: string;
  readonly producerNonce: string;
}

interface RefusalPreparation {
  readonly value: RefusalRecord;
  readonly plan: CompiledPlan;
  readonly source: ByteInventory;
  readonly candidate: ByteInventory;
  readonly slot: VerifierSlot;
}

const refusalPreparations = new WeakMap<PreparedRefusal, RefusalPreparation>();

/** Ready jobs keep the original API. Only the dedicated pure sizing exception can create a negative preparation. */
export function preflightVerification(
  plan: CompiledPlan,
  lock: TaskLock,
  slotId: string,
  source: ByteInventory,
  candidate: ByteInventory,
  generation: number,
  producerNonce: string,
): { readonly kind: 'ready'; readonly job: PreparedVerification } | { readonly kind: 'refused'; readonly prepared: PreparedRefusal } {
  const { planDigest, ...unsigned } = plan;
  if (!same(hash('loopwright.dev/controller/plan/v1\0' + canonical(unsigned)), planDigest) || !validateDocument(lock, 'TaskLock').ok) {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
  const slot = plan.verifierSlots.find(item => item.id === slotId);
  if (!slot || slot.handler.kind !== 'check') refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
  const parameters = slot.handler.parameters;
  if (slot.handler.implementation === 'json-artifact.v1') {
    record(parameters, ['checkId', 'path', 'required', 'equals']);
    if (parameters.checkId !== slot.checkId || !digestArtifact(text(parameters.path), new Uint8Array()).ok) {
      refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
    }
    const required = list(parameters.required, '', 128).map(value => text(value, '', 128));
    if (
      new Set(required).size !== required.length ||
      parameters.equals === null ||
      typeof parameters.equals !== 'object' ||
      Array.isArray(parameters.equals)
    ) {
      refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
    }
    const equals = record(parameters.equals, Object.keys(parameters.equals));
    if (
      Object.keys(equals).length > 128 ||
      Object.values(equals).some(
        value => (value !== null && !['string', 'boolean', 'number'].includes(typeof value)) || (typeof value === 'number' && !Number.isSafeInteger(value)),
      )
    ) {
      refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
    }
  } else if (slot.handler.implementation === 'json-keys-guard.v1') {
    record(parameters, ['checkId', 'path', 'allowedPointers']);
    if (parameters.checkId !== slot.checkId || !digestArtifact(text(parameters.path, '', 1024), new Uint8Array()).ok) {
      refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
    }
    const pointers = list(parameters.allowedPointers, '', 128).map(value => text(value, '', 256));
    if (pointers.length < 1 || pointers.some(ptr => !RFC6901_POINTER_PATTERN.test(ptr))) {
      refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
    }
  } else if (slot.handler.implementation === 'line-section-guard.v1') {
    record(parameters, ['checkId', 'path', 'startMarker', 'endMarker']);
    if (parameters.checkId !== slot.checkId || !digestArtifact(text(parameters.path, '', 1024), new Uint8Array()).ok) {
      refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
    }
    const startMarker = text(parameters.startMarker, '', 256);
    const endMarker = text(parameters.endMarker, '', 256);
    if (
      startMarker.length < 1 ||
      endMarker.length < 1 ||
      startMarker === endMarker ||
      /[\r\n]/.test(startMarker) ||
      /[\r\n]/.test(endMarker)
    ) {
      refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
    }
  } else if (slot.handler.implementation === 'evolve-block-guard.v1') {
    if (!isRecord(parameters)) refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
    const hasAllowedBlockIds = Object.hasOwn(parameters, 'allowedBlockIds');
    const hasMaxBlockBytes = Object.hasOwn(parameters, 'maxBlockBytes');
    record(parameters, [
      'checkId',
      'files',
      ...(hasAllowedBlockIds ? ['allowedBlockIds' as const] : []),
      ...(hasMaxBlockBytes ? ['maxBlockBytes' as const] : []),
    ]);
    if (parameters.checkId !== slot.checkId) refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
    const files = list(parameters.files, '', EVOLVE_BLOCK_LIMITS.maxFiles).map(item => text(item, '', 1024));
    if (files.length < 1) refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
    const seenFiles = new Set<string>();
    for (const file of files) {
      const folded = file.normalize('NFC').toLowerCase();
      if (!isValidEvolveGuardPath(file) || seenFiles.has(folded)) refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
      seenFiles.add(folded);
    }
    if (hasAllowedBlockIds) {
      const ids = list(parameters.allowedBlockIds, '', EVOLVE_BLOCK_LIMITS.maxAllowedBlockIds).map(item =>
        text(item, '', EVOLVE_BLOCK_LIMITS.maxBlockIdLength),
      );
      if (ids.length < 1) refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
      const seenIds = new Set<string>();
      for (const blockId of ids) {
        if (!isValidEvolveBlockId(blockId) || seenIds.has(blockId)) refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
        seenIds.add(blockId);
      }
    }
    if (hasMaxBlockBytes) {
      integer(parameters.maxBlockBytes, 1, Number.MAX_SAFE_INTEGER);
    }
  } else {
    record(parameters, ['checkId']);
    if (
      !['scope.v1', 'no-change.v1'].includes(slot.handler.implementation) ||
      parameters.checkId !== (slot.implicit === null ? slot.checkId : null)
    ) {
      refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
    }
  }

  try {
    return { kind: 'ready', job: prepareVerification(plan, lock, slotId, source, candidate, generation, producerNonce) };
  } catch (error) {
    if (!(error instanceof VerifierSizingFailure)) throw error;
    const overlay = lock.spec.contract.spec.budgets.overlay;
    const overlayOpts = overlay ? { overlay } : undefined;
    const subject = bindSubject(lock, candidate.manifest, overlayOpts);
    if (!subject.ok) refuse('ARTIFACT_INVALID', '', 'verification');
    const prospectiveOperationId = verifierOperationId(lock.spec.runId, slotId, generation);
    const value: RefusalRecord = freeze({
      version: 1,
      kind: 'controller_preflight_refusal',
      planDigest,
      handlerDigest: slot.handler.digest,
      slotId,
      checkId: slot.checkId,
      generation,
      prospectiveOperationId,
      producerNonce,
      subject: subject.value,
      source: descriptor(source.manifest, source.ref, overlay),
      candidate: descriptor(candidate.manifest, candidate.ref, overlay),
      code: 'OUTPUT_LIMIT',
      limits: error.sizing,
    });
    const prepared: PreparedRefusal = freeze({ slotId, generation, prospectiveOperationId, producerNonce });
    refusalPreparations.set(prepared, {
      value: freeze(parsePrivateJson(Buffer.from(canonical(value)), 65536) as unknown as RefusalRecord),
      plan,
      source,
      candidate,
      slot,
    });
    return { kind: 'refused', prepared };
  }
}

export interface PreflightRefusal {
  readonly slotId: string;
  readonly checkId: string;
  readonly generation: number;
  readonly prospectiveOperationId: string;
  readonly producerNonce: string;
  readonly status: 'blocked';
  readonly reason: string;
  readonly record: ArtifactRef;
}

interface AuthenticatedRefusal {
  readonly value: RefusalRecord;
  readonly row: VerifierRefusalRow;
  readonly storeId: string;
  readonly clockBasis: import('@loopwright/state').ClockBasis;
}

const refusalObservations = new WeakMap<PreflightRefusal, AuthenticatedRefusal>();
export function authenticatedRefusal(input: PreflightRefusal): AuthenticatedRefusal {
  const value = refusalObservations.get(input);
  if (!value) refuse('EVIDENCE_UNAVAILABLE', '', 'verification');
  return value;
}

export interface WorkerObservation {
  readonly kind: 'reply' | 'timeout' | 'cancelled' | 'failed';
  readonly reply: Uint8Array | null;
  readonly threadId: number;
  readonly exit: number;
  readonly errorCode: 'ERR_WORKER_OUT_OF_MEMORY' | 'WORKER_ERROR' | null;
  readonly limits: { readonly oldMb: number; readonly youngMb: number; readonly stackMb: number };
  readonly elapsedMs: number;
}

export interface WorkerObservationPorts {
  readonly limits?: (actual: Worker['resourceLimits']) => Worker['resourceLimits'];
  readonly maxOldGenerationSizeMb?: number;
  readonly timeoutMs?: number;
}

/** Private containment primitive. Production always supplies the fixed verifier module, never a task/config path. */
export function boundedWorker(module: URL, packet: Uint8Array<ArrayBuffer>, signal: AbortSignal, ports: WorkerObservationPorts = {}): Promise<WorkerObservation> {
  signal.throwIfAborted();
  const expectedOldMb = ports.maxOldGenerationSizeMb ?? 64;
  const timeoutMs = ports.timeoutMs ?? 2000;
  const started = performance.now();
  const worker = new Worker(module, {
    workerData: packet,
    transferList: [packet.buffer],
    env: {},
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: expectedOldMb, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
  });
  const threadId = worker.threadId;
  let limits = {
    oldMb: worker.resourceLimits?.maxOldGenerationSizeMb ?? -1,
    youngMb: worker.resourceLimits?.maxYoungGenerationSizeMb ?? -1,
    stackMb: worker.resourceLimits?.stackSizeMb ?? -1,
  };
  let reply: Uint8Array | null = null;
  let count = 0;
  let kind: WorkerObservation['kind'] = 'reply';
  let invalid = false;
  let errorCode: WorkerObservation['errorCode'] = null;
  return new Promise((resolve, reject) => {
    let stopTimer: NodeJS.Timeout | null = null;
    let finished = false;
    const stop = (next: WorkerObservation['kind']) => {
      if (finished || stopTimer) return;
      kind = next;
      stopTimer = setTimeout(() => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          reject(
            new ControllerFailure({
              version: 1,
              code: 'CLEANUP_FAILED',
              phase: 'verification',
              path: '',
              stateCode: null,
              piCode: null,
              effect: 'possible',
              retryable: false,
            }),
          );
        }
      }, 1000);
      void worker.terminate().catch(() => {
        /* Exact exit or cleanup timeout decides; no replacement Worker. */
      });
    };
    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    worker.on('message', (raw: unknown) => {
      if (++count !== 1 || !(raw instanceof Uint8Array) || raw.byteLength > 65536 || raw.buffer instanceof SharedArrayBuffer) {
        invalid = true;
        stop('failed');
      } else {
        reply = ownedBytes(raw, 65536);
      }
    });
    worker.once('error', (error: Error & { code?: string }) => {
      errorCode = error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? error.code : 'WORKER_ERROR';
      if (kind === 'reply') kind = 'failed';
    });
    worker.once('exit', exit => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (stopTimer) clearTimeout(stopTimer);
      signal.removeEventListener('abort', abort);
      if ((exit !== 0 && kind === 'reply') || invalid || (count !== 1 && kind === 'reply')) kind = 'failed';
      resolve({ kind, reply, threadId, exit, errorCode, limits, elapsedMs: performance.now() - started });
    });
    if (ports.limits) {
      try {
        const observed = ports.limits(worker.resourceLimits);
        limits = {
          oldMb: observed?.maxOldGenerationSizeMb ?? -1,
          youngMb: observed?.maxYoungGenerationSizeMb ?? -1,
          stackMb: observed?.stackSizeMb ?? -1,
        };
      } catch {
        invalid = true;
        stop('failed');
      }
    }
    if (limits.oldMb !== expectedOldMb || limits.youngMb !== 8 || limits.stackMb !== 2) stop('failed');
    else if (signal.aborted) abort();
  });
}

export interface VerifiedCheck {
  readonly slotId: string;
  readonly checkId: string;
  readonly generation: number;
  readonly operationId: string;
  readonly producerNonce: string;
  readonly status: 'passed' | 'failed' | 'blocked';
  readonly reason: string | null;
  readonly output: ArtifactRef;
  readonly receipt: ArtifactRef;
}

interface AuthenticatedCheck {
  readonly evidence: Evidence;
  readonly subject: Subject;
  readonly outputBytes: Uint8Array;
  readonly receipt: OperationReceipt;
  readonly header: VerifierHeader;
  readonly planDigest: import('@loopwright/core').Digest;
  readonly requestDigest: import('@loopwright/core').Digest;
}

const observations = new WeakMap<VerifiedCheck, AuthenticatedCheck>();
export function authenticatedCheck(value: VerifiedCheck): AuthenticatedCheck {
  const trusted = observations.get(value);
  if (!trusted) refuse('EVIDENCE_UNAVAILABLE', '', 'verification');
  return trusted;
}

interface Disposition {
  readonly status: VerifiedCheck['status'];
  readonly reason: string | null;
  readonly method: string;
  readonly response: unknown;
  readonly detail?: string | null;
  readonly metrics?: MetricsMap;
  readonly findings?: readonly StructuredFinding[];
}

const EXPECTED_METHODS: Readonly<Record<ByteHandler, VerifierMethod>> = {
  'scope.v1': 'verify_scope',
  'no-change.v1': 'verify_no_change',
  'json-artifact.v1': 'verify_json',
  'json-keys-guard.v1': 'verify_json_keys_guard',
  'line-section-guard.v1': 'verify_line_section_guard',
  'evolve-block-guard.v1': 'verify_evolve_block_guard',
};

const ALLOWED_REASONS: Readonly<Record<ByteHandler, readonly VerifierReason[]>> = {
  'scope.v1': ['outside_scope'],
  'no-change.v1': ['candidate_changed'],
  'json-artifact.v1': ['missing_file', 'invalid_json', 'property_missing', 'property_mismatch'],
  'json-keys-guard.v1': ['missing_file', 'invalid_json', 'disallowed_json_pointer'],
  'line-section-guard.v1': ['missing_file', 'invalid_utf8', 'missing_markers', 'unbalanced_markers', 'outside_section_modified'],
  'evolve-block-guard.v1': [
    'missing_file',
    'invalid_utf8',
    'missing_markers',
    'unbalanced_markers',
    'duplicate_block_id',
    'block_limit_exceeded',
    'outside_block_modified',
    'disallowed_block_id',
    'block_bytes_exceeded',
  ],
};

function checkedReply(input: unknown, header: VerifierHeader, packetDigest: Digest): Disposition {
  if (!isRecord(input)) refuse('RECOVERY_REQUIRED', '', 'verification');
  const hasDetail = Object.hasOwn(input, 'detail') && input.detail !== undefined;
  const hasMetrics = Object.hasOwn(input, 'metrics') && input.metrics !== undefined;
  const hasFindings = Object.hasOwn(input, 'findings') && input.findings !== undefined;
  const raw = record(input, [
    'version', 'jobId', 'handler', 'handlerDigest', 'checkId', 'producerNonce',
    'operationId', 'dispatchId', 'generation', 'subject', 'packetDigest', 'status', 'reason', 'method', 'allocationBytes',
    ...(hasDetail ? ['detail' as const] : []),
    ...(hasMetrics ? ['metrics' as const] : []),
    ...(hasFindings ? ['findings' as const] : []),
  ]);
  const expected = {
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
    packetDigest,
  };
  const binding = Object.fromEntries(Object.keys(expected).map(key => [key, raw[key]]));
  if (
    !same(binding, expected) ||
    !['passed', 'failed'].includes(text(raw.status)) ||
    (raw.status === 'passed') !== (raw.reason === null) ||
    raw.method !== EXPECTED_METHODS[header.handler]
  ) {
    refuse('RECOVERY_REQUIRED', '', 'verification');
  }
  const bounds = overlayProtocolBounds(header.overlay);
  integer(raw.allocationBytes, 0, bounds.allocationMaxBytes);
  if (raw.reason !== null && !ALLOWED_REASONS[header.handler].includes(text(raw.reason) as VerifierReason)) {
    refuse('RECOVERY_REQUIRED', '', 'verification');
  }
  let detail: string | null | undefined;
  let metrics: MetricsMap | undefined;
  let findings: readonly StructuredFinding[] | undefined;
  try {
    if (hasDetail) detail = checkedDetail(raw.detail);
    if (hasMetrics) metrics = checkedMetrics(raw.metrics);
    if (hasFindings) findings = checkedFindings(raw.findings);
  } catch {
    refuse('RECOVERY_REQUIRED', '', 'verification');
  }
  return {
    status: raw.status as VerifierReply['status'],
    reason: raw.reason as string | null,
    method: text(raw.method),
    response: raw,
    ...(detail !== undefined ? { detail } : {}),
    ...(metrics !== undefined ? { metrics } : {}),
    ...(findings !== undefined ? { findings } : {}),
  };
}

/** Private fault observations; absent from public exports and every config schema. No replacement producer. */
export interface VerificationPorts {
  readonly beforeWorker?: (packet: Uint8Array) => void;
  readonly afterReply?: (reply: Uint8Array) => Uint8Array;
  readonly afterReceiptBytes?: () => void;
}

const verifierModule = new URL('./verifier-worker.js', import.meta.url);

export class Verifier {
  constructor(
    readonly store: LocalRunStore,
    readonly authority: Authority,
    readonly artifacts: ArtifactStore,
    readonly plan: CompiledPlan,
    readonly lock: TaskLock,
    readonly currentSubject: () => Subject,
    readonly ports: VerificationPorts = {},
  ) {}

  #identity() {
    const view = stateValue(this.store.inspect());
    if (
      view.storeId !== this.authority.storeId ||
      view.runId !== this.lock.spec.runId ||
      !same(view.lockHash, this.lock.spec.lockHash) ||
      this.artifacts.owner.runId !== view.runId ||
      !same(this.artifacts.owner.planDigest, this.plan.planDigest)
    ) {
      refuse('AUTHORITY_REFUSED', '', 'verification');
    }
    return view;
  }

  #operationAbsent(operationId: string): void {
    const result = this.store.getOperation(operationId);
    if (result.ok || result.error.code !== 'RECORD_NOT_FOUND') refuse('RECOVERY_REQUIRED', '', 'verification');
  }

  async #refusalContext(prepared: PreparedRefusal) {
    const data = refusalPreparations.get(prepared);
    if (!data || data.plan !== this.plan || this.plan.verifierSlots.find(slot => slot.id === prepared.slotId) !== data.slot) {
      refuse('EVIDENCE_UNAVAILABLE', '', 'verification');
    }
    const repeated = preflightVerification(this.plan, this.lock, prepared.slotId, data.source, data.candidate, prepared.generation, prepared.producerNonce);
    if (repeated.kind !== 'refused' || !same(refusalPreparations.get(repeated.prepared)!.value, data.value)) {
      refuse('RECOVERY_REQUIRED', '', 'verification');
    }
    await this.artifacts.owner.assertCurrent();
    stateValue(this.store.renew(this.authority));
    const view = this.#identity();
    if (
      view.clockStatus !== 'trusted' ||
      view.owner.ownerId !== this.authority.ownerId ||
      view.owner.generation !== this.authority.generation ||
      view.counts.dispatchedRequests ||
      view.counts.unresolvedRequests ||
      view.counts.unresolvedOperations ||
      view.ledger.violations.length ||
      !same(this.currentSubject(), data.value.subject)
    ) {
      refuse('RECOVERY_REQUIRED', '', 'verification');
    }
    this.#operationAbsent(prepared.prospectiveOperationId);
    const bounds = overlayProtocolBounds(this.lock.spec.contract.spec.budgets.overlay);
    for (const input of [data.source, data.candidate]) {
      if (!Buffer.from(await this.artifacts.read(input.ref, bounds.manifestMaxBytes)).equals(Buffer.from(canonical(input.manifest)))) {
        refuse('ARTIFACT_INVALID', '', 'verification');
      }
    }
    const records = journal(this.store);
    const latest = records.checkpoints.filter(cp => cp.additionalArtifacts.length === 4).at(-1);
    if (!latest) refuse('RECOVERY_REQUIRED', '', 'verification');
    const progress = new ProgressStore(this.store, this.authority, this.artifacts, this.plan, this.lock, latest.additionalArtifacts[2]!, latest.additionalArtifacts[3]!);
    const head = await progress.read();
    const source = parsePrivateJson(await this.artifacts.read(progress.sourceRef, 262144), 262144) as Record<string, unknown>;
    if (
      !head ||
      head.progress.candidate.generation !== prepared.generation ||
      !same(head.checkpoint.subject, data.value.subject) ||
      !same(head.progress.candidate.manifest, data.candidate.ref) ||
      !same(source.manifest, data.source.ref)
    ) {
      refuse('RECOVERY_REQUIRED', '', 'verification');
    }
    await this.artifacts.owner.assertCurrent();
    stateValue(this.store.renew(this.authority));
    this.#operationAbsent(prepared.prospectiveOperationId);
    if (!same(this.currentSubject(), data.value.subject)) refuse('RECOVERY_REQUIRED', '', 'verification');
    const finalView = this.#identity();
    if (
      finalView.clockStatus !== 'trusted' ||
      finalView.owner.ownerId !== this.authority.ownerId ||
      finalView.owner.generation !== this.authority.generation ||
      finalView.counts.dispatchedRequests ||
      finalView.counts.unresolvedRequests ||
      finalView.counts.unresolvedOperations ||
      finalView.ledger.violations.length
    ) {
      refuse('RECOVERY_REQUIRED', '', 'verification');
    }
    return { data, progress, head, view: finalView };
  }

  /** Durable negative bytes only; neither this row nor an orphan file can authorize acceptance. */
  async storeRefusal(prepared: PreparedRefusal): Promise<VerifierRefusalRow> {
    const { data, view } = await this.#refusalContext(prepared);
    if (view.owner.mode !== 'active') refuse('AUTHORITY_REFUSED', '', 'verification');
    const ref = await this.artifacts.json('verifier-refusal', data.value, 65536);
    this.#operationAbsent(prepared.prospectiveOperationId);
    return freeze({
      slot: prepared.slotId,
      generation: prepared.generation,
      prospectiveOperationId: prepared.prospectiveOperationId,
      producerNonce: prepared.producerNonce,
      subject: data.value.subject,
      record: ref,
    });
  }

  /** Validate an existing pre anchor without granting a negative observation or allocating a new slot. */
  async validateStoredRefusal(prepared: PreparedRefusal, row: VerifierRefusalRow): Promise<void> {
    const { data, head } = await this.#refusalContext(prepared);
    const original = head.progress.verifierRefusals.find(item => item.slot === prepared.slotId && item.generation === prepared.generation);
    if (!same(original, row)) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const value = checkedRefusalRecord(parsePrivateJson(await this.artifacts.read(row.record, 65536), 65536), this.plan, this.lock, row);
    if (!same(value, data.value)) refuse('RECOVERY_REQUIRED', '', 'recovery');
  }

  /** Original pre/post anchors plus pure size reproduction; no Worker, operation intent, receipt or permit. */
  async restoreRefusal(prepared: PreparedRefusal, row: VerifierRefusalRow): Promise<PreflightRefusal> {
    await this.validateStoredRefusal(prepared, row);
    const { data, head, view } = await this.#refusalContext(prepared);
    const ordinal = this.plan.verifierSlots.findIndex(slot => slot.id === prepared.slotId);
    const phase = 'verify.' + prepared.generation + '.' + ordinal;
    const pre = stateValue(this.store.getCheckpoint(phaseCheckpointId(this.lock.spec.runId, phase + '.pre')));
    const post = stateValue(this.store.getCheckpoint(phaseCheckpointId(this.lock.spec.runId, phase + '.post')));
    if (
      post.sequence !== pre.sequence + 1 ||
      pre.counts.requests !== post.counts.requests ||
      pre.counts.operations !== post.counts.operations ||
      !same(pre.ledger, post.ledger) ||
      !same(pre.clockBasis, view.clock.basis) ||
      !same(post.clockBasis, view.clock.basis) ||
      !same(pre.subject, data.value.subject) ||
      !same(post.subject, data.value.subject) ||
      !head.progress.stage.consumed.includes(phase + '.pre') ||
      !head.progress.stage.consumed.includes(phase + '.post')
    ) {
      refuse('RECOVERY_REQUIRED', '', 'recovery');
    }
    const wideProgress = this.plan.capacity.D > 64;
    const pMaxBytes = wideProgress ? 262_144 : 65_536;
    const pCollectionLimit = wideProgress ? 1024 : 256;
    for (const [checkpoint, suffix] of [
      [pre, 'pre'],
      [post, 'post'],
    ] as const) {
      if (checkpoint.additionalArtifacts.length !== 4 || !same(checkpoint.additionalArtifacts.slice(2), head.checkpoint.additionalArtifacts.slice(2))) {
        refuse('RECOVERY_REQUIRED', '', 'recovery');
      }
      const progress = validateProgress(
        parsePrivateJson(await this.artifacts.read(checkpoint.additionalArtifacts[0]!, pMaxBytes), pMaxBytes, pCollectionLimit),
        this.plan,
        this.lock,
      );
      if (
        progress.stage.phase !== phase + '.' + suffix ||
        !same(progress.verifierRefusals.find(item => item.slot === row.slot && item.generation === row.generation), row)
      ) {
        refuse('RECOVERY_REQUIRED', '', 'recovery');
      }
    }
    this.#operationAbsent(row.prospectiveOperationId);
    const value: PreflightRefusal = freeze({
      slotId: row.slot,
      checkId: data.slot.checkId,
      generation: row.generation,
      prospectiveOperationId: row.prospectiveOperationId,
      producerNonce: row.producerNonce,
      status: 'blocked',
      reason: 'verifier_' + data.value.limits.reason,
      record: row.record,
    });
    refusalObservations.set(value, { value: data.value, row, storeId: view.storeId, clockBasis: view.clock.basis });
    return value;
  }

  #permit(permit: DispatchPermit, expected: Subject, target: string): void {
    stateValue(this.store.renew(this.authority));
    const view = stateValue(this.store.inspect());
    const operation = stateValue(this.store.getOperation(permit.operationId));
    if (
      !same(this.currentSubject(), expected) ||
      view.clockStatus !== 'trusted' ||
      view.owner.mode !== 'active' ||
      view.owner.ownerId !== this.authority.ownerId ||
      view.owner.generation !== this.authority.generation ||
      permit.generation !== this.authority.generation ||
      permit.clockEpoch !== view.clock.basis.clockEpoch ||
      view.storeId !== permit.storeId ||
      view.runId !== permit.runId ||
      !same(view.lockHash, permit.lockHash) ||
      BigInt(view.clock.sampledNow.monotonicMs) >= BigInt(permit.notAfterMonotonicMs) ||
      BigInt(view.clock.sampledNow.monotonicMs) >= BigInt(view.clock.basis.taskDeadlineMonotonicMs) ||
      operation.state !== 'dispatch_uncertain' ||
      operation.dispatch?.dispatchId !== permit.dispatchId ||
      operation.intent.targetIdentity !== target
    ) {
      refuse('AUTHORITY_REFUSED', '', 'verification');
    }
  }

  async #marker(operationId: string, nonce: string, kind: 'binding' | 'proof', value: unknown): Promise<void> {
    await this.artifacts.owner.assertCurrent();
    const name = 'producer-' + hash(operationId + '\0' + nonce).hex + '.' + kind + '.json';
    const path = join(this.artifacts.directory, name);
    const bytes = Buffer.from(canonical(value));
    if (bytes.byteLength > 1048576) refuse('OUTPUT_LIMIT', '', 'verification');
    this.artifacts.vault.assertClean(bytes);
    let file: Awaited<ReturnType<typeof open>>;
    try {
      file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !Buffer.from(await readBoundedFile(path, 1048576, true)).equals(bytes)) {
        refuse('RECOVERY_REQUIRED', '', 'verification');
      }
      return;
    }
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    const parent = await open(this.artifacts.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }

  async run(job: PreparedVerification, signal: AbortSignal): Promise<VerifiedCheck> {
    const prepared = preparedJobs.get(job);
    if (!prepared || this.plan.verifierSlots.find(slot => slot.id === job.slotId) !== prepared.slot) {
      refuse('EVIDENCE_UNAVAILABLE', '', 'verification');
    }
    signal.throwIfAborted();
    await this.artifacts.owner.assertCurrent();
    if (!same(this.currentSubject(), prepared.header.subject)) refuse('ARTIFACT_INVALID', '', 'verification');
    const done = await this.artifacts.owner.holdLocalActivity();
    let closed = true;
    try {
      const target = 'verifier:' + job.slotId + ':' + job.generation + ':' + prepared.header.subject.candidateDigest.hex;
      const before = this.#identity();
      if (before.owner.mode !== 'active') refuse('AUTHORITY_REFUSED', '', 'verification');
      if (before.counts.dispatchedRequests || before.counts.unresolvedRequests || before.counts.unresolvedOperations || before.ledger.violations.length) {
        refuse('RECOVERY_REQUIRED', '', 'verification');
      }
      stateValue(
        this.store.putIntent(this.authority, {
          operationId: job.operationId,
          nodeId: this.plan.orderedDAG[0]!.id,
          attemptId: prepared.header.jobId,
          effect: 'read_only',
          requestDigest: job.requestDigest,
          targetIdentity: target,
        }),
      );
      const dispatched = stateValue(this.store.authorizeOperationDispatch(this.authority, job.operationId));
      if (dispatched.kind !== 'new_dispatch') refuse('RECOVERY_REQUIRED', '', 'verification');
      const permit = dispatched.permit;
      const header = { ...prepared.header, dispatchId: permit.dispatchId };
      const packet = encodePacket(header, prepared.payload);
      const packetDigest = hash(packet);
      const maxJobPacket = maxPacketBytes(header);
      const jobRef = await this.artifacts.put('verifier-job', packet, maxJobPacket);
      const moduleDigest = hash(await readBoundedFile(fileURLToPath(verifierModule), 1048576, false));
      const operation = stateValue(this.store.getOperation(job.operationId));
      await this.#marker(job.operationId, job.producerNonce, 'binding', {
        version: 1,
        planDigest: this.plan.planDigest,
        operationId: job.operationId,
        producerNonce: job.producerNonce,
        requestDigest: job.requestDigest,
        intentDigest: operation.intentDigest,
        subject: header.subject,
        generation: job.generation,
        job: jobRef,
        packetDigest,
        moduleDigest,
        dispatchReceipt: {
          generation: permit.generation,
          dispatchId: permit.dispatchId,
          revision: permit.authorizedRevision,
          clockEpoch: permit.clockEpoch,
        },
      });
      this.ports.beforeWorker?.(packet);
      signal.throwIfAborted();
      await this.artifacts.owner.assertCurrent();
      this.#permit(permit, header.subject, target);
      const workerBounds = overlayProtocolBounds(header.overlay);
      const isWideOverlay = header.overlay !== undefined && (workerBounds.maxOverlayEntries > 128 || workerBounds.maxTotalBytes > 4_194_304);
      const maxOldGenerationSizeMb = isWideOverlay
        ? Math.min(192, Math.max(64, Math.ceil(workerBounds.allocationMaxBytes / (1024 * 1024)) + 32))
        : 64;
      const timeoutMs = isWideOverlay ? 15_000 : 2_000;
      const running = boundedWorker(verifierModule, packet, signal, { maxOldGenerationSizeMb, timeoutMs });
      closed = false;
      const observed = await running;
      closed = true;
      this.#permit(permit, header.subject, target);

      let disposition: Disposition;
      if (observed.kind === 'reply' && observed.reply) {
        const replyBytes = this.ports.afterReply?.(observed.reply) ?? observed.reply;
        disposition = checkedReply(parsePrivateJson(replyBytes, 65536), header, packetDigest);
      } else {
        const status: VerifiedCheck['status'] = 'blocked';
        const reason = 'worker_' + observed.kind;
        disposition = { status, reason, method: 'worker_runtime', response: { version: 1, status, reason } };
      }

      const output = await this.artifacts.json(
        'verifier-output',
        {
          version: 1,
          binding: header,
          packetDigest,
          moduleDigest,
          observation: {
            kind: observed.kind,
            threadId: observed.threadId,
            exit: observed.exit,
            errorCode: observed.errorCode,
            limits: observed.limits,
            elapsedMs: Math.ceil(observed.elapsedMs),
          },
          response: disposition.response,
        },
        65536,
      );
      const suffix = hash(job.operationId + '\0' + job.producerNonce).hex.slice(0, 40);
      const evidenceSpec = {
        checkId: prepared.slot.checkId,
        observedStatus: disposition.status,
        producerId: 'loopwright.byte-verifier.v1',
        method: disposition.method,
        level: 'local_execution' as const,
        subject: header.subject,
        artifacts: [output],
        reason: disposition.reason,
        ...(disposition.detail !== undefined ? { detail: disposition.detail } : {}),
        ...(disposition.metrics !== undefined ? { metrics: disposition.metrics } : {}),
        ...(disposition.findings !== undefined ? { findings: disposition.findings } : {}),
      };
      const evidenceResult = validateDocument(
        { apiVersion: 'loopwright.dev/v1alpha1', kind: 'Evidence', metadata: { id: 'evidence.' + suffix }, spec: evidenceSpec },
        'Evidence',
      );
      if (!evidenceResult.ok) refuse('RECOVERY_REQUIRED', '', 'verification');
      const current = stateValue(this.store.inspect());
      const receipt: OperationReceipt = {
        receiptId: 'receipt.' + suffix,
        outcome: observed.kind === 'reply' ? 'succeeded' : 'failed',
        evidence: {
          evidenceId: 'receipt-evidence.' + suffix,
          producerId: 'loopwright.byte-verifier.v1',
          method: disposition.method,
          subject: {
            storeId: current.storeId,
            runId: current.runId,
            lockHash: current.lockHash,
            operationId: job.operationId,
            requestId: null,
            intentDigest: operation.intentDigest,
            dispatchGeneration: permit.generation,
            dispatchId: permit.dispatchId,
          },
          artifact: output,
        },
      };
      const receiptRef = await this.artifacts.json('verifier-receipt', receipt, 65536);
      await this.#marker(job.operationId, job.producerNonce, 'proof', { version: 1, job: jobRef, output, receipt: receiptRef, evidence: evidenceResult.value });
      this.ports.afterReceiptBytes?.();
      this.#permit(permit, header.subject, target);
      stateValue(this.store.recordOperationReceipt(this.authority, job.operationId, receipt));
      const value: VerifiedCheck = freeze({
        slotId: job.slotId,
        checkId: prepared.slot.checkId,
        generation: job.generation,
        operationId: job.operationId,
        producerNonce: job.producerNonce,
        status: disposition.status,
        reason: disposition.reason,
        output,
        receipt: receiptRef,
      });
      observations.set(value, {
        evidence: freeze(evidenceResult.value),
        subject: header.subject,
        outputBytes: await this.artifacts.read(output, 65536),
        receipt: freeze(receipt),
        header: freeze(header),
        planDigest: this.plan.planDigest,
        requestDigest: job.requestDigest,
      });
      return value;
    } finally {
      if (closed) done();
    }
  }

  /** Original private producer proof only. No Worker, new intent, permit reconstruction or transport retry. */
  async restore(job: PreparedVerification): Promise<VerifiedCheck> {
    const prepared = preparedJobs.get(job);
    if (!prepared || this.plan.verifierSlots.find(slot => slot.id === job.slotId) !== prepared.slot) {
      refuse('EVIDENCE_UNAVAILABLE', '', 'recovery');
    }
    await this.artifacts.owner.assertCurrent();
    if (!same(this.currentSubject(), prepared.header.subject)) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const operation = stateValue(this.store.getOperation(job.operationId));
    const view = this.#identity();
    const dispatch = operation.dispatch;
    if (
      !dispatch ||
      view.clockStatus !== 'trusted' ||
      operation.intent.effect !== 'read_only' ||
      operation.linkedRequestId !== null ||
      !same(operation.intent.requestDigest, job.requestDigest) ||
      operation.intent.attemptId !== prepared.header.jobId ||
      operation.intent.nodeId !== this.plan.orderedDAG[0]!.id ||
      operation.intent.targetIdentity !== 'verifier:' + job.slotId + ':' + job.generation + ':' + prepared.header.subject.candidateDigest.hex
    ) {
      refuse('RECOVERY_REQUIRED', '', 'recovery');
    }
    const prefix = join(this.artifacts.directory, 'producer-' + hash(job.operationId + '\0' + job.producerNonce).hex);
    const binding = record(parsePrivateJson(await readBoundedFile(prefix + '.binding.json', 1048576, true), 1048576), [
      'version', 'planDigest', 'operationId', 'producerNonce', 'requestDigest', 'intentDigest',
      'subject', 'generation', 'job', 'packetDigest', 'moduleDigest', 'dispatchReceipt',
    ]);
    const proof = record(parsePrivateJson(await readBoundedFile(prefix + '.proof.json', 1048576, true), 1048576), [
      'version', 'job', 'output', 'receipt', 'evidence',
    ]);
    const receiptBinding = record(binding.dispatchReceipt, ['generation', 'dispatchId', 'revision', 'clockEpoch']);
    if (
      receiptBinding.generation !== dispatch.generation ||
      receiptBinding.dispatchId !== dispatch.dispatchId ||
      receiptBinding.revision !== dispatch.revision ||
      receiptBinding.clockEpoch !== view.clock.basis.clockEpoch
    ) {
      refuse('RECOVERY_REQUIRED', '', 'recovery');
    }
    const header = freeze({ ...prepared.header, dispatchId: dispatch.dispatchId });
    const expectedPacket = encodePacket(header, prepared.payload);
    const packetDigest = hash(expectedPacket);
    const jobRef = checkedRef(binding.job);
    const maxJobPacket = maxPacketBytes(header);
    const moduleDigest = hash(await readBoundedFile(fileURLToPath(verifierModule), 1048576, false));
    if (
      binding.version !== 1 ||
      proof.version !== 1 ||
      !same(binding.planDigest, this.plan.planDigest) ||
      binding.operationId !== job.operationId ||
      binding.producerNonce !== job.producerNonce ||
      binding.generation !== job.generation ||
      !same(binding.subject, header.subject) ||
      !same(binding.requestDigest, job.requestDigest) ||
      !same(binding.intentDigest, operation.intentDigest) ||
      !same(binding.packetDigest, packetDigest) ||
      !same(binding.moduleDigest, moduleDigest) ||
      !same(binding.job, proof.job) ||
      !Buffer.from(await this.artifacts.read(jobRef, maxJobPacket)).equals(Buffer.from(expectedPacket))
    ) {
      refuse('RECOVERY_REQUIRED', '', 'recovery');
    }
    const output = checkedRef(proof.output);
    const receiptRef = checkedRef(proof.receipt);
    const outputBytes = await this.artifacts.read(output, 65536);
    const saved = record(parsePrivateJson(outputBytes, 65536), ['version', 'binding', 'packetDigest', 'moduleDigest', 'observation', 'response']);
    const observed = record(saved.observation, ['kind', 'threadId', 'exit', 'errorCode', 'limits', 'elapsedMs']);
    integer(observed.threadId, 1, Number.MAX_SAFE_INTEGER);
    integer(observed.exit, 0, 255);
    integer(observed.elapsedMs, 0, Number.MAX_SAFE_INTEGER);
    if (
      saved.version !== 1 ||
      !same(saved.binding, header) ||
      !same(saved.packetDigest, packetDigest) ||
      !same(saved.moduleDigest, moduleDigest) ||
      !['reply', 'timeout', 'cancelled', 'failed'].includes(text(observed.kind)) ||
      (observed.errorCode !== null && !['ERR_WORKER_OUT_OF_MEMORY', 'WORKER_ERROR'].includes(text(observed.errorCode)))
    ) {
      refuse('RECOVERY_REQUIRED', '', 'recovery');
    }
    let disposition: Disposition;
    if (observed.kind === 'reply') {
      if (observed.exit !== 0 || observed.errorCode !== null || !same(observed.limits, { oldMb: 64, youngMb: 8, stackMb: 2 })) {
        refuse('RECOVERY_REQUIRED', '', 'recovery');
      }
      disposition = checkedReply(saved.response, header, packetDigest);
    } else {
      const response = { version: 1, status: 'blocked', reason: 'worker_' + observed.kind };
      if (!same(saved.response, response)) refuse('RECOVERY_REQUIRED', '', 'recovery');
      disposition = { status: 'blocked', reason: response.reason, method: 'worker_runtime', response };
    }
    const suffix = hash(job.operationId + '\0' + job.producerNonce).hex.slice(0, 40);
    const evidenceSpec = {
      checkId: prepared.slot.checkId,
      observedStatus: disposition.status,
      producerId: 'loopwright.byte-verifier.v1',
      method: disposition.method,
      level: 'local_execution' as const,
      subject: header.subject,
      artifacts: [output],
      reason: disposition.reason,
      ...(disposition.detail !== undefined ? { detail: disposition.detail } : {}),
      ...(disposition.metrics !== undefined ? { metrics: disposition.metrics } : {}),
      ...(disposition.findings !== undefined ? { findings: disposition.findings } : {}),
    };
    const evidence = validateDocument(
      { apiVersion: 'loopwright.dev/v1alpha1', kind: 'Evidence', metadata: { id: 'evidence.' + suffix }, spec: evidenceSpec },
      'Evidence',
    );
    if (!evidence.ok || !same(evidence.value, proof.evidence)) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const receipt: OperationReceipt = {
      receiptId: 'receipt.' + suffix,
      outcome: observed.kind === 'reply' ? 'succeeded' : 'failed',
      evidence: {
        evidenceId: 'receipt-evidence.' + suffix,
        producerId: 'loopwright.byte-verifier.v1',
        method: disposition.method,
        subject: {
          storeId: view.storeId,
          runId: view.runId,
          lockHash: view.lockHash,
          operationId: job.operationId,
          requestId: null,
          intentDigest: operation.intentDigest,
          dispatchGeneration: dispatch.generation,
          dispatchId: dispatch.dispatchId,
        },
        artifact: output,
      },
    };
    if (!same(parsePrivateJson(await this.artifacts.read(receiptRef, 65536), 65536), receipt)) refuse('RECOVERY_REQUIRED', '', 'recovery');
    await this.artifacts.owner.assertCurrent();
    if (!same(this.currentSubject(), header.subject)) refuse('RECOVERY_REQUIRED', '', 'recovery');
    stateValue(this.store.renew(this.authority));
    if (operation.state === 'confirmed') {
      if (!same(operation.reconciliation ?? operation.initialReceipt, receipt)) refuse('RECOVERY_REQUIRED', '', 'recovery');
    } else {
      stateValue(this.store.reconcileOperation(this.authority, job.operationId, receipt));
    }
    const value: VerifiedCheck = freeze({
      slotId: job.slotId,
      checkId: prepared.slot.checkId,
      generation: job.generation,
      operationId: job.operationId,
      producerNonce: job.producerNonce,
      status: disposition.status,
      reason: disposition.reason,
      output,
      receipt: receiptRef,
    });
    observations.set(value, {
      evidence: freeze(evidence.value),
      subject: header.subject,
      outputBytes,
      receipt: freeze(receipt),
      header,
      planDigest: this.plan.planDigest,
      requestDigest: job.requestDigest,
    });
    return value;
  }
}
