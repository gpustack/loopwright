import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SecretScrubber } from '@loopwright/core';
import { expectedSchema } from '../../state/src/schema.js';
import {
  loadEvolutionCampaignFile,
  parseDispatchManifestV1,
  parseEvolutionCampaignDocument,
  parseNullProtoJson,
  parseTeamPatchV1,
} from '../src/schema.js';
import { EvolutionCampaignStore } from '../src/store.js';
import {
  EVOLUTION_CAMPAIGN_MAX_BYTES,
  EvolutionError,
  TEAM_PATCH_DIAGNOSIS_MAX_BYTES,
  TEAM_PATCH_MAX_BYTES,
  type CampaignClockSource,
  type EvolutionErrorCode,
} from '../src/types.js';

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function makeDigest(seed: string): { readonly algorithm: 'sha256'; readonly hex: string } {
  return { algorithm: 'sha256', hex: sha256Hex(seed) };
}

function assertEvolutionError(fn: () => unknown, expectedCode: EvolutionErrorCode): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof EvolutionError, `expected EvolutionError, got ${String(err)}`);
    assert.equal(err.code, expectedCode);
    return true;
  });
}

async function assertEvolutionErrorAsync(
  fn: () => Promise<unknown>,
  expectedCode: EvolutionErrorCode,
): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof EvolutionError, `expected EvolutionError, got ${String(err)}`);
    assert.equal(err.code, expectedCode);
    return true;
  });
}

const VALID_CAMPAIGN_YAML = `apiVersion: loopwright.dev/v1alpha1
kind: EvolutionCampaign
metadata:
  name: flash-decode-sm90a
spec:
  taskpack: .loopwright/taskpack.yaml
  targetCellId: cuda-h100-whole
  stages:
    mode: specialist-then-portfolio
    specialistBuckets:
      - id: bs1-isl4k
        heldOutWorkloadId: decode-bs1-4k
      - id: bs16-isl8k
        heldOutWorkloadId: decode-bs16-8k
    portfolioHeldOutWorkloadId: decode-portfolio-holdout
  population:
    islands: 4
    migrationIntervalGenerations: 8
    maxMigrationElites: 1
    nicheAxes:
      - id: bound_pipeline
        kind: enum
        values: [hbm, l2, smem_lds_ub, tensor_cube, vector_valu]
      - id: occupancy_band
        kind: numeric_bins
        edges: [0, 25, 50, 75, 100]
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
    - metric: peak_mem_bytes
      direction: minimize
  budgets:
    maxGenerations: 40
    maxEvaluations: 160
    maxConcurrentEvaluations: 4
    targetRooflineHeadroom: 1.08
    scratchpadIntervalGenerations: 5
  export:
    format: oci-layout
    outputDir: .loopwright-out/bundles/flash-decode-sm90a
`;

