import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SecretScrubber,
  digestArtifact,
  type ArtifactRef,
  type Quantity,
} from '@loopwright/core';
import type { CheckpointRecord, OperationRecord, RequestRecord } from '@loopwright/state';
import { inside, streamRegularFile } from './files.js';
import { parsePrivateJson } from './parser.js';
import { phaseCheckpointId, type ProgressHead, type journal } from './progress.js';
import { sanitizeReportText } from './report.js';
import { checkedRef, freeze, isRecord, same } from './schema.js';
import { compareUtf16 } from './source.js';
import { streamVerifiedCasBlob, type ArtifactReader } from './storage.js';
import type { CompiledPlan, ControllerAttempt } from './types.js';

export const RUN_EVAL_SCHEMA_VERSION = 1 as const;
export const RUN_EVAL_LOCAL_TOOL_RECEIPT_MAX_BYTES = 4_096;
export const RUN_EVAL_ARTIFACT_MAX_BYTES = 65_536;
export const RUN_EVAL_AGGREGATE_MAX_BYTES = 2_097_152;
export const RUN_EVAL_MAX_SUGGESTIONS = 8;

export type RunEvalToolTelemetryState = 'available' | 'delegated_unavailable' | 'partial' | 'unavailable';
export type RunEvalCircuitBreakerState = 'none' | 'max_turns' | 'consecutive_tool_errors' | 'no_progress' | 'unavailable';
export type RunEvalCostCompleteness = 'complete' | 'partial' | 'unavailable';
export type RunEvalSuggestionSeverity = 'high' | 'medium' | 'low';

export interface RunEvalToolRepeat {
  readonly roleId: string;
  readonly stepId: string;
  readonly tool: string;
  readonly target: string;
  readonly count: number;
}

export interface RunEvalToolRepeats {
  readonly items: readonly RunEvalToolRepeat[];
  readonly totalFailingCalls: number;
  readonly circuitBreaker: RunEvalCircuitBreakerState;
}

export interface RunEvalPingPong {
  readonly detected: boolean;
  readonly checkOscillations: number;
  readonly repeatedFailureSignatures: number;
  readonly digestCycles: number;
  readonly repeatedReworks: number;
  readonly totalReworks: number;
}

export interface RunEvalAttemptCounts {
  readonly ordinary: number;
  readonly format: number;
  readonly implementation: number;
  readonly rework: number;
}

export interface RunEvalRepairConvergence {
  readonly attempts: RunEvalAttemptCounts;
  readonly unchangedDigestRepairs: number;
  readonly initialFailingChecks: number | null;
  readonly finalFailingChecks: number | null;
  readonly failingCheckDelta: number | null;
  readonly converged: boolean | null;
}

export interface RunEvalTokenBreakdown {
  readonly input: number;
  readonly output: number;
  readonly total: number;
}

export interface RunEvalStepBreakdown {
  readonly stepId: string;
  readonly roleId: string | null;
  readonly tokens: RunEvalTokenBreakdown;
  readonly costMicrousd: number | null;
  readonly costCompleteness: RunEvalCostCompleteness;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly elapsedMs: number | null;
}

export interface RunEvalRoleBreakdown {
  readonly roleId: string;
  readonly tokens: RunEvalTokenBreakdown;
  readonly costMicrousd: number | null;
  readonly costCompleteness: RunEvalCostCompleteness;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly elapsedMs: number | null;
}

export interface RunEvalBreakdownTotals {
  readonly tokens: RunEvalTokenBreakdown;
  readonly costMicrousd: number | null;
  readonly costCompleteness: RunEvalCostCompleteness;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly elapsedMs: number | null;
}

export interface RunEvalBreakdown {
  readonly byStep: readonly RunEvalStepBreakdown[];
  readonly byRole: readonly RunEvalRoleBreakdown[];
  readonly totals: RunEvalBreakdownTotals;
}

export interface RunEvalSuggestion {
  readonly autoApplied: false;
  readonly code: string;
  readonly severity: RunEvalSuggestionSeverity;
  readonly summary: string;
  readonly evidence: string;
}

export interface RunEvalReport {
  readonly schemaVersion: typeof RUN_EVAL_SCHEMA_VERSION;
  readonly runId: string;
  readonly status: string | null;
  readonly journalRevision: number;
  readonly toolTelemetry: RunEvalToolTelemetryState;
  readonly toolRepeats: RunEvalToolRepeats;
  readonly pingPong: RunEvalPingPong;
  readonly repairConvergence: RunEvalRepairConvergence;
  readonly breakdown: RunEvalBreakdown;
  readonly suggestions: readonly RunEvalSuggestion[];
}

export interface EvaluateRunHealthInput {
  readonly runId: string;
  readonly status: string | null;
  readonly plan: CompiledPlan;
  readonly records: ReturnType<typeof journal>;
  readonly head: ProgressHead | null;
  readonly artifacts?: ArtifactReader | undefined;
  readonly artifactsDirectory?: string | undefined;
  readonly observed?: Readonly<Record<string, unknown>> | null | undefined;
  readonly scrub?: ((text: string) => string) | undefined;
}

const MONOTONIC_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/;
const SEVERITY_RANK: Readonly<Record<RunEvalSuggestionSeverity, number>> = Object.freeze({
  high: 0,
  medium: 1,
  low: 2,
});
const TERMINAL_SUCCESS_STATUSES: ReadonlySet<string> = new Set(['completed', 'no_change']);
const NON_TERMINAL_STATUSES: ReadonlySet<string> = new Set(['in_progress', 'reconcile_required', 'not_started']);

function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function ownString(record: Record<string, unknown>, key: string): string | null {
  const value = own(record, key);
  return typeof value === 'string' ? value : null;
}

