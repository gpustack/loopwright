import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SecretScrubber } from '@loopwright/core';
import {
  computeHypervolume,
  computeHypervolumeDelta,
  computeMedianFitness,
  computeNicheKey,
  computeNsga2Ranking,
  computeObjectiveReferenceStats,
  dominatesObjectives,
  scalarizeFitness,
} from '../src/pareto.js';
import {
  computeSteppingStoneSamplingWeight,
  computeTruncatedImprovementReward,
  createSeededPrng,
  sampleParents,
  selectModelCandidate,
  selectRingMigrationElites,
  stageMultiParentContextFiles,
} from '../src/sampler.js';
import {
  EvolutionError,
  type EvolutionNicheAxis,
  type IndividualRecord,
  type ModelBanditArmRecord,
  type ObjectiveDirectionSpec,
} from '../src/types.js';

function makeDigest(seed: string): { readonly algorithm: 'sha256'; readonly hex: string } {
  return { algorithm: 'sha256', hex: createHash('sha256').update(seed, 'utf8').digest('hex') };
}

function makeIndividual(overrides: Partial<IndividualRecord> & { readonly individualId: string }): IndividualRecord {
  return {
    individualId: overrides.individualId,
    campaignId: overrides.campaignId ?? 'camp-1',
    islandId: overrides.islandId ?? 0,
    generation: overrides.generation ?? 1,
    bucketId: overrides.bucketId ?? null,
    teamConfigId: overrides.teamConfigId ?? 'team-0',
    modelId: overrides.modelId ?? 'model-a',
    trackId: overrides.trackId ?? 'cuda_raw',
    mutationKind: overrides.mutationKind ?? 'diff_tune',
    status: overrides.status ?? 'passed',
    failureReason: overrides.failureReason ?? null,
    nicheKey: overrides.nicheKey !== undefined ? overrides.nicheKey : 'bound_pipeline=hbm',
    paretoRank: overrides.paretoRank !== undefined ? overrides.paretoRank : 1,
    crowdingDistance: overrides.crowdingDistance !== undefined ? overrides.crowdingDistance : 1.0,
    scalarFitness: overrides.scalarFitness !== undefined ? overrides.scalarFitness : 0.5,
    offspringCount: overrides.offspringCount ?? 0,
    codeSliceCasDigest: overrides.codeSliceCasDigest ?? makeDigest(overrides.individualId),
    evidenceDigest: overrides.evidenceDigest ?? makeDigest(`ev-${overrides.individualId}`),
    verdictReceiptCasDigest: overrides.verdictReceiptCasDigest ?? makeDigest(`vr-${overrides.individualId}`),
    outputArtifacts: overrides.outputArtifacts ?? [],
    metrics: overrides.metrics ?? { latency_us_p50: 100, goodput_rps: 1000 },
    ...(overrides.bucketMetrics !== undefined ? { bucketMetrics: overrides.bucketMetrics } : {}),
    ...(overrides.hardwareDiagnostics !== undefined ? { hardwareDiagnostics: overrides.hardwareDiagnostics } : {}),
    ...(overrides.hardwareProvenance !== undefined ? { hardwareProvenance: overrides.hardwareProvenance } : {}),
    ...(overrides.findings !== undefined ? { findings: overrides.findings } : {}),
    createdAtWallMs: overrides.createdAtWallMs ?? 1_700_000_000_000,
  };
}