test('schema: parseEvolutionCampaignDocument produces null-prototype records and enforces bounds', async () => {
  const manifest = parseEvolutionCampaignDocument(VALID_CAMPAIGN_YAML);
  assert.equal(Object.getPrototypeOf(manifest), null);
  assert.equal(Object.getPrototypeOf(manifest.metadata), null);
  assert.equal(Object.getPrototypeOf(manifest.spec), null);
  assert.equal(manifest.metadata.name, 'flash-decode-sm90a');
  assert.equal(manifest.spec.stages.mode, 'specialist-then-portfolio');
  if (manifest.spec.stages.mode === 'specialist-then-portfolio') {
    assert.equal(manifest.spec.stages.specialistBuckets.length, 2);
    assert.equal(manifest.spec.stages.portfolioHeldOutWorkloadId, 'decode-portfolio-holdout');
  }
  assert.equal(manifest.spec.population.islands, 4);
  assert.equal(manifest.spec.sampling.modelBandit, 'ucb1');
  assert.equal(manifest.spec.teamEvolution?.maxTeamSize, 3);
  assert.equal(manifest.spec.objectives.length, 3);
  assert.equal(manifest.spec.export?.format, 'oci-layout');

  // Oversized YAML document (> 65,536 bytes) rejected
  const oversized = `${VALID_CAMPAIGN_YAML}# ${'x'.repeat(EVOLUTION_CAMPAIGN_MAX_BYTES)}\n`;
  assertEvolutionError(() => parseEvolutionCampaignDocument(oversized), 'EVOLUTION_SCHEMA_INVALID');

  // Negative zero, NaN, Infinity, prototype keys, unknown keys, lone surrogates rejected
  assertEvolutionError(
    () => parseEvolutionCampaignDocument(VALID_CAMPAIGN_YAML.replace('noveltyDecayLambda: 1.0', 'noveltyDecayLambda: -0.0')),
    'EVOLUTION_SCHEMA_INVALID',
  );
  assertEvolutionError(
    () => parseEvolutionCampaignDocument(`${VALID_CAMPAIGN_YAML}  unknownExtraField: true\n`),
    'EVOLUTION_SCHEMA_INVALID',
  );
  assertEvolutionError(
    () => parseEvolutionCampaignDocument(VALID_CAMPAIGN_YAML.replace('flash-decode-sm90a', 'bad\uD800name')),
    'EVOLUTION_SCHEMA_INVALID',
  );
  assertEvolutionError(
    () => parseNullProtoJson('{"__proto__": {"polluted": true}}'),
    'EVOLUTION_SCHEMA_INVALID',
  );
  assertEvolutionError(
    () => parseNullProtoJson('{"value": -0}'),
    'EVOLUTION_SCHEMA_INVALID',
  );
  assertEvolutionError(
    () => parseNullProtoJson('{"dup": 1, "dup": 2}'),
    'EVOLUTION_SCHEMA_INVALID',
  );

  // Out-of-bounds population, sampling, teamEvolution, and budget fields rejected
  assertEvolutionError(
    () => parseEvolutionCampaignDocument(VALID_CAMPAIGN_YAML.replace('islands: 4', 'islands: 17')),
    'EVOLUTION_SCHEMA_INVALID',
  );
  assertEvolutionError(
    () => parseEvolutionCampaignDocument(VALID_CAMPAIGN_YAML.replace('edges: [0, 25, 50, 75, 100]', 'edges: [0, 50, 25, 100]')),
    'EVOLUTION_SCHEMA_INVALID',
  );
  assertEvolutionError(
    () => parseEvolutionCampaignDocument(VALID_CAMPAIGN_YAML.replace('maxCrossoversPerPrompt: 2', 'maxCrossoversPerPrompt: 5')),
    'EVOLUTION_SCHEMA_INVALID',
  );
  assertEvolutionError(
    () => parseEvolutionCampaignDocument(VALID_CAMPAIGN_YAML.replace('targetRooflineHeadroom: 1.08', 'targetRooflineHeadroom: 0.95')),
    'EVOLUTION_SCHEMA_INVALID',
  );
  assertEvolutionError(
    () => parseEvolutionCampaignDocument(VALID_CAMPAIGN_YAML.replace('outputDir: .loopwright-out/bundles/flash-decode-sm90a', 'outputDir: ../escape')),
    'EVOLUTION_SCHEMA_INVALID',
  );

  // File loading with O_NOFOLLOW rejects symlinks
  const tempDir = mkdtempSync(join(tmpdir(), 'evo-schema-test-'));
  try {
    const campaignPath = join(tempDir, 'campaign.yaml');
    const symlinkPath = join(tempDir, 'campaign-link.yaml');
    writeFileSync(campaignPath, VALID_CAMPAIGN_YAML, 'utf8');
    symlinkSync(campaignPath, symlinkPath);

    const loaded = await loadEvolutionCampaignFile(campaignPath);
    assert.equal(loaded.metadata.name, 'flash-decode-sm90a');
    await assertEvolutionErrorAsync(() => loadEvolutionCampaignFile(symlinkPath), 'EVOLUTION_SYMLINK_FORBIDDEN');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('schema: parseTeamPatchV1 validates DAG acyclicity, handoffs, diagnosis byte caps, and secrets', () => {
  const scrubber = new SecretScrubber();
  scrubber.register('super-secret-credential-9999');

  const validPatch = parseTeamPatchV1({
    kind: 'TeamPatch',
    schemaVersion: 'team-patch.v1',
    diagnosis: {
      summary: 'Optimizer conflates Roofline bank-conflict diagnosis with tile-size mutation.',
      plateauCategory: 'coupled_responsibilities',
      rationale: 'Splitting read-only Roofline diagnosis from sandboxed mutation isolates shared-memory layout analysis.',
    },
    roles: [
      {
        id: 'diag-probe',
        archetypeRoleId: 'probe-readonly',
        purpose: 'review',
        prompt: 'Analyze Stage B Roofline stall counters and propose tile layout changes.',
        tools: ['read'],
        timeoutSeconds: 120,
      },
      {
        id: 'kernel-mutator',
        archetypeRoleId: 'mutator-sandboxed',
        purpose: 'task',
        prompt: 'Apply the proposed shared-memory swizzle inside EVOLVE-BLOCK.',
        model: 'claude-sonnet-4-6',
        tools: ['read', 'edit'],
      },
    ],
    steps: [
      {
        id: 'analyze',
        roleId: 'diag-probe',
        dependsOn: [],
      },
      {
        id: 'mutate',
        roleId: 'kernel-mutator',
        dependsOn: ['analyze'],
        handoffs: [
          {
            id: 'diag-summary',
            fromStep: 'analyze',
            source: { kind: 'submission' },
            select: { kind: 'markdown_heading', heading: '## Tile Plan' },
          },
        ],
        onRework: {
          rejectTo: 'analyze',
          maxReworks: 2,
        },
      },
    ],
  }, { scrubber });

  assert.equal(Object.getPrototypeOf(validPatch), null);
  assert.equal(validPatch.roles.length, 2);
  assert.equal(validPatch.steps.length, 2);

  // Cycle in steps[] (A -> B -> A) rejected
  assertEvolutionError(
    () => parseTeamPatchV1({
      kind: 'TeamPatch',
      schemaVersion: 'team-patch.v1',
      diagnosis: {
        summary: 'Cycle test',
        plateauCategory: 'other',
        rationale: 'Cycle test rationale',
      },
      roles: [
        { id: 'r1', archetypeRoleId: 'probe-readonly', purpose: 'review', prompt: 'p1', tools: ['read'] },
      ],
      steps: [
        { id: 's1', roleId: 'r1', dependsOn: ['s2'] },
        { id: 's2', roleId: 'r1', dependsOn: ['s1'] },
      ],
    }),
    'EVOLUTION_SCHEMA_INVALID',
  );

  // Unknown roleId and non-ancestor handoff.fromStep rejected
  assertEvolutionError(
    () => parseTeamPatchV1({
      kind: 'TeamPatch',
      schemaVersion: 'team-patch.v1',
      diagnosis: {
        summary: 'Bad role ref',
        plateauCategory: 'other',
        rationale: 'Missing role',
      },
      roles: [
        { id: 'r1', archetypeRoleId: 'probe-readonly', purpose: 'review', prompt: 'p1', tools: ['read'] },
      ],
      steps: [
        { id: 's1', roleId: 'nonexistent', dependsOn: [] },
      ],
    }),
    'EVOLUTION_SCHEMA_INVALID',
  );

  assertEvolutionError(
    () => parseTeamPatchV1({
      kind: 'TeamPatch',
      schemaVersion: 'team-patch.v1',
      diagnosis: {
        summary: 'Bad handoff ancestor',
        plateauCategory: 'other',
        rationale: 'Parallel non-ancestor handoff',
      },
      roles: [
        { id: 'r1', archetypeRoleId: 'probe-readonly', purpose: 'review', prompt: 'p1', tools: ['read'] },
      ],
      steps: [
        { id: 's1', roleId: 'r1', dependsOn: [] },
        {
          id: 's2',
          roleId: 'r1',
          dependsOn: [],
          handoffs: [{ fromStep: 's1', source: { kind: 'submission' }, select: { kind: 'full' } }],
        },
      ],
    }),
    'EVOLUTION_SCHEMA_INVALID',
  );

  // Diagnosis > 4,096 bytes and total payload > 32,768 bytes rejected
  assertEvolutionError(
    () => parseTeamPatchV1({
      kind: 'TeamPatch',
      schemaVersion: 'team-patch.v1',
      diagnosis: {
        summary: 'x'.repeat(TEAM_PATCH_DIAGNOSIS_MAX_BYTES),
        plateauCategory: 'other',
        rationale: 'overflow',
      },
      roles: [{ id: 'r1', archetypeRoleId: 'probe-readonly', purpose: 'review', prompt: 'p1', tools: ['read'] }],
      steps: [{ id: 's1', roleId: 'r1', dependsOn: [] }],
    }),
    'EVOLUTION_SCHEMA_INVALID',
  );

  assertEvolutionError(
    () => parseTeamPatchV1(' '.repeat(TEAM_PATCH_MAX_BYTES + 10)),
    'EVOLUTION_SCHEMA_INVALID',
  );

  // Registered secret inside prompt or diagnosis rejected
  assertEvolutionError(
    () => parseTeamPatchV1({
      kind: 'TeamPatch',
      schemaVersion: 'team-patch.v1',
      diagnosis: {
        summary: 'Clean summary',
        plateauCategory: 'other',
        rationale: 'Leaked super-secret-credential-9999 in diagnosis',
      },
      roles: [{ id: 'r1', archetypeRoleId: 'probe-readonly', purpose: 'review', prompt: 'p1', tools: ['read'] }],
      steps: [{ id: 's1', roleId: 'r1', dependsOn: [] }],
    }, { scrubber }),
    'SECRET_LEAK_DETECTED',
  );
});

test('schema: parseDispatchManifestV1 enforces 1..64 rules and mandatory baseline fallback', () => {
  const digest = makeDigest('kernel-cubin-v1');
  const parsed = parseDispatchManifestV1({
    version: 1,
    fallback: 'baseline',
    rules: [
      {
        bucketId: 'bs1-isl4k',
        dimensionBounds: {
          batch_size: { min: 1, max: 4 },
          seq_len: { min: 1024, max: 4096 },
        },
        dtypes: ['fp16', 'bf16'],
        alignmentBytes: 16,
        blobDigest: digest,
        blobPath: `blobs/sha256/${digest.hex}`,
        entrypoint: 'flash_decode_bs1_sm90a',
      },
    ],
  });

  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.equal(parsed.fallback, 'baseline');
  assert.equal(parsed.rules.length, 1);
  assert.equal(parsed.rules[0]?.entrypoint, 'flash_decode_bs1_sm90a');

  // Missing or non-baseline fallback rejected
  assertEvolutionError(
    () => parseDispatchManifestV1({ version: 1, rules: parsed.rules }),
    'EVOLUTION_SCHEMA_INVALID',
  );
  assertEvolutionError(
    () => parseDispatchManifestV1({ version: 1, fallback: 'error', rules: parsed.rules }),
    'EVOLUTION_SCHEMA_INVALID',
  );

  // Empty rules or min > max rejected
  assertEvolutionError(
    () => parseDispatchManifestV1({ version: 1, fallback: 'baseline', rules: [] }),
    'EVOLUTION_SCHEMA_INVALID',
  );
  assertEvolutionError(
    () => parseDispatchManifestV1({
      version: 1,
      fallback: 'baseline',
      rules: [
        {
          bucketId: 'bs1-isl4k',
          dimensionBounds: { batch_size: { min: 8, max: 2 } },
          blobDigest: digest,
          entrypoint: 'flash_decode_bs1_sm90a',
        },
      ],
    }),
    'EVOLUTION_SCHEMA_INVALID',
  );
});

test('store: enforces O_NOFOLLOW symlinks, DELETE/FULL STRICT pragmas, lease fencing, 1000ms clock drift, team trial rollback, preemption accounting, and serialized concurrent writes', async () => {
  const stateSchemaBefore = expectedSchema();
  const baseTemp = mkdtempSync(join(tmpdir(), 'evo-store-test-'));

  try {
    // 1. Symlink campaignRoot rejected fail-closed with EVOLUTION_SYMLINK_FORBIDDEN
    const realRoot = join(baseTemp, 'real-campaign');
    const symlinkRoot = join(baseTemp, 'symlink-campaign');
    symlinkSync(realRoot, symlinkRoot);
    await assertEvolutionErrorAsync(
      () => EvolutionCampaignStore.open({ campaignRoot: symlinkRoot }),
      'EVOLUTION_SYMLINK_FORBIDDEN',
    );

    // 2. Controllable monotonic/wall clock
    let monoMs = 10_000;
    let wallMs = 1_700_000_000_000;
    const clock: CampaignClockSource = {
      nowMonotonicMs: () => monoMs,
      nowWallMs: () => wallMs,
    };
    const advanceClock = (deltaMono: number, deltaWall = deltaMono): void => {
      monoMs += deltaMono;
      wallMs += deltaWall;
    };

    const store = await EvolutionCampaignStore.open({ campaignRoot: realRoot, clock });
    try {
      const pragmas = await store.inspectPragmas();
      assert.equal(pragmas.journalMode, 'delete');
      assert.equal(pragmas.synchronous, 2); // FULL = 2
      assert.equal(pragmas.foreignKeys, 1);
      for (const requiredTable of [
        'campaign_meta',
        'campaigns',
        'islands',
        'team_configs',
        'individuals',
        'lineage_edges',
        'model_bandit_arms',
        'scratchpad_snapshots',
      ]) {
        assert.ok(pragmas.tables.includes(requiredTable), `missing STRICT table ${requiredTable}`);
      }

      // 3. Lease fencing
      advanceClock(50);
      const lease1 = await store.acquireLease('controller-1');
      assert.equal(lease1.fenceEpoch, 1);

      const manifest = parseEvolutionCampaignDocument(VALID_CAMPAIGN_YAML);
      advanceClock(25);
      const campaign = await store.createCampaign(lease1, {
        campaignId: 'camp-001',
        manifest,
        manifestDigest: makeDigest(VALID_CAMPAIGN_YAML),
        baseRevision: 'a'.repeat(40),
        lockHash: makeDigest('lock-001'),
        modelIds: ['claude-sonnet-4-6', 'gpt-5.4'],
      });
      assert.equal(campaign.evaluationsUsed, 0);
      assert.equal(campaign.preemptionsCount, 0);

      const islands = await store.listIslands('camp-001');
      assert.equal(islands.length, 4);
      const island0BaselineTeamId = islands[0]!.activeTeamConfigId;

      // Second lease immediately fences lease1
      advanceClock(25);
      const lease2 = await store.acquireLease('controller-2');
      assert.equal(lease2.fenceEpoch, 2);
      await assertEvolutionErrorAsync(
        () => store.updateCampaignProgress(lease1, { campaignId: 'camp-001', currentGeneration: 1 }),
        'EVOLUTION_LEASE_FENCED',
      );

      // 4.Foreign key enforcement on individuals.team_config_id
      advanceClock(10);
      await assertEvolutionErrorAsync(
        () => store.recordIndividual(lease2, {
          individualId: 'ind-bad-fk',
          campaignId: 'camp-001',
          islandId: 0,
          generation: 0,
          bucketId: 'bs1-isl4k',
          teamConfigId: 'nonexistent-team-id',
          modelId: 'claude-sonnet-4-6',
          trackId: 'cuda_raw',
          mutationKind: 'baseline',
          status: 'passed',
          failureReason: null,
          nicheKey: 'bound_pipeline=hbm|occupancy_band=[50,75)',
          paretoRank: 1,
          crowdingDistance: Number.POSITIVE_INFINITY,
          scalarFitness: 0.5,
          codeSliceCasDigest: makeDigest('code-0'),
          evidenceDigest: makeDigest('ev-0'),
          verdictReceiptCasDigest: makeDigest('verdict-0'),
          outputArtifacts: [],
          metrics: { latency_us_p50: 120, goodput_rps: 900, peak_mem_bytes: 4096 },
        }),
        'EVOLUTION_STORE_ERROR',
      );

      // 5. Team trial promotion vs auto-rollback + preemption non-consumption
      advanceClock(10);
      const trialTeam1 = await store.createTrialTeamConfig(lease2, {
        teamConfigId: 'team-trial-1',
        campaignId: 'camp-001',
        islandId: 0,
        parentTeamConfigId: island0BaselineTeamId,
        createdGeneration: 4,
        trialBudgetGenerations: 2,
        diagnosis: {
          summary: 'Stalled on HBM bandwidth',
          plateauCategory: 'resource_spill_trap',
          rationale: 'Separate spill auditor from mutator',
        },
        patchCasDigest: makeDigest('patch-1'),
      });
      assert.equal(trialTeam1.status, 'trial');
      assert.equal((await store.getIsland('camp-001', 0))?.activeTeamConfigId, 'team-trial-1');

      // Preempted generation must NOT consume trial_used_generations
      advanceClock(10);
      const afterPreemptTrial = await store.recordTeamTrialGeneration(lease2, {
        teamConfigId: 'team-trial-1',
        advancedPareto: false,
        discoveredNiche: false,
        preempted: true,
      });
      assert.equal(afterPreemptTrial.trialUsedGenerations, 0);
      assert.equal(afterPreemptTrial.status, 'trial');

      // Two non-advancing generations auto-roll back to baseline team
      advanceClock(10);
      const gen1Trial = await store.recordTeamTrialGeneration(lease2, {
        teamConfigId: 'team-trial-1',
        advancedPareto: false,
        discoveredNiche: false,
      });
      assert.equal(gen1Trial.trialUsedGenerations, 1);
      assert.equal(gen1Trial.status, 'trial');

      advanceClock(10);
      const gen2Trial = await store.recordTeamTrialGeneration(lease2, {
        teamConfigId: 'team-trial-1',
        advancedPareto: false,
        discoveredNiche: false,
      });
      assert.equal(gen2Trial.trialUsedGenerations, 2);
      assert.equal(gen2Trial.status, 'rolled_back');
      assert.equal((await store.getIsland('camp-001', 0))?.activeTeamConfigId, island0BaselineTeamId);

      // Trial team that advances Pareto promotes immediately
      advanceClock(10);
      await store.createTrialTeamConfig(lease2, {
        teamConfigId: 'team-trial-2',
        campaignId: 'camp-001',
        islandId: 1,
        parentTeamConfigId: islands[1]!.activeTeamConfigId,
        createdGeneration: 5,
        trialBudgetGenerations: 2,
        diagnosis: {
          summary: 'Coupled concerns',
          plateauCategory: 'coupled_responsibilities',
          rationale: 'Split probe and mutator',
        },
        patchCasDigest: makeDigest('patch-2'),
      });
      advanceClock(10);
      const promoted = await store.recordTeamTrialGeneration(lease2, {
        teamConfigId: 'team-trial-2',
        advancedPareto: true,
        discoveredNiche: true,
      });
      assert.equal(promoted.status, 'promoted');
      assert.equal(promoted.paretoAdvances, 1);
      assert.equal(promoted.nicheDiscoveries, 1);
      assert.equal((await store.getIsland('camp-001', 1))?.activeTeamConfigId, 'team-trial-2');

      // 6. Concurrent serialized writes via enqueue (16 parallel operations + preemptions)
      advanceClock(20);
      await store.recordIndividual(lease2, {
        individualId: 'ind-seed-0',
        campaignId: 'camp-001',
        islandId: 0,
        generation: 0,
        bucketId: 'bs1-isl4k',
        teamConfigId: island0BaselineTeamId,
        modelId: 'claude-sonnet-4-6',
        trackId: 'cuda_raw',
        mutationKind: 'baseline',
        status: 'passed',
        failureReason: null,
        nicheKey: 'bound_pipeline=hbm|occupancy_band=[25,50)',
        paretoRank: 1,
        crowdingDistance: Number.POSITIVE_INFINITY,
        scalarFitness: 0.4,
        countEvaluation: false,
        codeSliceCasDigest: makeDigest('seed-slice'),
        evidenceDigest: makeDigest('seed-ev'),
        verdictReceiptCasDigest: makeDigest('seed-verdict'),
        outputArtifacts: [],
        metrics: { latency_us_p50: 100, goodput_rps: 1000, peak_mem_bytes: 2048 },
      });

      const concurrentTasks = Array.from({ length: 16 }, (_, idx) => {
        const isPreempted = idx % 5 === 0; // idx = 0, 5, 10, 15 -> 4 preempted (1 per island), 12 counted evaluations
        return store.recordIndividual(lease2, {
          individualId: `ind-conc-${idx}`,
          campaignId: 'camp-001',
          islandId: idx % 4,
          generation: 1,
          bucketId: 'bs1-isl4k',
          teamConfigId: islands[idx % 4]!.activeTeamConfigId === 'team-trial-2' && idx % 4 === 1
            ? 'team-trial-2'
            : islands[idx % 4]!.activeTeamConfigId,
          modelId: idx % 2 === 0 ? 'claude-sonnet-4-6' : 'gpt-5.4',
          trackId: 'triton',
          mutationKind: 'diff_tune',
          status: isPreempted ? 'preempted' : 'passed',
          failureReason: isPreempted ? 'BENCHMARK_PREEMPTED' : null,
          nicheKey: isPreempted ? null : `bound_pipeline=tensor_cube|occupancy_band=[50,75)`,
          paretoRank: isPreempted ? null : 1,
          crowdingDistance: isPreempted ? null : 0.75,
          scalarFitness: isPreempted ? null : 0.5 + idx * 0.01,
          codeSliceCasDigest: makeDigest(`slice-${idx}`),
          evidenceDigest: isPreempted ? null : makeDigest(`ev-${idx}`),
          verdictReceiptCasDigest: isPreempted ? null : makeDigest(`verdict-${idx}`),
          outputArtifacts: [],
          metrics: { latency_us_p50: 95 - idx, goodput_rps: 1050 + idx * 10, peak_mem_bytes: 2048 },
          lineageEdges: [
            {
              campaignId: 'camp-001',
              childIndividualId: `ind-conc-${idx}`,
              parentIndividualId: 'ind-seed-0',
              role: 'primary',
              sourceIslandId: 0,
              createdGeneration: 1,
            },
          ],
        });
      });

      await Promise.all(concurrentTasks);

      const updatedCampaign = await store.getCampaign('camp-001');
      assert.equal(updatedCampaign?.evaluationsUsed, 12);
      assert.equal(updatedCampaign?.preemptionsCount, 4);

      const island0Elites = await store.getIslandNicheElites('camp-001', 0, 'bs1-isl4k');
      assert.equal(island0Elites.size, 2);
      assert.equal(
        island0Elites.get('bound_pipeline=tensor_cube|occupancy_band=[50,75)')?.individualId,
        'ind-conc-12',
      );
      const seedReloaded = await store.getIndividual('ind-seed-0');
      assert.equal(seedReloaded?.crowdingDistance, Number.POSITIVE_INFINITY);

      // 7. Clock drift > 1,000ms rejected fail-closed with EVOLUTION_CLOCK_DRIFT
      advanceClock(100, 1_250); // +1,150ms drift (> 1,000ms limit)
      await assertEvolutionErrorAsync(
        () => store.updateCampaignProgress(lease2, { campaignId: 'camp-001', currentGeneration: 2 }),
        'EVOLUTION_CLOCK_DRIFT',
      );
    } finally {
      await store.close();
    }

    // 8. Reopening existing store after process stop/resume works when monotonic+wall advance, and rejects regressed clocks
    const reopened = await EvolutionCampaignStore.open({
      campaignRoot: realRoot,
      createIfMissing: false,
      clock: {
        nowMonotonicMs: () => monoMs + 5_000,
        nowWallMs: () => wallMs + 30_000,
      },
    });
    const resumedCampaign = await reopened.getCampaign('camp-001');
    assert.equal(resumedCampaign?.evaluationsUsed, 12);
    assert.equal(resumedCampaign?.preemptionsCount, 4);
    await reopened.close();

    await assertEvolutionErrorAsync(
      () => EvolutionCampaignStore.open({
        campaignRoot: realRoot,
        createIfMissing: false,
        clock: {
          nowMonotonicMs: () => 500, // Regressed behind persisted last_monotonic_ms
          nowWallMs: () => wallMs + 30_000,
        },
      }),
      'EVOLUTION_CLOCK_DRIFT',
    );

    // 8. Symlink campaign.sqlite rejected on reopen
    const symlinkDbDir = join(baseTemp, 'symlink-db-campaign');
    const store2 = await EvolutionCampaignStore.open({ campaignRoot: symlinkDbDir });
    await store2.close();
    rmSync(join(symlinkDbDir, 'campaign.sqlite'));
    symlinkSync(join(realRoot, 'campaign.sqlite'), join(symlinkDbDir, 'campaign.sqlite'));
    await assertEvolutionErrorAsync(
      () => EvolutionCampaignStore.open({ campaignRoot: symlinkDbDir }),
      'EVOLUTION_SYMLINK_FORBIDDEN',
    );
  } finally {
    rmSync(baseTemp, { recursive: true, force: true });
  }

  // Verify @loopwright/state schema digest is byte-for-byte untouched
  assert.equal(expectedSchema(), stateSchemaBefore);
});
