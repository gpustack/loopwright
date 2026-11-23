import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { expectedSchema } from '../../state/src/schema.js';
import {
  runHardwareWorker,
  startRelayServer,
  type WorkerConfig,
} from '@loopwright/hardware-runner';
import {
  checkEvolutionCampaign,
  createControllerChildRunEvaluator,
  exportEvolutionBundle,
  getEvolutionCampaignStatus,
  inspectEvolutionCampaign,
  resumeEvolutionCampaign,
  runEvolutionCampaign,
  verifyEvolutionBundle,
  EvolutionError,
  type CandidateEvaluationProposal,
  type CandidateEvaluationResult,
} from '../src/index.js';

const BENCH_HMAC_SECRET = 'e2e-campaign-relay-hmac-secret-0123456789abcdef';
const WORKER_BEARER_TOKEN = 'e2e-campaign-worker-token-0123456789abcdef';

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function makeDigest(seed: string): { readonly algorithm: 'sha256'; readonly hex: string } {
  return { algorithm: 'sha256', hex: sha256Hex(seed) };
}

function initGitRepo(repoDir: string, files: Readonly<Record<string, { readonly content: string | Buffer; readonly executable?: boolean }>>): string {
  mkdirSync(repoDir, { recursive: true, mode: 0o700 });
  for (const [relPath, entry] of Object.entries(files)) {
    const absPath = join(repoDir, relPath);
    mkdirSync(join(absPath, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(absPath, entry.content, { mode: entry.executable ? 0o755 : 0o644 });
    if (entry.executable) chmodSync(absPath, 0o755);
  }
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Loopwright Test',
    GIT_AUTHOR_EMAIL: 'test@loopwright.dev',
    GIT_COMMITTER_NAME: 'Loopwright Test',
    GIT_COMMITTER_EMAIL: 'test@loopwright.dev',
  };
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, env: gitEnv, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: repoDir, env: gitEnv, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'Initial baseline kernel'], { cwd: repoDir, env: gitEnv, stdio: 'ignore' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, env: gitEnv, encoding: 'utf8' }).trim();
}

/**
 * Deterministic pure-TypeScript ELF64 builder for Stage A static symbol audit testing.
 */
function buildElf64Cubin(symbols: readonly string[]): Buffer {
  const parts: Buffer[] = [Buffer.from([0])];
  const offsets: number[] = [];
  let cursor = 1;
  for (const sym of symbols) {
    offsets.push(cursor);
    const b = Buffer.from(`${sym}\0`, 'utf8');
    parts.push(b);
    cursor += b.byteLength;
  }
  const strTab = Buffer.concat(parts);
  const symTab = Buffer.alloc((1 + offsets.length) * 24, 0);
  for (let i = 0; i < offsets.length; i += 1) {
    const off = (i + 1) * 24;
    symTab.writeUInt32LE(offsets[i]!, off);
    symTab.writeUInt8(0x12, off + 4);
    symTab.writeUInt16LE(0, off + 6);
  }
  const shStrParts = [Buffer.from([0]), Buffer.from('.strtab\0'), Buffer.from('.symtab\0'), Buffer.from('.shstrtab\0')];
  const shStrOffsets = [1, 9, 17];
  const shStrTab = Buffer.concat(shStrParts);

  const sections = [
    { shType: 3, shLink: 0, shEntSize: 0, data: strTab },
    { shType: 2, shLink: 1, shEntSize: 24, data: symTab },
    { shType: 3, shLink: 0, shEntSize: 0, data: shStrTab },
  ];

  const ehdr = Buffer.alloc(64, 0);
  ehdr[0] = 0x7f;
  ehdr[1] = 0x45;
  ehdr[2] = 0x4c;
  ehdr[3] = 0x46;
  ehdr[4] = 2; // ELFCLASS64
  ehdr[5] = 1; // ELFDATA2LSB
  ehdr[6] = 1;
  ehdr.writeUInt16LE(2, 16); // ET_EXEC (.cubin)
  ehdr.writeUInt16LE(190, 18); // EM_CUDA
  ehdr.writeUInt32LE(1, 20);
  ehdr.writeUInt16LE(64, 52);
  ehdr.writeUInt16LE(64, 58);
  ehdr.writeUInt16LE(1 + sections.length, 60);
  ehdr.writeUInt16LE(3, 62);

  const chunks: Buffer[] = [ehdr];
  const secOffsets: number[] = [];
  let offset = 64;
  for (const sec of sections) {
    const pad = (8 - (offset % 8)) % 8;
    if (pad > 0) {
      chunks.push(Buffer.alloc(pad, 0));
      offset += pad;
    }
    secOffsets.push(offset);
    chunks.push(sec.data);
    offset += sec.data.byteLength;
  }
  const shPad = (8 - (offset % 8)) % 8;
  if (shPad > 0) {
    chunks.push(Buffer.alloc(shPad, 0));
    offset += shPad;
  }
  ehdr.writeBigUInt64LE(BigInt(offset), 40);
  chunks.push(Buffer.alloc(64, 0));
  for (let i = 0; i < sections.length; i += 1) {
    const sec = sections[i]!;
    const shdr = Buffer.alloc(64, 0);
    shdr.writeUInt32LE(shStrOffsets[i]!, 0);
    shdr.writeUInt32LE(sec.shType, 4);
    shdr.writeBigUInt64LE(BigInt(secOffsets[i]!), 24);
    shdr.writeBigUInt64LE(BigInt(sec.data.byteLength), 32);
    shdr.writeUInt32LE(sec.shLink, 40);
    shdr.writeBigUInt64LE(1n, 48);
    shdr.writeBigUInt64LE(BigInt(sec.shEntSize), 56);
    chunks.push(shdr);
  }
  return Buffer.concat(chunks);
}

const BASELINE_KERNEL_SOURCE = [
  '#include <stdint.h>',
  '// Locked prologue header outside EVOLVE-BLOCK',
  'static constexpr int LOCKED_ABI_VERSION = 1;',
  '// EVOLVE-BLOCK-START: flash_decode',
  'int flash_decode_mode() {',
  '  return 0; // baseline',
  '}',
  '// EVOLVE-BLOCK-END: flash_decode',
  '',
].join('\n');

