import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { HardwareProvenance } from '@loopwright/core';
import {
  DEFAULT_CLOCK_SOURCE,
  MAX_BENCHMARK_VERDICT_BYTES,
  RelayPullQueue,
} from '../src/queue.js';
import {
  HardwareRunnerError,
  type BenchmarkRequest,
  type BenchmarkVerdict,
  type ClockSource,
  type WorkerCapabilities,
} from '../src/types.js';

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

class FakeClock implements ClockSource {
  monoMs: number;
  wallMs: number;

  constructor(monoMs = 1_000, wallMs = 1_700_000_000_000) {
    this.monoMs = monoMs;
    this.wallMs = wallMs;
  }

  nowMonotonicMs(): number {
    return this.monoMs;
  }

  nowWallMs(): number {
    return this.wallMs;
  }

  advance(deltaMonoMs: number, deltaWallMs: number = deltaMonoMs): void {
    this.monoMs += deltaMonoMs;
    this.wallMs += deltaWallMs;
  }
}

function makeBenchmarkRequest(overrides: Partial<BenchmarkRequest> = {}): BenchmarkRequest {
  const lockHex = sha256Hex('lock-1');
  const contractHex = sha256Hex('contract-1');
  const candHex = overrides.candidateDigest ?? sha256Hex('candidate-1');
  const matrixHex = sha256Hex('matrix-1');
  const operationId = overrides.operationId ?? 'verify.0.check.bench';
  const reqHex = overrides.requestDigest ?? sha256Hex(`req:${operationId}`);
  return {
    version: 1,
    kind: 'benchmark_request',
    storeId: 'store-01',
    runId: 'run-01',
    lockHash: { algorithm: 'sha256', hex: lockHex },
    operationId,
    dispatchId: 'dispatch-01',
    dispatchGeneration: 1,
    requestDigest: reqHex,
    gateId: 'gpu-bench',
    checkId: 'kernel-speedup',
    candidateDigest: candHex,
    subject: {
      lockHash: { algorithm: 'sha256', hex: lockHex },
      contractHash: { algorithm: 'sha256', hex: contractHex },
      repository: 'org/repo',
      baseRevision: 'a'.repeat(40),
      sourceRevision: 'b'.repeat(40),
      candidateDigest: { algorithm: 'sha256', hex: candHex },
      targetMatrixDigest: { algorithm: 'sha256', hex: matrixHex },
    },
    targetCellId: 'cuda-h100',
    targetHardware: {
      accelerator: 'sm_90a',
      isolationMode: 'whole_device',
      deviceCount: 2,
      driverConstraint: '>=550.54.14',
      topology: 'nvlink',
    },
    heldOutWorkloadId: 'gemm-heldout-v1',
    metricThresholds: [{ kind: 'bounds', metric: 'latency_ms', max: 1.5 }],
    maxPreemptions: 3,
    candidateArtifacts: {
      entries: [],
      deleted: [],
    },
    ...overrides,
  };
}

function makeWorkerCapabilities(overrides: Partial<WorkerCapabilities> = {}): WorkerCapabilities {
  return {
    accelerator: 'sm_90a',
    isolationModes: ['whole_device', 'sliced'],
    deviceCount: 4,
    driverVersion: '550.90.07',
    topology: 'nvlink',
    workloadIds: ['gemm-heldout-v1', 'attn-v2'],
    ...overrides,
  };
}

function makeProvenance(): HardwareProvenance {
  return {
    targetCellId: 'cuda-h100',
    probeKind: 'physical',
    vendor: 'NVIDIA',
    deviceModel: 'NVIDIA H100 80GB HBM3',
    accelerator: 'sm_90a',
    isolationMode: 'whole_device',
    deviceCount: 2,
    driverVersion: '550.90.07',
    runtimeVersion: '12.6',
    topology: 'nvlink',
    workloadDigest: { algorithm: 'sha256', hex: sha256Hex('workload-bytes') },
    clockLockMode: 'locked',
  };
}

function assertFenced(fn: () => unknown): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof HardwareRunnerError);
    assert.equal(err.code, 'QUEUE_LEASE_FENCED');
    return true;
  });
}

test('queue enforces (relayBootId, jobId, leaseEpoch, leaseToken) fencing across all lease operations', () => {
  const clock = new FakeClock();
  const queueA = new RelayPullQueue({ clock, leaseTtlMs: 5_000, startSweepTimer: false });
  const queueB = new RelayPullQueue({ clock, leaseTtlMs: 5_000, startSweepTimer: false });
  assert.notEqual(queueA.relayBootId, queueB.relayBootId);

  try {
    queueA.submitJob(makeBenchmarkRequest());
    const grant1 = queueA.tryAcquireLease({
      workerId: 'worker-1',
      capabilities: makeWorkerCapabilities(),
    });
    assert.ok(grant1 !== null);
    assert.equal(grant1.leaseEpoch, 1);
    assert.equal(grant1.relayBootId, queueA.relayBootId);

    // Wrong relayBootId, wrong jobId, wrong epoch, wrong token are all fenced
    assertFenced(() =>
      queueA.heartbeatLease(grant1.jobId, {
        relayBootId: queueB.relayBootId,
        leaseEpoch: grant1.leaseEpoch,
        leaseToken: grant1.leaseToken,
      }),
    );
    assertFenced(() =>
      queueA.heartbeatLease('job_unknown', {
        relayBootId: queueA.relayBootId,
        leaseEpoch: grant1.leaseEpoch,
        leaseToken: grant1.leaseToken,
      }),
    );
    assertFenced(() =>
      queueA.heartbeatLease(grant1.jobId, {
        relayBootId: queueA.relayBootId,
        leaseEpoch: 2,
        leaseToken: grant1.leaseToken,
      }),
    );
    assertFenced(() =>
      queueA.heartbeatLease(grant1.jobId, {
        relayBootId: queueA.relayBootId,
        leaseEpoch: grant1.leaseEpoch,
        leaseToken: '0'.repeat(48),
      }),
    );

    // Valid heartbeat transitions leased -> running
    const hb = queueA.heartbeatLease(grant1.jobId, {
      relayBootId: grant1.relayBootId,
      leaseEpoch: grant1.leaseEpoch,
      leaseToken: grant1.leaseToken,
    });
    assert.equal(hb.desiredState, 'running');
    assert.equal(queueA.getJob(grant1.jobId)?.state, 'running');

    // Preempt epoch 1 and grant epoch 2; stale epoch 1 credentials must be fenced everywhere
    const preempted = queueA.preemptLease(grant1.jobId, {
      relayBootId: grant1.relayBootId,
      leaseEpoch: grant1.leaseEpoch,
      leaseToken: grant1.leaseToken,
      reason: 'SIGTERM',
    });
    assert.equal(preempted.status, 'requeued');
    assert.equal(preempted.preemptionCount, 1);

    const grant2 = queueA.tryAcquireLease({
      workerId: 'worker-2',
      capabilities: makeWorkerCapabilities(),
    });
    assert.ok(grant2 !== null);
    assert.equal(grant2.leaseEpoch, 2);

    const staleCreds = {
      relayBootId: grant1.relayBootId,
      leaseEpoch: grant1.leaseEpoch,
      leaseToken: grant1.leaseToken,
    };
    assertFenced(() => queueA.verifyActiveLease(grant1.jobId, staleCreds));
    assertFenced(() => queueA.heartbeatLease(grant1.jobId, staleCreds));
    assertFenced(() =>
      queueA.recordCommittedOutputBlob(grant1.jobId, staleCreds, {
        sha256: sha256Hex('cubin'),
        byteLength: 5,
      }),
    );
    assertFenced(() => queueA.preemptLease(grant1.jobId, staleCreds));
    assertFenced(() =>
      queueA.completeLease(grant1.jobId, {
        ...staleCreds,
        status: 'approved',
        reason: null,
        hardwareProvenance: makeProvenance(),
      }),
    );
  } finally {
    queueA.close();
    queueB.close();
  }
});

