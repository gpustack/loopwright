import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { DecisionTransport } from '@loopwright/decisions';
import { runHardwareWorker, startRelayServer } from '@loopwright/hardware-runner';
import { loadDeclarativeTaskpack } from '@loopwright/taskpack';
import {
  buildStageScopedTaskpack,
  collectChildBenchmarkArtifacts,
  createControllerChildRunEvaluator,
  EvolutionCampaignStore,
  EvolutionError,
  exportEvolutionBundle,
  inspectEvolutionCampaign,
  materializeGitCheckoutNoFollow,
  parseEvolutionCampaignDocument,
  resumeEvolutionCampaign,
  runEvolutionCampaign,
  sanitizeRunId,
  stageMultiParentContextFiles,
  type EvolutionBundleManifestV1,
  type TeamPatchV1,
} from '../src/index.js';

const HMAC_SECRET = 'hardening-relay-hmac-secret-0123456789abcdef';
const WORKER_TOKEN = 'hardening-worker-bearer-token-0123456789abcdef';

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function makeDigest(seed: string): { readonly algorithm: 'sha256'; readonly hex: string } {
  return { algorithm: 'sha256', hex: sha256Hex(seed) };
}

function initGitRepo(
  repoDir: string,
  files: Readonly<Record<string, { readonly content: string | Buffer; readonly executable?: boolean }>>,
): string {
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
  execFileSync('git', ['commit', '-m', 'Initial baseline'], { cwd: repoDir, env: gitEnv, stdio: 'ignore' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, env: gitEnv, encoding: 'utf8' }).trim();
}

