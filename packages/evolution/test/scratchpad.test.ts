import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SecretScrubber } from '@loopwright/core';
import { parseEvolutionCampaignDocument } from '../src/schema.js';
import { synthesizeCampaignScratchpad } from '../src/scratchpad.js';
import { EvolutionCampaignStore } from '../src/store.js';
import { EvolutionError, SCRATCHPAD_MAX_BYTES } from '../src/types.js';

function makeDigest(seed: string): { readonly algorithm: 'sha256'; readonly hex: string } {
  return { algorithm: 'sha256', hex: createHash('sha256').update(seed, 'utf8').digest('hex') };
}

const CAMPAIGN_YAML = `apiVersion: loopwright.dev/v1alpha1
kind: EvolutionCampaign
metadata:
  name: scratchpad-campaign
spec:
  taskpack: .loopwright/taskpack.yaml
  targetCellId: cuda-h100-whole
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
    maxCrossoversPerPrompt: 2
  objectives:
    - metric: latency_us_p50
      direction: minimize
    - metric: goodput_rps
      direction: maximize
  budgets:
    maxGenerations: 20
    maxEvaluations: 200
    maxConcurrentEvaluations: 2
    scratchpadIntervalGenerations: 5
`;

test('scratchpad: synthesizes deterministic <= 16 KiB CAS snapshot with speedup deltas, boundPipeline shifts, failure patterns, 0o400 permissions, and secret scrubbing', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'evo-scratchpad-test-'));
  const scrubber = new SecretScrubber();
  scrubber.register('custom-api-secret-xyz987654');

  try {
    const campaignRoot = join(tempDir, 'campaign');
    const store = await EvolutionCampaignStore.open({ campaignRoot });
    try {
      const lease = await store.acquireLease('scratchpad-owner');
      const manifest = parseEvolutionCampaignDocument(CAMPAIGN_YAML);
      await store.createCampaign(lease, {
        campaignId: 'camp-sp',
        manifest,
        manifestDigest: makeDigest(CAMPAIGN_YAML),
        baseRevision: 'b'.repeat(40),
        lockHash: makeDigest('lock-sp'),
        modelIds: ['claude-sonnet-4-6'],
      });

      const islands = await store.listIslands('camp-sp');
      const team0 = islands[0]!.activeTeamConfigId;

      // Seed baseline individual (HBM-bound, 120us)
      await store.recordIndividual(lease, {
        individualId: 'ind-base',
        campaignId: 'camp-sp',
        islandId: 0,
        generation: 0,
        bucketId: null,
        teamConfigId: team0,
        modelId: 'claude-sonnet-4-6',
        trackId: 'cuda_raw',
        mutationKind: 'baseline',
        status: 'passed',
        failureReason: null,
        nicheKey: 'bound_pipeline=hbm',
        paretoRank: 2,
        crowdingDistance: 1.0,
        scalarFitness: 0.4,
        countEvaluation: false,
        codeSliceCasDigest: makeDigest('base-code'),
        evidenceDigest: makeDigest('base-ev'),
        verdictReceiptCasDigest: makeDigest('base-vr'),
        outputArtifacts: [],
        metrics: { latency_us_p50: 120, goodput_rps: 800 },
        hardwareDiagnostics: { boundPipeline: 'hbm', occupancyPct: 40, localSpillBytes: 0 },
      });

      // Advancing child (shifts hbm -> tensor_cube, 120us -> 60us = 2.00x speedup!)
      await store.recordIndividual(lease, {
        individualId: 'ind-fast',
        campaignId: 'camp-sp',
        islandId: 0,
        generation: 1,
        bucketId: null,
        teamConfigId: team0,
        modelId: 'claude-sonnet-4-6',
        trackId: 'cute',
        mutationKind: 'full_rewrite',
        status: 'passed',
        failureReason: null,
        nicheKey: 'bound_pipeline=tensor_cube',
        paretoRank: 1,
        crowdingDistance: Number.POSITIVE_INFINITY,
        scalarFitness: 0.95,
        codeSliceCasDigest: makeDigest('fast-code'),
        evidenceDigest: makeDigest('fast-ev'),
        verdictReceiptCasDigest: makeDigest('fast-vr'),
        outputArtifacts: [],
        metrics: { latency_us_p50: 60, goodput_rps: 1600 },
        hardwareDiagnostics: { boundPipeline: 'tensor_cube', occupancyPct: 65, localSpillBytes: 0 },
        lineageEdges: [
          {
            campaignId: 'camp-sp',
            childIndividualId: 'ind-fast',
            parentIndividualId: 'ind-base',
            role: 'primary',
            sourceIslandId: 0,
            createdGeneration: 1,
          },
        ],
      });

      // Populate recurring failure patterns (including secret strings and verbose payload to stress 16 KiB cap)
      for (let i = 0; i < 45; i++) {
        const reason = i % 3 === 0
          ? 'STAGE_A_STATIC_AUDIT_FAILED'
          : i % 3 === 1
            ? 'METRIC_THRESHOLD_FAILED'
            : 'STAGE_A_SPILL_CEILING';
        await store.recordIndividual(lease, {
          individualId: `ind-fail-${i}`,
          campaignId: 'camp-sp',
          islandId: 0,
          generation: 2 + Math.floor(i / 5),
          bucketId: null,
          teamConfigId: team0,
          modelId: 'claude-sonnet-4-6',
          trackId: 'triton',
          mutationKind: 'diff_tune',
          status: 'failed',
          failureReason: reason,
          nicheKey: null,
          paretoRank: null,
          crowdingDistance: null,
          scalarFitness: null,
          codeSliceCasDigest: makeDigest(`fail-code-${i}`),
          evidenceDigest: null,
          verdictReceiptCasDigest: null,
          outputArtifacts: [],
          metrics: { max_ulp: i % 3 === 1 ? 8 : 0 },
          findings: [
            {
              title: reason === 'STAGE_A_STATIC_AUDIT_FAILED' ? 'Forbidden cublas symbol' : 'ULP / spill violation',
              severity: 'high',
              evidence: `Failure detail ${i} with token ghp_1234567890abcdefghijklmnop and custom-api-secret-xyz987654 ${'padding-'.repeat(40)}`,
            },
          ],
          lineageEdges: [
            {
              campaignId: 'camp-sp',
              childIndividualId: `ind-fail-${i}`,
              parentIndividualId: 'ind-fast',
              role: 'primary',
              sourceIslandId: 0,
              createdGeneration: 2,
            },
          ],
        });
      }

      // Also add many distinct synthetic niche improvements to test <= 16 KiB bounding
      for (let n = 0; n < 40; n++) {
        await store.recordIndividual(lease, {
          individualId: `ind-niche-${n}`,
          campaignId: 'camp-sp',
          islandId: 1,
          generation: 3,
          bucketId: null,
          teamConfigId: islands[1]!.activeTeamConfigId,
          modelId: 'claude-sonnet-4-6',
          trackId: 'cute',
          mutationKind: 'diff_tune',
          status: 'passed',
          failureReason: null,
          nicheKey: `bound_pipeline=smem_lds_ub|synthetic_bin=${n}-${'wide'.repeat(12)}`,
          paretoRank: 2,
          crowdingDistance: 0.5,
          scalarFitness: 0.7,
          codeSliceCasDigest: makeDigest(`niche-${n}`),
          evidenceDigest: makeDigest(`niche-ev-${n}`),
          verdictReceiptCasDigest: makeDigest(`niche-vr-${n}`),
          outputArtifacts: [],
          metrics: { latency_us_p50: 80 - (n % 20), goodput_rps: 1200 + n * 5 },
          hardwareDiagnostics: { boundPipeline: 'smem_lds_ub', localSpillBytes: 64 },
          lineageEdges: [
            {
              campaignId: 'camp-sp',
              childIndividualId: `ind-niche-${n}`,
              parentIndividualId: 'ind-base',
              role: 'primary',
              sourceIslandId: 0,
              createdGeneration: 3,
            },
          ],
        });
      }

      const synth1 = await synthesizeCampaignScratchpad({
        store,
        lease,
        campaignId: 'camp-sp',
        generation: 5,
        scrubber,
      });

      assert.ok(synth1.snapshot.byteLength <= SCRATCHPAD_MAX_BYTES);
      assert.equal(Buffer.byteLength(synth1.content, 'utf8'), synth1.snapshot.byteLength);
      assert.match(synth1.content, /2\.00x/);
      assert.match(synth1.content, /hbm -> tensor_cube/);
      assert.match(synth1.content, /STAGE_A_STATIC_AUDIT_FAILED/);

      // Zero secrets in persisted or returned scratchpad
      assert.equal(scrubber.containsSecret(synth1.content), false);
      assert.equal(synth1.content.includes('ghp_1234567890abcdefghijklmnop'), false);
      assert.equal(synth1.content.includes('custom-api-secret-xyz987654'), false);

      // Verify CAS file on disk has 0o400 permissions, nlink === 1, and exact SHA-256
      const casStat = lstatSync(synth1.casFilePath);
      assert.equal(casStat.isSymbolicLink(), false);
      assert.equal(casStat.nlink, 1);
      assert.equal(casStat.mode & 0o777, 0o400);
      const diskBytes = readFileSync(synth1.casFilePath);
      assert.equal(createHash('sha256').update(diskBytes).digest('hex'), synth1.snapshot.casDigest.hex);

      // Deterministic repeatability: synthesizing at the same state produces identical CAS digest
      const synth2 = await synthesizeCampaignScratchpad({
        store,
        lease,
        campaignId: 'camp-sp',
        generation: 5,
        snapshotId: 'snap-repeat',
        scrubber,
      });
      assert.equal(synth2.snapshot.casDigest.hex, synth1.snapshot.casDigest.hex);
      assert.equal(synth2.content, synth1.content);

      const latest = await store.getLatestScratchpadSnapshot('camp-sp');
      assert.equal(latest?.casDigest.hex, synth1.snapshot.casDigest.hex);
    } finally {
      // Restore write permission before temp cleanup so rmSync works across all platforms
      chmodSync(join(campaignRoot, 'cas', 'sha256'), 0o700);
      await store.close();
    }

    // Symlink CAS directory fails closed with EVOLUTION_SYMLINK_FORBIDDEN
    const badRoot = join(tempDir, 'bad-cas-campaign');
    const storeBad = await EvolutionCampaignStore.open({ campaignRoot: badRoot });
    try {
      const externalDir = join(tempDir, 'ext-dir');
      mkdirSync(externalDir);
      rmSync(join(badRoot, 'cas'), { recursive: true, force: true });
      symlinkSync(externalDir, join(badRoot, 'cas'));
      await assert.rejects(
        () => storeBad.writeCasBlob('hello'),
        (err: unknown) => err instanceof EvolutionError && err.code === 'EVOLUTION_SYMLINK_FORBIDDEN',
      );
    } finally {
      await storeBad.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
