import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SecretScrubber,
  admitTask,
  digestArtifact,
  identifyManifest,
  type ArtifactRef,
  type Digest,
  type RequestUsage,
} from '@loopwright/core';
import type {
  CheckpointRecord,
  OperationRecord,
  RequestRecord,
  RunView,
} from '@loopwright/state';
import {
  RUN_EVAL_AGGREGATE_MAX_BYTES,
  RUN_EVAL_ARTIFACT_MAX_BYTES,
  RUN_EVAL_LOCAL_TOOL_RECEIPT_MAX_BYTES,
  RUN_EVAL_MAX_SUGGESTIONS,
  RUN_EVAL_SCHEMA_VERSION,
  compilePlan,
  evaluateRunHealth,
  formatRunReport,
  inspectRun,
  runCycle,
  type CompiledPlan,
  type ControllerAttempt,
  type ControllerProgress,
  type ReportOutputFormat,
  type RunEvalReport,
} from '../src/index.js';
import { phaseCheckpointId, stableId, verifierOperationId, type ProgressHead } from '../src/progress.js';
import { canonical, hash } from '../src/schema.js';
import { configurationFixture } from './config-fixtures.js';
import { cycleFixture } from './scheduling-fixtures.js';
import { setFixture } from './progress-fixtures.js';

interface SyntheticHarness {
  readonly root: string;
  readonly artifactsDir: string;
  readonly plan: CompiledPlan;
  readonly runId: string;
  readonly lockHash: Digest;
  readonly cleanup: () => Promise<void>;
  readonly putArtifact: (name: string, payload: unknown | Uint8Array) => Promise<ArtifactRef>;
  readonly putCasBlob: (name: string, payload: unknown | Uint8Array) => Promise<ArtifactRef>;
}

async function createSyntheticHarness(options?: {
  readonly delegated?: boolean;
  readonly multiRole?: boolean;
}): Promise<SyntheticHarness> {
  const f = await configurationFixture();
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lw-run-eval-')));
  const artifactsDir = join(root, 'artifacts');
  await mkdir(artifactsDir, { mode: 0o700, recursive: true });
  await mkdir(join(artifactsDir, 'pi-receipts'), { mode: 0o700, recursive: true });
  await mkdir(join(artifactsDir, 'blobs', 'sha256'), { mode: 0o700, recursive: true });

  if (options?.delegated) {
    const selection = { provider: 'antigravity', model: 'gemini-4-argon', thinking: 'low' };
    setFixture(f.registry, ['spec', 'runtimeProfiles'], []);
    setFixture(f.registry, ['spec', 'credentialBindings'], []);
    setFixture(f.registry, ['spec', 'environmentBindings'], []);
    setFixture(f.registry, ['spec', 'roleProfiles', 0], {
      id: f.registry.spec.roleProfiles[0]!.id,
      adapter: 'delegated',
      selection,
      tools: f.registry.spec.roleProfiles[0]!.tools,
      runtimeRef: null,
      providerCredentialRef: null,
      mcp: null,
    });
    setFixture(f.config, ['spec', 'task', 'spec', 'roles', 0], {
      ...f.config.spec.task.spec.roles[0]!,
      adapter: 'delegated',
      provider: selection.provider,
      model: selection.model,
      thinking: selection.thinking,
    });
    setFixture(f.config, ['spec', 'credentials'], []);
  }
  if (options?.multiRole) {
    const baseRoleProfile = structuredClone(f.registry.spec.roleProfiles[0]!);
    const reviewProfile = { ...baseRoleProfile, id: 'reviewer-profile', tools: ['read'] };
    setFixture(f.registry, ['spec', 'roleProfiles'], [baseRoleProfile, reviewProfile]);
    const baseRole = structuredClone(f.config.spec.task.spec.roles[0]!);
    const reviewRole = { ...baseRole, id: 'reviewer', tools: ['read'] };
    setFixture(f.config, ['spec', 'task', 'spec', 'roles'], [baseRole, reviewRole]);
    const baseAgentHandler = structuredClone(f.registry.spec.handlers.find(h => h.id === 'package.patch')!);
    const reviewHandler = {
      ...baseAgentHandler,
      id: 'package.review',
      parameters: { ...baseAgentHandler.parameters, purpose: 'review', prompt: 'Review the candidate changes.' },
    };
    setFixture(f.registry, ['spec', 'handlers'], [...f.registry.spec.handlers, reviewHandler]);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'build', kind: 'agent', uses: 'package.patch', roleId: 'builder', dependsOn: [] },
      {
        id: 'review',
        kind: 'agent',
        uses: 'package.review',
        roleId: 'reviewer',
        dependsOn: ['build'],
        onRework: { rejectTo: 'build', maxReworks: 2 },
      },
      { id: 'verify', kind: 'check', uses: 'tests', roleId: null, dependsOn: ['review'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'roles'], [
      { roleId: 'builder', profileRef: baseRoleProfile.id },
      { roleId: 'reviewer', profileRef: 'reviewer-profile' },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'build', handlerRef: 'package.patch' },
      { stepId: 'review', handlerRef: 'package.review' },
      { stepId: 'verify', handlerRef: 'tests' },
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxModelCalls'], 16);
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxImplementationRepairs'], 4);
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxFormatRepairs'], 2);
    setFixture(f.config, ['spec', 'controls', 'maxAttempts'], 16);
  } else {
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxModelCalls'], 16);
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxImplementationRepairs'], 4);
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxFormatRepairs'], 2);
    setFixture(f.config, ['spec', 'controls', 'maxAttempts'], 16);
  }

  await f.save();
  const loaded = await f.load();
  assert.equal(loaded.ok, true, loaded.ok ? '' : JSON.stringify(loaded.error));
  if (!loaded.ok) throw new Error('load failed');
  const compiled = await compilePlan(loaded.value);
  assert.equal(compiled.ok, true, compiled.ok ? '' : JSON.stringify(compiled.error));
  if (!compiled.ok) throw new Error('compile failed');
  const plan = compiled.value;
  const runId = 'eval-run-1';
  const admitted = admitTask(plan.task, { admissionId: 'adm-1', runId });
  assert.equal(admitted.ok, true);
  if (!admitted.ok) throw new Error('admit failed');

  const putArtifact = async (name: string, payload: unknown | Uint8Array): Promise<ArtifactRef> => {
    const bytes = payload instanceof Uint8Array ? payload : Buffer.from(canonical(payload), 'utf8');
    const target = join(artifactsDir, name);
    await writeFile(target, bytes, { mode: 0o600 });
    const ref = digestArtifact(name, bytes);
    assert.equal(ref.ok, true);
    if (!ref.ok) throw new Error('digest failed');
    return ref.value;
  };

  const putCasBlob = async (name: string, payload: unknown | Uint8Array): Promise<ArtifactRef> => {
    const bytes = payload instanceof Uint8Array ? payload : Buffer.from(canonical(payload), 'utf8');
    const sha = hash(bytes).hex;
    const blobPath = join(artifactsDir, 'blobs', 'sha256', sha);
    try {
      await writeFile(blobPath, bytes, { mode: 0o600, flag: 'wx' });
      await chmod(blobPath, 0o400);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const ref = digestArtifact(name, bytes);
    assert.equal(ref.ok, true);
    if (!ref.ok) throw new Error('digest failed');
    return { ...ref.value, uri: `cas://sha256/${sha}` };
  };

  return {
    root,
    artifactsDir,
    plan,
    runId,
    lockHash: admitted.value.spec.lockHash,
    putArtifact,
    putCasBlob,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
      await f.cleanup();
    },
  };
}