function parseMonotonicBigInt(raw: string): bigint | null {
  if (!MONOTONIC_PATTERN.test(raw)) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

function monotonicDeltaMs(
  start: CheckpointRecord | undefined,
  end: CheckpointRecord | undefined,
  clockTrusted: boolean,
): number | null {
  if (!clockTrusted || !start || !end) return null;
  if (start.clockBasis.clockEpoch !== end.clockBasis.clockEpoch) return null;
  const startMono = parseMonotonicBigInt(start.clockSample.monotonicMs);
  const endMono = parseMonotonicBigInt(end.clockSample.monotonicMs);
  if (startMono === null || endMono === null || endMono < startMono) return null;
  const delta = endMono - startMono;
  if (delta > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(delta);
}

function totalMonotonicElapsedMs(checkpoints: readonly CheckpointRecord[], clockTrusted: boolean): number | null {
  if (!clockTrusted || checkpoints.length < 2) return null;
  const sorted = [...checkpoints].sort((a, b) => a.sequence - b.sequence);
  const epoch = sorted[0]!.clockBasis.clockEpoch;
  let prev = parseMonotonicBigInt(sorted[0]!.clockSample.monotonicMs);
  if (prev === null) return null;
  const first = prev;
  for (let i = 1; i < sorted.length; i += 1) {
    const cp = sorted[i]!;
    if (cp.clockBasis.clockEpoch !== epoch) return null;
    const current = parseMonotonicBigInt(cp.clockSample.monotonicMs);
    if (current === null || current < prev) return null;
    prev = current;
  }
  const delta = prev - first;
  if (delta > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(delta);
}

type BoundedReadResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: 'invalid' | 'cap_exceeded' | 'aggregate_cap_exceeded' | 'unavailable' };

type BoundedJsonResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: 'invalid' | 'cap_exceeded' | 'aggregate_cap_exceeded' | 'unavailable' };

class BoundedArtifactReader {
  #remainingBytes = RUN_EVAL_AGGREGATE_MAX_BYTES;
  readonly #cache = new Map<string, Uint8Array>();

  constructor(
    readonly artifactsDirectory: string | undefined,
    readonly artifacts: ArtifactReader | undefined,
  ) {}

  async readRaw(rawRef: unknown, maxBytes: number): Promise<BoundedReadResult> {
    let ref: ArtifactRef;
    try {
      ref = checkedRef(rawRef);
    } catch {
      return { ok: false, reason: 'invalid' };
    }
    if (ref.byteLength > maxBytes) {
      return { ok: false, reason: 'cap_exceeded' };
    }
    const cacheKey = `${ref.name}\0${ref.digest.hex}\0${ref.uri ?? ''}`;
    const cached = this.#cache.get(cacheKey);
    if (cached !== undefined) {
      return { ok: true, bytes: cached };
    }
    if (ref.byteLength > this.#remainingBytes) {
      return { ok: false, reason: 'aggregate_cap_exceeded' };
    }
    const effectiveCap = Math.min(maxBytes, this.#remainingBytes);
    const bytes = await this.#readVerified(ref, effectiveCap);
    if (bytes === null) {
      return { ok: false, reason: 'unavailable' };
    }
    if (bytes.byteLength > effectiveCap) {
      return { ok: false, reason: 'cap_exceeded' };
    }
    this.#cache.set(cacheKey, bytes);
    return { ok: true, bytes };
  }

  async readJson(rawRef: unknown, maxBytes: number): Promise<BoundedJsonResult> {
    const raw = await this.readRaw(rawRef, maxBytes);
    if (!raw.ok) return raw;
    try {
      const parsed = parsePrivateJson(Buffer.from(raw.bytes), maxBytes);
      return { ok: true, value: parsed };
    } catch {
      return { ok: false, reason: 'invalid' };
    }
  }

  #debitConsumed(bytesRead: number): void {
    if (bytesRead <= 0) return;
    this.#remainingBytes = Math.max(0, this.#remainingBytes - bytesRead);
  }

  async #readVerified(ref: ArtifactRef, effectiveCap: number): Promise<Uint8Array | null> {
    if (this.artifactsDirectory !== undefined) {
      if (typeof ref.uri === 'string' && ref.uri.startsWith('cas://sha256/')) {
        if (ref.uri !== `cas://sha256/${ref.digest.hex}`) return null;
        const chunks: Uint8Array[] = [];
        let collected = 0;
        try {
          await streamVerifiedCasBlob(
            this.artifactsDirectory,
            {
              name: ref.name,
              sha256: ref.digest.hex,
              byteLength: ref.byteLength,
              uri: ref.uri,
            },
            chunk => {
              collected += chunk.byteLength;
              this.#debitConsumed(chunk.byteLength);
              if (collected > effectiveCap) {
                throw new Error('cap_exceeded');
              }
              chunks.push(new Uint8Array(chunk));
            },
            'inspection',
          );
          return Buffer.concat(chunks);
        } catch {
          return null;
        }
      }

      if (
        ref.name.length === 0 ||
        ref.name.startsWith('/') ||
        ref.name.includes('\\') ||
        /[\0\r\n]/.test(ref.name)
      ) {
        return null;
      }
      const segments = ref.name.split('/');
      if (segments.some(seg => seg.length === 0 || seg === '.' || seg === '..')) {
        return null;
      }
      const targetPath = join(this.artifactsDirectory, ref.name);
      if (!inside(targetPath, this.artifactsDirectory) || targetPath === this.artifactsDirectory) {
        return null;
      }
      try {
        let current = this.artifactsDirectory;
        for (const seg of segments) {
          current = join(current, seg);
          const st = await lstat(current);
          if (st.isSymbolicLink()) return null;
        }
        const chunks: Uint8Array[] = [];
        let collected = 0;
        await streamRegularFile(
          targetPath,
          {
            maxBytes: effectiveCap,
            expectedBytes: ref.byteLength,
            owned: true,
            code: 'ARTIFACT_INVALID',
            limitCode: 'OUTPUT_LIMIT',
            phase: 'inspection',
          },
          chunk => {
            collected += chunk.byteLength;
            this.#debitConsumed(chunk.byteLength);
            if (collected > effectiveCap) {
              throw new Error('cap_exceeded');
            }
            chunks.push(new Uint8Array(chunk));
          },
        );
        const bytes = new Uint8Array(Buffer.concat(chunks));
        const actual = digestArtifact(ref.name, bytes);
        if (!actual.ok || !same(actual.value, ref)) return null;
        return bytes;
      } catch {
        return null;
      }
    }

    if (this.artifacts !== undefined) {
      try {
        const bytes = await this.artifacts.read(ref, effectiveCap);
        this.#debitConsumed(bytes.byteLength);
        if (bytes.byteLength > effectiveCap) return null;
        const actual = digestArtifact(ref.name, bytes);
        if (!actual.ok || !same(actual.value, ref)) return null;
        return bytes;
      } catch {
        return null;
      }
    }

    return null;
  }
}

