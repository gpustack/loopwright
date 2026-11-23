import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  admitTask,
  bindSubject,
  constructRunResult,
  digestArtifact,
  evaluateAcceptance,
  validateDocument,
  type MetricThresholdRule,
  type RunResult,
  type TaskContract,
} from '@loopwright/core';
import {
  installedHandlerDigests,
  inspectRun,
  loadTrustedConfiguration,
  resolveCanonicalCasBlobPath,
  stepNext,
  stepSubmit,
  streamVerifiedCasBlob,
  type ControllerConfiguration,
  type ControllerResult,
  type StepTickResult,
  type StepYield,
  type TrustedRegistry,
} from '@loopwright/controller';
import {
  runHardwareWorker,
  startRelayServer,
  type RelayServerHandle,
  type WorkerConfig,
} from '../src/index.js';

const RELAY_HMAC_SECRET = 'e2e-loopback-controller-hmac-secret-0123456789';
const RELAY_AUTH_BEARER = 'e2e-loopback-controller-bearer-token-0123456789';
const WORKER_BEARER = 'e2e-loopback-worker-pull-lease-token-0123456789';

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertControllerOk<T>(res: ControllerResult<T>, label: string): T {
  assert.equal(res.ok, true, `${label}: ${res.ok ? '' : JSON.stringify(res.error)}`);
  if (!res.ok) throw new Error(label);
  return res.value;
}

function assertYield(tick: StepTickResult): StepYield {
  assert.equal(tick.kind, 'step', `expected step yield, got ${JSON.stringify(tick).slice(0, 300)}`);
  if (tick.kind !== 'step') throw new Error('expected step yield');
  return tick;
}

function assertResultTick(tick: StepTickResult): RunResult {
  assert.equal(tick.kind, 'result', `expected result tick, got ${JSON.stringify(tick).slice(0, 300)}`);
  if (tick.kind !== 'result') throw new Error('expected result tick');
  return tick.result;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function hasLinuxProcCmdlineMarker(marker: string): Promise<boolean> {
  const entries = await readdir('/proc').catch(() => []);
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    if (Number(entry) === process.pid) continue;
    const raw = await readFile(`/proc/${entry}/cmdline`).catch(() => null);
    if (raw !== null && raw.toString('utf8').includes(marker)) {
      return true;
    }
  }
  return false;
}

async function initGitRepository(
  repoDir: string,
  files: Readonly<Record<string, { readonly content: string | Buffer; readonly mode?: number }>>,
): Promise<string> {
  await mkdir(repoDir, { recursive: true, mode: 0o700 });
  const git = (args: readonly string[]) =>
    execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: repoDir,
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        HOME: '/nonexistent',
        GIT_TERMINAL_PROMPT: '0',
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
  git(['init', '-q']);
  for (const [rel, spec] of Object.entries(files)) {
    const abs = join(repoDir, rel);
    await mkdir(join(abs, '..'), { recursive: true, mode: 0o700 });
    await writeFile(abs, spec.content, { mode: spec.mode ?? 0o644 });
    if (spec.mode !== undefined) {
      await chmod(abs, spec.mode);
    }
  }
  git(['add', '.']);
  git(['-c', 'user.name=Loopback E2E', '-c', 'user.email=e2e@localhost.invalid', 'commit', '-qm', 'baseline']);
  return git(['rev-parse', 'HEAD']).trim();
}

interface E2eHarnessOptions {
  readonly relay: RelayServerHandle;
  readonly allowSyntheticHardwareProbe: boolean;
  readonly maxPreemptions?: number;
  readonly maxImplementationRepairs?: number;
  readonly maxAttempts?: number;
  readonly checkOnRework?: { readonly rejectTo: string; readonly maxReworks: number };
  readonly metricThresholds?: readonly MetricThresholdRule[];
}