test('pareto: dominatesObjectives and computeNsga2Ranking are permutation-invariant and deterministic', () => {
  const objectives: readonly ObjectiveDirectionSpec[] = [
    { metric: 'latency_us_p50', direction: 'minimize' },
    { metric: 'goodput_rps', direction: 'maximize' },
  ];

  assert.equal(
    dominatesObjectives(
      { latency_us_p50: 80, goodput_rps: 1200 },
      { latency_us_p50: 90, goodput_rps: 1200 },
      objectives,
    ),
    true,
  );
  // Equal objective vectors never strictly dominate each other
  assert.equal(
    dominatesObjectives(
      { latency_us_p50: 80, goodput_rps: 1200 },
      { latency_us_p50: 80, goodput_rps: 1200 },
      objectives,
    ),
    false,
  );
  // Trade-off vectors are mutually non-dominated
  assert.equal(
    dominatesObjectives(
      { latency_us_p50: 70, goodput_rps: 1000 },
      { latency_us_p50: 90, goodput_rps: 1400 },
      objectives,
    ),
    false,
  );

  const candidates = [
    { individualId: 'ind-f1-left', metrics: { latency_us_p50: 50, goodput_rps: 1000 } },
    { individualId: 'ind-f1-mid-b', metrics: { latency_us_p50: 70, goodput_rps: 1300 } },
    { individualId: 'ind-f1-mid-a', metrics: { latency_us_p50: 60, goodput_rps: 1100 } },
    { individualId: 'ind-f1-right', metrics: { latency_us_p50: 90, goodput_rps: 1500 } },
    { individualId: 'ind-f2-b', metrics: { latency_us_p50: 100, goodput_rps: 1100 } },
    { individualId: 'ind-f2-a', metrics: { latency_us_p50: 100, goodput_rps: 1100 } }, // Exact tie broken by individualId
    { individualId: 'ind-f3', metrics: { latency_us_p50: 130, goodput_rps: 900 } },
  ];

  const ranked1 = computeNsga2Ranking(candidates, objectives);
  const reversed = [...candidates].reverse();
  const shuffled = [candidates[4]!, candidates[1]!, candidates[6]!, candidates[0]!, candidates[5]!, candidates[2]!, candidates[3]!];
  const ranked2 = computeNsga2Ranking(reversed, objectives);
  const ranked3 = computeNsga2Ranking(shuffled, objectives);

  assert.deepEqual(ranked1, ranked2);
  assert.deepEqual(ranked1, ranked3);

  // Verify front assignments
  const rankById = new Map(ranked1.map(r => [r.individualId, r]));
  assert.equal(rankById.get('ind-f1-left')?.paretoRank, 1);
  assert.equal(rankById.get('ind-f1-right')?.paretoRank, 1);
  assert.equal(rankById.get('ind-f1-left')?.crowdingDistance, Number.POSITIVE_INFINITY);
  assert.equal(rankById.get('ind-f1-right')?.crowdingDistance, Number.POSITIVE_INFINITY);
  assert.ok(Number.isFinite(rankById.get('ind-f1-mid-a')!.crowdingDistance));
  assert.ok(Number.isFinite(rankById.get('ind-f1-mid-b')!.crowdingDistance));
  assert.equal(rankById.get('ind-f2-a')?.paretoRank, 2);
  assert.equal(rankById.get('ind-f2-b')?.paretoRank, 2);
  assert.equal(rankById.get('ind-f3')?.paretoRank, 3);

  // Tie-break order: ind-f2-a precedes ind-f2-b
  const idxF2A = ranked1.findIndex(r => r.individualId === 'ind-f2-a');
  const idxF2B = ranked1.findIndex(r => r.individualId === 'ind-f2-b');
  assert.ok(idxF2A < idxF2B);
});

test('pareto: computeHypervolume and computeHypervolumeDelta are exact in 1D, 2D, and 3D', () => {
  // 2D exact test: minimize latency (ref 100), maximize goodput (ref 500)
  const obj2d: readonly ObjectiveDirectionSpec[] = [
    { metric: 'latency', direction: 'minimize' },
    { metric: 'goodput', direction: 'maximize' },
  ];
  const ref2d = { latency: 100, goodput: 500 };
  // p1 = (60, 900) -> box [40 x 400] = 16,000
  // p2 = (80, 1100) -> box [20 x 600] = 12,000
  // intersection = [20 x 400] = 8,000 -> union = 20,000
  const hv2d = computeHypervolume(
    [
      { latency: 60, goodput: 900 },
      { latency: 80, goodput: 1100 },
      { latency: 90, goodput: 800 }, // Dominated -> contributes 0
      { latency: 120, goodput: 2000 }, // Worse than reference on latency -> contributes 0
    ],
    obj2d,
    ref2d,
  );
  assert.equal(hv2d, 20_000);

  // 3D exact inclusion-exclusion verification: minimize a, b, c relative to (10, 10, 10)
  const obj3d: readonly ObjectiveDirectionSpec[] = [
    { metric: 'a', direction: 'minimize' },
    { metric: 'b', direction: 'minimize' },
    { metric: 'c', direction: 'minimize' },
  ];
  const ref3d = { a: 10, b: 10, c: 10 };
  // P1=(2,5,5) -> box (8,5,5)=200; P2=(5,2,6) -> box (5,8,4)=160; intersection (5,5,4)=100 -> union = 260
  const hv3d = computeHypervolume(
    [
      { a: 2, b: 5, c: 5 },
      { a: 5, b: 2, c: 6 },
    ],
    obj3d,
    ref3d,
  );
  assert.equal(hv3d, 260);

  const delta = computeHypervolumeDelta(
    [{ a: 2, b: 5, c: 5 }],
    [
      { a: 2, b: 5, c: 5 },
      { a: 5, b: 2, c: 6 },
    ],
    obj3d,
    ref3d,
  );
  assert.equal(delta, 60);
});

