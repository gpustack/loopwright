import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  matchesDriverConstraint,
  VERIFIER_ARTIFACT_LIMITS,
  type HardwareTargetSpec,
} from '@loopwright/core';
import {
  canonicalJson,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_MAX_JOBS,
  DEFAULT_SWEEP_INTERVAL_MS,
  DEFAULT_VERDICT_TTL_MS,
} from './config.js';
import {
  HardwareRunnerError,
  type AcquireLeaseInput,
  type BenchmarkOutputArtifact,
  type BenchmarkRequest,
  type BenchmarkVerdict,
  type ClockSource,
  type CompleteLeaseInput,
  type HeartbeatLeaseInput,
  type HeartbeatResponse,
  type LeaseCredentials,
  type LeaseGrant,
  type LeaseState,
  type PreemptLeaseInput,
  type PreemptResponse,
  type RelayJobSnapshot,
  type RelayJobState,
  type WorkerCapabilities,
  type WorkerJobPayload,
} from './types.js';

export const CLOCK_DRIFT_LIMIT_MS = 1_000;
export const MAX_ACQUIRE_WAIT_MS = 25_000;
export const MAX_BENCHMARK_VERDICT_BYTES = 65_536;
const EMPTY_SHA256_HEX = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export const DEFAULT_CLOCK_SOURCE: ClockSource = Object.freeze({
  nowMonotonicMs(): number {
    return Number(process.hrtime.bigint() / 1_000_000n);
  },
  nowWallMs(): number {
    return Date.now();
  },
});

export interface CommittedOutputBlob {
  readonly sha256: string;
  readonly byteLength: number;
}

export interface RecoveredTerminalOperationInput {
  readonly verdict: BenchmarkVerdict;
  readonly request?: BenchmarkRequest;
}

export interface RelayPullQueueOptions {
  readonly leaseTtlMs?: number;
  readonly sweepIntervalMs?: number;
  readonly verdictTtlMs?: number;
  readonly maxJobs?: number;
  readonly maxRetainedTerminalOps?: number;
  readonly clock?: ClockSource;
  readonly startSweepTimer?: boolean;
  readonly onTerminalVerdict?: (verdict: BenchmarkVerdict) => void;
}

export interface PreparedLeaseCompletion {
  readonly operationId: string;
  readonly verdict: BenchmarkVerdict;
  readonly outputArtifacts: readonly BenchmarkOutputArtifact[];
  commit(beforePublish?: () => void): BenchmarkVerdict;
  abort(): void;
}

interface SampledClock {
  readonly monoMs: number;
  readonly wallMs: number;
}

interface MutableLease {
  readonly relayBootId: string;
  readonly jobId: string;
  readonly workerId: string;
  readonly leaseEpoch: number;
  readonly leaseToken: string;
  readonly grantedMonotonicMs: number;
  notAfterMonotonicMs: number;
  readonly createdWallMs: number;
  readonly createdMonotonicMs: number;
  lastWallMs: number;
  lastMonotonicMs: number;
  cancelRequested: boolean;
}

interface EvictedEpochRecord {
  readonly leaseToken: string;
  readonly status: 'requeued' | 'preempted_exhausted';
}

interface InternalJob {
  readonly jobId: string;
  readonly operationId: string;
  request: BenchmarkRequest | null;
  requestCanonical: string | null;
  state: RelayJobState;
  preemptionCount: number;
  currentLeaseEpoch: number;
  activeLease: MutableLease | null;
  completingEpoch: number | null;
  terminalVerdict: BenchmarkVerdict | null;
  readonly evictedEpochs: Map<number, EvictedEpochRecord>;
  readonly committedOutputsByEpoch: Map<number, Map<string, number>>;
  readonly cancelListenersByEpoch: Map<number, Set<(reason: 'cancel' | 'shutdown') => void>>;
  readonly verdictWaiters: Set<(verdict: BenchmarkVerdict | null) => void>;
}

interface AcquireWaiter {
  readonly workerId: string;
  readonly capabilities: WorkerCapabilities;
  readonly resolve: (grant: LeaseGrant | null) => void;
  readonly cleanup: () => void;
}

export function timingSafeEqualStrings(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left, 'utf8').digest();
  const rightDigest = createHash('sha256').update(right, 'utf8').digest();
  const digestsMatch = timingSafeEqual(leftDigest, rightDigest);
  return digestsMatch && left.length === right.length;
}

export function matchesWorkerCapabilities(
  target: HardwareTargetSpec,
  heldOutWorkloadId: string,
  capabilities: WorkerCapabilities,
): boolean {
  if (capabilities.accelerator !== target.accelerator) return false;
  if (!capabilities.isolationModes.includes(target.isolationMode)) return false;
  const requiredDevices = target.deviceCount ?? 1;
  if (capabilities.deviceCount < requiredDevices) return false;
  if (target.topology !== undefined && capabilities.topology !== target.topology) return false;
  if (
    target.driverConstraint !== undefined
    && !matchesDriverConstraint(target.driverConstraint, capabilities.driverVersion)
  ) {
    return false;
  }
  if (capabilities.workloadIds !== undefined && !capabilities.workloadIds.includes(heldOutWorkloadId)) {
    return false;
  }
  return true;
}

function clockStepValid(created: SampledClock, last: SampledClock, now: SampledClock): boolean {
  if (now.monoMs < last.monoMs || now.wallMs < last.wallMs) {
    return false;
  }
  const adjacent = BigInt(now.wallMs - last.wallMs) - BigInt(now.monoMs - last.monoMs);
  const cumulative = BigInt(now.wallMs - created.wallMs) - BigInt(now.monoMs - created.monoMs);
  const limit = BigInt(CLOCK_DRIFT_LIMIT_MS);
  return adjacent >= -limit && adjacent <= limit && cumulative >= -limit && cumulative <= limit;
}

function buildWorkerJobPayload(request: BenchmarkRequest, preemptionCount: number): WorkerJobPayload {
  return Object.freeze({
    operationId: request.operationId,
    gateId: request.gateId,
    checkId: request.checkId,
    candidateDigest: request.candidateDigest,
    subject: request.subject,
    targetCellId: request.targetCellId,
    targetHardware: request.targetHardware,
    ...(request.stageAAudit !== undefined ? { stageAAudit: request.stageAAudit } : {}),
    heldOutWorkloadId: request.heldOutWorkloadId,
    metricThresholds: request.metricThresholds,
    maxPreemptions: request.maxPreemptions,
    preemptionCount,
    candidateArtifacts: request.candidateArtifacts,
  });
}

