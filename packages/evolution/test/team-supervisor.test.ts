import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  SecretScrubber,
  isWritablePath,
  validateDocument,
  type Digest,
  type TaskContract,
} from '@loopwright/core';
import {
  RUN_EVAL_SCHEMA_VERSION,
  type RunEvalReport,
  type TrustedRegistry,
} from '@loopwright/controller';
import {
  compileDeclarativeTaskpack,
  loadDeclarativeTaskpack,
  type TaskpackManifest,
} from '@loopwright/taskpack';
import { parseEvolutionCampaignDocument } from '../src/schema.js';
import { EvolutionCampaignStore } from '../src/store.js';
import {
  evaluateTeamEvolutionTrigger,
  hasRunEvalLoopPathology,
  recordTeamTrialOutcome,
  runPlateauSupervisorTurn,
  stageSupervisorContext,
  validateAndCompileTeamPatch,
} from '../src/team-supervisor.js';
import {
  EvolutionError,
  type EvolutionBudgetsSpec,
  type EvolutionErrorCode,
  type EvolutionTeamSpec,
  type IslandRecord,
  type TeamPatchV1,
} from '../src/types.js';

function makeDigest(seed: string): Digest {
  return { algorithm: 'sha256', hex: createHash('sha256').update(seed, 'utf8').digest('hex') };
}

function assertEvolutionError(fn: () => unknown, expectedCode: EvolutionErrorCode): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof EvolutionError, `expected EvolutionError, got ${String(err)}`);
    assert.equal(err.code, expectedCode);
    return true;
  });
}

const TEAM_EVOLUTION_SPEC: EvolutionTeamSpec = Object.freeze({
  enabled: true,
  supervisorRoleId: 'supervisor',
  allowedArchetypeRoles: ['probe-readonly', 'mutator-sandboxed', 'reviewer'],
  stallGenerations: 4,
  minHypervolumeDelta: 0.001,
  triggerOnRunEvalPathology: true,
  trialGenerations: 2,
  maxTeamSize: 3,
  maxTeamSteps: 4,
});

const DEFAULT_BUDGETS: EvolutionBudgetsSpec = Object.freeze({
  maxGenerations: 20,
  maxEvaluations: 80,
  maxConcurrentEvaluations: 2,
  targetRooflineHeadroom: 1.08,
  scratchpadIntervalGenerations: 5,
});

const BASE_TASKPACK_YAML = `
apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: flash-decode-team-test
spec:
  goal:
    candidate: Optimize flash decode kernel inside EVOLVE-BLOCK markers.
    noChange: No kernel change needed.
  target:
    matrix:
      - id: cuda-h100-whole
        platform: linux/amd64
        variant: cuda12
        hardware:
          accelerator: sm_90a
          isolationMode: whole_device
          deviceCount: 1
  scope:
    writable:
      - src/kernels/**
    protected:
      - src/kernels/locked.cu
  models:
    - provider: anthropic
      id: claude-sonnet-4-6
      thinking: medium
    - provider: openai
      id: gpt-5.4
      thinking: high
  roles:
    - id: probe-readonly
      provider: anthropic
      model: claude-sonnet-4-6
      purpose: task
      tools: [read]
      prompt: Inspect kernel Roofline bottleneck without mutating files.
    - id: mutator-sandboxed
      provider: anthropic
      model: claude-sonnet-4-6
      purpose: task
      dependsOn: [probe-readonly]
      tools: [read, write, edit, bash]
      prompt: Apply bounded kernel changes inside EVOLVE-BLOCK markers.
    - id: reviewer
      provider: anthropic
      model: claude-sonnet-4-6
      purpose: review
      dependsOn: [mutator-sandboxed]
      tools: [read]
      prompt: Review candidate diff against scope and numerical bounds.
  verification:
    localChecks:
      - id: evolve-guard
        implementation: evolve-block-guard.v1
        parameters:
          files:
            - src/kernels/flash_decode.cu
    externalGates:
      - id: gpu-bench
        implementation: benchmark-gate.v1
        endpointId: hw-relay
        gateId: flash-decode-bench
        required: true
        targetCellId: cuda-h100-whole
        heldOutWorkloadId: decode-bs1-4k
        allowSyntheticHardwareProbe: true
        metricThresholds:
          - kind: bounds
            metric: max_ulp
            max: 2
            bucketScope: all_buckets
  publication:
    mode: disabled
  triggers:
    schedule: false
    workflowDispatch: true
    releasePublished: false
    commentCommands: []
`;

const CAMPAIGN_WITH_TEAM_YAML = `
apiVersion: loopwright.dev/v1alpha1
kind: EvolutionCampaign
metadata:
  name: team-evo-campaign
spec:
  taskpack: .loopwright/taskpack.yaml
  targetCellId: cuda-h100-whole
  stages:
    mode: single-target
  population:
    islands: 2
    migrationIntervalGenerations: 4
    maxMigrationElites: 1
    nicheAxes:
      - id: bound_pipeline
        kind: enum
        values: [hbm, l2, smem_lds_ub, tensor_cube]
  sampling:
    noveltyDecayLambda: 1.0
    mutationWeights:
      diff_tune: 0.5
      full_rewrite: 0.3
      crossover: 0.2
    modelBandit: ucb1
    maxCrossoversPerPrompt: 2
  teamEvolution:
    enabled: true
    supervisorRoleId: supervisor
    allowedArchetypeRoles: [probe-readonly, mutator-sandboxed, reviewer]
    stallGenerations: 4
    minHypervolumeDelta: 0.001
    triggerOnRunEvalPathology: true
    trialGenerations: 2
    maxTeamSize: 3
    maxTeamSteps: 4
  objectives:
    - metric: latency_us_p50
      direction: minimize
    - metric: goodput_rps
      direction: maximize
  budgets:
    maxGenerations: 20
    maxEvaluations: 80
    maxConcurrentEvaluations: 2
    targetRooflineHeadroom: 1.08
    scratchpadIntervalGenerations: 5
`;