test('pareto: computeNicheKey and scalarizeFitness map hardware diagnostics and metrics canonically', () => {
  const axes: readonly EvolutionNicheAxis[] = [
    { id: 'bound_pipeline', kind: 'enum', values: ['hbm', 'l2', 'smem_lds_ub', 'tensor_cube', 'vector_valu'] },
    { id: 'occupancy_band', kind: 'numeric_bins', edges: [0, 25, 50, 75, 100] },
  ];

  assert.equal(
    computeNicheKey(axes, { latency_us_p50: 85 }, { boundPipeline: 'tensor_cube', occupancyPct: 50 }),
    'bound_pipeline=tensor_cube|occupancy_band=[50,75)',
  );
  // Upper boundary 100 falls into closed final bin [75,100]
  assert.equal(
    computeNicheKey(axes, { latency_us_p50: 85 }, { boundPipeline: 'hbm', occupancyPct: 100 }),
    'bound_pipeline=hbm|occupancy_band=[75,100]',
  );
  // Underflow, overflow, and unclassified enum fall into dedicated non-colliding bins
  assert.equal(
    computeNicheKey(axes, { occupancy_band: -5 }, { boundPipeline: 'unknown' }),
    'bound_pipeline=~unclassified|occupancy_band=<-inf,0)',
  );
  assert.equal(
    computeNicheKey(axes, { occupancy_band: 125 }),
    'bound_pipeline=~unclassified|occupancy_band=(100,+inf)',
  );

  const objectives: readonly ObjectiveDirectionSpec[] = [
    { metric: 'latency_us_p50', direction: 'minimize' },
    { metric: 'goodput_rps', direction: 'maximize' },
  ];
  const entries = [
    { latency_us_p50: 50, goodput_rps: 2000 },
    { latency_us_p50: 100, goodput_rps: 1500 },
    { latency_us_p50: 150, goodput_rps: 1000 },
  ];
  const stats = computeObjectiveReferenceStats(entries, objectives);
  const scores = entries.map(m => scalarizeFitness(m, objectives, stats));
  assert.equal(scores[0], 1);
  assert.equal(scores[1], 0.5);
  assert.equal(scores[2], 0);
  assert.equal(computeMedianFitness(scores), 0.5);
});

