import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { types } from 'node:util';
import {
  LIMITS,
  VERIFIER_ARTIFACT_LIMITS,
  bindSubject,
  digestArtifactFromMetadata,
  isVerifierNamespacePath,
  matchesHardwareTarget,
  validateDocument,
  validateRelativePath,
  type ArtifactManifest,
  type ArtifactRef,
  type BaseTreeAnchor,
  type Digest,
  type Evidence,
  type HardwareProvenance,
  type HardwareTargetSpec,
  type MetricThresholdRule,
  type MetricsMap,
  type StructuredFinding,
  type Subject,
  type TaskLock,
} from '@loopwright/core';
import type { Authority, DispatchPermit, LocalRunStore, OperationReceipt, OperationRecord, RunView } from '@loopwright/state';
import {
  ArtifactStore,
  checkedRef,
  cleanMarkerTempFilesInDirectory,
  overwriteAtomicMarker,
  privateDirectory,
  publishAtomicMarker,
  resolveCanonicalCasBlobPath,
  stateValue,
  streamVerifiedCasBlob,
  syncDirectory,
  unlinkIfOwnedInode,
} from './storage.js';
import { STREAM_CHUNK_BYTES, readBoundedFile, writeAllToHandle } from './files.js';
import { compareUtf16 } from './git-objects.js';
import type { ControllerOwner } from './ownership.js';
import type { FrozenSource } from './source.js';
import { canonical, digestValue, freeze, hash, id, integer, isRecord, list, record, same, text } from './schema.js';
import { parsePrivateJson } from './parser.js';
import { ControllerFailure, refuse, type ControllerDiagnostic } from './errors.js';
import { verifierOperationId } from './progress.js';
import {
  checkedDetail,
  checkedFindings,
  checkedMetrics,
  signGateVerdict,
  signPayload,
  validateGateUrlOverrides,
  verifyGateSignature,
  verifySignedPayload,
  type GateWaitDetail,
} from './gate.js';
import { ownedBytes } from './verifier-protocol.js';
import type { CandidateFileEntry, CompiledPlan, ControllerProgress, GateEndpoint, VerifierSlot } from './types.js';
import type { ByteInventory, VerifiedCheck } from './verification.js';

const EMPTY_SHA256_HEX = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const LONE_SURROGATE_PATTERN = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const VERDICT_STATUSES = ['pending', 'approved', 'denied', 'expired'] as const;
const MAX_PREFLIGHT_DISPATCH_ID = 'd'.repeat(64);
const MAX_PREFLIGHT_DISPATCH_GENERATION = 999_999;

export const LWTREE01_MAGIC = 'LWTREE01' as const;
const BASE_TREE_BUNDLE_MAGIC = Buffer.from(LWTREE01_MAGIC, 'ascii');
export const BENCHMARK_REQUEST_BYTES = 65_536;
export const BENCHMARK_RESPONSE_BYTES = 65_536;
export const BENCHMARK_OUTPUT_BYTES = 262_144;

export interface BenchmarkOutputArtifact {
  readonly name: string;
  readonly digest: Digest;
  readonly byteLength: number;
  readonly mediaType?: string | null;
}

export interface BenchmarkBaseTreeBundle {
  readonly digest: Digest;
  readonly byteLength: number;
  readonly blobPath: string;
}

export interface DecodedBaseTreeEntry {
  readonly name: string;
  readonly mode: '100644' | '100755';
  readonly bytes: Uint8Array;
}

export interface VerifierBudgetUsage {
  readonly files: number;
  readonly bytes: number;
}

export interface VerifierTotalLimits {
  readonly maxTotalFiles: number;
  readonly maxTotalBytes: number;
}

export interface BenchmarkCandidateEntry {
  readonly name: string;
  readonly digest: Digest;
  readonly byteLength: number;
  readonly mode?: '100644' | '100755';
}

export interface BenchmarkCandidateArtifacts {
  readonly entries: readonly BenchmarkCandidateEntry[];
  readonly deleted: readonly string[];
  readonly baseTree?: BaseTreeAnchor;
  readonly baseTreeBundle?: { readonly digest: Digest; readonly byteLength: number };
}

export type CandidateEntryModesInput =
  | ReadonlyMap<string, '100644' | '100755' | CandidateFileEntry>
  | readonly { readonly name: string; readonly mode?: '100644' | '100755' | undefined }[];

export interface BenchmarkRequest {
  readonly version: 1;
  readonly kind: 'benchmark_request';
  readonly storeId: string;
  readonly runId: string;
  readonly lockHash: Digest;
  readonly operationId: string;
  readonly dispatchId: string;
  readonly dispatchGeneration: number;
  readonly requestDigest: string;
  readonly gateId: string;
  readonly checkId: string;
  readonly candidateDigest: string;
  readonly subject: Subject;
  readonly targetCellId: string;
  readonly targetHardware: HardwareTargetSpec;
  readonly heldOutWorkloadId: string;
  readonly metricThresholds: readonly MetricThresholdRule[];
  readonly maxPreemptions: number;
  readonly candidateArtifacts: BenchmarkCandidateArtifacts;
}

export interface BenchmarkVerdict {
  readonly status: (typeof VERDICT_STATUSES)[number];
  readonly reason: string | null;
  readonly expiresAtMs: string;
  readonly preemptionCount: number;
  readonly retryablePreemption?: boolean;
  readonly detail?: string | null;
  readonly metrics?: MetricsMap;
  readonly findings?: readonly StructuredFinding[];
  readonly hardwareProvenance?: HardwareProvenance;
  readonly outputArtifacts?: readonly BenchmarkOutputArtifact[];
}

export interface PreparedBenchmarkGate {
  readonly version: 1;
  readonly slotId: string;
  readonly generation: number;
  readonly operationId: string;
  readonly producerNonce: string;
  readonly requestDigest: Digest;
}

export interface BenchmarkDisposition {
  readonly status: VerifiedCheck['status'];
  readonly reason: string | null;
  readonly method: 'benchmark-gate.v1' | 'benchmark_transport';
  readonly retryablePreemption?: boolean;
}

export interface BenchmarkGateObservation {
  readonly evidence: Evidence;
  readonly subject: Subject;
  readonly outputBytes: Uint8Array;
  readonly receipt: OperationReceipt;
  readonly planDigest: Digest;
  readonly requestDigest: Digest;
  readonly artifactsDirectory: string;
  readonly verifierArtifacts: readonly ArtifactRef[];
  readonly retryablePreemption: boolean;
  readonly header: {
    readonly handlerDigest: Digest;
    readonly handler: 'benchmark-gate.v1';
    readonly candidate: { readonly ref: { readonly digest: Digest; readonly byteLength: number } };
  };
}

interface BenchmarkGatePreparation {
  readonly slot: VerifierSlot;
  readonly endpoint: GateEndpoint;
  readonly subject: Subject;
  readonly manifest: ArtifactManifest;
  readonly files: ReadonlyMap<string, CandidateFileEntry>;
  readonly baseTreeBundle?: BenchmarkBaseTreeBundle | undefined;
  readonly targetCellId: string;
  readonly targetHardware: HardwareTargetSpec;
  readonly allowSyntheticHardwareProbe: boolean;
  readonly heldOutWorkloadId: string;
  readonly metricThresholds: readonly MetricThresholdRule[];
  readonly maxPreemptions: number;
  readonly candidateDigest: Digest;
  readonly candidateBytes: number;
}

type RoundTrip =
  | { readonly kind: 'verdict'; readonly verdict: BenchmarkVerdict; readonly responseBytes: Uint8Array; readonly signature: string }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'network' };

const preparations = new WeakMap<PreparedBenchmarkGate, BenchmarkGatePreparation>();
const observations = new WeakMap<VerifiedCheck, BenchmarkGateObservation>();

export function authenticatedBenchmarkGate(value: VerifiedCheck): BenchmarkGateObservation {
  const trusted = observations.get(value);
  if (!trusted) refuse('EVIDENCE_UNAVAILABLE', '', 'verification');
  return trusted;
}

export function signBenchmarkVerdict(secret: string, verdict: Readonly<Record<string, unknown>>): string {
  return signGateVerdict(secret, verdict);
}

export function verifyBenchmarkSignature(
  secret: string,
  verdict: Readonly<Record<string, unknown>>,
  expectedHex: string,
): boolean {
  return verifyGateSignature(secret, verdict, expectedHex);
}

export function expectedBenchmarkOutputArtifactRef(
  slotId: string,
  item: BenchmarkOutputArtifact,
  phase: ControllerDiagnostic['phase'] = 'recovery',
): ArtifactRef {
  const logicalName = `.loopwright-verifier/${slotId}/${item.name}`;
  const res = digestArtifactFromMetadata(logicalName, {
    digest: item.digest,
    byteLength: item.byteLength,
    uri: 'cas://sha256/' + item.digest.hex,
    ...(item.mediaType !== undefined ? { mediaType: item.mediaType } : {}),
  });
  if (!res.ok) refuse('ARTIFACT_INVALID', '', phase);
  return freeze(res.value);
}

export function checkedVerifierArtifactRef(
  raw: unknown,
  phase: ControllerDiagnostic['phase'] = 'recovery',
): ArtifactRef {
  if (!isRecord(raw)) refuse('ARTIFACT_INVALID', '', phase);
  const hasUri = Object.hasOwn(raw, 'uri') && raw.uri !== undefined;
  const hasMediaType = Object.hasOwn(raw, 'mediaType') && raw.mediaType !== undefined;
  let fields: Record<string, unknown>;
  try {
    fields = record(raw, [
      'name',
      'digest',
      'byteLength',
      ...(hasUri ? ['uri' as const] : []),
      ...(hasMediaType ? ['mediaType' as const] : []),
    ]);
  } catch {
    refuse('ARTIFACT_INVALID', '', phase);
  }
  if (typeof fields.name !== 'string' || !isVerifierNamespacePath(fields.name)) {
    refuse('ARTIFACT_INVALID', '', phase);
  }
  const res = digestArtifactFromMetadata(fields.name, {
    digest: fields.digest as Digest,
    byteLength: fields.byteLength as number,
    ...(hasUri ? { uri: fields.uri as string | null } : {}),
    ...(hasMediaType ? { mediaType: fields.mediaType as string | null } : {}),
  });
  if (!res.ok) refuse('ARTIFACT_INVALID', '', phase);
  return freeze(res.value);
}