function makeView(
  runId: string,
  lockHash: Digest,
  revision: number,
  clockStatus: 'trusted' | 'blocked' = 'trusted',
  clockEpoch = 'epoch-1',
): RunView {
  const zero = { decimal: '0', safeValue: 0 };
  const sample = { wallMs: 1_700_000_000_000, monotonicMs: '1000' };
  return {
    storeId: 'store.eval',
    runId,
    lockHash,
    identityDigest: hash('id'),
    startedAtMs: 1_700_000_000_000,
    deadlineMs: 1_700_000_600_000,
    revision,
    owner: {
      generation: 1,
      ownerId: 'owner-1',
      mode: 'active',
      leaseUntilMs: 1_700_000_060_000,
      leaseGrantedMonotonicMs: '1000',
      leaseUntilMonotonicMs: '61000',
    },
    policy: { version: 1, leaseMs: 60_000, cost: 'observe_only' },
    binding: {
      coreApiVersion: 'loopwright.dev/v1alpha1',
      hostVersion: 'test',
      adapters: [{ id: 'pi', version: '0.0.0' }],
      resourceVersion: 'r1',
      clockEpoch,
    },
    clockStatus,
    clock: {
      basis: { clockEpoch, created: sample, taskDeadlineMonotonicMs: '601000' },
      lastCommittedSample: sample,
      sampledNow: sample,
      elapsedTaskMs: zero,
      remainingTaskMs: { decimal: '600000', safeValue: 600_000 },
    },
    ledger: {
      admittedCalls: 0,
      formatRepairs: 0,
      implementationRepairs: 0,
      transportRetries: 0,
      heldSlots: 0,
      reportedTokens: zero,
      estimatedTokens: zero,
      unknownTokenRequests: 0,
      reservedCharge: zero,
      chargedTokens: zero,
      remainingTokens: { decimal: '100000', safeValue: 100_000 },
      reportedCostMicrousd: zero,
      estimatedCostMicrousd: zero,
      unknownCostRequests: 0,
      violations: [],
    },
    counts: {
      requests: 0,
      operations: 0,
      checkpoints: 0,
      reservedRequests: 0,
      dispatchedRequests: 0,
      observedRequests: 0,
      unresolvedRequests: 0,
      releasedRequests: 0,
      unresolvedOperations: 0,
    },
  };
}

function makeCheckpoint(
  runId: string,
  lockHash: Digest,
  sequence: number,
  phase: string,
  candidateDigest: Digest,
  monotonicMs: string,
  clockEpoch = 'epoch-1',
): CheckpointRecord {
  const view = makeView(runId, lockHash, sequence, 'trusted', clockEpoch);
  const emptyRef: ArtifactRef = { name: 'ws.bin', digest: hash('ws'), byteLength: 2 };
  return {
    sequence,
    checkpointId: phaseCheckpointId(runId, phase),
    inputDigest: hash('cp-' + sequence),
    subject: {
      repository: 'acme/repo',
      baseRevision: 'a'.repeat(40),
      sourceRevision: 'a'.repeat(40),
      contractHash: hash('contract'),
      lockHash,
      candidateDigest,
      targetMatrixDigest: null,
    },
    workspace: emptyRef,
    privateSession: null,
    additionalArtifacts: [],
    storeId: view.storeId,
    runId,
    lockHash,
    binding: view.binding,
    formatVersion: 1,
    generation: 1,
    publishedRevision: sequence,
    startedAtMs: view.startedAtMs,
    deadlineMs: view.deadlineMs,
    clockBasis: view.clock.basis,
    clockSample: { wallMs: 1_700_000_000_000 + Number(monotonicMs), monotonicMs },
    ledger: view.ledger,
    ledgerRoot: hash('lr-' + sequence),
    counts: view.counts,
  };
}

function makeRequest(
  sequence: number,
  roleId: string,
  nodeId: string,
  attemptId: string,
  usage: RequestUsage | null,
  repair: 'none' | 'format' | 'implementation' = 'none',
): RequestRecord {
  const requestId = `req-${sequence}`;
  const operationId = `op-req-${sequence}`;
  const lockHash = hash('lock');
  const dummyRef: ArtifactRef = { name: `u-${sequence}.bin`, digest: hash('u' + sequence), byteLength: 2 };
  return {
    sequence,
    admission: {
      requestId,
      roleId,
      nodeId,
      attemptId,
      purpose: 'task',
      repair,
      transportRetryOf: null,
      requestDigest: hash('req-' + sequence),
      inputUpperBound: 1000,
      outputUpperBound: 1000,
      totalUpperBound: 2000,
      capability: {
        adapterId: 'pi',
        adapterVersion: '0.0.0',
        provider: 'openai',
        model: 'gpt-5',
        kind: 'soft_only',
        coversAllBillableTokens: false,
        enforcesOutputBound: false,
      },
      operationId,
      targetIdentity: 'provider:openai',
    },
    admissionDigest: hash('adm-' + sequence),
    admissionGeneration: 1,
    state: usage ? 'observed' : 'unresolved',
    dispatch: { generation: 1, dispatchId: `disp-${sequence}`, revision: sequence },
    holdsSlot: false,
    chargedTokens: { decimal: '0', safeValue: 0 },
    initialObservation: usage
      ? {
          receiptId: `rcpt-${sequence}`,
          termination: 'confirmed',
          outcome: 'succeeded',
          usage,
          evidence: {
            evidenceId: `ev-${sequence}`,
            producerId: 'pi',
            method: 'sse',
            artifact: dummyRef,
            subject: {
              storeId: 'store.eval',
              runId: 'eval-run-1',
              lockHash,
              operationId,
              requestId,
              intentDigest: hash('i-' + sequence),
              dispatchGeneration: 1,
              dispatchId: `disp-${sequence}`,
            },
          },
        }
      : null,
    resolution: null,
    unresolvedReason: usage ? null : 'timeout',
    violations: [],
  };
}

function makeToolOperation(
  sequence: number,
  nodeId: string,
  targetIdentity: string,
  outcome: 'succeeded' | 'failed',
  artifact: ArtifactRef,
  lockHash: Digest,
): OperationRecord {
  const operationId = `tool-op-${sequence}`;
  return {
    sequence,
    intent: {
      operationId,
      nodeId,
      attemptId: `tool-attempt-${sequence}`,
      effect: 'read_only',
      requestDigest: hash('tool-req-' + sequence),
      targetIdentity,
    },
    intentDigest: hash('tool-int-' + sequence),
    intentGeneration: 1,
    linkedRequestId: null,
    state: 'confirmed',
    dispatch: { generation: 1, dispatchId: `tdisp-${sequence}`, revision: sequence },
    initialReceipt: {
      receiptId: `tool-rcpt-${sequence}`,
      outcome,
      evidence: {
        evidenceId: `tool-ev-${sequence}`,
        producerId: 'pi-owner',
        method: 'local-tool-v1',
        artifact,
        subject: {
          storeId: 'store.eval',
          runId: 'eval-run-1',
          lockHash,
          operationId,
          requestId: null,
          intentDigest: hash('tool-int-' + sequence),
          dispatchGeneration: 1,
          dispatchId: `tdisp-${sequence}`,
        },
      },
    },
    reconciliation: null,
    unresolvedReason: null,
  };
}