function buildMinimalElf64(symbolName: string): Buffer {
  const strTab = Buffer.concat([Buffer.from([0]), Buffer.from(`${symbolName}\0`, 'utf8')]);
  const symTab = Buffer.alloc(48, 0);
  symTab.writeUInt32LE(1, 24);
  symTab.writeUInt8(0x12, 28);
  const shStrTab = Buffer.from('\0.strtab\0.symtab\0.shstrtab\0', 'utf8');
  const shStrOffsets = [1, 9, 17];
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
  ehdr[4] = 2;
  ehdr[5] = 1;
  ehdr[6] = 1;
  ehdr.writeUInt16LE(2, 16);
  ehdr.writeUInt16LE(190, 18);
  ehdr.writeUInt32LE(1, 20);
  ehdr.writeUInt16LE(64, 52);
  ehdr.writeUInt16LE(64, 58);
  ehdr.writeUInt16LE(4, 60);
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

const KERNEL_SRC = [
  '// header',
  '// EVOLVE-BLOCK-START: decode',
  'int decode_kernel() { return 0; }',
  '// EVOLVE-BLOCK-END: decode',
  '',
].join('\n');

const MULTI_CELL_TASKPACK_YAML = `
apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: hardening-taskpack
spec:
  goal:
    candidate: Optimize decode kernel inside EVOLVE-BLOCK.
    noChange: No kernel change.
  target:
    matrix:
      - id: cuda-h100-whole
        platform: linux/amd64
        variant: cuda12
        hardware:
          accelerator: sm_90a
          isolationMode: whole_device
          deviceCount: 1
          driverConstraint: ">=550.54"
          forbiddenSymbolPatterns: [cublas]
      - id: rocm-mi300x-whole
        platform: linux/amd64
        variant: rocm6
        hardware:
          accelerator: gfx942
          isolationMode: whole_device
          deviceCount: 1
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
    - id: mutator
      provider: anthropic
      model: claude-sonnet-4-6
      purpose: task
      tools: [read, write, edit, bash]
      instructions:
        - docs/role-guide.md
      prompt: Edit kernel inside EVOLVE-BLOCK.
    - id: reviewer
      provider: anthropic
      model: claude-sonnet-4-6
      purpose: review
      dependsOn: [mutator]
      tools: [read]
      prompt: Review kernel diff.
  verification:
    localChecks:
      - id: evolve-guard
        implementation: evolve-block-guard.v1
        parameters:
          files:
            - src/kernels/decode.cu
    externalGates:
      - id: gpu-bench-cuda
        implementation: benchmark-gate.v1
        endpointId: hw-relay
        gateId: decode-cuda-bench
        required: true
        targetCellId: cuda-h100-whole
        heldOutWorkloadId: cuda-default-workload
        allowSyntheticHardwareProbe: true
      - id: gpu-bench-rocm
        implementation: benchmark-gate.v1
        endpointId: hw-relay
        gateId: decode-rocm-bench
        required: false
        targetCellId: rocm-mi300x-whole
        heldOutWorkloadId: rocm-untouched-workload
        allowSyntheticHardwareProbe: true
  publication:
    mode: disabled
  triggers:
    schedule: false
    workflowDispatch: true
    releasePublished: false
    commentCommands: []
`;

const BASE_CAMPAIGN_YAML = `
apiVersion: loopwright.dev/v1alpha1
kind: EvolutionCampaign
metadata:
  name: hardening-campaign
spec:
  taskpack: .loopwright/taskpack.yaml
  targetCellId: cuda-h100-whole
  tracks: [triton, tilelang]
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
  sampling:
    noveltyDecayLambda: 1.0
    mutationWeights:
      diff_tune: 0.4
      full_rewrite: 0.2
      crossover: 0.4
    modelBandit: deterministic-round-robin
    maxCrossoversPerPrompt: 2
  objectives:
    - metric: latency_us_p50
      direction: minimize
    - metric: goodput_rps
      direction: maximize
  budgets:
    maxGenerations: 2
    maxEvaluations: 4
    maxConcurrentEvaluations: 2
    scratchpadIntervalGenerations: 1
`;

test('sanitizeRunId emits controller-valid lowercase <= 64-char IDs and preserves trailing hex nonces', () => {
  const controllerRe = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

  const upperColon = sanitizeRunId('ind-g1-i0-Decode_BS16:4k-a1b2c3');
  assert.match(upperColon, controllerRe);
  assert.equal(upperColon, upperColon.toLowerCase());
  assert.ok(upperColon.endsWith('-a1b2c3'));

  const leadingDigit = sanitizeRunId('99-Bucket:Upper');
  assert.match(leadingDigit, controllerRe);

  const reserved = sanitizeRunId('__proto__');
  assert.match(reserved, controllerRe);
  assert.notEqual(reserved, '__proto__');

  const longBucket = 'Decode_BS128_ISL32768_FP8_PagedKV_SplitK_Persistent_Cluster_90a';
  const idA = sanitizeRunId(`ind-g12-i3-${longBucket}-deadbeef`);
  const idB = sanitizeRunId(`ind-g12-i3-${longBucket}-cafebabe`);
  assert.ok(idA.length <= 64);
  assert.ok(idB.length <= 64);
  assert.match(idA, controllerRe);
  assert.match(idB, controllerRe);
  assert.ok(idA.endsWith('-deadbeef'));
  assert.ok(idB.endsWith('-cafebabe'));
  assert.notEqual(idA, idB);
});

test('buildStageScopedTaskpack scopes heldOutWorkloadId strictly to targetCellId, resolves cross-provider models, and tampered team_configs fail closed on reload', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'evo-hardening-scoped-'));
  try {
    const taskpack = await loadDeclarativeTaskpack({
      bytes: Buffer.from(MULTI_CELL_TASKPACK_YAML, 'utf8'),
      format: 'yaml',
      executionMode: 'delegated',
      allowLoopbackHttp: true,
    });

    const patch: TeamPatchV1 = {
      kind: 'TeamPatch',
      schemaVersion: 'team-patch.v1',
      diagnosis: {
        summary: 'Test scoped taskpack',
        plateauCategory: 'coupled_responsibilities',
        rationale: 'Verify thinking, timeoutSeconds, onRework, and targetCellId scoping',
      },
      roles: [
        {
          id: 'mutator-fast',
          archetypeRoleId: 'mutator',
          purpose: 'task',
          tools: ['read', 'edit'],
          model: 'gpt-5.4',
          thinking: 'low',
          timeoutSeconds: 75,
          prompt: 'Edit kernel.',
        },
        {
          id: 'rev-gate',
          archetypeRoleId: 'reviewer',
          purpose: 'review',
          tools: ['read'],
          model: 'claude-sonnet-4-6',
          thinking: 'high',
          timeoutSeconds: 30,
          prompt: 'Check diff.',
        },
      ],
      steps: [
        { id: 'step-mut', roleId: 'mutator-fast', dependsOn: [] },
        {
          id: 'step-rev',
          roleId: 'rev-gate',
          dependsOn: ['step-mut'],
          onRework: { rejectTo: 'step-mut', maxReworks: 2 },
        },
      ],
    };

    const scoped = buildStageScopedTaskpack({
      taskpack,
      heldOutWorkloadId: 'specialist-cuda-bs1',
      targetCellId: 'cuda-h100-whole',
      teamPatch: patch,
    });

    const cudaGate = scoped.spec.verification.externalGates.find(g => g.id === 'gpu-bench-cuda');
    const rocmGate = scoped.spec.verification.externalGates.find(g => g.id === 'gpu-bench-rocm');
    assert.equal(cudaGate?.heldOutWorkloadId, 'specialist-cuda-bs1');
    assert.equal(rocmGate?.heldOutWorkloadId, 'rocm-untouched-workload', 'non-target cell gate must NEVER be overwritten');

    const mutatorFast = scoped.spec.roles?.find(r => r.id === 'mutator-fast');
    const revGate = scoped.spec.roles?.find(r => r.id === 'rev-gate');
    assert.equal(mutatorFast?.provider, 'openai', 'cross-provider role.model must resolve provider from Taskpack.spec.models');
    assert.equal(mutatorFast?.model, 'gpt-5.4');
    assert.equal(mutatorFast?.thinking, 'low');
    assert.equal(revGate?.provider, 'anthropic');
    assert.equal(revGate?.model, 'claude-sonnet-4-6');
    assert.equal(revGate?.thinking, 'high');
    assert.equal(scoped.spec.limits?.toolTimeoutSeconds, 75);
    assert.deepEqual(
      scoped.spec.steps?.find(s => s.id === 'step-rev')?.onRework,
      { rejectTo: 'step-mut', maxReworks: 2 },
    );

    // Explicit provider/model syntax in TeamPatch also resolves to bare model ID + matched provider
    const scopedQualified = buildStageScopedTaskpack({
      taskpack,
      heldOutWorkloadId: 'specialist-cuda-bs1',
      targetCellId: 'cuda-h100-whole',
      teamPatch: {
        ...patch,
        roles: [
          { ...patch.roles[0]!, model: 'openai/gpt-5.4' },
          patch.roles[1]!,
        ],
      },
    });
    const qualifiedMutator = scopedQualified.spec.roles?.find(r => r.id === 'mutator-fast');
    assert.equal(qualifiedMutator?.provider, 'openai');
    assert.equal(qualifiedMutator?.model, 'gpt-5.4');

    // Reloading a tampered team_configs patch from campaign.sqlite MUST fail closed with TEAM_ENVELOPE_VIOLATION!
    const repoDir = join(tempDir, 'repo');
    const baseRevision = initGitRepo(repoDir, {
      '.loopwright/taskpack.yaml': { content: MULTI_CELL_TASKPACK_YAML },
      'docs/role-guide.md': { content: '# Role Guide\nKeep coalesced loads.\n' },
      'src/kernels/decode.cu': { content: KERNEL_SRC },
    });
    const campaignRoot = join(tempDir, 'camp-tamper-team');
    const abortAfter1 = new AbortController();

    await runEvolutionCampaign({
      campaignRoot,
      campaignId: 'camp-tamper-team',
      manifest: BASE_CAMPAIGN_YAML.replace('islands: 2', 'islands: 1'),
      repositoryRoot: repoDir,
      baseRevision,
      signal: abortAfter1.signal,
      evaluator: async () => {
        abortAfter1.abort();
        return {
          status: 'passed',
          codeSlice: '// EVOLVE-BLOCK-START: decode\nint decode_kernel() { return 1; }\n// EVOLVE-BLOCK-END: decode\n',
          metrics: { latency_us_p50: 50, goodput_rps: 2000 },
          evidenceDigest: makeDigest('ev-1'),
        };
      },
    });

    // Inject a rogue TeamPatch into campaign.sqlite CAS and activate it on Island 0 while teamEvolution is NOT enabled!
    const store = await EvolutionCampaignStore.open({ campaignRoot });
    const lease = await store.acquireLease('tamper-writer');
    const incumbentIsl0 = (await store.getIsland('camp-tamper-team', 0))!;
    const roguePatchBytes = Buffer.from(
      JSON.stringify({
        ...patch,
        roles: [
          {
            id: 'rogue-role',
            archetypeRoleId: 'reviewer',
            purpose: 'task',
            tools: ['read', 'write', 'delete'],
            prompt: 'Escalate tools beyond reviewer archetype.',
          },
        ],
        steps: [{ id: 'step-rogue', roleId: 'rogue-role', dependsOn: [] }],
      }),
      'utf8',
    );
    const rogueCas = await store.writeCasBlob(roguePatchBytes);
    await store.createTrialTeamConfig(lease, {
      teamConfigId: 'rogue-team-cfg',
      campaignId: 'camp-tamper-team',
      islandId: 0,
      parentTeamConfigId: incumbentIsl0.activeTeamConfigId,
      createdGeneration: 1,
      trialBudgetGenerations: 2,
      diagnosis: {
        summary: 'Tampered team config injected into SQLite',
        plateauCategory: 'other',
        rationale: 'Must be rejected on campaign reload',
      },
      patchCasDigest: rogueCas.digest,
    });
    await store.close();

    // 1. Fails when teamEvolution.enabled !== true
    await assert.rejects(
      () => resumeEvolutionCampaign({
        campaignRoot,
        campaignId: 'camp-tamper-team',
        repositoryRoot: repoDir,
        evaluator: async () => ({
          status: 'passed',
          codeSlice: '// never reached\n',
          metrics: { latency_us_p50: 40, goodput_rps: 2200 },
        }),
      }),
      (err: unknown) => err instanceof EvolutionError && err.code === 'TEAM_ENVELOPE_VIOLATION',
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('refuses overlapping campaignRoot/repositoryRoot and materializes Git checkouts cleanly around untracked node_modules/.bin symlinks while refusing tracked symlinks', async () => {
  const tempDir = mkdtempSync(join(realpathSync(tmpdir()), 'evo-hardening-checkout-'));
  try {
    const repoDir = join(tempDir, 'repo');
    initGitRepo(repoDir, {
      '.loopwright/taskpack.yaml': { content: MULTI_CELL_TASKPACK_YAML },
      'docs/role-guide.md': { content: '# Guide\n' },
      'src/kernels/decode.cu': { content: KERNEL_SRC },
      'scripts/build.sh': { content: '#!/bin/sh\nexit 0\n', executable: true },
    });

    // Add untracked node_modules/.bin/tsc symlink inside repoDir!
    mkdirSync(join(repoDir, 'node_modules', 'typescript', 'bin'), { recursive: true });
    mkdirSync(join(repoDir, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(repoDir, 'node_modules', 'typescript', 'bin', 'tsc'), '#!/usr/bin/env node\n');
    symlinkSync('../typescript/bin/tsc', join(repoDir, 'node_modules', '.bin', 'tsc'));

    // 1. Overlapping campaignRoot inside repositoryRoot -> EVOLUTION_SCHEMA_INVALID before creating campaign.sqlite
    const nestedCampaignRoot = join(repoDir, '.loopwright-campaign');
    await assert.rejects(
      () => runEvolutionCampaign({
        campaignRoot: nestedCampaignRoot,
        manifest: BASE_CAMPAIGN_YAML,
        repositoryRoot: repoDir,
        evaluator: async () => ({ status: 'passed', codeSlice: '', metrics: {} }),
      }),
      (err: unknown) =>
        err instanceof EvolutionError
        && err.code === 'EVOLUTION_SCHEMA_INVALID'
        && /campaignRoot must live outside repositoryRoot/.test(err.message),
    );
    assert.equal(existsSync(nestedCampaignRoot), false);

    // Also reject repositoryRoot inside campaignRoot and equal roots on resumeEvolutionCampaign
    await assert.rejects(
      () => resumeEvolutionCampaign({
        campaignRoot: tempDir,
        repositoryRoot: repoDir,
        evaluator: async () => ({ status: 'passed', codeSlice: '', metrics: {} }),
      }),
      (err: unknown) => err instanceof EvolutionError && err.code === 'EVOLUTION_SCHEMA_INVALID',
    );

    // 2. materializeGitCheckoutNoFollow succeeds cleanly despite node_modules/.bin/tsc symlink and preserves 0o755 mode
    const checkoutDst = join(tempDir, 'materialized-checkout');
    await materializeGitCheckoutNoFollow(repoDir, checkoutDst);
    assert.equal(existsSync(join(checkoutDst, 'src', 'kernels', 'decode.cu')), true);
    assert.equal(existsSync(join(checkoutDst, 'node_modules')), false);
    assert.equal(lstatSync(join(checkoutDst, 'scripts', 'build.sh')).mode & 0o111, 0o111);

    // 3. Tracked symlink committed to Git MUST be refused with EVOLUTION_SYMLINK_FORBIDDEN
    const badRepoDir = join(tempDir, 'bad-symlink-repo');
    initGitRepo(badRepoDir, {
      'README.md': { content: 'hi\n' },
    });
    symlinkSync('README.md', join(badRepoDir, 'tracked-link.md'));
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Loopwright Test',
      GIT_AUTHOR_EMAIL: 'test@loopwright.dev',
      GIT_COMMITTER_NAME: 'Loopwright Test',
      GIT_COMMITTER_EMAIL: 'test@loopwright.dev',
    };
    execFileSync('git', ['add', 'tracked-link.md'], { cwd: badRepoDir, env: gitEnv, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'Add tracked symlink'], { cwd: badRepoDir, env: gitEnv, stdio: 'ignore' });

    await assert.rejects(
      () => materializeGitCheckoutNoFollow(badRepoDir, join(tempDir, 'bad-checkout')),
      (err: unknown) => err instanceof EvolutionError && err.code === 'EVOLUTION_SYMLINK_FORBIDDEN',
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('concurrent child evaluator never mutates process.env, preserves evo-parent-* & evo-scratchpad in role.resourceIds, rejects cosmetic clone BEFORE benchmark-gate.v1 dispatch, and forwards driverConstraint', async () => {
  const tempDir = mkdtempSync(join(realpathSync(tmpdir()), 'evo-hardening-child-'));
  const relayCasDir = join(tempDir, 'relay-cas');
  const workerWorkDir = join(tempDir, 'worker-work');
  const workloadsDir = join(tempDir, 'workloads');
  mkdirSync(workerWorkDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(workloadsDir, 'cuda-default-workload'), { recursive: true, mode: 0o700 });

  const evalScript = [
    `#!${process.execPath}`,
    'const payload = {',
    '  status: "approved",',
    '  metrics: { latency_us_p50: 40, goodput_rps: 2500 },',
    '  hardwareDiagnostics: { boundPipeline: "tensor_cube", occupancyPct: 75, rooflineHeadroom: 1.15 }',
    '};',
    'process.stdout.write("LOOPWRIGHT_STAGE_B_RESULT:" + JSON.stringify(payload) + "\\n");',
  ].join('\n');
  const evalScriptPath = join(workloadsDir, 'cuda-default-workload', 'evaluate.sh');
  writeFileSync(evalScriptPath, evalScript, { mode: 0o755 });
  chmodSync(evalScriptPath, 0o755);

  const cubinHex = buildMinimalElf64('decode_sm90a_kernel').toString('hex');
  const buildScript = [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    `fs.writeFileSync(path.join(process.env.LOOPWRIGHT_STAGE_A_OUT, "decode.cubin"), Buffer.from(${JSON.stringify(cubinHex)}, "hex"));`,
  ].join('\n');

  const relay = await startRelayServer({
    port: 0,
    casDir: relayCasDir,
    controllerSigningSecret: HMAC_SECRET,
    workerTokens: [WORKER_TOKEN],
    leaseTtlMs: 30_000,
    sweepIntervalMs: 200,
  });

  let workerLeases = 0;
  let workerFatalError: unknown = null;
  const workerAbort = new AbortController();
  const workerPromise = runHardwareWorker({
    config: {
      workerId: 'worker-hardening',
      relayUrl: relay.url,
      workerToken: WORKER_TOKEN,
      workDir: workerWorkDir,
      heldOutWorkloadsDir: workloadsDir,
      sandboxBackend: 'native_os',
      capabilities: {
        accelerator: 'sm_90a',
        isolationModes: ['whole_device'],
        deviceCount: 1,
        driverVersion: '555.42.02',
        workloadIds: ['cuda-default-workload'],
      },
      pollWaitMs: 50,
      heartbeatIntervalMs: 50,
      requestTimeoutMs: 10_000,
      stageATimeoutMs: 45_000,
      stageBTimeoutMs: 45_000,
      toolchainPaths: [join(process.execPath, '..')],
      probeMode: 'synthetic_fixture',
    },
    once: false,
    signal: workerAbort.signal,
    registerProcessSignalHandlers: false,
    onLeaseAcquired: () => {
      workerLeases += 1;
    },
  }).catch((err: unknown) => {
    if (!workerAbort.signal.aborted) {
      workerFatalError = err;
    }
  });

  const secretEnvVarName = 'LW_ISOLATED_TEST_SIGNING_KEY_SC2';
  assert.equal(process.env[secretEnvVarName], undefined);

  try {
    const repoDir = join(tempDir, 'repo');
    const singleGateTaskpack = MULTI_CELL_TASKPACK_YAML.slice(
      0,
      MULTI_CELL_TASKPACK_YAML.indexOf('      - id: gpu-bench-rocm'),
    ) + MULTI_CELL_TASKPACK_YAML.slice(MULTI_CELL_TASKPACK_YAML.indexOf('  publication:'));

    const baseRevision = initGitRepo(repoDir, {
      '.loopwright/taskpack.yaml': { content: singleGateTaskpack },
      'docs/role-guide.md': { content: '# Role Guide\nUse vectorized loads.\n' },
      'src/kernels/decode.cu': { content: KERNEL_SRC },
      'scripts/build.sh': { content: buildScript, executable: true },
    });
    // Also place an untracked node_modules/.bin symlink inside repoDir to prove createControllerChildRunEvaluator handles it!
    mkdirSync(join(repoDir, 'node_modules', '.bin'), { recursive: true });
    symlinkSync('../../scripts/build.sh', join(repoDir, 'node_modules', '.bin', 'fake-bin'));

    const bundleRelDir = '.loopwright-out/bundles/hardening';
    const bundleOutDir = join(repoDir, bundleRelDir);
    const campaignYaml = `${BASE_CAMPAIGN_YAML}  export:\n    format: dir\n    outputDir: ${bundleRelDir}\n`;

    let sawParentContextInAgent = false;
    let sawScratchpadInAgent = false;
    let sawProcessEnvMutation = false;

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
          maxPollMs: 120_000,
          pollInitialMs: 100,
          pollMaxMs: 250,
          jitter: 10,
        },
      ],
      credentialEnvMap: {
        byCredentialRef: { 'bench-sign': secretEnvVarName },
      },
      environment: name => (name === secretEnvVarName ? HMAC_SECRET : undefined),
      agentDriver: async ctx => {
        if (process.env[secretEnvVarName] !== undefined) {
          sawProcessEnvMutation = true;
        }
        for (const cf of ctx.contextFiles) {
          if (cf.includes('parent-0.json')) sawParentContextInAgent = true;
          if (cf.includes('latest.md')) sawScratchpadInAgent = true;
        }
        const kernelPath = join(ctx.workspacePath, 'src/kernels/decode.cu');
        if (ctx.generation === 1) {
          writeFileSync(
            kernelPath,
            KERNEL_SRC.replace('return 0;', `return ${10 + ctx.islandId};`),
            'utf8',
          );
        } else if (ctx.islandId === 0) {
          // Gen 2 Island 0: cosmetic comment/whitespace clone of Gen 1 Island 0 (return 10;) -> MUST be rejected BEFORE benchmark-gate.v1!
          writeFileSync(
            kernelPath,
            '// header\n// EVOLVE-BLOCK-START: decode\n/* cosmetic comment */\nint   decode_kernel( ) {\n  return 10; // exact token clone\n}\n// EVOLVE-BLOCK-END: decode\n',
            'utf8',
          );
        } else {
          // Gen 2 Island 1: genuinely novel mutation -> dispatches benchmark-gate.v1
          writeFileSync(
            kernelPath,
            KERNEL_SRC.replace('return 0;', 'return 99; /* novel_gen2 */'),
            'utf8',
          );
        }
      },
    });

    const campaignRoot = join(tempDir, 'campaign-run');
    const res = await runEvolutionCampaign({
      campaignRoot,
      campaignId: 'camp-sc2-sh3-pm2',
      manifest: campaignYaml,
      repositoryRoot: repoDir,
      baseRevision,
      evaluator,
      allowSyntheticProbe: true,
      receiptSigningSecret: HMAC_SECRET,
    });

    // Zero process.env mutation during or after concurrent child runs
    assert.equal(sawProcessEnvMutation, false);
    assert.equal(process.env[secretEnvVarName], undefined);

    // evo-parent-0 and evo-scratchpad are preserved in role.resourceIds despite role-level instructions
    assert.equal(sawParentContextInAgent, true, 'evo-parent-0 must be exposed in contextFiles when role.instructions is set');
    assert.equal(sawScratchpadInAgent, true, 'evo-scratchpad must be exposed in contextFiles when role.instructions is set');

    // Gen 1 ran 2 worker leases (Island 0 + Island 1); Gen 2 Island 0 clone was rejected pre-gate (0 leases), Gen 2 Island 1 ran 1 lease -> total 3 leases
    const recordedSummary = JSON.stringify(
      (await res.store.listIndividuals('camp-sc2-sh3-pm2')).map(ind => ({
        id: ind.individualId,
        gen: ind.generation,
        isl: ind.islandId,
        status: ind.status,
        reason: ind.failureReason,
      })),
    );
    assert.equal(workerFatalError, null, `hardware worker threw unexpectedly: ${String(workerFatalError)}`);
    assert.equal(
      res.noveltyRejectionsCount,
      1,
      `expected 1 novelty rejection (workerLeases=${workerLeases}, individuals=${recordedSummary})`,
    );
    assert.equal(workerLeases, 3, `cosmetic clone must be rejected BEFORE benchmark-gate.v1 acquires any worker lease (individuals=${recordedSummary})`);
    assert.equal(res.campaign.evaluationsUsed, 3, `individuals=${recordedSummary}`);

    // Auto-exported bundle carries hardware.driverConstraint (">=550.54") in compatibility
    assert.ok(res.exportedBundle !== undefined);
    const bundleManifest = JSON.parse(
      readFileSync(join(bundleOutDir, 'manifest.json'), 'utf8'),
    ) as EvolutionBundleManifestV1;
    assert.equal(bundleManifest.compatibility.driverConstraint, '>=550.54');

    await res.store.close();
  } finally {
    workerAbort.abort();
    await workerPromise;
    await relay.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('specialist-then-portfolio supports 5..64 specialist buckets and resets per-island roofline/stall state across buckets', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'evo-hardening-buckets-'));
  try {
    // Verify stageMultiParentContextFiles still enforces <= 4 crossover donors
    await assert.rejects(
      () => stageMultiParentContextFiles({
        stagingDir: join(tempDir, 'bad-crossover'),
        maxCrossoversPerPrompt: 5,
        parents: [],
      }),
      (err: unknown) => err instanceof EvolutionError && err.code === 'EVOLUTION_SCHEMA_INVALID',
    );

    const repoDir = join(tempDir, 'repo');
    const baseRevision = initGitRepo(repoDir, {
      '.loopwright/taskpack.yaml': { content: MULTI_CELL_TASKPACK_YAML },
      'docs/role-guide.md': { content: '# Guide\n' },
      'src/kernels/decode.cu': { content: KERNEL_SRC },
    });

    // 5 specialist buckets + teamEvolution + targetRooflineHeadroom = 1.10
    // Bucket 0 hits headroom 1.05 (<= 1.10); Bucket 1 stalls for 2 generations with headroom 1.45 -> supervisor MUST fire in Bucket 1!
    const fiveBucketYaml = `
apiVersion: loopwright.dev/v1alpha1
kind: EvolutionCampaign
metadata:
  name: five-bucket-portfolio
spec:
  taskpack: .loopwright/taskpack.yaml
  targetCellId: cuda-h100-whole
  stages:
    mode: specialist-then-portfolio
    specialistBuckets:
      - id: bucket-0
        heldOutWorkloadId: wl-0
      - id: bucket-1
        heldOutWorkloadId: wl-1
      - id: bucket-2
        heldOutWorkloadId: wl-2
      - id: bucket-3
        heldOutWorkloadId: wl-3
      - id: bucket-4
        heldOutWorkloadId: wl-4
    portfolioHeldOutWorkloadId: wl-portfolio
  population:
    islands: 1
    migrationIntervalGenerations: 4
    maxMigrationElites: 1
    nicheAxes:
      - id: bound_pipeline
        kind: enum
        values: [hbm, tensor_cube]
  sampling:
    noveltyDecayLambda: 1.0
    mutationWeights:
      diff_tune: 0.5
      full_rewrite: 0.5
      crossover: 0.0
    maxCrossoversPerPrompt: 1
  teamEvolution:
    enabled: true
    supervisorRoleId: reviewer
    allowedArchetypeRoles: [mutator, reviewer]
    stallGenerations: 2
    minHypervolumeDelta: 0.01
    triggerOnRunEvalPathology: false
    trialGenerations: 2
    maxTeamSize: 2
    maxTeamSteps: 2
  objectives:
    - metric: latency_us_p50
      direction: minimize
  budgets:
    maxGenerations: 16
    maxEvaluations: 25
    maxConcurrentEvaluations: 1
    targetRooflineHeadroom: 1.10
    scratchpadIntervalGenerations: 10
`;

    const supervisorBucketsObserved: Array<string | null> = [];
    let observedPortfolioParentFiles = 0;

    const res = await runEvolutionCampaign({
      campaignRoot: join(tempDir, 'camp-5buckets'),
      campaignId: 'camp-5buckets',
      manifest: fiveBucketYaml,
      repositoryRoot: repoDir,
      baseRevision,
      supervisorRunner: async ctx => {
        supervisorBucketsObserved.push(ctx.island.bestRooflineHeadroom !== null ? String(ctx.island.bestRooflineHeadroom) : 'null');
        return JSON.stringify({
          kind: 'TeamPatch',
          schemaVersion: 'team-patch.v1',
          diagnosis: {
            summary: 'Bucket 1 stalled after Bucket 0 hit roofline',
            plateauCategory: 'coupled_responsibilities',
            rationale: 'Verify per-bucket reset allowed supervisor invocation in Bucket 1',
          },
          roles: [
            {
              id: 'mut-tuned',
              archetypeRoleId: 'mutator',
              purpose: 'task',
              tools: ['read', 'edit'],
              prompt: 'Tune bucket.',
            },
          ],
          steps: [{ id: 'step-mut-tuned', roleId: 'mut-tuned', dependsOn: [] }],
        });
      },
      evaluator: async proposal => {
        if (proposal.stagePhase === 'portfolio') {
          observedPortfolioParentFiles = proposal.stagedParentFiles.length;
          return {
            status: 'passed',
            codeSlice: '// EVOLVE-BLOCK-START: decode\nint decode_kernel() { return 555; }\n// EVOLVE-BLOCK-END: decode\n',
            metrics: { latency_us_p50: 35 },
            hardwareDiagnostics: { boundPipeline: 'tensor_cube', rooflineHeadroom: 1.06 },
            evidenceDigest: makeDigest(`ev-${proposal.individualId}`),
          };
        }
        if (proposal.bucketId === 'bucket-0') {
          // Hits targetRooflineHeadroom 1.05 <= 1.10 immediately in bucket-0!
          return {
            status: 'passed',
            codeSlice: `// EVOLVE-BLOCK-START: decode\nint decode_kernel() { return ${100 + proposal.generation}; }\n// EVOLVE-BLOCK-END: decode\n`,
            metrics: { latency_us_p50: 30 },
            hardwareDiagnostics: { boundPipeline: 'tensor_cube', rooflineHeadroom: 1.05 },
            evidenceDigest: makeDigest(`ev-${proposal.individualId}`),
          };
        }
        if (proposal.bucketId === 'bucket-1') {
          // Stalls across its 2 generations (same latency 90, headroom 1.45 > 1.10) -> triggers supervisor on 2nd no-gain gen!
          return {
            status: 'passed',
            codeSlice: `// EVOLVE-BLOCK-START: decode\nint decode_kernel() { return ${200 + proposal.generation}; }\n// EVOLVE-BLOCK-END: decode\n`,
            metrics: { latency_us_p50: 90 },
            hardwareDiagnostics: { boundPipeline: 'hbm', rooflineHeadroom: 1.45 },
            evidenceDigest: makeDigest(`ev-${proposal.individualId}`),
          };
        }
        return {
          status: 'passed',
          codeSlice: `// EVOLVE-BLOCK-START: decode\nint decode_kernel() { return ${300 + proposal.generation}; }\n// EVOLVE-BLOCK-END: decode\n`,
          metrics: { latency_us_p50: 45 },
          hardwareDiagnostics: { boundPipeline: 'tensor_cube', rooflineHeadroom: 1.05 },
          evidenceDigest: makeDigest(`ev-${proposal.individualId}`),
        };
      },
    });

    assert.equal(res.campaign.status, 'completed');
    assert.equal(observedPortfolioParentFiles, 5, 'stagePortfolioSpecialistContextFiles must stage all 5 specialist winners');
    assert.ok(supervisorBucketsObserved.length >= 1, 'bucket-0 roofline must NOT suppress plateau supervision in bucket-1');
    await res.store.close();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('wires decisionPolicy/transport mutationKind & declaredTracks, caps >64 island history slices without crashing, and retains soft_passed stepping stones in MAP-Elites niches without exporting them', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'evo-hardening-decisions-'));
  try {
    const repoDir = join(tempDir, 'repo');
    const taskpackWithDecisions = MULTI_CELL_TASKPACK_YAML.replace(
      '  publication:',
      '  decisions:\n    enabled: true\n    provider: typesafe-jev\n    disclosurePolicy: repo-approved-redacted-evidence\n  publication:',
    );
    const baseRevision = initGitRepo(repoDir, {
      '.loopwright/taskpack.yaml': { content: taskpackWithDecisions },
      'docs/role-guide.md': { content: '# Guide\n' },
      'src/kernels/decode.cu': { content: KERNEL_SRC },
    });

    const campaignRoot = join(tempDir, 'camp-decisions');
    let transportStrategyCalls = 0;

    // Mock System-One DecisionTransport returning 'tilelang' + 'crossover' when available
    const mockTransport: DecisionTransport = {
      send: async req => {
        const body = JSON.parse(req.body) as {
          questions: Record<string, { type: string; criteria?: Record<string, string> }>;
        };
        const answers: Record<string, unknown> = {};
        for (const [qId, q] of Object.entries(body.questions)) {
          if (q.type === 'choice' && q.criteria !== undefined) {
            transportStrategyCalls += 1;
            const keys = Object.keys(q.criteria);
            const pick = keys.includes('tilelang')
              ? 'tilelang'
              : (keys.includes('crossover') ? 'crossover' : keys[0]!);
            const probabilities: Record<string, number> = {};
            for (const k of keys) {
              probabilities[k] = k === pick ? 1 : 0;
            }
            answers[qId] = { type: 'choice', choice: pick, confidence: 0.95, probabilities };
          } else if (q.type === 'noul') {
            answers[qId] = { type: 'noul', noul: 0.05 };
          }
        }
        return {
          status: 200,
          body: JSON.stringify({ answers }),
        };
      },
    };

    const threeGenOneIslandYaml = BASE_CAMPAIGN_YAML
      .replace('islands: 2', 'islands: 1')
      .replace('maxGenerations: 2', 'maxGenerations: 3')
      .replace('maxEvaluations: 4', 'maxEvaluations: 3');

    const observedTracks: string[] = [];
    const observedMutations: string[] = [];

    const res = await runEvolutionCampaign({
      campaignRoot,
      campaignId: 'camp-pw1-pw2',
      manifest: threeGenOneIslandYaml,
      repositoryRoot: repoDir,
      baseRevision,
      decisionTransport: mockTransport,
      decisionApiKey: 'test-jev-api-key-pw1',
      evaluator: async proposal => {
        observedTracks.push(proposal.trackId);
        observedMutations.push(proposal.mutationKind);
        if (proposal.generation === 1) {
          // Gen 1: passed in hbm niche (latency 50)
          return {
            status: 'passed',
            codeSlice: '// EVOLVE-BLOCK-START: decode\nint decode_kernel() { return 1; }\n// EVOLVE-BLOCK-END: decode\n',
            metrics: { latency_us_p50: 50, goodput_rps: 2000 },
            hardwareDiagnostics: { boundPipeline: 'hbm', rooflineHeadroom: 1.4 },
            evidenceDigest: makeDigest('ev-g1'),
          };
        }
        if (proposal.generation === 2) {
          // Gen 2: smokeMetrics severely regressed (500 vs parent 50) -> cascade prunes to soft_passed in smem_lds_ub niche!
          return {
            status: 'passed',
            codeSlice: '// EVOLVE-BLOCK-START: decode\nint decode_kernel() { return 2; }\n// EVOLVE-BLOCK-END: decode\n',
            metrics: { latency_us_p50: 85, goodput_rps: 1600 },
            smokeMetrics: { latency_us_p50: 500 },
            hardwareDiagnostics: { boundPipeline: 'smem_lds_ub', rooflineHeadroom: 1.5 },
            evidenceDigest: makeDigest('ev-g2'),
          };
        }
        // Gen 3: Island 0 now has 2 niches (hbm passed + smem_lds_ub soft_passed!) -> mockTransport picks crossover!
        return {
          status: 'passed',
          codeSlice: '// EVOLVE-BLOCK-START: decode\nint decode_kernel() { return 3; }\n// EVOLVE-BLOCK-END: decode\n',
          metrics: { latency_us_p50: 38, goodput_rps: 2600 },
          hardwareDiagnostics: { boundPipeline: 'tensor_cube', rooflineHeadroom: 1.12 },
          evidenceDigest: makeDigest('ev-g3'),
        };
      },
    });

    assert.ok(transportStrategyCalls >= 2, 'taskpack.spec.decisions + decisionTransport must invoke System-One router');
    assert.ok(observedTracks.every(t => t === 'triton' || t === 'tilelang'), 'tracks must be restricted to manifest.spec.tracks');
    assert.ok(observedTracks.includes('tilelang'));
    assert.equal(res.cascadeSoftStopsCount, 1);
    assert.equal(observedMutations[2], 'crossover', 'Gen 3 must honor strategyDecision.mutationKind === crossover using soft_passed second niche!');

    const inspected = await inspectEvolutionCampaign({ campaignRoot, campaignId: 'camp-pw1-pw2' });
    const isl0Elites = inspected.nicheArchives.find(a => a.islandId === 0)!.elites;
    assert.equal(isl0Elites.some(e => e.status === 'soft_passed' && e.nicheKey === 'bound_pipeline=smem_lds_ub'), true);
    assert.equal(inspected.paretoFrontier.every(e => e.status === 'passed'), true);

    // Seed 70 passed individuals on Island 0 (> 64 DECISION_NOVELTY_MAX_HISTORY_SLICES) and resume without overflowing novelty history cap
    await res.store.close();

    const seventyRoot = join(tempDir, 'camp-70-slices');
    const seventyYaml = BASE_CAMPAIGN_YAML
      .replace('islands: 2', 'islands: 1')
      .replace('maxGenerations: 2', 'maxGenerations: 2')
      .replace('maxEvaluations: 4', 'maxEvaluations: 2');
    const abortGen1 = new AbortController();
    const first70 = await runEvolutionCampaign({
      campaignRoot: seventyRoot,
      campaignId: 'camp-70',
      manifest: seventyYaml,
      repositoryRoot: repoDir,
      baseRevision,
      signal: abortGen1.signal,
      proposeCandidateSlice: async () =>
        '// EVOLVE-BLOCK-START: decode\nint decode_kernel() { return 1; }\n// EVOLVE-BLOCK-END: decode\n',
      evaluator: async p => {
        abortGen1.abort();
        return {
          status: 'passed',
          codeSlice: p.proposedCodeSlice ?? '',
          metrics: { latency_us_p50: 50, goodput_rps: 2000 },
          evidenceDigest: makeDigest('ev-70-1'),
        };
      },
    });
    const l70 = await first70.store.acquireLease('seed-70-b');
    const team70Id = (await first70.store.getIsland('camp-70', 0))!.activeTeamConfigId;
    for (let k = 0; k < 70; k += 1) {
      const sc = await first70.store.writeCasBlob(
        Buffer.from(`// EVOLVE-BLOCK-START: decode\nint decode_kernel() { return ${5000 + k}; }\n// EVOLVE-BLOCK-END: decode\n`, 'utf8'),
      );
      await first70.store.recordIndividual(l70, {
        individualId: `ind-seed70-${k}`,
        campaignId: 'camp-70',
        islandId: 0,
        generation: 1,
        bucketId: null,
        teamConfigId: team70Id,
        modelId: 'claude-sonnet-4-6',
        trackId: 'triton',
        mutationKind: 'diff_tune',
        status: 'passed',
        failureReason: null,
        nicheKey: 'bound_pipeline=hbm',
        paretoRank: 2,
        crowdingDistance: 0,
        scalarFitness: 0.5,
        countEvaluation: false,
        codeSliceCasDigest: sc.digest,
        evidenceDigest: makeDigest(`ev-s70-${k}`),
        verdictReceiptCasDigest: null,
        outputArtifacts: [],
        metrics: { latency_us_p50: 60, goodput_rps: 1900 },
      });
    }
    await first70.store.close();

    const resumed70 = await resumeEvolutionCampaign({
      campaignRoot: seventyRoot,
      campaignId: 'camp-70',
      repositoryRoot: repoDir,
      proposeCandidateSlice: async () =>
        '// EVOLVE-BLOCK-START: decode\nint decode_kernel() { return 9999; }\n// EVOLVE-BLOCK-END: decode\n',
      evaluator: async p => ({
        status: 'passed',
        codeSlice: p.proposedCodeSlice ?? '',
        metrics: { latency_us_p50: 40, goodput_rps: 2400 },
        evidenceDigest: makeDigest('ev-70-2'),
      }),
    });
    assert.equal(resumed70.campaign.status, 'completed');

    // Verify soft_passed-only campaign refuses exportEvolutionBundle with EXPORT_UNVERIFIED_FORBIDDEN
    const softOnlyRoot = join(tempDir, 'camp-soft-only');
    const softRes = await runEvolutionCampaign({
      campaignRoot: softOnlyRoot,
      campaignId: 'camp-soft-only',
      manifest: BASE_CAMPAIGN_YAML
        .replace('islands: 2', 'islands: 1')
        .replace('maxGenerations: 2', 'maxGenerations: 1')
        .replace('maxEvaluations: 4', 'maxEvaluations: 1')
        .replace('maxConcurrentEvaluations: 2', 'maxConcurrentEvaluations: 1'),
      repositoryRoot: repoDir,
      baseRevision,
      evaluator: async () => ({
        status: 'soft_passed',
        failureReason: 'CASCADE_NOT_ESCALATED',
        codeSlice: '// EVOLVE-BLOCK-START: decode\nint decode_kernel() { return 7; }\n// EVOLVE-BLOCK-END: decode\n',
        metrics: { latency_us_p50: 80, goodput_rps: 1500 },
      }),
    });
    await assert.rejects(
      () => exportEvolutionBundle({
        store: softRes.store,
        campaignId: 'camp-soft-only',
        outputDir: join(tempDir, 'out-soft-denied'),
        allowUnverifiedSignature: true,
      }),
      (err: unknown) => err instanceof EvolutionError && err.code === 'EXPORT_UNVERIFIED_FORBIDDEN',
    );
    await softRes.store.close();
    await resumed70.store.close();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('mid-generation SIGTERM resumes unfinished islands in same generation, evaluator throws close SQLite store cleanly, and collectChildBenchmarkArtifacts rejects symlinks/hardlinks/prototype keys', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'evo-hardening-resume-'));
  try {
    const repoDir = join(tempDir, 'repo');
    const baseRevision = initGitRepo(repoDir, {
      '.loopwright/taskpack.yaml': { content: MULTI_CELL_TASKPACK_YAML },
      'docs/role-guide.md': { content: '# Guide\n' },
      'src/kernels/decode.cu': { content: KERNEL_SRC },
    });

    // 1. Two islands, maxConcurrentEvaluations = 1; SIGTERM after Gen 1 Island 0 -> resume completes Gen 1 Island 1 without skipping Gen 1 or re-running Island 0
    const midGenRoot = join(tempDir, 'camp-midgen');
    const midGenYaml = BASE_CAMPAIGN_YAML.replace('maxConcurrentEvaluations: 2', 'maxConcurrentEvaluations: 1');
    const abortMid = new AbortController();
    const seenSlotsRun1: string[] = [];

    const firstHalf = await runEvolutionCampaign({
      campaignRoot: midGenRoot,
      campaignId: 'camp-midgen',
      manifest: midGenYaml,
      repositoryRoot: repoDir,
      baseRevision,
      signal: abortMid.signal,
      evaluator: async p => {
        seenSlotsRun1.push(`g${p.generation}-i${p.islandId}`);
        abortMid.abort();
        return {
          status: 'passed',
          codeSlice: `// EVOLVE-BLOCK-START: decode\nint decode_kernel() { return ${p.generation * 10 + p.islandId}; }\n// EVOLVE-BLOCK-END: decode\n`,
          metrics: { latency_us_p50: 60, goodput_rps: 2000 },
          evidenceDigest: makeDigest(`ev-${p.individualId}`),
        };
      },
    });
    assert.deepEqual(seenSlotsRun1, ['g1-i0']);
    assert.equal(firstHalf.campaign.status, 'paused');
    assert.equal(firstHalf.campaign.currentGeneration, 0, 'interrupted Gen 1 must NOT advance currentGeneration to 1');
    await firstHalf.store.close();

    const seenSlotsRun2: string[] = [];
    const secondHalf = await resumeEvolutionCampaign({
      campaignRoot: midGenRoot,
      campaignId: 'camp-midgen',
      repositoryRoot: repoDir,
      evaluator: async p => {
        seenSlotsRun2.push(`g${p.generation}-i${p.islandId}`);
        return {
          status: 'passed',
          codeSlice: `// EVOLVE-BLOCK-START: decode\nint decode_kernel() { return ${100 + p.generation * 10 + p.islandId}; }\n// EVOLVE-BLOCK-END: decode\n`,
          metrics: { latency_us_p50: 50 - p.generation, goodput_rps: 2200 },
          evidenceDigest: makeDigest(`ev2-${p.individualId}`),
        };
      },
    });
    assert.deepEqual(seenSlotsRun2, ['g1-i1', 'g2-i0', 'g2-i1']);
    assert.equal(secondHalf.campaign.status, 'completed');
    assert.equal(secondHalf.campaign.evaluationsUsed, 4);
    await secondHalf.store.close();

    // 2. Throwing inside evaluator closes EvolutionCampaignStore cleanly so immediate reopen succeeds
    const throwRoot = join(tempDir, 'camp-throw-close');
    await assert.rejects(
      () => runEvolutionCampaign({
        campaignRoot: throwRoot,
        campaignId: 'camp-throw',
        manifest: midGenYaml,
        repositoryRoot: repoDir,
        baseRevision,
        evaluator: async () => {
          throw new Error('simulated evaluator crash');
        },
      }),
      /simulated evaluator crash/,
    );
    const reopenedAfterCrash = await EvolutionCampaignStore.open({ campaignRoot: throwRoot, createIfMissing: false });
    assert.equal((await reopenedAfterCrash.getCampaign('camp-throw'))?.campaignId, 'camp-throw');
    await reopenedAfterCrash.close();

    // 3. collectChildBenchmarkArtifacts rejects symlink proof, hardlinked proof, and __proto__ keys
    const artSymDir = join(tempDir, 'artifacts-symlink');
    mkdirSync(artSymDir, { recursive: true });
    const extProof = join(tempDir, 'external-proof.json');
    writeFileSync(extProof, '{"output":{"name":"out.json"}}\n');
    symlinkSync(extProof, join(artSymDir, 'benchmark-producer-01.proof.json'));
    await assert.rejects(
      () => collectChildBenchmarkArtifacts(artSymDir, true),
      (err: unknown) => err instanceof EvolutionError && err.code === 'EVOLUTION_SYMLINK_FORBIDDEN',
    );

    const artHardDir = join(tempDir, 'artifacts-hardlink');
    mkdirSync(artHardDir, { recursive: true });
    const proofFile = join(artHardDir, 'benchmark-producer-01.proof.json');
    writeFileSync(proofFile, '{"output":null}\n');
    linkSync(proofFile, join(tempDir, 'hardlinked-proof.json'));
    await assert.rejects(
      () => collectChildBenchmarkArtifacts(artHardDir, true),
      (err: unknown) => err instanceof EvolutionError && err.code === 'EVOLUTION_SYMLINK_FORBIDDEN',
    );

    const artProtoDir = join(tempDir, 'artifacts-proto');
    mkdirSync(artProtoDir, { recursive: true });
    writeFileSync(
      join(artProtoDir, 'benchmark-producer-01.proof.json'),
      '{"output":{"name":"bench-out.json"}}\n',
    );
    writeFileSync(
      join(artProtoDir, 'bench-out.json'),
      '{"__proto__":{"polluted":true},"verdict":{"metrics":{"latency_us_p50":10}}}\n',
    );
    await assert.rejects(
      () => collectChildBenchmarkArtifacts(artProtoDir, true),
      (err: unknown) => err instanceof EvolutionError && err.code === 'EVOLUTION_SCHEMA_INVALID',
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('heldOutWorkloadId enforces strict identifier schema, forwards single-target override to evaluator, and gates bundle export', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'evo-hardening-workload-id-'));
  try {
    // 1. Invalid heldOutWorkloadId values (leading digit, uppercase, colon) fail closed at parse time
    for (const badId of ['16x4096', 'Decode_BS16', 'bs16:fp16']) {
      assert.throws(
        () => parseEvolutionCampaignDocument(
          BASE_CAMPAIGN_YAML.replace('targetCellId: cuda-h100-whole', `targetCellId: cuda-h100-whole\n  heldOutWorkloadId: "${badId}"`),
        ),
        (err: unknown) => err instanceof EvolutionError && err.code === 'EVOLUTION_SCHEMA_INVALID',
      );
      assert.throws(
        () => parseEvolutionCampaignDocument(
          BASE_CAMPAIGN_YAML.replace(
            '  stages:\n    mode: single-target',
            `  stages:\n    mode: specialist-then-portfolio\n    specialistBuckets:\n      - id: bs16:fp16\n        heldOutWorkloadId: valid-wl\n    portfolioHeldOutWorkloadId: "${badId}"`,
          ),
        ),
        (err: unknown) => err instanceof EvolutionError && err.code === 'EVOLUTION_SCHEMA_INVALID',
      );
    }

    // 2. Top-level spec.heldOutWorkloadId is rejected under specialist-then-portfolio mode
    assert.throws(
      () => parseEvolutionCampaignDocument(
        BASE_CAMPAIGN_YAML
          .replace('targetCellId: cuda-h100-whole', 'targetCellId: cuda-h100-whole\n  heldOutWorkloadId: single-override')
          .replace(
            '  stages:\n    mode: single-target',
            '  stages:\n    mode: specialist-then-portfolio\n    specialistBuckets:\n      - id: bs16:fp16\n        heldOutWorkloadId: valid-wl\n    portfolioHeldOutWorkloadId: portfolio-wl',
          ),
      ),
      (err: unknown) => err instanceof EvolutionError && err.code === 'EVOLUTION_SCHEMA_INVALID',
    );

    // 3. Bucket IDs with colons remain accepted while heldOutWorkloadId must be an identifier
    const validPortfolio = parseEvolutionCampaignDocument(
      BASE_CAMPAIGN_YAML.replace(
        '  stages:\n    mode: single-target',
        '  stages:\n    mode: specialist-then-portfolio\n    specialistBuckets:\n      - id: bs16:fp16\n        heldOutWorkloadId: valid-wl-1\n    portfolioHeldOutWorkloadId: portfolio-wl',
      ),
    );
    assert.equal(validPortfolio.spec.stages.mode, 'specialist-then-portfolio');

    // 4. single-target spec.heldOutWorkloadId override is forwarded to evaluator and enforced at export
    const repoDir = join(tempDir, 'repo');
    const baseRevision = initGitRepo(repoDir, {
      '.loopwright/taskpack.yaml': { content: MULTI_CELL_TASKPACK_YAML },
      'docs/role-guide.md': { content: '# Guide\n' },
      'src/kernels/decode.cu': { content: KERNEL_SRC },
    });

    const singleOverrideYaml = BASE_CAMPAIGN_YAML
      .replace('targetCellId: cuda-h100-whole', 'targetCellId: cuda-h100-whole\n  heldOutWorkloadId: full-sm90a-holdout')
      .replace('islands: 2', 'islands: 1')
      .replace('maxGenerations: 2', 'maxGenerations: 1')
      .replace('maxEvaluations: 4', 'maxEvaluations: 1')
      .replace('maxConcurrentEvaluations: 2', 'maxConcurrentEvaluations: 1');

    const seenWorkloads: string[] = [];
    const cubinBytes = buildMinimalElf64('decode_override_kernel');
    const cubinDigest = { algorithm: 'sha256' as const, hex: sha256Hex(cubinBytes) };
    const wrongWorkloadReceipt = Buffer.from(
      JSON.stringify({
        version: 1,
        kind: 'benchmark_verdict',
        storeId: 'store-wl-override',
        runId: 'run-wl-override',
        lockHash: makeDigest('lock-wl'),
        operationId: 'op-wrong-wl',
        dispatchId: 'disp-wrong-wl',
        dispatchGeneration: 1,
        gateId: 'decode-cuda-bench',
        checkId: 'gpu-bench-cuda',
        candidateDigest: sha256Hex('cand-wl'),
        status: 'approved',
        reason: null,
        expiresAtMs: '1900000000000',
        preemptionCount: 0,
        heldOutWorkloadId: 'cuda-default-workload',
        metrics: { latency_us_p50: 32, goodput_rps: 2600 },
        hardwareProvenance: {
          targetCellId: 'cuda-h100-whole',
          probeKind: 'physical',
          vendor: 'nvidia',
          deviceModel: 'NVIDIA H100 80GB HBM3',
          accelerator: 'sm_90a',
          isolationMode: 'whole_device',
          deviceCount: 1,
          driverVersion: '555.42.02',
          runtimeVersion: 'cuda-12.5',
          topology: 'single_gpu',
          workloadDigest: makeDigest('wl-wrong'),
          clockLockMode: 'locked',
        },
        outputArtifacts: [
          {
            name: 'decode.cubin',
            digest: cubinDigest,
            byteLength: cubinBytes.byteLength,
            mediaType: 'application/octet-stream',
          },
        ],
        signature: '0'.repeat(64),
      }),
      'utf8',
    );

    const res = await runEvolutionCampaign({
      campaignRoot: join(tempDir, 'camp-wl-override'),
      campaignId: 'camp-wl-override',
      manifest: singleOverrideYaml,
      repositoryRoot: repoDir,
      baseRevision,
      evaluator: async proposal => {
        seenWorkloads.push(proposal.heldOutWorkloadId);
        return {
          status: 'passed',
          codeSlice: '// EVOLVE-BLOCK-START: decode\nint decode_kernel() { return 42; }\n// EVOLVE-BLOCK-END: decode\n',
          metrics: { latency_us_p50: 32, goodput_rps: 2600 },
          evidenceDigest: makeDigest('ev-wl-override'),
          rawVerdictReceiptBytes: wrongWorkloadReceipt,
          stageABlobs: [{ name: 'decode.cubin', bytes: cubinBytes, digest: cubinDigest, byteLength: cubinBytes.byteLength }],
          outputArtifacts: [{ name: 'decode.cubin', digest: cubinDigest, byteLength: cubinBytes.byteLength, uri: `cas://sha256/${cubinDigest.hex}` }],
        };
      },
    });
    assert.deepEqual(seenWorkloads, ['full-sm90a-holdout']);

    await assert.rejects(
      () => exportEvolutionBundle({
        store: res.store,
        campaignId: 'camp-wl-override',
        outputDir: join(tempDir, 'out-wrong-wl'),
        allowUnverifiedSignature: true,
      }),
      (err: unknown) =>
        err instanceof EvolutionError
        && err.code === 'EXPORT_UNVERIFIED_FORBIDDEN'
        && /expected "full-sm90a-holdout"/.test(err.message),
    );
    await res.store.close();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