function readFiniteMetric(metrics: MetricsMap, key: string): number | undefined {
  if (!Object.hasOwn(metrics, key)) return undefined;
  const raw = metrics[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Object.is(raw, -0) ? 0 : raw;
}

export function evaluateBenchmarkThresholds(
  rules: readonly MetricThresholdRule[],
  metrics: MetricsMap | undefined,
): boolean {
  if (rules.length === 0) return true;
  if (metrics === undefined) return false;
  for (const rule of rules) {
    const value = readFiniteMetric(metrics, rule.metric);
    if (value === undefined) return false;
    if (rule.kind === 'bounds') {
      if (rule.min !== undefined && value < rule.min) return false;
      if (rule.max !== undefined && value > rule.max) return false;
      continue;
    }
    const baseline = readFiniteMetric(metrics, rule.baselineMetric);
    if (baseline === undefined) return false;
    if (rule.operator === 'min_ratio') {
      if (!(baseline > 0)) return false;
      const ratio = value / baseline;
      if (Number.isNaN(ratio) || ratio < rule.threshold) return false;
    } else if (rule.operator === 'max_ratio') {
      if (!(baseline > 0)) return false;
      const ratio = value / baseline;
      if (Number.isNaN(ratio) || ratio > rule.threshold) return false;
    } else {
      const delta = value - baseline;
      if (Number.isNaN(delta) || delta > rule.threshold) return false;
    }
  }
  return true;
}

function checkedPrintableText(raw: unknown, max: number): string {
  const s = text(raw, '', max);
  if (s.length < 1 || s.trim() !== s || /[\r\n\t\p{C}]/u.test(s) || LONE_SURROGATE_PATTERN.test(s)) {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
  return s;
}

function checkedPrintableAscii(raw: unknown, max: number): string {
  const s = text(raw, '', max);
  if (s.length < 1 || s.trim() !== s || !/^[\x20-\x7E]+$/.test(s)) {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
  return s;
}

export function checkedHardwareProvenance(raw: unknown): HardwareProvenance {
  if (!isRecord(raw)) refuse('ARTIFACT_INVALID', '', 'verification');
  const hasTopology = Object.hasOwn(raw, 'topology') && raw.topology !== undefined;
  const fields = record(raw, [
    'targetCellId',
    'probeKind',
    'vendor',
    'deviceModel',
    'accelerator',
    'isolationMode',
    'deviceCount',
    'driverVersion',
    'runtimeVersion',
    'workloadDigest',
    'clockLockMode',
    ...(hasTopology ? ['topology' as const] : []),
  ]);
  const targetCellId = id(fields.targetCellId);
  const probeKind = text(fields.probeKind, '', 32);
  if (probeKind !== 'physical' && probeKind !== 'synthetic_fixture') refuse('ARTIFACT_INVALID', '', 'verification');
  const vendor = checkedPrintableText(fields.vendor, 128);
  const deviceModel = checkedPrintableText(fields.deviceModel, 128);
  const accelerator = checkedPrintableAscii(fields.accelerator, 64);
  const isolationMode = text(fields.isolationMode, '', 32);
  if (isolationMode !== 'whole_device' && isolationMode !== 'sliced') refuse('ARTIFACT_INVALID', '', 'verification');
  const deviceCount = integer(fields.deviceCount, 1, 64);
  const driverVersion = checkedPrintableText(fields.driverVersion, 128);
  const runtimeVersion = checkedPrintableText(fields.runtimeVersion, 128);
  const topology = hasTopology ? checkedPrintableText(fields.topology, 128) : undefined;
  const workloadDigest = digestValue(fields.workloadDigest);
  const clockLockMode = text(fields.clockLockMode, '', 16);
  if (clockLockMode !== 'locked' && clockLockMode !== 'unlocked' && clockLockMode !== 'unknown') {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  out.targetCellId = targetCellId;
  out.probeKind = probeKind;
  out.vendor = vendor;
  out.deviceModel = deviceModel;
  out.accelerator = accelerator;
  out.isolationMode = isolationMode;
  out.deviceCount = deviceCount;
  out.driverVersion = driverVersion;
  out.runtimeVersion = runtimeVersion;
  if (topology !== undefined) out.topology = topology;
  out.workloadDigest = workloadDigest;
  out.clockLockMode = clockLockMode;
  return freeze(out as unknown as HardwareProvenance);
}

function checkedOutputArtifacts(raw: unknown, slotId: string): readonly BenchmarkOutputArtifact[] {
  const items = list(raw, '', VERIFIER_ARTIFACT_LIMITS.maxFilesPerSlot);
  const seenNames = new Set<string>();
  let totalBytes = 0;
  const out: BenchmarkOutputArtifact[] = [];
  for (const item of items) {
    if (!isRecord(item)) refuse('ARTIFACT_INVALID', '', 'verification');
    const hasMediaType = Object.hasOwn(item, 'mediaType') && item.mediaType !== undefined;
    const fields = record(item, [
      'name',
      'digest',
      'byteLength',
      ...(hasMediaType ? ['mediaType' as const] : []),
    ]);
    const rawName = text(fields.name, '', 1024);
    if (rawName.length < 1 || LONE_SURROGATE_PATTERN.test(rawName) || isVerifierNamespacePath(rawName)) {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }
    const validRel = validateRelativePath(rawName);
    if (!validRel.ok || validRel.value.split('/').some(seg => seg.toLowerCase() === '.git')) {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }
    const nameKey = validRel.value.toLowerCase();
    if (seenNames.has(nameKey)) refuse('ARTIFACT_INVALID', '', 'verification');
    seenNames.add(nameKey);

    const digest = digestValue(fields.digest);
    const byteLength = integer(fields.byteLength, 0, VERIFIER_ARTIFACT_LIMITS.maxFileBytes);
    if ((byteLength === 0) !== (digest.hex === EMPTY_SHA256_HEX)) {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }
    if (byteLength > VERIFIER_ARTIFACT_LIMITS.maxTotalBytes - totalBytes) {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }
    totalBytes += byteLength;

    let mediaTypeVal: string | null | undefined;
    if (hasMediaType) {
      if (fields.mediaType === null) {
        mediaTypeVal = null;
      } else {
        const mt = text(fields.mediaType, '', 128);
        if (mt.length < 1 || LONE_SURROGATE_PATTERN.test(mt)) refuse('ARTIFACT_INVALID', '', 'verification');
        mediaTypeVal = mt;
      }
    }

    const logicalName = `.loopwright-verifier/${slotId}/${validRel.value}`;
    const refCheck = digestArtifactFromMetadata(logicalName, {
      digest,
      byteLength,
      uri: 'cas://sha256/' + digest.hex,
      ...(hasMediaType ? { mediaType: mediaTypeVal } : {}),
    });
    if (!refCheck.ok) refuse('ARTIFACT_INVALID', '', 'verification');

    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    copy.name = validRel.value;
    copy.digest = digest;
    copy.byteLength = byteLength;
    if (hasMediaType) copy.mediaType = mediaTypeVal;
    out.push(freeze(copy as unknown as BenchmarkOutputArtifact));
  }
  return freeze(out);
}

export function checkedBenchmarkVerdict(raw: unknown, expected: Record<string, unknown>): BenchmarkVerdict {
  try {
    if (!isRecord(raw)) refuse('ARTIFACT_INVALID', '', 'verification');
    const hasPreemption = Object.hasOwn(raw, 'retryablePreemption') && raw.retryablePreemption !== undefined;
    const hasDetail = Object.hasOwn(raw, 'detail') && raw.detail !== undefined;
    const hasMetrics = Object.hasOwn(raw, 'metrics') && raw.metrics !== undefined;
    const hasFindings = Object.hasOwn(raw, 'findings') && raw.findings !== undefined;
    const hasProvenance = Object.hasOwn(raw, 'hardwareProvenance') && raw.hardwareProvenance !== undefined;
    const hasOutputArtifacts = Object.hasOwn(raw, 'outputArtifacts') && raw.outputArtifacts !== undefined;
    const value = record(raw, [
      'version',
      'kind',
      'storeId',
      'runId',
      'lockHash',
      'operationId',
      'dispatchId',
      'dispatchGeneration',
      'gateId',
      'checkId',
      'candidateDigest',
      'status',
      'reason',
      'expiresAtMs',
      'preemptionCount',
      ...(hasPreemption ? ['retryablePreemption' as const] : []),
      ...(hasDetail ? ['detail' as const] : []),
      ...(hasMetrics ? ['metrics' as const] : []),
      ...(hasFindings ? ['findings' as const] : []),
      ...(hasProvenance ? ['hardwareProvenance' as const] : []),
      ...(hasOutputArtifacts ? ['outputArtifacts' as const] : []),
    ]);
    const binding = {
      version: 1,
      kind: 'benchmark_verdict',
      storeId: expected.storeId,
      runId: expected.runId,
      lockHash: expected.lockHash,
      operationId: expected.operationId,
      dispatchId: expected.dispatchId,
      dispatchGeneration: expected.dispatchGeneration,
      gateId: expected.gateId,
      checkId: expected.checkId,
      candidateDigest: expected.candidateDigest,
    };
    const stripped = {
      version: value.version,
      kind: value.kind,
      storeId: value.storeId,
      runId: value.runId,
      lockHash: value.lockHash,
      operationId: value.operationId,
      dispatchId: value.dispatchId,
      dispatchGeneration: value.dispatchGeneration,
      gateId: value.gateId,
      checkId: value.checkId,
      candidateDigest: value.candidateDigest,
    };
    if (!same(stripped, binding) || !VERDICT_STATUSES.includes(value.status as never)) {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }
    if (
      value.reason !== null
      && (value.status === 'pending'
        || typeof value.reason !== 'string'
        || value.reason.length < 1
        || value.reason.length > 256
        || LONE_SURROGATE_PATTERN.test(value.reason))
    ) {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }
    if (!/^(?:0|[1-9][0-9]{0,17})$/.test(text(value.expiresAtMs, '', 19))) {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }
    const preemptionCount = integer(value.preemptionCount, 0, 16);

    let retryablePreemption: boolean | undefined;
    if (hasPreemption) {
      if (
        typeof value.retryablePreemption !== 'boolean'
        || value.status === 'pending'
        || (value.retryablePreemption === true && value.status === 'approved')
      ) {
        refuse('ARTIFACT_INVALID', '', 'verification');
      }
      retryablePreemption = value.retryablePreemption;
    }

    const detail = hasDetail ? checkedDetail(value.detail) : undefined;
    const metrics = hasMetrics ? checkedMetrics(value.metrics) : undefined;
    const findings = hasFindings ? checkedFindings(value.findings) : undefined;

    if (value.status === 'approved' && !hasProvenance) {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }
    const hardwareProvenance = hasProvenance ? checkedHardwareProvenance(value.hardwareProvenance) : undefined;

    const slotId = typeof expected.slotId === 'string' && expected.slotId.length > 0
      ? expected.slotId
      : 'check.' + String(expected.checkId);
    const outputArtifacts = hasOutputArtifacts ? checkedOutputArtifacts(value.outputArtifacts, slotId) : undefined;
    if (value.status === 'pending' && outputArtifacts !== undefined && outputArtifacts.length > 0) {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }

    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    out.status = value.status;
    out.reason = value.reason;
    out.expiresAtMs = value.expiresAtMs;
    out.preemptionCount = preemptionCount;
    if (retryablePreemption !== undefined) out.retryablePreemption = retryablePreemption;
    if (detail !== undefined) out.detail = detail;
    if (metrics !== undefined) out.metrics = metrics;
    if (findings !== undefined) out.findings = findings;
    if (hardwareProvenance !== undefined) out.hardwareProvenance = hardwareProvenance;
    if (outputArtifacts !== undefined) out.outputArtifacts = outputArtifacts;
    return freeze(out as unknown as BenchmarkVerdict);
  } catch (error) {
    if (error instanceof ControllerFailure && error.diagnostic.code === 'ARTIFACT_INVALID') throw error;
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
}

export function resolveBenchmarkSlotMetadata(plan: CompiledPlan, slot: VerifierSlot): {
  readonly gateId: string;
  readonly endpointRef: string;
  readonly heldOutWorkloadId: string;
  readonly maxPreemptions: number;
  readonly targetCellId: string;
  readonly targetHardware: HardwareTargetSpec;
  readonly allowSyntheticHardwareProbe: boolean;
  readonly metricThresholds: readonly MetricThresholdRule[];
} {
  if (!isRecord(slot.handler.parameters)) refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
  const hasMaxPreemptions = Object.hasOwn(slot.handler.parameters, 'maxPreemptions');
  const parameters = record(slot.handler.parameters, [
    'checkId',
    'endpointRef',
    'gateId',
    'heldOutWorkloadId',
    ...(hasMaxPreemptions ? ['maxPreemptions' as const] : []),
  ]);
  if (parameters.checkId !== slot.checkId) refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
  const endpointRef = id(parameters.endpointRef);
  const gateId = text(parameters.gateId, '', 128);
  if (gateId.length < 1 || gateId.trim() !== gateId || !/^[\x20-\x7E]+$/.test(gateId)) {
    refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
  }
  const heldOutWorkloadId = id(parameters.heldOutWorkloadId);
  const maxPreemptions = hasMaxPreemptions ? integer(parameters.maxPreemptions, 0, 16) : 3;

  const check = plan.task.spec.acceptance.checks.find(item => item.id === slot.checkId);
  if (!check || !check.allowedEvidenceLevels.includes('hardware_execution') || !check.targetCellId) {
    refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
  }
  const cell = (plan.task.spec.target.matrix ?? []).find(item => item.id === check.targetCellId);
  if (!cell || cell.hardware === undefined) {
    refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
  }
  const targetHardware: HardwareTargetSpec = freeze({
    accelerator: cell.hardware.accelerator,
    isolationMode: cell.hardware.isolationMode,
    ...(cell.hardware.deviceCount !== undefined ? { deviceCount: cell.hardware.deviceCount } : {}),
    ...(cell.hardware.driverConstraint !== undefined ? { driverConstraint: cell.hardware.driverConstraint } : {}),
    ...(cell.hardware.topology !== undefined ? { topology: cell.hardware.topology } : {}),
  });
  const metricThresholds: readonly MetricThresholdRule[] = freeze(
    (check.metricThresholds ?? []).map(rule =>
      rule.kind === 'bounds'
        ? freeze({
            kind: 'bounds' as const,
            metric: rule.metric,
            ...(rule.min !== undefined ? { min: rule.min } : {}),
            ...(rule.max !== undefined ? { max: rule.max } : {}),
          })
        : freeze({
            kind: 'comparative' as const,
            metric: rule.metric,
            baselineMetric: rule.baselineMetric,
            operator: rule.operator,
            threshold: rule.threshold,
          }),
    ),
  );
  return {
    gateId,
    endpointRef,
    heldOutWorkloadId,
    maxPreemptions,
    targetCellId: check.targetCellId,
    targetHardware,
    allowSyntheticHardwareProbe: check.allowSyntheticHardwareProbe === true,
    metricThresholds,
  };
}

function resolveCandidateEntryModesMap(
  entryModes?: CandidateEntryModesInput,
  phase: ControllerDiagnostic['phase'] = 'verification',
): ReadonlyMap<string, '100644' | '100755'> {
  const out = new Map<string, '100644' | '100755'>();
  if (entryModes === undefined) return out;
  if (entryModes instanceof Map) {
    for (const [name, rawVal] of entryModes.entries()) {
      if (typeof rawVal === 'string') {
        if (rawVal !== '100644' && rawVal !== '100755') refuse('ARTIFACT_INVALID', '', phase);
        out.set(name, rawVal);
      } else if (isRecord(rawVal)) {
        if (Object.hasOwn(rawVal, 'mode') && rawVal.mode !== undefined) {
          if (rawVal.mode !== '100644' && rawVal.mode !== '100755') refuse('ARTIFACT_INVALID', '', phase);
          out.set(name, rawVal.mode);
        }
      } else {
        refuse('ARTIFACT_INVALID', '', phase);
      }
    }
    return out;
  }
  if (!Array.isArray(entryModes)) refuse('ARTIFACT_INVALID', '', phase);
  for (const item of entryModes as readonly { readonly name: string; readonly mode?: unknown }[]) {
    if (!isRecord(item) || typeof item.name !== 'string') refuse('ARTIFACT_INVALID', '', phase);
    if (Object.hasOwn(item, 'mode') && item.mode !== undefined) {
      if (item.mode !== '100644' && item.mode !== '100755') refuse('ARTIFACT_INVALID', '', phase);
      out.set(item.name, item.mode);
    }
  }
  return out;
}

export function checkedBenchmarkCandidateArtifacts(
  raw: unknown,
  phase: ControllerDiagnostic['phase'] = 'verification',
): BenchmarkCandidateArtifacts {
  if (!isRecord(raw)) refuse('ARTIFACT_INVALID', '', phase);
  const hasBaseTree = Object.hasOwn(raw, 'baseTree') && raw.baseTree !== undefined;
  const hasBaseTreeBundle = Object.hasOwn(raw, 'baseTreeBundle') && raw.baseTreeBundle !== undefined;
  let obj: Record<string, unknown>;
  try {
    obj = record(raw, [
      'entries',
      'deleted',
      ...(hasBaseTree ? ['baseTree' as const] : []),
      ...(hasBaseTreeBundle ? ['baseTreeBundle' as const] : []),
    ]);
  } catch {
    refuse('ARTIFACT_INVALID', '', phase);
  }
  if (!hasBaseTree && hasBaseTreeBundle) refuse('ARTIFACT_INVALID', '', phase);

  const rawEntries = list(obj.entries, '', 4096);
  const seenFolded = new Set<string>();
  const entries: BenchmarkCandidateEntry[] = [];
  for (const rawEntry of rawEntries) {
    if (!isRecord(rawEntry)) refuse('ARTIFACT_INVALID', '', phase);
    const hasMode = Object.hasOwn(rawEntry, 'mode') && rawEntry.mode !== undefined;
    let item: Record<string, unknown>;
    try {
      item = record(rawEntry, ['name', 'digest', 'byteLength', ...(hasMode ? ['mode' as const] : [])]);
    } catch {
      refuse('ARTIFACT_INVALID', '', phase);
    }
    const rawName = text(item.name, '', LIMITS.path);
    const rel = validateRelativePath(rawName);
    if (!rel.ok || isVerifierNamespacePath(rel.value) || rel.value.split('/').some(seg => seg.toLowerCase() === '.git')) {
      refuse('ARTIFACT_INVALID', '', phase);
    }
    const folded = rel.value.toLowerCase();
    if (seenFolded.has(folded)) refuse('ARTIFACT_INVALID', '', phase);
    seenFolded.add(folded);
    const digest = digestValue(item.digest);
    const byteLength = integer(item.byteLength, 0, VERIFIER_ARTIFACT_LIMITS.maxFileBytes);
    if ((byteLength === 0) !== (digest.hex === EMPTY_SHA256_HEX)) {
      refuse('ARTIFACT_INVALID', '', phase);
    }
    let normalizedMode: '100644' | '100755' | undefined;
    if (hasMode) {
      if (item.mode !== '100644' && item.mode !== '100755') refuse('ARTIFACT_INVALID', '', phase);
      normalizedMode = item.mode;
    }
    entries.push(
      freeze({
        name: rel.value,
        digest: freeze({ algorithm: digest.algorithm, hex: digest.hex }),
        byteLength,
        ...(normalizedMode === '100755' ? { mode: '100755' as const } : {}),
      }),
    );
  }

  const rawDeleted = list(obj.deleted, '', 4096);
  const deleted: string[] = [];
  for (const rawDel of rawDeleted) {
    const rawName = text(rawDel, '', LIMITS.path);
    const rel = validateRelativePath(rawName);
    if (!rel.ok || isVerifierNamespacePath(rel.value) || rel.value.split('/').some(seg => seg.toLowerCase() === '.git')) {
      refuse('ARTIFACT_INVALID', '', phase);
    }
    const folded = rel.value.toLowerCase();
    if (seenFolded.has(folded)) refuse('ARTIFACT_INVALID', '', phase);
    seenFolded.add(folded);
    deleted.push(rel.value);
  }

  let baseTree: BaseTreeAnchor | undefined;
  if (hasBaseTree) {
    let bt: Record<string, unknown>;
    try {
      bt = record(obj.baseTree, ['objectFormat', 'commitOid', 'treeOid']);
    } catch {
      refuse('ARTIFACT_INVALID', '', phase);
    }
    if (bt.objectFormat !== 'sha1' && bt.objectFormat !== 'sha256') refuse('ARTIFACT_INVALID', '', phase);
    const oidRe = bt.objectFormat === 'sha1' ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/;
    const commitOid = text(bt.commitOid, '', 64);
    const treeOid = text(bt.treeOid, '', 64);
    if (!oidRe.test(commitOid) || !oidRe.test(treeOid)) refuse('ARTIFACT_INVALID', '', phase);
    baseTree = freeze({ objectFormat: bt.objectFormat, commitOid, treeOid });
  }

  let baseTreeBundle: { readonly digest: Digest; readonly byteLength: number } | undefined;
  if (hasBaseTreeBundle) {
    let btb: Record<string, unknown>;
    try {
      btb = record(obj.baseTreeBundle, ['digest', 'byteLength']);
    } catch {
      refuse('ARTIFACT_INVALID', '', phase);
    }
    const digest = digestValue(btb.digest);
    const byteLength = integer(btb.byteLength, 12, VERIFIER_ARTIFACT_LIMITS.maxFileBytes);
    baseTreeBundle = freeze({
      digest: freeze({ algorithm: digest.algorithm, hex: digest.hex }),
      byteLength,
    });
  }

  return freeze({
    entries: freeze(entries),
    deleted: freeze(deleted),
    ...(baseTree !== undefined ? { baseTree } : {}),
    ...(baseTreeBundle !== undefined ? { baseTreeBundle } : {}),
  });
}

export function buildCandidateArtifactsDescriptor(
  manifest: ArtifactManifest,
  baseTreeBundle?: { readonly digest: Digest; readonly byteLength: number },
  entryModes?: CandidateEntryModesInput,
): BenchmarkCandidateArtifacts {
  if (baseTreeBundle !== undefined && manifest.spec.baseTree === undefined) {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
  const modeMap = resolveCandidateEntryModesMap(entryModes, 'verification');
  return freeze({
    entries: freeze(
      manifest.spec.entries.map(entry => {
        const mode = modeMap.get(entry.name);
        return freeze({
          name: entry.name,
          digest: freeze({ algorithm: entry.digest.algorithm, hex: entry.digest.hex }),
          byteLength: entry.byteLength,
          ...(mode === '100755' ? { mode: '100755' as const } : {}),
        });
      }),
    ),
    deleted: freeze([...(manifest.spec.deleted ?? [])]),
    ...(manifest.spec.baseTree !== undefined
      ? {
          baseTree: freeze({
            objectFormat: manifest.spec.baseTree.objectFormat,
            commitOid: manifest.spec.baseTree.commitOid,
            treeOid: manifest.spec.baseTree.treeOid,
          }),
        }
      : {}),
    ...(baseTreeBundle !== undefined
      ? {
          baseTreeBundle: freeze({
            digest: freeze({ algorithm: baseTreeBundle.digest.algorithm, hex: baseTreeBundle.digest.hex }),
            byteLength: baseTreeBundle.byteLength,
          }),
        }
      : {}),
  });
}

export function expectedBenchmarkRequest(
  plan: CompiledPlan,
  slot: VerifierSlot,
  endpoint: GateEndpoint,
  subject: Subject,
  manifest: ArtifactManifest,
  baseTreeBundle?: { readonly digest: Digest; readonly byteLength: number },
  entryModes?: CandidateEntryModesInput,
): Record<string, unknown> {
  const meta = resolveBenchmarkSlotMetadata(plan, slot);
  if (meta.endpointRef !== endpoint.id) refuse('ARTIFACT_INVALID', '', 'verification');
  return {
    version: 1,
    kind: 'benchmark_request',
    gateId: meta.gateId,
    checkId: slot.checkId,
    candidateDigest: subject.candidateDigest.hex,
    subject,
    targetCellId: meta.targetCellId,
    targetHardware: meta.targetHardware,
    heldOutWorkloadId: meta.heldOutWorkloadId,
    metricThresholds: meta.metricThresholds,
    maxPreemptions: meta.maxPreemptions,
    candidateArtifacts: buildCandidateArtifactsDescriptor(manifest, baseTreeBundle, entryModes),
  };
}

function cancelledFailure(phase: ControllerDiagnostic['phase'] = 'verification'): ControllerFailure {
  return new ControllerFailure({
    version: 1,
    code: 'CANCELLED',
    phase,
    path: '',
    stateCode: null,
    piCode: null,
    effect: 'none',
    retryable: false,
  });
}

/**
 * Deterministically seals surviving unchanged v2 base-tree entries into a digest-bound `LWTREE01`
 * binary CAS blob (`<= 1 MiB` streaming via owned `git cat-file --batch`, `O_NOFOLLOW`, `0o400`, `fsync`, `nlink === 1`).
 */
export async function sealBenchmarkBaseTreeBundle(
  source: FrozenSource,
  manifest: ArtifactManifest,
  artifacts: ArtifactStore,
  owner: ControllerOwner,
  signal: AbortSignal,
  onProgress?: () => void | Promise<void>,
): Promise<BenchmarkBaseTreeBundle | undefined> {
  if (source.version !== 2 || manifest.spec.baseTree === undefined) return undefined;
  if (signal.aborted) throw cancelledFailure('verification');
  await owner.assertCurrent();

  const overlayNames = new Set(manifest.spec.entries.map(entry => entry.name));
  const deletedNames = new Set(manifest.spec.deleted ?? []);
  const surviving = (source.baselineEntries ?? [])
    .filter(entry => !overlayNames.has(entry.name) && !deletedNames.has(entry.name))
    .sort((a, b) => compareUtf16(a.name, b.name));
  if (surviving.length === 0) return undefined;
  if (surviving.length > LIMITS.baselineEntries) refuse('OUTPUT_LIMIT', '', 'verification');

  const preparedEntries: {
    readonly name: string;
    readonly pathBytes: Buffer;
    readonly mode: '100644' | '100755';
    readonly modeFlag: 0 | 1;
    readonly oid: string;
    readonly byteLength: number;
  }[] = [];
  let expectedBundleBytes = 12; // 8-byte ASCII 'LWTREE01' + uint32BE count
  let prevName: string | null = null;
  const seenFolded = new Set<string>();

  for (const entry of surviving) {
    if (prevName !== null && compareUtf16(prevName, entry.name) >= 0) {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }
    prevName = entry.name;
    const validRel = validateRelativePath(entry.name);
    if (
      !validRel.ok
      || validRel.value !== entry.name
      || isVerifierNamespacePath(entry.name)
      || entry.name.split('/').some(seg => seg.toLowerCase() === '.git' || Buffer.byteLength(seg, 'utf8') > 255)
    ) {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }
    const folded = entry.name.normalize('NFC').toLowerCase();
    if (seenFolded.has(folded)) refuse('ARTIFACT_INVALID', '', 'verification');
    seenFolded.add(folded);

    if (entry.mode !== '100644' && entry.mode !== '100755') {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }
    if (
      !Number.isSafeInteger(entry.byteLength)
      || Object.is(entry.byteLength, -0)
      || entry.byteLength < 0
      || entry.byteLength > 0xffff_ffff
    ) {
      refuse('OUTPUT_LIMIT', '', 'verification');
    }
    const pathBytes = Buffer.from(entry.name, 'utf8');
    if (pathBytes.byteLength < 1 || pathBytes.byteLength > 4096) {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }
    const entryFramingAndBody = 4 + pathBytes.byteLength + 1 + 4 + entry.byteLength;
    if (entryFramingAndBody > VERIFIER_ARTIFACT_LIMITS.maxFileBytes - expectedBundleBytes) {
      refuse('OUTPUT_LIMIT', '', 'verification');
    }
    expectedBundleBytes += entryFramingAndBody;
    preparedEntries.push({
      name: entry.name,
      pathBytes,
      mode: entry.mode,
      modeFlag: entry.mode === '100755' ? 1 : 0,
      oid: entry.oid,
      byteLength: entry.byteLength,
    });
  }
  for (const folded of seenFolded) {
    let slash = folded.indexOf('/');
    while (slash !== -1) {
      if (seenFolded.has(folded.slice(0, slash))) refuse('ARTIFACT_INVALID', '', 'verification');
      slash = folded.indexOf('/', slash + 1);
    }
  }

  const blobsDir = join(artifacts.directory, 'blobs');
  const sha256Dir = join(blobsDir, 'sha256');
  await privateDirectory(blobsDir);
  await privateDirectory(sha256Dir);

  const releaseActivity = await owner.holdLocalActivity();
  const tmpPath = join(sha256Dir, '.tmp-' + randomBytes(16).toString('hex'));
  let tmpHandle: Awaited<ReturnType<typeof open>> | null = null;
  const vaultChecker = artifacts.vault.createStreamChecker();
  let vaultFinished = false;
  let tmpClosed = false;
  let tmpUnlinked = false;
  let createdDev = -1;
  let createdIno = -1;

  try {
    tmpHandle = await open(
      tmpPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    const handle = tmpHandle;
    const createdInfo = await handle.stat();
    createdDev = createdInfo.dev;
    createdIno = createdInfo.ino;
    if (
      !createdInfo.isFile()
      || createdInfo.isSymbolicLink()
      || createdInfo.uid !== process.getuid?.()
      || createdInfo.nlink !== 1
    ) {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }

    const bundleSha = createHash('sha256');
    let writtenBundleBytes = 0;
    const writeBundleSlice = async (raw: Uint8Array): Promise<void> => {
      for (let off = 0; off < raw.byteLength; off += STREAM_CHUNK_BYTES) {
        if (signal.aborted) throw cancelledFailure('verification');
        if (onProgress) await onProgress();
        const sub = raw.subarray(off, Math.min(raw.byteLength, off + STREAM_CHUNK_BYTES));
        writtenBundleBytes += sub.byteLength;
        if (writtenBundleBytes > expectedBundleBytes || writtenBundleBytes > VERIFIER_ARTIFACT_LIMITS.maxFileBytes) {
          refuse('OUTPUT_LIMIT', '', 'verification');
        }
        try {
          vaultChecker.push(sub);
        } catch (error) {
          if (error instanceof ControllerFailure && error.diagnostic.code === 'CONFIG_CREDENTIAL_INVALID') {
            refuse('ARTIFACT_INVALID', '', 'verification');
          }
          throw error;
        }
        bundleSha.update(sub);
        await writeAllToHandle(handle, sub);
      }
    };

    const headerBuf = Buffer.allocUnsafe(12);
    BASE_TREE_BUNDLE_MAGIC.copy(headerBuf, 0);
    headerBuf.writeUInt32BE(preparedEntries.length, 8);
    await writeBundleSlice(headerBuf);

    let entryIndex = 0;
    await owner.streamGitBatch(
      source.directory,
      preparedEntries,
      async (_entry, readChunks) => {
        const item = preparedEntries[entryIndex++]!;
        if (signal.aborted) throw cancelledFailure('verification');
        const entryPrefix = Buffer.allocUnsafe(4 + item.pathBytes.byteLength + 1 + 4);
        entryPrefix.writeUInt32BE(item.pathBytes.byteLength, 0);
        item.pathBytes.copy(entryPrefix, 4);
        entryPrefix[4 + item.pathBytes.byteLength] = item.modeFlag;
        entryPrefix.writeUInt32BE(item.byteLength, 4 + item.pathBytes.byteLength + 1);
        await writeBundleSlice(entryPrefix);
        await readChunks(async slice => {
          await writeBundleSlice(slice);
        });
      },
      {
        intentScope: { bundle: LWTREE01_MAGIC },
        phase: 'verification',
        signal,
        timeoutMs: 120_000,
      },
    );

    try {
      vaultChecker.finish();
      vaultFinished = true;
    } catch (error) {
      if (error instanceof ControllerFailure && error.diagnostic.code === 'CONFIG_CREDENTIAL_INVALID') {
        refuse('ARTIFACT_INVALID', '', 'verification');
      }
      throw error;
    }

    if (writtenBundleBytes !== expectedBundleBytes) {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }
    const sha256Hex = bundleSha.digest('hex');

    await handle.chmod(0o400);
    await handle.sync();
    const sealedInfo = await handle.stat();
    if (
      !sealedInfo.isFile()
      || sealedInfo.isSymbolicLink()
      || sealedInfo.dev !== createdDev
      || sealedInfo.ino !== createdIno
      || sealedInfo.uid !== process.getuid?.()
      || sealedInfo.nlink !== 1
      || sealedInfo.size !== expectedBundleBytes
      || (sealedInfo.mode & 0o7777) !== 0o400
    ) {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }

    await owner.assertCurrent();
    const beforeLink = await lstat(tmpPath).catch(() => null);
    if (
      !beforeLink
      || beforeLink.isSymbolicLink()
      || !beforeLink.isFile()
      || beforeLink.dev !== sealedInfo.dev
      || beforeLink.ino !== sealedInfo.ino
      || beforeLink.uid !== process.getuid?.()
    ) {
      tmpUnlinked = true;
      refuse('ARTIFACT_INVALID', '', 'verification');
    }

    const finalHexPath = join(sha256Dir, sha256Hex);
    let linked = false;
    try {
      await link(tmpPath, finalHexPath);
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    if (linked) {
      await unlinkIfOwnedInode(tmpPath, sealedInfo.dev, sealedInfo.ino);
      tmpUnlinked = true;
      let finalVerifyHandle: Awaited<ReturnType<typeof open>> | null = null;
      try {
        finalVerifyHandle = await open(finalHexPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        const committed = await finalVerifyHandle.stat();
        const pinned = await handle.stat();
        if (
          committed.isSymbolicLink()
          || !committed.isFile()
          || committed.dev !== sealedInfo.dev
          || committed.ino !== sealedInfo.ino
          || committed.uid !== process.getuid?.()
          || committed.nlink !== 1
          || committed.size !== expectedBundleBytes
          || (committed.mode & 0o7777) !== 0o400
          || pinned.dev !== sealedInfo.dev
          || pinned.ino !== sealedInfo.ino
          || pinned.nlink !== 1
        ) {
          if (committed.dev === sealedInfo.dev && committed.ino === sealedInfo.ino && committed.uid === process.getuid?.()) {
            await unlinkIfOwnedInode(finalHexPath, sealedInfo.dev, sealedInfo.ino);
          }
          refuse('ARTIFACT_INVALID', '', 'verification');
        }
      } finally {
        if (finalVerifyHandle) await finalVerifyHandle.close().catch(() => {});
      }
      await handle.close();
      tmpClosed = true;
    } else {
      await handle.close();
      tmpClosed = true;
      await unlinkIfOwnedInode(tmpPath, sealedInfo.dev, sealedInfo.ino);
      tmpUnlinked = true;
      for (let attempt = 0; attempt < 20; attempt++) {
        const st = await lstat(finalHexPath).catch(() => null);
        if (!st || st.isSymbolicLink() || !st.isFile() || st.nlink <= 1) break;
        await new Promise(r => setTimeout(r, 5));
      }
      await streamVerifiedCasBlob(
        artifacts.directory,
        { sha256: sha256Hex, byteLength: expectedBundleBytes, path: finalHexPath },
        async () => {
          if (signal.aborted) throw cancelledFailure('verification');
          if (onProgress) await onProgress();
        },
        'verification',
      );
    }

    await syncDirectory(sha256Dir);
    return freeze({
      digest: freeze({ algorithm: 'sha256', hex: sha256Hex }),
      byteLength: expectedBundleBytes,
      blobPath: finalHexPath,
    });
  } finally {
    if (!vaultFinished) {
      try {
        vaultChecker.finish();
      } catch {
        // Ignore cleanup error after failure.
      }
    }
    if (tmpHandle !== null && !tmpClosed) {
      await tmpHandle.close().catch(() => {});
    }
    if (!tmpUnlinked && createdDev !== -1) {
      await unlinkIfOwnedInode(tmpPath, createdDev, createdIno).catch(() => {});
    }
    releaseActivity();
  }
}

/** Bounded deterministic `LWTREE01` binary bundle decoder. */
export function decodeBenchmarkBaseTreeBundle(
  bytes: Uint8Array,
  maxBytes: number = VERIFIER_ARTIFACT_LIMITS.maxFileBytes,
): readonly DecodedBaseTreeEntry[] {
  if (
    !(bytes instanceof Uint8Array)
    || types.isProxy(bytes)
    || types.isSharedArrayBuffer(bytes.buffer)
    || bytes.byteLength < 12
    || bytes.byteLength > maxBytes
  ) {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
  if (!Buffer.from(bytes.buffer, bytes.byteOffset, 8).equals(BASE_TREE_BUNDLE_MAGIC)) {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(8, false);
  if (count > LIMITS.baselineEntries) refuse('ARTIFACT_INVALID', '', 'verification');

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries: DecodedBaseTreeEntry[] = [];
  const seenFolded = new Set<string>();
  let prevName: string | null = null;
  let offset = 12;

  for (let i = 0; i < count; i++) {
    if (offset + 4 > bytes.byteLength) refuse('ARTIFACT_INVALID', '', 'verification');
    const pathLen = view.getUint32(offset, false);
    offset += 4;
    if (pathLen < 1 || pathLen > 4096 || offset + pathLen + 5 > bytes.byteLength) {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }
    let name: string;
    try {
      name = decoder.decode(bytes.subarray(offset, offset + pathLen));
    } catch {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }
    offset += pathLen;

    const validRel = validateRelativePath(name);
    if (
      !validRel.ok
      || validRel.value !== name
      || isVerifierNamespacePath(name)
      || name.split('/').some(seg => seg.toLowerCase() === '.git' || Buffer.byteLength(seg, 'utf8') > 255)
      || (prevName !== null && compareUtf16(prevName, name) >= 0)
    ) {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }
    prevName = name;
    const folded = name.normalize('NFC').toLowerCase();
    if (seenFolded.has(folded)) refuse('ARTIFACT_INVALID', '', 'verification');
    seenFolded.add(folded);

    const modeFlag = bytes[offset]!;
    offset += 1;
    if (modeFlag !== 0 && modeFlag !== 1) refuse('ARTIFACT_INVALID', '', 'verification');

    const contentLen = view.getUint32(offset, false);
    offset += 4;
    if (contentLen > bytes.byteLength - offset) refuse('ARTIFACT_INVALID', '', 'verification');
    const content = bytes.slice(offset, offset + contentLen);
    offset += contentLen;

    entries.push(
      freeze({
        name,
        mode: modeFlag === 1 ? '100755' : '100644',
        bytes: content,
      }),
    );
  }

  if (offset !== bytes.byteLength) refuse('ARTIFACT_INVALID', '', 'verification');
  for (const folded of seenFolded) {
    let slash = folded.indexOf('/');
    while (slash !== -1) {
      if (seenFolded.has(folded.slice(0, slash))) refuse('ARTIFACT_INVALID', '', 'verification');
      slash = folded.indexOf('/', slash + 1);
    }
  }
  return freeze(entries);
}

export function resolveBenchmarkBaseUrl(
  endpoint: GateEndpoint,
  gateUrlOverrides: Readonly<Record<string, string>> | undefined,
  phase: ControllerDiagnostic['phase'] = 'verification',
): string {
  let transportUrl = endpoint.url;
  if (gateUrlOverrides && Object.hasOwn(gateUrlOverrides, endpoint.id) && gateUrlOverrides[endpoint.id] !== undefined) {
    const overrideUrl = gateUrlOverrides[endpoint.id]!;
    validateGateUrlOverrides({ [endpoint.id]: overrideUrl }, phase, [endpoint]);
    transportUrl = overrideUrl;
  }
  return transportUrl.replace(/\/+$/, '');
}

async function readBoundedResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    reader.releaseLock();
  }
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** Rate-limits SQLite lease renewal callbacks during multi-chunk CAS scans without throttling cancellation checks. */
export function createRateLimitedProgress(
  onProgress: (() => void | Promise<void>) | undefined,
  minIntervalMs = 1_000,
): (() => Promise<void>) | undefined {
  if (!onProgress) return undefined;
  let lastRenewMs = performance.now();
  return async () => {
    const now = performance.now();
    if (now - lastRenewMs < minIntervalMs) return;
    lastRenewMs = now;
    await onProgress();
  };
}

export async function pullBenchmarkOutputBlobs(options: {
  readonly baseUrl: string;
  readonly operationId: string;
  readonly slotId: string;
  readonly secret: string;
  readonly bearerToken: string | null;
  readonly outputArtifacts: readonly BenchmarkOutputArtifact[];
  readonly artifacts: ArtifactStore;
  readonly signal: AbortSignal;
  readonly resolveTimeoutMs: () => number | null;
  readonly onBeforeEach?: () => void;
  readonly reuseLocalFirst?: boolean;
  readonly phase?: ControllerDiagnostic['phase'];
}): Promise<
  | { readonly ok: true; readonly refs: readonly ArtifactRef[]; readonly casOutcome: 'ok' }
  | { readonly ok: false; readonly casOutcome: 'artifact_invalid' | 'evidence_unavailable' | 'gate_timeout' }
> {
  const phase = options.phase ?? 'verification';
  const extraSecrets = [options.secret, ...(options.bearerToken !== null ? [options.bearerToken] : [])];
  const refs: ArtifactRef[] = [];
  const chunkProgress = createRateLimitedProgress(options.onBeforeEach, 1_000);

  for (const item of options.outputArtifacts) {
    options.onBeforeEach?.();
    const logicalName = `.loopwright-verifier/${options.slotId}/${item.name}`;

    if (options.reuseLocalFirst) {
      if (options.signal.aborted) {
        throw cancelledFailure(phase);
      }
      try {
        const reused = await options.artifacts.verifyOrReuseVerifierCasBlob({
          logicalName,
          expectedSha256: item.digest.hex,
          expectedByteLength: item.byteLength,
          mediaType: item.mediaType,
          maxBytes: VERIFIER_ARTIFACT_LIMITS.maxFileBytes,
          phase,
          extraSecrets,
          signal: options.signal,
          onProgress: chunkProgress,
        });
        if (options.signal.aborted) {
          throw cancelledFailure(phase);
        }
        if (reused !== null) {
          refs.push(reused.blobRef);
          continue;
        }
      } catch (error) {
        if (options.signal.aborted) {
          throw cancelledFailure(phase);
        }
        if (error instanceof ControllerFailure && error.diagnostic.code === 'ARTIFACT_INVALID') {
          return { ok: false, casOutcome: 'artifact_invalid' };
        }
        throw error;
      }
    }

    const timeoutMs = options.resolveTimeoutMs();
    if (timeoutMs === null || timeoutMs <= 0) {
      return { ok: false, casOutcome: 'gate_timeout' };
    }
    const url = `${options.baseUrl}/${encodeURIComponent(options.operationId)}/blobs/${item.digest.hex}`;
    const headers: Record<string, string> = {
      'x-loopwright-signature': signPayload(options.secret, `GET\n${options.operationId}\n${item.digest.hex}`),
    };
    if (options.bearerToken !== null) headers.authorization = 'Bearer ' + options.bearerToken;

    const composed = AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]);
    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', headers, redirect: 'error', signal: composed });
    } catch {
      if (options.signal.aborted) {
        throw new ControllerFailure({
          version: 1,
          code: 'CANCELLED',
          phase,
          path: '',
          stateCode: null,
          piCode: null,
          effect: 'none',
          retryable: false,
        });
      }
      const nextWindow = options.resolveTimeoutMs();
      return { ok: false, casOutcome: nextWindow === null || nextWindow <= 0 ? 'gate_timeout' : 'evidence_unavailable' };
    }

    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, casOutcome: 'evidence_unavailable' };
    }

    const headerSha = response.headers.get('x-loopwright-blob-sha256') ?? '';
    const headerLen = response.headers.get('x-loopwright-blob-length') ?? '';
    const headerSig = response.headers.get('x-loopwright-signature') ?? '';
    const expectedSigned = `BLOB\n${options.operationId}\n${item.digest.hex}\n${String(item.byteLength)}`;
    if (
      headerSha !== item.digest.hex
      || headerLen !== String(item.byteLength)
      || !verifySignedPayload(options.secret, expectedSigned, headerSig)
    ) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, casOutcome: 'artifact_invalid' };
    }

    let streamTransportError = false;
    try {
      const pointer = await options.artifacts.ingestVerifiedCasBlobStream(
        {
          logicalName,
          expectedSha256: item.digest.hex,
          expectedByteLength: item.byteLength,
          mediaType: item.mediaType,
          maxBytes: VERIFIER_ARTIFACT_LIMITS.maxFileBytes,
          phase,
          extraSecrets,
          signal: options.signal,
          onProgress: chunkProgress,
        },
        async consumeChunk => {
          if (!response.body) return;
          const reader = response.body.getReader();
          try {
            for (;;) {
              let step: ReadableStreamReadResult<Uint8Array>;
              try {
                step = await reader.read();
              } catch (err) {
                streamTransportError = true;
                throw err;
              }
              if (step.done) break;
              if (step.value && step.value.byteLength > 0) {
                await consumeChunk(step.value);
              }
            }
          } finally {
            reader.releaseLock();
          }
        },
      );
      refs.push(pointer.blobRef);
    } catch (error) {
      await response.body?.cancel().catch(() => {});
      if (options.signal.aborted) {
        throw new ControllerFailure({
          version: 1,
          code: 'CANCELLED',
          phase,
          path: '',
          stateCode: null,
          piCode: null,
          effect: 'none',
          retryable: false,
        });
      }
      if (error instanceof ControllerFailure && error.diagnostic.code === 'ARTIFACT_INVALID' && !streamTransportError) {
        return { ok: false, casOutcome: 'artifact_invalid' };
      }
      if (streamTransportError) {
        const nextWindow = options.resolveTimeoutMs();
        return { ok: false, casOutcome: nextWindow === null || nextWindow <= 0 ? 'gate_timeout' : 'evidence_unavailable' };
      }
      throw error;
    }
  }

  return { ok: true, refs: freeze(refs), casOutcome: 'ok' };
}

export function isPreemptedBenchmarkVerdict(verdict: BenchmarkVerdict): boolean {
  return (
    verdict.status !== 'pending'
    && verdict.status !== 'approved'
    && (verdict.retryablePreemption === true || verdict.reason === 'BENCHMARK_PREEMPTED')
  );
}

export function shouldPullBenchmarkOutputs(input: {
  readonly verdict: BenchmarkVerdict | null;
  readonly wallClockValid: boolean;
  readonly targetHardware: HardwareTargetSpec;
  readonly targetCellId: string;
  readonly allowSyntheticHardwareProbe: boolean;
  readonly metricThresholds: readonly MetricThresholdRule[];
}): boolean {
  const { verdict } = input;
  if (
    verdict === null
    || verdict.outputArtifacts === undefined
    || verdict.outputArtifacts.length === 0
    || isPreemptedBenchmarkVerdict(verdict)
  ) {
    return false;
  }
  if (verdict.status === 'denied') {
    return (
      verdict.hardwareProvenance === undefined
      || matchesHardwareTarget(
        input.targetHardware,
        input.targetCellId,
        input.allowSyntheticHardwareProbe,
        verdict.hardwareProvenance,
      )
    );
  }
  if (verdict.status === 'approved') {
    return (
      input.wallClockValid
      && matchesHardwareTarget(
        input.targetHardware,
        input.targetCellId,
        input.allowSyntheticHardwareProbe,
        verdict.hardwareProvenance,
      )
      && evaluateBenchmarkThresholds(input.metricThresholds, verdict.metrics)
    );
  }
  return false;
}

export async function collectPriorGenerationVerifierBudget(
  plan: CompiledPlan,
  artifacts: ArtifactStore,
  generation: number,
  excludeSlotId: string,
  inMemoryChecks?: ReadonlyMap<string, VerifiedCheck>,
  retainedReceipts?: ControllerProgress['verifierReceipts'],
): Promise<VerifierBudgetUsage> {
  let files = 0;
  let bytes = 0;
  for (const slot of plan.verifierSlots) {
    if (slot.id === excludeSlotId || slot.handler.implementation !== 'benchmark-gate.v1') continue;
    const mem = inMemoryChecks?.get(slot.id + ':' + generation);
    if (mem) {
      const obs = observations.get(mem);
      if (obs) {
        files += obs.verifierArtifacts.length;
        for (const ref of obs.verifierArtifacts) bytes += ref.byteLength;
        continue;
      }
    }
    const row = retainedReceipts?.find(
      item => item.slot === slot.id && item.generation === generation && item.output !== null && item.receipt !== null,
    );
    if (!row || !row.output) continue;
    const rawOut = parsePrivateJson(await artifacts.read(row.output, BENCHMARK_OUTPUT_BYTES), BENCHMARK_OUTPUT_BYTES);
    if (!isRecord(rawOut) || !Array.isArray(rawOut.verifierArtifacts)) continue;
    for (const rawRef of list(rawOut.verifierArtifacts, '', VERIFIER_ARTIFACT_LIMITS.maxFilesPerSlot)) {
      const ref = checkedVerifierArtifactRef(rawRef, 'recovery');
      files += 1;
      bytes += ref.byteLength;
    }
  }
  return freeze({ files, bytes });
}

export function computeBenchmarkDisposition(input: {
  readonly verdict: BenchmarkVerdict | null;
  readonly timedOut: boolean;
  readonly sawPreemption: boolean;
  readonly wallClockValid: boolean;
  readonly targetHardware: HardwareTargetSpec;
  readonly targetCellId: string;
  readonly allowSyntheticHardwareProbe: boolean;
  readonly metricThresholds: readonly MetricThresholdRule[];
  readonly casOutcome: 'ok' | 'artifact_invalid' | 'evidence_unavailable' | 'gate_timeout';
}): BenchmarkDisposition {
  const { verdict, timedOut, sawPreemption } = input;
  if (!verdict || verdict.status === 'pending') {
    if (timedOut) {
      if (sawPreemption) {
        return freeze({ status: 'blocked', reason: 'BENCHMARK_PREEMPTED', method: 'benchmark_transport', retryablePreemption: true });
      }
      return freeze({ status: 'blocked', reason: 'GATE_TIMEOUT', method: 'benchmark_transport' });
    }
    return freeze({ status: 'blocked', reason: 'EVIDENCE_UNAVAILABLE', method: 'benchmark_transport' });
  }

  if (isPreemptedBenchmarkVerdict(verdict)) {
    return freeze({ status: 'blocked', reason: 'BENCHMARK_PREEMPTED', method: 'benchmark-gate.v1', retryablePreemption: true });
  }

  const preemptionField = verdict.retryablePreemption !== undefined ? { retryablePreemption: verdict.retryablePreemption } : {};

  if (verdict.status === 'expired') {
    return freeze({
      status: 'blocked',
      reason: verdict.reason ?? 'EVIDENCE_UNAVAILABLE',
      method: 'benchmark-gate.v1',
      ...preemptionField,
    });
  }

  if (verdict.status === 'denied') {
    if (
      verdict.hardwareProvenance !== undefined
      && !matchesHardwareTarget(
        input.targetHardware,
        input.targetCellId,
        input.allowSyntheticHardwareProbe,
        verdict.hardwareProvenance,
      )
    ) {
      return freeze({ status: 'blocked', reason: 'HARDWARE_PROVENANCE_MISMATCH', method: 'benchmark-gate.v1', ...preemptionField });
    }
    if (input.casOutcome === 'artifact_invalid') {
      return freeze({ status: 'blocked', reason: 'ARTIFACT_INVALID', method: 'benchmark-gate.v1', ...preemptionField });
    }
    if (input.casOutcome === 'gate_timeout') {
      if (sawPreemption) {
        return freeze({ status: 'blocked', reason: 'BENCHMARK_PREEMPTED', method: 'benchmark_transport', retryablePreemption: true });
      }
      return freeze({ status: 'blocked', reason: 'GATE_TIMEOUT', method: 'benchmark_transport', ...preemptionField });
    }
    if (input.casOutcome === 'evidence_unavailable') {
      return freeze({ status: 'blocked', reason: 'EVIDENCE_UNAVAILABLE', method: 'benchmark_transport', ...preemptionField });
    }
    return freeze({
      status: 'failed',
      reason: verdict.reason ?? 'benchmark_denied',
      method: 'benchmark-gate.v1',
      ...preemptionField,
    });
  }

  // verdict.status === 'approved'
  if (input.casOutcome === 'artifact_invalid') {
    return freeze({ status: 'blocked', reason: 'ARTIFACT_INVALID', method: 'benchmark-gate.v1', ...preemptionField });
  }
  if (!input.wallClockValid) {
    return freeze({ status: 'blocked', reason: 'EVIDENCE_UNAVAILABLE', method: 'benchmark-gate.v1', ...preemptionField });
  }
  if (
    !matchesHardwareTarget(
      input.targetHardware,
      input.targetCellId,
      input.allowSyntheticHardwareProbe,
      verdict.hardwareProvenance,
    )
  ) {
    return freeze({ status: 'blocked', reason: 'HARDWARE_PROVENANCE_MISMATCH', method: 'benchmark-gate.v1', ...preemptionField });
  }
  if (!evaluateBenchmarkThresholds(input.metricThresholds, verdict.metrics)) {
    return freeze({ status: 'blocked', reason: 'METRIC_THRESHOLD_FAILED', method: 'benchmark-gate.v1', ...preemptionField });
  }
  if (input.casOutcome === 'gate_timeout') {
    if (sawPreemption) {
      return freeze({ status: 'blocked', reason: 'BENCHMARK_PREEMPTED', method: 'benchmark_transport', retryablePreemption: true });
    }
    return freeze({ status: 'blocked', reason: 'GATE_TIMEOUT', method: 'benchmark_transport', ...preemptionField });
  }
  if (input.casOutcome === 'evidence_unavailable') {
    return freeze({ status: 'blocked', reason: 'EVIDENCE_UNAVAILABLE', method: 'benchmark_transport', ...preemptionField });
  }
  return freeze({ status: 'passed', reason: null, method: 'benchmark-gate.v1', ...preemptionField });
}

function computeBoundedBackoffDelayMs(
  endpoint: GateEndpoint,
  operationId: string,
  attempt: number,
  remainingMonoMs: number,
  remainingMaxPollMs: number,
): number {
  const exponential = Math.min(endpoint.pollMaxMs, endpoint.pollInitialMs * 2 ** Math.min(30, Math.max(0, attempt - 1)));
  const jitterSeed = endpoint.jitter
    ? parseInt(
        hash(
          'loopwright.dev/controller/benchmark-jitter/v1\0'
            + canonical({ operationId, attempt }),
        ).hex.slice(0, 8),
        16,
      )
    : 0;
  const withJitter = exponential + (endpoint.jitter ? jitterSeed % (endpoint.jitter + 1) : 0);
  return Math.min(withJitter, remainingMonoMs, remainingMaxPollMs);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(cancelledFailure('verification'));
  return new Promise((resolve, reject) => {
    const onDone = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(cancelledFailure('verification'));
    };
    const timer = setTimeout(onDone, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function validateStoredBenchmarkProof(input: {
  readonly proofBytes: Buffer;
  readonly artifacts: ArtifactStore;
  readonly plan: CompiledPlan;
  readonly slot: VerifierSlot;
  readonly endpoint: GateEndpoint;
  readonly targetHardware: HardwareTargetSpec;
  readonly targetCellId: string;
  readonly allowSyntheticHardwareProbe: boolean;
  readonly metricThresholds: readonly MetricThresholdRule[];
  readonly view: RunView;
  readonly operation: OperationRecord;
  readonly dispatch: NonNullable<OperationRecord['dispatch']>;
  readonly operationId: string;
  readonly producerNonce: string;
  readonly generation: number;
  readonly subject: Subject;
  readonly request: Record<string, unknown>;
  readonly requestBytesDigest: string;
  readonly secret: string;
  readonly bearerToken: string | null;
  readonly priorBudget?: VerifierBudgetUsage;
  readonly totalLimits?: VerifierTotalLimits;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: (() => void | Promise<void>) | undefined;
  readonly allowInvalidLocalCasSettlement?: boolean | undefined;
}): Promise<{
  readonly output: ArtifactRef;
  readonly outputBytes: Uint8Array;
  readonly receiptRef: ArtifactRef;
  readonly receipt: OperationReceipt;
  readonly evidence: Evidence;
  readonly verdict: BenchmarkVerdict | null;
  readonly verifierCasRefs: readonly ArtifactRef[];
  readonly localCasInvalid: boolean;
  readonly disposition: BenchmarkDisposition;
  readonly observation: {
    readonly attempts: number;
    readonly elapsedMs: number;
    readonly transport: 'completed' | 'deadline';
    readonly sawPreemption: boolean;
    readonly wallClockValid: boolean;
    readonly casOutcome: 'ok' | 'artifact_invalid' | 'evidence_unavailable' | 'gate_timeout';
  };
  readonly responseBytesBase64: string | null;
  readonly responseSignature: string | null;
}> {
  const proof = record(parsePrivateJson(input.proofBytes, 1_048_576), ['version', 'output', 'receipt', 'evidence']);
  if (proof.version !== 1) refuse('RECOVERY_REQUIRED', '', 'recovery');
  const output = checkedRef(proof.output);
  const receiptRef = checkedRef(proof.receipt);
  const outputBytes = await input.artifacts.read(output, BENCHMARK_OUTPUT_BYTES);
  const saved = record(parsePrivateJson(Buffer.from(outputBytes), BENCHMARK_OUTPUT_BYTES), [
    'version',
    'binding',
    'observation',
    'verdict',
    'responseBytes',
    'responseSignature',
    'verifierArtifacts',
    'disposition',
  ]);
  const savedBinding = record(saved.binding, [
    'planDigest',
    'operationId',
    'producerNonce',
    'generation',
    'endpoint',
    'subject',
    'requestBytesDigest',
  ]);
  if (
    saved.version !== 1
    || !same(savedBinding, {
      planDigest: input.plan.planDigest,
      operationId: input.operationId,
      producerNonce: input.producerNonce,
      generation: input.generation,
      endpoint: input.endpoint.id,
      subject: input.subject,
      requestBytesDigest: input.requestBytesDigest,
    })
  ) {
    refuse('RECOVERY_REQUIRED', '', 'recovery');
  }

  const observation = record(saved.observation, [
    'attempts',
    'elapsedMs',
    'transport',
    'sawPreemption',
    'wallClockValid',
    'casOutcome',
  ]);
  integer(observation.attempts, 1, 65_536);
  integer(observation.elapsedMs, 0, Number.MAX_SAFE_INTEGER);
  if (
    !['completed', 'deadline'].includes(text(observation.transport))
    || typeof observation.sawPreemption !== 'boolean'
    || typeof observation.wallClockValid !== 'boolean'
    || !['ok', 'artifact_invalid', 'evidence_unavailable', 'gate_timeout'].includes(text(observation.casOutcome))
  ) {
    refuse('RECOVERY_REQUIRED', '', 'recovery');
  }

  let verdict: BenchmarkVerdict | null = null;
  if (saved.verdict !== null && typeof saved.responseBytes === 'string' && typeof saved.responseSignature === 'string') {
    const responseBytes = Buffer.from(saved.responseBytes, 'base64');
    if (responseBytes.byteLength > BENCHMARK_RESPONSE_BYTES) refuse('RECOVERY_REQUIRED', '', 'recovery');
    if (!verifySignedPayload(input.secret, responseBytes, saved.responseSignature)) {
      refuse('EVIDENCE_UNAVAILABLE', '', 'recovery');
    }
    const expected = {
      storeId: input.view.storeId,
      runId: input.view.runId,
      lockHash: input.view.lockHash,
      operationId: input.operationId,
      dispatchId: input.dispatch.dispatchId,
      dispatchGeneration: input.dispatch.generation,
      gateId: String(input.request.gateId),
      checkId: String(input.request.checkId),
      candidateDigest: String(input.request.candidateDigest),
      slotId: input.slot.id,
    };
    const parsed = checkedBenchmarkVerdict(parsePrivateJson(responseBytes, BENCHMARK_RESPONSE_BYTES), expected);
    if (!same(saved.verdict, parsed) || parsed.status === 'pending') refuse('RECOVERY_REQUIRED', '', 'recovery');
    verdict = parsed;
  } else if (saved.verdict !== null || saved.responseBytes !== null || saved.responseSignature !== null) {
    refuse('RECOVERY_REQUIRED', '', 'recovery');
  }

  const savedRefsRaw = list(saved.verifierArtifacts, '', VERIFIER_ARTIFACT_LIMITS.maxFilesPerSlot);
  const parsedSavedRefs = savedRefsRaw.map(rawRef => checkedVerifierArtifactRef(rawRef, 'recovery'));
  const extraSecrets = [input.secret, ...(input.bearerToken !== null ? [input.bearerToken] : [])];
  const priorBudget = input.priorBudget ?? { files: 0, bytes: 0 };
  const totalLimits = input.totalLimits ?? VERIFIER_ARTIFACT_LIMITS;

  const casOutcome = observation.casOutcome as 'ok' | 'artifact_invalid' | 'evidence_unavailable' | 'gate_timeout';
  const expectedPull = shouldPullBenchmarkOutputs({
    verdict,
    wallClockValid: observation.wallClockValid,
    targetHardware: input.targetHardware,
    targetCellId: input.targetCellId,
    allowSyntheticHardwareProbe: input.allowSyntheticHardwareProbe,
    metricThresholds: input.metricThresholds,
  });

  const expectedOutputs = verdict?.outputArtifacts ?? [];
  if (casOutcome !== 'ok' || !expectedPull) {
    if (parsedSavedRefs.length !== 0) refuse('RECOVERY_REQUIRED', '', 'recovery');
  } else {
    if (parsedSavedRefs.length !== expectedOutputs.length) refuse('RECOVERY_REQUIRED', '', 'recovery');
    for (let idx = 0; idx < expectedOutputs.length; idx++) {
      const expOut = expectedOutputs[idx]!;
      const obsRef = parsedSavedRefs[idx]!;
      const expectedCanonicalRef = expectedBenchmarkOutputArtifactRef(input.slot.id, expOut, 'recovery');
      if (!same(obsRef, expectedCanonicalRef)) {
        refuse('RECOVERY_REQUIRED', '', 'recovery');
      }
    }
  }

  // Prevalidate cross-slot file count and aggregate byte budget across ALL proposed refs BEFORE hashing/reusing any local CAS blob.
  if (priorBudget.files + parsedSavedRefs.length > totalLimits.maxTotalFiles) {
    refuse('RECOVERY_REQUIRED', '', 'recovery');
  }
  let proposedBytes = 0;
  for (const ref of parsedSavedRefs) {
    if (ref.byteLength > totalLimits.maxTotalBytes - priorBudget.bytes - proposedBytes) {
      refuse('RECOVERY_REQUIRED', '', 'recovery');
    }
    proposedBytes += ref.byteLength;
  }

  const verifierCasRefs: ArtifactRef[] = [];
  let localCasInvalid = false;
  for (let idx = 0; idx < parsedSavedRefs.length; idx++) {
    if (input.signal?.aborted) {
      refuse('CANCELLED', '', 'recovery');
    }
    if (input.onProgress) {
      await input.onProgress();
    }
    const ref = parsedSavedRefs[idx]!;
    const expOut = expectedOutputs[idx]!;
    let verified: Awaited<ReturnType<ArtifactStore['verifyOrReuseVerifierCasBlob']>>;
    try {
      verified = await input.artifacts.verifyOrReuseVerifierCasBlob({
        logicalName: ref.name,
        expectedSha256: ref.digest.hex,
        expectedByteLength: ref.byteLength,
        mediaType: expOut.mediaType,
        maxBytes: VERIFIER_ARTIFACT_LIMITS.maxFileBytes,
        phase: 'recovery',
        extraSecrets,
        signal: input.signal,
        onProgress: input.onProgress,
      });
    } catch (error) {
      if (
        error instanceof ControllerFailure
        && (error.diagnostic.code === 'CANCELLED'
          || error.diagnostic.code === 'AUTHORITY_REFUSED'
          || error.diagnostic.code === 'OWNER_BUSY')
      ) {
        throw error;
      }
      if (
        input.allowInvalidLocalCasSettlement === true
        && error instanceof ControllerFailure
        && error.diagnostic.code === 'ARTIFACT_INVALID'
      ) {
        localCasInvalid = true;
        break;
      }
      throw error;
    }
    if (!verified || !same(verified.blobRef, ref)) {
      if (input.allowInvalidLocalCasSettlement === true) {
        localCasInvalid = true;
        break;
      }
      refuse('RECOVERY_REQUIRED', '', 'recovery');
    }
    verifierCasRefs.push(verified.blobRef);
  }
  if (input.signal?.aborted) {
    refuse('CANCELLED', '', 'recovery');
  }
  if (input.onProgress) {
    await input.onProgress();
  }

  const dispositioned = computeBenchmarkDisposition({
    verdict,
    timedOut: observation.transport === 'deadline',
    sawPreemption: observation.sawPreemption,
    wallClockValid: observation.wallClockValid,
    targetHardware: input.targetHardware,
    targetCellId: input.targetCellId,
    allowSyntheticHardwareProbe: input.allowSyntheticHardwareProbe,
    metricThresholds: input.metricThresholds,
    casOutcome,
  });
  if (!same(saved.disposition, dispositioned)) refuse('RECOVERY_REQUIRED', '', 'recovery');

  const suffix = hash(input.operationId + '\0' + input.producerNonce).hex.slice(0, 40);
  const evidenceArtifacts = localCasInvalid ? parsedSavedRefs : verifierCasRefs;
  const evidenceSpec = {
    checkId: input.slot.checkId,
    observedStatus: dispositioned.status,
    producerId: 'loopwright.benchmark-gate.v1',
    method: dispositioned.method,
    level: 'hardware_execution' as const,
    subject: input.subject,
    artifacts: [output, ...evidenceArtifacts],
    reason: dispositioned.reason,
    ...(verdict && Object.hasOwn(verdict, 'detail') ? { detail: verdict.detail } : {}),
    ...(verdict?.metrics !== undefined ? { metrics: verdict.metrics } : {}),
    ...(verdict?.findings !== undefined ? { findings: verdict.findings } : {}),
    ...(verdict?.hardwareProvenance !== undefined ? { hardwareProvenance: verdict.hardwareProvenance } : {}),
  };
  const evidence = validateDocument(
    { apiVersion: 'loopwright.dev/v1alpha1', kind: 'Evidence', metadata: { id: 'evidence.' + suffix }, spec: evidenceSpec },
    'Evidence',
  );
  if (!evidence.ok || !same(evidence.value, proof.evidence)) refuse('RECOVERY_REQUIRED', '', 'recovery');

  const receipt: OperationReceipt = {
    receiptId: 'receipt.' + suffix,
    outcome: dispositioned.method === 'benchmark-gate.v1' ? 'succeeded' : 'failed',
    evidence: {
      evidenceId: 'receipt-evidence.' + suffix,
      producerId: 'loopwright.benchmark-gate.v1',
      method: dispositioned.method,
      subject: {
        storeId: input.view.storeId,
        runId: input.view.runId,
        lockHash: input.view.lockHash,
        operationId: input.operationId,
        requestId: null,
        intentDigest: input.operation.intentDigest,
        dispatchGeneration: input.dispatch.generation,
        dispatchId: input.dispatch.dispatchId,
      },
      artifact: output,
    },
  };
  if (!same(parsePrivateJson(await input.artifacts.read(receiptRef, 65_536), 65_536), receipt)) {
    refuse('RECOVERY_REQUIRED', '', 'recovery');
  }

  return {
    output,
    outputBytes,
    receiptRef,
    receipt,
    evidence: evidence.value,
    verdict,
    verifierCasRefs: freeze(localCasInvalid ? [] : verifierCasRefs),
    localCasInvalid,
    disposition: dispositioned,
    observation: freeze({
      attempts: observation.attempts as number,
      elapsedMs: observation.elapsedMs as number,
      transport: observation.transport as 'completed' | 'deadline',
      sawPreemption: observation.sawPreemption,
      wallClockValid: observation.wallClockValid,
      casOutcome,
    }),
    responseBytesBase64: typeof saved.responseBytes === 'string' ? saved.responseBytes : null,
    responseSignature: typeof saved.responseSignature === 'string' ? saved.responseSignature : null,
  };
}

function validateCandidateFilesForStaging(manifest: ArtifactManifest, files: readonly CandidateFileEntry[]): ReadonlyMap<string, CandidateFileEntry> {
  if (files.length !== manifest.spec.entries.length) {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
  const byName = new Map<string, CandidateFileEntry>();
  for (const file of files) {
    if (byName.has(file.name)) refuse('ARTIFACT_INVALID', '', 'verification');
    byName.set(file.name, file);
  }
  const out = new Map<string, CandidateFileEntry>();
  for (const entry of manifest.spec.entries) {
    const file = byName.get(entry.name);
    if (!file) refuse('ARTIFACT_INVALID', '', 'verification');
    const rawFileRec = file as unknown as Record<string, unknown>;
    if (Object.hasOwn(rawFileRec, 'mode') && rawFileRec.mode !== undefined && rawFileRec.mode !== '100644' && rawFileRec.mode !== '100755') {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }
    if ('bytes' in file) {
      if ('blobPath' in file) refuse('ARTIFACT_INVALID', '', 'verification');
      const copy = ownedBytes(file.bytes, VERIFIER_ARTIFACT_LIMITS.maxFileBytes);
      if (copy.byteLength !== entry.byteLength || hash(copy).hex !== entry.digest.hex) {
        refuse('ARTIFACT_INVALID', '', 'verification');
      }
      out.set(entry.name, {
        name: entry.name,
        bytes: copy,
        ...(file.mode !== undefined ? { mode: file.mode } : {}),
      });
    } else {
      if (
        typeof file.blobPath !== 'string'
        || !isAbsolute(file.blobPath)
        || file.blobPath.length > 4096
        || /[\0\r\n]/.test(file.blobPath)
        || file.byteLength !== entry.byteLength
        || !same(file.digest, entry.digest)
      ) {
        refuse('ARTIFACT_INVALID', '', 'verification');
      }
      out.set(entry.name, file);
    }
  }
  return out;
}

type StreamingFetchInit = RequestInit & { readonly duplex?: 'half' };

/** Authenticated remote benchmark gate client with streaming HTTP CAS staging/retrieval and Relay preemption safety. */
export class BenchmarkGate {
  constructor(
    readonly store: LocalRunStore,
    readonly authority: Authority,
    readonly artifacts: ArtifactStore,
    readonly plan: CompiledPlan,
    readonly lock: TaskLock,
    readonly resolveCredential: (ref: string) => string,
    readonly currentSubject: () => Subject,
    readonly onWait: ((detail: GateWaitDetail) => Promise<void>) | null = null,
    readonly gateUrlOverrides?: Readonly<Record<string, string>>,
    readonly resolvePriorVerifierBudget?: (
      generation: number,
      excludeSlotId: string,
    ) => Promise<VerifierBudgetUsage> | VerifierBudgetUsage,
    readonly verifierTotalLimits?: VerifierTotalLimits,
  ) {}

  #identity(): RunView {
    const view = stateValue(this.store.inspect());
    if (
      view.storeId !== this.authority.storeId
      || view.runId !== this.lock.spec.runId
      || !same(view.lockHash, this.lock.spec.lockHash)
      || this.artifacts.owner.runId !== view.runId
      || !same(this.artifacts.owner.planDigest, this.plan.planDigest)
    ) {
      refuse('AUTHORITY_REFUSED', '', 'verification');
    }
    return view;
  }

  #permit(permit: DispatchPermit, expected: Subject, target: string): void {
    stateValue(this.store.renew(this.authority));
    const view = stateValue(this.store.inspect());
    const operation = stateValue(this.store.getOperation(permit.operationId));
    if (
      !same(this.currentSubject(), expected)
      || permit.generation !== this.authority.generation
      || permit.clockEpoch !== view.clock.basis.clockEpoch
      || view.storeId !== permit.storeId
      || view.runId !== permit.runId
      || !same(view.lockHash, permit.lockHash)
      || BigInt(view.clock.sampledNow.monotonicMs) >= BigInt(permit.notAfterMonotonicMs)
      || BigInt(view.clock.sampledNow.monotonicMs) >= BigInt(view.clock.basis.taskDeadlineMonotonicMs)
      || operation.state !== 'dispatch_uncertain'
      || operation.dispatch?.dispatchId !== permit.dispatchId
      || operation.intent.targetIdentity !== target
    ) {
      refuse('AUTHORITY_REFUSED', '', 'verification');
    }
  }

  async #marker(operationId: string, nonce: string, kind: 'binding' | 'proof', value: unknown): Promise<void> {
    await this.artifacts.owner.assertCurrent();
    const name = 'benchmark-producer-' + hash(operationId + '\0' + nonce).hex + '.' + kind + '.json';
    const path = join(this.artifacts.directory, name);
    await publishAtomicMarker(path, value, this.artifacts.vault, 'verification');
  }

  async #putSingleBlob(
    baseUrl: string,
    operationId: string,
    secret: string,
    bearerToken: string | null,
    file: CandidateFileEntry,
    sha256Hex: string,
    byteLength: number,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<'ok' | 'invalid' | 'network'> {
    const url = `${baseUrl}/${encodeURIComponent(operationId)}/blobs/${sha256Hex}`;
    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      'content-length': String(byteLength),
      'x-loopwright-blob-sha256': sha256Hex,
      'x-loopwright-blob-length': String(byteLength),
      'x-loopwright-signature': signPayload(secret, `PUT\n${operationId}\n${sha256Hex}\n${String(byteLength)}`),
    };
    if (bearerToken !== null) headers.authorization = 'Bearer ' + bearerToken;
    const composed = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);

    if ('bytes' in file) {
      const raw = file.bytes;
      if (raw.byteLength !== byteLength || hash(raw).hex !== sha256Hex) {
        refuse('ARTIFACT_INVALID', file.name, 'verification');
      }
      let offset = 0;
      const body: BodyInit =
        byteLength === 0
          ? new Uint8Array(0)
          : new ReadableStream<Uint8Array>({
              pull(controller) {
                if (offset >= raw.byteLength) {
                  controller.close();
                  return;
                }
                const end = Math.min(raw.byteLength, offset + STREAM_CHUNK_BYTES);
                controller.enqueue(raw.subarray(offset, end));
                offset = end;
                if (offset >= raw.byteLength) controller.close();
              },
            });
      const init: StreamingFetchInit = {
        method: 'PUT',
        headers,
        body,
        redirect: 'error',
        signal: composed,
        ...(byteLength > 0 ? { duplex: 'half' } : {}),
      };
      try {
        const res = await fetch(url, init);
        await res.body?.cancel().catch(() => {});
        return res.status === 200 || res.status === 201 || res.status === 204 ? 'ok' : 'invalid';
      } catch {
        if (signal.aborted) {
          throw new ControllerFailure({
            version: 1,
            code: 'CANCELLED',
            phase: 'verification',
            path: '',
            stateCode: null,
            piCode: null,
            effect: 'none',
            retryable: false,
          });
        }
        return 'network';
      }
    }

    const canonicalBlobPath = await resolveCanonicalCasBlobPath(
      this.artifacts.directory,
      sha256Hex,
      file.blobPath,
      'verification',
    );
    let before: Awaited<ReturnType<typeof lstat>>;
    try {
      before = await lstat(canonicalBlobPath);
    } catch {
      refuse('ARTIFACT_INVALID', file.name, 'verification');
    }
    if (
      before.isSymbolicLink()
      || !before.isFile()
      || before.nlink !== 1
      || before.uid !== process.getuid?.()
      || (before.mode & 0o7777) !== 0o400
      || before.size !== byteLength
    ) {
      refuse('ARTIFACT_INVALID', file.name, 'verification');
    }

    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(canonicalBlobPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      refuse('ARTIFACT_INVALID', file.name, 'verification');
    }

    let closed = false;
    const closeHandle = async (): Promise<void> => {
      if (!closed) {
        closed = true;
        await handle.close().catch(() => {});
      }
    };

    let localCorrupt = false;
    try {
      const info = await handle.stat();
      if (
        !info.isFile()
        || info.nlink !== 1
        || info.dev !== before.dev
        || info.ino !== before.ino
        || info.uid !== process.getuid?.()
        || info.size !== byteLength
        || (info.mode & 0o7777) !== 0o400
      ) {
        localCorrupt = true;
        refuse('ARTIFACT_INVALID', file.name, 'verification');
      }

      if (byteLength === 0) {
        if (sha256Hex !== EMPTY_SHA256_HEX) {
          localCorrupt = true;
          refuse('ARTIFACT_INVALID', file.name, 'verification');
        }
        await closeHandle();
        try {
          const res = await fetch(url, {
            method: 'PUT',
            headers,
            body: new Uint8Array(0),
            redirect: 'error',
            signal: composed,
          });
          await res.body?.cancel().catch(() => {});
          return res.status === 200 || res.status === 201 || res.status === 204 ? 'ok' : 'invalid';
        } catch {
          if (signal.aborted) {
            throw new ControllerFailure({
              version: 1,
              code: 'CANCELLED',
              phase: 'verification',
              path: '',
              stateCode: null,
              piCode: null,
              effect: 'none',
              retryable: false,
            });
          }
          return 'network';
        }
      }

      const sha = createHash('sha256');
      let offset = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const toRead = Math.min(STREAM_CHUNK_BYTES, byteLength - offset);
            if (toRead <= 0) {
              controller.close();
              return;
            }
            const chunkBuf = Buffer.allocUnsafe(toRead);
            const { bytesRead } = await handle.read(chunkBuf, 0, toRead, offset);
            if (bytesRead <= 0) {
              localCorrupt = true;
              await closeHandle();
              controller.error(new Error('unexpected_eof'));
              return;
            }
            const slice = new Uint8Array(chunkBuf.buffer, chunkBuf.byteOffset, bytesRead);
            sha.update(slice);
            offset += bytesRead;
            controller.enqueue(slice);
            if (offset >= byteLength) {
              const probe = Buffer.allocUnsafe(1);
              const extra = (await handle.read(probe, 0, 1, offset)).bytesRead;
              const after = await handle.stat();
              await closeHandle();
              if (
                extra !== 0
                || offset !== byteLength
                || !after.isFile()
                || after.nlink !== 1
                || after.dev !== info.dev
                || after.ino !== info.ino
                || after.size !== info.size
                || after.mtimeMs !== info.mtimeMs
                || after.ctimeMs !== info.ctimeMs
                || (after.mode & 0o7777) !== 0o400
                || sha.digest('hex') !== sha256Hex
              ) {
                localCorrupt = true;
                controller.error(new Error('cas_integrity_failed'));
                return;
              }
              controller.close();
            }
          } catch (err) {
            await closeHandle();
            controller.error(err);
          }
        },
        async cancel() {
          await closeHandle();
        },
      });

      const init: StreamingFetchInit = {
        method: 'PUT',
        headers,
        body,
        duplex: 'half',
        redirect: 'error',
        signal: composed,
      };
      const res = await fetch(url, init);
      await res.body?.cancel().catch(() => {});
      if (localCorrupt) refuse('ARTIFACT_INVALID', file.name, 'verification');
      return res.status === 200 || res.status === 201 || res.status === 204 ? 'ok' : 'invalid';
    } catch (error) {
      if (localCorrupt || (error instanceof ControllerFailure && error.diagnostic.code === 'ARTIFACT_INVALID')) {
        refuse('ARTIFACT_INVALID', file.name, 'verification');
      }
      if (signal.aborted) {
        throw new ControllerFailure({
          version: 1,
          code: 'CANCELLED',
          phase: 'verification',
          path: '',
          stateCode: null,
          piCode: null,
          effect: 'none',
          retryable: false,
        });
      }
      return 'network';
    } finally {
      await closeHandle();
    }
  }

  async #roundTrip(
    baseUrl: string,
    secret: string,
    bearerToken: string | null,
    requestBody: Buffer,
    signal: AbortSignal,
    binding: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<RoundTrip> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-loopwright-signature': signPayload(secret, requestBody),
    };
    if (bearerToken !== null) headers.authorization = 'Bearer ' + bearerToken;
    const composed = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    let bytes: Uint8Array | null;
    let signature: string;
    try {
      const response = await fetch(baseUrl, {
        method: 'POST',
        headers,
        body: new Uint8Array(requestBody),
        redirect: 'error',
        signal: composed,
      });
      if (response.status !== 200 || !(response.headers.get('content-type') ?? '').startsWith('application/json')) {
        await response.body?.cancel().catch(() => {});
        return { kind: 'invalid' };
      }
      signature = response.headers.get('x-loopwright-signature') ?? '';
      bytes = await readBoundedResponseBytes(response, BENCHMARK_RESPONSE_BYTES);
    } catch {
      if (signal.aborted) {
        throw new ControllerFailure({
          version: 1,
          code: 'CANCELLED',
          phase: 'verification',
          path: '',
          stateCode: null,
          piCode: null,
          effect: 'none',
          retryable: false,
        });
      }
      return { kind: 'network' };
    }
    if (bytes === null || bytes.byteLength > BENCHMARK_RESPONSE_BYTES || !verifySignedPayload(secret, bytes, signature)) {
      return { kind: 'invalid' };
    }
    try {
      const verdict = checkedBenchmarkVerdict(parsePrivateJson(Buffer.from(bytes), BENCHMARK_RESPONSE_BYTES), binding);
      return { kind: 'verdict', verdict, responseBytes: bytes, signature };
    } catch {
      return { kind: 'invalid' };
    }
  }

  async run(job: PreparedBenchmarkGate, signal: AbortSignal): Promise<VerifiedCheck> {
    const data = preparations.get(job);
    if (!data || this.plan.verifierSlots.find(slot => slot.id === job.slotId) !== data.slot) {
      refuse('EVIDENCE_UNAVAILABLE', '', 'verification');
    }
    signal.throwIfAborted();
    await this.artifacts.owner.assertCurrent();
    if (!same(this.currentSubject(), data.subject)) refuse('ARTIFACT_INVALID', '', 'verification');
    const done = await this.artifacts.owner.holdLocalActivity();
    try {
      const target = 'benchmark:' + job.slotId + ':' + job.generation + ':' + data.subject.candidateDigest.hex;
      const before = this.#identity();
      if (before.owner.mode !== 'active') refuse('AUTHORITY_REFUSED', '', 'verification');
      if (
        before.counts.dispatchedRequests
        || before.counts.unresolvedRequests
        || before.counts.unresolvedOperations
        || before.ledger.violations.length
      ) {
        refuse('RECOVERY_REQUIRED', '', 'verification');
      }

      const baseUrl = resolveBenchmarkBaseUrl(data.endpoint, this.gateUrlOverrides, 'verification');
      const expectedBase = expectedBenchmarkRequest(
        this.plan,
        data.slot,
        data.endpoint,
        data.subject,
        data.manifest,
        data.baseTreeBundle,
        data.files,
      );
      const worstCaseRequest: Record<string, unknown> = {
        ...expectedBase,
        storeId: before.storeId,
        runId: before.runId,
        lockHash: before.lockHash,
        operationId: job.operationId,
        dispatchId: MAX_PREFLIGHT_DISPATCH_ID,
        dispatchGeneration: Math.max(this.authority.generation, MAX_PREFLIGHT_DISPATCH_GENERATION),
        requestDigest: job.requestDigest.hex,
      };
      if (Buffer.byteLength(canonical(worstCaseRequest), 'utf8') > BENCHMARK_REQUEST_BYTES) {
        refuse('OUTPUT_LIMIT', '', 'verification');
      }

      stateValue(
        this.store.putIntent(this.authority, {
          operationId: job.operationId,
          nodeId: this.plan.orderedDAG[0]!.id,
          attemptId: 'job.' + hash(job.operationId + '\0' + job.producerNonce).hex.slice(0, 40),
          effect: 'read_only',
          requestDigest: job.requestDigest,
          targetIdentity: target,
        }),
      );
      const dispatched = stateValue(this.store.authorizeOperationDispatch(this.authority, job.operationId));
      if (dispatched.kind !== 'new_dispatch') refuse('RECOVERY_REQUIRED', '', 'verification');
      const permit = dispatched.permit;

      const request: Record<string, unknown> = {
        ...expectedBase,
        storeId: before.storeId,
        runId: before.runId,
        lockHash: before.lockHash,
        operationId: job.operationId,
        dispatchId: permit.dispatchId,
        dispatchGeneration: permit.generation,
        requestDigest: job.requestDigest.hex,
      };
      const requestBody = Buffer.from(canonical(request), 'utf8');
      if (requestBody.byteLength > BENCHMARK_REQUEST_BYTES) {
        refuse('OUTPUT_LIMIT', '', 'verification');
      }
      const requestBytesDigest = hash(requestBody).hex;
      const intentDigest = stateValue(this.store.getOperation(job.operationId)).intentDigest;

      await this.#marker(job.operationId, job.producerNonce, 'binding', {
        version: 1,
        planDigest: this.plan.planDigest,
        operationId: job.operationId,
        producerNonce: job.producerNonce,
        requestDigest: job.requestDigest,
        requestBytesDigest,
        intentDigest,
        subject: data.subject,
        generation: job.generation,
        endpoint: data.endpoint.id,
        dispatchReceipt: {
          generation: permit.generation,
          dispatchId: permit.dispatchId,
          revision: permit.authorizedRevision,
          clockEpoch: permit.clockEpoch,
        },
      });

      const secret = this.resolveCredential(data.endpoint.signingCredentialRef);
      const bearerToken =
        data.endpoint.authCredentialRef !== null ? this.resolveCredential(data.endpoint.authCredentialRef) : null;
      const started = performance.now();
      const startMono = BigInt(before.clock.sampledNow.monotonicMs);
      const maxPollMono = startMono + BigInt(data.endpoint.maxPollMs);
      const permitCapMono =
        BigInt(permit.notAfterMonotonicMs) > 2000n
          ? BigInt(permit.notAfterMonotonicMs) - 2000n
          : BigInt(permit.notAfterMonotonicMs);
      const drain = BigInt(this.plan.controls.drainReserveMs);
      const taskCapMono =
        BigInt(before.clock.basis.taskDeadlineMonotonicMs) > drain + 2000n
          ? BigInt(before.clock.basis.taskDeadlineMonotonicMs) - drain - 2000n
          : BigInt(before.clock.basis.taskDeadlineMonotonicMs);
      const pollDeadlineMono = [maxPollMono, permitCapMono, taskCapMono].reduce((a, b) => (a < b ? a : b));
      const deadlineMs = Math.max(0, Number(pollDeadlineMono - startMono));

      const isPastPollDeadline = (): boolean => {
        const nowMono = BigInt(stateValue(this.store.inspect()).clock.sampledNow.monotonicMs);
        const elapsed = Math.ceil(performance.now() - started);
        return nowMono >= pollDeadlineMono || elapsed >= data.endpoint.maxPollMs;
      };

      const remainingWindowMs = (): number | null => {
        const nowMono = BigInt(stateValue(this.store.inspect()).clock.sampledNow.monotonicMs);
        const elapsed = Math.ceil(performance.now() - started);
        const remMono = Number(pollDeadlineMono - nowMono);
        const remPoll = data.endpoint.maxPollMs - elapsed;
        const windowMs = Math.min(data.endpoint.timeoutMs, remMono, remPoll);
        return windowMs <= 0 ? null : windowMs;
      };

      const waitWithBackoff = async (retryAttempt: number): Promise<boolean> => {
        if (signal.aborted) throw cancelledFailure('verification');
        const viewNow = stateValue(this.store.inspect());
        const nowMono = BigInt(viewNow.clock.sampledNow.monotonicMs);
        const elapsed = Math.ceil(performance.now() - started);
        if (nowMono >= pollDeadlineMono || elapsed >= data.endpoint.maxPollMs) return false;
        const delay = computeBoundedBackoffDelayMs(
          data.endpoint,
          job.operationId,
          retryAttempt,
          Number(pollDeadlineMono - nowMono),
          data.endpoint.maxPollMs - elapsed,
        );
        if (delay <= 0) return false;
        if (this.onWait) {
          await this.onWait({
            operationId: job.operationId,
            gateId: String(request.gateId),
            elapsedMs: elapsed,
            nextPollMs: delay,
            deadlineMs,
          });
        }
        if (signal.aborted) throw cancelledFailure('verification');
        await sleep(delay, signal);
        return true;
      };

      // Stage baseTreeBundle (when present) and candidate overlay blobs via HMAC-authenticated PUT .../blobs/:sha256 before initial POST.
      let stagingFailedInvalid = false;
      let timedOut = false;
      let stageRetries = 0;
      let pollAttempts = 0;
      const stagedDigests = new Set<string>();
      const blobsToStage: { readonly file: CandidateFileEntry; readonly digestHex: string; readonly byteLength: number }[] = [];
      if (data.baseTreeBundle !== undefined) {
        blobsToStage.push({
          file: {
            name: '.base-tree-bundle',
            byteLength: data.baseTreeBundle.byteLength,
            digest: data.baseTreeBundle.digest,
            blobPath: data.baseTreeBundle.blobPath,
          },
          digestHex: data.baseTreeBundle.digest.hex,
          byteLength: data.baseTreeBundle.byteLength,
        });
      }
      for (const entry of data.manifest.spec.entries) {
        blobsToStage.push({
          file: data.files.get(entry.name)!,
          digestHex: entry.digest.hex,
          byteLength: entry.byteLength,
        });
      }

      for (const item of blobsToStage) {
        if (stagedDigests.has(item.digestHex)) continue;
        for (;;) {
          this.#permit(permit, data.subject, target);
          const putTimeoutMs = remainingWindowMs();
          if (putTimeoutMs === null) {
            timedOut = true;
            break;
          }
          const stageRes = await this.#putSingleBlob(
            baseUrl,
            job.operationId,
            secret,
            bearerToken,
            item.file,
            item.digestHex,
            item.byteLength,
            signal,
            putTimeoutMs,
          );
          if (isPastPollDeadline()) {
            timedOut = true;
            break;
          }
          if (stageRes === 'ok') {
            stagedDigests.add(item.digestHex);
            break;
          }
          if (stageRes === 'invalid') {
            stagingFailedInvalid = true;
            break;
          }
          stageRetries++;
          if (!(await waitWithBackoff(stageRetries))) {
            timedOut = true;
            break;
          }
        }
        if (timedOut || stagingFailedInvalid) break;
      }

      let outcome: RoundTrip = stagingFailedInvalid ? { kind: 'invalid' } : { kind: 'network' };
      let sawPreemption = false;

      if (!timedOut && !stagingFailedInvalid) {
        for (;;) {
          this.#permit(permit, data.subject, target);
          const postTimeoutMs = remainingWindowMs();
          if (postTimeoutMs === null) {
            timedOut = true;
            outcome = { kind: 'network' };
            break;
          }
          outcome = await this.#roundTrip(
            baseUrl,
            secret,
            bearerToken,
            requestBody,
            signal,
            {
              storeId: before.storeId,
              runId: before.runId,
              lockHash: before.lockHash,
              operationId: job.operationId,
              dispatchId: permit.dispatchId,
              dispatchGeneration: permit.generation,
              gateId: String(request.gateId),
              checkId: String(request.checkId),
              candidateDigest: String(request.candidateDigest),
              slotId: data.slot.id,
            },
            postTimeoutMs,
          );
          pollAttempts++;
          if (isPastPollDeadline()) {
            if (
              outcome.kind === 'verdict'
              && (outcome.verdict.preemptionCount > 0 || isPreemptedBenchmarkVerdict(outcome.verdict))
            ) {
              sawPreemption = true;
            }
            timedOut = true;
            outcome = { kind: 'network' };
            break;
          }
          if (outcome.kind === 'verdict') {
            if (outcome.verdict.preemptionCount > 0 || isPreemptedBenchmarkVerdict(outcome.verdict)) {
              sawPreemption = true;
            }
            if (outcome.verdict.status !== 'pending') break;
          } else if (outcome.kind === 'invalid') {
            break;
          }
          if (!(await waitWithBackoff(pollAttempts))) {
            timedOut = true;
            outcome = { kind: 'network' };
            break;
          }
        }
      }

      const settledVerdict: BenchmarkVerdict | null =
        !timedOut && outcome.kind === 'verdict' && outcome.verdict.status !== 'pending' ? outcome.verdict : null;

      const checkFreshWallClock = (verdictToCheck: BenchmarkVerdict | null): boolean => {
        if (!verdictToCheck || verdictToCheck.status !== 'approved') return true;
        const viewNow = stateValue(this.store.inspect());
        const wall = BigInt(viewNow.clock.sampledNow.wallMs);
        const exp = BigInt(verdictToCheck.expiresAtMs);
        return exp >= wall && exp <= wall + 86_400_000n;
      };

      let wallClockValid = checkFreshWallClock(settledVerdict);
      let casOutcome: 'ok' | 'artifact_invalid' | 'evidence_unavailable' | 'gate_timeout' = 'ok';
      let verifierCasRefs: readonly ArtifactRef[] = freeze([]);

      const shouldPull = shouldPullBenchmarkOutputs({
        verdict: settledVerdict,
        wallClockValid,
        targetHardware: data.targetHardware,
        targetCellId: data.targetCellId,
        allowSyntheticHardwareProbe: data.allowSyntheticHardwareProbe,
        metricThresholds: data.metricThresholds,
      });

      if (shouldPull && settledVerdict?.outputArtifacts) {
        const priorBudget = this.resolvePriorVerifierBudget
          ? await this.resolvePriorVerifierBudget(job.generation, job.slotId)
          : { files: 0, bytes: 0 };
        const totalLimits = this.verifierTotalLimits ?? VERIFIER_ARTIFACT_LIMITS;
        const proposedFiles = settledVerdict.outputArtifacts.length;
        const proposedBytes = settledVerdict.outputArtifacts.reduce((sum, item) => sum + item.byteLength, 0);
        if (
          priorBudget.files + proposedFiles > totalLimits.maxTotalFiles
          || proposedBytes > totalLimits.maxTotalBytes - priorBudget.bytes
        ) {
          casOutcome = 'artifact_invalid';
        } else {
          const pulled = await pullBenchmarkOutputBlobs({
            baseUrl,
            operationId: job.operationId,
            slotId: data.slot.id,
            secret,
            bearerToken,
            outputArtifacts: settledVerdict.outputArtifacts,
            artifacts: this.artifacts,
            signal,
            resolveTimeoutMs: remainingWindowMs,
            onBeforeEach: () => this.#permit(permit, data.subject, target),
            phase: 'verification',
          });
          if (isPastPollDeadline()) {
            timedOut = true;
            casOutcome = 'gate_timeout';
          } else if (pulled.ok) {
            verifierCasRefs = pulled.refs;
          } else {
            casOutcome = pulled.casOutcome;
            if (casOutcome === 'gate_timeout') timedOut = true;
          }
        }
      }

      // Re-sample wall-clock freshness immediately before final settlement (after any CAS I/O).
      if (!checkFreshWallClock(settledVerdict)) {
        wallClockValid = false;
      }

      const dispositioned = computeBenchmarkDisposition({
        verdict: settledVerdict,
        timedOut,
        sawPreemption,
        wallClockValid,
        targetHardware: data.targetHardware,
        targetCellId: data.targetCellId,
        allowSyntheticHardwareProbe: data.allowSyntheticHardwareProbe,
        metricThresholds: data.metricThresholds,
        casOutcome,
      });

      const view = stateValue(this.store.inspect());
      const suffix = hash(job.operationId + '\0' + job.producerNonce).hex.slice(0, 40);
      const retained = outcome.kind === 'verdict' && settledVerdict !== null ? outcome : null;
      const retainOutputs =
        casOutcome === 'ok'
        && shouldPullBenchmarkOutputs({
          verdict: settledVerdict,
          wallClockValid,
          targetHardware: data.targetHardware,
          targetCellId: data.targetCellId,
          allowSyntheticHardwareProbe: data.allowSyntheticHardwareProbe,
          metricThresholds: data.metricThresholds,
        });
      const effectiveRefs = retainOutputs ? verifierCasRefs : freeze([]);
      const totalAttempts = Math.max(1, pollAttempts + stageRetries);
      const output = await this.artifacts.json(
        'benchmark-output',
        {
          version: 1,
          binding: {
            planDigest: this.plan.planDigest,
            operationId: job.operationId,
            producerNonce: job.producerNonce,
            generation: job.generation,
            endpoint: data.endpoint.id,
            subject: data.subject,
            requestBytesDigest,
          },
          observation: {
            attempts: totalAttempts,
            elapsedMs: Math.ceil(performance.now() - started),
            transport: timedOut ? 'deadline' : 'completed',
            sawPreemption,
            wallClockValid,
            casOutcome,
          },
          verdict: settledVerdict,
          responseBytes: retained ? Buffer.from(retained.responseBytes).toString('base64') : null,
          responseSignature: retained?.signature ?? null,
          verifierArtifacts: effectiveRefs,
          disposition: dispositioned,
        },
        BENCHMARK_OUTPUT_BYTES,
      );

      const evidenceSpec = {
        checkId: data.slot.checkId,
        observedStatus: dispositioned.status,
        producerId: 'loopwright.benchmark-gate.v1',
        method: dispositioned.method,
        level: 'hardware_execution' as const,
        subject: data.subject,
        artifacts: [output, ...effectiveRefs],
        reason: dispositioned.reason,
        ...(settledVerdict && Object.hasOwn(settledVerdict, 'detail') ? { detail: settledVerdict.detail } : {}),
        ...(settledVerdict?.metrics !== undefined ? { metrics: settledVerdict.metrics } : {}),
        ...(settledVerdict?.findings !== undefined ? { findings: settledVerdict.findings } : {}),
        ...(settledVerdict?.hardwareProvenance !== undefined ? { hardwareProvenance: settledVerdict.hardwareProvenance } : {}),
      };
      const evidenceResult = validateDocument(
        { apiVersion: 'loopwright.dev/v1alpha1', kind: 'Evidence', metadata: { id: 'evidence.' + suffix }, spec: evidenceSpec },
        'Evidence',
      );
      if (!evidenceResult.ok) refuse('RECOVERY_REQUIRED', '', 'verification');

      const receipt: OperationReceipt = {
        receiptId: 'receipt.' + suffix,
        outcome: dispositioned.method === 'benchmark-gate.v1' ? 'succeeded' : 'failed',
        evidence: {
          evidenceId: 'receipt-evidence.' + suffix,
          producerId: 'loopwright.benchmark-gate.v1',
          method: dispositioned.method,
          subject: {
            storeId: view.storeId,
            runId: view.runId,
            lockHash: view.lockHash,
            operationId: job.operationId,
            requestId: null,
            intentDigest,
            dispatchGeneration: permit.generation,
            dispatchId: permit.dispatchId,
          },
          artifact: output,
        },
      };
      const receiptRef = await this.artifacts.json('benchmark-receipt', receipt, 65_536);
      await this.#marker(job.operationId, job.producerNonce, 'proof', {
        version: 1,
        output,
        receipt: receiptRef,
        evidence: evidenceResult.value,
      });
      let finalDisposition = dispositioned;
      let finalOutput = output;
      let finalEvidence = evidenceResult.value;
      let finalReceipt: OperationReceipt = receipt;
      let finalReceiptRef = receiptRef;
      let finalVerifierRefs = effectiveRefs;

      this.#permit(permit, data.subject, target);

      // Re-sample signed expiresAtMs after durable proof persistence, right at first SQLite confirmation.
      if (wallClockValid && !checkFreshWallClock(settledVerdict)) {
        const expiredDisposition = computeBenchmarkDisposition({
          verdict: settledVerdict,
          timedOut,
          sawPreemption,
          wallClockValid: false,
          targetHardware: data.targetHardware,
          targetCellId: data.targetCellId,
          allowSyntheticHardwareProbe: data.allowSyntheticHardwareProbe,
          metricThresholds: data.metricThresholds,
          casOutcome,
        });
        const expiredOutput = await this.artifacts.json(
          'benchmark-output',
          {
            version: 1,
            binding: {
              planDigest: this.plan.planDigest,
              operationId: job.operationId,
              producerNonce: job.producerNonce,
              generation: job.generation,
              endpoint: data.endpoint.id,
              subject: data.subject,
              requestBytesDigest,
            },
            observation: {
              attempts: totalAttempts,
              elapsedMs: Math.ceil(performance.now() - started),
              transport: timedOut ? 'deadline' : 'completed',
              sawPreemption,
              wallClockValid: false,
              casOutcome,
            },
            verdict: settledVerdict,
            responseBytes: retained ? Buffer.from(retained.responseBytes).toString('base64') : null,
            responseSignature: retained?.signature ?? null,
            verifierArtifacts: [],
            disposition: expiredDisposition,
          },
          BENCHMARK_OUTPUT_BYTES,
        );
        const expiredEvidenceSpec = {
          checkId: data.slot.checkId,
          observedStatus: expiredDisposition.status,
          producerId: 'loopwright.benchmark-gate.v1',
          method: expiredDisposition.method,
          level: 'hardware_execution' as const,
          subject: data.subject,
          artifacts: [expiredOutput],
          reason: expiredDisposition.reason,
          ...(settledVerdict && Object.hasOwn(settledVerdict, 'detail') ? { detail: settledVerdict.detail } : {}),
          ...(settledVerdict?.metrics !== undefined ? { metrics: settledVerdict.metrics } : {}),
          ...(settledVerdict?.findings !== undefined ? { findings: settledVerdict.findings } : {}),
          ...(settledVerdict?.hardwareProvenance !== undefined ? { hardwareProvenance: settledVerdict.hardwareProvenance } : {}),
        };
        const expiredEvidenceRes = validateDocument(
          { apiVersion: 'loopwright.dev/v1alpha1', kind: 'Evidence', metadata: { id: 'evidence.' + suffix }, spec: expiredEvidenceSpec },
          'Evidence',
        );
        if (!expiredEvidenceRes.ok) refuse('RECOVERY_REQUIRED', '', 'verification');
        const expiredReceipt: OperationReceipt = {
          receiptId: 'receipt.' + suffix,
          outcome: expiredDisposition.method === 'benchmark-gate.v1' ? 'succeeded' : 'failed',
          evidence: {
            evidenceId: 'receipt-evidence.' + suffix,
            producerId: 'loopwright.benchmark-gate.v1',
            method: expiredDisposition.method,
            subject: {
              storeId: view.storeId,
              runId: view.runId,
              lockHash: view.lockHash,
              operationId: job.operationId,
              requestId: null,
              intentDigest,
              dispatchGeneration: permit.generation,
              dispatchId: permit.dispatchId,
            },
            artifact: expiredOutput,
          },
        };
        const expiredReceiptRef = await this.artifacts.json('benchmark-receipt', expiredReceipt, 65_536);
        const proofPath = join(
          this.artifacts.directory,
          'benchmark-producer-' + hash(job.operationId + '\0' + job.producerNonce).hex + '.proof.json',
        );
        await this.artifacts.owner.assertCurrent();
        await overwriteAtomicMarker(
          proofPath,
          {
            version: 1,
            output: expiredOutput,
            receipt: expiredReceiptRef,
            evidence: expiredEvidenceRes.value,
          },
          this.artifacts.vault,
          'verification',
        );
        this.#permit(permit, data.subject, target);
        const finalExpiredView = stateValue(this.store.inspect());
        if (finalExpiredView.clockStatus !== 'trusted') refuse('RECOVERY_REQUIRED', '', 'verification');
        finalDisposition = expiredDisposition;
        finalOutput = expiredOutput;
        finalEvidence = expiredEvidenceRes.value;
        finalReceipt = expiredReceipt;
        finalReceiptRef = expiredReceiptRef;
        finalVerifierRefs = freeze([]);
      }

      if (signal.aborted) throw cancelledFailure('verification');
      stateValue(this.store.recordOperationReceipt(this.authority, job.operationId, finalReceipt));

      const value: VerifiedCheck = freeze({
        slotId: job.slotId,
        checkId: data.slot.checkId,
        generation: job.generation,
        operationId: job.operationId,
        producerNonce: job.producerNonce,
        status: finalDisposition.status,
        reason: finalDisposition.reason,
        output: finalOutput,
        receipt: finalReceiptRef,
      });
      observations.set(value, {
        evidence: freeze(finalEvidence),
        subject: data.subject,
        outputBytes: await this.artifacts.read(finalOutput, BENCHMARK_OUTPUT_BYTES),
        receipt: freeze(finalReceipt),
        planDigest: this.plan.planDigest,
        requestDigest: job.requestDigest,
        artifactsDirectory: this.artifacts.directory,
        verifierArtifacts: finalVerifierRefs,
        retryablePreemption: finalDisposition.retryablePreemption === true,
        header: {
          handlerDigest: data.slot.handler.digest,
          handler: 'benchmark-gate.v1',
          candidate: { ref: { digest: data.candidateDigest, byteLength: data.candidateBytes } },
        },
      });
      return value;
    } finally {
      done();
    }
  }

  /** Re-authenticates retained producer proof and verified CAS artifacts without sending any replacement network request. */
  async restore(job: PreparedBenchmarkGate, signal?: AbortSignal): Promise<VerifiedCheck> {
    if (signal?.aborted) throw cancelledFailure('recovery');
    const data = preparations.get(job);
    if (!data || this.plan.verifierSlots.find(slot => slot.id === job.slotId) !== data.slot) {
      refuse('EVIDENCE_UNAVAILABLE', '', 'recovery');
    }
    await this.artifacts.owner.assertCurrent();
    if (!same(this.currentSubject(), data.subject)) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const operation = stateValue(this.store.getOperation(job.operationId));
    const view = this.#identity();
    const dispatch = operation.dispatch;
    const attemptId = 'job.' + hash(job.operationId + '\0' + job.producerNonce).hex.slice(0, 40);
    if (
      !dispatch
      || view.clockStatus !== 'trusted'
      || operation.intent.effect !== 'read_only'
      || operation.linkedRequestId !== null
      || !same(operation.intent.requestDigest, job.requestDigest)
      || operation.intent.attemptId !== attemptId
      || operation.intent.nodeId !== this.plan.orderedDAG[0]!.id
      || operation.intent.targetIdentity !== 'benchmark:' + job.slotId + ':' + job.generation + ':' + data.subject.candidateDigest.hex
    ) {
      refuse('RECOVERY_REQUIRED', '', 'recovery');
    }

    await cleanMarkerTempFilesInDirectory(this.artifacts.directory, this.artifacts.owner);
    const prefix = join(this.artifacts.directory, 'benchmark-producer-' + hash(job.operationId + '\0' + job.producerNonce).hex);
    let bindingBytes: Buffer;
    try {
      bindingBytes = await readBoundedFile(prefix + '.binding.json', 1_048_576, true, 0o600);
    } catch (error) {
      if (error instanceof ControllerFailure && error.diagnostic.code === 'REGISTRY_UNTRUSTED') {
        refuse('RECOVERY_REQUIRED', '', 'recovery');
      }
      throw error;
    }
    const binding = record(parsePrivateJson(bindingBytes, 1_048_576), [
      'version',
      'planDigest',
      'operationId',
      'producerNonce',
      'requestDigest',
      'requestBytesDigest',
      'intentDigest',
      'subject',
      'generation',
      'endpoint',
      'dispatchReceipt',
    ]);
    const proofPath = prefix + '.proof.json';
    let proofExists = false;
    try {
      await lstat(proofPath);
      proofExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        refuse('RECOVERY_REQUIRED', '', 'recovery');
      }
    }
    if (!proofExists) {
      if (signal?.aborted) throw cancelledFailure('recovery');
      if (operation.state === 'dispatch_uncertain') {
        return await this.#settleTimeout(job, data, bindingBytes, view, dispatch, operation.intentDigest, signal);
      }
      refuse('RECOVERY_REQUIRED', '', 'recovery');
    }
    let proofBytes: Buffer;
    try {
      proofBytes = await readBoundedFile(proofPath, 1_048_576, true, 0o600);
    } catch (error) {
      if (error instanceof ControllerFailure && error.diagnostic.code === 'REGISTRY_UNTRUSTED') {
        refuse('RECOVERY_REQUIRED', '', 'recovery');
      }
      throw error;
    }

    const receiptBinding = record(binding.dispatchReceipt, ['generation', 'dispatchId', 'revision', 'clockEpoch']);
    if (
      receiptBinding.generation !== dispatch.generation
      || receiptBinding.dispatchId !== dispatch.dispatchId
      || receiptBinding.revision !== dispatch.revision
      || receiptBinding.clockEpoch !== view.clock.basis.clockEpoch
    ) {
      refuse('RECOVERY_REQUIRED', '', 'recovery');
    }
    const request: Record<string, unknown> = {
      ...expectedBenchmarkRequest(
        this.plan,
        data.slot,
        data.endpoint,
        data.subject,
        data.manifest,
        data.baseTreeBundle,
        data.files,
      ),
      storeId: view.storeId,
      runId: view.runId,
      lockHash: view.lockHash,
      operationId: job.operationId,
      dispatchId: dispatch.dispatchId,
      dispatchGeneration: dispatch.generation,
      requestDigest: job.requestDigest.hex,
    };
    const requestBytesDigest = hash(Buffer.from(canonical(request))).hex;
    if (
      binding.version !== 1
      || !same(binding.planDigest, this.plan.planDigest)
      || binding.operationId !== job.operationId
      || binding.producerNonce !== job.producerNonce
      || binding.generation !== job.generation
      || !same(binding.subject, data.subject)
      || !same(binding.requestDigest, job.requestDigest)
      || !same(binding.intentDigest, operation.intentDigest)
      || binding.endpoint !== data.endpoint.id
      || !same(binding.requestBytesDigest, requestBytesDigest)
      || !same(binding.dispatchReceipt, {
        generation: dispatch.generation,
        dispatchId: dispatch.dispatchId,
        revision: dispatch.revision,
        clockEpoch: view.clock.basis.clockEpoch,
      })
    ) {
      refuse('RECOVERY_REQUIRED', '', 'recovery');
    }

    const secret = this.resolveCredential(data.endpoint.signingCredentialRef);
    const bearerToken =
      data.endpoint.authCredentialRef !== null ? this.resolveCredential(data.endpoint.authCredentialRef) : null;
    const priorBudget = this.resolvePriorVerifierBudget
      ? await this.resolvePriorVerifierBudget(job.generation, job.slotId)
      : { files: 0, bytes: 0 };
    const restoreProgress = createRateLimitedProgress(() => {
      if (signal?.aborted) throw cancelledFailure('recovery');
      stateValue(this.store.renew(this.authority));
    }, 1_000);
    const validated = await validateStoredBenchmarkProof({
      proofBytes,
      artifacts: this.artifacts,
      plan: this.plan,
      slot: data.slot,
      endpoint: data.endpoint,
      targetHardware: data.targetHardware,
      targetCellId: data.targetCellId,
      allowSyntheticHardwareProbe: data.allowSyntheticHardwareProbe,
      metricThresholds: data.metricThresholds,
      view,
      operation,
      dispatch,
      operationId: job.operationId,
      producerNonce: job.producerNonce,
      generation: job.generation,
      subject: data.subject,
      request,
      requestBytesDigest,
      secret,
      bearerToken,
      priorBudget,
      signal,
      onProgress: restoreProgress,
      allowInvalidLocalCasSettlement: operation.state !== 'confirmed',
      ...(this.verifierTotalLimits !== undefined ? { totalLimits: this.verifierTotalLimits } : {}),
    });

    if (signal?.aborted) throw cancelledFailure('recovery');
    await this.artifacts.owner.assertCurrent();
    if (!same(this.currentSubject(), data.subject)) refuse('RECOVERY_REQUIRED', '', 'recovery');
    if (signal?.aborted) throw cancelledFailure('recovery');
    stateValue(this.store.renew(this.authority));
    if (operation.state === 'confirmed') {
      if (!same(operation.reconciliation ?? operation.initialReceipt, validated.receipt)) {
        refuse('RECOVERY_REQUIRED', '', 'recovery');
      }
    } else {
      // Operation still needs FIRST SQLite confirmation: settle invalid local CAS or expired approval
      // cleanly instead of stranding dispatch_uncertain or confirming an expired approval.
      const postValidateView = stateValue(this.store.inspect());
      const currentWallMs = BigInt(postValidateView.clock.sampledNow.wallMs);
      const currentlyFresh =
        validated.verdict === null
        || validated.verdict.status !== 'approved'
        || (BigInt(validated.verdict.expiresAtMs) >= currentWallMs
          && BigInt(validated.verdict.expiresAtMs) <= currentWallMs + 86_400_000n);
      if (validated.localCasInvalid) {
        return await this.#settleSupersededUnconfirmedProof(
          job,
          data,
          proofPath,
          postValidateView,
          dispatch,
          operation.intentDigest,
          requestBytesDigest,
          validated,
          {
            casOutcome: 'artifact_invalid',
            wallClockValid: validated.observation.wallClockValid && currentlyFresh,
          },
          signal,
        );
      }
      if (!currentlyFresh && validated.observation.wallClockValid) {
        return await this.#settleSupersededUnconfirmedProof(
          job,
          data,
          proofPath,
          postValidateView,
          dispatch,
          operation.intentDigest,
          requestBytesDigest,
          validated,
          {
            casOutcome: validated.observation.casOutcome,
            wallClockValid: false,
          },
          signal,
        );
      }
      if (signal?.aborted) throw cancelledFailure('recovery');
      stateValue(this.store.reconcileOperation(this.authority, job.operationId, validated.receipt));
    }

    const value: VerifiedCheck = freeze({
      slotId: job.slotId,
      checkId: data.slot.checkId,
      generation: job.generation,
      operationId: job.operationId,
      producerNonce: job.producerNonce,
      status: validated.disposition.status,
      reason: validated.disposition.reason,
      output: validated.output,
      receipt: validated.receiptRef,
    });
    observations.set(value, {
      evidence: freeze(validated.evidence),
      subject: data.subject,
      outputBytes: validated.outputBytes,
      receipt: freeze(validated.receipt),
      planDigest: this.plan.planDigest,
      requestDigest: job.requestDigest,
      artifactsDirectory: this.artifacts.directory,
      verifierArtifacts: validated.verifierCasRefs,
      retryablePreemption: validated.disposition.retryablePreemption === true,
      header: {
        handlerDigest: data.slot.handler.digest,
        handler: 'benchmark-gate.v1',
        candidate: { ref: { digest: data.candidateDigest, byteLength: data.candidateBytes } },
      },
    });
    return value;
  }

  async #settleSupersededUnconfirmedProof(
    job: PreparedBenchmarkGate,
    data: BenchmarkGatePreparation,
    proofPath: string,
    view: RunView,
    dispatch: NonNullable<OperationRecord['dispatch']>,
    intentDigest: Digest,
    requestBytesDigest: string,
    validated: Awaited<ReturnType<typeof validateStoredBenchmarkProof>>,
    override: {
      readonly casOutcome: 'ok' | 'artifact_invalid' | 'evidence_unavailable' | 'gate_timeout';
      readonly wallClockValid: boolean;
    },
    signal?: AbortSignal,
  ): Promise<VerifiedCheck> {
    const supersededDisposition = computeBenchmarkDisposition({
      verdict: validated.verdict,
      timedOut: validated.observation.transport === 'deadline',
      sawPreemption: validated.observation.sawPreemption,
      wallClockValid: override.wallClockValid,
      targetHardware: data.targetHardware,
      targetCellId: data.targetCellId,
      allowSyntheticHardwareProbe: data.allowSyntheticHardwareProbe,
      metricThresholds: data.metricThresholds,
      casOutcome: override.casOutcome,
    });
    const suffix = hash(job.operationId + '\0' + job.producerNonce).hex.slice(0, 40);
    const supersededOutput = await this.artifacts.json(
      'benchmark-output',
      {
        version: 1,
        binding: {
          planDigest: this.plan.planDigest,
          operationId: job.operationId,
          producerNonce: job.producerNonce,
          generation: job.generation,
          endpoint: data.endpoint.id,
          subject: data.subject,
          requestBytesDigest,
        },
        observation: {
          attempts: validated.observation.attempts,
          elapsedMs: validated.observation.elapsedMs,
          transport: validated.observation.transport,
          sawPreemption: validated.observation.sawPreemption,
          wallClockValid: override.wallClockValid,
          casOutcome: override.casOutcome,
        },
        verdict: validated.verdict,
        responseBytes: validated.responseBytesBase64,
        responseSignature: validated.responseSignature,
        verifierArtifacts: [],
        disposition: supersededDisposition,
      },
      BENCHMARK_OUTPUT_BYTES,
    );
    const evidenceSpec = {
      checkId: data.slot.checkId,
      observedStatus: supersededDisposition.status,
      producerId: 'loopwright.benchmark-gate.v1',
      method: supersededDisposition.method,
      level: 'hardware_execution' as const,
      subject: data.subject,
      artifacts: [supersededOutput],
      reason: supersededDisposition.reason,
      ...(validated.verdict && Object.hasOwn(validated.verdict, 'detail') ? { detail: validated.verdict.detail } : {}),
      ...(validated.verdict?.metrics !== undefined ? { metrics: validated.verdict.metrics } : {}),
      ...(validated.verdict?.findings !== undefined ? { findings: validated.verdict.findings } : {}),
      ...(validated.verdict?.hardwareProvenance !== undefined ? { hardwareProvenance: validated.verdict.hardwareProvenance } : {}),
    };
    const evidenceResult = validateDocument(
      { apiVersion: 'loopwright.dev/v1alpha1', kind: 'Evidence', metadata: { id: 'evidence.' + suffix }, spec: evidenceSpec },
      'Evidence',
    );
    if (!evidenceResult.ok) refuse('RECOVERY_REQUIRED', '', 'recovery');

    const supersededReceipt: OperationReceipt = {
      receiptId: 'receipt.' + suffix,
      outcome: supersededDisposition.method === 'benchmark-gate.v1' ? 'succeeded' : 'failed',
      evidence: {
        evidenceId: 'receipt-evidence.' + suffix,
        producerId: 'loopwright.benchmark-gate.v1',
        method: supersededDisposition.method,
        subject: {
          storeId: view.storeId,
          runId: view.runId,
          lockHash: view.lockHash,
          operationId: job.operationId,
          requestId: null,
          intentDigest,
          dispatchGeneration: dispatch.generation,
          dispatchId: dispatch.dispatchId,
        },
        artifact: supersededOutput,
      },
    };
    const supersededReceiptRef = await this.artifacts.json('benchmark-receipt', supersededReceipt, 65_536);

    await this.artifacts.owner.assertCurrent();
    await overwriteAtomicMarker(
      proofPath,
      {
        version: 1,
        output: supersededOutput,
        receipt: supersededReceiptRef,
        evidence: evidenceResult.value,
      },
      this.artifacts.vault,
      'recovery',
    );

    if (signal?.aborted) throw cancelledFailure('recovery');
    stateValue(this.store.renew(this.authority));
    const finalSupersededView = stateValue(this.store.inspect());
    if (finalSupersededView.clockStatus !== 'trusted') refuse('RECOVERY_REQUIRED', '', 'recovery');
    if (signal?.aborted) throw cancelledFailure('recovery');
    stateValue(this.store.reconcileOperation(this.authority, job.operationId, supersededReceipt));

    const value: VerifiedCheck = freeze({
      slotId: job.slotId,
      checkId: data.slot.checkId,
      generation: job.generation,
      operationId: job.operationId,
      producerNonce: job.producerNonce,
      status: supersededDisposition.status,
      reason: supersededDisposition.reason,
      output: supersededOutput,
      receipt: supersededReceiptRef,
    });
    observations.set(value, {
      evidence: freeze(evidenceResult.value),
      subject: data.subject,
      outputBytes: await this.artifacts.read(supersededOutput, BENCHMARK_OUTPUT_BYTES),
      receipt: freeze(supersededReceipt),
      planDigest: this.plan.planDigest,
      requestDigest: job.requestDigest,
      artifactsDirectory: this.artifacts.directory,
      verifierArtifacts: freeze([]),
      retryablePreemption: supersededDisposition.retryablePreemption === true,
      header: {
        handlerDigest: data.slot.handler.digest,
        handler: 'benchmark-gate.v1',
        candidate: { ref: { digest: data.candidateDigest, byteLength: data.candidateBytes } },
      },
    });
    return value;
  }

  /** Interrupted read-only benchmark operations without a proof settle fail-closed as blocked GATE_TIMEOUT without replacement POSTs. */
  async #settleTimeout(
    job: PreparedBenchmarkGate,
    data: BenchmarkGatePreparation,
    bindingBytes: Buffer,
    view: RunView,
    dispatch: NonNullable<OperationRecord['dispatch']>,
    intentDigest: Digest,
    signal?: AbortSignal,
  ): Promise<VerifiedCheck> {
    if (signal?.aborted) throw cancelledFailure('recovery');
    await this.artifacts.owner.assertCurrent();
    if (!same(this.currentSubject(), data.subject)) refuse('RECOVERY_REQUIRED', '', 'recovery');
    stateValue(this.store.renew(this.authority));
    const binding = record(parsePrivateJson(bindingBytes, 1_048_576), [
      'version',
      'planDigest',
      'operationId',
      'producerNonce',
      'requestDigest',
      'requestBytesDigest',
      'intentDigest',
      'subject',
      'generation',
      'endpoint',
      'dispatchReceipt',
    ]);
    const request: Record<string, unknown> = {
      ...expectedBenchmarkRequest(
        this.plan,
        data.slot,
        data.endpoint,
        data.subject,
        data.manifest,
        data.baseTreeBundle,
        data.files,
      ),
      storeId: view.storeId,
      runId: view.runId,
      lockHash: view.lockHash,
      operationId: job.operationId,
      dispatchId: dispatch.dispatchId,
      dispatchGeneration: dispatch.generation,
      requestDigest: job.requestDigest.hex,
    };
    const requestBytesDigest = hash(Buffer.from(canonical(request))).hex;
    const receiptBinding = record(binding.dispatchReceipt, ['generation', 'dispatchId', 'revision', 'clockEpoch']);
    if (
      receiptBinding.generation !== dispatch.generation
      || receiptBinding.dispatchId !== dispatch.dispatchId
      || receiptBinding.revision !== dispatch.revision
      || receiptBinding.clockEpoch !== view.clock.basis.clockEpoch
      || binding.version !== 1
      || !same(binding.planDigest, this.plan.planDigest)
      || binding.operationId !== job.operationId
      || binding.producerNonce !== job.producerNonce
      || binding.generation !== job.generation
      || !same(binding.subject, data.subject)
      || !same(binding.requestDigest, job.requestDigest)
      || !same(binding.intentDigest, intentDigest)
      || binding.endpoint !== data.endpoint.id
      || !same(binding.requestBytesDigest, requestBytesDigest)
      || !same(binding.dispatchReceipt, {
        generation: dispatch.generation,
        dispatchId: dispatch.dispatchId,
        revision: dispatch.revision,
        clockEpoch: view.clock.basis.clockEpoch,
      })
    ) {
      refuse('RECOVERY_REQUIRED', '', 'recovery');
    }

    const dispositioned: BenchmarkDisposition = freeze({
      status: 'blocked',
      reason: 'GATE_TIMEOUT',
      method: 'benchmark_transport',
    });
    const suffix = hash(job.operationId + '\0' + job.producerNonce).hex.slice(0, 40);
    const output = await this.artifacts.json(
      'benchmark-output',
      {
        version: 1,
        binding: {
          planDigest: this.plan.planDigest,
          operationId: job.operationId,
          producerNonce: job.producerNonce,
          generation: job.generation,
          endpoint: data.endpoint.id,
          subject: data.subject,
          requestBytesDigest,
        },
        observation: {
          attempts: 1,
          elapsedMs: 0,
          transport: 'deadline',
          sawPreemption: false,
          wallClockValid: true,
          casOutcome: 'gate_timeout',
        },
        verdict: null,
        responseBytes: null,
        responseSignature: null,
        verifierArtifacts: [],
        disposition: dispositioned,
      },
      65_536,
    );
    const evidenceResult = validateDocument(
      {
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'Evidence',
        metadata: { id: 'evidence.' + suffix },
        spec: {
          checkId: data.slot.checkId,
          observedStatus: 'blocked',
          producerId: 'loopwright.benchmark-gate.v1',
          method: 'benchmark_transport',
          level: 'hardware_execution',
          subject: data.subject,
          artifacts: [output],
          reason: 'GATE_TIMEOUT',
        },
      },
      'Evidence',
    );
    if (!evidenceResult.ok) refuse('RECOVERY_REQUIRED', '', 'recovery');

    const receipt: OperationReceipt = {
      receiptId: 'receipt.' + suffix,
      outcome: 'failed',
      evidence: {
        evidenceId: 'receipt-evidence.' + suffix,
        producerId: 'loopwright.benchmark-gate.v1',
        method: 'benchmark_transport',
        subject: {
          storeId: view.storeId,
          runId: view.runId,
          lockHash: view.lockHash,
          operationId: job.operationId,
          requestId: null,
          intentDigest: binding.intentDigest as Digest,
          dispatchGeneration: dispatch.generation,
          dispatchId: dispatch.dispatchId,
        },
        artifact: output,
      },
    };
    const receiptRef = await this.artifacts.json('benchmark-receipt', receipt, 65_536);
    if (signal?.aborted) throw cancelledFailure('recovery');
    await this.#marker(job.operationId, job.producerNonce, 'proof', {
      version: 1,
      output,
      receipt: receiptRef,
      evidence: evidenceResult.value,
    });
    if (signal?.aborted) throw cancelledFailure('recovery');
    stateValue(this.store.renew(this.authority));
    const finalTimeoutView = stateValue(this.store.inspect());
    if (finalTimeoutView.clockStatus !== 'trusted') refuse('RECOVERY_REQUIRED', '', 'recovery');
    if (signal?.aborted) throw cancelledFailure('recovery');
    stateValue(this.store.reconcileOperation(this.authority, job.operationId, receipt));
    const value: VerifiedCheck = freeze({
      slotId: job.slotId,
      checkId: data.slot.checkId,
      generation: job.generation,
      operationId: job.operationId,
      producerNonce: job.producerNonce,
      status: 'blocked',
      reason: 'GATE_TIMEOUT',
      output,
      receipt: receiptRef,
    });
    observations.set(value, {
      evidence: freeze(evidenceResult.value),
      subject: data.subject,
      outputBytes: await this.artifacts.read(output, 65_536),
      receipt: freeze(receipt),
      planDigest: this.plan.planDigest,
      requestDigest: job.requestDigest,
      artifactsDirectory: this.artifacts.directory,
      verifierArtifacts: freeze([]),
      retryablePreemption: false,
      header: {
        handlerDigest: data.slot.handler.digest,
        handler: 'benchmark-gate.v1',
        candidate: { ref: { digest: data.candidateDigest, byteLength: data.candidateBytes } },
      },
    });
    return value;
  }
}