function makeProgressHead(
  h: SyntheticHarness,
  overrides: Partial<ControllerProgress> & { readonly candidateDigest?: Digest },
): ProgressHead {
  const dummyRef: ArtifactRef = { name: 'dummy.bin', digest: hash('dummy'), byteLength: 2 };
  const candidateDigest = overrides.candidateDigest ?? hash('cand-0');
  const identified = identifyManifest({
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'ArtifactManifest',
    metadata: { id: 'candidate' },
    spec: { entries: [] },
  });
  assert.equal(identified.ok, true);
  if (!identified.ok) throw new Error('manifest failed');
  const progress: ControllerProgress = {
    version: 2,
    runId: h.runId,
    lockHash: h.lockHash,
    sequence: 1,
    previous: null,
    stage: {
      kind: 'terminal_observations',
      phase: 'terminal.observations',
      capacity: h.plan.capacity,
      consumed: ['bootstrap'],
      watermarks: { requests: 0, operations: 0 },
    },
    nodes: h.plan.orderedDAG.map(n => ({ id: n.id, state: 'completed' as const })),
    attempts: [],
    nativeCheckpoints: [],
    submission: null,
    publication: { status: 'idle', operationId: null, receipt: null },
    candidate: { manifest: dummyRef, digest: candidateDigest, generation: 0, workspace: dummyRef, privateSession: null },
    failures: [],
    verifierReceipts: [],
    verifierRefusals: [],
    eventSequence: 0,
    terminalIntent: { primary: 'completed', result: null, observations: null },
    ...overrides,
  };
  const cp = makeCheckpoint(h.runId, h.lockHash, 1, 'bootstrap', candidateDigest, '1000');
  return {
    checkpoint: cp,
    ref: dummyRef,
    progress,
    index: { version: 1, runId: h.runId, entries: [] },
    manifest: identified.value.manifest,
  };
}

test('RunEval: repeated failing tool calls, circuit-breaker states, and delegated_unavailable telemetry', async () => {
  const h = await createSyntheticHarness();
  try {
    const cmdRef = await h.putArtifact('cmd.bin', { text: 'do work' });
    const attempt1Id = stableId(h.runId, 'build', 'task', 'none', 1);
    const r1 = await h.putArtifact('pi-receipts/tool-op-1-final.json', {
      version: 1, outcome: 'failed', parentRequestId: 'req-1', tool: 'edit', target: 'candidate:src/a.ts',
    });
    const r2 = await h.putArtifact('pi-receipts/tool-op-2-final.json', {
      version: 1, outcome: 'failed', parentRequestId: 'req-1', tool: 'edit', target: 'candidate:src/a.ts',
    });
    const r3 = await h.putArtifact('pi-receipts/tool-op-3-final.json', {
      version: 1, outcome: 'failed', parentRequestId: 'req-1', tool: 'bash', target: 'scratch:s1',
    });
    const r4 = await h.putArtifact('pi-receipts/tool-op-4-final.json', {
      version: 1, outcome: 'failed', parentRequestId: 'req-1', tool: 'bash', target: 'scratch:s1',
    });
    const r5 = await h.putArtifact('pi-receipts/tool-op-5-final.json', {
      version: 1, outcome: 'failed', parentRequestId: 'req-1', tool: 'bash', target: 'scratch:s1',
    });
    const rSingle = await h.putArtifact('pi-receipts/tool-op-6-final.json', {
      version: 1, outcome: 'failed', parentRequestId: 'req-1', tool: 'read', target: 'candidate:README.md',
    });
    const rOk = await h.putArtifact('pi-receipts/tool-op-7-final.json', {
      version: 1, outcome: 'succeeded', parentRequestId: 'req-1', tool: 'edit', target: 'candidate:src/a.ts',
    });

    const ops: OperationRecord[] = [
      makeToolOperation(1, 'build', 'candidate:src/a.ts', 'failed', r1, h.lockHash),
      makeToolOperation(2, 'build', 'candidate:src/a.ts', 'failed', r2, h.lockHash),
      makeToolOperation(3, 'build', 'scratch:s1', 'failed', r3, h.lockHash),
      makeToolOperation(4, 'build', 'scratch:s1', 'failed', r4, h.lockHash),
      makeToolOperation(5, 'build', 'scratch:s1', 'failed', r5, h.lockHash),
      makeToolOperation(6, 'build', 'candidate:README.md', 'failed', rSingle, h.lockHash),
      makeToolOperation(7, 'build', 'candidate:src/a.ts', 'succeeded', rOk, h.lockHash),
    ];
    const reqs: RequestRecord[] = [
      makeRequest(1, 'builder', 'build', attempt1Id, {
        requestId: 'req-1',
        inputTokens: { provenance: 'reported', value: 500 },
        outputTokens: { provenance: 'reported', value: 100 },
        costMicrousd: { provenance: 'estimated', value: 5000 },
      }),
    ];

    const breakerCases: readonly { readonly path: string; readonly expected: RunEvalReport['toolRepeats']['circuitBreaker'] }[] = [
      { path: '/circuit-breaker/maxTurns', expected: 'max_turns' },
      { path: '/circuit-breaker/consecutiveToolErrors', expected: 'consecutive_tool_errors' },
      { path: '/circuit-breaker/repairNoProgress', expected: 'no_progress' },
    ];

    for (const [idx, bc] of breakerCases.entries()) {
      const nativeOutcomeRef = await h.putArtifact(`native-outcome-${idx}.bin`, {
        version: 1,
        attemptId: attempt1Id,
        outcome: {
          status: 'failed',
          requestIds: ['req-1'],
          operationIds: [],
          providerTermination: 'confirmed',
          usage: 'complete',
          localCleanup: 'complete',
          error: {
            code: 'REQUEST_REFUSED',
            path: bc.path,
            phase: 'admission',
            retryable: false,
            effect: 'confirmed',
            requestId: null,
            operationId: null,
            stateErrorCode: 'BUDGET_EXHAUSTED',
          },
          cleanupError: null,
        },
      });
      const roleRefusalRef = await h.putArtifact(`role-refusal-${idx}.bin`, {
        version: 1,
        attemptId: attempt1Id,
        command: cmdRef,
        diagnostic: { version: 1, code: 'BUDGET_EXHAUSTED', phase: 'execution', path: '', stateCode: 'BUDGET_EXHAUSTED', piCode: 'REQUEST_REFUSED', effect: 'confirmed', retryable: false },
        nativeOutcome: nativeOutcomeRef,
        currentCandidate: null,
        unavailable: [],
        localCleanup: 'complete',
      });
      const attempts: ControllerAttempt[] = [
        {
          ordinal: 1,
          id: attempt1Id,
          nodeId: 'build',
          nativeStepId: 'build',
          sessionId: 'sess-1',
          purpose: 'task',
          repair: 'none',
          command: cmdRef,
          before: { requests: 0, operations: 0 },
          finished: { after: { requests: 1, operations: 7 }, outcome: roleRefusalRef, nativeCheckpointId: null },
        },
      ];
      const d0 = hash('d0');
      const checkpoints = [
        makeCheckpoint(h.runId, h.lockHash, 1, 'bootstrap', d0, '1000'),
        makeCheckpoint(h.runId, h.lockHash, 2, 'role.1.pre', d0, '1100'),
        makeCheckpoint(h.runId, h.lockHash, 3, 'role.1.post', d0, '2600'),
      ];
      const head = makeProgressHead(h, {
        attempts,
        terminalIntent: { primary: 'exhausted', result: null, observations: null },
      });
      const report = await evaluateRunHealth({
        runId: h.runId,
        status: 'exhausted',
        plan: h.plan,
        records: { view: makeView(h.runId, h.lockHash, 42), requests: reqs, operations: ops, checkpoints },
        head,
        artifactsDirectory: h.artifactsDir,
      });

      assert.equal(report.schemaVersion, RUN_EVAL_SCHEMA_VERSION);
      assert.equal(report.journalRevision, 42);
      assert.equal(report.toolTelemetry, 'available');
      assert.equal(report.toolRepeats.circuitBreaker, bc.expected);
      assert.equal(report.toolRepeats.totalFailingCalls, 6);
      assert.deepEqual(report.toolRepeats.items, [
        { roleId: 'builder', stepId: 'build', tool: 'bash', target: 'scratch:s1', count: 3 },
        { roleId: 'builder', stepId: 'build', tool: 'edit', target: 'candidate:src/a.ts', count: 2 },
      ]);
      assert.ok(report.suggestions.some(s => s.code === 'CIRCUIT_BREAKER_TRIPPED' && s.autoApplied === false));
      assert.ok(report.suggestions.some(s => s.code === 'REPEATED_TOOL_FAILURES' && s.autoApplied === false));
    }

    // Missing / unreadable outcome -> circuitBreaker: 'unavailable'
    const missingOutcomeRef: ArtifactRef = { name: 'missing-outcome.bin', digest: hash('missing'), byteLength: 32 };
    const unavailableReport = await evaluateRunHealth({
      runId: h.runId,
      status: 'failed',
      plan: h.plan,
      records: { view: makeView(h.runId, h.lockHash, 9), requests: reqs, operations: [], checkpoints: [] },
      head: makeProgressHead(h, {
        attempts: [{
          ordinal: 1, id: attempt1Id, nodeId: 'build', nativeStepId: 'build', sessionId: 'sess-1',
          purpose: 'task', repair: 'none', command: cmdRef, before: { requests: 0, operations: 0 },
          finished: { after: { requests: 1, operations: 0 }, outcome: missingOutcomeRef, nativeCheckpointId: null },
        }],
        terminalIntent: { primary: 'failed', result: null, observations: null },
      }),
      artifactsDirectory: h.artifactsDir,
    });
    assert.equal(unavailableReport.toolRepeats.circuitBreaker, 'unavailable');
  } finally {
    await h.cleanup();
  }

  // Delegated adapter -> toolTelemetry: 'delegated_unavailable'
  const dh = await createSyntheticHarness({ delegated: true });
  try {
    const cmdRef = await dh.putArtifact('cmd.bin', { text: 'delegated work' });
    const outRef = await dh.putArtifact('role-outcome.bin', {
      version: 1, attemptId: stableId(dh.runId, 'build', 'task', 'none', 1),
      journal: { requestIds: [], operationIds: [] },
    });
    const d0 = hash('del-d0');
    const d1 = hash('del-d1');
    const report = await evaluateRunHealth({
      runId: dh.runId,
      status: 'completed',
      plan: dh.plan,
      records: {
        view: makeView(dh.runId, dh.lockHash, 5),
        requests: [],
        operations: [],
        checkpoints: [
          makeCheckpoint(dh.runId, dh.lockHash, 1, 'bootstrap', d0, '1000'),
          makeCheckpoint(dh.runId, dh.lockHash, 2, 'role.1.pre', d0, '1200'),
          makeCheckpoint(dh.runId, dh.lockHash, 3, 'role.1.post', d1, '2200'),
        ],
      },
      head: makeProgressHead(dh, {
        attempts: [{
          ordinal: 1,
          id: stableId(dh.runId, 'build', 'task', 'none', 1),
          nodeId: 'build',
          nativeStepId: 'build',
          sessionId: 'sess-del',
          purpose: 'task',
          repair: 'none',
          command: cmdRef,
          before: { requests: 0, operations: 0 },
          finished: { after: { requests: 0, operations: 0 }, outcome: outRef, nativeCheckpointId: null },
        }],
      }),
      artifactsDirectory: dh.artifactsDir,
    });
    assert.equal(report.toolTelemetry, 'delegated_unavailable');
    assert.equal(report.toolRepeats.circuitBreaker, 'unavailable');
    assert.equal(report.breakdown.totals.modelCalls, 1);
    assert.equal(report.breakdown.totals.costCompleteness, 'unavailable');
    assert.equal(report.breakdown.totals.costMicrousd, null);
    assert.equal(report.breakdown.byRole[0]?.elapsedMs, 1000);
  } finally {
    await dh.cleanup();
  }
});