function toPublicLeaseState(lease: MutableLease): Omit<LeaseState, 'leaseToken'> {
  return Object.freeze({
    relayBootId: lease.relayBootId,
    jobId: lease.jobId,
    workerId: lease.workerId,
    leaseEpoch: lease.leaseEpoch,
    grantedMonotonicMs: lease.grantedMonotonicMs,
    notAfterMonotonicMs: lease.notAfterMonotonicMs,
    createdWallMs: lease.createdWallMs,
    createdMonotonicMs: lease.createdMonotonicMs,
    lastWallMs: lease.lastWallMs,
    lastMonotonicMs: lease.lastMonotonicMs,
    cancelRequested: lease.cancelRequested,
  });
}

export function verdictMatchesRequestBinding(verdict: BenchmarkVerdict, request: BenchmarkRequest): boolean {
  if (
    verdict.storeId !== request.storeId
    || verdict.runId !== request.runId
    || verdict.lockHash.algorithm !== request.lockHash.algorithm
    || verdict.lockHash.hex !== request.lockHash.hex
    || verdict.operationId !== request.operationId
    || verdict.dispatchId !== request.dispatchId
    || verdict.dispatchGeneration !== request.dispatchGeneration
    || verdict.gateId !== request.gateId
    || verdict.checkId !== request.checkId
    || verdict.candidateDigest !== request.candidateDigest
  ) {
    return false;
  }
  if (verdict.hardwareProvenance !== undefined && verdict.hardwareProvenance.targetCellId !== request.targetCellId) {
    return false;
  }
  return true;
}

export class RelayPullQueue {
  readonly relayBootId: string;
  readonly #leaseTtlMs: number;
  readonly #verdictTtlMs: number;
  readonly #maxJobs: number;
  readonly #maxRetainedTerminalOps: number;
  readonly #clock: ClockSource;
  readonly #onTerminalVerdict: ((verdict: BenchmarkVerdict) => void) | undefined;
  readonly #jobsById = new Map<string, InternalJob>();
  readonly #jobsByOperationId = new Map<string, InternalJob>();
  readonly #activeJobIds = new Set<string>();
  readonly #terminalOperationOrder: string[] = [];
  readonly #queueOrder: string[] = [];
  readonly #acquireWaiters = new Set<AcquireWaiter>();
  readonly #createdSample: SampledClock;
  #lastSample: SampledClock;
  #clockDegraded = false;
  #closed = false;
  #jobSeq = 0;
  #sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: RelayPullQueueOptions = {}) {
    const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    if (!Number.isSafeInteger(leaseTtlMs) || Object.is(leaseTtlMs, -0) || leaseTtlMs < 10) {
      throw new HardwareRunnerError('QUEUE_STATE_INVALID', 'leaseTtlMs must be an integer >= 10');
    }
    const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    if (!Number.isSafeInteger(sweepIntervalMs) || Object.is(sweepIntervalMs, -0) || sweepIntervalMs < 5) {
      throw new HardwareRunnerError('QUEUE_STATE_INVALID', 'sweepIntervalMs must be an integer >= 5');
    }
    const verdictTtlMs = options.verdictTtlMs ?? DEFAULT_VERDICT_TTL_MS;
    if (!Number.isSafeInteger(verdictTtlMs) || Object.is(verdictTtlMs, -0) || verdictTtlMs < 1_000 || verdictTtlMs > 86_400_000) {
      throw new HardwareRunnerError('QUEUE_STATE_INVALID', 'verdictTtlMs must be within 1000..86400000');
    }
    const maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;
    if (!Number.isSafeInteger(maxJobs) || Object.is(maxJobs, -0) || maxJobs < 1) {
      throw new HardwareRunnerError('QUEUE_STATE_INVALID', 'maxJobs must be a positive integer');
    }
    const maxRetainedTerminalOps = options.maxRetainedTerminalOps ?? Math.max(4_096, maxJobs * 16);
    if (!Number.isSafeInteger(maxRetainedTerminalOps) || Object.is(maxRetainedTerminalOps, -0) || maxRetainedTerminalOps < 1) {
      throw new HardwareRunnerError('QUEUE_STATE_INVALID', 'maxRetainedTerminalOps must be a positive integer');
    }

    this.relayBootId = randomBytes(16).toString('hex');
    this.#leaseTtlMs = leaseTtlMs;
    this.#verdictTtlMs = verdictTtlMs;
    this.#maxJobs = maxJobs;
    this.#maxRetainedTerminalOps = maxRetainedTerminalOps;
    this.#clock = options.clock ?? DEFAULT_CLOCK_SOURCE;
    this.#onTerminalVerdict = options.onTerminalVerdict;

    const initial = this.#rawSample();
    this.#createdSample = initial;
    this.#lastSample = initial;