/** Pure preparation: no intent, permit, timer, credential or network operation. */
export function prepareBenchmarkGate(
  plan: CompiledPlan,
  lock: TaskLock,
  slotId: string,
  candidate: ByteInventory,
  generation: number,
  producerNonce: string,
  gateEndpoints: readonly GateEndpoint[],
  baseTreeBundle?: BenchmarkBaseTreeBundle,
): PreparedBenchmarkGate {
  if (!same(plan.task, lock.spec.contract) || !/^[a-f0-9]{32}$/.test(producerNonce)) {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
  integer(generation, 0, plan.capacity.V - 1);
  const slot = plan.verifierSlots.find(item => item.id === slotId);
  if (!slot || slot.handler.implementation !== 'benchmark-gate.v1' || slot.handler.kind !== 'check') {
    refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
  }
  const overlayOpts = lock.spec.contract.spec.budgets.overlay
    ? { overlay: lock.spec.contract.spec.budgets.overlay }
    : undefined;
  const subject = bindSubject(lock, candidate.manifest, overlayOpts);
  if (!subject.ok) refuse('ARTIFACT_INVALID', '', 'verification');
  const validatedFiles = validateCandidateFilesForStaging(candidate.manifest, candidate.files);
  let validatedBundle: BenchmarkBaseTreeBundle | undefined;
  if (baseTreeBundle !== undefined) {
    if (
      candidate.manifest.spec.baseTree === undefined
      || typeof baseTreeBundle.blobPath !== 'string'
      || !isAbsolute(baseTreeBundle.blobPath)
      || baseTreeBundle.blobPath.length > 4096
      || /[\0\r\n]/.test(baseTreeBundle.blobPath)
    ) {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }
    const checkedDigest = digestValue(baseTreeBundle.digest);
    const checkedBytes = integer(baseTreeBundle.byteLength, 12, VERIFIER_ARTIFACT_LIMITS.maxFileBytes);
    validatedBundle = freeze({
      digest: checkedDigest,
      byteLength: checkedBytes,
      blobPath: baseTreeBundle.blobPath,
    });
  }
  const meta = resolveBenchmarkSlotMetadata(plan, slot);
  const endpoint = gateEndpoints.find(item => item.id === meta.endpointRef);
  if (!endpoint) refuse('CONFIG_REFERENCE', '/registry/spec/gateEndpoints', 'verification');
  const candidateArtifacts = buildCandidateArtifactsDescriptor(candidate.manifest, validatedBundle, validatedFiles);
  const requestDigest = hash(
    'loopwright.dev/controller/benchmark-request/v1\0'
      + canonical({
        planDigest: plan.planDigest,
        slotId,
        generation,
        gateId: meta.gateId,
        checkId: slot.checkId,
        targetCellId: meta.targetCellId,
        targetHardware: meta.targetHardware,
        heldOutWorkloadId: meta.heldOutWorkloadId,
        metricThresholds: meta.metricThresholds,
        maxPreemptions: meta.maxPreemptions,
        candidateArtifacts,
        subject: subject.value,
        producerNonce,
      }),
  );
  const value: PreparedBenchmarkGate = freeze({
    version: 1,
    slotId,
    generation,
    operationId: verifierOperationId(lock.spec.runId, slotId, generation),
    producerNonce,
    requestDigest,
  });
  preparations.set(value, {
    slot,
    endpoint,
    subject: subject.value,
    manifest: candidate.manifest,
    files: validatedFiles,
    ...(validatedBundle !== undefined ? { baseTreeBundle: validatedBundle } : {}),
    targetCellId: meta.targetCellId,
    targetHardware: meta.targetHardware,
    allowSyntheticHardwareProbe: meta.allowSyntheticHardwareProbe,
    heldOutWorkloadId: meta.heldOutWorkloadId,
    metricThresholds: meta.metricThresholds,
    maxPreemptions: meta.maxPreemptions,
    candidateDigest: hash(canonical(candidate.manifest)),
    candidateBytes: Buffer.byteLength(canonical(candidate.manifest)),
  });
  return value;
}