async function createControllerE2eHarness(root: string, opts: E2eHarnessOptions) {
  const operatorDir = join(root, 'operator');
  const taskDir = join(root, 'task');
  const repoDir = join(root, 'repo');
  const runRoot = join(root, 'runs');
  await mkdir(operatorDir, { recursive: true, mode: 0o700 });
  await mkdir(taskDir, { recursive: true, mode: 0o700 });

  const revision = await initGitRepository(repoDir, {
    'packages/README.md': { content: '# CUDA Kernel Workspace\n', mode: 0o644 },
    'packages/header.cuh': { content: '#pragma once\n#define TILE_M 128\n', mode: 0o644 },
    'packages/obsolete.cu': { content: '// remove in candidate\n', mode: 0o644 },
    'packages/build.sh': { content: '#!/bin/sh\necho "baseline non-exec"\n', mode: 0o644 },
  });

  const digests = await installedHandlerDigests();
  const registry: TrustedRegistry = {
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'TrustedRegistry',
    metadata: { name: 'e2e-operator' },
    spec: {
      version: 1,
      resourceVersion: 'ctx-e2e-1',
      handlers: [
        {
          id: 'package.patch',
          kind: 'agent',
          implementation: 'pi.agent.v1',
          version: 1,
          digest: digests['pi.agent.v1'],
          parameters: { prompt: 'Optimize SM90 GEMM kernel.', purpose: 'task' },
          capabilities: ['pi'],
        },
        {
          id: 'kernel-bench',
          kind: 'check',
          implementation: 'benchmark-gate.v1',
          version: 1,
          digest: digests['benchmark-gate.v1'],
          parameters: {
            checkId: 'kernel-bench',
            endpointRef: 'gpu-relay',
            gateId: 'sm90-gemm-gate',
            heldOutWorkloadId: 'gemm-fp16-4096',
            maxPreemptions: opts.maxPreemptions ?? 3,
          },
          capabilities: ['hardware_execution', 'read_only'],
        },
        {
          id: 'scope',
          kind: 'check',
          implementation: 'scope.v1',
          version: 1,
          digest: digests['scope.v1'],
          parameters: { checkId: null },
          capabilities: ['inert_bytes', 'read_only'],
        },
        {
          id: 'no-change',
          kind: 'check',
          implementation: 'no-change.v1',
          version: 1,
          digest: digests['no-change.v1'],
          parameters: { checkId: null },
          capabilities: ['inert_bytes', 'read_only'],
        },
      ],
      roleProfiles: [
        {
          id: 'builder',
          adapter: 'delegated',
          runtimeRef: null,
          providerCredentialRef: null,
          selection: { provider: 'antigravity', model: 'gemini-4-argon', thinking: 'high' },
          tools: ['read', 'write', 'edit', 'delete'],
          context: {
            mode: 'estimated_guard',
            estimator: 'lw-pi-final-json-bytes-v1',
            proofId: null,
            version: 1,
            evidence: 'estimated',
            workingWindowCeiling: 98_304,
            maxRequestBytes: 65_536,
            serviceMargin: 32_768,
            toolReserve: 16_384,
            maxOutputTokens: 2_048,
          },
          mcp: null,
        },
      ],
      runtimeProfiles: [],
      resources: [],
      credentialBindings: [
        {
          id: 'bench-signer',
          consumer: 'gate',
          destinationRef: 'gpu-relay',
          environmentNames: ['BENCH_SECRET'],
          template: '${BENCH_SECRET}',
        },
        {
          id: 'bench-auth',
          consumer: 'gate',
          destinationRef: 'gpu-relay',
          environmentNames: ['BENCH_BEARER'],
          template: '${BENCH_BEARER}',
        },
      ],
      environmentBindings: [
        { name: 'BENCH_SECRET', classification: 'credential', paths: ['/spec/credentials/0/template'] },
        { name: 'BENCH_BEARER', classification: 'credential', paths: ['/spec/credentials/1/template'] },
      ],
      gateEndpoints: [
        {
          id: 'gpu-relay',
          url: `${opts.relay.url}/v1/benchmark/jobs`,
          signingCredentialRef: 'bench-signer',
          authCredentialRef: 'bench-auth',
          timeoutMs: 4_000,
          maxPollMs: 15_000,
          pollInitialMs: 100,
          pollMaxMs: 200,
          jitter: 0,
        },
      ],
      publicationEndpoints: [],
    },
  };

  const registryJson = JSON.stringify(registry);
  const registrySha = sha256Hex(registryJson);
  const registryPath = join(operatorDir, 'registry.json');
  const configPath = join(taskDir, 'config.json');
  await writeFile(registryPath, registryJson, { mode: 0o600 });

  const taskRaw = {
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'TaskContract',
    spec: {
      goal: 'Optimize SM90a FP16 GEMM kernel',
      taskpack: 'sm90-gemm-opt',
      target: {
        repository: 'org/kernels',
        baseRevision: revision,
        sourceRevision: revision,
        matrix: [
          {
            id: 'cuda-sm90',
            platform: 'linux-x64',
            variant: 'sm90',
            hardware: {
              accelerator: 'sm_90a',
              isolationMode: 'whole_device',
              deviceCount: 1,
              driverConstraint: '>=550.54',
              topology: 'nvlink-single',
            },
          },
        ],
      },
      scope: {
        writable: ['packages/**'],
        protected: ['packages/policy/**'],
      },
      roles: [
        {
          id: 'builder',
          adapter: 'delegated',
          provider: 'antigravity',
          model: 'gemini-4-argon',
          thinking: 'high',
          tools: ['read', 'write', 'edit', 'delete'],
        },
      ],
      trustedContext: { revision: 'ctx-e2e-1', discovery: 'disabled', resources: [] },
      budgets: {
        wallTimeMs: 120_000,
        totalTokens: 100_000,
        perCallOutputTokens: 2_048,
        maxModelCalls: 8,
        maxConcurrency: 2,
        maxFormatRepairs: 0,
        maxImplementationRepairs: opts.maxImplementationRepairs ?? 0,
        maxTransportRetries: 2,
        overlay: { maxFiles: 129, maxBytes: 4_194_304 },
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
      steps: [
        { id: 'build', kind: 'agent', uses: 'package.patch', roleId: 'builder', dependsOn: [] },
        {
          id: 'bench-step',
          kind: 'check',
          uses: 'kernel-bench',
          roleId: null,
          dependsOn: ['build'],
          ...(opts.checkOnRework !== undefined ? { onRework: opts.checkOnRework } : {}),
        },
      ],
      acceptance: {
        required: ['kernel-bench'],
        checks: [
          {
            id: 'kernel-bench',
            allowedEvidenceLevels: ['hardware_execution'],
            targetCellId: 'cuda-sm90',
            allowSyntheticHardwareProbe: opts.allowSyntheticHardwareProbe,
            metricThresholds: opts.metricThresholds ?? [
              { kind: 'bounds', metric: 'max_abs_err', max: 1e-3 },
              { kind: 'comparative', metric: 'tflops', baselineMetric: 'baseline_tflops', operator: 'min_ratio', threshold: 1.5 },
            ],
          },
        ],
      },
    },
  };
  const validatedTask = validateDocument(taskRaw, 'TaskContract');
  assert.equal(validatedTask.ok, true, JSON.stringify(validatedTask));
  if (!validatedTask.ok) throw new Error('invalid TaskContract');

  const config: ControllerConfiguration = {
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'ControllerConfig',
    spec: {
      task: validatedTask.value as TaskContract,
      registry: { name: 'e2e-operator', digest: { algorithm: 'sha256', hex: registrySha } },
      profiles: {
        roles: [{ roleId: 'builder', profileRef: 'builder' }],
        steps: [
          { stepId: 'build', handlerRef: 'package.patch' },
          { stepId: 'bench-step', handlerRef: 'kernel-bench' },
        ],
      },
      credentials: [
        { ref: 'bench-signer', template: '${BENCH_SECRET}' },
        { ref: 'bench-auth', template: '${BENCH_BEARER}' },
      ],
      controls: {
        maxAttempts: opts.maxAttempts ?? 4,
        drainReserveMs: 10_000,
        repeatFailureLimit: 2,
        submission: { mode: 'artifact_or_assistant', path: null },
      },
      publication: { mode: 'disabled' },
    },
  };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });

  const envMap: Readonly<Record<string, string | undefined>> = {
    BENCH_SECRET: RELAY_HMAC_SECRET,
    BENCH_BEARER: RELAY_AUTH_BEARER,
  };
  const prevSecret = process.env.BENCH_SECRET;
  const prevBearer = process.env.BENCH_BEARER;
  process.env.BENCH_SECRET = RELAY_HMAC_SECRET;
  process.env.BENCH_BEARER = RELAY_AUTH_BEARER;
  let loaded;
  try {
    loaded = assertControllerOk(
      await loadTrustedConfiguration({
        configPath,
        registryPath,
        registrySha256: registrySha,
        untrustedRoots: [taskDir],
      }),
      'loadTrustedConfiguration',
    );
  } finally {
    if (prevSecret === undefined) delete process.env.BENCH_SECRET;
    else process.env.BENCH_SECRET = prevSecret;
    if (prevBearer === undefined) delete process.env.BENCH_BEARER;
    else process.env.BENCH_BEARER = prevBearer;
  }

  return { repoDir, runRoot, loaded, envMap, task: validatedTask.value };
}