const SINGLE_TARGET_TASKPACK_YAML = `
apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: flash-decode-e2e
spec:
  goal:
    candidate: Evolve flash decode kernel inside EVOLVE-BLOCK markers.
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
          forbiddenSymbolPatterns:
            - cublas
            - cudnn
  scope:
    writable:
      - src/kernels/**
    protected:
      - scripts/**
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
      prompt: Inspect kernel Roofline bottleneck.
    - id: mutator-sandboxed
      provider: anthropic
      model: claude-sonnet-4-6
      purpose: task
      tools: [read, write, edit, bash]
      prompt: Mutate flash_decode.cu strictly inside EVOLVE-BLOCK markers.
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

const STEPPING_STONE_CAMPAIGN_YAML = `
apiVersion: loopwright.dev/v1alpha1
kind: EvolutionCampaign
metadata:
  name: stepping-stone-campaign
spec:
  taskpack: .loopwright/taskpack.yaml
  targetCellId: cuda-h100-whole
  stages:
    mode: single-target
  population:
    islands: 2
    migrationIntervalGenerations: 2
    maxMigrationElites: 1
    nicheAxes:
      - id: bound_pipeline
        kind: enum
        values: [hbm, l2, smem_lds_ub, tensor_cube]
      - id: occupancy_band
        kind: numeric_bins
        edges: [0, 50, 100]
  sampling:
    noveltyDecayLambda: 1.0
    mutationWeights:
      diff_tune: 0.2
      full_rewrite: 0.2
      crossover: 0.6
    modelBandit: ucb1
    maxCrossoversPerPrompt: 2
  objectives:
    - metric: latency_us_p50
      direction: minimize
    - metric: goodput_rps
      direction: maximize
  budgets:
    maxGenerations: 3
    maxEvaluations: 6
    maxConcurrentEvaluations: 2
    scratchpadIntervalGenerations: 2
`;

test('campaign: checkEvolutionCampaign validates Taskpack links and rejects broken targetCellId, unapproved team archetype, or colliding portfolio workload', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'evo-check-campaign-'));
  try {
    const repoDir = join(tempDir, 'repo');
    initGitRepo(repoDir, {
      '.loopwright/taskpack.yaml': { content: SINGLE_TARGET_TASKPACK_YAML },
      '.loopwright/campaign.yaml': { content: STEPPING_STONE_CAMPAIGN_YAML },
      'src/kernels/flash_decode.cu': { content: BASELINE_KERNEL_SOURCE },
    });

    const checked = await checkEvolutionCampaign({
      manifestPath: join(repoDir, '.loopwright', 'campaign.yaml'),
      repositoryRoot: repoDir,
    });
    assert.equal(checked.valid, true);
    assert.equal(checked.targetCellId, 'cuda-h100-whole');
    assert.deepEqual(checked.modelIds, ['claude-sonnet-4-6', 'gpt-5.4']);

    // Unknown targetCellId -> fails closed
    await assert.rejects(
      () => checkEvolutionCampaign({
        manifest: STEPPING_STONE_CAMPAIGN_YAML.replace('targetCellId: cuda-h100-whole', 'targetCellId: missing-cell'),
        repositoryRoot: repoDir,
      }),
      (err: unknown) => err instanceof EvolutionError && err.code === 'EVOLUTION_SCHEMA_INVALID',
    );

    // Unapproved archetype in teamEvolution -> TEAM_ENVELOPE_VIOLATION
    const badArchetypeYaml = `${STEPPING_STONE_CAMPAIGN_YAML}
  teamEvolution:
    enabled: true
    supervisorRoleId: supervisor
    allowedArchetypeRoles: [nonexistent-archetype]
    stallGenerations: 4
    minHypervolumeDelta: 0.001
    triggerOnRunEvalPathology: true
    trialGenerations: 2
    maxTeamSize: 2
    maxTeamSteps: 2