async function makeCompiledBaseFixtures(): Promise<{
  readonly taskpack: TaskpackManifest;
  readonly baseTaskContract: TaskContract;
  readonly trustedRegistry: TrustedRegistry;
}> {
  const taskpack = await loadDeclarativeTaskpack({
    bytes: Buffer.from(BASE_TASKPACK_YAML, 'utf8'),
    format: 'yaml',
    executionMode: 'delegated',
    allowLoopbackHttp: true,
    policyProfile: 'local',
  });
  const compiled = await compileDeclarativeTaskpack(taskpack, {
    mode: 'candidate',
    executionMode: 'delegated',
    repository: 'local/evolution',
    hostPolicy: { policyProfile: 'local', allowWorkflowWrites: false },
    baseRevision: 'a'.repeat(40),
    sourceRevision: 'a'.repeat(40),
    gateEndpoints: [
      {
        id: 'hw-relay',
        url: 'http://127.0.0.1:9999',
        signingCredentialRef: 'bench-sign',
        implementation: 'benchmark-gate.v1',
      },
    ],
    credentialEnvMap: {
      byCredentialRef: { 'bench-sign': 'LOOPWRIGHT_GATE_SIGNING_SECRET' },
    },
    budgets: {
      wallTimeMs: 600_000,
      totalTokens: 250_000,
      perCallOutputTokens: 16_384,
      maxModelCalls: 16,
      maxConcurrency: 1,
      maxFormatRepairs: 0,
      maxImplementationRepairs: 0,
      maxTransportRetries: 1,
      enforcement: {
        wallTime: 'hard_admission',
        tokens: 'soft_accounting',
        modelCalls: 'hard_admission',
        concurrency: 'hard_admission',
        formatRepairs: 'hard_admission',
        implementationRepairs: 'hard_admission',
        transportRetries: 'hard_admission',
      },
    },
  });

  const extraResources = [
    {
      id: 'res-arch-guide',
      kind: 'document' as const,
      path: '.loopwright/instructions/sm90a.md',
      digest: makeDigest('res-arch-guide'),
    },
    {
      id: 'res-scratchpad',
      kind: 'document' as const,
      path: '.loopwright/scratchpad/latest.md',
      digest: makeDigest('res-scratchpad'),
    },
  ];

  const baseTaskContract: TaskContract = {
    ...compiled.config.spec.task,
    spec: {
      ...compiled.config.spec.task.spec,
      trustedContext: {
        ...compiled.config.spec.task.spec.trustedContext,
        resources: [...compiled.config.spec.task.spec.trustedContext.resources, ...extraResources],
      },
    },
  };

  // Enforce 60s toolWallMs on probe-readonly profile to test timeout ceiling enforcement
  const trustedRegistry: TrustedRegistry = {
    ...compiled.registry,
    spec: {
      ...compiled.registry.spec,
      resources: [...compiled.registry.spec.resources, ...extraResources],
      roleProfiles: compiled.registry.spec.roleProfiles.map(prof =>
        prof.id.includes('probe-readonly')
          ? { ...prof, limits: { ...prof.limits, toolWallMs: 60_000 } }
          : { ...prof, limits: { ...prof.limits, toolWallMs: 180_000 } },
      ),
    },
  };

  return { taskpack, baseTaskContract, trustedRegistry };
}

function makeIsland(overrides: Partial<IslandRecord> = {}): IslandRecord {
  return {
    campaignId: overrides.campaignId ?? 'camp-team-1',
    islandId: overrides.islandId ?? 0,
    activeTeamConfigId: overrides.activeTeamConfigId ?? 'camp-team-1:island-0:baseline',
    currentGeneration: overrides.currentGeneration ?? 3,
    consecutiveNoGainGenerations: overrides.consecutiveNoGainGenerations ?? 0,
    consecutivePathologyRuns: overrides.consecutivePathologyRuns ?? 0,
    lastHypervolume: overrides.lastHypervolume ?? 120.5,
    bestRooflineHeadroom: overrides.bestRooflineHeadroom !== undefined ? overrides.bestRooflineHeadroom : 1.35,
  };
}

function makeRunEvalReport(overrides: {
  readonly runId?: string;
  readonly pingPongDetected?: boolean;
  readonly circuitBreaker?: 'none' | 'max_turns' | 'consecutive_tool_errors' | 'no_progress' | 'unavailable';
} = {}): RunEvalReport {
  return {
    schemaVersion: RUN_EVAL_SCHEMA_VERSION,
    runId: overrides.runId ?? 'run-eval-1',
    status: 'failed',
    journalRevision: 6,
    toolTelemetry: 'available',
    toolRepeats: {
      items: [],
      totalFailingCalls: overrides.circuitBreaker === 'consecutive_tool_errors' ? 4 : 0,
      circuitBreaker: overrides.circuitBreaker ?? 'none',
    },
    pingPong: {
      detected: overrides.pingPongDetected === true,
      checkOscillations: overrides.pingPongDetected ? 2 : 0,
      repeatedFailureSignatures: overrides.pingPongDetected ? 2 : 0,
      digestCycles: 0,
      repeatedReworks: 0,
      totalReworks: 0,
    },
    repairConvergence: {
      attempts: { ordinary: 1, format: 0, implementation: 1, rework: 0 },
      unchangedDigestRepairs: 0,
      initialFailingChecks: 1,
      finalFailingChecks: 1,
      failingCheckDelta: 0,
      converged: false,
    },
    breakdown: {
      byStep: [],
      byRole: [],
      totals: {
        tokens: { input: 100, output: 50, total: 150 },
        costMicrousd: null,
        costCompleteness: 'unavailable',
        modelCalls: 1,
        toolCalls: 2,
        elapsedMs: 250,
      },
    },
    suggestions: [],
  };
}