function makeOutboundWorkerConfig(relayUrl: string, workDir: string, workloadsDir: string): WorkerConfig {
  return {
    workerId: 'nat-outbound-worker-01',
    relayUrl,
    workerToken: WORKER_BEARER,
    workDir,
    heldOutWorkloadsDir: workloadsDir,
    sandboxBackend: 'native_os',
    capabilities: {
      accelerator: 'sm_90a',
      isolationModes: ['whole_device'],
      deviceCount: 1,
      driverVersion: '550.90.07',
      topology: 'nvlink-single',
      workloadIds: ['gemm-fp16-4096'],
    },
    pollWaitMs: 2_000,
    heartbeatIntervalMs: 80,
    requestTimeoutMs: 5_000,
    stageATimeoutMs: 15_000,
    stageBTimeoutMs: 15_000,
    toolchainPaths: [join(process.execPath, '..')],
    probeMode: 'synthetic_fixture',
  };
}

test('E2E #1: Happy path Controller -> Relay -> Outbound Worker -> Two-Stage Sandbox with >1 MiB overlay, LWTREE01 baseTreeBundle, 100755 build script, and CAS verifier ingestion', async () => {
  const realTmp = await realpath(tmpdir());
  const root = await mkdtemp(join(realTmp, 'lw-e2e-happy-'));
  const casDir = join(root, 'relay-cas');
  const workerWorkDir = join(root, 'worker-work');
  const workloadsDir = join(root, 'held_out_workloads');
  await mkdir(workerWorkDir, { recursive: true, mode: 0o700 });
  await mkdir(join(workloadsDir, 'gemm-fp16-4096'), { recursive: true, mode: 0o700 });

  await writeFile(join(workloadsDir, 'gemm-fp16-4096', 'secret-golden.bin'), 'GOLDEN_MATRIX_FP16_SECRET_DATA\n', {
    mode: 0o644,
  });
  await writeFile(
    join(workloadsDir, 'gemm-fp16-4096', 'evaluate.sh'),
    [
      `#!${process.execPath}`,
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const outDir = process.env.LOOPWRIGHT_STAGE_A_OUT;',
      'const wlDir = process.env.LOOPWRIGHT_HELD_OUT_WORKLOAD_DIR;',
      'if (!fs.statSync(path.join(outDir, "gemm_sm90.cubin")).isFile()) process.exit(2);',
      'const sass = fs.readFileSync(path.join(outDir, "gemm_sm90.sass"), "utf8");',
      'if (!sass.includes("TILE_M_FROM_BASE_TREE=128")) process.exit(3);',
      'const golden = fs.readFileSync(path.join(wlDir, "secret-golden.bin"), "utf8");',
      'if (!golden.includes("GOLDEN_MATRIX_FP16_SECRET_DATA")) process.exit(4);',
      'process.stdout.write(\'{"status":"approved","detail":"SM90a GEMM verified","metrics":{"max_abs_err":0.0002,"tflops":360.0,"baseline_tflops":200.0}}\\n\');',
    ].join('\n'),
    { mode: 0o755 },
  );

  const relay = await startRelayServer({
    port: 0,
    casDir,
    controllerSigningSecret: RELAY_HMAC_SECRET,
    controllerAuthToken: RELAY_AUTH_BEARER,
    workerTokens: [WORKER_BEARER],
    leaseTtlMs: 8_000,
    sweepIntervalMs: 100,
  });

  try {
    const h = await createControllerE2eHarness(join(root, 'ctrl'), {
      relay,
      allowSyntheticHardwareProbe: true,
    });

    const runId = 'run-e2e-happy';
    const step1 = assertYield(
      assertControllerOk(
        await stepNext({
          configuration: h.loaded,
          repository: h.repoDir,
          runRoot: h.runRoot,
          runId,
          environment: name => h.envMap[name],
        }),
        'stepNext',
      ),
    );

    const lutBytes = Buffer.alloc(1_363_148, 0x5a);
    await writeFile(join(step1.candidateDir, 'packages', 'lut.bin'), lutBytes, { mode: 0o644 });
    await writeFile(
      join(step1.candidateDir, 'packages', 'build.sh'),
      [
        `#!${process.execPath}`,
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const candDir = process.env.LOOPWRIGHT_CANDIDATE_DIR;',
        'const outDir = process.env.LOOPWRIGHT_STAGE_A_OUT;',
        'if (fs.existsSync(path.join(candDir, "packages/obsolete.cu"))) process.exit(9);',
        'if (!fs.readFileSync(path.join(candDir, "packages/header.cuh"), "utf8").includes("TILE_M 128")) process.exit(10);',
        'if (fs.statSync(path.join(candDir, "packages/lut.bin")).size !== 1363148) process.exit(11);',
        'fs.writeFileSync(path.join(outDir, "gemm_sm90.cubin"), Buffer.alloc(1150 * 1024, 0));',
        'fs.writeFileSync(path.join(outDir, "gemm_sm90.sass"), "/* SASS TILE_M_FROM_BASE_TREE=128 */\\n", "utf8");',
      ].join('\n'),
      { mode: 0o755 },
    );
    await chmod(join(step1.candidateDir, 'packages', 'build.sh'), 0o755);
    await rm(join(step1.candidateDir, 'packages', 'obsolete.cu'));

    const workerConfig = makeOutboundWorkerConfig(relay.url, workerWorkDir, workloadsDir);
    const [settledRes, workerRes] = await Promise.all([
      stepSubmit({
        runRoot: h.runRoot,
        runId,
        leaseToken: step1.leaseToken,
        status: 'completed',
        environment: name => h.envMap[name],
      }),
      runHardwareWorker({
        config: workerConfig,
        once: true,
        registerProcessSignalHandlers: false,
      }),
    ]);

    assert.equal(workerRes.exitReason, 'once_completed');
    assert.equal(workerRes.jobsProcessed, 1);
    assert.equal(workerRes.lastSettlement?.acknowledgment, 'confirmed');
    assert.deepEqual(await readdir(workerWorkDir), []);

    const runResult = assertResultTick(assertControllerOk(settledRes, 'stepSubmit'));
    assert.equal(runResult.spec.status, 'completed');
    assert.equal(runResult.spec.verification.spec.satisfied, true);

    const inspected = assertControllerOk(await inspectRun({ runRoot: h.runRoot, runId }), 'inspectRun');
    assert.equal(inspected.status.status, 'completed');

    const artifactsDir = join(h.runRoot, runId, 'artifacts');
    const sassExpectedBytes = Buffer.from('/* SASS TILE_M_FROM_BASE_TREE=128 */\n', 'utf8');
    const sassSha = sha256Hex(sassExpectedBytes);
    const sassCasPath = await resolveCanonicalCasBlobPath(artifactsDir, sassSha);
    await streamVerifiedCasBlob(
      artifactsDir,
      { sha256: sassSha, byteLength: sassExpectedBytes.byteLength, path: sassCasPath },
      undefined,
      'verification',
    );
    const sassStat = await lstat(sassCasPath);
    assert.equal(sassStat.mode & 0o7777, 0o400);
    assert.equal(sassStat.nlink, 1);

    const validatedResult = validateDocument(runResult, 'RunResult');
    assert.equal(validatedResult.ok, true);
  } finally {
    await relay.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('E2E #2: Real spawned worker child process receiving OS SIGTERM tears down default OS-sandboxed stage, requeues (3x -> 4th worker completes), and 4th preemption settles blocked (BENCHMARK_PREEMPTED) with ZERO repair/rework', async () => {
  const realTmp = await realpath(tmpdir());
  const root = await mkdtemp(join(realTmp, 'lw-e2e-preempt-'));
  const casDir = join(root, 'relay-cas');
  const workerWorkDir = join(root, 'worker-work');
  const workloadsDir = join(root, 'held_out_workloads');
  await mkdir(workerWorkDir, { recursive: true, mode: 0o700 });
  await mkdir(join(workloadsDir, 'gemm-fp16-4096'), { recursive: true, mode: 0o700 });

  // Stage B sleeps briefly when slow marker not bypassed, or scores immediately
  await writeFile(
    join(workloadsDir, 'gemm-fp16-4096', 'evaluate.sh'),
    '#!/bin/sh\nprintf \'{"status":"approved","metrics":{"max_abs_err":0.0001,"tflops":350.0,"baseline_tflops":200.0}}\\n\'\n',
    { mode: 0o755 },
  );

  const relay = await startRelayServer({
    port: 0,
    casDir,
    controllerSigningSecret: RELAY_HMAC_SECRET,
    controllerAuthToken: RELAY_AUTH_BEARER,
    workerTokens: [WORKER_BEARER],
    leaseTtlMs: 8_000,
    sweepIntervalMs: 100,
  });

  try {
    const h = await createControllerE2eHarness(join(root, 'ctrl'), {
      relay,
      allowSyntheticHardwareProbe: true,
      maxPreemptions: 3,
      maxImplementationRepairs: 2,
      maxAttempts: 6,
      checkOnRework: { rejectTo: 'build', maxReworks: 2 },
    });

    const workerConfig = makeOutboundWorkerConfig(relay.url, workerWorkDir, workloadsDir);
    const workerIndexUrl = pathToFileURL(resolve(process.cwd(), '.test-build/packages/hardware-runner/src/index.js')).href;
    const workerCliScript = join(root, 'worker-proc.mjs');
    await writeFile(
      workerCliScript,
      [
        `import { runHardwareWorker } from ${JSON.stringify(workerIndexUrl)};`,
        `const res = await runHardwareWorker({ config: ${JSON.stringify(workerConfig)}, once: true, registerProcessSignalHandlers: true });`,
        'process.stdout.write("PROC_DONE:" + JSON.stringify(res) + "\\n");',
      ].join('\n'),
      { mode: 0o600 },
    );

    // --- Scenario A: Real OS SIGTERM on Worker 1 (default two-stage evaluator) + 2 more preemptions -> 4th worker completes! ---
    const runIdRecover = 'run-e2e-preempt-recover';
    const stepA = assertYield(
      assertControllerOk(
        await stepNext({
          configuration: h.loaded,
          repository: h.repoDir,
          runRoot: h.runRoot,
          runId: runIdRecover,
          environment: name => h.envMap[name],
        }),
        'stepNext A',
      ),
    );
    // Stage A writes its sandboxed Node PID and waits ~650ms so Worker 1 gets OS SIGTERM mid-stage
    // (under macOS Seatbelt deny process-fork), while Worker 4 finishes cleanly after 650ms!
    await writeFile(
      join(stepA.candidateDir, 'packages', 'build.sh'),
      [
        `#!${process.execPath}`,
        'const cp = require("node:child_process");',
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'if (process.platform === "darwin") {',
        '  const forkRes = cp.spawnSync("/bin/echo", ["hi"]);',
        '  if (!forkRes.error || forkRes.error.code !== "EPERM") process.exit(44);',
        '}',
        'const outDir = process.env.LOOPWRIGHT_STAGE_A_OUT;',
        'const pidFile = path.join(outDir, "e2e-pids.txt");',
        'fs.writeFileSync(path.join(outDir, "k.cubin"), "cubin-ok\\n", "utf8");',
        'let pidNs = "";',
        'try { pidNs = fs.readlinkSync("/proc/self/ns/pid"); } catch {}',
        'fs.writeFileSync(pidFile, String(process.pid) + (pidNs ? " " + pidNs : "") + "\\n", "utf8");',
        'setTimeout(() => {',
        '  try { fs.unlinkSync(pidFile); } catch {}',
        '  process.exit(0);',
        '}, 650);',
      ].join('\n'),
      { mode: 0o755 },
    );
    await chmod(join(stepA.candidateDir, 'packages', 'build.sh'), 0o755);

    const workerSequenceA = (async () => {
      // Epoch 1: Spawn real Node worker child process running default two-stage OS sandbox and send OS SIGTERM!
      const child1 = spawn(process.execPath, [workerCliScript], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out1 = '';
      child1.stdout.on('data', (c: Buffer) => {
        out1 += c.toString('utf8');
      });
      let stagePid = 0;
      let stagePidNs = '';
      let stageJobDir = '';
      const pidDeadline = Date.now() + 8_000;
      while (Date.now() < pidDeadline && stagePid === 0) {
        const dirs = await readdir(workerWorkDir).catch(() => []);
        for (const d of dirs) {
          const txt = await readFile(join(workerWorkDir, d, 'stage-a', 'stage-a-out', 'e2e-pids.txt'), 'utf8').catch(() => '');
          const [pidToken = '', nsToken = ''] = txt.trim().split(/\s+/);
          const parsedPid = Number.parseInt(pidToken, 10);
          if (Number.isSafeInteger(parsedPid) && parsedPid > 0) {
            stagePid = parsedPid;
            stagePidNs = nsToken;
            stageJobDir = d;
            break;
          }
        }
        if (stagePid === 0) await new Promise(r => setTimeout(r, 15));
      }
      assert.equal(stagePid > 0, true);
      const selfPidNs = process.platform === 'linux'
        ? await readlink('/proc/self/ns/pid').catch(() => '')
        : '';
      const samePidNamespace = process.platform !== 'linux'
        || stagePidNs === ''
        || selfPidNs === ''
        || stagePidNs === selfPidNs;
      if (!samePidNamespace) {
        assert.equal(await hasLinuxProcCmdlineMarker(stageJobDir), true);
      }
      process.kill(child1.pid!, 'SIGTERM');
      const code1 = await new Promise<number | null>(r => child1.on('close', c => r(c)));
      assert.equal(code1, 0);
      assert.equal(
        samePidNamespace ? isPidAlive(stagePid) : await hasLinuxProcCmdlineMarker(stageJobDir),
        false,
      );
      assert.match(out1, /"outcome":"preempted"/);

      // Epochs 2 & 3: preempt via real worker subprocesses receiving OS SIGTERM as well
      for (const epoch of [2, 3]) {
        const pCtrl = new AbortController();
        const r = await runHardwareWorker({
          config: workerConfig,
          once: true,
          preemptSignal: pCtrl.signal,
          registerProcessSignalHandlers: false,
          onLeaseAcquired: g => {
            assert.equal(g.leaseEpoch, epoch);
            setTimeout(() => pCtrl.abort(), 30);
          },
        });
        assert.equal(r.exitReason, 'preempted');
        assert.equal(r.lastSettlement?.acknowledgment, 'confirmed');
      }

      // Epoch 4: Real worker subprocess runs unmodified default two-stage evaluator to completion!
      const fourth = await runHardwareWorker({
        config: workerConfig,
        once: true,
        registerProcessSignalHandlers: false,
      });
      assert.equal(fourth.exitReason, 'once_completed');
      assert.equal(fourth.lastSettlement?.leaseEpoch, 4);
      assert.equal(fourth.lastSettlement?.status, 'approved');
    })();

    const [submitARes] = await Promise.all([
      stepSubmit({
        runRoot: h.runRoot,
        runId: runIdRecover,
        leaseToken: stepA.leaseToken,
        status: 'completed',
        environment: name => h.envMap[name],
      }),
      workerSequenceA,
    ]);
    const resultA = assertResultTick(assertControllerOk(submitARes, 'stepSubmit A'));
    assert.equal(resultA.spec.status, 'completed');

    // --- Scenario B: 4 preemptions (leaseEpoch 1..4) exhausts maxPreemptions=3 -> settles blocked (BENCHMARK_PREEMPTED) with ZERO repair/rework! ---
    const runIdExhaust = 'run-e2e-preempt-exhaust';
    const stepB = assertYield(
      assertControllerOk(
        await stepNext({
          configuration: h.loaded,
          repository: h.repoDir,
          runRoot: h.runRoot,
          runId: runIdExhaust,
          environment: name => h.envMap[name],
        }),
        'stepNext B',
      ),
    );
    await writeFile(
      join(stepB.candidateDir, 'packages', 'build.sh'),
      `#!${process.execPath}\nsetTimeout(() => {}, 10_000);\n`,
      { mode: 0o755 },
    );
    await chmod(join(stepB.candidateDir, 'packages', 'build.sh'), 0o755);

    const workerSequenceB = (async () => {
      for (const epoch of [1, 2, 3, 4]) {
        const preempt = new AbortController();
        const r = await runHardwareWorker({
          config: workerConfig,
          once: true,
          preemptSignal: preempt.signal,
          registerProcessSignalHandlers: false,
          onLeaseAcquired: grant => {
            assert.equal(grant.leaseEpoch, epoch);
            setTimeout(() => preempt.abort(), 30);
          },
        });
        assert.equal(r.exitReason, 'preempted');
      }
    })();

    const [submitBRes] = await Promise.all([
      stepSubmit({
        runRoot: h.runRoot,
        runId: runIdExhaust,
        leaseToken: stepB.leaseToken,
        status: 'completed',
        environment: name => h.envMap[name],
      }),
      workerSequenceB,
    ]);
    const resultB = assertResultTick(assertControllerOk(submitBRes, 'stepSubmit B'));
    assert.equal(resultB.spec.status, 'blocked');
    assert.equal(resultB.spec.verification.spec.required[0]?.status, 'blocked');
    assert.equal(resultB.spec.verification.spec.required[0]?.detail, 'BENCHMARK_PREEMPTED');
  } finally {
    await relay.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('E2E #3: Quantitative threshold miss settles failed, while synthetic_fixture without opt-in or forged provenance settles blocked (HARDWARE_PROVENANCE_MISMATCH)', async () => {
  const realTmp = await realpath(tmpdir());
  const root = await mkdtemp(join(realTmp, 'lw-e2e-policy-'));
  const casDir = join(root, 'relay-cas');
  const workerWorkDir = join(root, 'worker-work');
  const workloadsDir = join(root, 'held_out_workloads');
  await mkdir(workerWorkDir, { recursive: true, mode: 0o700 });
  await mkdir(join(workloadsDir, 'gemm-fp16-4096'), { recursive: true, mode: 0o700 });

  await writeFile(
    join(workloadsDir, 'gemm-fp16-4096', 'evaluate.sh'),
    '#!/bin/sh\nprintf \'{"status":"approved","metrics":{"max_abs_err":0.0001,"tflops":220.0,"baseline_tflops":200.0}}\\n\'\n',
    { mode: 0o755 },
  );

  const relay = await startRelayServer({
    port: 0,
    casDir,
    controllerSigningSecret: RELAY_HMAC_SECRET,
    controllerAuthToken: RELAY_AUTH_BEARER,
    workerTokens: [WORKER_BEARER],
    leaseTtlMs: 8_000,
    sweepIntervalMs: 100,
  });

  try {
    const workerConfig = makeOutboundWorkerConfig(relay.url, workerWorkDir, workloadsDir);

    const hThreshold = await createControllerE2eHarness(join(root, 'ctrl-thresh'), {
      relay,
      allowSyntheticHardwareProbe: true,
      maxImplementationRepairs: 0,
    });
    const stepT = assertYield(
      assertControllerOk(
        await stepNext({
          configuration: hThreshold.loaded,
          repository: hThreshold.repoDir,
          runRoot: hThreshold.runRoot,
          runId: 'run-thresh-miss',
          environment: name => hThreshold.envMap[name],
        }),
        'stepNext threshold',
      ),
    );
    await writeFile(
      join(stepT.candidateDir, 'packages', 'build.sh'),
      '#!/bin/sh\nprintf "slow-cubin\\n" > "$LOOPWRIGHT_STAGE_A_OUT/slow.cubin"\n',
      { mode: 0o755 },
    );
    await chmod(join(stepT.candidateDir, 'packages', 'build.sh'), 0o755);

    const [threshSubmitRes] = await Promise.all([
      stepSubmit({
        runRoot: hThreshold.runRoot,
        runId: 'run-thresh-miss',
        leaseToken: stepT.leaseToken,
        status: 'completed',
        environment: name => hThreshold.envMap[name],
      }),
      runHardwareWorker({
        config: workerConfig,
        once: true,
        registerProcessSignalHandlers: false,
      }),
    ]);
    const threshResult = assertResultTick(assertControllerOk(threshSubmitRes, 'stepSubmit threshold'));
    assert.equal(threshResult.spec.status, 'failed');
    assert.equal(threshResult.spec.verification.spec.required[0]?.status, 'failed');

    await writeFile(
      join(workloadsDir, 'gemm-fp16-4096', 'evaluate.sh'),
      '#!/bin/sh\nprintf \'{"status":"approved","metrics":{"max_abs_err":0.0001,"tflops":380.0,"baseline_tflops":200.0}}\\n\'\n',
      { mode: 0o755 },
    );

    const hProd = await createControllerE2eHarness(join(root, 'ctrl-prod'), {
      relay,
      allowSyntheticHardwareProbe: false,
      maxImplementationRepairs: 2,
    });
    const stepP = assertYield(
      assertControllerOk(
        await stepNext({
          configuration: hProd.loaded,
          repository: hProd.repoDir,
          runRoot: hProd.runRoot,
          runId: 'run-synthetic-blocked',
          environment: name => hProd.envMap[name],
        }),
        'stepNext prod',
      ),
    );
    await writeFile(
      join(stepP.candidateDir, 'packages', 'build.sh'),
      '#!/bin/sh\nprintf "fast-cubin\\n" > "$LOOPWRIGHT_STAGE_A_OUT/fast.cubin"\n',
      { mode: 0o755 },
    );
    await chmod(join(stepP.candidateDir, 'packages', 'build.sh'), 0o755);

    const [prodSubmitRes] = await Promise.all([
      stepSubmit({
        runRoot: hProd.runRoot,
        runId: 'run-synthetic-blocked',
        leaseToken: stepP.leaseToken,
        status: 'completed',
        environment: name => hProd.envMap[name],
      }),
      runHardwareWorker({
        config: workerConfig,
        once: true,
        registerProcessSignalHandlers: false,
      }),
    ]);
    const prodResult = assertResultTick(assertControllerOk(prodSubmitRes, 'stepSubmit prod'));
    assert.equal(prodResult.spec.status, 'blocked');
    assert.equal(prodResult.spec.verification.spec.required[0]?.status, 'blocked');
    assert.equal(prodResult.spec.verification.spec.required[0]?.detail, 'HARDWARE_PROVENANCE_MISMATCH');

    const lockRes = admitTask(hProd.task, { admissionId: 'adm-core-forged', runId: 'run-core-forged' });
    assert.equal(lockRes.ok, true);
    if (!lockRes.ok) throw new Error('admitTask failed');
    const candBytes = Buffer.from('int main() {}\n', 'utf8');
    const candRefRes = digestArtifact('packages/kernel.cu', candBytes);
    assert.equal(candRefRes.ok, true);
    if (!candRefRes.ok) throw new Error('digestArtifact failed');
    const manifest = {
      apiVersion: 'loopwright.dev/v1alpha1' as const,
      kind: 'ArtifactManifest' as const,
      metadata: { id: 'manifest-forged' },
      spec: { entries: [candRefRes.value] },
    };
    const subRes = bindSubject(lockRes.value, manifest);
    assert.equal(subRes.ok, true);
    if (!subRes.ok) throw new Error('bindSubject failed');

    const forgedEvidence = {
      apiVersion: 'loopwright.dev/v1alpha1' as const,
      kind: 'Evidence' as const,
      metadata: { id: 'ev-forged-gpu' },
      spec: {
        checkId: 'kernel-bench',
        observedStatus: 'passed' as const,
        producerId: 'benchmark-gate',
        method: 'benchmark-gate',
        level: 'hardware_execution' as const,
        subject: subRes.value,
        artifacts: [candRefRes.value],
        reason: null,
        metrics: { max_abs_err: 0.0001, tflops: 400, baseline_tflops: 200 },
        hardwareProvenance: {
          targetCellId: 'cuda-sm90',
          probeKind: 'physical' as const,
          vendor: 'nvidia',
          deviceModel: 'Forged Wrong GPU',
          accelerator: 'sm_89',
          isolationMode: 'whole_device' as const,
          deviceCount: 1,
          driverVersion: '550.90.07',
          runtimeVersion: 'cuda-12.6',
          topology: 'nvlink-single',
          workloadDigest: { algorithm: 'sha256' as const, hex: '9'.repeat(64) },
          clockLockMode: 'locked' as const,
        },
      },
    };
    const forgedEval = evaluateAcceptance(
      JSON.parse(
        JSON.stringify({
          trusted: {
            expectedLock: lockRes.value,
            candidateManifest: manifest,
            eligibleEvidence: [forgedEvidence],
          },
          claims: [{ checkId: 'kernel-bench', status: 'passed', evidenceId: 'ev-forged-gpu', reason: null }],
        }),
      ),
      [{ name: 'packages/kernel.cu', bytes: candBytes }],
    );
    assert.equal(forgedEval.ok, true, JSON.stringify(forgedEval));
    if (!forgedEval.ok) throw new Error('evaluateAcceptance failed');
    assert.equal(forgedEval.value.spec.satisfied, false);
    assert.equal(forgedEval.value.spec.required[0]?.status, 'blocked');
    assert.equal(forgedEval.value.spec.required[0]?.reason, 'hardware_provenance_mismatch');

    const refusedCompleted = constructRunResult(
      JSON.parse(
        JSON.stringify({
          trusted: {
            expectedLock: lockRes.value,
            candidateManifest: manifest,
            eligibleEvidence: [forgedEvidence],
            usage: [],
            externalEffects: 'none',
            noChange: null,
          },
          candidate: {
            status: 'completed',
            checks: [{ checkId: 'kernel-bench', status: 'passed', evidenceId: 'ev-forged-gpu', reason: null }],
            memory: { status: 'not_requested', reason: null },
          },
        }),
      ),
      [{ name: 'packages/kernel.cu', bytes: candBytes }],
    );
    assert.equal(refusedCompleted.ok, false);
  } finally {
    await relay.close();
    await rm(root, { recursive: true, force: true });
  }
});