test('clock drift guard passes at exactly 1,000ms drift and fails closed at 1,001ms drift', () => {
  // 1,000ms positive drift passes
  const clockPass = new FakeClock(1_000, 1_700_000_000_000);
  const queuePass = new RelayPullQueue({ clock: clockPass, leaseTtlMs: 10_000, startSweepTimer: false });
  try {
    queuePass.submitJob(makeBenchmarkRequest());
    const grant = queuePass.tryAcquireLease({
      workerId: 'w-1',
      capabilities: makeWorkerCapabilities(),
    });
    assert.ok(grant !== null);

    // Advance mono by 2,000ms and wall by 3,000ms -> delta difference = +1,000ms (exact boundary pass)
    clockPass.advance(2_000, 3_000);
    const hb1 = queuePass.heartbeatLease(grant.jobId, {
      relayBootId: grant.relayBootId,
      leaseEpoch: grant.leaseEpoch,
      leaseToken: grant.leaseToken,
    });
    assert.equal(hb1.desiredState, 'running');
    assert.equal(queuePass.isClockDegraded(), false);

    // Advance mono by 2,000ms and wall by 1,000ms -> adjacent diff = -1,000ms, cumulative diff = 0ms (pass)
    clockPass.advance(2_000, 1_000);
    const hb2 = queuePass.heartbeatLease(grant.jobId, {
      relayBootId: grant.relayBootId,
      leaseEpoch: grant.leaseEpoch,
      leaseToken: grant.leaseToken,
    });
    assert.equal(hb2.desiredState, 'running');
    assert.equal(queuePass.isClockDegraded(), false);
  } finally {
    queuePass.close();
  }

  // 1,001ms drift fails closed on heartbeat and subsequent lease grants
  const clockFail = new FakeClock(1_000, 1_700_000_000_000);
  const queueFail = new RelayPullQueue({ clock: clockFail, leaseTtlMs: 10_000, startSweepTimer: false });
  try {
    queueFail.submitJob(makeBenchmarkRequest({ operationId: 'op-1' }));
    queueFail.submitJob(makeBenchmarkRequest({ operationId: 'op-2' }));
    const grant = queueFail.tryAcquireLease({
      workerId: 'w-1',
      capabilities: makeWorkerCapabilities(),
    });
    assert.ok(grant !== null);

    // Advance mono by 2,000ms and wall by 3,001ms -> |deltaWall - deltaMono| = 1,001ms -> FAILS!
    clockFail.advance(2_000, 3_001);
    assertFenced(() =>
      queueFail.heartbeatLease(grant.jobId, {
        relayBootId: grant.relayBootId,
        leaseEpoch: grant.leaseEpoch,
        leaseToken: grant.leaseToken,
      }),
    );
    assert.equal(queueFail.isClockDegraded(), true);
    assertFenced(() =>
      queueFail.tryAcquireLease({
        workerId: 'w-2',
        capabilities: makeWorkerCapabilities(),
      }),
    );
  } finally {
    queueFail.close();
  }
});