    if (options.startSweepTimer !== false) {
      const timer = setInterval(() => {
        if (!this.#closed) {
          this.sweepExpired();
        }
      }, sweepIntervalMs);
      timer.unref();
      this.#sweepTimer = timer;
    }
  }

  get leaseTtlMs(): number {
    return this.#leaseTtlMs;
  }

  get activeJobCount(): number {
    return this.#activeJobIds.size;
  }

  get maxRetainedTerminalOps(): number {
    return this.#maxRetainedTerminalOps;
  }

  get retainedTerminalCount(): number {
    return this.#terminalOperationOrder.length;
  }

  isClockDegraded(): boolean {
    return this.#clockDegraded;
  }

  hasOperation(operationId: string): boolean {
    return this.#jobsByOperationId.has(operationId);
  }

  isActiveOperation(operationId: string): boolean {
    const job = this.#jobsByOperationId.get(operationId);
    return job !== undefined && this.#activeJobIds.has(job.jobId);
  }

  assertCanAdmitNewJob(): void {
    if (this.#closed) {
      throw new HardwareRunnerError('QUEUE_STATE_INVALID', 'Relay queue is closed');
    }
    this.#sampleAndSweep(false);
    if (this.#activeJobIds.size >= this.#maxJobs) {
      throw new HardwareRunnerError('QUEUE_CAPACITY_EXCEEDED', `Relay queue capacity (${this.#maxJobs}) exceeded`);
    }
  }

  #releaseActiveSlot(job: InternalJob): void {
    if (this.#activeJobIds.delete(job.jobId)) {
      this.#recordRetainedTerminalOp(job.operationId);
    }
  }

  #recordRetainedTerminalOp(operationId: string): void {
    this.#terminalOperationOrder.push(operationId);
    while (this.#terminalOperationOrder.length > this.#maxRetainedTerminalOps) {
      const oldestOp = this.#terminalOperationOrder.shift();
      if (oldestOp === undefined) break;
      const oldestJob = this.#jobsByOperationId.get(oldestOp);
      if (oldestJob && !this.#activeJobIds.has(oldestJob.jobId)) {
        this.#jobsByOperationId.delete(oldestOp);
        this.#jobsById.delete(oldestJob.jobId);
      }
    }
  }

  restoreTerminalOperation(input: RecoveredTerminalOperationInput): void {
    if (this.#closed) {
      throw new HardwareRunnerError('QUEUE_STATE_INVALID', 'Relay queue is closed');
    }
    const { verdict, request } = input;
    if (verdict.status === 'pending') {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'cannot restore pending verdict as terminal operation');
    }
    if (request !== undefined && !verdictMatchesRequestBinding(verdict, request)) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', `recovered request does not match receipt for "${verdict.operationId}"`);
    }
    if (this.#jobsByOperationId.has(verdict.operationId)) {
      throw new HardwareRunnerError('QUEUE_JOB_CONFLICT', `duplicate recovered operation "${verdict.operationId}"`);
    }

    const state: RelayJobState = verdict.status === 'approved' || verdict.status === 'denied'
      ? 'completed'
      : verdict.reason === 'BENCHMARK_CANCELLED'
        ? 'cancelled'
        : 'preempted_exhausted';

    this.#jobSeq += 1;
    const jobId = `job_recovered_${String(this.#jobSeq).padStart(6, '0')}_${randomBytes(6).toString('hex')}`;
    const job: InternalJob = {
      jobId,
      operationId: verdict.operationId,
      request: request ?? null,
      requestCanonical: request !== undefined ? canonicalJson(request) : null,
      state,
      preemptionCount: verdict.preemptionCount,
      currentLeaseEpoch: 0,
      activeLease: null,
      completingEpoch: null,
      terminalVerdict: verdict,
      evictedEpochs: new Map(),
      committedOutputsByEpoch: new Map(),
      cancelListenersByEpoch: new Map(),
      verdictWaiters: new Set(),
    };
    this.#jobsById.set(jobId, job);
    this.#jobsByOperationId.set(verdict.operationId, job);
    this.#recordRetainedTerminalOp(verdict.operationId);
  }

  #rawSample(): SampledClock {
    const monoRaw = this.#clock.nowMonotonicMs();
    const wallRaw = this.#clock.nowWallMs();
    if (!Number.isFinite(monoRaw) || !Number.isFinite(wallRaw)) {
      this.#clockDegraded = true;
      throw new HardwareRunnerError('QUEUE_LEASE_FENCED', 'ClockSource returned non-finite timestamp');
    }
    const monoMs = Math.trunc(monoRaw);
    const wallMs = Math.trunc(wallRaw);
    if (!Number.isSafeInteger(monoMs) || !Number.isSafeInteger(wallMs) || wallMs < 0) {
      this.#clockDegraded = true;
      throw new HardwareRunnerError('QUEUE_LEASE_FENCED', 'ClockSource returned out-of-range timestamp');
    }
    return { monoMs, wallMs };
  }

  #isLeaseClockValid(lease: MutableLease, sample: SampledClock): boolean {
    const created: SampledClock = { monoMs: lease.createdMonotonicMs, wallMs: lease.createdWallMs };
    const last: SampledClock = { monoMs: lease.lastMonotonicMs, wallMs: lease.lastWallMs };
    return clockStepValid(created, last, sample);
  }

  #areActiveLeaseClocksValid(sample: SampledClock): boolean {
    for (const jobId of this.#activeJobIds) {
      const job = this.#jobsById.get(jobId);
      const lease = job?.activeLease;
      if (!job || !lease || (job.state !== 'leased' && job.state !== 'running')) continue;
      if (!this.#isLeaseClockValid(lease, sample)) {
        return false;
      }
    }
    return true;
  }

  #sampleAndSweep(requireHealthyClock: boolean): SampledClock {
    let sample: SampledClock | null = null;
    try {
      sample = this.#rawSample();
    } catch (err) {
      this.#clockDegraded = true;
      if (requireHealthyClock) throw err;
    }
    if (sample !== null && !this.#clockDegraded) {
      if (!clockStepValid(this.#createdSample, this.#lastSample, sample) || !this.#areActiveLeaseClocksValid(sample)) {
        this.#clockDegraded = true;
      } else {
        this.#lastSample = sample;
      }
    }
    if (!this.#clockDegraded) {
      this.#sweepWithSample(this.#lastSample);
    }
    if (requireHealthyClock && this.#clockDegraded) {
      throw new HardwareRunnerError('QUEUE_LEASE_FENCED', 'Relay clock drifted beyond the 1000ms budget');
    }
    return this.#lastSample;
  }

  #buildPendingVerdict(job: InternalJob, wallMs: number): BenchmarkVerdict {
    const req = job.request;
    if (req === null) {
      throw new HardwareRunnerError('QUEUE_STATE_INVALID', 'recovered terminal job has no pending verdict');
    }
    return Object.freeze({
      version: 1,
      kind: 'benchmark_verdict',
      storeId: req.storeId,
      runId: req.runId,
      lockHash: req.lockHash,
      operationId: req.operationId,
      dispatchId: req.dispatchId,
      dispatchGeneration: req.dispatchGeneration,
      gateId: req.gateId,
      checkId: req.checkId,
      candidateDigest: req.candidateDigest,
      status: 'pending',
      reason: null,
      expiresAtMs: String(wallMs + this.#verdictTtlMs),
      preemptionCount: job.preemptionCount,
    });
  }

  #buildPreemptedExhaustedVerdict(job: InternalJob, wallMs: number): BenchmarkVerdict {
    const req = job.request!;
    return Object.freeze({
      version: 1,
      kind: 'benchmark_verdict',
      storeId: req.storeId,
      runId: req.runId,
      lockHash: req.lockHash,
      operationId: req.operationId,
      dispatchId: req.dispatchId,
      dispatchGeneration: req.dispatchGeneration,
      gateId: req.gateId,
      checkId: req.checkId,
      candidateDigest: req.candidateDigest,
      status: 'expired',
      reason: 'BENCHMARK_PREEMPTED',
      expiresAtMs: String(wallMs + this.#verdictTtlMs),
      preemptionCount: job.preemptionCount,
      retryablePreemption: true,
    });
  }

  #notifyCancelListeners(job: InternalJob, leaseEpoch: number, reason: 'cancel' | 'shutdown'): void {
    const listeners = job.cancelListenersByEpoch.get(leaseEpoch);
    if (!listeners) return;
    job.cancelListenersByEpoch.delete(leaseEpoch);
    for (const listener of [...listeners]) {
      listener(reason);
    }
  }

  #notifyVerdictWaiters(job: InternalJob, verdict: BenchmarkVerdict | null): void {
    const waiters = [...job.verdictWaiters];
    job.verdictWaiters.clear();
    for (const waiter of waiters) {
      waiter(verdict);
    }
  }

  #evictLeaseEpochOnce(job: InternalJob, lease: MutableLease, wallMs: number): PreemptResponse {
    const existing = job.evictedEpochs.get(lease.leaseEpoch);
    if (existing !== undefined) {
      return Object.freeze({
        status: existing.status,
        preemptionCount: job.preemptionCount,
      });
    }

    const req = job.request!;
    lease.cancelRequested = true;
    job.activeLease = null;
    if (job.completingEpoch === lease.leaseEpoch) {
      job.completingEpoch = null;
    }
    job.committedOutputsByEpoch.delete(lease.leaseEpoch);
    this.#notifyCancelListeners(job, lease.leaseEpoch, 'cancel');

    if (job.preemptionCount + 1 <= req.maxPreemptions) {
      job.preemptionCount += 1;
      job.evictedEpochs.set(lease.leaseEpoch, {
        leaseToken: lease.leaseToken,
        status: 'requeued',
      });
      job.state = 'queued';
      this.#queueOrder.push(job.jobId);
      return Object.freeze({
        status: 'requeued',
        preemptionCount: job.preemptionCount,
      });
    }

    job.state = 'preempted_exhausted';
    job.committedOutputsByEpoch.clear();
    job.evictedEpochs.clear();
    job.evictedEpochs.set(lease.leaseEpoch, {
      leaseToken: lease.leaseToken,
      status: 'preempted_exhausted',
    });
    const verdict = this.#buildPreemptedExhaustedVerdict(job, wallMs);
    job.terminalVerdict = verdict;
    this.#releaseActiveSlot(job);
    this.#onTerminalVerdict?.(verdict);
    this.#notifyVerdictWaiters(job, verdict);
    return Object.freeze({
      status: 'preempted_exhausted',
      preemptionCount: job.preemptionCount,
    });
  }

  #sweepWithSample(sample: SampledClock): number {
    if (!this.#areActiveLeaseClocksValid(sample)) {
      this.#clockDegraded = true;
      return 0;
    }
    let swept = 0;
    let requeuedAny = false;
    for (const jobId of [...this.#activeJobIds]) {
      const job = this.#jobsById.get(jobId);
      if (!job) continue;
      const lease = job.activeLease;
      if (lease === null) continue;
      if ((job.state === 'leased' || job.state === 'running') && sample.monoMs >= lease.notAfterMonotonicMs) {
        if (!this.#isLeaseClockValid(lease, sample)) {
          this.#clockDegraded = true;
          return swept;
        }
        const outcome = this.#evictLeaseEpochOnce(job, lease, sample.wallMs);
        swept += 1;
        if (outcome.status === 'requeued') {
          requeuedAny = true;
        }
      }
    }
    if (requeuedAny && !this.#clockDegraded && !this.#closed) {
      this.#dispatchToWaiters(sample);
    }
    return swept;
  }

  sweepExpired(): number {
    if (this.#closed || this.#clockDegraded) return 0;
    let sample: SampledClock;
    try {
      sample = this.#rawSample();
    } catch {
      this.#clockDegraded = true;
      return 0;
    }
    if (!clockStepValid(this.#createdSample, this.#lastSample, sample) || !this.#areActiveLeaseClocksValid(sample)) {
      this.#clockDegraded = true;
      return 0;
    }
    this.#lastSample = sample;
    return this.#sweepWithSample(sample);
  }

  #grantNextMatchingQueuedJob(workerId: string, capabilities: WorkerCapabilities, sample: SampledClock): LeaseGrant | null {
    for (let idx = 0; idx < this.#queueOrder.length; idx += 1) {
      const jobId = this.#queueOrder[idx]!;
      const job = this.#jobsById.get(jobId);
      if (!job || job.request === null || job.state !== 'queued' || job.activeLease !== null) {
        this.#queueOrder.splice(idx, 1);
        idx -= 1;
        continue;
      }
      if (!matchesWorkerCapabilities(job.request.targetHardware, job.request.heldOutWorkloadId, capabilities)) {
        continue;
      }
      this.#queueOrder.splice(idx, 1);
      job.currentLeaseEpoch += 1;
      const leaseToken = randomBytes(24).toString('hex');
      const lease: MutableLease = {
        relayBootId: this.relayBootId,
        jobId: job.jobId,
        workerId,
        leaseEpoch: job.currentLeaseEpoch,
        leaseToken,
        grantedMonotonicMs: sample.monoMs,
        notAfterMonotonicMs: sample.monoMs + this.#leaseTtlMs,
        createdWallMs: sample.wallMs,
        createdMonotonicMs: sample.monoMs,
        lastWallMs: sample.wallMs,
        lastMonotonicMs: sample.monoMs,
        cancelRequested: false,
      };
      job.activeLease = lease;
      job.completingEpoch = null;
      job.state = 'leased';
      job.committedOutputsByEpoch.set(lease.leaseEpoch, new Map());
      return Object.freeze({
        relayBootId: this.relayBootId,
        jobId: job.jobId,
        operationId: job.operationId,
        leaseEpoch: lease.leaseEpoch,
        leaseToken,
        leaseTtlMs: this.#leaseTtlMs,
        job: buildWorkerJobPayload(job.request, job.preemptionCount),
      });
    }
    return null;
  }

  #dispatchToWaiters(sample: SampledClock): void {
    if (this.#acquireWaiters.size === 0 || this.#clockDegraded || this.#closed) return;
    for (const waiter of [...this.#acquireWaiters]) {
      const grant = this.#grantNextMatchingQueuedJob(waiter.workerId, waiter.capabilities, sample);
      if (grant !== null) {
        this.#acquireWaiters.delete(waiter);
        waiter.cleanup();
        waiter.resolve(grant);
      }
    }
  }

  #resolveExistingOperation(
    existing: InternalJob,
    request: BenchmarkRequest,
    requestCanonical: string,
    wallMs: number,
  ): BenchmarkVerdict {
    if (existing.request !== null && existing.requestCanonical !== null) {
      if (
        existing.request.dispatchId !== request.dispatchId
        || existing.request.requestDigest !== request.requestDigest
        || existing.requestCanonical !== requestCanonical
      ) {
        throw new HardwareRunnerError(
          'QUEUE_JOB_CONFLICT',
          `conflicting benchmark_request for existing operationId "${request.operationId}"`,
        );
      }
    } else {
      // Never allow a receipt-only recovered record (missing an authenticated request descriptor)
      // to bind an unauthenticated POST as its canonical request!
      throw new HardwareRunnerError(
        'QUEUE_JOB_CONFLICT',
        `operation "${request.operationId}" has a terminal receipt without an authenticated request descriptor`,
      );
    }
    return existing.terminalVerdict ?? this.#buildPendingVerdict(existing, wallMs);
  }

  /** Looks up an existing in-memory operation after sweeping expired leases without creating new work. */
  lookupExistingOperation(
    request: BenchmarkRequest,
  ): { readonly found: true; readonly jobId: string; readonly verdict: BenchmarkVerdict } | { readonly found: false } {
    if (this.#closed) {
      throw new HardwareRunnerError('QUEUE_STATE_INVALID', 'Relay queue is closed');
    }
    const sample = this.#sampleAndSweep(false);
    const existing = this.#jobsByOperationId.get(request.operationId);
    if (existing === undefined) {
      return Object.freeze({ found: false });
    }
    const verdict = this.#resolveExistingOperation(existing, request, canonicalJson(request), sample.wallMs);
    return Object.freeze({ found: true, jobId: existing.jobId, verdict });
  }

  submitJob(request: BenchmarkRequest): { readonly jobId: string; readonly created: boolean; readonly verdict: BenchmarkVerdict } {
    if (this.#closed) {
      throw new HardwareRunnerError('QUEUE_STATE_INVALID', 'Relay queue is closed');
    }
    const sample = this.#sampleAndSweep(false);
    const requestCanonical = canonicalJson(request);
    const existing = this.#jobsByOperationId.get(request.operationId);
    if (existing !== undefined) {
      const verdict = this.#resolveExistingOperation(existing, request, requestCanonical, sample.wallMs);
      return Object.freeze({ jobId: existing.jobId, created: false, verdict });
    }

    if (this.#activeJobIds.size >= this.#maxJobs) {
      throw new HardwareRunnerError('QUEUE_CAPACITY_EXCEEDED', `Relay queue capacity (${this.#maxJobs}) exceeded`);
    }

    this.#jobSeq += 1;
    const jobId = `job_${String(this.#jobSeq).padStart(6, '0')}_${randomBytes(6).toString('hex')}`;
    const job: InternalJob = {
      jobId,
      operationId: request.operationId,
      request,
      requestCanonical,
      state: 'queued',
      preemptionCount: 0,
      currentLeaseEpoch: 0,
      activeLease: null,
      completingEpoch: null,
      terminalVerdict: null,
      evictedEpochs: new Map(),
      committedOutputsByEpoch: new Map(),
      cancelListenersByEpoch: new Map(),
      verdictWaiters: new Set(),
    };
    this.#jobsById.set(jobId, job);
    this.#jobsByOperationId.set(request.operationId, job);
    this.#activeJobIds.add(jobId);
    this.#queueOrder.push(jobId);

    if (!this.#clockDegraded) {
      this.#dispatchToWaiters(sample);
    }

    const verdict = job.terminalVerdict ?? this.#buildPendingVerdict(job, sample.wallMs);
    return Object.freeze({ jobId, created: true, verdict });
  }

  waitForVerdict(operationId: string, waitMs: number, signal?: AbortSignal): Promise<BenchmarkVerdict> {
    const sample = this.#sampleAndSweep(false);
    const job = this.#jobsByOperationId.get(operationId);
    if (!job) {
      throw new HardwareRunnerError('NOT_FOUND', `unknown operationId "${operationId}"`);
    }
    if (job.terminalVerdict !== null) {
      return Promise.resolve(job.terminalVerdict);
    }
    const clampedWait = Math.max(0, Math.min(MAX_ACQUIRE_WAIT_MS, Math.trunc(waitMs)));
    if (clampedWait === 0 || this.#closed || signal?.aborted) {
      return Promise.resolve(this.#buildPendingVerdict(job, sample.wallMs));
    }

    return new Promise<BenchmarkVerdict>(resolve => {
      let settled = false;
      const finish = (verdict: BenchmarkVerdict | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        job.verdictWaiters.delete(finish);
        if (verdict !== null) {
          resolve(verdict);
          return;
        }
        const now = this.#closed ? sample : this.#sampleAndSweep(false);
        resolve(job.terminalVerdict ?? this.#buildPendingVerdict(job, now.wallMs));
      };
      const onAbort = () => finish(null);
      const timer = setTimeout(() => finish(null), clampedWait);
      timer.unref();
      job.verdictWaiters.add(finish);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  tryAcquireLease(input: Omit<AcquireLeaseInput, 'waitMs'>): LeaseGrant | null {
    if (this.#closed) return null;
    if (typeof input.workerId !== 'string' || input.workerId.trim().length === 0 || input.workerId.length > 128) {
      throw new HardwareRunnerError('QUEUE_STATE_INVALID', 'workerId must be a non-empty string');
    }
    const sample = this.#sampleAndSweep(true);
    return this.#grantNextMatchingQueuedJob(input.workerId, input.capabilities, sample);
  }

  acquireLease(input: AcquireLeaseInput, signal?: AbortSignal): Promise<LeaseGrant | null> {
    const immediate = this.tryAcquireLease(input);
    if (immediate !== null || this.#closed) {
      return Promise.resolve(immediate);
    }
    const rawWait = input.waitMs ?? 0;
    if (typeof rawWait !== 'number' || !Number.isSafeInteger(rawWait) || Object.is(rawWait, -0) || rawWait < 0) {
      throw new HardwareRunnerError('QUEUE_STATE_INVALID', 'waitMs must be a non-negative integer');
    }
    const clampedWaitMs = Math.min(rawWait, MAX_ACQUIRE_WAIT_MS);
    if (clampedWaitMs === 0 || signal?.aborted) {
      return Promise.resolve(null);
    }

    return new Promise<LeaseGrant | null>(resolve => {
      let done = false;
      const cleanup = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.#acquireWaiters.delete(entry);
      };
      const onAbort = () => {
        cleanup();
        resolve(null);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, clampedWaitMs);
      timer.unref();
      const entry: AcquireWaiter = {
        workerId: input.workerId,
        capabilities: input.capabilities,
        resolve,
        cleanup,
      };
      this.#acquireWaiters.add(entry);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  #requireActiveLeaseInternal(
    jobId: string,
    creds: LeaseCredentials,
  ): { readonly job: InternalJob; readonly lease: MutableLease; readonly sample: SampledClock } {
    if (this.#closed) {
      throw new HardwareRunnerError('QUEUE_LEASE_FENCED', 'Relay queue is closed');
    }
    if (
      typeof creds.relayBootId !== 'string'
      || typeof creds.leaseToken !== 'string'
      || typeof creds.leaseEpoch !== 'number'
      || !Number.isSafeInteger(creds.leaseEpoch)
      || Object.is(creds.leaseEpoch, -0)
      || creds.leaseEpoch < 1
    ) {
      throw new HardwareRunnerError('QUEUE_LEASE_FENCED', 'invalid lease fencing credentials');
    }
    if (!timingSafeEqualStrings(creds.relayBootId, this.relayBootId)) {
      throw new HardwareRunnerError('QUEUE_LEASE_FENCED', 'stale relayBootId');
    }
    const sample = this.#sampleAndSweep(true);
    const job = this.#jobsById.get(jobId);
    if (
      !job
      || job.request === null
      || job.activeLease === null
      || (job.state !== 'leased' && job.state !== 'running')
    ) {
      throw new HardwareRunnerError('QUEUE_LEASE_FENCED', `no active lease on job "${jobId}"`);
    }
    const lease = job.activeLease;
    const tokenOk = timingSafeEqualStrings(creds.leaseToken, lease.leaseToken);
    if (lease.leaseEpoch !== creds.leaseEpoch || !tokenOk || lease.cancelRequested) {
      throw new HardwareRunnerError('QUEUE_LEASE_FENCED', `stale or mismatched lease on job "${jobId}"`);
    }
    const created: SampledClock = { monoMs: lease.createdMonotonicMs, wallMs: lease.createdWallMs };
    const last: SampledClock = { monoMs: lease.lastMonotonicMs, wallMs: lease.lastWallMs };
    if (!clockStepValid(created, last, sample)) {
      this.#clockDegraded = true;
      throw new HardwareRunnerError('QUEUE_LEASE_FENCED', 'lease clock drifted beyond the 1000ms budget');
    }
    return { job, lease, sample };
  }

  verifyActiveLease(
    jobId: string,
    creds: LeaseCredentials,
  ): { readonly jobId: string; readonly operationId: string; readonly leaseEpoch: number; readonly request: BenchmarkRequest } {
    const { job, lease } = this.#requireActiveLeaseInternal(jobId, creds);
    return Object.freeze({
      jobId: job.jobId,
      operationId: job.operationId,
      leaseEpoch: lease.leaseEpoch,
      request: job.request!,
    });
  }

  recordCommittedOutputBlob(jobId: string, creds: LeaseCredentials, blob: CommittedOutputBlob): void {
    const { job, lease } = this.#requireActiveLeaseInternal(jobId, creds);
    let epochMap = job.committedOutputsByEpoch.get(lease.leaseEpoch);
    if (!epochMap) {
      epochMap = new Map();
      job.committedOutputsByEpoch.set(lease.leaseEpoch, epochMap);
    }
    epochMap.set(blob.sha256, blob.byteLength);
  }

  heartbeatLease(jobId: string, input: HeartbeatLeaseInput): HeartbeatResponse {
    if (input.state !== undefined && input.state !== 'running') {
      throw new HardwareRunnerError('QUEUE_STATE_INVALID', 'unsupported heartbeat state');
    }
    const { job, lease, sample } = this.#requireActiveLeaseInternal(jobId, input);
    lease.notAfterMonotonicMs = sample.monoMs + this.#leaseTtlMs;
    lease.lastMonotonicMs = sample.monoMs;
    lease.lastWallMs = sample.wallMs;
    if (job.state === 'leased') {
      job.state = 'running';
    }
    return Object.freeze({
      desiredState: lease.cancelRequested ? 'cancel' : 'running',
      leaseTtlMs: this.#leaseTtlMs,
    });
  }

  subscribeLeaseCancel(
    jobId: string,
    creds: LeaseCredentials,
    listener: (reason: 'cancel' | 'shutdown') => void,
  ): () => void {
    const { job, lease } = this.#requireActiveLeaseInternal(jobId, creds);
    if (lease.cancelRequested) {
      listener('cancel');
      return () => {};
    }
    let set = job.cancelListenersByEpoch.get(lease.leaseEpoch);
    if (!set) {
      set = new Set();
      job.cancelListenersByEpoch.set(lease.leaseEpoch, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) {
        job.cancelListenersByEpoch.delete(lease.leaseEpoch);
      }
    };
  }

  preemptLease(jobId: string, input: PreemptLeaseInput): PreemptResponse {
    if (this.#closed) {
      throw new HardwareRunnerError('QUEUE_LEASE_FENCED', 'Relay queue is closed');
    }
    if (
      typeof input.relayBootId !== 'string'
      || typeof input.leaseToken !== 'string'
      || typeof input.leaseEpoch !== 'number'
      || !Number.isSafeInteger(input.leaseEpoch)
      || Object.is(input.leaseEpoch, -0)
      || input.leaseEpoch < 1
    ) {
      throw new HardwareRunnerError('QUEUE_LEASE_FENCED', 'invalid lease fencing credentials');
    }
    if (!timingSafeEqualStrings(input.relayBootId, this.relayBootId)) {
      throw new HardwareRunnerError('QUEUE_LEASE_FENCED', 'stale relayBootId');
    }
    const rawNow = this.#rawSample();
    const targetBeforeSweep = this.#jobsById.get(jobId);
    if (
      targetBeforeSweep?.activeLease !== null
      && targetBeforeSweep?.activeLease !== undefined
      && targetBeforeSweep.activeLease.leaseEpoch === input.leaseEpoch
      && timingSafeEqualStrings(input.leaseToken, targetBeforeSweep.activeLease.leaseToken)
      && !this.#isLeaseClockValid(targetBeforeSweep.activeLease, rawNow)
    ) {
      this.#clockDegraded = true;
      throw new HardwareRunnerError('QUEUE_LEASE_FENCED', 'lease clock drifted beyond the 1000ms budget');
    }
    const sample = this.#sampleAndSweep(true);
    const job = this.#jobsById.get(jobId);
    if (!job || job.request === null || job.state === 'completed' || job.state === 'cancelled') {
      throw new HardwareRunnerError('QUEUE_LEASE_FENCED', `cannot preempt job "${jobId}"`);
    }

    // Idempotent handling when the exact current epoch was already counted (e.g. duplicate SIGTERM retry or sweep race),
    // never double-incrementing preemptionCount while still fencing superseded epochs (input.leaseEpoch < currentLeaseEpoch).
    if (job.activeLease === null) {
      const prior = job.evictedEpochs.get(input.leaseEpoch);
      if (
        prior !== undefined
        && input.leaseEpoch === job.currentLeaseEpoch
        && timingSafeEqualStrings(input.leaseToken, prior.leaseToken)
      ) {
        return Object.freeze({
          status: prior.status,
          preemptionCount: job.preemptionCount,
        });
      }
      throw new HardwareRunnerError('QUEUE_LEASE_FENCED', `stale leaseEpoch ${input.leaseEpoch} on job "${jobId}"`);
    }

    const lease = job.activeLease;
    const tokenOk = timingSafeEqualStrings(input.leaseToken, lease.leaseToken);
    if (lease.leaseEpoch !== input.leaseEpoch || !tokenOk) {
      throw new HardwareRunnerError('QUEUE_LEASE_FENCED', `stale leaseEpoch ${input.leaseEpoch} on job "${jobId}"`);
    }
    if (!this.#isLeaseClockValid(lease, sample)) {
      this.#clockDegraded = true;
      throw new HardwareRunnerError('QUEUE_LEASE_FENCED', 'lease clock drifted beyond the 1000ms budget');
    }

    const response = this.#evictLeaseEpochOnce(job, lease, sample.wallMs);
    if (response.status === 'requeued' && !this.#clockDegraded) {
      this.#dispatchToWaiters(sample);
    }
    return response;
  }

  prepareCompleteLease(jobId: string, input: CompleteLeaseInput): PreparedLeaseCompletion {
    const { job, lease, sample } = this.#requireActiveLeaseInternal(jobId, input);
    if (job.completingEpoch !== null) {
      throw new HardwareRunnerError('QUEUE_LEASE_FENCED', `completion already in progress on job "${jobId}"`);
    }
    if (input.status !== 'approved' && input.status !== 'denied') {
      throw new HardwareRunnerError('QUEUE_STATE_INVALID', 'complete status must be "approved" or "denied"');
    }
    if (input.status === 'approved') {
      if (input.reason !== null) {
        throw new HardwareRunnerError('ARTIFACT_INVALID', 'approved verdict reason must be null');
      }
      if (input.hardwareProvenance === undefined) {
        throw new HardwareRunnerError('ARTIFACT_INVALID', 'approved verdict requires hardwareProvenance');
      }
    } else if (typeof input.reason !== 'string' || input.reason.trim().length === 0 || input.reason.length > 256) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'denied verdict requires a non-empty reason (<= 256 chars)');
    }
    if (
      input.hardwareProvenance !== undefined
      && input.hardwareProvenance.targetCellId !== job.request!.targetCellId
    ) {
      throw new HardwareRunnerError(
        'ARTIFACT_INVALID',
        `hardwareProvenance.targetCellId "${input.hardwareProvenance.targetCellId}" does not match job targetCellId "${job.request!.targetCellId}"`,
      );
    }

    const outputArtifacts = input.outputArtifacts !== undefined ? [...input.outputArtifacts] : undefined;
    if (outputArtifacts !== undefined) {
      if (outputArtifacts.length > VERIFIER_ARTIFACT_LIMITS.maxFilesPerSlot) {
        throw new HardwareRunnerError('ARTIFACT_INVALID', 'outputArtifacts exceeds maximum of 64 entries');
      }
      const committedMap = job.committedOutputsByEpoch.get(lease.leaseEpoch);
      const seenNames = new Set<string>();
      let totalOutputBytes = 0;
      for (const art of outputArtifacts) {
        const lower = art.name.toLowerCase();
        if (seenNames.has(lower)) {
          throw new HardwareRunnerError('ARTIFACT_INVALID', 'duplicate outputArtifact path');
        }
        seenNames.add(lower);
        if ((art.byteLength === 0) !== (art.digest.hex === EMPTY_SHA256_HEX)) {
          throw new HardwareRunnerError('ARTIFACT_INVALID', 'invalid empty outputArtifact digest binding');
        }
        if (art.byteLength > VERIFIER_ARTIFACT_LIMITS.maxTotalBytes - totalOutputBytes) {
          throw new HardwareRunnerError(
            'PAYLOAD_TOO_LARGE',
            `outputArtifacts total byteLength exceeds ${VERIFIER_ARTIFACT_LIMITS.maxTotalBytes} bytes`,
          );
        }
        totalOutputBytes += art.byteLength;
        const committedLen = committedMap?.get(art.digest.hex);
        if (committedLen === undefined || committedLen !== art.byteLength) {
          throw new HardwareRunnerError(
            'ARTIFACT_INVALID',
            `outputArtifact (${art.digest.hex}) was not committed under leaseEpoch ${lease.leaseEpoch}`,
          );
        }
      }
    }

    const req = job.request!;
    const verdict: BenchmarkVerdict = Object.freeze({
      version: 1,
      kind: 'benchmark_verdict',
      storeId: req.storeId,
      runId: req.runId,
      lockHash: req.lockHash,
      operationId: req.operationId,
      dispatchId: req.dispatchId,
      dispatchGeneration: req.dispatchGeneration,
      gateId: req.gateId,
      checkId: req.checkId,
      candidateDigest: req.candidateDigest,
      status: input.status,
      reason: input.reason,
      expiresAtMs: String(sample.wallMs + this.#verdictTtlMs),
      preemptionCount: job.preemptionCount,
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      ...(input.metrics !== undefined ? { metrics: input.metrics } : {}),
      ...(input.findings !== undefined ? { findings: input.findings } : {}),
      ...(input.hardwareProvenance !== undefined ? { hardwareProvenance: input.hardwareProvenance } : {}),
      ...(input.bucketMetrics !== undefined ? { bucketMetrics: input.bucketMetrics } : {}),
      ...(input.hardwareDiagnostics !== undefined ? { hardwareDiagnostics: input.hardwareDiagnostics } : {}),
      ...(outputArtifacts !== undefined ? { outputArtifacts: Object.freeze(outputArtifacts) } : {}),
    });

    if (Buffer.byteLength(canonicalJson(verdict), 'utf8') > MAX_BENCHMARK_VERDICT_BYTES) {
      throw new HardwareRunnerError(
        'PAYLOAD_TOO_LARGE',
        `assembled benchmark_verdict exceeds ${MAX_BENCHMARK_VERDICT_BYTES} bytes`,
      );
    }

    // Keep the active lease live and eligible for expiry sweeps, cancellation, and preemption
    // while asynchronous CAS rehashing and receipt temp-file staging proceed.
    job.completingEpoch = lease.leaseEpoch;

    let committed = false;
    let aborted = false;
    return {
      operationId: job.operationId,
      verdict,
      outputArtifacts: outputArtifacts ?? [],
      commit: (beforePublish?: () => void): BenchmarkVerdict => {
        if (committed) return verdict;
        if (aborted) {
          throw new HardwareRunnerError('QUEUE_LEASE_FENCED', 'prepared completion was aborted');
        }
        try {
          const { job: liveJob, lease: liveLease } = this.#requireActiveLeaseInternal(jobId, input);
          if (liveJob !== job || liveLease !== lease || job.completingEpoch !== lease.leaseEpoch) {
            throw new HardwareRunnerError('QUEUE_LEASE_FENCED', `lease fence invalidated during completion of "${jobId}"`);
          }
          beforePublish?.();
        } catch (err) {
          aborted = true;
          if (job.completingEpoch === lease.leaseEpoch) {
            job.completingEpoch = null;
          }
          throw err;
        }
        committed = true;
        job.completingEpoch = null;
        job.activeLease = null;
        job.state = 'completed';
        job.terminalVerdict = verdict;
        job.committedOutputsByEpoch.clear();
        job.evictedEpochs.clear();
        this.#releaseActiveSlot(job);
        this.#notifyCancelListeners(job, lease.leaseEpoch, 'shutdown');
        this.#onTerminalVerdict?.(verdict);
        this.#notifyVerdictWaiters(job, verdict);
        return verdict;
      },
      abort: (): void => {
        if (committed || aborted) return;
        aborted = true;
        if (job.completingEpoch === lease.leaseEpoch) {
          job.completingEpoch = null;
        }
      },
    };
  }

  completeLease(jobId: string, input: CompleteLeaseInput): BenchmarkVerdict {
    const prepared = this.prepareCompleteLease(jobId, input);
    return prepared.commit();
  }

  cancelJob(jobId: string): boolean {
    const sample = this.#sampleAndSweep(false);
    const job = this.#jobsById.get(jobId);
    if (
      !job
      || job.request === null
      || job.state === 'completed'
      || job.state === 'preempted_exhausted'
      || job.state === 'cancelled'
    ) {
      return false;
    }
    if (job.activeLease !== null) {
      const lease = job.activeLease;
      lease.cancelRequested = true;
      job.activeLease = null;
      job.committedOutputsByEpoch.delete(lease.leaseEpoch);
      this.#notifyCancelListeners(job, lease.leaseEpoch, 'cancel');
    }
    job.completingEpoch = null;
    job.committedOutputsByEpoch.clear();
    job.state = 'cancelled';
    const req = job.request;
    const verdict: BenchmarkVerdict = Object.freeze({
      version: 1,
      kind: 'benchmark_verdict',
      storeId: req.storeId,
      runId: req.runId,
      lockHash: req.lockHash,
      operationId: req.operationId,
      dispatchId: req.dispatchId,
      dispatchGeneration: req.dispatchGeneration,
      gateId: req.gateId,
      checkId: req.checkId,
      candidateDigest: req.candidateDigest,
      status: 'expired',
      reason: 'BENCHMARK_CANCELLED',
      expiresAtMs: String(sample.wallMs + this.#verdictTtlMs),
      preemptionCount: job.preemptionCount,
    });
    job.terminalVerdict = verdict;
    this.#releaseActiveSlot(job);
    this.#onTerminalVerdict?.(verdict);
    this.#notifyVerdictWaiters(job, verdict);
    return true;
  }

  #toSnapshot(job: InternalJob, wallMs: number): RelayJobSnapshot {
    const req = job.request;
    const verdict = job.terminalVerdict ?? this.#buildPendingVerdict(job, wallMs);
    const synthesizedRequest: BenchmarkRequest = req ?? Object.freeze({
      version: 1,
      kind: 'benchmark_request',
      storeId: verdict.storeId,
      runId: verdict.runId,
      lockHash: verdict.lockHash,
      operationId: verdict.operationId,
      dispatchId: verdict.dispatchId,
      dispatchGeneration: verdict.dispatchGeneration,
      requestDigest: '0'.repeat(64),
      gateId: verdict.gateId,
      checkId: verdict.checkId,
      candidateDigest: verdict.candidateDigest,
      subject: Object.freeze({
        lockHash: verdict.lockHash,
        contractHash: verdict.lockHash,
        repository: 'recovered/unknown',
        baseRevision: '0'.repeat(40),
        sourceRevision: '0'.repeat(40),
        candidateDigest: Object.freeze({ algorithm: 'sha256', hex: verdict.candidateDigest }),
        targetMatrixDigest: null,
      }),
      targetCellId: verdict.hardwareProvenance?.targetCellId ?? 'recovered',
      targetHardware: Object.freeze({
        accelerator: verdict.hardwareProvenance?.accelerator ?? 'recovered',
        isolationMode: verdict.hardwareProvenance?.isolationMode ?? 'whole_device',
      }),
      heldOutWorkloadId: 'recovered',
      metricThresholds: Object.freeze([]),
      maxPreemptions: verdict.preemptionCount,
      candidateArtifacts: Object.freeze({ entries: Object.freeze([]), deleted: Object.freeze([]) }),
    });
    return Object.freeze({
      jobId: job.jobId,
      operationId: job.operationId,
      dispatchId: synthesizedRequest.dispatchId,
      requestDigest: synthesizedRequest.requestDigest,
      state: job.state,
      preemptionCount: job.preemptionCount,
      maxPreemptions: synthesizedRequest.maxPreemptions,
      currentLeaseEpoch: job.currentLeaseEpoch,
      activeLease: job.activeLease !== null ? toPublicLeaseState(job.activeLease) : null,
      request: synthesizedRequest,
      verdict,
    });
  }

  getJob(jobId: string): RelayJobSnapshot | null {
    const sample = this.#closed ? this.#lastSample : this.#sampleAndSweep(false);
    const job = this.#jobsById.get(jobId);
    return job ? this.#toSnapshot(job, sample.wallMs) : null;
  }

  getJobByOperationId(operationId: string): RelayJobSnapshot | null {
    const sample = this.#closed ? this.#lastSample : this.#sampleAndSweep(false);
    const job = this.#jobsByOperationId.get(operationId);
    return job ? this.#toSnapshot(job, sample.wallMs) : null;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#sweepTimer !== null) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = null;
    }
    for (const waiter of [...this.#acquireWaiters]) {
      waiter.cleanup();
      waiter.resolve(null);
    }
    this.#acquireWaiters.clear();
    for (const job of this.#jobsById.values()) {
      for (const epoch of [...job.cancelListenersByEpoch.keys()]) {
        this.#notifyCancelListeners(job, epoch, 'shutdown');
      }
      this.#notifyVerdictWaiters(job, job.terminalVerdict);
    }
  }
}