test('RunEval: pingPong detects check oscillations (S1->S2->S1), identical failure repeats, digest cycles (Da->Db->Da), and repeated reworks', async () => {
  const h = await createSyntheticHarness({ multiRole: true });
  try {
    const slot = h.plan.verifierSlots.find(s => s.implicit === null)!;
    const scopeSlot = h.plan.verifierSlots.find(s => s.implicit === 'scope')!;
    const outG0a = await h.putArtifact('v-g0-a.bin', { binding: { checkId: slot.checkId }, response: { status: 'failed', reason: 'missing_key_a' } });
    const outG1a = await h.putArtifact('v-g1-a.bin', { binding: { checkId: slot.checkId }, response: { status: 'failed', reason: 'missing_key_b' } });
    const outG2a = await h.putArtifact('v-g2-a.bin', { binding: { checkId: slot.checkId }, response: { status: 'failed', reason: 'missing_key_a' } });
    const outG3a = await h.putArtifact('v-g3-a.bin', { binding: { checkId: slot.checkId }, response: { status: 'failed', reason: 'missing_key_a' } });
    const outPass = await h.putArtifact('v-pass.bin', { binding: { checkId: scopeSlot.checkId }, response: { status: 'passed', reason: null } });
    const rcptRef = await h.putArtifact('v-rcpt.bin', { receiptId: 'r' });
    const verdictRaw = await h.putArtifact('verdict.bin', { verdict: 'rework', summary: 'fix it', findings: [] });

    const d0 = hash('digest-a');
    const d1 = hash('digest-b');
    const checkpoints = [
      makeCheckpoint(h.runId, h.lockHash, 1, 'bootstrap', d0, '1000'),
      makeCheckpoint(h.runId, h.lockHash, 2, 'role.1.pre', d0, '1100'),
      makeCheckpoint(h.runId, h.lockHash, 3, 'role.1.post', d1, '2100'),
      makeCheckpoint(h.runId, h.lockHash, 4, 'role.2.pre', d1, '2200'),
      makeCheckpoint(h.runId, h.lockHash, 5, 'role.2.post', d0, '3200'),
    ];

    const head = makeProgressHead(h, {
      reworkEpoch: 2,
      reworkCounts: { review: 2 },
      stepVerdicts: [
        { attemptId: null, stepId: 'review', roleId: 'reviewer', reworkEpoch: 0, generation: 1, raw: verdictRaw, verdict: 'rework', summaryPreview: 'fix 1', findingCount: 1 },
        { attemptId: null, stepId: 'review', roleId: 'reviewer', reworkEpoch: 1, generation: 2, raw: verdictRaw, verdict: 'rework', summaryPreview: 'fix 2', findingCount: 1 },
      ],
      verifierReceipts: [
        { slot: slot.id, generation: 0, operationId: verifierOperationId(h.runId, slot.id, 0), producerNonce: 'a'.repeat(32), output: outG0a, receipt: rcptRef },
        { slot: scopeSlot.id, generation: 0, operationId: verifierOperationId(h.runId, scopeSlot.id, 0), producerNonce: 'b'.repeat(32), output: outPass, receipt: rcptRef },
        { slot: slot.id, generation: 1, operationId: verifierOperationId(h.runId, slot.id, 1), producerNonce: 'c'.repeat(32), output: outG1a, receipt: rcptRef },
        { slot: slot.id, generation: 2, operationId: verifierOperationId(h.runId, slot.id, 2), producerNonce: 'd'.repeat(32), output: outG2a, receipt: rcptRef },
        { slot: slot.id, generation: 3, operationId: verifierOperationId(h.runId, slot.id, 3), producerNonce: 'e'.repeat(32), output: outG3a, receipt: rcptRef },
      ],
      failures: [
        { signature: hash('sig-repeat'), count: 2, generation: 2, evidence: outG3a },
      ],
      terminalIntent: { primary: 'failed', result: null, observations: null },
    });

    const report = await evaluateRunHealth({
      runId: h.runId,
      status: 'failed',
      plan: h.plan,
      records: { view: makeView(h.runId, h.lockHash, 15), requests: [], operations: [], checkpoints },
      head,
      artifactsDirectory: h.artifactsDir,
    });

    assert.equal(report.pingPong.detected, true);
    assert.equal(report.pingPong.checkOscillations, 1);
    assert.equal(report.pingPong.repeatedFailureSignatures, 1);
    assert.equal(report.pingPong.digestCycles, 1);
    assert.equal(report.pingPong.repeatedReworks, 1);
    assert.equal(report.pingPong.totalReworks, 2);
    assert.ok(report.suggestions.some(s => s.code === 'CHECK_OSCILLATION'));
    assert.ok(report.suggestions.some(s => s.code === 'DIGEST_CYCLE'));
    assert.ok(report.suggestions.some(s => s.code === 'REPEATED_REWORKS'));
    assert.ok(report.suggestions.length <= RUN_EVAL_MAX_SUGGESTIONS);
    assert.equal(report.suggestions.every(s => s.autoApplied === false), true);
  } finally {
    await h.cleanup();
  }
});