test('single-owner preemptionCount enforces maxPreemptions=0, maxPreemptions=3 (leaseEpoch 1..4), and never double-counts an epoch', () => {
  const clock = new FakeClock();
  const terminalVerdicts: BenchmarkVerdict[] = [];
  const queue = new RelayPullQueue({
    clock,
    leaseTtlMs: 5_000,
    startSweepTimer: false,
    onTerminalVerdict: v => terminalVerdicts.push(v),
  });

  try {
    // Case 1: maxPreemptions = 0 -> immediate preempted_exhausted on first eviction
    queue.submitJob(makeBenchmarkRequest({ operationId: 'op-zero-budget', maxPreemptions: 0 }));
    const zGrant = queue.tryAcquireLease({ workerId: 'w-0', capabilities: makeWorkerCapabilities() });
    assert.ok(zGrant !== null);
    assert.equal(zGrant.leaseEpoch, 1);

    const zPreempt = queue.preemptLease(zGrant.jobId, {
      relayBootId: zGrant.relayBootId,
      leaseEpoch: zGrant.leaseEpoch,
      leaseToken: zGrant.leaseToken,
    });
    assert.equal(zPreempt.status, 'preempted_exhausted');
    assert.equal(zPreempt.preemptionCount, 0);
    const zSnap = queue.getJob(zGrant.jobId)!;
    assert.equal(zSnap.state, 'preempted_exhausted');
    assert.equal(zSnap.verdict.status, 'expired');
    assert.equal(zSnap.verdict.reason, 'BENCHMARK_PREEMPTED');
    assert.equal(zSnap.verdict.retryablePreemption, true);
    assert.equal(zSnap.verdict.preemptionCount, 0);

    // Duplicate preempt call on the same already-settled epoch does not increment preemptionCount
    const zPreemptDup = queue.preemptLease(zGrant.jobId, {
      relayBootId: zGrant.relayBootId,
      leaseEpoch: zGrant.leaseEpoch,
      leaseToken: zGrant.leaseToken,
    });
    assert.equal(zPreemptDup.status, 'preempted_exhausted');
    assert.equal(zPreemptDup.preemptionCount, 0);

    // Case 2: maxPreemptions = 3 -> 3 requeues reach leaseEpoch = 4, double-preempt same epoch doesn't double-count, 4th exhausts
    queue.submitJob(makeBenchmarkRequest({ operationId: 'op-three-budget', maxPreemptions: 3 }));

    // Epoch 1: preempt twice -> preemptionCount stays 1
    const g1 = queue.tryAcquireLease({ workerId: 'w-1', capabilities: makeWorkerCapabilities() })!;
    assert.equal(g1.leaseEpoch, 1);
    const p1a = queue.preemptLease(g1.jobId, {
      relayBootId: g1.relayBootId,
      leaseEpoch: g1.leaseEpoch,
      leaseToken: g1.leaseToken,
    });
    const p1b = queue.preemptLease(g1.jobId, {
      relayBootId: g1.relayBootId,
      leaseEpoch: g1.leaseEpoch,
      leaseToken: g1.leaseToken,
    });
    assert.deepEqual(p1a, { status: 'requeued', preemptionCount: 1 });
    assert.deepEqual(p1b, { status: 'requeued', preemptionCount: 1 });

    // Epoch 2: expire via sweep, then worker also sends preempt -> preemptionCount stays 2
    const g2 = queue.tryAcquireLease({ workerId: 'w-2', capabilities: makeWorkerCapabilities() })!;
    assert.equal(g2.leaseEpoch, 2);
    clock.advance(5_000, 5_000);
    assert.equal(queue.sweepExpired(), 1);
    const p2AfterSweep = queue.preemptLease(g2.jobId, {
      relayBootId: g2.relayBootId,
      leaseEpoch: g2.leaseEpoch,
      leaseToken: g2.leaseToken,
    });
    assert.deepEqual(p2AfterSweep, { status: 'requeued', preemptionCount: 2 });

    // Epoch 3: preempt -> requeued with preemptionCount = 3
    const g3 = queue.tryAcquireLease({ workerId: 'w-3', capabilities: makeWorkerCapabilities() })!;
    assert.equal(g3.leaseEpoch, 3);
    const p3 = queue.preemptLease(g3.jobId, {
      relayBootId: g3.relayBootId,
      leaseEpoch: g3.leaseEpoch,
      leaseToken: g3.leaseToken,
    });
    assert.deepEqual(p3, { status: 'requeued', preemptionCount: 3 });

    // Epoch 4: 4th eviction exceeds maxPreemptions=3 -> settles preempted_exhausted BENCHMARK_PREEMPTED
    const g4 = queue.tryAcquireLease({ workerId: 'w-4', capabilities: makeWorkerCapabilities() })!;
    assert.equal(g4.leaseEpoch, 4);
    assert.equal(g4.job.preemptionCount, 3);
    const p4 = queue.preemptLease(g4.jobId, {
      relayBootId: g4.relayBootId,
      leaseEpoch: g4.leaseEpoch,
      leaseToken: g4.leaseToken,
    });
    assert.deepEqual(p4, { status: 'preempted_exhausted', preemptionCount: 3 });
    const finalSnap = queue.getJob(g4.jobId)!;
    assert.equal(finalSnap.state, 'preempted_exhausted');
    assert.equal(finalSnap.verdict.status, 'expired');
    assert.equal(finalSnap.verdict.reason, 'BENCHMARK_PREEMPTED');
    assert.equal(finalSnap.verdict.retryablePreemption, true);
    assert.equal(finalSnap.verdict.preemptionCount, 3);
    assert.equal(terminalVerdicts.length, 2);
  } finally {
    queue.close();
  }
});

test('periodic timer sweep fences expired leases without waiting for new worker acquisitions', async () => {
  const queue = new RelayPullQueue({
    leaseTtlMs: 40,
    sweepIntervalMs: 15,
    startSweepTimer: true,
  });

  try {
    const sub = queue.submitJob(makeBenchmarkRequest({ operationId: 'op-timer-sweep', maxPreemptions: 0 }));
    const grant = queue.tryAcquireLease({
      workerId: 'w-dead',
      capabilities: makeWorkerCapabilities(),
    });
    assert.ok(grant !== null);

    let cancelNotified = false;
    queue.subscribeLeaseCancel(grant.jobId, grant, reason => {
      if (reason === 'cancel') cancelNotified = true;
    });

    const settled = await queue.waitForVerdict('op-timer-sweep', 2_000);
    assert.equal(settled.status, 'expired');
    assert.equal(settled.reason, 'BENCHMARK_PREEMPTED');
    assert.equal(settled.retryablePreemption, true);
    assert.equal(cancelNotified, true);
    assert.equal(queue.getJob(sub.jobId)?.state, 'preempted_exhausted');
  } finally {
    queue.close();
  }
});