`;
    await assert.rejects(
      () => checkEvolutionCampaign({
        manifest: badArchetypeYaml,
        repositoryRoot: repoDir,
      }),
      (err: unknown) => err instanceof EvolutionError && err.code === 'TEAM_ENVELOPE_VIOLATION',
    );

    // Portfolio workload colliding with specialist bucket workload -> EVOLUTION_SCHEMA_INVALID
    const collidingPortfolioYaml = STEPPING_STONE_CAMPAIGN_YAML.replace(
      `  stages:\n    mode: single-target`,
      [
        '  stages:',
        '    mode: specialist-then-portfolio',
        '    specialistBuckets:',
        '      - id: bs1-isl4k',
        '        heldOutWorkloadId: decode-bs1-4k',
        '    portfolioHeldOutWorkloadId: decode-bs1-4k',
      ].join('\n'),
    );
    await assert.rejects(
      () => checkEvolutionCampaign({
        manifest: collidingPortfolioYaml,
        repositoryRoot: repoDir,
      }),
      (err: unknown) => err instanceof EvolutionError && err.code === 'EVOLUTION_SCHEMA_INVALID',
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('campaign: retains slower MAP-Elites stepping stone in distinct bound_pipeline niche, migrates inspiration across islands, and promotes crossover child to rank-1 Pareto dominance', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'evo-stepping-stone-'));
  try {
    const repoDir = join(tempDir, 'repo');
    const baseRevision = initGitRepo(repoDir, {
      '.loopwright/taskpack.yaml': { content: SINGLE_TARGET_TASKPACK_YAML },
      'src/kernels/flash_decode.cu': { content: BASELINE_KERNEL_SOURCE },
    });
    const campaignRoot = join(tempDir, 'campaign-state');

    const observedStagedParentPerms: number[] = [];

    const evaluator = async (proposal: CandidateEvaluationProposal): Promise<CandidateEvaluationResult> => {
      for (const file of proposal.stagedParentFiles) {
        const st = lstatSync(file.filePath);
        assert.equal(st.isSymbolicLink(), false);
        assert.equal(st.nlink, 1);
        observedStagedParentPerms.push(st.mode & 0o777);
      }
      if (proposal.stagedScratchpadPath !== undefined) {
        const scStat = lstatSync(proposal.stagedScratchpadPath);
        assert.equal(scStat.mode & 0o777, 0o400);
      }

      // Generation 1:
      // Island 0 discovers a fast HBM-bound local elite (latency 70, goodput 1900)
      // Island 1 discovers a SLOWER structural tensor_cube stepping stone (latency 96, goodput 1450)
      if (proposal.generation === 1) {
        if (proposal.islandId === 0) {
          return {
            status: 'passed',
            codeSlice: `// EVOLVE-BLOCK-START: flash_decode\nint flash_decode_mode() { return 10; /* fast_hbm_vec4 */ }\n// EVOLVE-BLOCK-END: flash_decode\n`,
            metrics: { latency_us_p50: 70, goodput_rps: 1900 },
            hardwareDiagnostics: { boundPipeline: 'hbm', occupancyPct: 75, rooflineHeadroom: 1.45 },
            evidenceDigest: makeDigest(`ev-${proposal.individualId}`),
          };
        }
        return {
          status: 'passed',
          codeSlice: `// EVOLVE-BLOCK-START: flash_decode\nint flash_decode_mode() { return 20; /* async_tma_tensor_cube_stone */ }\n// EVOLVE-BLOCK-END: flash_decode\n`,
          metrics: { latency_us_p50: 96, goodput_rps: 1450 },
          hardwareDiagnostics: { boundPipeline: 'tensor_cube', occupancyPct: 35, rooflineHeadroom: 1.65 },
          evidenceDigest: makeDigest(`ev-${proposal.individualId}`),
        };
      }

      // Generation 2: Island 0 ALSO discovers a local smem_lds_ub stepping stone so Island 0 has 2 distinct niches!
      if (proposal.generation === 2) {
        if (proposal.islandId === 0) {
          return {
            status: 'passed',
            codeSlice: `// EVOLVE-BLOCK-START: flash_decode\nint flash_decode_mode() { return 15; /* double_buffered_smem_stone */ }\n// EVOLVE-BLOCK-END: flash_decode\n`,
            metrics: { latency_us_p50: 88, goodput_rps: 1600 },
            hardwareDiagnostics: { boundPipeline: 'smem_lds_ub', occupancyPct: 40, rooflineHeadroom: 1.52 },
            evidenceDigest: makeDigest(`ev-${proposal.individualId}`),
          };
        }
        return {
          status: 'passed',
          codeSlice: `// EVOLVE-BLOCK-START: flash_decode\nint flash_decode_mode() { return 22; /* l2_prefetch_stone */ }\n// EVOLVE-BLOCK-END: flash_decode\n`,
          metrics: { latency_us_p50: 84, goodput_rps: 1650 },
          hardwareDiagnostics: { boundPipeline: 'l2', occupancyPct: 60, rooflineHeadroom: 1.48 },
          evidenceDigest: makeDigest(`ev-${proposal.individualId}`),
        };
      }

      // Generation 3 (after gen-2 ring migration + scratchpad synthesis):
      // Multi-parent crossover combines primary + stepping-stone donor/inspiration -> rank-1 Pareto breakthrough!
      const hasSteppingStoneParent = proposal.parents.some(p =>
        p.individual.nicheKey?.includes('tensor_cube')
        || p.individual.nicheKey?.includes('smem_lds_ub')
        || p.role === 'inspiration'
        || p.role === 'crossover_donor',
      );
      if (proposal.islandId === 0 && hasSteppingStoneParent) {
        return {
          status: 'passed',
          codeSlice: `// EVOLVE-BLOCK-START: flash_decode\nint flash_decode_mode() { return 99; /* fused_tma_double_buffer_winner */ }\n// EVOLVE-BLOCK-END: flash_decode\n`,
          metrics: { latency_us_p50: 42, goodput_rps: 2850 },
          hardwareDiagnostics: { boundPipeline: 'tensor_cube', occupancyPct: 80, rooflineHeadroom: 1.11 },
          evidenceDigest: makeDigest(`ev-${proposal.individualId}`),
        };
      }
      return {
        status: 'passed',
        codeSlice: `// EVOLVE-BLOCK-START: flash_decode\nint flash_decode_mode() { return ${30 + proposal.islandId}; }\n// EVOLVE-BLOCK-END: flash_decode\n`,
        metrics: { latency_us_p50: 68, goodput_rps: 1950 },
        hardwareDiagnostics: { boundPipeline: 'hbm', occupancyPct: 70, rooflineHeadroom: 1.38 },
        evidenceDigest: makeDigest(`ev-${proposal.individualId}`),
      };
    };

    const result = await runEvolutionCampaign({
      campaignRoot,
      campaignId: 'camp-stepping-stone',
      manifest: STEPPING_STONE_CAMPAIGN_YAML,
      repositoryRoot: repoDir,
      baseRevision,
      evaluator,
    });

    assert.equal(result.campaign.status, 'completed');
    assert.equal(result.campaign.evaluationsUsed, 6);
    assert.ok(observedStagedParentPerms.length > 0);
    assert.ok(observedStagedParentPerms.every(mode => mode === 0o400));

    const inspected = await inspectEvolutionCampaign({
      campaignRoot,
      campaignId: 'camp-stepping-stone',
    });

    // Slower stepping stones in smem_lds_ub / tensor_cube niches survived in island niche archives!
    const island0Archive = inspected.nicheArchives.find(a => a.islandId === 0);
    assert.ok(island0Archive !== undefined);
    assert.ok(island0Archive.elites.length >= 2, 'MAP-Elites must retain distinct hardware-behavior niches on Island 0');

    // Rank-1 Pareto winner achieved (latency 42, goodput 2850) and has multi-parent lineage edges
    assert.equal(inspected.paretoFrontier.length, 1);
    const winner = inspected.paretoFrontier[0]!;
    assert.equal(winner.metrics['latency_us_p50'], 42);
    assert.equal(winner.metrics['goodput_rps'], 2850);

    const winnerEdges = inspected.lineageEdges.filter(e => e.childIndividualId === winner.individualId);
    assert.ok(winnerEdges.length >= 2, 'crossover winner must record multi-parent lineage_edges');
    assert.equal(winnerEdges.some(e => e.role === 'primary'), true);
    assert.equal(
      winnerEdges.some(e => e.role === 'crossover_donor' || e.role === 'inspiration'),
      true,
    );

    // Scratchpad snapshot was synthesized at generation 2 and model bandit arms recorded rewards
    assert.ok(inspected.scratchpadSnapshots.length >= 1);
    assert.equal(inspected.modelBanditArms.length, 2);
    assert.ok(inspected.modelBanditArms.some(arm => arm.totalReward > 0));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('campaign: cosmetic EVOLVE-BLOCK clone is rejected by @loopwright/decisions with 0 benchmark-gate.v1 dispatches and verificationCertified: false', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'evo-novelty-clone-'));
  try {
    const repoDir = join(tempDir, 'repo');
    const baseRevision = initGitRepo(repoDir, {
      '.loopwright/taskpack.yaml': { content: SINGLE_TARGET_TASKPACK_YAML },
      'src/kernels/flash_decode.cu': { content: BASELINE_KERNEL_SOURCE },
    });
    const campaignRoot = join(tempDir, 'campaign-state');

    const twoGenYaml = STEPPING_STONE_CAMPAIGN_YAML
      .replace('islands: 2', 'islands: 1')
      .replace('maxGenerations: 3', 'maxGenerations: 2')
      .replace('maxEvaluations: 6', 'maxEvaluations: 4');

    let benchmarkGateDispatches = 0;

    const result = await runEvolutionCampaign({
      campaignRoot,
      campaignId: 'camp-novelty-filter',
      manifest: twoGenYaml,
      repositoryRoot: repoDir,
      baseRevision,
      proposeCandidateSlice: async ctx => {
        if (ctx.generation === 1) {
          return '// EVOLVE-BLOCK-START: flash_decode\nint flash_decode_mode() {\n  return 7;\n}\n// EVOLVE-BLOCK-END: flash_decode\n';
        }
        // Generation 2: cosmetic whitespace + comment-only clone of Generation 1!
        return '// EVOLVE-BLOCK-START: flash_decode\n/* pure cosmetic comment */\nint   flash_decode_mode( ) {\n    return 7; // identical AST token stream\n}\n// EVOLVE-BLOCK-END: flash_decode\n';
      },
      evaluator: async proposal => {
        benchmarkGateDispatches += 1;
        return {
          status: 'passed',
          codeSlice: proposal.proposedCodeSlice ?? '',
          metrics: { latency_us_p50: 60, goodput_rps: 2100 },
          hardwareDiagnostics: { boundPipeline: 'tensor_cube', occupancyPct: 75, rooflineHeadroom: 1.25 },
          evidenceDigest: makeDigest(`ev-${proposal.individualId}`),
        };
      },
    });

    // Generation 1 dispatched benchmark-gate.v1 (1 time); Generation 2 cosmetic clone was rejected BEFORE evaluator (0 dispatches for clone!)
    assert.equal(benchmarkGateDispatches, 1);
    assert.equal(result.noveltyRejectionsCount, 1);
    assert.equal(result.campaign.evaluationsUsed, 1);
    assert.ok(result.advisoryDecisions.length >= 2);
    assert.equal(result.advisoryDecisions.every(d => d.verificationCertified === false && d.advisoryOnly === true), true);

    const inspected = await inspectEvolutionCampaign({ campaignRoot, campaignId: 'camp-novelty-filter' });
    const rejectedClone = inspected.individuals.find(i => i.failureReason === 'NOVELTY_CLONE_REJECTED');
    assert.ok(rejectedClone !== undefined);
    assert.equal(rejectedClone.status, 'failed');
    assert.equal(rejectedClone.verdictReceiptCasDigest, null);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('campaign (real LocalRunStore + RelayServer + Worker): enforces evolve-block-guard.v1 pre-lease, Stage A cublasGemmEx static audit with 0 Stage B runs, and all_buckets max_ulp threshold', async () => {
  const stateSchemaBefore = expectedSchema();
  const tempDir = mkdtempSync(join(realpathSync(tmpdir()), 'evo-real-gates-'));

  const relayCasDir = join(tempDir, 'relay-cas');
  const workerWorkDir = join(tempDir, 'worker-work');
  const workloadsDir = join(tempDir, 'workloads');
  mkdirSync(workerWorkDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(workloadsDir, 'decode-bs1-4k'), { recursive: true, mode: 0o700 });

  // Stage B blind workload script: reads compiled mode marker inside sealed Stage A metadata and emits bucketed metrics
  const evaluateScript = [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const modePath = path.join(process.env.LOOPWRIGHT_STAGE_A_OUT || ".", "mode.txt");',
    'const mode = fs.existsSync(modePath) ? fs.readFileSync(modePath, "utf8").trim() : "clean";',
    'const badUlp = mode === "bad_ulp";',
    'const payload = {',
    '  status: "approved",',
    '  metrics: { latency_us_p50: badUlp ? 45 : 52, goodput_rps: 2400, max_ulp: badUlp ? 5 : 1 },',
    '  bucketMetrics: [',
    '    { bucketId: "b0", dimensions: { bs: 1 }, metrics: { latency_us_p50: 48, goodput_rps: 2500, max_ulp: 1 } },',
    '    { bucketId: "b1", dimensions: { bs: 4 }, metrics: { latency_us_p50: 56, goodput_rps: 2300, max_ulp: badUlp ? 5 : 1 } }',
    '  ],',
    '  hardwareDiagnostics: { boundPipeline: "tensor_cube", occupancyPct: 75, rooflineHeadroom: 1.15 }',
    '};',
    'process.stdout.write("LOOPWRIGHT_STAGE_B_RESULT:" + JSON.stringify(payload) + "\\n");',
    '',
  ].join('\n');
  writeFileSync(join(workloadsDir, 'decode-bs1-4k', 'evaluate.sh'), evaluateScript, { mode: 0o755 });
  chmodSync(join(workloadsDir, 'decode-bs1-4k', 'evaluate.sh'), 0o755);

  const cleanCubinHex = buildElf64Cubin(['flash_decode_sm90a']).toString('hex');
  const cublasCubinHex = buildElf64Cubin(['cublasGemmEx']).toString('hex');

  // Stage A build script inside repo: compiles src/kernels/flash_decode.cu into Stage A .cubin + mode.txt
  const buildScript = [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const src = fs.readFileSync("src/kernels/flash_decode.cu", "utf8");',
    'const outDir = process.env.LOOPWRIGHT_STAGE_A_OUT;',
    'if (src.includes("USE_CUBLAS_FALLBACK")) {',
    `  fs.writeFileSync(path.join(outDir, "kernel.cubin"), Buffer.from(${JSON.stringify(cublasCubinHex)}, "hex"));`,
    '} else {',
    `  fs.writeFileSync(path.join(outDir, "kernel.cubin"), Buffer.from(${JSON.stringify(cleanCubinHex)}, "hex"));`,
    '  fs.writeFileSync(path.join(outDir, "mode.txt"), src.includes("TRIGGER_BAD_ULP") ? "bad_ulp" : "clean");',
    '}',
    '',
  ].join('\n');

  const relay = await startRelayServer({
    port: 0,
    casDir: relayCasDir,
    controllerSigningSecret: BENCH_HMAC_SECRET,
    workerTokens: [WORKER_BEARER_TOKEN],
    leaseTtlMs: 15_000,
    sweepIntervalMs: 250,
  });

  const workerAbort = new AbortController();
  let workerLeasesAcquired = 0;
  let stageBExecutionsObserved = 0;
  const workerConfig: WorkerConfig = {
    workerId: 'worker-e2e-gates',
    relayUrl: relay.url,
    workerToken: WORKER_BEARER_TOKEN,
    workDir: workerWorkDir,
    heldOutWorkloadsDir: workloadsDir,
    sandboxBackend: 'native_os',
    capabilities: {
      accelerator: 'sm_90a',
      isolationModes: ['whole_device'],
      deviceCount: 1,
      driverVersion: '550.90.07',
      workloadIds: ['decode-bs1-4k'],
    },
    pollWaitMs: 200,
    heartbeatIntervalMs: 50,
    requestTimeoutMs: 5_000,
    stageATimeoutMs: 15_000,
    stageBTimeoutMs: 15_000,
    toolchainPaths: [join(process.execPath, '..')],
    probeMode: 'synthetic_fixture',
  };

  let workerFatalError: unknown = null;
  const workerPromise = runHardwareWorker({
    config: workerConfig,
    once: false,
    signal: workerAbort.signal,
    registerProcessSignalHandlers: false,
    onLeaseAcquired: () => {
      workerLeasesAcquired += 1;
    },
  }).catch((err: unknown) => {
    if (!workerAbort.signal.aborted) {
      workerFatalError = err;
    }
  });

  try {
    const repoDir = join(tempDir, 'repo');
    const baseRevision = initGitRepo(repoDir, {
      '.loopwright/taskpack.yaml': { content: SINGLE_TARGET_TASKPACK_YAML },
      'src/kernels/flash_decode.cu': { content: BASELINE_KERNEL_SOURCE },
      'scripts/build.sh': { content: buildScript, executable: true },
    });

    const fourGenCampaignYaml = STEPPING_STONE_CAMPAIGN_YAML
      .replace('islands: 2', 'islands: 1')
      .replace('maxGenerations: 3', 'maxGenerations: 4')
      .replace('maxEvaluations: 6', 'maxEvaluations: 4');

    const envMap: Readonly<Record<string, string>> = {
      BENCH_SIGNING_SECRET: BENCH_HMAC_SECRET,
    };

    const leaseCountsAfterGen: number[] = [];
    const stageBCountsAfterGen: number[] = [];

    const evaluator = createControllerChildRunEvaluator({
      repositoryRoot: repoDir,
      allowLoopbackHttp: true,
      gateEndpoints: [
        {
          id: 'hw-relay',
          url: `${relay.url}/v1/benchmark/jobs`,
          signingCredentialRef: 'bench-sign',
          implementation: 'benchmark-gate.v1',
          timeoutMs: 10_000,
          maxPollMs: 25_000,
          pollInitialMs: 100,
          pollMaxMs: 250,
          jitter: 10,
        },
      ],
      credentialEnvMap: {
        byCredentialRef: { 'bench-sign': 'BENCH_SIGNING_SECRET' },
      },
      environment: name => envMap[name],
      agentDriver: async stepCtx => {
        const kernelPath = join(stepCtx.workspacePath, 'src/kernels/flash_decode.cu');
        if (stepCtx.generation === 1) {
          // 1. Mutate 1 character OUTSIDE EVOLVE-BLOCK -> must fail evolve-block-guard.v1 BEFORE Relay/Worker lease!
          const illegalOutsideEdit = BASELINE_KERNEL_SOURCE.replace(
            'LOCKED_ABI_VERSION = 1;',
            'LOCKED_ABI_VERSION = 2;',
          );
          writeFileSync(kernelPath, illegalOutsideEdit, 'utf8');
        } else if (stepCtx.generation === 2) {
          // 2. Legal inside-block edit, but Stage A links forbidden cublasGemmEx -> STAGE_A_STATIC_AUDIT_FAILED (0 Stage B runs!)
          const cublasEdit = BASELINE_KERNEL_SOURCE.replace(
            'return 0; // baseline',
            'return 1; // USE_CUBLAS_FALLBACK',
          );
          writeFileSync(kernelPath, cublasEdit, 'utf8');
        } else if (stepCtx.generation === 3) {
          // 3. Clean Stage A ELF, but Stage B bucket b1 has max_ulp = 5 > 2 -> METRIC_THRESHOLD_FAILED!
          const badUlpEdit = BASELINE_KERNEL_SOURCE.replace(
            'return 0; // baseline',
            'return 2; // TRIGGER_BAD_ULP',
          );
          writeFileSync(kernelPath, badUlpEdit, 'utf8');
        } else {
          // 4. Clean Stage A ELF + clean all-bucket Stage B -> PASSED!
          const cleanEdit = BASELINE_KERNEL_SOURCE.replace(
            'return 0; // baseline',
            'return 3; // CLEAN_TENSOR_CUBE_WINNER',
          );
          writeFileSync(kernelPath, cleanEdit, 'utf8');
        }
      },
      onAfterChildEvaluation: async (_proposal, evalResult) => {
        if (evalResult.bucketMetrics !== undefined && evalResult.bucketMetrics.length > 0) {
          stageBExecutionsObserved += 1;
        }
        leaseCountsAfterGen.push(workerLeasesAcquired);
        stageBCountsAfterGen.push(stageBExecutionsObserved);
      },
    });

    const campaignRoot = join(tempDir, 'campaign-real');
    const runRes = await runEvolutionCampaign({
      campaignRoot,
      campaignId: 'camp-real-gates',
      manifest: fourGenCampaignYaml,
      repositoryRoot: repoDir,
      baseRevision,
      evaluator,
    });

    assert.equal(runRes.campaign.status, 'completed');
    assert.equal(runRes.campaign.evaluationsUsed, 4);

    // Gen 1 (outside EVOLVE-BLOCK): 0 worker leases, 0 Stage B runs!
    assert.equal(leaseCountsAfterGen[0], 0);
    assert.equal(stageBCountsAfterGen[0], 0);

    // Gen 2 (Stage A cublasGemmEx): 1 worker lease, STILL 0 Stage B runs!
    assert.equal(leaseCountsAfterGen[1], 1);
    assert.equal(stageBCountsAfterGen[1], 0);

    // Gen 3 (all_buckets max_ulp failure): 2 worker leases, 1 Stage B run
    assert.equal(leaseCountsAfterGen[2], 2);
    assert.equal(stageBCountsAfterGen[2], 1);

    // Gen 4 (clean pass): 3 worker leases, 2 Stage B runs
    assert.equal(leaseCountsAfterGen[3], 3);
    assert.equal(stageBCountsAfterGen[3], 2);

    const inspected = await inspectEvolutionCampaign({ campaignRoot, campaignId: 'camp-real-gates' });
    const byGen = [...inspected.individuals].sort((a, b) => a.generation - b.generation);
    assert.equal(byGen.length, 4);

    // Verify child LocalRunStore directories exist under <campaignRoot>/runs/<individualId>/controller/<individualId>/state
    for (const ind of byGen) {
      const childStateDir = join(campaignRoot, 'runs', ind.individualId, 'controller', ind.individualId, 'state');
      assert.equal(existsSync(childStateDir), true);
    }

    assert.equal(byGen[0]?.status, 'failed');
    assert.ok(byGen[0]?.failureReason !== null);

    assert.equal(byGen[1]?.status, 'failed');
    assert.equal(byGen[1]?.failureReason, 'STAGE_A_STATIC_AUDIT_FAILED');

    assert.equal(byGen[2]?.status, 'failed');
    assert.equal(byGen[2]?.failureReason, 'METRIC_THRESHOLD_FAILED');

    assert.equal(byGen[3]?.status, 'passed');
    assert.ok(byGen[3]?.verdictReceiptCasDigest !== null);
    assert.ok(byGen[3]?.outputArtifacts.some(a => a.name === 'kernel.cubin'));

    assert.equal(expectedSchema(), stateSchemaBefore);
  } finally {
    workerAbort.abort();
    await workerPromise;
    await relay.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
  assert.equal(workerFatalError, null);
});

test('campaign: graceful SIGTERM / BENCHMARK_PREEMPTED interruption and resumeEvolutionCampaign preserve archives without double-counting maxEvaluations or mutating @loopwright/state schema', async () => {
  const stateSchemaBefore = expectedSchema();
  const tempDir = mkdtempSync(join(tmpdir(), 'evo-resume-preempt-'));
  try {
    const repoDir = join(tempDir, 'repo');
    const baseRevision = initGitRepo(repoDir, {
      '.loopwright/taskpack.yaml': { content: SINGLE_TARGET_TASKPACK_YAML },
      'src/kernels/flash_decode.cu': { content: BASELINE_KERNEL_SOURCE },
    });
    const campaignRoot = join(tempDir, 'campaign-resume');

    const resumeYaml = STEPPING_STONE_CAMPAIGN_YAML
      .replace('islands: 2', 'islands: 1')
      .replace('maxGenerations: 3', 'maxGenerations: 4')
      .replace('maxEvaluations: 6', 'maxEvaluations: 3');

    const abortController = new AbortController();
    let callCount = 0;

    // Run 1:
    // Call 1 (Gen 1): passed (evaluationsUsed = 1)
    // Call 2 (Gen 2): BENCHMARK_PREEMPTED (preemptionsCount = 1, evaluationsUsed MUST stay 1!) -> then SIGTERM abort triggers!
    const firstRun = await runEvolutionCampaign({
      campaignRoot,
      campaignId: 'camp-resume-1',
      manifest: resumeYaml,
      repositoryRoot: repoDir,
      baseRevision,
      signal: abortController.signal,
      evaluator: async proposal => {
        callCount += 1;
        if (callCount === 1) {
          return {
            status: 'passed',
            codeSlice: '// EVOLVE-BLOCK-START: flash_decode\nint flash_decode_mode() { return 101; }\n// EVOLVE-BLOCK-END: flash_decode\n',
            metrics: { latency_us_p50: 80, goodput_rps: 1700 },
            hardwareDiagnostics: { boundPipeline: 'hbm', occupancyPct: 60, rooflineHeadroom: 1.4 },
            evidenceDigest: makeDigest(`ev-${proposal.individualId}`),
          };
        }
        abortController.abort();
        return {
          status: 'preempted',
          failureReason: 'BENCHMARK_PREEMPTED',
          codeSlice: '// EVOLVE-BLOCK-START: flash_decode\nint flash_decode_mode() { return 102; }\n// EVOLVE-BLOCK-END: flash_decode\n',
          metrics: {},
        };
      },
    });

    assert.equal(firstRun.campaign.status, 'paused');
    assert.equal(firstRun.campaign.evaluationsUsed, 1, 'preempted evaluation must NOT consume maxEvaluations');
    assert.equal(firstRun.campaign.preemptionsCount, 1);

    const midStatus = await getEvolutionCampaignStatus({ campaignRoot, campaignId: 'camp-resume-1' });
    assert.equal(midStatus.campaign.status, 'paused');
    assert.equal(midStatus.countsByStatus.passed, 1);
    assert.equal(midStatus.countsByStatus.preempted, 1);

    // Resume from campaign.sqlite with fresh coordinator lease and complete remaining 2 evaluations (total = 3 === maxEvaluations)
    let resumedCalls = 0;
    const resumedRun = await resumeEvolutionCampaign({
      campaignRoot,
      campaignId: 'camp-resume-1',
      repositoryRoot: repoDir,
      evaluator: async proposal => {
        resumedCalls += 1;
        return {
          status: 'passed',
          codeSlice: `// EVOLVE-BLOCK-START: flash_decode\nint flash_decode_mode() { return ${200 + resumedCalls}; }\n// EVOLVE-BLOCK-END: flash_decode\n`,
          metrics: { latency_us_p50: 70 - resumedCalls * 10, goodput_rps: 1900 + resumedCalls * 300 },
          hardwareDiagnostics: { boundPipeline: 'tensor_cube', occupancyPct: 75, rooflineHeadroom: 1.15 },
          evidenceDigest: makeDigest(`ev-resumed-${proposal.individualId}`),
        };
      },
    });

    assert.equal(resumedRun.campaign.status, 'completed');
    assert.equal(resumedCalls, 2);
    assert.equal(resumedRun.campaign.evaluationsUsed, 3);
    assert.equal(resumedRun.campaign.preemptionsCount, 1);
    assert.equal(expectedSchema(), stateSchemaBefore);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('campaign (e2e specialist-then-portfolio -> OCI bundle): evolves 2 specialist buckets without exposing portfolioHeldOutWorkloadId, verifies portfolio, exports OCI bundle, and rejects 1-byte tampered .cubin', async () => {
  const tempDir = mkdtempSync(join(realpathSync(tmpdir()), 'evo-portfolio-e2e-'));

  const relayCasDir = join(tempDir, 'relay-cas');
  const workerWorkDir = join(tempDir, 'worker-work');
  const workloadsDir = join(tempDir, 'workloads');
  mkdirSync(workerWorkDir, { recursive: true, mode: 0o700 });

  for (const [workloadId, baseLat, baseRps] of [
    ['decode-bs1-4k', 28, 2200] as const,
    ['decode-bs16-8k', 64, 5400] as const,
    ['decode-portfolio-holdout', 44, 4100] as const,
  ]) {
    mkdirSync(join(workloadsDir, workloadId), { recursive: true, mode: 0o700 });
    const script = [
      `#!${process.execPath}`,
      `const payload = {`,
      `  status: "approved",`,
      `  metrics: { latency_us_p50: ${baseLat}, goodput_rps: ${baseRps}, max_ulp: 1 },`,
      `  bucketMetrics: [`,
      `    { bucketId: ${JSON.stringify(workloadId)}, dimensions: { bs: ${workloadId.includes('bs16') ? 16 : 1} }, metrics: { latency_us_p50: ${baseLat}, goodput_rps: ${baseRps}, max_ulp: 1 } }`,
      `  ],`,
      `  hardwareDiagnostics: { boundPipeline: "tensor_cube", occupancyPct: 78, rooflineHeadroom: 1.12 }`,
      `};`,
      `process.stdout.write("LOOPWRIGHT_STAGE_B_RESULT:" + JSON.stringify(payload) + "\\n");`,
      '',
    ].join('\n');
    const scriptPath = join(workloadsDir, workloadId, 'evaluate.sh');
    writeFileSync(scriptPath, script, { mode: 0o755 });
    chmodSync(scriptPath, 0o755);
  }

  const bs1CubinHex = buildElf64Cubin(['flash_decode_bs1_sm90a']).toString('hex');
  const bs16CubinHex = buildElf64Cubin(['flash_decode_bs16_sm90a']).toString('hex');
  const routerCubinHex = buildElf64Cubin(['flash_decode_portfolio_router_sm90a']).toString('hex');

  const portfolioBuildScript = [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const src = fs.readFileSync("src/kernels/flash_decode.cu", "utf8");',
    'const outDir = process.env.LOOPWRIGHT_STAGE_A_OUT;',
    'if (src.includes("PORTFOLIO_ROUTER_DISPATCH")) {',
    `  fs.writeFileSync(path.join(outDir, "portfolio_router.cubin"), Buffer.from(${JSON.stringify(routerCubinHex)}, "hex"));`,
    '} else if (src.includes("SPECIALIST_BS16")) {',
    `  fs.writeFileSync(path.join(outDir, "spec_bs16.cubin"), Buffer.from(${JSON.stringify(bs16CubinHex)}, "hex"));`,
    '} else {',
    `  fs.writeFileSync(path.join(outDir, "spec_bs1.cubin"), Buffer.from(${JSON.stringify(bs1CubinHex)}, "hex"));`,
    '}',
    '',
  ].join('\n');

  const relay = await startRelayServer({
    port: 0,
    casDir: relayCasDir,
    controllerSigningSecret: BENCH_HMAC_SECRET,
    workerTokens: [WORKER_BEARER_TOKEN],
    leaseTtlMs: 15_000,
    sweepIntervalMs: 250,
  });

  const observedWorkloadsByPhase: Array<{ readonly phase: string; readonly workloadId: string }> = [];
  let portfolioWorkerError: unknown = null;
  const workerAbort = new AbortController();
  const workerPromise = runHardwareWorker({
    config: {
      workerId: 'worker-portfolio-e2e',
      relayUrl: relay.url,
      workerToken: WORKER_BEARER_TOKEN,
      workDir: workerWorkDir,
      heldOutWorkloadsDir: workloadsDir,
      sandboxBackend: 'native_os',
      capabilities: {
        accelerator: 'sm_90a',
        isolationModes: ['whole_device'],
        deviceCount: 1,
        driverVersion: '550.90.07',
        workloadIds: ['decode-bs1-4k', 'decode-bs16-8k', 'decode-portfolio-holdout'],
      },
      pollWaitMs: 40,
      heartbeatIntervalMs: 50,
      requestTimeoutMs: 5_000,
      stageATimeoutMs: 15_000,
      stageBTimeoutMs: 15_000,
      toolchainPaths: [join(process.execPath, '..')],
      probeMode: 'synthetic_fixture',
    },
    once: false,
    signal: workerAbort.signal,
    registerProcessSignalHandlers: false,
    onLeaseAcquired: grant => {
      observedWorkloadsByPhase.push({
        phase: grant.job.heldOutWorkloadId === 'decode-portfolio-holdout' ? 'portfolio' : 'specialist',
        workloadId: grant.job.heldOutWorkloadId,
      });
    },
  }).catch((err: unknown) => {
    if (!workerAbort.signal.aborted) {
      portfolioWorkerError = err;
    }
  });

  try {
    const repoDir = join(tempDir, 'repo');
    const baseRevision = initGitRepo(repoDir, {
      '.loopwright/taskpack.yaml': { content: SINGLE_TARGET_TASKPACK_YAML },
      'src/kernels/flash_decode.cu': { content: BASELINE_KERNEL_SOURCE },
      'scripts/build.sh': { content: portfolioBuildScript, executable: true },
    });

    const bundleRelDir = '.loopwright-out/bundles/portfolio';
    const bundleOutputDir = join(repoDir, bundleRelDir);
    const portfolioCampaignYaml = `
apiVersion: loopwright.dev/v1alpha1
kind: EvolutionCampaign
metadata:
  name: portfolio-flash-decode
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
    islands: 1
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
      full_rewrite: 0.5
      crossover: 0.0
    modelBandit: deterministic-round-robin
    maxCrossoversPerPrompt: 1
  objectives:
    - metric: latency_us_p50
      direction: minimize
    - metric: goodput_rps
      direction: maximize
  budgets:
    maxGenerations: 3
    maxEvaluations: 6
    maxConcurrentEvaluations: 1
    scratchpadIntervalGenerations: 5
  export:
    format: oci-layout
    outputDir: ${bundleRelDir}
`;

    const envMap: Readonly<Record<string, string>> = {
      BENCH_SIGNING_SECRET: BENCH_HMAC_SECRET,
    };

    const specialistContextSnapshots: string[] = [];

    const evaluator = createControllerChildRunEvaluator({
      repositoryRoot: repoDir,
      allowLoopbackHttp: true,
      gateEndpoints: [
        {
          id: 'hw-relay',
          url: `${relay.url}/v1/benchmark/jobs`,
          signingCredentialRef: 'bench-sign',
          implementation: 'benchmark-gate.v1',
          timeoutMs: 10_000,
          maxPollMs: 25_000,
          pollInitialMs: 100,
          pollMaxMs: 250,
          jitter: 10,
        },
      ],
      credentialEnvMap: {
        byCredentialRef: { 'bench-sign': 'BENCH_SIGNING_SECRET' },
      },
      environment: name => envMap[name],
      agentDriver: async stepCtx => {
        if (stepCtx.stagePhase === 'specialist') {
          // Confirm portfolioHeldOutWorkloadId ('decode-portfolio-holdout') is NEVER exposed anywhere in specialist prompt or context!
          specialistContextSnapshots.push(stepCtx.prompt);
          for (const cf of stepCtx.contextFiles) {
            specialistContextSnapshots.push(readFileSync(cf, 'utf8'));
          }
          const registryText = readFileSync(join(stepCtx.childRunDir, 'registry', 'registry.json'), 'utf8');
          const configText = readFileSync(join(stepCtx.childRunDir, 'registry', 'config.json'), 'utf8');
          specialistContextSnapshots.push(registryText, configText);
        }

        const kernelPath = join(stepCtx.workspacePath, 'src/kernels/flash_decode.cu');
        if (stepCtx.stagePhase === 'portfolio') {
          writeFileSync(
            kernelPath,
            BASELINE_KERNEL_SOURCE.replace('return 0; // baseline', 'return 77; // PORTFOLIO_ROUTER_DISPATCH'),
            'utf8',
          );
        } else if (stepCtx.bucketId === 'bs16-isl8k') {
          writeFileSync(
            kernelPath,
            BASELINE_KERNEL_SOURCE.replace('return 0; // baseline', 'return 16; // SPECIALIST_BS16'),
            'utf8',
          );
        } else {
          writeFileSync(
            kernelPath,
            BASELINE_KERNEL_SOURCE.replace('return 0; // baseline', 'return 1; // SPECIALIST_BS1'),
            'utf8',
          );
        }
      },
    });

    const campaignRoot = join(tempDir, 'campaign-portfolio');
    const runRes = await runEvolutionCampaign({
      campaignRoot,
      campaignId: 'camp-portfolio-e2e',
      manifest: portfolioCampaignYaml,
      repositoryRoot: repoDir,
      baseRevision,
      evaluator,
      allowSyntheticProbe: true,
      receiptSigningSecret: BENCH_HMAC_SECRET,
    });

    assert.equal(runRes.campaign.status, 'completed');
    assert.equal(runRes.campaign.stagePhase, 'portfolio');

    // Confirm portfolioHeldOutWorkloadId ('decode-portfolio-holdout') was NEVER exposed in any specialist run!
    assert.ok(specialistContextSnapshots.length > 0);
    for (const snap of specialistContextSnapshots) {
      assert.equal(
        snap.includes('decode-portfolio-holdout'),
        false,
        'portfolioHeldOutWorkloadId must NEVER leak into specialist runs',
      );
    }

    // Confirm Relay/Worker ran specialist workloads first, then decode-portfolio-holdout last
    assert.deepEqual(
      observedWorkloadsByPhase.map(item => item.workloadId),
      ['decode-bs1-4k', 'decode-bs16-8k', 'decode-portfolio-holdout'],
    );

    // Auto-export produced a valid OCI-layout evolution-bundle.v1
    assert.ok(runRes.exportedBundle !== undefined);
    assert.equal(runRes.exportedBundle.format, 'oci-layout');
    assert.equal(runRes.exportedBundle.exportedIndividualIds.length, 3);
    assert.equal(runRes.exportedBundle.blobCount, 3);

    // Verify status & inspect APIs
    const status = await getEvolutionCampaignStatus({ campaignRoot, campaignId: 'camp-portfolio-e2e' });
    assert.equal(status.campaign.status, 'completed');
    assert.equal(status.countsByStatus.passed, 3);

    const inspected = await inspectEvolutionCampaign({ campaignRoot, campaignId: 'camp-portfolio-e2e' });
    const portfolioEdges = inspected.lineageEdges.filter(e => e.role === 'portfolio_member');
    assert.equal(portfolioEdges.length, 2, 'portfolio individual must link both specialist winners as portfolio_member');

    // Verify exported OCI bundle passes verifyEvolutionBundle with HMAC signature check
    const verifiedBundle = await verifyEvolutionBundle({
      bundleDir: bundleOutputDir,
      allowSyntheticProbe: true,
      receiptSigningSecret: BENCH_HMAC_SECRET,
    });
    assert.equal(verifiedBundle.format, 'oci-layout');
    assert.equal(verifiedBundle.receiptCount, 3);
    assert.equal(verifiedBundle.blobCount, 3);

    // Also verify manual re-export to a second directory is deterministic
    const manualExportDir = join(tempDir, 'manual-oci-bundle');
    await exportEvolutionBundle({
      store: runRes.store,
      campaignId: 'camp-portfolio-e2e',
      outputDir: manualExportDir,
      format: 'oci-layout',
      allowSyntheticProbe: true,
      receiptSigningSecret: BENCH_HMAC_SECRET,
    });
    await runRes.store.close();

    // Tamper 1 byte of an exported .cubin blob in bundleOutputDir -> verifyEvolutionBundle MUST fail closed with ARTIFACT_INVALID
    const expectedBs1Digest = sha256Hex(Buffer.from(bs1CubinHex, 'hex'));
    const cubinBlobPath = join(bundleOutputDir, 'blobs', 'sha256', expectedBs1Digest);
    assert.equal(existsSync(cubinBlobPath), true);
    const tampered = Buffer.from(readFileSync(cubinBlobPath));
    tampered[0] = tampered[0]! ^ 0xff;
    writeFileSync(cubinBlobPath, tampered);

    await assert.rejects(
      () => verifyEvolutionBundle({
        bundleDir: bundleOutputDir,
        allowSyntheticProbe: true,
        receiptSigningSecret: BENCH_HMAC_SECRET,
      }),
      (err: unknown) => err instanceof EvolutionError && err.code === 'ARTIFACT_INVALID',
    );
  } finally {
    workerAbort.abort();
    await workerPromise;
    await relay.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
  assert.equal(portfolioWorkerError, null);
});