test('RunEval: repairConvergence splits attempt counts, unchangedDigestRepairs, failingCheckDelta, and converged (true | false | null)', async () => {
  const h = await createSyntheticHarness({ multiRole: true });
  try {
    const cmdRef = await h.putArtifact('cmd.bin', { text: 'work' });
    const outRef = await h.putArtifact('role-out.bin', { version: 1, attemptId: 'a', journal: { requestIds: [], operationIds: [] } });
    const slot = h.plan.verifierSlots.find(s => s.implicit === null)!;
    const scopeSlot = h.plan.verifierSlots.find(s => s.implicit === 'scope')!;
    const rcptRef = await h.putArtifact('rcpt.bin', { receiptId: 'r' });
    const fail1 = await h.putArtifact('fail1.bin', { binding: { checkId: slot.checkId }, response: { status: 'failed', reason: 'bad_json' } });
    const failScope = await h.putArtifact('fail-scope.bin', { binding: { checkId: scopeSlot.checkId }, response: { status: 'failed', reason: 'out_of_scope' } });
    const pass1 = await h.putArtifact('pass1.bin', { binding: { checkId: slot.checkId }, response: { status: 'passed', reason: null } });
    const passScope = await h.putArtifact('pass-scope.bin', { binding: { checkId: scopeSlot.checkId }, response: { status: 'passed', reason: null } });

    const d0 = hash('c0');
    const d1 = hash('c1');
    const d2 = hash('c2');
    const attempts: ControllerAttempt[] = [
      {
        ordinal: 1, id: stableId(h.runId, 'build', 'task', 'none', 1), nodeId: 'build', nativeStepId: 'build',
        sessionId: 's1', purpose: 'task', repair: 'none', command: cmdRef, before: { requests: 0, operations: 0 },
        finished: { after: { requests: 1, operations: 0 }, outcome: outRef, nativeCheckpointId: phaseCheckpointId(h.runId, 'role.1.native') },
      },
      {
        ordinal: 2, id: stableId(h.runId, 'build', 'task', 'format', 2), nodeId: 'build', nativeStepId: 'build',
        sessionId: 's1', purpose: 'task', repair: 'format', command: cmdRef, before: { requests: 1, operations: 0 },
        finished: { after: { requests: 2, operations: 0 }, outcome: outRef, nativeCheckpointId: phaseCheckpointId(h.runId, 'role.2.native') },
      },
      {
        ordinal: 3, id: stableId(h.runId, 'build', 'task', 'implementation', 3), nodeId: 'build', nativeStepId: 'build',
        sessionId: 's1', purpose: 'task', repair: 'implementation', command: cmdRef, before: { requests: 2, operations: 0 },
        finished: { after: { requests: 3, operations: 0 }, outcome: outRef, nativeCheckpointId: phaseCheckpointId(h.runId, 'role.3.native') },
      },
      {
        ordinal: 4, id: stableId(h.runId, 'build', 'task', 'implementation', 4), nodeId: 'build', nativeStepId: 'build',
        sessionId: 's1', purpose: 'task', repair: 'implementation', command: cmdRef, before: { requests: 3, operations: 0 },
        finished: { after: { requests: 4, operations: 0 }, outcome: outRef, nativeCheckpointId: phaseCheckpointId(h.runId, 'role.4.native') },
      },
      {
        ordinal: 5, id: stableId(h.runId, 'build', 'task', 'none', 5), nodeId: 'build', nativeStepId: 'build',
        sessionId: 's1', purpose: 'task', repair: 'none', command: cmdRef, before: { requests: 4, operations: 0 },
        finished: { after: { requests: 5, operations: 0 }, outcome: outRef, nativeCheckpointId: phaseCheckpointId(h.runId, 'role.5.native') },
        reworkEpoch: 1,
      },
    ];
    const checkpoints = [
      makeCheckpoint(h.runId, h.lockHash, 1, 'bootstrap', d0, '1000'),
      makeCheckpoint(h.runId, h.lockHash, 2, 'role.1.pre', d0, '1000'),
      makeCheckpoint(h.runId, h.lockHash, 3, 'role.1.post', d1, '2000'),
      makeCheckpoint(h.runId, h.lockHash, 4, 'role.2.pre', d1, '2000'),
      makeCheckpoint(h.runId, h.lockHash, 5, 'role.2.post', d1, '2500'), // format repair: not counted in unchangedDigestRepairs
      makeCheckpoint(h.runId, h.lockHash, 6, 'role.3.pre', d1, '2500'),
      makeCheckpoint(h.runId, h.lockHash, 7, 'role.3.post', d1, '3500'), // implementation repair with UNCHANGED digest!
      makeCheckpoint(h.runId, h.lockHash, 8, 'role.4.pre', d1, '3500'),
      makeCheckpoint(h.runId, h.lockHash, 9, 'role.4.post', d2, '4500'), // implementation repair with CHANGED digest!
      makeCheckpoint(h.runId, h.lockHash, 10, 'role.5.pre', d2, '4500'),
      makeCheckpoint(h.runId, h.lockHash, 11, 'role.5.post', d2, '5500'),
    ];
    const verifierReceipts = [
      { slot: slot.id, generation: 1, operationId: verifierOperationId(h.runId, slot.id, 1), producerNonce: 'a'.repeat(32), output: fail1, receipt: rcptRef },
      { slot: scopeSlot.id, generation: 1, operationId: verifierOperationId(h.runId, scopeSlot.id, 1), producerNonce: 'b'.repeat(32), output: failScope, receipt: rcptRef },
      { slot: slot.id, generation: 2, operationId: verifierOperationId(h.runId, slot.id, 2), producerNonce: 'c'.repeat(32), output: pass1, receipt: rcptRef },
      { slot: scopeSlot.id, generation: 2, operationId: verifierOperationId(h.runId, scopeSlot.id, 2), producerNonce: 'd'.repeat(32), output: passScope, receipt: rcptRef },
    ];

    const completed = await evaluateRunHealth({
      runId: h.runId,
      status: 'completed',
      plan: h.plan,
      records: { view: makeView(h.runId, h.lockHash, 20), requests: [], operations: [], checkpoints },
      head: makeProgressHead(h, { attempts, verifierReceipts, reworkEpoch: 1, reworkCounts: { review: 1 } }),
      artifactsDirectory: h.artifactsDir,
    });
    assert.deepEqual(completed.repairConvergence.attempts, { ordinary: 1, format: 1, implementation: 2, rework: 1 });
    assert.equal(completed.repairConvergence.unchangedDigestRepairs, 1);
    assert.equal(completed.repairConvergence.initialFailingChecks, 2);
    assert.equal(completed.repairConvergence.finalFailingChecks, 0);
    assert.equal(completed.repairConvergence.failingCheckDelta, -2);
    assert.equal(completed.repairConvergence.converged, true);

    const failed = await evaluateRunHealth({
      runId: h.runId,
      status: 'failed',
      plan: h.plan,
      records: { view: makeView(h.runId, h.lockHash, 20), requests: [], operations: [], checkpoints },
      head: makeProgressHead(h, {
        attempts,
        verifierReceipts: verifierReceipts.slice(0, 2),
        terminalIntent: { primary: 'failed', result: null, observations: null },
      }),
      artifactsDirectory: h.artifactsDir,
    });
    assert.equal(failed.repairConvergence.failingCheckDelta, 0);
    assert.equal(failed.repairConvergence.converged, false);

    const inProgress = await evaluateRunHealth({
      runId: h.runId,
      status: 'in_progress',
      plan: h.plan,
      records: { view: makeView(h.runId, h.lockHash, 10), requests: [], operations: [], checkpoints },
      head: makeProgressHead(h, {
        attempts,
        stage: { kind: 'role_post', phase: 'role.5.post', capacity: h.plan.capacity, consumed: ['bootstrap'], watermarks: { requests: 0, operations: 0 } },
        terminalIntent: null,
      }),
      artifactsDirectory: h.artifactsDir,
    });
    assert.equal(inProgress.repairConvergence.converged, null);
  } finally {
    await h.cleanup();
  }
});