function breakerFromPath(path: string | null): RunEvalCircuitBreakerState | null {
  if (path === '/circuit-breaker/maxTurns') return 'max_turns';
  if (path === '/circuit-breaker/consecutiveToolErrors') return 'consecutive_tool_errors';
  if (path === '/circuit-breaker/repairNoProgress') return 'no_progress';
  return null;
}

function breakerFromValue(value: unknown): RunEvalCircuitBreakerState | null {
  if (typeof value === 'string') {
    if (value === 'none' || value === 'max_turns' || value === 'consecutive_tool_errors' || value === 'no_progress') {
      return value;
    }
    return breakerFromPath(value);
  }
  if (isRecord(value)) {
    const byReason = breakerFromValue(own(value, 'reason'));
    if (byReason !== null) return byReason;
    const byState = breakerFromValue(own(value, 'state'));
    if (byState !== null) return byState;
    return breakerFromPath(ownString(value, 'path'));
  }
  return null;
}

function extractBreakerFromOutcomeRecord(doc: Record<string, unknown>): RunEvalCircuitBreakerState | null {
  const direct = breakerFromValue(own(doc, 'circuitBreaker')) ?? breakerFromValue(own(doc, 'breaker'));
  if (direct !== null) return direct;
  const diag = own(doc, 'diagnostic');
  if (isRecord(diag)) {
    const diagBreaker = breakerFromPath(ownString(diag, 'path'));
    if (diagBreaker !== null) return diagBreaker;
  }
  const nestedOutcome = own(doc, 'outcome');
  if (isRecord(nestedOutcome)) {
    const nestedDirect = breakerFromValue(own(nestedOutcome, 'circuitBreaker')) ?? breakerFromValue(own(nestedOutcome, 'breaker'));
    if (nestedDirect !== null) return nestedDirect;
    const err = own(nestedOutcome, 'error');
    if (isRecord(err)) {
      const errBreaker = breakerFromPath(ownString(err, 'path'));
      if (errBreaker !== null) return errBreaker;
    }
  }
  const err = own(doc, 'error');
  if (isRecord(err)) {
    const errBreaker = breakerFromPath(ownString(err, 'path'));
    if (errBreaker !== null) return errBreaker;
  }
  return null;
}

interface MutableBucket {
  inputTokens: number;
  outputTokens: number;
  knownCostMicrousd: number;
  knownCostCount: number;
  unknownCostCount: number;
  modelCalls: number;
  toolCalls: number;
  elapsedMs: number;
  elapsedCount: number;
  elapsedIncomplete: boolean;
}

function createMutableBucket(): MutableBucket {
  return {
    inputTokens: 0,
    outputTokens: 0,
    knownCostMicrousd: 0,
    knownCostCount: 0,
    unknownCostCount: 0,
    modelCalls: 0,
    toolCalls: 0,
    elapsedMs: 0,
    elapsedCount: 0,
    elapsedIncomplete: false,
  };
}

function addQuantityToTokens(quantity: Quantity | undefined): number {
  if (!quantity || quantity.provenance === 'unknown') return 0;
  return quantity.value;
}

function isProvablyUnexecutedRequest(row: RequestRecord): boolean {
  if (row.resolution?.kind === 'not_executed') {
    return true;
  }
  return (
    (row.state === 'released' || row.state === 'reserved')
    && row.dispatch === null
    && row.initialObservation === null
    && row.resolution === null
  );
}

function addRequestUsageToBucket(bucket: MutableBucket, row: RequestRecord): void {
  if (isProvablyUnexecutedRequest(row)) {
    return;
  }
  bucket.modelCalls += 1;
  const obs = row.resolution?.kind === 'terminal_usage' ? row.resolution.observation : row.initialObservation;
  const usage = obs?.usage ?? null;
  if (usage === null) {
    bucket.unknownCostCount += 1;
    return;
  }
  bucket.inputTokens += addQuantityToTokens(usage.inputTokens);
  bucket.outputTokens += addQuantityToTokens(usage.outputTokens);
  if (usage.costMicrousd.provenance === 'unknown') {
    bucket.unknownCostCount += 1;
  } else {
    bucket.knownCostMicrousd += usage.costMicrousd.value;
    bucket.knownCostCount += 1;
  }
}

function addElapsedToBucket(bucket: MutableBucket, delta: number | null): void {
  if (delta === null) {
    bucket.elapsedIncomplete = true;
    return;
  }
  bucket.elapsedMs += delta;
  bucket.elapsedCount += 1;
}