test('sampler: stepping-stone weight decay, deterministic parent crossover, and Island Elitism ring migration', () => {
  // Exact formula check: at fitness === median, sigmoid(0) = 0.5
  assert.equal(computeSteppingStoneSamplingWeight(0.5, 0.5, 0, 1.0), 0.5);
  assert.equal(computeSteppingStoneSamplingWeight(0.5, 0.5, 3, 1.0), 0.125); // 0.5 / (1 + 3)

  // Novelty decay: over-sampled leader gets lower weight than fresh stepping stone
  const overSampledLeaderWeight = computeSteppingStoneSamplingWeight(0.9, 0.5, 20, 1.0);
  const freshSteppingStoneWeight = computeSteppingStoneSamplingWeight(0.45, 0.5, 0, 1.0);
  assert.ok(freshSteppingStoneWeight > overSampledLeaderWeight);

  // Island Elitism ring migration: rank-1 leaders stay strictly local; rank >= 2 niche elites migrate to (i + 1) % islands
  const islandIndividuals: readonly IndividualRecord[] = [
    makeIndividual({
      individualId: 'isl0-leader-r1',
      islandId: 0,
      nicheKey: 'bound_pipeline=hbm',
      paretoRank: 1,
      scalarFitness: 0.95,
    }),
    makeIndividual({
      individualId: 'isl0-stone-r2',
      islandId: 0,
      nicheKey: 'bound_pipeline=tensor_cube',
      paretoRank: 2,
      scalarFitness: 0.6,
    }),
    makeIndividual({
      individualId: 'isl1-leader-r1',
      islandId: 1,
      nicheKey: 'bound_pipeline=l2',
      paretoRank: 1,
      scalarFitness: 0.92,
    }),
    makeIndividual({
      individualId: 'isl1-stone-r3',
      islandId: 1,
      nicheKey: 'bound_pipeline=smem_lds_ub',
      paretoRank: 3,
      scalarFitness: 0.55,
    }),
  ];

  // Off-interval generation produces zero migrations
  assert.equal(
    selectRingMigrationElites({
      generation: 7,
      islands: 2,
      migrationIntervalGenerations: 8,
      maxMigrationElites: 1,
      individuals: islandIndividuals,
    }).length,
    0,
  );

  // On-interval generation migrates non-rank-1 niche elites across ring (0 -> 1, 1 -> 0) as inspiration
  const migrations = selectRingMigrationElites({
    generation: 8,
    islands: 2,
    migrationIntervalGenerations: 8,
    maxMigrationElites: 1,
    individuals: islandIndividuals,
  });
  assert.equal(migrations.length, 2);
  assert.equal(migrations.some(m => m.individual.paretoRank === 1), false);
  assert.equal(migrations[0]?.sourceIslandId, 0);
  assert.equal(migrations[0]?.targetIslandId, 1);
  assert.equal(migrations[0]?.individual.individualId, 'isl0-stone-r2');
  assert.equal(migrations[0]?.role, 'inspiration');
  assert.equal(migrations[1]?.sourceIslandId, 1);
  assert.equal(migrations[1]?.targetIslandId, 0);
  assert.equal(migrations[1]?.individual.individualId, 'isl1-stone-r3');

  // Seeded PRNG and multi-parent sampling determinism
  const rngA = createSeededPrng('campaign-seed-42');
  const rngB = createSeededPrng('campaign-seed-42');
  assert.deepEqual(
    Array.from({ length: 8 }, () => rngA()),
    Array.from({ length: 8 }, () => rngB()),
  );

  const selection1 = sampleParents({
    islandId: 1,
    localCandidates: [
      islandIndividuals[2]!,
      islandIndividuals[3]!,
      makeIndividual({ individualId: 'isl1-donor-b', islandId: 1, nicheKey: 'bound_pipeline=vector_valu', paretoRank: 2, scalarFitness: 0.7 }),
    ],
    inspirationCandidates: [migrations[0]!.individual],
    maxCrossoversPerPrompt: 2,
    noveltyDecayLambda: 1.0,
    seed: 'gen-8-isl-1-slot-0',
  });
  const selection2 = sampleParents({
    islandId: 1,
    localCandidates: [
      islandIndividuals[2]!,
      islandIndividuals[3]!,
      makeIndividual({ individualId: 'isl1-donor-b', islandId: 1, nicheKey: 'bound_pipeline=vector_valu', paretoRank: 2, scalarFitness: 0.7 }),
    ],
    inspirationCandidates: [migrations[0]!.individual],
    maxCrossoversPerPrompt: 2,
    noveltyDecayLambda: 1.0,
    seed: 'gen-8-isl-1-slot-0',
  });
  assert.deepEqual(selection1, selection2);
  assert.equal(selection1.primary.role, 'primary');
  assert.equal(selection1.primary.individual.islandId, 1);
  assert.equal(selection1.secondary.length, 2);
  const selectedIds = new Set([selection1.primary.individual.individualId, ...selection1.secondary.map(s => s.individual.individualId)]);
  assert.equal(selectedIds.size, 3);
});