test('RunEval: per-step and per-role tokens, complete vs partial costMicrousd, and monotonic elapsedMs (null when incomplete or non-monotonic)', async () => {
  const h = await createSyntheticHarness({ multiRole: true });
  try {
    const cmdRef = await h.putArtifact('cmd.bin', { text: 'work' });
    const outRef = await h.putArtifact('out.bin', { version: 1, attemptId: 'a', journal: { requestIds: [], operationIds: [] } });
    const a1 = stableId(h.runId, 'build', 'task', 'none', 1);
    const a2 = stableId(h.runId, 'review', 'reviewer', 'none', 2);
    const rTool = await h.putArtifact('pi-receipts/tool-op-1-final.json', {
      version: 1, outcome: 'succeeded', parentRequestId: 'req-1', tool: 'write', target: 'candidate:result.json',
    });

    const attempts: ControllerAttempt[] = [
      {
        ordinal: 1, id: a1, nodeId: 'build', nativeStepId: 'build', sessionId: 's1', purpose: 'task', repair: 'none',
        command: cmdRef, before: { requests: 0, operations: 0 },
        finished: { after: { requests: 2, operations: 1 }, outcome: outRef, nativeCheckpointId: phaseCheckpointId(h.runId, 'role.1.native') },
      },
      {
        ordinal: 2, id: a2, nodeId: 'review', nativeStepId: 'review', sessionId: 's2', purpose: 'reviewer', repair: 'none',
        command: cmdRef, before: { requests: 2, operations: 1 },
        finished: { after: { requests: 3, operations: 1 }, outcome: outRef, nativeCheckpointId: phaseCheckpointId(h.runId, 'role.2.native') },
      },
    ];
    const requests: RequestRecord[] = [
      makeRequest(1, 'builder', 'build', a1, {
        requestId: 'req-1',
        inputTokens: { provenance: 'reported', value: 1000 },
        outputTokens: { provenance: 'reported', value: 200 },
        costMicrousd: { provenance: 'reported', value: 4000 },
      }),
      makeRequest(2, 'builder', 'build', a1, {
        requestId: 'req-2',
        inputTokens: { provenance: 'reported', value: 500 },
        outputTokens: { provenance: 'reported', value: 100 },
        costMicrousd: { provenance: 'unknown' },
      }),
      makeRequest(3, 'reviewer', 'review', a2, {
        requestId: 'req-3',
        inputTokens: { provenance: 'reported', value: 300 },
        outputTokens: { provenance: 'reported', value: 50 },
        costMicrousd: { provenance: 'estimated', value: 1500 },
      }),
    ];
    const operations: OperationRecord[] = [
      makeToolOperation(1, 'build', 'candidate:result.json', 'succeeded', rTool, h.lockHash),
    ];

    const d0 = hash('bd0');
    const d1 = hash('bd1');
    const monotonicCps = [
      makeCheckpoint(h.runId, h.lockHash, 1, 'bootstrap', d0, '1000'),
      makeCheckpoint(h.runId, h.lockHash, 2, 'role.1.pre', d0, '1200'),
      makeCheckpoint(h.runId, h.lockHash, 3, 'role.1.post', d1, '3700'),
      makeCheckpoint(h.runId, h.lockHash, 4, 'role.2.pre', d1, '3800'),
      makeCheckpoint(h.runId, h.lockHash, 5, 'role.2.post', d1, '4300'),
    ];

    const report = await evaluateRunHealth({
      runId: h.runId,
      status: 'completed',
      plan: h.plan,
      records: { view: makeView(h.runId, h.lockHash, 12), requests, operations, checkpoints: monotonicCps },
      head: makeProgressHead(h, { attempts }),
      artifactsDirectory: h.artifactsDir,
    });

    const buildStep = report.breakdown.byStep.find(s => s.stepId === 'build')!;
    const reviewStep = report.breakdown.byStep.find(s => s.stepId === 'review')!;
    assert.equal(report.toolRepeats.circuitBreaker, 'none');
    assert.equal(report.toolTelemetry, 'available');
    assert.equal(report.suggestions.length, 0);
    assert.deepEqual(buildStep.tokens, { input: 1500, output: 300, total: 1800 });
    assert.equal(buildStep.costMicrousd, 4000);
    assert.equal(buildStep.costCompleteness, 'partial');
    assert.equal(buildStep.modelCalls, 2);
    assert.equal(buildStep.toolCalls, 1);
    assert.equal(buildStep.elapsedMs, 2500);

    assert.deepEqual(reviewStep.tokens, { input: 300, output: 50, total: 350 });
    assert.equal(reviewStep.costMicrousd, 1500);
    assert.equal(reviewStep.costCompleteness, 'complete');
    assert.equal(reviewStep.modelCalls, 1);
    assert.equal(reviewStep.toolCalls, 0);
    assert.equal(reviewStep.elapsedMs, 500);

    const builderRole = report.breakdown.byRole.find(r => r.roleId === 'builder')!;
    const reviewerRole = report.breakdown.byRole.find(r => r.roleId === 'reviewer')!;
    assert.equal(builderRole.tokens.total, 1800);
    assert.equal(builderRole.costCompleteness, 'partial');
    assert.equal(reviewerRole.tokens.total, 350);
    assert.equal(reviewerRole.costCompleteness, 'complete');

    assert.deepEqual(report.breakdown.totals.tokens, { input: 1800, output: 350, total: 2150 });
    assert.equal(report.breakdown.totals.costMicrousd, 5500);
    assert.equal(report.breakdown.totals.costCompleteness, 'partial');
    assert.equal(report.breakdown.totals.modelCalls, 3);
    assert.equal(report.breakdown.totals.toolCalls, 1);
    assert.equal(report.breakdown.totals.elapsedMs, 3300);

    // Incomplete checkpoints (missing role.2.post) and non-monotonic role.1.post < role.1.pre -> elapsedMs === null
    const badCps = [
      makeCheckpoint(h.runId, h.lockHash, 1, 'bootstrap', d0, '1000'),
      makeCheckpoint(h.runId, h.lockHash, 2, 'role.1.pre', d0, '3000'),
      makeCheckpoint(h.runId, h.lockHash, 3, 'role.1.post', d1, '2500'), // backwards!
      makeCheckpoint(h.runId, h.lockHash, 4, 'role.2.pre', d1, '4000'),
    ];
    const incompleteReport = await evaluateRunHealth({
      runId: h.runId,
      status: 'in_progress',
      plan: h.plan,
      records: { view: makeView(h.runId, h.lockHash, 12), requests, operations, checkpoints: badCps },
      head: makeProgressHead(h, { attempts, terminalIntent: null }),
      artifactsDirectory: h.artifactsDir,
    });
    assert.equal(incompleteReport.breakdown.byStep.find(s => s.stepId === 'build')?.elapsedMs, null);
    assert.equal(incompleteReport.breakdown.byStep.find(s => s.stepId === 'review')?.elapsedMs, null);
    assert.equal(incompleteReport.breakdown.totals.elapsedMs, null);
  } finally {
    await h.cleanup();
  }
});

