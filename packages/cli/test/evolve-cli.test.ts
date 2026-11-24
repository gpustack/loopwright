import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EVOLUTION_ERROR_CODES,
  parseEvolutionCampaignDocument,
  verifyEvolutionBundle,
  type EvolutionErrorCode,
} from '@loopwright/evolution';
import { SecretScrubber } from '@loopwright/core';
import { SecretScrubber as TaskpackSecretScrubber, loadDeclarativeTaskpack } from '@loopwright/taskpack';
import {
  runHardwareWorker,
  startRelayServer,
  type WorkerConfig,
} from '@loopwright/hardware-runner';
import { createCliEvolutionEvaluator } from '../src/evolve.js';
import { evolutionExitCode, main as cliMain } from '../src/main.js';

const MAIN = fileURLToPath(new URL('../src/main.js', import.meta.url));
const BENCH_HMAC_SECRET = 'evolve-cli-bench-hmac-secret-0123456789abcdef';
const WORKER_BEARER_TOKEN = 'evolve-cli-worker-token-0123456789abcdef';
const LOCAL_OAI_KEY = 'sk-evolve-cli-test-secret-0123456789abcdef';

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

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
  ehdr[4] = 2;
  ehdr[5] = 1;
  ehdr[6] = 1;
  ehdr.writeUInt16LE(2, 16);
  ehdr.writeUInt16LE(190, 18);
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

async function initGitRepo(
  repoDir: string,
  files: Readonly<Record<string, { readonly content: string | Buffer; readonly executable?: boolean }>>,
): Promise<string> {
  await mkdir(repoDir, { recursive: true, mode: 0o700 });
  for (const [relPath, entry] of Object.entries(files)) {
    const absPath = join(repoDir, relPath);
    await mkdir(join(absPath, '..'), { recursive: true, mode: 0o700 });
    await writeFile(absPath, entry.content, { mode: entry.executable ? 0o755 : 0o644 });
    if (entry.executable) await chmod(absPath, 0o755);
  }
  const gitEnv = {
    PATH: '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    HOME: '/nonexistent',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Loopwright Test',
    GIT_AUTHOR_EMAIL: 'test@loopwright.dev',
    GIT_COMMITTER_NAME: 'Loopwright Test',
    GIT_COMMITTER_EMAIL: 'test@loopwright.dev',
  };
  execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', 'init', '-b', 'main'], { cwd: repoDir, env: gitEnv, stdio: 'ignore' });
  execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', 'add', '.'], { cwd: repoDir, env: gitEnv, stdio: 'ignore' });
  execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Initial baseline kernel'], { cwd: repoDir, env: gitEnv, stdio: 'ignore' });
  return execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', 'rev-parse', 'HEAD'], { cwd: repoDir, env: gitEnv, encoding: 'utf8' }).trim();
}