function finalizeBucketCost(bucket: MutableBucket): {
  readonly costMicrousd: number | null;
  readonly costCompleteness: RunEvalCostCompleteness;
} {
  if (bucket.knownCostCount === 0) {
    return { costMicrousd: null, costCompleteness: 'unavailable' };
  }
  if (bucket.unknownCostCount > 0) {
    return { costMicrousd: bucket.knownCostMicrousd, costCompleteness: 'partial' };
  }
  return { costMicrousd: bucket.knownCostMicrousd, costCompleteness: 'complete' };
}

function finalizeBucketElapsed(bucket: MutableBucket): number | null {
  if (bucket.elapsedIncomplete || bucket.elapsedCount === 0) return null;
  return bucket.elapsedMs;
}

function findAttemptForRequest(attempts: readonly ControllerAttempt[], sequence: number): ControllerAttempt | null {
  for (const attempt of attempts) {
    if (sequence > attempt.before.requests && (attempt.finished === null || sequence <= attempt.finished.after.requests)) {
      return attempt;
    }
  }
  return null;
}

function findAttemptForOperation(attempts: readonly ControllerAttempt[], sequence: number): ControllerAttempt | null {
  for (const attempt of attempts) {
    if (sequence > attempt.before.operations && (attempt.finished === null || sequence <= attempt.finished.after.operations)) {
      return attempt;
    }
  }
  return null;
}

function isToolOperation(op: OperationRecord): boolean {
  if (op.intent.effect === 'model_call' || op.intent.effect === 'external_write') return false;
  const receipt = op.reconciliation ?? op.initialReceipt;
  if (receipt?.evidence.method === 'local-tool-v1') return true;
  if (
    op.intent.targetIdentity.startsWith('verifier:') ||
    op.intent.targetIdentity.startsWith('gate:') ||
    receipt?.evidence.producerId === 'loopwright.byte-verifier.v1' ||
    receipt?.evidence.producerId === 'loopwright.gate-verifier.v1'
  ) {
    return false;
  }
  return op.intent.operationId.startsWith('tool-');
}

function isTerminalRunStatus(status: string | null, head: ProgressHead | null): boolean {
  if (status === null || NON_TERMINAL_STATUSES.has(status)) return false;
  if (head !== null) {
    if (head.progress.terminalIntent !== null) return true;
    const stageKind = head.progress.stage.kind;
    if (stageKind.startsWith('terminal') || stageKind === 'reconcile_result') return true;
    return false;
  }
  return true;
}