test('RunEval: enforces 4 KiB local-tool-v1 cap, 64 KiB fallback cap, 2 MiB aggregate cap, safe regular/CAS file checks, and scrubs secrets/control bytes', async () => {
  const h = await createSyntheticHarness();
  try {
    assert.equal(RUN_EVAL_LOCAL_TOOL_RECEIPT_MAX_BYTES, 4_096);
    assert.equal(RUN_EVAL_ARTIFACT_MAX_BYTES, 65_536);
    assert.equal(RUN_EVAL_AGGREGATE_MAX_BYTES, 2_097_152);

    const rawSecret = 'ghp_SecretCanaryTokenValue1234567890abcd';
    const customSecret = 'CUSTOM_TOP_SECRET_VALUE_987654321';
    const scrubber = new SecretScrubber();
    scrubber.register(customSecret);

    // 1. Oversized local-tool-v1 receipt (> 4 KiB) must be skipped (marking toolTelemetry partial)
    const oversizedReceipt = await h.putArtifact('pi-receipts/tool-op-1-final.json', {
      version: 1, outcome: 'failed', tool: 'bash', target: 'x'.repeat(5_000),
    });
    assert.ok(oversizedReceipt.byteLength > RUN_EVAL_LOCAL_TOOL_RECEIPT_MAX_BYTES);

    // 2. Symlink receipt must be refused by O_NOFOLLOW / !isSymbolicLink()
    const realTarget = join(h.root, 'outside.json');
    const symBody = Buffer.from(canonical({ version: 1, outcome: 'failed', tool: 'read', target: 'candidate:outside' }));
    await writeFile(realTarget, symBody, { mode: 0o600 });
    await symlink(realTarget, join(h.artifactsDir, 'pi-receipts', 'tool-op-2-final.json'));
    const symRefRes = digestArtifact('pi-receipts/tool-op-2-final.json', symBody);
    assert.equal(symRefRes.ok, true);
    if (!symRefRes.ok) throw new Error('symRef failed');

    // 3. Hardlinked receipt (nlink === 2) must be refused
    const hardBody = Buffer.from(canonical({ version: 1, outcome: 'failed', tool: 'read', target: 'candidate:hard' }));
    const hardPath = join(h.artifactsDir, 'pi-receipts', 'tool-op-3-final.json');
    await writeFile(hardPath, hardBody, { mode: 0o600 });
    await link(hardPath, join(h.root, 'hard-extra.json'));
    const hardRefRes = digestArtifact('pi-receipts/tool-op-3-final.json', hardBody);
    assert.equal(hardRefRes.ok, true);
    if (!hardRefRes.ok) throw new Error('hardRef failed');

    // 4. Valid CAS-backed tool receipts carrying secret & ANSI/control bytes
    const dirtyTarget = `candidate:\x1b[31m::error::${rawSecret}\x00${customSecret}\x1b[0m.ts`;
    const cas1 = await h.putCasBlob('pi-receipts/tool-op-4-final.json', {
      version: 1, callId: 'call-4', outcome: 'failed', tool: 'edit', target: dirtyTarget,
    });
    const cas2 = await h.putCasBlob('pi-receipts/tool-op-5-final.json', {
      version: 1, callId: 'call-5', outcome: 'failed', tool: 'edit', target: dirtyTarget,
    });

    // 5. Oversized fallback artifact (> 64 KiB) must be safely skipped without throwing
    const hugeOutcome = await h.putArtifact('native-outcome-huge.bin', {
      version: 1, attemptId: stableId(h.runId, 'build', 'task', 'none', 1), pad: 'z'.repeat(70_000),
    });
    assert.ok(hugeOutcome.byteLength > RUN_EVAL_ARTIFACT_MAX_BYTES);

    const cmdRef = await h.putArtifact('cmd.bin', { text: 'work' });
    const ops: OperationRecord[] = [
      makeToolOperation(1, 'build', 'scratch:big', 'failed', oversizedReceipt, h.lockHash),
      makeToolOperation(2, 'build', 'candidate:outside', 'failed', symRefRes.value, h.lockHash),
      makeToolOperation(3, 'build', 'candidate:hard', 'failed', hardRefRes.value, h.lockHash),
      makeToolOperation(4, 'build', dirtyTarget, 'failed', cas1, h.lockHash),
      makeToolOperation(5, 'build', dirtyTarget, 'failed', cas2, h.lockHash),
    ];

    const report = await evaluateRunHealth({
      runId: h.runId,
      status: 'failed',
      plan: h.plan,
      records: { view: makeView(h.runId, h.lockHash, 7), requests: [], operations: ops, checkpoints: [] },
      head: makeProgressHead(h, {
        attempts: [{
          ordinal: 1, id: stableId(h.runId, 'build', 'task', 'none', 1), nodeId: 'build', nativeStepId: 'build',
          sessionId: 's1', purpose: 'task', repair: 'none', command: cmdRef, before: { requests: 0, operations: 0 },
          finished: { after: { requests: 0, operations: 5 }, outcome: hugeOutcome, nativeCheckpointId: null },
        }],
        terminalIntent: { primary: 'failed', result: null, observations: null },
      }),
      artifactsDirectory: h.artifactsDir,
      scrub: value => scrubber.scrub(value),
    });

    assert.equal(report.toolTelemetry, 'partial');
    assert.equal(report.toolRepeats.circuitBreaker, 'unavailable');
    assert.equal(report.toolRepeats.items.length, 1);
    assert.equal(report.toolRepeats.items[0]!.count, 2);

    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes(rawSecret), false);
    assert.equal(serialized.includes(customSecret), false);
    assert.equal(serialized.includes('\x1b'), false);
    assert.equal(serialized.includes('\x00'), false);
    assert.equal(serialized.includes('::error::'), false);
    assert.ok(serialized.includes('[scrubbed]'));
    assert.ok(report.suggestions.length >= 1 && report.suggestions.length <= RUN_EVAL_MAX_SUGGESTIONS);
    assert.equal(report.suggestions.every(s => s.autoApplied === false), true);

    // 6. Aggregate 2 MiB cap: 35 distinct 62 KiB fallback verifier artifacts (> 2 MiB total) stop cleanly at the aggregate cap
    const slot = h.plan.verifierSlots.find(s => s.implicit === null)!;
    const rcptRef = await h.putArtifact('v-rcpt.bin', { ok: true });
    const manyReceipts: ControllerProgress['verifierReceipts'][number][] = [];
    for (let g = 0; g < 36; g += 1) {
      const ref = await h.putArtifact(`big-v-${g}.bin`, {
        binding: { checkId: slot.checkId },
        response: { status: 'failed', reason: `err-${g}`, pad: 'p'.repeat(61_000) },
      });
      assert.ok(ref.byteLength > 60_000 && ref.byteLength <= RUN_EVAL_ARTIFACT_MAX_BYTES);
      manyReceipts.push({
        slot: slot.id,
        generation: g,
        operationId: verifierOperationId(h.runId, slot.id, g),
        producerNonce: String(g).padStart(32, '0'),
        output: ref,
        receipt: rcptRef,
      });
    }
    let readCount = 0;
    let totalBytesRead = 0;
    const countingReader = {
      read: async (ref: ArtifactRef, maximum = 65_536): Promise<Uint8Array> => {
        readCount += 1;
        const bytes = await readFile(join(h.artifactsDir, ref.name));
        assert.ok(bytes.byteLength <= maximum);
        totalBytesRead += bytes.byteLength;
        return new Uint8Array(bytes);
      },
    };
    const aggReport = await evaluateRunHealth({
      runId: h.runId,
      status: 'failed',
      plan: h.plan,
      records: { view: makeView(h.runId, h.lockHash, 30), requests: [], operations: [], checkpoints: [] },
      head: makeProgressHead(h, { verifierReceipts: manyReceipts }),
      artifacts: countingReader,
    });
    assert.ok(readCount > 0 && readCount < 36, `expected aggregate cap to stop reads before 36, got ${readCount}`);
    assert.ok(totalBytesRead <= RUN_EVAL_AGGREGATE_MAX_BYTES, `exceeded 2 MiB aggregate cap: ${totalBytesRead}`);
    assert.equal(aggReport.schemaVersion, RUN_EVAL_SCHEMA_VERSION);
  } finally {
    await h.cleanup();
  }
});