async function runCliInProcess(
  argv: readonly string[],
  envOverrides: Readonly<Record<string, string | undefined>> = {},
): Promise<{ readonly status: number; readonly stdout: string; readonly stderr: string }> {
  const prevEnv: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(envOverrides)) {
    prevEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  let stdout = '';
  let stderr = '';
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array, encodingOrCb?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    if (callback) callback(null);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, encodingOrCb?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    if (callback) callback(null);
    return true;
  }) as typeof process.stderr.write;

  try {
    const status = await cliMain(argv);
    return { status, stdout, stderr };
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const BASELINE_KERNEL_SOURCE = [
  '#include <stdint.h>',
  'static constexpr int LOCKED_ABI_VERSION = 1;',
  '// EVOLVE-BLOCK-START: flash_decode',
  'int flash_decode_mode() {',
  '  return 0; // baseline',
  '}',
  '// EVOLVE-BLOCK-END: flash_decode',
  '',
].join('\n');

test('evolve-cli: help flags, zero top-level @loopwright/evolution static imports, and exhaustive exit codes', async () => {
  const topHelp = spawnSync(process.execPath, [MAIN, '--help'], {
    encoding: 'utf8',
    timeout: 5_000,
    env: { PATH: '/usr/bin:/bin' },
  });
  assert.equal(topHelp.status, 0, topHelp.stderr);
  assert.match(topHelp.stdout, /evolve check --campaign FILE/);
  assert.match(topHelp.stdout, /evolve run --campaign FILE --state DIR/);
  assert.match(topHelp.stdout, /evolve resume --campaign DIR/);
  assert.match(topHelp.stdout, /evolve status --campaign DIR/);
  assert.match(topHelp.stdout, /evolve inspect --campaign DIR/);
  assert.match(topHelp.stdout, /evolve export --campaign DIR --out DIR/);

  for (const helpArgv of [
    ['evolve', '--help'],
    ['evolve', 'check', '--help'],
    ['evolve', 'run', '--help'],
    ['evolve', 'resume', '--help'],
    ['evolve', 'status', '--help'],
    ['evolve', 'inspect', '--help'],
    ['evolve', 'export', '--help'],
  ]) {
    const res = spawnSync(process.execPath, [MAIN, ...helpArgv], {
      encoding: 'utf8',
      timeout: 5_000,
      env: { PATH: '/usr/bin:/bin' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /evolve export --campaign DIR --out DIR/);
  }

  const mainSrcPath = fileURLToPath(new URL('../../../../packages/cli/src/main.ts', import.meta.url));
  const mainSrc = await readFile(mainSrcPath, 'utf8');
  assert.equal(
    /^\s*import\b[^;]*@loopwright\/evolution/m.test(mainSrc),
    false,
    'main.ts must not perform a top-level import of @loopwright/evolution',
  );
  assert.equal(
    /^\s*import\b[^;]*@loopwright\/agent-pi\/host-session/m.test(mainSrc),
    false,
    'main.ts must not perform a top-level import of @loopwright/agent-pi/host-session',
  );
  assert.match(mainSrc, /await import\('@loopwright\/evolution'\)/);

  const evolveSrcPath = fileURLToPath(new URL('../../../../packages/cli/src/evolve.ts', import.meta.url));
  const evolveSrc = await readFile(evolveSrcPath, 'utf8');
  assert.equal(
    /^\s*import\s+(?!type\b)[^;]*@loopwright\/evolution/m.test(evolveSrc),
    false,
    'evolve.ts must not perform a top-level runtime import of @loopwright/evolution',
  );
  assert.equal(
    /^\s*import\b[^;]*@loopwright\/agent-pi\/host-session/m.test(evolveSrc),
    false,
    'evolve.ts must not perform a top-level static import of @loopwright/agent-pi/host-session',
  );

  const expectedExitCodes: Record<EvolutionErrorCode, number> = {
    EVOLUTION_SCHEMA_INVALID: 2,
    TEAM_ENVELOPE_VIOLATION: 3,
    EXPORT_UNVERIFIED_FORBIDDEN: 3,
    EVOLUTION_SYMLINK_FORBIDDEN: 3,
    EVOLUTION_NOT_FOUND: 4,
    ARTIFACT_INVALID: 4,
    ARTIFACT_MISSING: 4,
    EVOLUTION_BUDGET_EXCEEDED: 5,
    EVOLUTION_CLOCK_DRIFT: 7,
    EVOLUTION_LEASE_FENCED: 7,
    EVOLUTION_CONFLICT: 7,
    EVOLUTION_STORE_BUSY: 7,
    EVOLUTION_STORE_ERROR: 8,
    EVOLUTION_STORE_CLOSED: 8,
    EVOLUTION_STORE_CORRUPT: 8,
    SECRET_LEAK_DETECTED: 8,
  };
  for (const code of EVOLUTION_ERROR_CODES) {
    assert.equal(evolutionExitCode(code), expectedExitCodes[code], `mismatch for ${code}`);
  }
});

test('evolve-cli: evolve check validates campaign manifests and fails closed without leaking secrets', async () => {
  const realTmp = await realpath(tmpdir());
  const root = await mkdtemp(join(realTmp, 'lw-evolve-cli-check-'));
  try {
    const repoDir = join(root, 'repo');
    await initGitRepo(repoDir, {
      '.loopwright/taskpack.yaml': {
        content: [
          'apiVersion: loopwright.dev/v1alpha1',
          'kind: Taskpack',
          'metadata:',
          '  name: cli-check-tp',
          'spec:',
          '  goal:',
          '    candidate: Evolve kernel.',
          '    noChange: No change.',
          '  target:',
          '    matrix:',
          '      - id: cuda-sm90',
          '        platform: linux/amd64',
          '        variant: cuda12',
          '        hardware:',
          '          accelerator: sm_90a',
          '          isolationMode: whole_device',
          '          deviceCount: 1',
          '  scope:',
          '    writable: [src/kernels/**]',
          '    protected: [scripts/**]',
          '  models:',
          '    - provider: local-oai',
          '      id: mock-model',
          '      apiKeyEnv: LOCAL_OAI_KEY',
          '  verification:',
          '    localChecks:',
          '      - id: evolve-guard',
          '        implementation: evolve-block-guard.v1',
          '        parameters:',
          '          files: [src/kernels/flash_decode.cu]',
          '    externalGates:',
          '      - id: gpu-bench',
          '        implementation: benchmark-gate.v1',
          '        endpointId: hw-relay',
          '        gateId: flash-bench',
          '        required: true',
          '        targetCellId: cuda-sm90',
          '        heldOutWorkloadId: decode-bs1-4k',
          '        allowSyntheticHardwareProbe: true',
          '        metricThresholds:',
          '          - kind: bounds',
          '            metric: max_ulp',
          '            max: 2',
          '            bucketScope: all_buckets',
        ].join('\n'),
      },
      '.loopwright/campaign.yaml': {
        content: [
          'apiVersion: loopwright.dev/v1alpha1',
          'kind: EvolutionCampaign',
          'metadata:',
          '  name: cli-check-campaign',
          'spec:',
          '  taskpack: .loopwright/taskpack.yaml',
          '  targetCellId: cuda-sm90',
          '  stages:',
          '    mode: single-target',
          '  population:',
          '    islands: 1',
          '    migrationIntervalGenerations: 2',
          '    maxMigrationElites: 1',
          '    nicheAxes:',
          '      - id: bound_pipeline',
          '        kind: enum',
          '        values: [hbm, tensor_cube]',
          '  sampling:',
          '    noveltyDecayLambda: 1.0',
          '    mutationWeights:',
          '      diff_tune: 0.5',
          '      full_rewrite: 0.5',
          '      crossover: 0.0',
          '    modelBandit: deterministic-round-robin',
          '    maxCrossoversPerPrompt: 1',
          '  objectives:',
          '    - metric: latency_us_p50',
          '      direction: minimize',
          '  budgets:',
          '    maxGenerations: 1',
          '    maxEvaluations: 1',
          '    maxConcurrentEvaluations: 1',
          '    scratchpadIntervalGenerations: 1',
        ].join('\n'),
      },
      'src/kernels/flash_decode.cu': { content: BASELINE_KERNEL_SOURCE },
    });

    const okRes = spawnSync(
      process.execPath,
      [MAIN, 'evolve', 'check', '--campaign', join(repoDir, '.loopwright', 'campaign.yaml'), '--repo', repoDir, '--json'],
      { encoding: 'utf8', timeout: 10_000, env: { PATH: '/usr/bin:/bin', LOCAL_OAI_KEY } },
    );
    assert.equal(okRes.status, 0, okRes.stdout + okRes.stderr);
    const okEnv = JSON.parse(okRes.stdout) as {
      kind: string;
      data: { valid: boolean; targetCellId: string; stageMode: string; modelIds: readonly string[] };
    };
    assert.equal(okEnv.kind, 'plan');
    assert.equal(okEnv.data.valid, true);
    assert.equal(okEnv.data.targetCellId, 'cuda-sm90');
    assert.equal(okEnv.data.stageMode, 'single-target');
    assert.deepEqual(okEnv.data.modelIds, ['mock-model']);

    const badCampaign = join(root, 'bad-campaign.yaml');
    await writeFile(
      badCampaign,
      (await readFile(join(repoDir, '.loopwright', 'campaign.yaml'), 'utf8')).replace('targetCellId: cuda-sm90', 'targetCellId: missing-cell'),
      { mode: 0o600 },
    );
    const badRes = spawnSync(
      process.execPath,
      [MAIN, 'evolve', 'check', '--campaign', badCampaign, '--repo', repoDir, '--json'],
      { encoding: 'utf8', timeout: 10_000, env: { PATH: '/usr/bin:/bin', LOCAL_OAI_KEY } },
    );
    assert.equal(badRes.status, 2, badRes.stdout + badRes.stderr);
    const badEnv = JSON.parse(badRes.stdout) as { kind: string; data: { code: string; message: string } };
    assert.equal(badEnv.kind, 'diagnostic');
    assert.equal(badEnv.data.code, 'EVOLUTION_SCHEMA_INVALID');

    const secretCampaign = join(root, 'secret-campaign.yaml');
    await writeFile(
      secretCampaign,
      (await readFile(join(repoDir, '.loopwright', 'campaign.yaml'), 'utf8')).replace('targetCellId: cuda-sm90', `targetCellId: ${LOCAL_OAI_KEY}`),
      { mode: 0o600 },
    );
    const secretRes = spawnSync(
      process.execPath,
      [MAIN, 'evolve', 'check', '--campaign', secretCampaign, '--repo', repoDir, '--json'],
      { encoding: 'utf8', timeout: 10_000, env: { PATH: '/usr/bin:/bin', LOCAL_OAI_KEY } },
    );
    assert.equal(secretRes.status, 8, secretRes.stdout + secretRes.stderr);
    const secretEnv = JSON.parse(secretRes.stdout) as { kind: string; data: { code: string; message: string } };
    assert.equal(secretEnv.kind, 'diagnostic');
    assert.equal(secretEnv.data.code, 'SECRET_LEAK_DETECTED');
    assert.equal(secretRes.stdout.includes(LOCAL_OAI_KEY), false);
    assert.equal(secretRes.stderr.includes(LOCAL_OAI_KEY), false);

    const missingStatus = spawnSync(
      process.execPath,
      [MAIN, 'evolve', 'status', '--campaign', join(root, 'missing-state'), '--json'],
      { encoding: 'utf8', timeout: 5_000, env: { PATH: '/usr/bin:/bin' } },
    );
    assert.equal(missingStatus.status, 4, missingStatus.stdout + missingStatus.stderr);
    assert.equal(JSON.parse(missingStatus.stdout).data.code, 'EVOLUTION_NOT_FOUND');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('evolve-cli: end-to-end specialist-then-portfolio run, SIGINT pause + resume, status, inspect, OCI export, and tamper/probe gates', { timeout: 120000 }, async () => {
  const realTmp = await realpath(tmpdir());
  const root = await mkdtemp(join(realTmp, 'lw-evolve-cli-e2e-'));

  const relayCasDir = join(root, 'relay-cas');
  const workerWorkDir = join(root, 'worker-work');
  const workloadsDir = join(root, 'workloads');
  await mkdir(workerWorkDir, { recursive: true, mode: 0o700 });

  for (const [workloadId, lat, rps] of [
    ['decode-bs1-4k', 28, 2200] as const,
    ['decode-bs16-8k', 64, 5400] as const,
    ['decode-portfolio-holdout', 44, 4100] as const,
  ]) {
    await mkdir(join(workloadsDir, workloadId), { recursive: true, mode: 0o700 });
    const evalScript = [
      `#!${process.execPath}`,
      'const payload = {',
      '  status: "approved",',
      `  metrics: { latency_us_p50: ${lat}, goodput_rps: ${rps}, max_ulp: 1 },`,
      '  bucketMetrics: [',
      `    { bucketId: ${JSON.stringify(workloadId)}, dimensions: { bs: ${workloadId.includes('bs16') ? 16 : 1} }, metrics: { latency_us_p50: ${lat}, goodput_rps: ${rps}, max_ulp: 1 } }`,
      '  ],',
      '  hardwareDiagnostics: { boundPipeline: "tensor_cube", occupancyPct: 78, rooflineHeadroom: 1.12 }',
      '};',
      'process.stdout.write("LOOPWRIGHT_STAGE_B_RESULT:" + JSON.stringify(payload) + "\\n");',
      '',
    ].join('\n');
    const evalPath = join(workloadsDir, workloadId, 'evaluate.sh');
    await writeFile(evalPath, evalScript, { mode: 0o755 });
    await chmod(evalPath, 0o755);
  }

  const bs1CubinHex = buildElf64Cubin(['flash_decode_bs1_sm90a']).toString('hex');
  const bs16CubinHex = buildElf64Cubin(['flash_decode_bs16_sm90a']).toString('hex');
  const routerCubinHex = buildElf64Cubin(['flash_decode_portfolio_router_sm90a']).toString('hex');

  const buildScript = [
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
    sweepIntervalMs: 150,
  });

  const workerAbort = new AbortController();
  let workerFatalError: unknown = null;
  const workerPromise = runHardwareWorker({
    config: {
      workerId: 'evolve-cli-worker',
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
    } satisfies WorkerConfig,
    once: false,
    signal: workerAbort.signal,
    registerProcessSignalHandlers: false,
  }).catch((err: unknown) => {
    if (!workerAbort.signal.aborted) {
      workerFatalError = err;
    }
  });

  // Mock loopback SSE provider returning a write tool call + completed submission
  let sseTurn = 0;
  let emitSigintOnSecondEval = false;
  const sseServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
    const parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      readonly messages?: readonly { readonly role?: string }[];
    };
    const isSecondMessage = parsedBody.messages?.some(m => m.role === 'tool') ?? false;
    const bodyText = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (!isSecondMessage) {
        sseTurn += 1;
        assert.equal(
          bodyText.includes('decode-portfolio-holdout'),
          false,
          'portfolioHeldOutWorkloadId must never leak to specialist or portfolio model prompts',
        );
        if (emitSigintOnSecondEval && sseTurn === 2) {
          emitSigintOnSecondEval = false;
          setTimeout(() => {
            process.emit('SIGINT');
          }, 25);
        }
        let marker = 'SPECIALIST_BS1';
        if (bodyText.includes('Evolution stage: portfolio')) {
          marker = 'PORTFOLIO_ROUTER_DISPATCH';
        } else if (bodyText.includes('bucket: bs16-isl8k')) {
          marker = 'SPECIALIST_BS16';
        }
        const nextKernel = BASELINE_KERNEL_SOURCE.replace('return 0; // baseline', `return ${sseTurn}; // ${marker}`);
        const toolChunk = {
          id: `chatcmpl-tool-${sseTurn}`,
          object: 'chat.completion.chunk',
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [{
                index: 0,
                id: `call_write_${sseTurn}`,
                type: 'function',
                function: {
                  name: 'write',
                  arguments: JSON.stringify({ path: 'src/kernels/flash_decode.cu', content: nextKernel }),
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
        };
        res.end(`data: ${JSON.stringify(toolChunk)}\n\ndata: [DONE]\n\n`);
        return;
      }

      const doneChunk = {
        id: `chatcmpl-done-${sseTurn}`,
        object: 'chat.completion.chunk',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            content: '{"version":1,"status":"completed","checks":[],"reason":"updated flash_decode.cu inside EVOLVE-BLOCK"}',
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 25, completion_tokens: 12, total_tokens: 37 },
      };
      res.end(`data: ${JSON.stringify(doneChunk)}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(resolveListen => sseServer.listen(0, '127.0.0.1', () => resolveListen()));
  const ssePort = (sseServer.address() as { port: number }).port;

  try {
    const modelsJsonPath = join(root, 'models.json');
    await writeFile(
      modelsJsonPath,
      JSON.stringify({
        providers: {
          'local-oai': {
            baseUrl: `http://127.0.0.1:${ssePort}/v1`,
            api: 'openai-completions',
            apiKey: 'LOCAL_OAI_KEY',
            models: [{ id: 'mock-model', contextWindow: 128_000, maxTokens: 4_096 }],
          },
        },
      }),
      { mode: 0o600 },
    );

    const repoDir = join(root, 'repo');
    await initGitRepo(repoDir, {
      '.loopwright/taskpack.yaml': {
        content: [
          'apiVersion: loopwright.dev/v1alpha1',
          'kind: Taskpack',
          'metadata:',
          '  name: cli-portfolio-tp',
          'spec:',
          '  goal:',
          '    candidate: Evolve flash decode kernel inside EVOLVE-BLOCK markers.',
          '    noChange: No kernel change needed.',
          '  target:',
          '    matrix:',
          '      - id: cuda-sm90',
          '        platform: linux/amd64',
          '        variant: cuda12',
          '        hardware:',
          '          accelerator: sm_90a',
          '          isolationMode: whole_device',
          '          deviceCount: 1',
          '          driverConstraint: ">=550.0"',
          '          forbiddenSymbolPatterns: [cublas, cudnn]',
          '  scope:',
          '    writable: [src/kernels/**]',
          '    protected: [scripts/**]',
          '  models:',
          '    - provider: local-oai',
          '      id: mock-model',
          '      apiKeyEnv: LOCAL_OAI_KEY',
          '  roles:',
          '    - id: mutator',
          '      provider: local-oai',
          '      model: mock-model',
          '      purpose: task',
          '      tools: [read, write, edit, bash]',
          '      prompt: Mutate src/kernels/flash_decode.cu strictly inside EVOLVE-BLOCK markers.',
          '  verification:',
          '    localChecks:',
          '      - id: evolve-guard',
          '        implementation: evolve-block-guard.v1',
          '        parameters:',
          '          files: [src/kernels/flash_decode.cu]',
          '    externalGates:',
          '      - id: gpu-bench',
          '        implementation: benchmark-gate.v1',
          '        endpointId: hw-relay',
          '        gateId: flash-decode-bench',
          '        required: true',
          '        targetCellId: cuda-sm90',
          '        heldOutWorkloadId: decode-bs1-4k',
          '        allowSyntheticHardwareProbe: true',
          '        metricThresholds:',
          '          - kind: bounds',
          '            metric: max_ulp',
          '            max: 2',
          '            bucketScope: all_buckets',
          '  publication:',
          '    mode: disabled',
        ].join('\n'),
      },
      '.loopwright/campaign.yaml': {
        content: [
          'apiVersion: loopwright.dev/v1alpha1',
          'kind: EvolutionCampaign',
          'metadata:',
          '  name: cli-portfolio-e2e',
          'spec:',
          '  taskpack: .loopwright/taskpack.yaml',
          '  targetCellId: cuda-sm90',
          '  stages:',
          '    mode: specialist-then-portfolio',
          '    specialistBuckets:',
          '      - id: bs1-isl4k',
          '        heldOutWorkloadId: decode-bs1-4k',
          '      - id: bs16-isl8k',
          '        heldOutWorkloadId: decode-bs16-8k',
          '    portfolioHeldOutWorkloadId: decode-portfolio-holdout',
          '  population:',
          '    islands: 1',
          '    migrationIntervalGenerations: 4',
          '    maxMigrationElites: 1',
          '    nicheAxes:',
          '      - id: bound_pipeline',
          '        kind: enum',
          '        values: [hbm, l2, smem_lds_ub, tensor_cube]',
          '  sampling:',
          '    noveltyDecayLambda: 1.0',
          '    mutationWeights:',
          '      diff_tune: 0.5',
          '      full_rewrite: 0.5',
          '      crossover: 0.0',
          '    modelBandit: deterministic-round-robin',
          '    maxCrossoversPerPrompt: 1',
          '  objectives:',
          '    - metric: latency_us_p50',
          '      direction: minimize',
          '    - metric: goodput_rps',
          '      direction: maximize',
          '  budgets:',
          '    maxGenerations: 3',
          '    maxEvaluations: 6',
          '    maxConcurrentEvaluations: 1',
          '    scratchpadIntervalGenerations: 5',
        ].join('\n'),
      },
      'src/kernels/flash_decode.cu': { content: BASELINE_KERNEL_SOURCE },
      'scripts/build.sh': { content: buildScript, executable: true },
    });

    const campaignFile = join(repoDir, '.loopwright', 'campaign.yaml');
    const campaignStateDir = join(root, 'campaign-state');
    const cliEnv = {
      PATH: '/usr/bin:/bin',
      LOOPWRIGHT_MODELS_JSON: modelsJsonPath,
      LOOPWRIGHT_ALLOW_MANIFEST_CUSTOM_BASE_URL: 'true',
      LOOPWRIGHT_BENCHMARK_GATE_URL: `${relay.url}/v1/benchmark/jobs`,
      LOOPWRIGHT_GATE_SIGNING_SECRET: BENCH_HMAC_SECRET,
      LOCAL_OAI_KEY,
    };

    // 1. Start `evolve run` and interrupt after first specialist evaluation via SIGINT -> exit 130 (paused)
    emitSigintOnSecondEval = true;
    const interruptedRun = await runCliInProcess([
      'evolve', 'run',
      '--campaign', campaignFile,
      '--state', campaignStateDir,
      '--repo', repoDir,
      '--allow-synthetic-probe',
      '--json',
    ], cliEnv);
    assert.equal(interruptedRun.status, 130, interruptedRun.stdout + interruptedRun.stderr);
    const interruptedEnv = JSON.parse(interruptedRun.stdout.trim()) as {
      kind: string;
      data: { campaign: { status: string; evaluationsUsed: number } };
    };
    assert.equal(interruptedEnv.kind, 'result');
    assert.equal(interruptedEnv.data.campaign.status, 'paused');
    assert.ok(interruptedEnv.data.campaign.evaluationsUsed >= 1);

    // 2. Resume via `evolve resume` -> completes specialist + portfolio synthesis cleanly!
    const resumedRun = await runCliInProcess([
      'evolve', 'resume',
      '--campaign', campaignStateDir,
      '--repo', repoDir,
      '--allow-synthetic-probe',
      '--json',
    ], cliEnv);
    assert.equal(resumedRun.status, 0, resumedRun.stdout + resumedRun.stderr);
    const resumedEnv = JSON.parse(resumedRun.stdout.trim()) as {
      kind: string;
      data: { campaign: { status: string; stagePhase: string }; paretoFrontier: readonly { individualId: string }[] };
    };
    assert.equal(resumedEnv.kind, 'result');
    assert.equal(resumedEnv.data.campaign.status, 'completed');
    assert.equal(resumedEnv.data.campaign.stagePhase, 'portfolio');
    assert.equal(resumedRun.stdout.includes(BENCH_HMAC_SECRET), false);
    assert.equal(resumedRun.stdout.includes(LOCAL_OAI_KEY), false);

    // 3. `evolve status`
    const statusRes = await runCliInProcess(['evolve', 'status', '--campaign', campaignStateDir, '--json'], cliEnv);
    assert.equal(statusRes.status, 0, statusRes.stdout + statusRes.stderr);
    const statusEnv = JSON.parse(statusRes.stdout.trim()) as {
      kind: string;
      data: { campaign: { status: string }; countsByStatus: { passed: number } };
    };
    assert.equal(statusEnv.kind, 'status');
    assert.equal(statusEnv.data.campaign.status, 'completed');
    assert.equal(statusEnv.data.countsByStatus.passed, 3);

    // 4. `evolve inspect` (full + --island + --individual + missing -> exit 4)
    const inspectAll = await runCliInProcess(['evolve', 'inspect', '--campaign', campaignStateDir, '--json'], cliEnv);
    assert.equal(inspectAll.status, 0, inspectAll.stdout + inspectAll.stderr);
    const inspectEnv = JSON.parse(inspectAll.stdout.trim()) as {
      kind: string;
      data: {
        individuals: readonly { individualId: string; status: string }[];
        lineageEdges: readonly { role: string }[];
      };
    };
    assert.equal(inspectEnv.kind, 'inspection');
    assert.equal(inspectEnv.data.individuals.length, 4);
    assert.equal(inspectEnv.data.individuals.filter(i => i.status === 'passed').length, 3);
    assert.equal(inspectEnv.data.individuals.filter(i => i.status === 'preempted').length, 1);
    assert.equal(inspectEnv.data.lineageEdges.filter(e => e.role === 'portfolio_member').length, 2);

    const firstIndId = inspectEnv.data.individuals[0]!.individualId;
    const inspectOne = await runCliInProcess([
      'evolve', 'inspect', '--campaign', campaignStateDir, '--island', '0', '--individual', firstIndId, '--json',
    ], cliEnv);
    assert.equal(inspectOne.status, 0, inspectOne.stdout + inspectOne.stderr);
    assert.equal(JSON.parse(inspectOne.stdout.trim()).data.individuals.length, 1);

    const inspectMissingIsland = await runCliInProcess([
      'evolve', 'inspect', '--campaign', campaignStateDir, '--island', '99', '--json',
    ], cliEnv);
    assert.equal(inspectMissingIsland.status, 4);
    assert.equal(JSON.parse(inspectMissingIsland.stdout.trim()).data.code, 'EVOLUTION_NOT_FOUND');

    // 5a. `evolve export` without --allow-synthetic-probe -> EXPORT_UNVERIFIED_FORBIDDEN (exit 3)
    const ociOutDir = join(root, 'oci-bundle');
    const unverifiedExport = await runCliInProcess([
      'evolve', 'export', '--campaign', campaignStateDir, '--out', ociOutDir, '--format', 'oci-layout', '--json',
    ], cliEnv);
    assert.equal(unverifiedExport.status, 3, unverifiedExport.stdout + unverifiedExport.stderr);
    assert.equal(JSON.parse(unverifiedExport.stdout.trim()).data.code, 'EXPORT_UNVERIFIED_FORBIDDEN');

    // 5b. `evolve export --allow-synthetic-probe` WITHOUT LOOPWRIGHT_GATE_SIGNING_SECRET -> EXPORT_UNVERIFIED_FORBIDDEN (exit 3)
    const missingSecretExport = await runCliInProcess([
      'evolve', 'export', '--campaign', campaignStateDir, '--out', ociOutDir, '--format', 'oci-layout', '--allow-synthetic-probe', '--json',
    ], {
      ...cliEnv,
      LOOPWRIGHT_GATE_SIGNING_SECRET: undefined,
      BENCH_SIGNING_SECRET: undefined,
    });
    assert.equal(missingSecretExport.status, 3, missingSecretExport.stdout + missingSecretExport.stderr);
    assert.equal(JSON.parse(missingSecretExport.stdout.trim()).data.code, 'EXPORT_UNVERIFIED_FORBIDDEN');

    // 6. `evolve export --format oci-layout --allow-synthetic-probe` with HMAC secret -> exit 0 + verified OCI bundle + driverConstraint
    const okExport = await runCliInProcess([
      'evolve', 'export', '--campaign', campaignStateDir, '--out', ociOutDir, '--format', 'oci-layout', '--allow-synthetic-probe', '--json',
    ], cliEnv);
    assert.equal(okExport.status, 0, okExport.stdout + okExport.stderr);
    const exportEnv = JSON.parse(okExport.stdout.trim()) as {
      kind: string;
      data: { format: string; exportedIndividualIds: readonly string[]; blobCount: number };
    };
    assert.equal(exportEnv.kind, 'result');
    assert.equal(exportEnv.data.format, 'oci-layout');
    assert.equal(exportEnv.data.exportedIndividualIds.length, 3);
    assert.equal(exportEnv.data.blobCount, 3);

    const verified = await verifyEvolutionBundle({
      bundleDir: ociOutDir,
      allowSyntheticProbe: true,
      receiptSigningSecret: BENCH_HMAC_SECRET,
    });
    assert.equal(verified.format, 'oci-layout');
    assert.equal(verified.manifest.compatibility.driverConstraint, '>=550.0');
    assert.equal(verified.dispatchManifest.fallback, 'baseline');
    assert.equal(verified.receiptCount, 3);
    assert.equal(verified.blobCount, 3);

    // 7. Re-exporting to existing dir without --overwrite -> EVOLUTION_CONFLICT (exit 7); with --overwrite -> exit 0
    const conflictExport = await runCliInProcess([
      'evolve', 'export', '--campaign', campaignStateDir, '--out', ociOutDir, '--format', 'oci-layout', '--allow-synthetic-probe', '--json',
    ], cliEnv);
    assert.equal(conflictExport.status, 7, conflictExport.stdout + conflictExport.stderr);
    assert.equal(JSON.parse(conflictExport.stdout.trim()).data.code, 'EVOLUTION_CONFLICT');

    const overwriteExport = await runCliInProcess([
      'evolve', 'export', '--campaign', campaignStateDir, '--out', ociOutDir, '--format', 'oci-layout', '--allow-synthetic-probe', '--overwrite', '--json',
    ], cliEnv);
    assert.equal(overwriteExport.status, 0, overwriteExport.stdout + overwriteExport.stderr);

    // 8. Tamper 1 byte of a CAS .cubin blob -> evolve export fails closed with ARTIFACT_INVALID (exit 4)
    const bs1Digest = sha256Hex(Buffer.from(bs1CubinHex, 'hex'));
    const casBlobPath = join(campaignStateDir, 'cas', 'sha256', bs1Digest);
    const originalBlob = await readFile(casBlobPath);
    const tamperedBlob = Buffer.from(originalBlob);
    tamperedBlob[0] = tamperedBlob[0]! ^ 0xff;
    await chmod(casBlobPath, 0o600);
    await writeFile(casBlobPath, tamperedBlob);
    await chmod(casBlobPath, 0o400);

    const tamperedExport = await runCliInProcess([
      'evolve', 'export',
      '--campaign', campaignStateDir,
      '--out', join(root, 'tampered-bundle'),
      '--format', 'oci-layout',
      '--allow-synthetic-probe',
      '--json',
    ], cliEnv);
    assert.equal(tamperedExport.status, 4, tamperedExport.stdout + tamperedExport.stderr);
    assert.equal(JSON.parse(tamperedExport.stdout.trim()).data.code, 'ARTIFACT_INVALID');
  } finally {
    workerAbort.abort();
    await workerPromise;
    await relay.close();
    await new Promise<void>(resolveClose => sseServer.close(() => resolveClose()));
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(workerFatalError, null);
});

test('evolve-cli: overlapping --state inside --repo fails closed with EVOLUTION_SCHEMA_INVALID (exit 2)', async () => {
  const realTmp = await realpath(tmpdir());
  const root = await mkdtemp(join(realTmp, 'lw-evolve-cli-disjoint-'));
  try {
    const repoDir = join(root, 'repo');
    await initGitRepo(repoDir, {
      '.loopwright/taskpack.yaml': {
        content: [
          'apiVersion: loopwright.dev/v1alpha1',
          'kind: Taskpack',
          'metadata:',
          '  name: cli-disjoint-tp',
          'spec:',
          '  goal:',
          '    candidate: Evolve kernel.',
          '    noChange: No change.',
          '  target:',
          '    matrix:',
          '      - id: cuda-sm90',
          '        platform: linux/amd64',
          '        variant: cuda12',
          '        hardware:',
          '          accelerator: sm_90a',
          '          isolationMode: whole_device',
          '          deviceCount: 1',
          '  scope:',
          '    writable: [src/kernels/**]',
          '    protected: [scripts/**]',
          '  models:',
          '    - provider: local-oai',
          '      id: mock-model',
          '      apiKeyEnv: LOCAL_OAI_KEY',
          '  verification:',
          '    localChecks:',
          '      - id: evolve-guard',
          '        implementation: evolve-block-guard.v1',
          '        parameters:',
          '          files: [src/kernels/flash_decode.cu]',
          '    externalGates:',
          '      - id: gpu-bench',
          '        implementation: benchmark-gate.v1',
          '        endpointId: hw-relay',
          '        gateId: flash-bench',
          '        required: true',
          '        targetCellId: cuda-sm90',
          '        heldOutWorkloadId: decode-bs1-4k',
          '        allowSyntheticHardwareProbe: true',
          '  publication:',
          '    mode: disabled',
        ].join('\n'),
      },
      '.loopwright/campaign.yaml': {
        content: [
          'apiVersion: loopwright.dev/v1alpha1',
          'kind: EvolutionCampaign',
          'metadata:',
          '  name: cli-disjoint-camp',
          'spec:',
          '  taskpack: .loopwright/taskpack.yaml',
          '  targetCellId: cuda-sm90',
          '  stages:',
          '    mode: single-target',
          '  population:',
          '    islands: 1',
          '    migrationIntervalGenerations: 2',
          '    maxMigrationElites: 1',
          '    nicheAxes:',
          '      - id: bound_pipeline',
          '        kind: enum',
          '        values: [hbm, tensor_cube]',
          '  sampling:',
          '    noveltyDecayLambda: 1.0',
          '    mutationWeights:',
          '      diff_tune: 0.5',
          '      full_rewrite: 0.5',
          '      crossover: 0.0',
          '    modelBandit: deterministic-round-robin',
          '    maxCrossoversPerPrompt: 1',
          '  objectives:',
          '    - metric: latency_us_p50',
          '      direction: minimize',
          '  budgets:',
          '    maxGenerations: 1',
          '    maxEvaluations: 1',
          '    maxConcurrentEvaluations: 1',
          '    scratchpadIntervalGenerations: 1',
        ].join('\n'),
      },
      'src/kernels/flash_decode.cu': { content: BASELINE_KERNEL_SOURCE },
    });

    const overlapRes = await runCliInProcess([
      'evolve', 'run',
      '--campaign', join(repoDir, '.loopwright', 'campaign.yaml'),
      '--state', join(repoDir, 'campaign-state'),
      '--repo', repoDir,
      '--json',
    ], { PATH: '/usr/bin:/bin', LOCAL_OAI_KEY });
    assert.equal(overlapRes.status, 2, overlapRes.stdout + overlapRes.stderr);
    const env = JSON.parse(overlapRes.stdout.trim()) as { kind: string; data: { code: string } };
    assert.equal(env.kind, 'diagnostic');
    assert.equal(env.data.code, 'EVOLUTION_SCHEMA_INVALID');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('evolve-cli: teamEvolution.enabled triggers isolated read-only LocalRunStore Pi supervisor on stall', { timeout: 120000 }, async () => {
  const realTmp = await realpath(tmpdir());
  const root = await mkdtemp(join(realTmp, 'lw-evolve-cli-team-sup-'));

  const relayCasDir = join(root, 'relay-cas');
  const workerWorkDir = join(root, 'worker-work');
  const workloadsDir = join(root, 'workloads');
  await mkdir(workerWorkDir, { recursive: true, mode: 0o700 });
  await mkdir(join(workloadsDir, 'decode-bs1-4k'), { recursive: true, mode: 0o700 });

  const evalScript = [
    `#!${process.execPath}`,
    'const payload = {',
    '  status: "approved",',
    '  metrics: { latency_us_p50: 40, goodput_rps: 2000, max_ulp: 1 },',
    '  bucketMetrics: [',
    '    { bucketId: "decode-bs1-4k", dimensions: { bs: 1 }, metrics: { latency_us_p50: 40, goodput_rps: 2000, max_ulp: 1 } }',
    '  ],',
    '  hardwareDiagnostics: { boundPipeline: "tensor_cube", occupancyPct: 75, rooflineHeadroom: 1.25 }',
    '};',
    'process.stdout.write("LOOPWRIGHT_STAGE_B_RESULT:" + JSON.stringify(payload) + "\\n");',
    '',
  ].join('\n');
  const evalPath = join(workloadsDir, 'decode-bs1-4k', 'evaluate.sh');
  await writeFile(evalPath, evalScript, { mode: 0o755 });
  await chmod(evalPath, 0o755);

  const cubinHex = buildElf64Cubin(['flash_decode_team_sm90a']).toString('hex');
  const buildScript = [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const outDir = process.env.LOOPWRIGHT_STAGE_A_OUT;',
    `fs.writeFileSync(path.join(outDir, "team_kernel.cubin"), Buffer.from(${JSON.stringify(cubinHex)}, "hex"));`,
    '',
  ].join('\n');

  const relay = await startRelayServer({
    port: 0,
    casDir: relayCasDir,
    controllerSigningSecret: BENCH_HMAC_SECRET,
    workerTokens: [WORKER_BEARER_TOKEN],
    leaseTtlMs: 15_000,
    sweepIntervalMs: 150,
  });

  const workerAbort = new AbortController();
  let workerFatalError: unknown = null;
  const workerPromise = runHardwareWorker({
    config: {
      workerId: 'evolve-cli-team-worker',
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
      pollWaitMs: 40,
      heartbeatIntervalMs: 50,
      requestTimeoutMs: 5_000,
      stageATimeoutMs: 15_000,
      stageBTimeoutMs: 15_000,
      toolchainPaths: [join(process.execPath, '..')],
      probeMode: 'synthetic_fixture',
    } satisfies WorkerConfig,
    once: false,
    signal: workerAbort.signal,
    registerProcessSignalHandlers: false,
  }).catch((err: unknown) => {
    if (!workerAbort.signal.aborted) workerFatalError = err;
  });

  let mutateTurn = 0;
  let supervisorCalls = 0;
  let probeRoleCalls = 0;
  const synthesizedTeamPatch = {
    kind: 'TeamPatch',
    schemaVersion: 'team-patch.v1',
    diagnosis: {
      summary: 'Island stalled on flat HBM roofline; split read-only probe from mutator',
      plateauCategory: 'coupled_responsibilities',
      rationale: 'Add a read-only probe step before mutating flash_decode.cu',
    },
    roles: [
      {
        id: 'probe-worker',
        archetypeRoleId: 'probe-readonly',
        purpose: 'task',
        tools: ['read'],
        model: 'mock-model',
        prompt: 'Inspect kernel bottleneck in read-only mode.',
      },
      {
        id: 'mutator-worker',
        archetypeRoleId: 'mutator',
        purpose: 'task',
        tools: ['read', 'write', 'edit'],
        model: 'mock-model',
        prompt: 'Mutate src/kernels/flash_decode.cu inside EVOLVE-BLOCK markers.',
      },
    ],
    steps: [
      { id: 'step-probe', roleId: 'probe-worker', dependsOn: [] },
      { id: 'step-mutate', roleId: 'mutator-worker', dependsOn: ['step-probe'] },
    ],
  };

  const sseServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const parsedBody = JSON.parse(bodyText) as {
        readonly messages?: readonly { readonly role?: string }[];
      };
      const isAfterTool = parsedBody.messages?.some(m => m.role === 'tool') ?? false;
      res.writeHead(200, { 'content-type': 'text/event-stream' });

      if (bodyText.includes('Diagnose island 0 plateau')) {
        supervisorCalls += 1;
        assert.equal(bodyText.includes('decode-bs1-4k'), false, 'heldOutWorkloadId must never enter Pi supervisor prompt');
        const supChunk = {
          id: `chatcmpl-sup-${supervisorCalls}`,
          object: 'chat.completion.chunk',
          choices: [{
            index: 0,
            delta: { role: 'assistant', content: JSON.stringify(synthesizedTeamPatch) },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 30, completion_tokens: 40, total_tokens: 70 },
        };
        res.end(`data: ${JSON.stringify(supChunk)}\n\ndata: [DONE]\n\n`);
        return;
      }

      if (bodyText.includes('Inspect kernel bottleneck in read-only mode.')) {
        probeRoleCalls += 1;
        const probeChunk = {
          id: `chatcmpl-probe-${probeRoleCalls}`,
          object: 'chat.completion.chunk',
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              content: '{"version":1,"status":"completed","checks":[],"reason":"probe completed read-only analysis"}',
            },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
        };
        res.end(`data: ${JSON.stringify(probeChunk)}\n\ndata: [DONE]\n\n`);
        return;
      }

      if (!isAfterTool) {
        mutateTurn += 1;
        const nextKernel = BASELINE_KERNEL_SOURCE.replace('return 0; // baseline', `return ${mutateTurn * 10 + 1}; // team_gen_${mutateTurn}`);
        const toolChunk = {
          id: `chatcmpl-mut-tool-${mutateTurn}`,
          object: 'chat.completion.chunk',
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [{
                index: 0,
                id: `call_team_write_${mutateTurn}`,
                type: 'function',
                function: {
                  name: 'write',
                  arguments: JSON.stringify({ path: 'src/kernels/flash_decode.cu', content: nextKernel }),
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
        };
        res.end(`data: ${JSON.stringify(toolChunk)}\n\ndata: [DONE]\n\n`);
        return;
      }

      const doneChunk = {
        id: `chatcmpl-mut-done-${mutateTurn}`,
        object: 'chat.completion.chunk',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            content: '{"version":1,"status":"completed","checks":[],"reason":"mutated kernel"}',
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      };
      res.end(`data: ${JSON.stringify(doneChunk)}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(resolveListen => sseServer.listen(0, '127.0.0.1', () => resolveListen()));
  const ssePort = (sseServer.address() as { port: number }).port;

  try {
    const modelsJsonPath = join(root, 'models.json');
    await writeFile(
      modelsJsonPath,
      JSON.stringify({
        providers: {
          'local-oai': {
            baseUrl: `http://127.0.0.1:${ssePort}/v1`,
            api: 'openai-completions',
            apiKey: 'LOCAL_OAI_KEY',
            models: [{ id: 'mock-model', contextWindow: 128_000, maxTokens: 4_096 }],
          },
        },
      }),
      { mode: 0o600 },
    );

    const repoDir = join(root, 'repo');
    await initGitRepo(repoDir, {
      '.loopwright/taskpack.yaml': {
        content: [
          'apiVersion: loopwright.dev/v1alpha1',
          'kind: Taskpack',
          'metadata:',
          '  name: cli-team-sup-tp',
          'spec:',
          '  goal:',
          '    candidate: Evolve flash decode kernel inside EVOLVE-BLOCK markers.',
          '    noChange: No kernel change needed.',
          '  target:',
          '    matrix:',
          '      - id: cuda-sm90',
          '        platform: linux/amd64',
          '        variant: cuda12',
          '        hardware:',
          '          accelerator: sm_90a',
          '          isolationMode: whole_device',
          '          deviceCount: 1',
          '  scope:',
          '    writable: [src/kernels/**]',
          '    protected: [scripts/**]',
          '  models:',
          '    - provider: local-oai',
          '      id: mock-model',
          '      apiKeyEnv: LOCAL_OAI_KEY',
          '  roles:',
          '    - id: mutator',
          '      provider: local-oai',
          '      model: mock-model',
          '      purpose: task',
          '      tools: [read, write, edit]',
          '      prompt: Mutate src/kernels/flash_decode.cu inside EVOLVE-BLOCK markers.',
          '    - id: probe-readonly',
          '      provider: local-oai',
          '      model: mock-model',
          '      purpose: task',
          '      tools: [read]',
          '      prompt: Read-only probe archetype.',
          '    - id: supervisor',
          '      provider: local-oai',
          '      model: mock-model',
          '      purpose: task',
          '      tools: [read]',
          '      prompt: Read-only plateau supervisor.',
          '  verification:',
          '    localChecks:',
          '      - id: evolve-guard',
          '        implementation: evolve-block-guard.v1',
          '        parameters:',
          '          files: [src/kernels/flash_decode.cu]',
          '    externalGates:',
          '      - id: gpu-bench',
          '        implementation: benchmark-gate.v1',
          '        endpointId: hw-relay',
          '        gateId: flash-decode-bench',
          '        required: true',
          '        targetCellId: cuda-sm90',
          '        heldOutWorkloadId: decode-bs1-4k',
          '        allowSyntheticHardwareProbe: true',
          '  publication:',
          '    mode: disabled',
        ].join('\n'),
      },
      '.loopwright/campaign.yaml': {
        content: [
          'apiVersion: loopwright.dev/v1alpha1',
          'kind: EvolutionCampaign',
          'metadata:',
          '  name: cli-team-sup-camp',
          'spec:',
          '  taskpack: .loopwright/taskpack.yaml',
          '  targetCellId: cuda-sm90',
          '  stages:',
          '    mode: single-target',
          '  population:',
          '    islands: 1',
          '    migrationIntervalGenerations: 4',
          '    maxMigrationElites: 1',
          '    nicheAxes:',
          '      - id: bound_pipeline',
          '        kind: enum',
          '        values: [hbm, tensor_cube]',
          '  sampling:',
          '    noveltyDecayLambda: 1.0',
          '    mutationWeights:',
          '      diff_tune: 0.5',
          '      full_rewrite: 0.5',
          '      crossover: 0.0',
          '    modelBandit: deterministic-round-robin',
          '    maxCrossoversPerPrompt: 1',
          '  teamEvolution:',
          '    enabled: true',
          '    supervisorRoleId: supervisor',
          '    allowedArchetypeRoles: [probe-readonly, mutator]',
          '    stallGenerations: 1',
          '    trialGenerations: 2',
          '    maxTeamSize: 2',
          '    maxTeamSteps: 2',
          '  objectives:',
          '    - metric: latency_us_p50',
          '      direction: minimize',
          '  budgets:',
          '    maxGenerations: 3',
          '    maxEvaluations: 6',
          '    maxConcurrentEvaluations: 1',
          '    scratchpadIntervalGenerations: 5',
        ].join('\n'),
      },
      'src/kernels/flash_decode.cu': { content: BASELINE_KERNEL_SOURCE },
      'scripts/build.sh': { content: buildScript, executable: true },
    });

    const stateDir = join(root, 'campaign-state');
    const cliEnv = {
      PATH: '/usr/bin:/bin',
      LOOPWRIGHT_MODELS_JSON: modelsJsonPath,
      LOOPWRIGHT_ALLOW_MANIFEST_CUSTOM_BASE_URL: 'true',
      LOOPWRIGHT_BENCHMARK_GATE_URL: `${relay.url}/v1/benchmark/jobs`,
      LOOPWRIGHT_GATE_SIGNING_SECRET: BENCH_HMAC_SECRET,
      LOCAL_OAI_KEY,
    };

    const runRes = await runCliInProcess([
      'evolve', 'run',
      '--campaign', join(repoDir, '.loopwright', 'campaign.yaml'),
      '--state', stateDir,
      '--repo', repoDir,
      '--allow-synthetic-probe',
      '--json',
    ], cliEnv);
    assert.equal(runRes.status, 0, runRes.stdout + runRes.stderr);
    assert.equal(supervisorCalls, 1, 'isolated read-only Pi supervisor must trigger exactly once on stall');
    assert.ok(probeRoleCalls >= 1, 'synthesized read-only probe role must execute on subsequent trial generation');

    const inspectRes = await runCliInProcess(['evolve', 'inspect', '--campaign', stateDir, '--json'], cliEnv);
    assert.equal(inspectRes.status, 0, inspectRes.stdout + inspectRes.stderr);
    const inspectEnv = JSON.parse(inspectRes.stdout.trim()) as {
      data: {
        teamConfigs: readonly { teamConfigId: string; status: string; patchCasDigest: unknown }[];
      };
    };
    assert.equal(inspectEnv.data.teamConfigs.length, 2, 'incumbent + synthesized trial team must be recorded');
    assert.ok(inspectEnv.data.teamConfigs.some(tc => tc.patchCasDigest !== null));
  } finally {
    workerAbort.abort();
    await workerPromise;
    await relay.close();
    await new Promise<void>(resolveClose => sseServer.close(() => resolveClose()));
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(workerFatalError, null);
});

test('evolve-cli: exact whitespace/comment clone edit is rejected with NOVELTY_CLONE_REJECTED and 0 hardware benchmark dispatches', { timeout: 120000 }, async () => {
  const realTmp = await realpath(tmpdir());
  const root = await mkdtemp(join(realTmp, 'lw-evolve-cli-novelty-'));

  const relayCasDir = join(root, 'relay-cas');
  const workerWorkDir = join(root, 'worker-work');
  const workloadsDir = join(root, 'workloads');
  await mkdir(workerWorkDir, { recursive: true, mode: 0o700 });
  await mkdir(join(workloadsDir, 'decode-bs1-4k'), { recursive: true, mode: 0o700 });

  const evalScript = [
    `#!${process.execPath}`,
    'const payload = {',
    '  status: "approved",',
    '  metrics: { latency_us_p50: 32, goodput_rps: 2800, max_ulp: 1 },',
    '  bucketMetrics: [',
    '    { bucketId: "decode-bs1-4k", dimensions: { bs: 1 }, metrics: { latency_us_p50: 32, goodput_rps: 2800, max_ulp: 1 } }',
    '  ],',
    '  hardwareDiagnostics: { boundPipeline: "tensor_cube", occupancyPct: 80, rooflineHeadroom: 1.15 }',
    '};',
    'process.stdout.write("LOOPWRIGHT_STAGE_B_RESULT:" + JSON.stringify(payload) + "\\n");',
    '',
  ].join('\n');
  const evalPath = join(workloadsDir, 'decode-bs1-4k', 'evaluate.sh');
  await writeFile(evalPath, evalScript, { mode: 0o755 });
  await chmod(evalPath, 0o755);

  const cubinHex = buildElf64Cubin(['flash_decode_novelty_sm90a']).toString('hex');
  const buildScript = [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const outDir = process.env.LOOPWRIGHT_STAGE_A_OUT;',
    `fs.writeFileSync(path.join(outDir, "novelty_kernel.cubin"), Buffer.from(${JSON.stringify(cubinHex)}, "hex"));`,
    '',
  ].join('\n');

  const relay = await startRelayServer({
    port: 0,
    casDir: relayCasDir,
    controllerSigningSecret: BENCH_HMAC_SECRET,
    workerTokens: [WORKER_BEARER_TOKEN],
    leaseTtlMs: 15_000,
    sweepIntervalMs: 150,
  });

  let workerJobsProcessed = 0;
  const workerAbort = new AbortController();
  let workerFatalError: unknown = null;
  const workerPromise = runHardwareWorker({
    config: {
      workerId: 'evolve-cli-novelty-worker',
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
      pollWaitMs: 40,
      heartbeatIntervalMs: 50,
      requestTimeoutMs: 5_000,
      stageATimeoutMs: 15_000,
      stageBTimeoutMs: 15_000,
      toolchainPaths: [join(process.execPath, '..')],
      probeMode: 'synthetic_fixture',
    } satisfies WorkerConfig,
    once: false,
    signal: workerAbort.signal,
    registerProcessSignalHandlers: false,
    onJobSettled: () => {
      workerJobsProcessed += 1;
    },
  }).catch((err: unknown) => {
    if (!workerAbort.signal.aborted) workerFatalError = err;
  });

  let sseTurn = 0;
  const sseServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        readonly messages?: readonly { readonly role?: string }[];
      };
      const isAfterTool = parsedBody.messages?.some(m => m.role === 'tool') ?? false;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (!isAfterTool) {
        sseTurn += 1;
        // Gen 1 writes return 42; Gen 2 writes an exact whitespace/comment clone of Gen 1!
        const nextKernel = sseTurn === 1
          ? BASELINE_KERNEL_SOURCE.replace('return 0; // baseline', 'return 42; // gen 1 original')
          : BASELINE_KERNEL_SOURCE.replace('return 0; // baseline', '  return   42; /* gen 2 whitespace/comment clone */');
        const toolChunk = {
          id: `chatcmpl-nov-tool-${sseTurn}`,
          object: 'chat.completion.chunk',
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [{
                index: 0,
                id: `call_nov_write_${sseTurn}`,
                type: 'function',
                function: {
                  name: 'write',
                  arguments: JSON.stringify({ path: 'src/kernels/flash_decode.cu', content: nextKernel }),
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
        };
        res.end(`data: ${JSON.stringify(toolChunk)}\n\ndata: [DONE]\n\n`);
        return;
      }

      const doneChunk = {
        id: `chatcmpl-nov-done-${sseTurn}`,
        object: 'chat.completion.chunk',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            content: '{"version":1,"status":"completed","checks":[],"reason":"wrote kernel variant"}',
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      };
      res.end(`data: ${JSON.stringify(doneChunk)}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(resolveListen => sseServer.listen(0, '127.0.0.1', () => resolveListen()));
  const ssePort = (sseServer.address() as { port: number }).port;

  try {
    const modelsJsonPath = join(root, 'models.json');
    await writeFile(
      modelsJsonPath,
      JSON.stringify({
        providers: {
          'local-oai': {
            baseUrl: `http://127.0.0.1:${ssePort}/v1`,
            api: 'openai-completions',
            apiKey: 'LOCAL_OAI_KEY',
            models: [{ id: 'mock-model', contextWindow: 128_000, maxTokens: 4_096 }],
          },
        },
      }),
      { mode: 0o600 },
    );

    const repoDir = join(root, 'repo');
    await initGitRepo(repoDir, {
      '.loopwright/taskpack.yaml': {
        content: [
          'apiVersion: loopwright.dev/v1alpha1',
          'kind: Taskpack',
          'metadata:',
          '  name: cli-novelty-tp',
          'spec:',
          '  goal:',
          '    candidate: Evolve flash decode kernel inside EVOLVE-BLOCK markers.',
          '    noChange: No kernel change needed.',
          '  target:',
          '    matrix:',
          '      - id: cuda-sm90',
          '        platform: linux/amd64',
          '        variant: cuda12',
          '        hardware:',
          '          accelerator: sm_90a',
          '          isolationMode: whole_device',
          '          deviceCount: 1',
          '  scope:',
          '    writable: [src/kernels/**]',
          '    protected: [scripts/**]',
          '  models:',
          '    - provider: local-oai',
          '      id: mock-model',
          '      apiKeyEnv: LOCAL_OAI_KEY',
          '  roles:',
          '    - id: mutator',
          '      provider: local-oai',
          '      model: mock-model',
          '      purpose: task',
          '      tools: [read, write, edit]',
          '      prompt: Mutate src/kernels/flash_decode.cu inside EVOLVE-BLOCK markers.',
          '  verification:',
          '    localChecks:',
          '      - id: evolve-guard',
          '        implementation: evolve-block-guard.v1',
          '        parameters:',
          '          files: [src/kernels/flash_decode.cu]',
          '    externalGates:',
          '      - id: gpu-bench',
          '        implementation: benchmark-gate.v1',
          '        endpointId: hw-relay',
          '        gateId: flash-decode-bench',
          '        required: true',
          '        targetCellId: cuda-sm90',
          '        heldOutWorkloadId: decode-bs1-4k',
          '        allowSyntheticHardwareProbe: true',
          '  publication:',
          '    mode: disabled',
        ].join('\n'),
      },
      '.loopwright/campaign.yaml': {
        content: [
          'apiVersion: loopwright.dev/v1alpha1',
          'kind: EvolutionCampaign',
          'metadata:',
          '  name: cli-novelty-camp',
          'spec:',
          '  taskpack: .loopwright/taskpack.yaml',
          '  targetCellId: cuda-sm90',
          '  stages:',
          '    mode: single-target',
          '  population:',
          '    islands: 1',
          '    migrationIntervalGenerations: 4',
          '    maxMigrationElites: 1',
          '    nicheAxes:',
          '      - id: bound_pipeline',
          '        kind: enum',
          '        values: [hbm, tensor_cube]',
          '  sampling:',
          '    noveltyDecayLambda: 1.0',
          '    mutationWeights:',
          '      diff_tune: 0.5',
          '      full_rewrite: 0.5',
          '      crossover: 0.0',
          '    modelBandit: deterministic-round-robin',
          '    maxCrossoversPerPrompt: 1',
          '  objectives:',
          '    - metric: latency_us_p50',
          '      direction: minimize',
          '  budgets:',
          '    maxGenerations: 2',
          '    maxEvaluations: 4',
          '    maxConcurrentEvaluations: 1',
          '    scratchpadIntervalGenerations: 5',
        ].join('\n'),
      },
      'src/kernels/flash_decode.cu': { content: BASELINE_KERNEL_SOURCE },
      'scripts/build.sh': { content: buildScript, executable: true },
    });

    const stateDir = join(root, 'campaign-state');
    const cliEnv = {
      PATH: '/usr/bin:/bin',
      LOOPWRIGHT_MODELS_JSON: modelsJsonPath,
      LOOPWRIGHT_ALLOW_MANIFEST_CUSTOM_BASE_URL: 'true',
      LOOPWRIGHT_BENCHMARK_GATE_URL: `${relay.url}/v1/benchmark/jobs`,
      LOOPWRIGHT_GATE_SIGNING_SECRET: BENCH_HMAC_SECRET,
      LOCAL_OAI_KEY,
    };

    const runRes = await runCliInProcess([
      'evolve', 'run',
      '--campaign', join(repoDir, '.loopwright', 'campaign.yaml'),
      '--state', stateDir,
      '--repo', repoDir,
      '--allow-synthetic-probe',
      '--json',
    ], cliEnv);
    assert.equal(runRes.status, 0, runRes.stdout + runRes.stderr);
    assert.equal(workerJobsProcessed, 1, 'clone candidate must trigger 0 hardware benchmark dispatches');

    const runEnv = JSON.parse(runRes.stdout.trim()) as {
      data: {
        campaign: { evaluationsUsed: number };
        noveltyRejectionsCount: number;
      };
    };
    assert.equal(runEnv.data.noveltyRejectionsCount, 1);
    assert.equal(runEnv.data.campaign.evaluationsUsed, 1, 'NOVELTY_CLONE_REJECTED must not consume evaluation budget');

    const inspectRes = await runCliInProcess(['evolve', 'inspect', '--campaign', stateDir, '--json'], cliEnv);
    assert.equal(inspectRes.status, 0, inspectRes.stdout + inspectRes.stderr);
    const inspectEnv = JSON.parse(inspectRes.stdout.trim()) as {
      data: {
        individuals: readonly { status: string; failureReason: string | null }[];
      };
    };
    assert.equal(inspectEnv.data.individuals.length, 2);
    assert.equal(inspectEnv.data.individuals.filter(i => i.status === 'passed').length, 1);
    assert.equal(
      inspectEnv.data.individuals.filter(i => i.status === 'failed' && i.failureReason === 'NOVELTY_CLONE_REJECTED').length,
      1,
    );
  } finally {
    workerAbort.abort();
    await workerPromise;
    await relay.close();
    await new Promise<void>(resolveClose => sseServer.close(() => resolveClose()));
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(workerFatalError, null);
});

test('evolve-cli: 1-role cross-provider TeamPatch binds OPENAI_API_KEY and never leaks ANTHROPIC_API_KEY to openai endpoint', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'lw-evolve-cli-xprov-'));
  const observedOpenAiAuths: string[] = [];
  const sseServer = createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    if (req.url?.startsWith('/openai/')) {
      observedOpenAiAuths.push(auth);
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const doneChunk = {
        id: 'chatcmpl-xprov-1',
        object: 'chat.completion.chunk',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            content: '{"version":1,"status":"no_change","checks":[],"reason":"checked cross-provider auth"}',
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      };
      res.end(`data: ${JSON.stringify(doneChunk)}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(resolveListen => sseServer.listen(0, '127.0.0.1', () => resolveListen()));
  const ssePort = (sseServer.address() as { port: number }).port;

  const prevAnth = process.env['ANTHROPIC_API_KEY'];
  const prevOai = process.env['OPENAI_API_KEY'];
  const prevModelsJson = process.env['LOOPWRIGHT_MODELS_JSON'];
  const prevAllowCustomUrl = process.env['LOOPWRIGHT_ALLOW_MANIFEST_CUSTOM_BASE_URL'];
  const prevBenchUrl = process.env['LOOPWRIGHT_BENCHMARK_GATE_URL'];
  const prevGateSecret = process.env['LOOPWRIGHT_GATE_SIGNING_SECRET'];

  try {
    const modelsJsonPath = join(root, 'models.json');
    await writeFile(
      modelsJsonPath,
      JSON.stringify({
        providers: {
          anthropic: {
            baseUrl: `http://127.0.0.1:${ssePort}/anthropic`,
            api: 'openai-completions',
            models: [{ id: 'claude-sonnet-4-6', contextWindow: 128_000, maxTokens: 4_096 }],
          },
          openai: {
            baseUrl: `http://127.0.0.1:${ssePort}/openai`,
            api: 'openai-completions',
            models: [{ id: 'gpt-5.4', contextWindow: 128_000, maxTokens: 4_096 }],
          },
        },
      }),
      { mode: 0o600 },
    );

    const taskpackYaml = [
      'apiVersion: loopwright.dev/v1alpha1',
      'kind: Taskpack',
      'metadata:',
      '  name: xprov-tp',
      'spec:',
      '  goal:',
      '    candidate: Optimize decode kernel.',
      '    noChange: No change.',
      '  target:',
      '    matrix:',
      '      - id: cuda-sm90',
      '        platform: linux/amd64',
      '        variant: cuda12',
      '        hardware:',
      '          accelerator: sm_90a',
      '          isolationMode: whole_device',
      '          deviceCount: 1',
      '  scope:',
      '    writable: [src/kernels/**]',
      '    protected: [scripts/**]',
      '  models:',
      '    - provider: anthropic',
      '      id: claude-sonnet-4-6',
      '    - provider: openai',
      '      id: gpt-5.4',
      '  roles:',
      '    - id: mutator',
      '      provider: anthropic',
      '      model: claude-sonnet-4-6',
      '      purpose: task',
      '      tools: [read, edit]',
      '      prompt: Edit kernel.',
      '  verification:',
      '    localChecks:',
      '      - id: evolve-guard',
      '        implementation: evolve-block-guard.v1',
      '        parameters:',
      '          files: [src/kernels/flash_decode.cu]',
      '    externalGates:',
      '      - id: gpu-bench',
      '        implementation: benchmark-gate.v1',
      '        endpointId: hw-relay',
      '        gateId: flash-decode-bench',
      '        required: true',
      '        targetCellId: cuda-sm90',
      '        heldOutWorkloadId: decode-bs1-4k',
      '        allowSyntheticHardwareProbe: true',
      '  publication:',
      '    mode: disabled',
    ].join('\n');

    const campaignYaml = [
      'apiVersion: loopwright.dev/v1alpha1',
      'kind: EvolutionCampaign',
      'metadata:',
      '  name: xprov-camp',
      'spec:',
      '  taskpack: .loopwright/taskpack.yaml',
      '  targetCellId: cuda-sm90',
      '  stages:',
      '    mode: single-target',
      '  population:',
      '    islands: 1',
      '    migrationIntervalGenerations: 4',
      '    maxMigrationElites: 1',
      '    nicheAxes:',
      '      - id: bound_pipeline',
      '        kind: enum',
      '        values: [hbm, tensor_cube]',
      '  sampling:',
      '    noveltyDecayLambda: 1.0',
      '    mutationWeights:',
      '      diff_tune: 1.0',
      '      full_rewrite: 0.0',
      '      crossover: 0.0',
      '    maxCrossoversPerPrompt: 1',
      '  objectives:',
      '    - metric: latency_us_p50',
      '      direction: minimize',
      '  budgets:',
      '    maxGenerations: 1',
      '    maxEvaluations: 1',
      '    maxConcurrentEvaluations: 1',
      '    scratchpadIntervalGenerations: 5',
    ].join('\n');

    const repoDir = join(root, 'repo');
    const baseRevision = await initGitRepo(repoDir, {
      '.loopwright/taskpack.yaml': { content: taskpackYaml },
      '.loopwright/campaign.yaml': { content: campaignYaml },
      'src/kernels/flash_decode.cu': { content: BASELINE_KERNEL_SOURCE },
    });

    process.env['ANTHROPIC_API_KEY'] = 'sk-anth-DO-NOT-LEAK-TO-OPENAI-0123456789';
    process.env['OPENAI_API_KEY'] = 'sk-oai-EXPECTED-KEY-0123456789abcdef';
    process.env['LOOPWRIGHT_MODELS_JSON'] = modelsJsonPath;
    process.env['LOOPWRIGHT_ALLOW_MANIFEST_CUSTOM_BASE_URL'] = 'true';
    process.env['LOOPWRIGHT_BENCHMARK_GATE_URL'] = `http://127.0.0.1:${ssePort}/bench`;
    process.env['LOOPWRIGHT_GATE_SIGNING_SECRET'] = BENCH_HMAC_SECRET;

    const manifest = parseEvolutionCampaignDocument(campaignYaml);
    const taskpack = await loadDeclarativeTaskpack({
      bytes: Buffer.from(taskpackYaml, 'utf8'),
      format: 'yaml',
      allowLoopbackHttp: true,
    });

    const coreScrubber = new SecretScrubber();
    const taskpackScrubber = new TaskpackSecretScrubber();
    const evaluator = createCliEvolutionEvaluator({
      repositoryRoot: repoDir,
      coreScrubber,
      taskpackScrubber,
    });

    const campRoot = join(root, 'camp-state');
    const childRunDir = join(campRoot, 'runs', 'ind-xprov-1');
    await mkdir(childRunDir, { recursive: true, mode: 0o700 });

    await evaluator({
      campaignId: 'camp-xprov',
      campaignRoot: campRoot,
      childRunDir,
      baseRevision,
      individualId: 'ind-xprov-1',
      islandId: 0,
      generation: 1,
      stagePhase: 'single-target',
      bucketId: null,
      heldOutWorkloadId: 'decode-bs1-4k',
      teamConfigId: 'team-xprov-1',
      modelId: 'claude-sonnet-4-6',
      trackId: 'triton',
      mutationKind: 'diff_tune',
      parents: [],
      stagedParentFiles: [],
      manifest,
      taskpack,
      teamPatch: {
        kind: 'TeamPatch',
        schemaVersion: 'team-patch.v1',
        diagnosis: {
          summary: 'Switch single mutator role to openai/gpt-5.4',
          plateauCategory: 'coupled_responsibilities',
          rationale: 'Use openai provider even when bandit slot selected anthropic modelId',
        },
        roles: [
          {
            id: 'mutator-oai',
            archetypeRoleId: 'mutator',
            purpose: 'task',
            tools: ['read', 'edit'],
            model: 'openai/gpt-5.4',
            prompt: 'Inspect kernel.',
          },
        ],
        steps: [{ id: 'step-mut', roleId: 'mutator-oai', dependsOn: [] }],
      },
    });

    assert.ok(observedOpenAiAuths.length >= 1, 'openai endpoint must receive the 1-role cross-provider request');
    assert.ok(
      observedOpenAiAuths.every(h => h === 'Bearer sk-oai-EXPECTED-KEY-0123456789abcdef'),
      `expected OPENAI_API_KEY on openai endpoint, got ${JSON.stringify(observedOpenAiAuths)}`,
    );
    assert.ok(
      observedOpenAiAuths.every(h => !h.includes('sk-anth-DO-NOT-LEAK')),
      'ANTHROPIC_API_KEY must never be sent to openai endpoint',
    );
  } finally {
    if (prevAnth === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = prevAnth;
    if (prevOai === undefined) delete process.env['OPENAI_API_KEY'];
    else process.env['OPENAI_API_KEY'] = prevOai;
    if (prevModelsJson === undefined) delete process.env['LOOPWRIGHT_MODELS_JSON'];
    else process.env['LOOPWRIGHT_MODELS_JSON'] = prevModelsJson;
    if (prevAllowCustomUrl === undefined) delete process.env['LOOPWRIGHT_ALLOW_MANIFEST_CUSTOM_BASE_URL'];
    else process.env['LOOPWRIGHT_ALLOW_MANIFEST_CUSTOM_BASE_URL'] = prevAllowCustomUrl;
    if (prevBenchUrl === undefined) delete process.env['LOOPWRIGHT_BENCHMARK_GATE_URL'];
    else process.env['LOOPWRIGHT_BENCHMARK_GATE_URL'] = prevBenchUrl;
    if (prevGateSecret === undefined) delete process.env['LOOPWRIGHT_GATE_SIGNING_SECRET'];
    else process.env['LOOPWRIGHT_GATE_SIGNING_SECRET'] = prevGateSecret;
    await new Promise<void>(resolveClose => sseServer.close(() => resolveClose()));
    await rm(root, { recursive: true, force: true });
  }
});