test('capability and driverConstraint matching plus long-poll wakeup and AbortSignal cancellation', async () => {
  const clock = new FakeClock();
  const queue = new RelayPullQueue({ clock, leaseTtlMs: 5_000, startSweepTimer: false });

  try {
    queue.submitJob(makeBenchmarkRequest({ operationId: 'op-gpu-match' }));

    // Mismatched accelerator, isolationMode, deviceCount, topology, driverVersion, and workloadId all return null
    assert.equal(
      queue.tryAcquireLease({
        workerId: 'w-wrong-arch',
        capabilities: makeWorkerCapabilities({ accelerator: 'sm_89' }),
      }),
      null,
    );
    assert.equal(
      queue.tryAcquireLease({
        workerId: 'w-wrong-iso',
        capabilities: makeWorkerCapabilities({ isolationModes: ['sliced'] }),
      }),
      null,
    );
    assert.equal(
      queue.tryAcquireLease({
        workerId: 'w-few-gpus',
        capabilities: makeWorkerCapabilities({ deviceCount: 1 }),
      }),
      null,
    );
    assert.equal(
      queue.tryAcquireLease({
        workerId: 'w-wrong-topo',
        capabilities: makeWorkerCapabilities({ topology: 'pcie' }),
      }),
      null,
    );
    assert.equal(
      queue.tryAcquireLease({
        workerId: 'w-old-driver',
        capabilities: makeWorkerCapabilities({ driverVersion: '535.104.05' }),
      }),
      null,
    );
    assert.equal(
      queue.tryAcquireLease({
        workerId: 'w-missing-workload',
        capabilities: makeWorkerCapabilities({ workloadIds: ['other-workload'] }),
      }),
      null,
    );

    // Matching worker acquires op-gpu-match
    const firstGrant = queue.tryAcquireLease({
      workerId: 'w-good',
      capabilities: makeWorkerCapabilities({ deviceCount: 2, driverVersion: '550.54.14' }),
    });
    assert.ok(firstGrant !== null);
    assert.equal(firstGrant.operationId, 'op-gpu-match');

    // Long-poll AbortSignal cancellation resolves null cleanly
    const abortCtrl = new AbortController();
    const cancelledWait = queue.acquireLease(
      { workerId: 'w-abort', capabilities: makeWorkerCapabilities(), waitMs: 5_000 },
      abortCtrl.signal,
    );
    abortCtrl.abort();
    assert.equal(await cancelledWait, null);

    // Long-poll waiter wakes immediately when matching job is submitted
    const waiterPromise = queue.acquireLease({
      workerId: 'w-waiter',
      capabilities: makeWorkerCapabilities({ accelerator: 'gfx1101', topology: 'xgmi', driverVersion: '6.2.0' }),
      waitMs: 5_000,
    });
    queue.submitJob(
      makeBenchmarkRequest({
        operationId: 'op-rocm',
        targetHardware: {
          accelerator: 'gfx1101',
          isolationMode: 'whole_device',
          deviceCount: 1,
          driverConstraint: '>=6.1.0',
          topology: 'xgmi',
        },
      }),
    );
    const wokenGrant = await waiterPromise;
    assert.ok(wokenGrant !== null);
    assert.equal(wokenGrant.operationId, 'op-rocm');
  } finally {
    queue.close();
  }
});