test('RunEval: inspectRun exports run-eval.json in PublicBundle and formatRunReport renders sanitized Run Health across all four formats', async () => {
  const f = await cycleFixture(true);
  try {
    const input = { configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId: 'run-eval-inspect' };
    const executed = await runCycle(input);
    assert.equal(executed.ok, true, JSON.stringify(executed));

    const exportDir = join(f.root, 'exported-eval');
    const inspected = await inspectRun({ runRoot: f.runRoot, runId: input.runId, output: exportDir });
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    if (!inspected.ok) return;

    assert.ok(inspected.value.runEval !== null);
    assert.equal(inspected.value.runEval!.schemaVersion, RUN_EVAL_SCHEMA_VERSION);
    assert.equal(inspected.value.runEval!.runId, input.runId);
    assert.equal(inspected.value.runEval!.status, 'completed');
    assert.equal(inspected.value.runEval!.repairConvergence.converged, true);

    const manifestEntry = inspected.value.manifest?.entries.find(e => e.name === 'run-eval.json');
    assert.ok(manifestEntry !== undefined);
    assert.equal(manifestEntry!.presence, 'present');
    assert.ok(manifestEntry!.ref !== null);
    const exportedBytes = await readFile(join(exportDir, 'run-eval.json'));
    const ref = digestArtifact('run-eval.json', exportedBytes);
    assert.equal(ref.ok, true);
    if (ref.ok) assert.deepEqual(ref.value, manifestEntry!.ref);
    const parsedExport = JSON.parse(exportedBytes.toString('utf8')) as RunEvalReport;
    assert.deepEqual(parsedExport, inspected.value.runEval);

    // Unavailable run -> runEval: null
    const missing = await inspectRun({ runRoot: f.runRoot, runId: 'does-not-exist' });
    assert.equal(missing.ok, true);
    if (missing.ok) assert.equal(missing.value.runEval, null);

    // formatRunReport across all 4 formats with secret + control byte sanitization
    const secret = 'CUSTOM_REPORT_SECRET_TOKEN_11223344';
    const scrubber = new SecretScrubber();
    scrubber.register(secret);
    const syntheticEval: RunEvalReport = {
      schemaVersion: 1,
      runId: input.runId,
      status: 'failed',
      journalRevision: 7,
      toolTelemetry: 'available',
      toolRepeats: {
        items: [{ roleId: 'builder', stepId: 'build', tool: 'edit', target: `candidate:\x1b[31m::error::${secret}\x1b[0m.ts`, count: 3 }],
        totalFailingCalls: 3,
        circuitBreaker: 'consecutive_tool_errors',
      },
      pingPong: {
        detected: true,
        checkOscillations: 1,
        repeatedFailureSignatures: 1,
        digestCycles: 1,
        repeatedReworks: 1,
        totalReworks: 2,
      },
      repairConvergence: {
        attempts: { ordinary: 1, format: 1, implementation: 2, rework: 1 },
        unchangedDigestRepairs: 1,
        initialFailingChecks: 2,
        finalFailingChecks: 1,
        failingCheckDelta: -1,
        converged: false,
      },
      breakdown: {
        byStep: [
          {
            stepId: 'build',
            roleId: 'builder',
            tokens: { input: 1000, output: 250, total: 1250 },
            costMicrousd: 12_500,
            costCompleteness: 'complete',
            modelCalls: 2,
            toolCalls: 3,
            elapsedMs: 4_200,
          },
        ],
        byRole: [
          {
            roleId: 'builder',
            tokens: { input: 1000, output: 250, total: 1250 },
            costMicrousd: 12_500,
            costCompleteness: 'complete',
            modelCalls: 2,
            toolCalls: 3,
            elapsedMs: 4_200,
          },
        ],
        totals: {
          tokens: { input: 1000, output: 250, total: 1250 },
          costMicrousd: 12_500,
          costCompleteness: 'complete',
          modelCalls: 2,
          toolCalls: 3,
          elapsedMs: 4_200,
        },
      },
      suggestions: [
        {
          autoApplied: false,
          code: 'REPEATED_TOOL_FAILURES',
          severity: 'high',
          summary: `Inspect failing edit on ${secret} \x00 ::warning::bad`,
          evidence: `edit x3 on ${secret}`,
        },
      ],
    };

    for (const fmt of ['json', 'github-step-summary', 'markdown', 'text'] as readonly ReportOutputFormat[]) {
      const rendered = formatRunReport(
        {
          runId: input.runId,
          status: 'failed',
          runEval: syntheticEval,
          scrub: value => scrubber.scrub(value),
        },
        fmt,
      );
      assert.equal(rendered.includes(secret), false, `${fmt} leaked secret`);
      assert.equal(rendered.includes('\x1b'), false, `${fmt} leaked ESC`);
      assert.equal(rendered.includes('\x00'), false, `${fmt} leaked NUL`);
      assert.equal(rendered.includes('::error::'), false, `${fmt} leaked ::error::`);
      assert.equal(rendered.includes('::warning::'), false, `${fmt} leaked ::warning::`);

      if (fmt === 'json') {
        const parsed = JSON.parse(rendered) as { runEval: RunEvalReport };
        assert.equal(parsed.runEval.toolRepeats.circuitBreaker, 'consecutive_tool_errors');
        assert.equal(parsed.runEval.pingPong.detected, true);
        assert.equal(parsed.runEval.repairConvergence.failingCheckDelta, -1);
        assert.equal(parsed.runEval.suggestions[0]?.autoApplied, false);
        assert.ok(parsed.runEval.suggestions[0]?.summary.includes('[scrubbed]'));
      } else {
        assert.ok(rendered.includes('Run Health'), `${fmt} missing Run Health heading`);
        assert.ok(rendered.includes('consecutive_tool_errors'), `${fmt} missing circuitBreaker`);
        assert.ok(rendered.includes('REPEATED_TOOL_FAILURES'), `${fmt} missing suggestion code`);
        assert.ok(rendered.includes('autoApplied'), `${fmt} missing autoApplied: false indicator`);
        assert.ok(rendered.includes('builder'), `${fmt} missing role breakdown`);
        assert.ok(rendered.includes('build'), `${fmt} missing step breakdown`);
      }
    }
  } finally {
    await f.cleanup();
  }
});