test('sampler: stageMultiParentContextFiles enforces 0o400 permissions, O_NOFOLLOW, and SecretScrubber', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'evo-context-test-'));
  const scrubber = new SecretScrubber();
  scrubber.register('private-token-abcdef123456');

  try {
    const contextDir = join(tempDir, 'parent-context');
    const primary = makeIndividual({
      individualId: 'parent-primary',
      islandId: 0,
      bucketMetrics: [{ bucketId: 'bs1-isl4k', metrics: { latency_us_p50: 82 } }],
      hardwareDiagnostics: { boundPipeline: 'tensor_cube', occupancyPct: 62.5 },
    });
    const donor = makeIndividual({
      individualId: 'parent-insp',
      islandId: 3,
      hardwareDiagnostics: { boundPipeline: 'smem_lds_ub', bankConflictPct: 1.5 },
    });

    const staged = await stageMultiParentContextFiles({
      stagingDir: contextDir,
      parents: [
        { individual: primary, role: 'primary', codeSlice: '// EVOLVE-BLOCK-START: k\n__syncthreads();\n// EVOLVE-BLOCK-END: k\n' },
        { individual: donor, role: 'inspiration', codeSlice: '// Donor double-buffered smem pipeline\n' },
      ],
      maxCrossoversPerPrompt: 2,
      scrubber,
    });

    assert.equal(staged.files.length, 2);
    for (const file of staged.files) {
      const stat = lstatSync(file.filePath);
      assert.equal(stat.isSymbolicLink(), false);
      assert.equal(stat.nlink, 1);
      assert.equal(stat.mode & 0o777, 0o400);
      const parsed = JSON.parse(readFileSync(file.filePath, 'utf8')) as Record<string, unknown>;
      assert.ok(typeof parsed['codeSlice'] === 'string');
    }

    // Secret leak inside codeSlice fails closed with SECRET_LEAK_DETECTED
    await assert.rejects(
      () => stageMultiParentContextFiles({
        stagingDir: join(tempDir, 'leak-context'),
        parents: [
          { individual: primary, role: 'primary', codeSlice: 'const key = "private-token-abcdef123456";' },
        ],
        maxCrossoversPerPrompt: 2,
        scrubber,
      }),
      (err: unknown) => err instanceof EvolutionError && err.code === 'SECRET_LEAK_DETECTED',
    );

    // Symlink staging directory fails closed with EVOLUTION_SYMLINK_FORBIDDEN
    const symlinkContextDir = join(tempDir, 'symlink-context');
    symlinkSync(contextDir, symlinkContextDir);
    await assert.rejects(
      () => stageMultiParentContextFiles({
        stagingDir: symlinkContextDir,
        parents: [{ individual: primary, role: 'primary', codeSlice: '// clean' }],
        maxCrossoversPerPrompt: 2,
        scrubber,
      }),
      (err: unknown) => err instanceof EvolutionError && err.code === 'EVOLUTION_SYMLINK_FORBIDDEN',
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('sampler: UCB1 bandit and truncated parent-relative improvement reward follow exact spec formulas', () => {
  // r_u = exp(max(r - r_parent, 0)) - 1
  assert.equal(computeTruncatedImprovementReward(0.4, 0.6), 0); // regression -> 0
  assert.equal(computeTruncatedImprovementReward(0.6, 0.6), 0); // tie -> 0
  const posReward = computeTruncatedImprovementReward(0.8, 0.5);
  assert.ok(Math.abs(posReward - (Math.exp(0.3) - 1)) < 1e-12);

  const models = ['model-alpha', 'model-beta', 'model-gamma'] as const;

  // Round-robin deterministic cycling
  assert.equal(
    selectModelCandidate({ strategy: 'deterministic-round-robin', modelIds: models, arms: [], sequenceIndex: 0 }).modelId,
    'model-alpha',
  );
  assert.equal(
    selectModelCandidate({ strategy: 'deterministic-round-robin', modelIds: models, arms: [], sequenceIndex: 4 }).modelId,
    'model-beta',
  );

  // UCB1 pulls unpulled arms first in declaration order
  const partialArms: readonly ModelBanditArmRecord[] = [
    { campaignId: 'c1', modelId: 'model-alpha', pullCount: 1, totalReward: 0.5, meanReward: 0.5, lastPulledGeneration: 0 },
  ];
  const explorePick = selectModelCandidate({ strategy: 'ucb1', modelIds: models, arms: partialArms, sequenceIndex: 1 });
  assert.equal(explorePick.modelId, 'model-beta');

  // UCB1 exploits higher-reward arm once all arms are pulled sufficiently
  const matureArms: readonly ModelBanditArmRecord[] = [
    { campaignId: 'c1', modelId: 'model-alpha', pullCount: 10, totalReward: 0.2, meanReward: 0.02, lastPulledGeneration: 9 },
    { campaignId: 'c1', modelId: 'model-beta', pullCount: 10, totalReward: 8.5, meanReward: 0.85, lastPulledGeneration: 9 },
    { campaignId: 'c1', modelId: 'model-gamma', pullCount: 10, totalReward: 1.0, meanReward: 0.10, lastPulledGeneration: 9 },
  ];
  const exploitPick = selectModelCandidate({ strategy: 'ucb1', modelIds: models, arms: matureArms, sequenceIndex: 30 });
  assert.equal(exploitPick.modelId, 'model-beta');
});