/** Deterministic, zero-LLM run health evaluator operating on a single consistent journal revision. */
export async function evaluateRunHealth(input: EvaluateRunHealthInput): Promise<RunEvalReport> {
  const defaultScrubber = new SecretScrubber();
  const combinedScrub = (value: string): string => {
    const first = defaultScrubber.scrub(value);
    return input.scrub ? defaultScrubber.scrub(input.scrub(first)) : first;
  };
  const clean = (value: string): string => sanitizeReportText(value, { scrub: combinedScrub, singleLine: true });

  const reader = new BoundedArtifactReader(input.artifactsDirectory, input.artifacts);
  const { plan, records, head } = input;
  const attempts = head?.progress.attempts ?? [];
  const clockTrusted = records.view.clockStatus === 'trusted';

  const dagById = new Map(plan.orderedDAG.map(node => [node.id, node]));
  const roleById = new Map(plan.roles.map(role => [role.roleId, role]));
  const slotById = new Map(plan.verifierSlots.map(slot => [slot.id, slot]));
  const slotIndexById = new Map(plan.verifierSlots.map((slot, index) => [slot.id, index]));
  const checkpointById = new Map(records.checkpoints.map(cp => [cp.checkpointId, cp]));
  const requestById = new Map(records.requests.map(req => [req.admission.requestId, req]));

  const isDelegatedStep = (stepId: string): boolean => {
    const node = dagById.get(stepId);
    if (!node?.roleId) return false;
    return roleById.get(node.roleId)?.adapter === 'delegated';
  };

  // 1. Attempts classification, circuit-breaker metadata, and unchanged-digest repair counting.
  let ordinaryAttempts = 0;
  let formatAttempts = 0;
  let implementationAttempts = 0;
  let reworkAttempts = 0;
  let unchangedDigestRepairs = 0;
  let piAttempts = 0;
  let delegatedAttempts = 0;
  let readablePiOutcomeCount = 0;
  let unreadablePiOutcomeCount = 0;
  let trippedBreaker: RunEvalCircuitBreakerState | null = null;

  const stepBuckets = new Map<string, { readonly roleId: string | null; readonly bucket: MutableBucket }>();
  const roleBuckets = new Map<string, MutableBucket>();
  const totalsBucket = createMutableBucket();

  const ensureStepBucket = (stepId: string, fallbackRoleId: string | null): MutableBucket => {
    const existing = stepBuckets.get(stepId);
    if (existing !== undefined) return existing.bucket;
    const roleId = dagById.get(stepId)?.roleId ?? fallbackRoleId;
    const bucket = createMutableBucket();
    stepBuckets.set(stepId, { roleId, bucket });
    return bucket;
  };

  const ensureRoleBucket = (roleId: string): MutableBucket => {
    let bucket = roleBuckets.get(roleId);
    if (bucket === undefined) {
      bucket = createMutableBucket();
      roleBuckets.set(roleId, bucket);
    }
    return bucket;
  };

  for (const attempt of attempts) {
    if (attempt.repair === 'format') formatAttempts += 1;
    else if (attempt.repair === 'implementation') implementationAttempts += 1;
    else if ((attempt.reworkEpoch ?? 0) > 0) reworkAttempts += 1;
    else ordinaryAttempts += 1;

    const delegated = isDelegatedStep(attempt.nodeId);
    if (delegated) delegatedAttempts += 1;
    else piAttempts += 1;

    const stepNode = dagById.get(attempt.nodeId);
    const roleId = stepNode?.roleId ?? null;
    const stepBucket = ensureStepBucket(attempt.nodeId, roleId);
    const roleBucket = roleId !== null ? ensureRoleBucket(roleId) : null;

    if (delegated && attempt.purpose !== 'compaction') {
      stepBucket.modelCalls += 1;
      stepBucket.unknownCostCount += 1;
      if (roleBucket !== null) {
        roleBucket.modelCalls += 1;
        roleBucket.unknownCostCount += 1;
      }
      totalsBucket.modelCalls += 1;
      totalsBucket.unknownCostCount += 1;
    }

    const preCp = checkpointById.get(phaseCheckpointId(input.runId, `role.${attempt.ordinal}.pre`));
    const postCp = checkpointById.get(phaseCheckpointId(input.runId, `role.${attempt.ordinal}.post`));
    const delta = monotonicDeltaMs(preCp, postCp, clockTrusted);
    addElapsedToBucket(stepBucket, delta);
    if (roleBucket !== null) addElapsedToBucket(roleBucket, delta);

    if (
      attempt.repair === 'implementation'
      && attempt.finished !== null
      && attempt.finished.nativeCheckpointId !== null
      && preCp !== undefined
    ) {
      const afterCp = postCp ?? checkpointById.get(attempt.finished.nativeCheckpointId);
      if (afterCp !== undefined && afterCp.subject.candidateDigest.hex === preCp.subject.candidateDigest.hex) {
        unchangedDigestRepairs += 1;
      }
    }

    if (!delegated && attempt.finished !== null) {
      const parsed = await reader.readJson(attempt.finished.outcome, RUN_EVAL_ARTIFACT_MAX_BYTES);
      if (!parsed.ok || !isRecord(parsed.value)) {
        unreadablePiOutcomeCount += 1;
      } else {
        let detected = extractBreakerFromOutcomeRecord(parsed.value);
        let nativeReadFailed = false;
        const nativeOutcomeRef = own(parsed.value, 'nativeOutcome');
        if (detected === null && nativeOutcomeRef !== undefined && nativeOutcomeRef !== null) {
          const nativeParsed = await reader.readJson(nativeOutcomeRef, RUN_EVAL_ARTIFACT_MAX_BYTES);
          if (nativeParsed.ok && isRecord(nativeParsed.value)) {
            detected = extractBreakerFromOutcomeRecord(nativeParsed.value);
          } else {
            nativeReadFailed = true;
          }
        }
        if (detected !== null && detected !== 'none') {
          trippedBreaker = detected;
          readablePiOutcomeCount += 1;
        } else if (nativeReadFailed) {
          unreadablePiOutcomeCount += 1;
        } else {
          readablePiOutcomeCount += 1;
        }
      }
    }
  }

  // 2. Model request tokens and cost breakdown.
  for (const req of records.requests) {
    const attempt = findAttemptForRequest(attempts, req.sequence);
    const stepId = attempt?.nodeId ?? req.admission.nodeId;
    const roleId = dagById.get(stepId)?.roleId ?? req.admission.roleId;
    addRequestUsageToBucket(ensureStepBucket(stepId, roleId), req);
    addRequestUsageToBucket(ensureRoleBucket(roleId), req);
    addRequestUsageToBucket(totalsBucket, req);
  }

  // 3. Tool telemetry & repeated failing tool calls (`local-tool-v1` bounded to <= 4 KiB).
  let totalToolOps = 0;
  let parsedToolOps = 0;
  let unreadableToolOps = 0;
  let totalFailingToolCalls = 0;
  const failingToolCounts = new Map<string, { readonly roleId: string; readonly stepId: string; readonly tool: string; readonly target: string; count: number }>();

  for (const op of records.operations) {
    if (!isToolOperation(op)) continue;
    totalToolOps += 1;
    const receipt = op.reconciliation ?? op.initialReceipt;
    const attempt = findAttemptForOperation(attempts, op.sequence);

    let toolName: string | null = null;
    let targetText: string | null = null;
    let parentRequestId: string | null = null;
    let payloadOutcome: string | null = null;

    if (receipt?.evidence.artifact !== undefined) {
      const readRes = await reader.readJson(receipt.evidence.artifact, RUN_EVAL_LOCAL_TOOL_RECEIPT_MAX_BYTES);
      if (readRes.ok && isRecord(readRes.value)) {
        parsedToolOps += 1;
        toolName = ownString(readRes.value, 'tool');
        targetText = ownString(readRes.value, 'target');
        parentRequestId = ownString(readRes.value, 'parentRequestId');
        payloadOutcome = ownString(readRes.value, 'outcome');
      } else {
        unreadableToolOps += 1;
      }
    } else {
      unreadableToolOps += 1;
    }

    const parentReq = parentRequestId !== null ? requestById.get(parentRequestId) : undefined;
    const stepId = attempt?.nodeId ?? parentReq?.admission.nodeId ?? op.intent.nodeId;
    const roleId = dagById.get(stepId)?.roleId ?? parentReq?.admission.roleId ?? 'unknown';

    ensureStepBucket(stepId, roleId).toolCalls += 1;
    ensureRoleBucket(roleId).toolCalls += 1;
    totalsBucket.toolCalls += 1;

    const failed = receipt?.outcome === 'failed' || payloadOutcome === 'failed';
    if (failed) {
      totalFailingToolCalls += 1;
      if (toolName !== null) {
        const cleanRole = clean(roleId);
        const cleanStep = clean(stepId);
        const cleanTool = clean(toolName);
        const cleanTarget = clean(targetText ?? op.intent.targetIdentity);
        const key = `${cleanRole}\0${cleanStep}\0${cleanTool}\0${cleanTarget}`;
        const existing = failingToolCounts.get(key);
        if (existing !== undefined) {
          existing.count += 1;
        } else {
          failingToolCounts.set(key, {
            roleId: cleanRole,
            stepId: cleanStep,
            tool: cleanTool,
            target: cleanTarget,
            count: 1,
          });
        }
      }
    }
  }

  const repeatedTools: RunEvalToolRepeat[] = [...failingToolCounts.values()]
    .filter(item => item.count >= 2)
    .sort((a, b) =>
      b.count - a.count ||
      compareUtf16(a.roleId, b.roleId) ||
      compareUtf16(a.stepId, b.stepId) ||
      compareUtf16(a.tool, b.tool) ||
      compareUtf16(a.target, b.target),
    )
    .map(item => ({
      roleId: item.roleId,
      stepId: item.stepId,
      tool: item.tool,
      target: item.target,
      count: item.count,
    }));

  const allRolesDelegated = plan.roles.length > 0 && plan.roles.every(role => role.adapter === 'delegated');
  let toolTelemetry: RunEvalToolTelemetryState;
  if (delegatedAttempts > 0 && piAttempts === 0 && totalToolOps === 0) {
    toolTelemetry = 'delegated_unavailable';
  } else if (piAttempts === 0 && delegatedAttempts === 0 && allRolesDelegated && totalToolOps === 0) {
    toolTelemetry = 'delegated_unavailable';
  } else if (delegatedAttempts > 0 && (piAttempts > 0 || totalToolOps > 0)) {
    toolTelemetry = 'partial';
  } else if (totalToolOps > 0) {
    toolTelemetry = unreadableToolOps === 0 ? 'available' : parsedToolOps > 0 ? 'partial' : 'unavailable';
  } else if (piAttempts > 0) {
    toolTelemetry = 'available';
  } else {
    toolTelemetry = 'unavailable';
  }

  const circuitBreaker: RunEvalCircuitBreakerState =
    trippedBreaker !== null
      ? trippedBreaker
      : readablePiOutcomeCount > 0 && unreadablePiOutcomeCount === 0
        ? 'none'
        : 'unavailable';

  // 4. Verifier outputs across generations -> ping-pong check oscillations, repeats, failingCheckDelta, check elapsedMs.
  interface GenerationChecks {
    evaluatedCount: number;
    readonly failedItems: { readonly checkId: string; readonly reason: string }[];
  }
  const byGeneration = new Map<number, GenerationChecks>();
  const ensureGeneration = (gen: number): GenerationChecks => {
    let entry = byGeneration.get(gen);
    if (entry === undefined) {
      entry = { evaluatedCount: 0, failedItems: [] };
      byGeneration.set(gen, entry);
    }
    return entry;
  };

  const failedReceiptCountsByEvidence = new Map<string, number>();
  for (const row of head?.progress.verifierReceipts ?? []) {
    const slot = slotById.get(row.slot);
    const slotIndex = slotIndexById.get(row.slot);
    if (slot !== undefined && slotIndex !== undefined) {
      const preCp = checkpointById.get(phaseCheckpointId(input.runId, `verify.${row.generation}.${slotIndex}.pre`));
      const postCp = checkpointById.get(phaseCheckpointId(input.runId, `verify.${row.generation}.${slotIndex}.post`));
      const delta = monotonicDeltaMs(preCp, postCp, clockTrusted);
      for (const dagNode of plan.orderedDAG) {
        if (dagNode.kind === 'check' && dagNode.handler.id === slot.handler.id) {
          addElapsedToBucket(ensureStepBucket(dagNode.id, null), delta);
        }
      }
    }
    if (row.output === null) continue;
    const parsed = await reader.readJson(row.output, RUN_EVAL_ARTIFACT_MAX_BYTES);
    if (!parsed.ok || !isRecord(parsed.value)) continue;
    const response = own(parsed.value, 'response');
    const disposition = own(parsed.value, 'disposition');
    const binding = own(parsed.value, 'binding');
    const checkId =
      (isRecord(binding) ? ownString(binding, 'checkId') : null) ??
      slot?.checkId ??
      row.slot;
    const statusValue =
      (isRecord(response) ? ownString(response, 'status') : null) ??
      (isRecord(disposition) ? ownString(disposition, 'status') : null);
    const reasonValue =
      (isRecord(response) ? ownString(response, 'reason') : null) ??
      (isRecord(disposition) ? ownString(disposition, 'reason') : null);
    if (statusValue === null) continue;
    const genEntry = ensureGeneration(row.generation);
    genEntry.evaluatedCount += 1;
    if (statusValue === 'failed') {
      genEntry.failedItems.push({
        checkId: clean(checkId),
        reason: clean(reasonValue ?? 'failed'),
      });
      const evHex = row.output.digest.hex;
      failedReceiptCountsByEvidence.set(evHex, (failedReceiptCountsByEvidence.get(evHex) ?? 0) + 1);
    }
  }

  let fallbackExtraRepeats = 0;
  for (const failure of head?.progress.failures ?? []) {
    const genEntry = ensureGeneration(failure.generation);
    if (genEntry.evaluatedCount === 0 && genEntry.failedItems.length === 0) {
      genEntry.evaluatedCount += 1;
      genEntry.failedItems.push({
        checkId: 'failure',
        reason: failure.signature.hex.slice(0, 12),
      });
      if (failure.count > 1) {
        fallbackExtraRepeats += failure.count - 1;
      }
    } else if (failure.count > 1 && failure.evidence !== null) {
      const matchedReceipts = failedReceiptCountsByEvidence.get(failure.evidence.digest.hex) ?? 0;
      if (matchedReceipts > 0 && failure.count > matchedReceipts) {
        fallbackExtraRepeats += failure.count - matchedReceipts;
      }
    }
  }

  const sortedGenerations = [...byGeneration.entries()].sort((a, b) => a[0] - b[0]);
  const failingSignatures: { readonly generation: number; readonly signature: string }[] = [];
  for (const [generation, info] of sortedGenerations) {
    if (info.failedItems.length === 0) continue;
    const parts = [...new Set(info.failedItems.map(item => `${item.checkId}:${item.reason}`))].sort(compareUtf16);
    failingSignatures.push({ generation, signature: parts.join('|') });
  }

  let checkOscillations = 0;
  let repeatedFailureSignatures = fallbackExtraRepeats;
  const lastSeenSigIndex = new Map<string, number>();

  for (let i = 0; i < failingSignatures.length; i += 1) {
    const entry = failingSignatures[i]!;
    const prev = lastSeenSigIndex.get(entry.signature);
    if (prev !== undefined) {
      if (prev === i - 1) {
        repeatedFailureSignatures += 1;
      } else {
        checkOscillations += 1;
      }
    }
    lastSeenSigIndex.set(entry.signature, i);
  }

  // 5. Candidate digest cycles (Da -> Db -> Da).
  const sortedCheckpoints = [...records.checkpoints].sort((a, b) => a.sequence - b.sequence);
  const distinctDigests: string[] = [];
  for (const cp of sortedCheckpoints) {
    const hex = cp.subject.candidateDigest.hex;
    if (distinctDigests.at(-1) !== hex) {
      distinctDigests.push(hex);
    }
  }
  const seenDigests = new Set<string>();
  let digestCycles = 0;
  for (const hex of distinctDigests) {
    if (seenDigests.has(hex)) {
      digestCycles += 1;
    } else {
      seenDigests.add(hex);
    }
  }

  // 6. Repeated reworks count.
  const reworkVerdictCount = (head?.progress.stepVerdicts ?? []).filter(item => item.verdict === 'rework').length;
  const totalReworks = Math.max(head?.progress.reworkEpoch ?? 0, reworkVerdictCount);
  const repeatedReworks = Math.max(0, totalReworks - 1);

  const pingPong: RunEvalPingPong = {
    detected: checkOscillations > 0 || repeatedFailureSignatures > 0 || digestCycles > 0 || repeatedReworks > 0,
    checkOscillations,
    repeatedFailureSignatures,
    digestCycles,
    repeatedReworks,
    totalReworks,
  };

  // 7. Repair convergence metrics.
  const evaluatedGenerations = sortedGenerations.filter(([, info]) => info.evaluatedCount > 0);
  const firstFailingGen = evaluatedGenerations.find(([, info]) => info.failedItems.length > 0);
  const lastEvaluatedGen = evaluatedGenerations.at(-1);
  const initialFailingChecks = firstFailingGen !== undefined ? firstFailingGen[1].failedItems.length : null;
  const finalFailingChecks =
    firstFailingGen !== undefined && lastEvaluatedGen !== undefined ? lastEvaluatedGen[1].failedItems.length : null;
  const failingCheckDelta =
    initialFailingChecks !== null && finalFailingChecks !== null ? finalFailingChecks - initialFailingChecks : null;

  const cleanStatus = input.status !== null ? clean(input.status) : null;
  const terminal = isTerminalRunStatus(cleanStatus, head);
  const converged: boolean | null = terminal
    ? cleanStatus !== null && TERMINAL_SUCCESS_STATUSES.has(cleanStatus)
    : null;

  const repairConvergence: RunEvalRepairConvergence = {
    attempts: {
      ordinary: ordinaryAttempts,
      format: formatAttempts,
      implementation: implementationAttempts,
      rework: reworkAttempts,
    },
    unchangedDigestRepairs,
    initialFailingChecks,
    finalFailingChecks,
    failingCheckDelta,
    converged,
  };

  // 8. Finalize step, role, and total breakdowns.
  const stepOrder = new Map(plan.orderedDAG.map((node, index) => [node.id, index]));
  const roleOrder = new Map(plan.roles.map((role, index) => [role.roleId, index]));

  const byStep: RunEvalStepBreakdown[] = [...stepBuckets.entries()]
    .sort(([a], [b]) => {
      const idxA = stepOrder.get(a) ?? Number.MAX_SAFE_INTEGER;
      const idxB = stepOrder.get(b) ?? Number.MAX_SAFE_INTEGER;
      return idxA - idxB || compareUtf16(a, b);
    })
    .map(([stepId, entry]) => {
      const cost = finalizeBucketCost(entry.bucket);
      return {
        stepId: clean(stepId),
        roleId: entry.roleId !== null ? clean(entry.roleId) : null,
        tokens: {
          input: entry.bucket.inputTokens,
          output: entry.bucket.outputTokens,
          total: entry.bucket.inputTokens + entry.bucket.outputTokens,
        },
        costMicrousd: cost.costMicrousd,
        costCompleteness: cost.costCompleteness,
        modelCalls: entry.bucket.modelCalls,
        toolCalls: entry.bucket.toolCalls,
        elapsedMs: finalizeBucketElapsed(entry.bucket),
      };
    });

  const byRole: RunEvalRoleBreakdown[] = [...roleBuckets.entries()]
    .sort(([a], [b]) => {
      const idxA = roleOrder.get(a) ?? Number.MAX_SAFE_INTEGER;
      const idxB = roleOrder.get(b) ?? Number.MAX_SAFE_INTEGER;
      return idxA - idxB || compareUtf16(a, b);
    })
    .map(([roleId, bucket]) => {
      const cost = finalizeBucketCost(bucket);
      return {
        roleId: clean(roleId),
        tokens: {
          input: bucket.inputTokens,
          output: bucket.outputTokens,
          total: bucket.inputTokens + bucket.outputTokens,
        },
        costMicrousd: cost.costMicrousd,
        costCompleteness: cost.costCompleteness,
        modelCalls: bucket.modelCalls,
        toolCalls: bucket.toolCalls,
        elapsedMs: finalizeBucketElapsed(bucket),
      };
    });

  const totalCost = finalizeBucketCost(totalsBucket);
  const totals: RunEvalBreakdownTotals = {
    tokens: {
      input: totalsBucket.inputTokens,
      output: totalsBucket.outputTokens,
      total: totalsBucket.inputTokens + totalsBucket.outputTokens,
    },
    costMicrousd: totalCost.costMicrousd,
    costCompleteness: totalCost.costCompleteness,
    modelCalls: totalsBucket.modelCalls,
    toolCalls: totalsBucket.toolCalls,
    elapsedMs: totalMonotonicElapsedMs(records.checkpoints, clockTrusted),
  };

  // 9. Deterministic, human-reviewed suggestions (0..8, all autoApplied: false, scrubbed).
  const rawSuggestions: RunEvalSuggestion[] = [];
  const pushSuggestion = (
    code: string,
    severity: RunEvalSuggestionSeverity,
    summary: string,
    evidence: string,
  ): void => {
    rawSuggestions.push({
      autoApplied: false,
      code: clean(code),
      severity,
      summary: clean(summary),
      evidence: clean(evidence),
    });
  };

  if (circuitBreaker === 'max_turns' || circuitBreaker === 'consecutive_tool_errors' || circuitBreaker === 'no_progress') {
    pushSuggestion(
      'CIRCUIT_BREAKER_TRIPPED',
      'high',
      `Session halted by circuit breaker (${circuitBreaker}); narrow task scope or refine role tool instructions before retrying.`,
      `circuitBreaker=${circuitBreaker}, failingToolCalls=${totalFailingToolCalls}`,
    );
  }
  if (repeatedTools.length > 0) {
    const top = repeatedTools[0]!;
    pushSuggestion(
      'REPEATED_TOOL_FAILURES',
      top.count >= 3 ? 'high' : 'medium',
      `Role ${top.roleId} on step ${top.stepId} failed ${top.tool} ${top.count} times on ${top.target}; verify scope rules and tool usage guidance.`,
      repeatedTools
        .slice(0, 3)
        .map(item => `${item.roleId}/${item.stepId}:${item.tool}(${item.target})x${item.count}`)
        .join('; '),
    );
  }
  if (pingPong.checkOscillations > 0) {
    pushSuggestion(
      'CHECK_OSCILLATION',
      'high',
      'Failing check signatures oscillated across repair attempts; review conflicting acceptance checks or split changes into smaller steps.',
      `checkOscillations=${pingPong.checkOscillations}`,
    );
  }
  if (pingPong.digestCycles > 0) {
    pushSuggestion(
      'DIGEST_CYCLE',
      'high',
      'Candidate workspace returned to a previous digest; review repair prompts and check criteria to eliminate circular edits.',
      `digestCycles=${pingPong.digestCycles}`,
    );
  }
  if (pingPong.repeatedFailureSignatures > 0) {
    pushSuggestion(
      'REPEATED_CHECK_FAILURES',
      'medium',
      'Identical failing check signatures repeated across attempts; ensure repair diagnostics surface actionable root causes.',
      `repeatedFailureSignatures=${pingPong.repeatedFailureSignatures}`,
    );
  }
  if (unchangedDigestRepairs > 0) {
    pushSuggestion(
      'UNCHANGED_DIGEST_REPAIRS',
      'medium',
      'One or more implementation repair attempts made no candidate file changes; verify writable scope and mutation tools for the repairing role.',
      `unchangedDigestRepairs=${unchangedDigestRepairs}`,
    );
  }
  if (pingPong.repeatedReworks > 0) {
    pushSuggestion(
      'REPEATED_REWORKS',
      'medium',
      'Workflow triggered repeated rework loops; tighten upstream step instructions or handoff criteria before review gates.',
      `repeatedReworks=${pingPong.repeatedReworks}, totalReworks=${pingPong.totalReworks}`,
    );
  }
  if (formatAttempts > 0) {
    pushSuggestion(
      'FORMAT_REPAIR_OVERHEAD',
      'low',
      'Role required format-repair turns to produce valid JSON output; reinforce exact response schema instructions.',
      `formatRepairs=${formatAttempts}`,
    );
  }
  if (converged === false && (implementationAttempts > 0 || reworkAttempts > 0)) {
    pushSuggestion(
      'NON_CONVERGENT_REPAIRS',
      'medium',
      'Repair or rework attempts did not converge to a passing terminal outcome; inspect final check failures before increasing attempt budgets.',
      `status=${cleanStatus ?? 'unknown'}, failingCheckDelta=${failingCheckDelta === null ? 'unavailable' : String(failingCheckDelta)}`,
    );
  }
  if (toolTelemetry === 'delegated_unavailable' && converged === false) {
    pushSuggestion(
      'DELEGATED_TOOL_TELEMETRY_UNAVAILABLE',
      'low',
      'Tool-level telemetry is unavailable for delegated adapter steps; inspect delegated agent logs for repeated tool failures.',
      'toolTelemetry=delegated_unavailable',
    );
  }

  const suggestions = rawSuggestions
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || compareUtf16(a.code, b.code))
    .slice(0, RUN_EVAL_MAX_SUGGESTIONS);

  return freeze({
    schemaVersion: RUN_EVAL_SCHEMA_VERSION,
    runId: clean(input.runId),
    status: cleanStatus,
    journalRevision: records.view.revision,
    toolTelemetry,
    toolRepeats: {
      items: repeatedTools,
      totalFailingCalls: totalFailingToolCalls,
      circuitBreaker,
    },
    pingPong,
    repairConvergence,
    breakdown: {
      byStep,
      byRole,
      totals,
    },
    suggestions,
  });
}