test('team-supervisor: steady-progress island, disabled spec, reached roofline, or exhausted budget invokes 0 supervisor turns', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'evo-supervisor-steady-'));
  try {
    const { taskpack, baseTaskContract, trustedRegistry } = await makeCompiledBaseFixtures();
    const store = await EvolutionCampaignStore.open({ campaignRoot: join(tempDir, 'campaign') });
    try {
      const lease = await store.acquireLease('steady-owner');
      const manifest = parseEvolutionCampaignDocument(CAMPAIGN_WITH_TEAM_YAML);
      await store.createCampaign(lease, {
        campaignId: 'camp-steady',
        manifest,
        manifestDigest: makeDigest(CAMPAIGN_WITH_TEAM_YAML),
        baseRevision: 'a'.repeat(40),
        lockHash: makeDigest('lock-steady'),
        modelIds: ['claude-sonnet-4-6'],
      });
      const island = (await store.getIsland('camp-steady', 0))!;

      // 1. Steady-progress island (consecutiveNoGainGenerations = 2 < stallGenerations = 4, 1 pathology < 2)
      const steadyDecision = evaluateTeamEvolutionTrigger({
        teamEvolution: TEAM_EVOLUTION_SPEC,
        island: makeIsland({ ...island, consecutiveNoGainGenerations: 2, consecutivePathologyRuns: 1 }),
        budgets: DEFAULT_BUDGETS,
        evaluationsUsed: 10,
        currentGeneration: 3,
        recentRunEvals: [makeRunEvalReport({ pingPongDetected: false }), makeRunEvalReport({ pingPongDetected: true })],
      });
      assert.equal(steadyDecision.shouldInvoke, false);
      assert.equal(steadyDecision.suppressedReason, 'steady_progress');

      // 2. teamEvolution disabled
      assert.equal(
        evaluateTeamEvolutionTrigger({
          teamEvolution: { ...TEAM_EVOLUTION_SPEC, enabled: false },
          island: makeIsland({ consecutiveNoGainGenerations: 10 }),
          budgets: DEFAULT_BUDGETS,
          evaluationsUsed: 10,
          currentGeneration: 5,
        }).shouldInvoke,
        false,
      );

      // 3. Remaining evaluation budget < 2 (cannot cover 1 supervisor turn + 1 child evaluation)
      const noEvalBudget = evaluateTeamEvolutionTrigger({
        teamEvolution: TEAM_EVOLUTION_SPEC,
        island: makeIsland({ consecutiveNoGainGenerations: 6 }),
        budgets: DEFAULT_BUDGETS,
        evaluationsUsed: 79,
        currentGeneration: 5,
      });
      assert.equal(noEvalBudget.shouldInvoke, false);
      assert.equal(noEvalBudget.suppressedReason, 'insufficient_evaluation_budget');

      // 4. Remaining generation budget < 1
      const noGenBudget = evaluateTeamEvolutionTrigger({
        teamEvolution: TEAM_EVOLUTION_SPEC,
        island: makeIsland({ consecutiveNoGainGenerations: 6 }),
        budgets: DEFAULT_BUDGETS,
        evaluationsUsed: 20,
        currentGeneration: 20,
      });
      assert.equal(noGenBudget.shouldInvoke, false);
      assert.equal(noGenBudget.suppressedReason, 'insufficient_generation_budget');

      // 5. Island already reached targetRooflineHeadroom (1.05 <= 1.08)
      const rooflineMet = evaluateTeamEvolutionTrigger({
        teamEvolution: TEAM_EVOLUTION_SPEC,
        island: makeIsland({ consecutiveNoGainGenerations: 8, bestRooflineHeadroom: 1.05 }),
        budgets: DEFAULT_BUDGETS,
        evaluationsUsed: 20,
        currentGeneration: 5,
      });
      assert.equal(rooflineMet.shouldInvoke, false);
      assert.equal(rooflineMet.suppressedReason, 'target_roofline_reached');

      // Verify runPlateauSupervisorTurn invokes supervisorRunner 0 times on steady island
      let supervisorCalls = 0;
      const turnRes = await runPlateauSupervisorTurn({
        store,
        lease,
        campaignId: 'camp-steady',
        island,
        teamEvolution: TEAM_EVOLUTION_SPEC,
        budgets: DEFAULT_BUDGETS,
        evaluationsUsed: 10,
        currentGeneration: 2,
        baseTaskContract,
        taskpack,
        trustedRegistry,
        stagingDir: join(tempDir, 'unused-stage'),
        supervisorRunner: async () => {
          supervisorCalls += 1;
          return '{}';
        },
      });
      assert.equal(turnRes.invoked, false);
      assert.equal(supervisorCalls, 0);
    } finally {
      await store.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('team-supervisor: stalled island and >= 2 RunEval pathologies invoke strictly read-only tools: ["read"] supervisor with 0o400 O_NOFOLLOW scrubbed context', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'evo-supervisor-isolation-'));
  try {
    const { baseTaskContract } = await makeCompiledBaseFixtures();

    assert.equal(hasRunEvalLoopPathology(makeRunEvalReport({ pingPongDetected: false, circuitBreaker: 'none' })), false);
    assert.equal(hasRunEvalLoopPathology(makeRunEvalReport({ pingPongDetected: true })), true);
    assert.equal(hasRunEvalLoopPathology(makeRunEvalReport({ circuitBreaker: 'consecutive_tool_errors' })), true);
    assert.equal(hasRunEvalLoopPathology(makeRunEvalReport({ circuitBreaker: 'no_progress' })), true);

    const stallTrigger = evaluateTeamEvolutionTrigger({
      teamEvolution: TEAM_EVOLUTION_SPEC,
      island: makeIsland({ consecutiveNoGainGenerations: 4, consecutivePathologyRuns: 0 }),
      budgets: DEFAULT_BUDGETS,
      evaluationsUsed: 16,
      currentGeneration: 4,
    });
    assert.equal(stallTrigger.shouldInvoke, true);
    assert.equal(stallTrigger.triggerReason, 'pareto_stagnation');

    const pathologyTrigger = evaluateTeamEvolutionTrigger({
      teamEvolution: TEAM_EVOLUTION_SPEC,
      island: makeIsland({ consecutiveNoGainGenerations: 1, consecutivePathologyRuns: 0 }),
      budgets: DEFAULT_BUDGETS,
      evaluationsUsed: 8,
      currentGeneration: 2,
      recentRunEvals: [
        makeRunEvalReport({ runId: 'r-ok', pingPongDetected: false }),
        makeRunEvalReport({ runId: 'r-p1', pingPongDetected: true }),
        makeRunEvalReport({ runId: 'r-p2', circuitBreaker: 'no_progress' }),
      ],
    });
    assert.equal(pathologyTrigger.shouldInvoke, true);
    assert.equal(pathologyTrigger.triggerReason, 'run_eval_pathology');
    assert.equal(pathologyTrigger.consecutivePathologyRuns, 2);

    const stagingDir = join(tempDir, 'sup-ctx');
    const scrubber = new SecretScrubber();
    scrubber.register('super-secret-relay-hmac-key-999');

    const staged = await stageSupervisorContext({
      stagingDir,
      campaignId: 'camp-iso-1',
      island: makeIsland({ campaignId: 'camp-iso-1', consecutiveNoGainGenerations: 4 }),
      triggerReason: 'pareto_stagnation',
      teamEvolution: TEAM_EVOLUTION_SPEC,
      baseTaskContract,
      trajectory: [
        { generation: 1, hypervolume: 100, bestScalarFitness: 0.5, nichesOpen: 2 },
        { generation: 2, hypervolume: 100.0002, bestScalarFitness: 0.5, nichesOpen: 2 },
      ],
      recentRunEvals: [
        makeRunEvalReport({ runId: 'r-p1', pingPongDetected: true }),
        makeRunEvalReport({ runId: 'r-p2', circuitBreaker: 'consecutive_tool_errors' }),
      ],
      recentIndividuals: [],
      latestScratchpadMarkdown: '# Campaign Scratchpad\n- Avoid shared memory bank conflicts.\n',
      teamHistory: [
        {
          teamConfigId: 'team-failed-prev',
          campaignId: 'camp-iso-1',
          islandId: 0,
          parentTeamConfigId: 'camp-iso-1:island-0:baseline',
          status: 'rolled_back',
          createdGeneration: 2,
          trialBudgetGenerations: 2,
          trialUsedGenerations: 2,
          paretoAdvances: 0,
          nicheDiscoveries: 0,
          diagnosis: {
            summary: 'Over-split pipeline degraded context coherence',
            plateauCategory: 'coupled_responsibilities',
            rationale: 'Three-hop chain lost tile size invariants',
          },
          patchCasDigest: makeDigest('old-patch'),
        },
      ],
      scrubber,
    });

    assert.equal(staged.supervisorContract.spec.roles.length, 1);
    const supRole = staged.supervisorContract.spec.roles[0]!;
    assert.equal(supRole.id, 'supervisor');
    assert.deepEqual(supRole.tools, ['read']);
    assert.deepEqual(staged.writablePaths, []);
    const writableCheck = isWritablePath(staged.supervisorContract, 'src/kernels/flash_decode.cu');
    assert.equal(writableCheck.ok, true);
    if (writableCheck.ok) {
      assert.equal(writableCheck.value, false);
    }
    assert.equal(
      staged.supervisorContract.spec.acceptance.checks.some(c => c.allowedEvidenceLevels.includes('hardware_execution')),
      false,
    );
    assert.equal(JSON.stringify(staged.supervisorContract).includes('decode-bs1-4k'), false);

    assert.ok(staged.files.length >= 5);
    for (const file of staged.files) {
      const st = lstatSync(file.filePath);
      assert.equal(st.isSymbolicLink(), false);
      assert.equal(st.nlink, 1);
      assert.equal(st.mode & 0o777, 0o400);
    }
    const historyFile = staged.files.find(f => f.name === 'team-history.json');
    assert.ok(historyFile !== undefined);
    const historyJson = readFileSync(historyFile.filePath, 'utf8');
    assert.ok(historyJson.includes('rolled_back'));
    assert.ok(historyJson.includes('Over-split pipeline degraded context coherence'));

    const symDir = join(tempDir, 'sym-sup-ctx');
    symlinkSync(stagingDir, symDir);
    await assert.rejects(
      () => stageSupervisorContext({
        stagingDir: symDir,
        campaignId: 'camp-iso-1',
        island: makeIsland(),
        triggerReason: 'pareto_stagnation',
        teamEvolution: TEAM_EVOLUTION_SPEC,
        baseTaskContract,
        scrubber,
      }),
      (err: unknown) => err instanceof EvolutionError && err.code === 'EVOLUTION_SYMLINK_FORBIDDEN',
    );

    await assert.rejects(
      () => stageSupervisorContext({
        stagingDir: join(tempDir, 'leak-sup-ctx'),
        campaignId: 'camp-iso-1',
        island: makeIsland(),
        triggerReason: 'pareto_stagnation',
        teamEvolution: TEAM_EVOLUTION_SPEC,
        baseTaskContract,
        latestScratchpadMarkdown: 'Leaked credential super-secret-relay-hmac-key-999',
        scrubber,
      }),
      (err: unknown) => err instanceof EvolutionError && err.code === 'SECRET_LEAK_DETECTED',
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('team-supervisor: TEAM_ENVELOPE_VIOLATION rejects tool widening, unapproved archetype, undeclared model, unpinned resource, scope/acceptance tampering, and D > 256 overflow while retaining incumbent team', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'evo-supervisor-envelope-'));
  try {
    const { taskpack, baseTaskContract, trustedRegistry } = await makeCompiledBaseFixtures();

    const makeValidRawPatch = (): Record<string, unknown> => ({
      kind: 'TeamPatch',
      schemaVersion: 'team-patch.v1',
      diagnosis: {
        summary: 'Mutator couples bottleneck measurement with tile tuning',
        plateauCategory: 'coupled_responsibilities',
        rationale: 'Isolate read-only bottleneck analysis from sandboxed mutator',
      },
      roles: [
        {
          id: 'bottleneck-auditor',
          archetypeRoleId: 'probe-readonly',
          purpose: 'task',
          tools: ['read'],
          model: 'claude-sonnet-4-6',
          resourceIds: ['res-arch-guide'],
          timeoutSeconds: 45,
          prompt: 'Analyze warp stall breakdown and emit ## Bottleneck Summary.',
        },
        {
          id: 'tile-mutator',
          archetypeRoleId: 'mutator-sandboxed',
          purpose: 'task',
          tools: ['read', 'edit'],
          model: 'gpt-5.4',
          resourceIds: ['res-arch-guide', 'res-scratchpad'],
          timeoutSeconds: 120,
          prompt: 'Apply async TMA tile schedule inside EVOLVE-BLOCK.',
        },
      ],
      steps: [
        {
          id: 'step-audit',
          roleId: 'bottleneck-auditor',
          dependsOn: [],
        },
        {
          id: 'step-mutate',
          roleId: 'tile-mutator',
          dependsOn: ['step-audit'],
          handoffs: [
            {
              id: 'bottleneck-handoff',
              fromStep: 'step-audit',
              source: { kind: 'submission' },
              select: { kind: 'markdown_heading', heading: 'Bottleneck Summary' },
              maxBytes: 4096,
              required: true,
            },
          ],
        },
      ],
    });

    // 0. Free-form Markdown wrapper rejected (strict parseTeamPatchV1, zero regex scraping)
    assertEvolutionError(
      () => validateAndCompileTeamPatch({
        rawPatch: '```json\n' + JSON.stringify(makeValidRawPatch()) + '\n```',
        teamEvolution: TEAM_EVOLUTION_SPEC,
        baseTaskContract,
        taskpack,
        trustedRegistry,
      }),
      'EVOLUTION_SCHEMA_INVALID',
    );

    // 1. Unapproved archetypeRoleId
    const badArchetype = makeValidRawPatch();
    (badArchetype['roles'] as Array<Record<string, unknown>>)[0]!['archetypeRoleId'] = 'root-shell-admin';
    assertEvolutionError(
      () => validateAndCompileTeamPatch({
        rawPatch: badArchetype,
        teamEvolution: TEAM_EVOLUTION_SPEC,
        baseTaskContract,
        taskpack,
        trustedRegistry,
      }),
      'TEAM_ENVELOPE_VIOLATION',
    );

    // 2a. Tool widening beyond read-only archetype (probe-readonly requesting 'write')
    const widenedReadonly = makeValidRawPatch();
    (widenedReadonly['roles'] as Array<Record<string, unknown>>)[0]!['tools'] = ['read', 'write'];
    assertEvolutionError(
      () => validateAndCompileTeamPatch({
        rawPatch: widenedReadonly,
        teamEvolution: TEAM_EVOLUTION_SPEC,
        baseTaskContract,
        taskpack,
        trustedRegistry,
      }),
      'TEAM_ENVELOPE_VIOLATION',
    );

    // 2b. Tool widening beyond mutator archetype ('delete' not in mutator-sandboxed.tools)
    const widenedMutator = makeValidRawPatch();
    (widenedMutator['roles'] as Array<Record<string, unknown>>)[1]!['tools'] = ['read', 'edit', 'delete'];
    assertEvolutionError(
      () => validateAndCompileTeamPatch({
        rawPatch: widenedMutator,
        teamEvolution: TEAM_EVOLUTION_SPEC,
        baseTaskContract,
        taskpack,
        trustedRegistry,
      }),
      'TEAM_ENVELOPE_VIOLATION',
    );

    // 2c. Mutating tool on purpose: 'review' role
    const badReview = makeValidRawPatch();
    (badReview['roles'] as Array<Record<string, unknown>>)[0]!['archetypeRoleId'] = 'mutator-sandboxed';
    (badReview['roles'] as Array<Record<string, unknown>>)[0]!['purpose'] = 'review';
    (badReview['roles'] as Array<Record<string, unknown>>)[0]!['tools'] = ['read', 'bash'];
    assertEvolutionError(
      () => validateAndCompileTeamPatch({
        rawPatch: badReview,
        teamEvolution: TEAM_EVOLUTION_SPEC,
        baseTaskContract,
        taskpack,
        trustedRegistry,
      }),
      'TEAM_ENVELOPE_VIOLATION',
    );

    // 3a. Undeclared model
    const badModel = makeValidRawPatch();
    (badModel['roles'] as Array<Record<string, unknown>>)[1]!['model'] = 'rogue-unpinned-model-99';
    assertEvolutionError(
      () => validateAndCompileTeamPatch({
        rawPatch: badModel,
        teamEvolution: TEAM_EVOLUTION_SPEC,
        baseTaskContract,
        taskpack,
        trustedRegistry,
      }),
      'TEAM_ENVELOPE_VIOLATION',
    );

    // 3b. Unpinned resourceId
    const badResource = makeValidRawPatch();
    (badResource['roles'] as Array<Record<string, unknown>>)[0]!['resourceIds'] = ['res-arch-guide', 'res-unhashed-secret'];
    assertEvolutionError(
      () => validateAndCompileTeamPatch({
        rawPatch: badResource,
        teamEvolution: TEAM_EVOLUTION_SPEC,
        baseTaskContract,
        taskpack,
        trustedRegistry,
      }),
      'TEAM_ENVELOPE_VIOLATION',
    );

    // 3c. timeoutSeconds exceeding archetype ceiling (probe-readonly toolWallMs = 60_000 -> 60s max)
    const badTimeout = makeValidRawPatch();
    (badTimeout['roles'] as Array<Record<string, unknown>>)[0]!['timeoutSeconds'] = 120;
    assertEvolutionError(
      () => validateAndCompileTeamPatch({
        rawPatch: badTimeout,
        teamEvolution: TEAM_EVOLUTION_SPEC,
        baseTaskContract,
        taskpack,
        trustedRegistry,
      }),
      'TEAM_ENVELOPE_VIOLATION',
    );

    // 4a. Scope / acceptance.required tampering in supervisor output
    const tamperedScope = {
      ...makeValidRawPatch(),
      scope: { writable: ['**'], protected: [] },
    };
    assertEvolutionError(
      () => validateAndCompileTeamPatch({
        rawPatch: tamperedScope,
        teamEvolution: TEAM_EVOLUTION_SPEC,
        baseTaskContract,
        taskpack,
        trustedRegistry,
      }),
      'TEAM_ENVELOPE_VIOLATION',
    );

    const tamperedAcceptance = {
      ...makeValidRawPatch(),
      acceptance: { required: [] },
    };
    assertEvolutionError(
      () => validateAndCompileTeamPatch({
        rawPatch: tamperedAcceptance,
        teamEvolution: TEAM_EVOLUTION_SPEC,
        baseTaskContract,
        taskpack,
        trustedRegistry,
      }),
      'TEAM_ENVELOPE_VIOLATION',
    );

    // 4b. Step ID colliding with locked acceptance check identifier
    const collidingStep = makeValidRawPatch();
    (collidingStep['steps'] as Array<Record<string, unknown>>)[0]!['id'] = 'evolve-guard';
    (collidingStep['steps'] as Array<Record<string, unknown>>)[1]!['dependsOn'] = ['evolve-guard'];
    ((collidingStep['steps'] as Array<Record<string, unknown>>)[1]!['handoffs'] as Array<Record<string, unknown>>)[0]!['fromStep'] = 'evolve-guard';
    assertEvolutionError(
      () => validateAndCompileTeamPatch({
        rawPatch: collidingStep,
        teamEvolution: TEAM_EVOLUTION_SPEC,
        baseTaskContract,
        taskpack,
        trustedRegistry,
      }),
      'TEAM_ENVELOPE_VIOLATION',
    );

    // 4c. Checkpoint capacity overflow (D > 256) rejected BEFORE launching any child run
    const highRepairContractRes = validateDocument(
      {
        ...baseTaskContract,
        spec: {
          ...baseTaskContract.spec,
          budgets: {
            ...baseTaskContract.spec.budgets,
            maxModelCalls: 64,
            maxImplementationRepairs: 24,
          },
        },
      },
      'TaskContract',
    );
    assert.equal(highRepairContractRes.ok, true);
    if (!highRepairContractRes.ok) throw new Error('unexpected');

    assertEvolutionError(
      () => validateAndCompileTeamPatch({
        rawPatch: makeValidRawPatch(),
        teamEvolution: TEAM_EVOLUTION_SPEC,
        baseTaskContract: highRepairContractRes.value,
        taskpack,
        trustedRegistry,
        maxAttempts: 40,
      }),
      'TEAM_ENVELOPE_VIOLATION',
    );

    // 5. Campaign continuity: rejected supervisor patch keeps incumbent activeTeamConfigId active in campaign.sqlite
    const store = await EvolutionCampaignStore.open({ campaignRoot: join(tempDir, 'campaign') });
    try {
      const lease = await store.acquireLease('envelope-owner');
      const manifest = parseEvolutionCampaignDocument(CAMPAIGN_WITH_TEAM_YAML);
      await store.createCampaign(lease, {
        campaignId: 'camp-env-1',
        manifest,
        manifestDigest: makeDigest(CAMPAIGN_WITH_TEAM_YAML),
        baseRevision: 'b'.repeat(40),
        lockHash: makeDigest('lock-env'),
        modelIds: ['claude-sonnet-4-6', 'gpt-5.4'],
      });
      await store.updateIslandProgress(lease, {
        campaignId: 'camp-env-1',
        islandId: 0,
        currentGeneration: 4,
        consecutiveNoGainGenerations: 4,
      });
      const stalledIsland = (await store.getIsland('camp-env-1', 0))!;
      const incumbentTeamId = stalledIsland.activeTeamConfigId;

      const rejectedTurn = await runPlateauSupervisorTurn({
        store,
        lease,
        campaignId: 'camp-env-1',
        island: stalledIsland,
        teamEvolution: TEAM_EVOLUTION_SPEC,
        budgets: DEFAULT_BUDGETS,
        evaluationsUsed: 12,
        currentGeneration: 4,
        baseTaskContract,
        taskpack,
        trustedRegistry,
        stagingDir: join(tempDir, 'sup-stage-reject'),
        supervisorRunner: async () => JSON.stringify(widenedReadonly),
      });

      assert.equal(rejectedTurn.invoked, true);
      assert.equal(rejectedTurn.accepted, false);
      assert.equal(rejectedTurn.error?.code, 'TEAM_ENVELOPE_VIOLATION');
      assert.equal(rejectedTurn.activeTeamConfigId, incumbentTeamId);
      assert.equal((await store.getIsland('camp-env-1', 0))?.activeTeamConfigId, incumbentTeamId);
      assert.equal((await store.listTeamConfigs('camp-env-1', 0)).length, 1);
    } finally {
      await store.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('team-supervisor: valid probe-readonly -> mutator-sandboxed StepHandoffSelector patch compiles valid TaskContract, promotes on advance, and auto-rolls back after trialGenerations while ignoring BENCHMARK_PREEMPTED', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'evo-supervisor-trial-'));
  try {
    const { taskpack, baseTaskContract, trustedRegistry } = await makeCompiledBaseFixtures();

    const validPatch: TeamPatchV1 = {
      kind: 'TeamPatch',
      schemaVersion: 'team-patch.v1',
      diagnosis: {
        summary: 'Single mutator repeats HBM uncoalesced access pattern',
        plateauCategory: 'coupled_responsibilities',
        rationale: 'Add read-only probe step feeding Bottleneck Analysis via StepHandoffSelector to sandboxed mutator',
      },
      roles: [
        {
          id: 'probe-auditor',
          archetypeRoleId: 'probe-readonly',
          purpose: 'task',
          tools: ['read'],
          model: 'claude-sonnet-4-6',
          resourceIds: ['res-arch-guide'],
          timeoutSeconds: 45,
          prompt: 'Inspect memory coalescing and emit ## Bottleneck Analysis.',
        },
        {
          id: 'kernel-mutator',
          archetypeRoleId: 'mutator-sandboxed',
          purpose: 'task',
          tools: ['read', 'write', 'edit'],
          model: 'gpt-5.4',
          resourceIds: ['res-arch-guide', 'res-scratchpad'],
          timeoutSeconds: 120,
          prompt: 'Implement vectorized float4 loads inside EVOLVE-BLOCK.',
        },
      ],
      steps: [
        {
          id: 'step-probe',
          roleId: 'probe-auditor',
          dependsOn: [],
        },
        {
          id: 'step-mutate',
          roleId: 'kernel-mutator',
          dependsOn: ['step-probe'],
          handoffs: [
            {
              id: 'probe-to-mutator',
              fromStep: 'step-probe',
              source: { kind: 'submission' },
              select: { kind: 'markdown_heading', heading: 'Bottleneck Analysis', includeSubheadings: true },
              maxBytes: 4096,
              required: true,
            },
          ],
        },
      ],
    };

    const compiled = validateAndCompileTeamPatch({
      rawPatch: JSON.stringify(validPatch),
      teamEvolution: TEAM_EVOLUTION_SPEC,
      baseTaskContract,
      taskpack,
      trustedRegistry,
    });

    assert.ok(compiled.capacity.D <= 256);
    assert.equal(compiled.capacity.N, 2);
    const validatedContract = validateDocument(compiled.taskContract, 'TaskContract');
    assert.equal(validatedContract.ok, true);

    assert.deepEqual(compiled.taskContract.spec.scope, baseTaskContract.spec.scope);
    assert.deepEqual(compiled.taskContract.spec.acceptance, baseTaskContract.spec.acceptance);
    assert.equal(compiled.taskContract.spec.trustedContext.discovery, 'disabled');

    const mutateStep = compiled.taskContract.spec.steps.find(s => s.id === 'step-mutate');
    assert.ok(mutateStep?.kind === 'agent');
    assert.equal(mutateStep.handoffs?.length, 1);
    assert.equal(mutateStep.handoffs?.[0]?.fromStep, 'step-probe');

    const checkSteps = compiled.taskContract.spec.steps.filter(s => s.kind === 'check');
    assert.ok(checkSteps.length >= 2);
    assert.ok(checkSteps.some(cs => cs.dependsOn.includes('step-mutate')));

    const store = await EvolutionCampaignStore.open({ campaignRoot: join(tempDir, 'campaign') });
    try {
      const lease = await store.acquireLease('trial-owner');
      const manifest = parseEvolutionCampaignDocument(CAMPAIGN_WITH_TEAM_YAML);
      await store.createCampaign(lease, {
        campaignId: 'camp-trial-1',
        manifest,
        manifestDigest: makeDigest(CAMPAIGN_WITH_TEAM_YAML),
        baseRevision: 'c'.repeat(40),
        lockHash: makeDigest('lock-trial'),
        modelIds: ['claude-sonnet-4-6', 'gpt-5.4'],
      });

      await store.updateIslandProgress(lease, {
        campaignId: 'camp-trial-1',
        islandId: 0,
        currentGeneration: 4,
        consecutiveNoGainGenerations: 4,
      });
      const island0 = (await store.getIsland('camp-trial-1', 0))!;
      const baselineTeam0 = island0.activeTeamConfigId;

      const acceptedTurn0 = await runPlateauSupervisorTurn({
        store,
        lease,
        campaignId: 'camp-trial-1',
        island: island0,
        teamEvolution: TEAM_EVOLUTION_SPEC,
        budgets: DEFAULT_BUDGETS,
        evaluationsUsed: 8,
        currentGeneration: 4,
        baseTaskContract,
        taskpack,
        trustedRegistry,
        stagingDir: join(tempDir, 'sup-stage-0'),
        supervisorRunner: async ctx => {
          assert.deepEqual(ctx.supervisorContract.spec.roles[0]?.tools, ['read']);
          return JSON.stringify(validPatch);
        },
      });

      assert.equal(acceptedTurn0.invoked, true);
      assert.equal(acceptedTurn0.accepted, true);
      const trialTeam0Id = acceptedTurn0.teamConfig!.teamConfigId;
      assert.equal(acceptedTurn0.teamConfig?.status, 'trial');
      assert.equal(acceptedTurn0.teamConfig?.trialBudgetGenerations, 2);
      assert.equal((await store.getIsland('camp-trial-1', 0))?.activeTeamConfigId, trialTeam0Id);

      // Record a BENCHMARK_PREEMPTED child run bound to trialTeam0Id -> must NOT consume trial_used_generations
      await store.recordIndividual(lease, {
        individualId: 'ind-preempted-trial',
        campaignId: 'camp-trial-1',
        islandId: 0,
        generation: 5,
        bucketId: null,
        teamConfigId: trialTeam0Id,
        modelId: 'gpt-5.4',
        trackId: 'cuda_raw',
        mutationKind: 'diff_tune',
        status: 'preempted',
        failureReason: 'BENCHMARK_PREEMPTED',
        nicheKey: null,
        paretoRank: null,
        crowdingDistance: null,
        scalarFitness: null,
        codeSliceCasDigest: makeDigest('code-preempt'),
        evidenceDigest: null,
        verdictReceiptCasDigest: null,
        outputArtifacts: [],
        metrics: {},
      });

      const preemptOutcome = await recordTeamTrialOutcome(store, lease, {
        campaignId: 'camp-trial-1',
        islandId: 0,
        teamConfigId: trialTeam0Id,
        advancedPareto: false,
        discoveredNiche: false,
        preempted: true,
      });
      assert.equal(preemptOutcome.ignoredPreemption, true);
      assert.equal(preemptOutcome.teamConfig.trialUsedGenerations, 0);
      assert.equal(preemptOutcome.nextStatus, 'trial');

      const trialGen1 = await recordTeamTrialOutcome(store, lease, {
        campaignId: 'camp-trial-1',
        islandId: 0,
        teamConfigId: trialTeam0Id,
        advancedPareto: false,
        discoveredNiche: false,
      });
      assert.equal(trialGen1.teamConfig.trialUsedGenerations, 1);
      assert.equal(trialGen1.nextStatus, 'trial');
      assert.equal(trialGen1.rolledBack, false);

      const trialGen2 = await recordTeamTrialOutcome(store, lease, {
        campaignId: 'camp-trial-1',
        islandId: 0,
        teamConfigId: trialTeam0Id,
        advancedPareto: false,
        discoveredNiche: false,
      });
      assert.equal(trialGen2.teamConfig.trialUsedGenerations, 2);
      assert.equal(trialGen2.nextStatus, 'rolled_back');
      assert.equal(trialGen2.rolledBack, true);
      assert.equal(trialGen2.activeTeamConfigId, baselineTeam0);
      assert.equal((await store.getIsland('camp-trial-1', 0))?.activeTeamConfigId, baselineTeam0);

      // Island 1: stall -> synthesize trial team -> child evaluation advances Pareto -> promoted!
      await store.updateIslandProgress(lease, {
        campaignId: 'camp-trial-1',
        islandId: 1,
        currentGeneration: 4,
        consecutiveNoGainGenerations: 4,
      });
      const island1 = (await store.getIsland('camp-trial-1', 1))!;
      const acceptedTurn1 = await runPlateauSupervisorTurn({
        store,
        lease,
        campaignId: 'camp-trial-1',
        island: island1,
        teamEvolution: TEAM_EVOLUTION_SPEC,
        budgets: DEFAULT_BUDGETS,
        evaluationsUsed: 12,
        currentGeneration: 4,
        baseTaskContract,
        taskpack,
        trustedRegistry,
        stagingDir: join(tempDir, 'sup-stage-1'),
        supervisorRunner: async () => JSON.stringify(validPatch),
      });
      const trialTeam1Id = acceptedTurn1.teamConfig!.teamConfigId;

      await store.recordIndividual(lease, {
        individualId: 'ind-promoted-child',
        campaignId: 'camp-trial-1',
        islandId: 1,
        generation: 5,
        bucketId: null,
        teamConfigId: trialTeam1Id,
        modelId: 'gpt-5.4',
        trackId: 'cuda_raw',
        mutationKind: 'diff_tune',
        status: 'passed',
        failureReason: null,
        nicheKey: 'bound_pipeline=tensor_cube',
        paretoRank: 1,
        crowdingDistance: Number.POSITIVE_INFINITY,
        scalarFitness: 0.95,
        codeSliceCasDigest: makeDigest('code-promoted'),
        evidenceDigest: makeDigest('ev-promoted'),
        verdictReceiptCasDigest: makeDigest('vr-promoted'),
        outputArtifacts: [],
        metrics: { latency_us_p50: 48, goodput_rps: 2400 },
      });

      const promoteOutcome = await recordTeamTrialOutcome(store, lease, {
        campaignId: 'camp-trial-1',
        islandId: 1,
        teamConfigId: trialTeam1Id,
        advancedPareto: true,
        discoveredNiche: true,
      });
      assert.equal(promoteOutcome.promoted, true);
      assert.equal(promoteOutcome.nextStatus, 'promoted');
      assert.equal(promoteOutcome.activeTeamConfigId, trialTeam1Id);
      assert.equal((await store.getIsland('camp-trial-1', 1))?.activeTeamConfigId, trialTeam1Id);
    } finally {
      await store.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