test('completeLease artifact bindings, denied verdicts, cancelJob, getJobByOperationId, and maxJobs cap', async () => {
  const clock = new FakeClock();
  const queue = new RelayPullQueue({
    clock,
    leaseTtlMs: 5_000,
    maxJobs: 3,
    startSweepTimer: false,
  });

  try {
    // 1. Complete lease with committed outputArtifact vs uncommitted artifact rejection
    queue.submitJob(makeBenchmarkRequest({ operationId: 'op-complete-ok' }));
    assert.equal(queue.getJobByOperationId('op-complete-ok')?.state, 'queued');
    const g1 = queue.tryAcquireLease({ workerId: 'w-1', capabilities: makeWorkerCapabilities() })!;
    const cubinHex = sha256Hex('compiled-cubin');

    // Uncommitted output artifact rejected with ARTIFACT_INVALID while keeping lease intact
    assert.throws(
      () =>
        queue.completeLease(g1.jobId, {
          relayBootId: g1.relayBootId,
          leaseEpoch: g1.leaseEpoch,
          leaseToken: g1.leaseToken,
          status: 'approved',
          reason: null,
          hardwareProvenance: makeProvenance(),
          outputArtifacts: [
            { name: 'kernel.cubin', digest: { algorithm: 'sha256', hex: cubinHex }, byteLength: 14 },
          ],
        }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'ARTIFACT_INVALID',
    );

    // Commit output artifact under active epoch and test prepareCompleteLease abort + final commit
    queue.recordCommittedOutputBlob(g1.jobId, g1, { sha256: cubinHex, byteLength: 14 });
    const prepared = queue.prepareCompleteLease(g1.jobId, {
      relayBootId: g1.relayBootId,
      leaseEpoch: g1.leaseEpoch,
      leaseToken: g1.leaseToken,
      status: 'approved',
      reason: null,
      detail: 'all bounds met',
      metrics: { latency_ms: 0.9 },
      findings: [],
      hardwareProvenance: makeProvenance(),
      outputArtifacts: [
        { name: 'kernel.cubin', digest: { algorithm: 'sha256', hex: cubinHex }, byteLength: 14 },
      ],
    });
    prepared.abort();
    assert.equal(queue.getJob(g1.jobId)?.state, 'leased');

    const verdict = queue.completeLease(g1.jobId, {
      relayBootId: g1.relayBootId,
      leaseEpoch: g1.leaseEpoch,
      leaseToken: g1.leaseToken,
      status: 'approved',
      reason: null,
      hardwareProvenance: makeProvenance(),
      outputArtifacts: [
        { name: 'kernel.cubin', digest: { algorithm: 'sha256', hex: cubinHex }, byteLength: 14 },
      ],
    });
    assert.equal(verdict.status, 'approved');
    assert.equal(queue.getJobByOperationId('op-complete-ok')?.state, 'completed');

    // 2. Denied verdict path
    queue.submitJob(makeBenchmarkRequest({ operationId: 'op-denied' }));
    const g2 = queue.tryAcquireLease({ workerId: 'w-2', capabilities: makeWorkerCapabilities() })!;
    const denied = queue.completeLease(g2.jobId, {
      relayBootId: g2.relayBootId,
      leaseEpoch: g2.leaseEpoch,
      leaseToken: g2.leaseToken,
      status: 'denied',
      reason: 'metric_threshold_failed',
      metrics: { latency_ms: 2.4 },
    });
    assert.equal(denied.status, 'denied');
    assert.equal(denied.reason, 'metric_threshold_failed');

    // 3. cancelJob fences active lease, notifies cancel listeners, and settles expired BENCHMARK_CANCELLED
    const subCancel = queue.submitJob(makeBenchmarkRequest({ operationId: 'op-cancel' }));
    const g3 = queue.tryAcquireLease({ workerId: 'w-3', capabilities: makeWorkerCapabilities() })!;
    let cancelReason: string | null = null;
    const unsub = queue.subscribeLeaseCancel(g3.jobId, g3, r => {
      cancelReason = r;
    });
    const waitCancel = queue.waitForVerdict('op-cancel', 5_000);
    assert.equal(queue.cancelJob(subCancel.jobId), true);
    assert.equal(queue.cancelJob(subCancel.jobId), false);
    unsub();
    assert.equal(cancelReason, 'cancel');
    const cancelledVerdict = await waitCancel;
    assert.equal(cancelledVerdict.status, 'expired');
    assert.equal(cancelledVerdict.reason, 'BENCHMARK_CANCELLED');

    // 4. Active jobs count toward maxJobs=3 while terminal jobs release capacity!
    // Currently all 3 earlier jobs ('op-complete-ok', 'op-denied', 'op-cancel') are terminal, so activeJobCount === 0.
    assert.equal(queue.activeJobCount, 0);
    queue.submitJob(makeBenchmarkRequest({ operationId: 'op-active-1' }));
    queue.submitJob(makeBenchmarkRequest({ operationId: 'op-active-2' }));
    queue.submitJob(makeBenchmarkRequest({ operationId: 'op-active-3' }));
    assert.equal(queue.activeJobCount, 3);
    assert.throws(
      () => queue.submitJob(makeBenchmarkRequest({ operationId: 'op-overflow' })),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'QUEUE_CAPACITY_EXCEEDED',
    );

    // 5. Boundary validation on constructor, DEFAULT_CLOCK_SOURCE, waitForVerdict unknown op, and completeLease reason rules
    assert.equal(typeof DEFAULT_CLOCK_SOURCE.nowMonotonicMs(), 'number');
    assert.equal(typeof DEFAULT_CLOCK_SOURCE.nowWallMs(), 'number');
    assert.equal(queue.leaseTtlMs, 5_000);
    assert.throws(() => new RelayPullQueue({ leaseTtlMs: 0 }));
    assert.throws(() => new RelayPullQueue({ sweepIntervalMs: 0 }));
    assert.throws(() => new RelayPullQueue({ verdictTtlMs: 100 }));
    assert.throws(() => new RelayPullQueue({ maxJobs: 0 }));
    assert.throws(() => queue.waitForVerdict('op-does-not-exist', 100));
  } finally {
    queue.close();
  }
});

test('prepareCompleteLease keeps lease fence live and fences expiry, cancellation, and shutdown at commit boundary', () => {
  // 1. Lease expiry during preparation (both sweep-driven and commit-sampled)
  const clockExp = new FakeClock();
  const publishedVerdicts: BenchmarkVerdict[] = [];
  const queueExp = new RelayPullQueue({
    clock: clockExp,
    leaseTtlMs: 1_000,
    startSweepTimer: false,
    onTerminalVerdict: v => publishedVerdicts.push(v),
  });
  try {
    queueExp.submitJob(makeBenchmarkRequest({ operationId: 'op-prep-expire', maxPreemptions: 1 }));
    const grant = queueExp.tryAcquireLease({ workerId: 'w-1', capabilities: makeWorkerCapabilities() })!;
    const outSha = sha256Hex('stage-a-cubin');
    queueExp.recordCommittedOutputBlob(grant.jobId, grant, { sha256: outSha, byteLength: 13 });

    const prepared = queueExp.prepareCompleteLease(grant.jobId, {
      relayBootId: grant.relayBootId,
      leaseEpoch: grant.leaseEpoch,
      leaseToken: grant.leaseToken,
      status: 'approved',
      reason: null,
      hardwareProvenance: makeProvenance(),
      outputArtifacts: [{ name: 'out.cubin', digest: { algorithm: 'sha256', hex: outSha }, byteLength: 13 }],
    });

    // Active lease remains live during preparation and concurrent prepareCompleteLease is fenced
    assert.notEqual(queueExp.getJob(grant.jobId)?.activeLease, null);
    assertFenced(() =>
      queueExp.prepareCompleteLease(grant.jobId, {
        relayBootId: grant.relayBootId,
        leaseEpoch: grant.leaseEpoch,
        leaseToken: grant.leaseToken,
        status: 'approved',
        reason: null,
        hardwareProvenance: makeProvenance(),
      }),
    );

    // Expiry sweep is NOT blocked by in-flight preparation
    clockExp.advance(1_000, 1_000);
    assert.equal(queueExp.sweepExpired(), 1);
    assert.equal(queueExp.getJob(grant.jobId)?.state, 'queued');

    let beforePublishCalled = false;
    assertFenced(() =>
      prepared.commit(() => {
        beforePublishCalled = true;
      }),
    );
    assert.equal(beforePublishCalled, false);
    assert.equal(publishedVerdicts.length, 0);

    // Re-acquire epoch 2 and test expiry detected directly at commit() without an intervening sweep
    const grant2 = queueExp.tryAcquireLease({ workerId: 'w-2', capabilities: makeWorkerCapabilities() })!;
    assert.equal(grant2.leaseEpoch, 2);
    const prepared2 = queueExp.prepareCompleteLease(grant2.jobId, {
      relayBootId: grant2.relayBootId,
      leaseEpoch: grant2.leaseEpoch,
      leaseToken: grant2.leaseToken,
      status: 'approved',
      reason: null,
      hardwareProvenance: makeProvenance(),
    });
    clockExp.advance(1_000, 1_000);
    assertFenced(() => prepared2.commit());
    assert.equal(queueExp.getJob(grant2.jobId)?.state, 'preempted_exhausted');
  } finally {
    queueExp.close();
  }

  // 2. Cancellation during preparation must not be overwritten by prepared.commit()
  const clockCancel = new FakeClock();
  const queueCancel = new RelayPullQueue({ clock: clockCancel, leaseTtlMs: 5_000, startSweepTimer: false });
  try {
    const sub = queueCancel.submitJob(makeBenchmarkRequest({ operationId: 'op-prep-cancel' }));
    const grant = queueCancel.tryAcquireLease({ workerId: 'w-c', capabilities: makeWorkerCapabilities() })!;
    const prepared = queueCancel.prepareCompleteLease(grant.jobId, {
      relayBootId: grant.relayBootId,
      leaseEpoch: grant.leaseEpoch,
      leaseToken: grant.leaseToken,
      status: 'approved',
      reason: null,
      hardwareProvenance: makeProvenance(),
    });
    assert.equal(queueCancel.cancelJob(sub.jobId), true);
    assert.equal(queueCancel.getJob(sub.jobId)?.state, 'cancelled');
    assertFenced(() => prepared.commit());
    assert.equal(queueCancel.getJob(sub.jobId)?.state, 'cancelled');
    assert.equal(queueCancel.getJob(sub.jobId)?.verdict.reason, 'BENCHMARK_CANCELLED');
  } finally {
    queueCancel.close();
  }

  // 3. Shutdown during preparation refuses commit with QUEUE_LEASE_FENCED
  const clockClose = new FakeClock();
  const queueClose = new RelayPullQueue({ clock: clockClose, leaseTtlMs: 5_000, startSweepTimer: false });
  queueClose.submitJob(makeBenchmarkRequest({ operationId: 'op-prep-shutdown' }));
  const grantClose = queueClose.tryAcquireLease({ workerId: 'w-s', capabilities: makeWorkerCapabilities() })!;
  const preparedClose = queueClose.prepareCompleteLease(grantClose.jobId, {
    relayBootId: grantClose.relayBootId,
    leaseEpoch: grantClose.leaseEpoch,
    leaseToken: grantClose.leaseToken,
    status: 'approved',
    reason: null,
    hardwareProvenance: makeProvenance(),
  });
  queueClose.close();
  assertFenced(() => preparedClose.commit());
  assert.notEqual(queueClose.getJob(grantClose.jobId)?.state, 'completed');
});

test('maxJobs=1 releases active capacity on terminal settlement while retaining idempotent/conflict bindings', () => {
  const clock = new FakeClock();
  const queue = new RelayPullQueue({ clock, leaseTtlMs: 5_000, maxJobs: 1, startSweepTimer: false });
  try {
    // Job 1 admitted -> active capacity full (maxJobs = 1)
    const req1 = makeBenchmarkRequest({ operationId: 'op-turn-1' });
    const sub1 = queue.submitJob(req1);
    assert.equal(sub1.created, true);
    assert.equal(queue.activeJobCount, 1);

    assert.throws(
      () => queue.submitJob(makeBenchmarkRequest({ operationId: 'op-blocked-while-active' })),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'QUEUE_CAPACITY_EXCEEDED',
    );

    // Settle Job 1 via completion -> capacity released!
    const g1 = queue.tryAcquireLease({ workerId: 'w-1', capabilities: makeWorkerCapabilities() })!;
    queue.completeLease(g1.jobId, {
      relayBootId: g1.relayBootId,
      leaseEpoch: g1.leaseEpoch,
      leaseToken: g1.leaseToken,
      status: 'approved',
      reason: null,
      hardwareProvenance: makeProvenance(),
    });
    assert.equal(queue.activeJobCount, 0);

    // Job 1 binding retained for idempotent polls and conflict rejection
    const poll1 = queue.submitJob(req1);
    assert.equal(poll1.created, false);
    assert.equal(poll1.verdict.status, 'approved');
    assert.throws(
      () => queue.submitJob(makeBenchmarkRequest({ ...req1, requestDigest: sha256Hex('conflict-1') })),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'QUEUE_JOB_CONFLICT',
    );

    // Job 2 admitted and settled via preemption exhaustion -> capacity released!
    const req2 = makeBenchmarkRequest({ operationId: 'op-turn-2', maxPreemptions: 0 });
    assert.equal(queue.submitJob(req2).created, true);
    assert.equal(queue.activeJobCount, 1);
    const g2 = queue.tryAcquireLease({ workerId: 'w-2', capabilities: makeWorkerCapabilities() })!;
    queue.preemptLease(g2.jobId, {
      relayBootId: g2.relayBootId,
      leaseEpoch: g2.leaseEpoch,
      leaseToken: g2.leaseToken,
    });
    assert.equal(queue.activeJobCount, 0);

    // Job 3 admitted and settled via cancellation -> capacity released for Job 4!
    const sub3 = queue.submitJob(makeBenchmarkRequest({ operationId: 'op-turn-3' }));
    assert.equal(queue.activeJobCount, 1);
    assert.equal(queue.cancelJob(sub3.jobId), true);
    assert.equal(queue.activeJobCount, 0);

    const sub4 = queue.submitJob(makeBenchmarkRequest({ operationId: 'op-turn-4' }));
    assert.equal(sub4.created, true);
    assert.equal(queue.activeJobCount, 1);
  } finally {
    queue.close();
  }
});

test('preemptLease and sweepExpired fence state-changing transitions on 1,001ms clock drift and preserve trusted timestamps', () => {
  // 1. preemptLease fails closed at 1,001ms drift without consuming retry or settling expired
  const clockPreempt = new FakeClock(1_000, 1_700_000_000_000);
  const terminalFromPreempt: BenchmarkVerdict[] = [];
  const queuePreempt = new RelayPullQueue({
    clock: clockPreempt,
    leaseTtlMs: 10_000,
    verdictTtlMs: 60_000,
    startSweepTimer: false,
    onTerminalVerdict: v => terminalFromPreempt.push(v),
  });
  try {
    queuePreempt.submitJob(makeBenchmarkRequest({ operationId: 'op-drift-preempt', maxPreemptions: 0 }));
    const grant = queuePreempt.tryAcquireLease({ workerId: 'w-1', capabilities: makeWorkerCapabilities() })!;

    // Drift by +1,001ms
    clockPreempt.advance(2_000, 3_001);
    assertFenced(() =>
      queuePreempt.preemptLease(grant.jobId, {
        relayBootId: grant.relayBootId,
        leaseEpoch: grant.leaseEpoch,
        leaseToken: grant.leaseToken,
      }),
    );
    assert.equal(queuePreempt.isClockDegraded(), true);
    assert.equal(terminalFromPreempt.length, 0);
    const snap = queuePreempt.getJob(grant.jobId)!;
    assert.equal(snap.state, 'leased');
    assert.equal(snap.preemptionCount, 0);
    // Pending verdict expiresAtMs uses last trusted sample (1_700_000_000_000 + 60_000), NOT drifted 1_700_000_003_001
    assert.equal(snap.verdict.expiresAtMs, String(1_700_000_000_000 + 60_000));
  } finally {
    queuePreempt.close();
  }

  // 2. sweepExpired refuses state-changing requeue or terminal expiry when clock drifts by 1,001ms
  const clockSweep = new FakeClock(1_000, 1_700_000_000_000);
  const terminalFromSweep: BenchmarkVerdict[] = [];
  const queueSweep = new RelayPullQueue({
    clock: clockSweep,
    leaseTtlMs: 5_000,
    startSweepTimer: false,
    onTerminalVerdict: v => terminalFromSweep.push(v),
  });
  try {
    queueSweep.submitJob(makeBenchmarkRequest({ operationId: 'op-drift-sweep', maxPreemptions: 0 }));
    const grant = queueSweep.tryAcquireLease({ workerId: 'w-1', capabilities: makeWorkerCapabilities() })!;

    // Advance monotonic past leaseTtlMs (6_000ms > 5_000ms) WITH 1,001ms wall drift (7_001ms)
    clockSweep.advance(6_000, 7_001);
    assert.equal(queueSweep.sweepExpired(), 0);
    assert.equal(queueSweep.isClockDegraded(), true);
    assert.equal(terminalFromSweep.length, 0);
    assert.equal(queueSweep.getJob(grant.jobId)?.state, 'leased');
  } finally {
    queueSweep.close();
  }

  // 3. Oversized assembled benchmark_verdict (> 65,536 bytes) rejected before commit
  const clockCap = new FakeClock();
  const queueCap = new RelayPullQueue({ clock: clockCap, leaseTtlMs: 5_000, startSweepTimer: false });
  try {
    queueCap.submitJob(makeBenchmarkRequest({ operationId: 'op-verdict-size-cap' }));
    const grant = queueCap.tryAcquireLease({ workerId: 'w-cap', capabilities: makeWorkerCapabilities() })!;
    const largeFindings = Array.from({ length: 40 }, (_, i) => ({
      title: `Finding-${i}`,
      severity: 'medium' as const,
      evidence: 'e'.repeat(1_800),
    }));
    assert.throws(
      () =>
        queueCap.prepareCompleteLease(grant.jobId, {
          relayBootId: grant.relayBootId,
          leaseEpoch: grant.leaseEpoch,
          leaseToken: grant.leaseToken,
          status: 'denied',
          reason: 'oversized_evidence',
          detail: 'd'.repeat(16_000),
          findings: largeFindings,
        }),
      (err: unknown) =>
        err instanceof HardwareRunnerError
        && err.code === 'PAYLOAD_TOO_LARGE'
        && MAX_BENCHMARK_VERDICT_BYTES === 65_536,
    );
  } finally {
    queueCap.close();
  }
});

test('restoreTerminalOperation recovers receipt-only and request-paired terminal operations without consuming active capacity', () => {
  const clock = new FakeClock();
  const queue = new RelayPullQueue({ clock, maxJobs: 1, startSweepTimer: false });
  try {
    const req1 = makeBenchmarkRequest({ operationId: 'op-rec-receipt-only' });
    const approvedVerdict: BenchmarkVerdict = {
      version: 1,
      kind: 'benchmark_verdict',
      storeId: req1.storeId,
      runId: req1.runId,
      lockHash: req1.lockHash,
      operationId: req1.operationId,
      dispatchId: req1.dispatchId,
      dispatchGeneration: req1.dispatchGeneration,
      gateId: req1.gateId,
      checkId: req1.checkId,
      candidateDigest: req1.candidateDigest,
      status: 'approved',
      reason: null,
      expiresAtMs: String(clock.wallMs + 60_000),
      preemptionCount: 1,
      hardwareProvenance: makeProvenance(),
    };

    // Pending verdict cannot be restored as terminal
    assert.throws(
      () => queue.restoreTerminalOperation({ verdict: { ...approvedVerdict, status: 'pending' } }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'ARTIFACT_INVALID',
    );
    // Mismatched request binding rejected
    assert.throws(
      () =>
        queue.restoreTerminalOperation({
          verdict: approvedVerdict,
          request: makeBenchmarkRequest({ ...req1, dispatchId: 'mismatch' }),
        }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'ARTIFACT_INVALID',
    );

    // Receipt-only restore (no persisted BenchmarkRequest) exposes snapshot for output serving/reconcile,
    // and strictly refuses ANY unauthenticated POST re-binding with QUEUE_JOB_CONFLICT!
    queue.restoreTerminalOperation({ verdict: approvedVerdict });
    assert.equal(queue.activeJobCount, 0);
    assert.equal(queue.hasOperation('op-rec-receipt-only'), true);
    const snap = queue.getJobByOperationId('op-rec-receipt-only');
    assert.equal(snap?.state, 'completed');
    assert.equal(snap?.verdict.status, 'approved');

    // Duplicate restore rejected
    assert.throws(
      () => queue.restoreTerminalOperation({ verdict: approvedVerdict }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'QUEUE_JOB_CONFLICT',
    );

    // Both forged and matching POSTs against a receipt-only record fail closed without mutating canonical request
    assert.throws(
      () => queue.submitJob(makeBenchmarkRequest({ ...req1, requestDigest: sha256Hex('forged-digest') })),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'QUEUE_JOB_CONFLICT',
    );
    assert.throws(
      () => queue.submitJob(req1),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'QUEUE_JOB_CONFLICT',
    );

    // Descriptor + receipt paired restore replays matching POST idempotently and rejects conflicting bindings
    const reqPaired = makeBenchmarkRequest({ operationId: 'op-rec-paired' });
    const pairedVerdict: BenchmarkVerdict = {
      ...approvedVerdict,
      operationId: reqPaired.operationId,
    };
    queue.restoreTerminalOperation({ verdict: pairedVerdict, request: reqPaired });
    const idemp = queue.submitJob(reqPaired);
    assert.equal(idemp.created, false);
    assert.equal(idemp.verdict.status, 'approved');
    assert.throws(
      () => queue.submitJob(makeBenchmarkRequest({ ...reqPaired, requestDigest: sha256Hex('later-conflict') })),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'QUEUE_JOB_CONFLICT',
    );
    assert.throws(
      () => queue.submitJob(makeBenchmarkRequest({ ...reqPaired, heldOutWorkloadId: 'different-workload' })),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'QUEUE_JOB_CONFLICT',
    );
  } finally {
    queue.close();
  }
});

test('lease-relative clock drift (+600ms -> 0ms -> -600ms = 1,200ms) fences both sweepExpired and preemptLease without evicting leases, and prepareCompleteLease enforces targetCellId + retention cap', () => {
  // 1. +600ms -> 0ms -> -600ms sequence on sweepExpired (global boot/adjacent offsets stay <= 600ms, lease-relative = 1,200ms)
  const clockSweep = new FakeClock(1_000, 1_000_000);
  const sweptTerminals: BenchmarkVerdict[] = [];
  const queueSweep = new RelayPullQueue({
    clock: clockSweep,
    leaseTtlMs: 5_000,
    startSweepTimer: false,
    onTerminalVerdict: v => sweptTerminals.push(v),
  });
  try {
    queueSweep.submitJob(makeBenchmarkRequest({ operationId: 'op-rel-sweep', maxPreemptions: 0 }));
    // Step 1: +600ms offset relative to boot (mono +1000, wall +1600) -> grant lease (notAfterMono = 7000)
    clockSweep.advance(1_000, 1_600);
    const grant = queueSweep.tryAcquireLease({ workerId: 'w-rel-1', capabilities: makeWorkerCapabilities() })!;
    assert.equal(grant.leaseEpoch, 1);

    // Step 2: intermediate sample at 0ms offset relative to boot (mono +2000 -> 4000, wall +1400 -> 1_003_000)
    clockSweep.advance(2_000, 1_400);
    assert.equal(queueSweep.sweepExpired(), 0);
    assert.equal(queueSweep.isClockDegraded(), false);

    // Step 3: -600ms offset relative to boot past lease TTL (mono +3500 -> 7500 >= 7000, wall +2900 -> 1_005_900)
    // Global adjacent = -600ms, global cumulative = -600ms, but lease-relative = -1,200ms (> 1,000ms)!
    clockSweep.advance(3_500, 2_900);
    assert.equal(queueSweep.sweepExpired(), 0);
    assert.equal(queueSweep.isClockDegraded(), true);
    assert.equal(sweptTerminals.length, 0);
    assert.equal(queueSweep.getJob(grant.jobId)?.state, 'leased');
    assert.equal(queueSweep.getJob(grant.jobId)?.preemptionCount, 0);
  } finally {
    queueSweep.close();
  }

  // 2. Same +600ms -> 0ms -> -600ms sequence on preemptLease (must check lease-relative drift BEFORE sweeping!)
  const clockPreempt = new FakeClock(1_000, 1_000_000);
  const preemptTerminals: BenchmarkVerdict[] = [];
  const queuePreempt = new RelayPullQueue({
    clock: clockPreempt,
    leaseTtlMs: 5_000,
    startSweepTimer: false,
    onTerminalVerdict: v => preemptTerminals.push(v),
  });
  try {
    queuePreempt.submitJob(makeBenchmarkRequest({ operationId: 'op-rel-preempt', maxPreemptions: 0 }));
    clockPreempt.advance(1_000, 1_600);
    const grant = queuePreempt.tryAcquireLease({ workerId: 'w-rel-2', capabilities: makeWorkerCapabilities() })!;

    clockPreempt.advance(2_000, 1_400);
    assert.equal(queuePreempt.sweepExpired(), 0);

    clockPreempt.advance(3_500, 2_900);
    assertFenced(() =>
      queuePreempt.preemptLease(grant.jobId, {
        relayBootId: grant.relayBootId,
        leaseEpoch: grant.leaseEpoch,
        leaseToken: grant.leaseToken,
      }),
    );
    assert.equal(queuePreempt.isClockDegraded(), true);
    assert.equal(preemptTerminals.length, 0);
    assert.equal(queuePreempt.getJob(grant.jobId)?.state, 'leased');
  } finally {
    queuePreempt.close();
  }

  // 3. prepareCompleteLease enforces hardwareProvenance.targetCellId === job.request.targetCellId and bounds maxRetainedTerminalOps
  assert.throws(() => new RelayPullQueue({ maxRetainedTerminalOps: 0 }));
  const clockCell = new FakeClock();
  const queueCell = new RelayPullQueue({
    clock: clockCell,
    maxJobs: 1,
    maxRetainedTerminalOps: 2,
    startSweepTimer: false,
  });
  try {
    assert.equal(queueCell.maxRetainedTerminalOps, 2);
    for (let i = 0; i < 4; i += 1) {
      queueCell.submitJob(makeBenchmarkRequest({ operationId: `op-cap-${i}` }));
      const g = queueCell.tryAcquireLease({ workerId: `w-${i}`, capabilities: makeWorkerCapabilities() })!;
      if (i === 0) {
        assert.throws(
          () =>
            queueCell.completeLease(g.jobId, {
              relayBootId: g.relayBootId,
              leaseEpoch: g.leaseEpoch,
              leaseToken: g.leaseToken,
              status: 'approved',
              reason: null,
              hardwareProvenance: { ...makeProvenance(), targetCellId: 'mismatched-cell' },
            }),
          (err: unknown) => err instanceof HardwareRunnerError && err.code === 'ARTIFACT_INVALID',
        );
      }
      queueCell.completeLease(g.jobId, {
        relayBootId: g.relayBootId,
        leaseEpoch: g.leaseEpoch,
        leaseToken: g.leaseToken,
        status: 'approved',
        reason: null,
        hardwareProvenance: makeProvenance(),
      });
    }
    assert.equal(queueCell.retainedTerminalCount, 2);
    assert.equal(queueCell.hasOperation('op-cap-0'), false);
    assert.equal(queueCell.hasOperation('op-cap-1'), false);
    assert.equal(queueCell.hasOperation('op-cap-2'), true);
    assert.equal(queueCell.hasOperation('op-cap-3'), true);
  } finally {
    queueCell.close();
  }
});
