import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  signRelayPayload,
  type BenchmarkRequest,
  type HardwareRunnerErrorCode,
} from '@loopwright/hardware-runner';
import { hardwareRunnerExitCode, main as cliMain } from '../src/main.js';

const MAIN = fileURLToPath(new URL('../src/main.js', import.meta.url));

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function runCliAsync(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

async function waitForLine(
  stream: NodeJS.ReadableStream,
  timeoutMs = 10_000,
): Promise<{ readonly line: string; readonly rest: () => string }> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      stream.off('data', onData);
      reject(new Error(`timed out waiting for stdout line; buffered: ${buffer}`));
    }, timeoutMs);
    const onData = (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl !== -1) {
        clearTimeout(timer);
        stream.off('data', onData);
        const line = buffer.slice(0, nl);
        const remaining = buffer.slice(nl + 1);
        resolve({ line, rest: () => remaining });
      }
    };
    stream.on('data', onData);
  });
}

function makeRelayBenchmarkRequest(
  operationId: string,
  buildScriptBytes: Buffer,
): BenchmarkRequest {
  const lockHex = sha256Hex('cli-lock-1');
  const contractHex = sha256Hex('cli-contract-1');
  const candHex = sha256Hex(buildScriptBytes);
  const matrixHex = sha256Hex('cli-matrix-1');
  const scriptSha = sha256Hex(buildScriptBytes);
  return {
    version: 1,
    kind: 'benchmark_request',
    storeId: 'cli-store-1',
    runId: 'cli-run-1',
    lockHash: { algorithm: 'sha256', hex: lockHex },
    operationId,
    dispatchId: `dispatch-${operationId}`,
    dispatchGeneration: 1,
    requestDigest: sha256Hex(`req:${operationId}`),
    gateId: 'cli-bench-gate',
    checkId: 'kernel-bench',
    candidateDigest: candHex,
    subject: {
      lockHash: { algorithm: 'sha256', hex: lockHex },
      contractHash: { algorithm: 'sha256', hex: contractHex },
      repository: 'org/kernels',
      baseRevision: '1'.repeat(40),
      sourceRevision: '2'.repeat(40),
      candidateDigest: { algorithm: 'sha256', hex: candHex },
      targetMatrixDigest: { algorithm: 'sha256', hex: matrixHex },
    },
    targetCellId: 'cuda-sm90',
    targetHardware: {
      accelerator: 'sm_90a',
      isolationMode: 'whole_device',
      deviceCount: 1,
      driverConstraint: '>=550.54',
      topology: 'nvlink-single',
    },
    heldOutWorkloadId: 'gemm-fp16-4096',
    metricThresholds: [
      { kind: 'bounds', metric: 'max_abs_err', max: 0.001 },
      { kind: 'comparative', metric: 'tflops', baselineMetric: 'baseline_tflops', operator: 'min_ratio', threshold: 1.2 },
    ],
    maxPreemptions: 3,
    candidateArtifacts: {
      entries: [
        {
          name: 'packages/build.sh',
          digest: { algorithm: 'sha256', hex: scriptSha },
          byteLength: buildScriptBytes.byteLength,
          mode: '100755',
        },
      ],
      deleted: [],
    },
  };
}

test('runner-cli: help flags, HELP text, and dynamic import isolation', async () => {
  const topHelp = spawnSync(process.execPath, [MAIN, '--help'], {
    encoding: 'utf8',
    timeout: 5_000,
    env: { PATH: '/usr/bin:/bin' },
  });
  assert.equal(topHelp.status, 0, topHelp.stderr);
  assert.match(topHelp.stdout, /runner relay --config FILE \[--json\]/);
  assert.match(topHelp.stdout, /runner worker --config FILE \[--once\] \[--json\]/);

  for (const helpArgv of [
    ['runner', '--help'],
    ['runner', 'relay', '--help'],
    ['runner', 'worker', '--help'],
  ]) {
    const res = spawnSync(process.execPath, [MAIN, ...helpArgv], {
      encoding: 'utf8',
      timeout: 5_000,
      env: { PATH: '/usr/bin:/bin' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /runner relay --config FILE \[--json\]/);
    assert.match(res.stdout, /runner worker --config FILE \[--once\] \[--json\]/);
  }

  const mainSrcPath = fileURLToPath(new URL('../../../../packages/cli/src/main.ts', import.meta.url));
  const mainSrc = await readFile(mainSrcPath, 'utf8');
  assert.equal(
    /^\s*import\s+(?!type\b)[^;]*@loopwright\/hardware-runner/m.test(mainSrc),
    false,
    'main.ts must not perform a runtime static import of @loopwright/hardware-runner',
  );
  assert.match(mainSrc, /await import\('@loopwright\/hardware-runner'\)/);
});

test('runner-cli: hardwareRunnerExitCode covers every HardwareRunnerErrorCode exhaustively', () => {
  const expected: Record<HardwareRunnerErrorCode, number> = {
    CONFIG_INVALID: 2,
    PAYLOAD_TOO_LARGE: 2,
    AUTH_UNAUTHORIZED: 3,
    AUTH_FORBIDDEN: 3,
    RUNNER_SANDBOX_FAILED: 3,
    WORKER_DEVICE_QUARANTINED: 3,
    ARTIFACT_INVALID: 4,
    ARTIFACT_MISSING: 4,
    NOT_FOUND: 4,
    QUEUE_CAPACITY_EXCEEDED: 5,
    QUEUE_LEASE_FENCED: 7,
    QUEUE_JOB_CONFLICT: 7,
    QUEUE_STATE_INVALID: 8,
  };
  for (const [code, exitCode] of Object.entries(expected) as [HardwareRunnerErrorCode, number][]) {
    assert.equal(hardwareRunnerExitCode(code), exitCode, `mismatch for ${code}`);
  }
});

test('runner-cli: invalid relay and worker configs exit cleanly with scrubbed diagnostics and zero secret leaks', async () => {
  const realTmp = await realpath(tmpdir());
  const root = await mkdtemp(join(realTmp, 'lw-runner-cli-badcfg-'));
  const secretSigning = 'SUPER_SECRET_SIGNING_VALUE_987654321';
  const secretAuth = 'SUPER_SECRET_CONTROLLER_AUTH_987654321';
  const secretWorker = 'SUPER_SECRET_WORKER_TOKEN_987654321';
  try {
    const missingPath = join(root, 'missing-relay.yaml');
    const missingRes = spawnSync(
      process.execPath,
      [MAIN, 'runner', 'relay', '--config', missingPath, '--json'],
      { encoding: 'utf8', timeout: 5_000, env: { PATH: '/usr/bin:/bin' } },
    );
    assert.equal(missingRes.status, 2);
    const missingEnv = JSON.parse(missingRes.stdout) as { kind: string; data: { code: string; message: string } };
    assert.equal(missingEnv.kind, 'diagnostic');
    assert.equal(missingEnv.data.code, 'CONFIG_INVALID');

    const badYamlPath = join(root, 'bad.yaml');
    await writeFile(badYamlPath, 'kind: [unclosed\n', { mode: 0o600 });
    const badYamlRes = spawnSync(
      process.execPath,
      [MAIN, 'runner', 'worker', '--config', badYamlPath, '--json'],
      { encoding: 'utf8', timeout: 5_000, env: { PATH: '/usr/bin:/bin' } },
    );
    assert.equal(badYamlRes.status, 2);
    assert.equal(JSON.parse(badYamlRes.stdout).data.code, 'CONFIG_INVALID');

    const realCfg = join(root, 'real-relay.yaml');
    await writeFile(realCfg, 'kind: relay\nport: 0\ncasDir: ./cas\n', { mode: 0o600 });
    const symlinkCfg = join(root, 'symlink-relay.yaml');
    await symlink(realCfg, symlinkCfg);
    const symlinkRes = spawnSync(
      process.execPath,
      [MAIN, 'runner', 'relay', '--config', symlinkCfg, '--json'],
      { encoding: 'utf8', timeout: 5_000, env: { PATH: '/usr/bin:/bin' } },
    );
    assert.equal(symlinkRes.status, 2);
    assert.equal(JSON.parse(symlinkRes.stdout).data.code, 'CONFIG_INVALID');

    const missingEnvCfg = join(root, 'missing-secret.yaml');
    await writeFile(
      missingEnvCfg,
      [
        'kind: relay',
        'port: 0',
        `casDir: ${join(root, 'cas')}`,
        'signingSecretEnv: env:TEST_SIGNING_SECRET',
        'controllerAuthTokenEnv: env:TEST_AUTH_TOKEN',
        'workerTokenEnv: env:MISSING_WORKER_TOKEN',
      ].join('\n'),
      { mode: 0o600 },
    );
    const missingSecretRes = spawnSync(
      process.execPath,
      [MAIN, 'runner', 'relay', '--config', missingEnvCfg, '--json'],
      {
        encoding: 'utf8',
        timeout: 5_000,
        env: {
          PATH: '/usr/bin:/bin',
          TEST_SIGNING_SECRET: secretSigning,
          TEST_AUTH_TOKEN: secretAuth,
        },
      },
    );
    assert.equal(missingSecretRes.status, 2);
    assert.equal(missingSecretRes.stdout.includes(secretSigning), false);
    assert.equal(missingSecretRes.stdout.includes(secretAuth), false);
    assert.equal(missingSecretRes.stderr.includes(secretSigning), false);

    // Physical probe with native_os sandbox fails closed with RUNNER_SANDBOX_FAILED (exit 3) and zero secret leaks
    const workDir = join(root, 'w-work');
    const workloadsDir = join(root, 'w-workloads');
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    await mkdir(workloadsDir, { recursive: true, mode: 0o700 });
    const physNativeCfg = join(root, 'worker-physical-native.yaml');
    await writeFile(
      physNativeCfg,
      [
        'kind: worker',
        'workerId: cli-worker-bad-sandbox',
        'relayUrl: http://127.0.0.1:65500',
        'workerTokenEnv: env:TEST_WORKER_TOKEN',
        `workDir: ${workDir}`,
        `heldOutWorkloadsDir: ${workloadsDir}`,
        'sandboxBackend: native_os',
        'probeMode: physical',
        'capabilities:',
        '  accelerator: sm_90a',
        '  isolationModes: [whole_device]',
        '  deviceCount: 1',
        '  driverVersion: "550.90.07"',
      ].join('\n'),
      { mode: 0o600 },
    );
    const sandboxRes = spawnSync(
      process.execPath,
      [MAIN, 'runner', 'worker', '--config', physNativeCfg, '--once', '--json'],
      {
        encoding: 'utf8',
        timeout: 5_000,
        env: {
          PATH: '/usr/bin:/bin',
          TEST_WORKER_TOKEN: secretWorker,
        },
      },
    );
    assert.equal(sandboxRes.status, 3, sandboxRes.stdout + sandboxRes.stderr);
    const sandboxDiag = JSON.parse(sandboxRes.stdout) as { kind: string; data: { code: string; message: string } };
    assert.equal(sandboxDiag.kind, 'diagnostic');
    assert.equal(sandboxDiag.data.code, 'RUNNER_SANDBOX_FAILED');
    assert.equal(sandboxRes.stdout.includes(secretWorker), false);
    assert.equal(sandboxRes.stderr.includes(secretWorker), false);

    // Unreachable relay with --once throws RunnerTransportError -> exit 8 with scrubbed diagnostic
    const unreachableCfg = join(root, 'worker-unreachable.yaml');
    await writeFile(
      unreachableCfg,
      [
        'kind: worker',
        'workerId: cli-worker-unreachable',
        'relayUrl: http://127.0.0.1:1',
        'workerTokenEnv: env:TEST_WORKER_TOKEN',
        `workDir: ${workDir}`,
        `heldOutWorkloadsDir: ${workloadsDir}`,
        'sandboxBackend: native_os',
        'probeMode: synthetic_fixture',
        'pollWaitMs: 0',
        'requestTimeoutMs: 500',
        'capabilities:',
        '  accelerator: sm_90a',
        '  isolationModes: [whole_device]',
        '  deviceCount: 1',
        '  driverVersion: "550.90.07"',
      ].join('\n'),
      { mode: 0o600 },
    );
    const transportRes = spawnSync(
      process.execPath,
      [MAIN, 'runner', 'worker', '--config', unreachableCfg, '--once', '--json'],
      {
        encoding: 'utf8',
        timeout: 5_000,
        env: {
          PATH: '/usr/bin:/bin',
          TEST_WORKER_TOKEN: secretWorker,
        },
      },
    );
    assert.equal(transportRes.status, 8, transportRes.stdout + transportRes.stderr);
    assert.equal(JSON.parse(transportRes.stdout).data.code, 'RUNNER_TRANSPORT_ERROR');
    assert.equal(transportRes.stdout.includes(secretWorker), false);

    // Relay port bind collision (EADDRINUSE) -> exit 8 RUNNER_UNAVAILABLE with zero secret leakage
    const blocker = createNetServer();
    await new Promise<void>(resolveListen => blocker.listen(0, '127.0.0.1', () => resolveListen()));
    const occupiedPort = (blocker.address() as { port: number }).port;
    try {
      const collideCfg = join(root, 'relay-collide.yaml');
      await writeFile(
        collideCfg,
        [
          'kind: relay',
          'host: 127.0.0.1',
          `port: ${occupiedPort}`,
          `casDir: ${join(root, 'cas-collide')}`,
          'signingSecretEnv: TEST_SIGNING_SECRET',
          'controllerAuthTokenEnv: TEST_AUTH_TOKEN',
          'workerTokenEnvs:',
          '  - TEST_WORKER_TOKEN',
        ].join('\n'),
        { mode: 0o600 },
      );
      const collideRes = spawnSync(
        process.execPath,
        [MAIN, 'runner', 'relay', '--config', collideCfg, '--json'],
        {
          encoding: 'utf8',
          timeout: 5_000,
          env: {
            PATH: '/usr/bin:/bin',
            TEST_SIGNING_SECRET: secretSigning,
            TEST_AUTH_TOKEN: secretAuth,
            TEST_WORKER_TOKEN: secretWorker,
          },
        },
      );
      assert.equal(collideRes.status, 8, collideRes.stdout + collideRes.stderr);
      assert.equal(JSON.parse(collideRes.stdout).data.code, 'RUNNER_UNAVAILABLE');
      assert.equal(collideRes.stdout.includes(secretSigning), false);
      assert.equal(collideRes.stdout.includes(secretWorker), false);
    } finally {
      await new Promise<void>(resolveClose => blocker.close(() => resolveClose()));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runner-cli: runner relay subprocess handles SIGTERM (143) and SIGINT (130) cleanly without leaking secrets', async () => {
  const realTmp = await realpath(tmpdir());
  const root = await mkdtemp(join(realTmp, 'lw-runner-cli-signals-'));
  const signingSecret = 'cli-relay-hmac-secret-0123456789abcdef';
  const authToken = 'cli-relay-auth-bearer-0123456789abcdef';
  const workerToken = 'cli-worker-bearer-tok-0123456789abcdef';
  try {
    const relayCfg = join(root, 'relay.yaml');
    await writeFile(
      relayCfg,
      [
        'kind: relay',
        'host: 127.0.0.1',
        'port: 0',
        `casDir: ${join(root, 'cas')}`,
        'signingSecretEnv: env:LW_RELAY_SIGNING',
        'controllerAuthTokenEnv: env:LW_RELAY_AUTH',
        'workerTokenEnv: env:LW_WORKER_TOKEN',
      ].join('\n'),
      { mode: 0o600 },
    );

    for (const [signal, expectedExit] of [['SIGTERM', 143], ['SIGINT', 130]] as const) {
      const child = spawn(process.execPath, [MAIN, 'runner', 'relay', '--config', relayCfg, '--json'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: '/usr/bin:/bin',
          LW_RELAY_SIGNING: signingSecret,
          LW_RELAY_AUTH: authToken,
          LW_WORKER_TOKEN: workerToken,
        },
      });
      try {
        let stderrText = '';
        child.stderr.on('data', (c: Buffer) => {
          stderrText += c.toString('utf8');
        });
        const { line } = await waitForLine(child.stdout);
        const envelope = JSON.parse(line) as {
          version: number;
          kind: string;
          runId: null;
          data: { role: string; host: string; port: number; url: string; relayBootId: string };
        };
        assert.equal(envelope.version, 1);
        assert.equal(envelope.kind, 'status');
        assert.equal(envelope.runId, null);
        assert.equal(envelope.data.role, 'relay');
        assert.equal(envelope.data.host, '127.0.0.1');
        assert.ok(envelope.data.port > 0);
        assert.match(envelope.data.url, /^http:\/\/127\.0\.0\.1:\d+$/);
        assert.ok(envelope.data.relayBootId.length > 0);
        assert.equal(line.includes(signingSecret), false);
        assert.equal(line.includes(authToken), false);
        assert.equal(line.includes(workerToken), false);

        child.kill(signal);
        const exitCode = await new Promise<number | null>(resolveCode => child.on('close', code => resolveCode(code)));
        assert.equal(exitCode, expectedExit, `expected ${expectedExit} on ${signal}, stderr=${stderrText}`);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await new Promise<void>(resolveClose => child.once('close', () => resolveClose()));
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runner-cli: subprocess worker --once runs idle, executes queued two-stage job, and handles SIGTERM preemption (143)', async () => {
  const realTmp = await realpath(tmpdir());
  const root = await mkdtemp(join(realTmp, 'lw-runner-cli-e2e-'));
  const signingSecret = 'cli-e2e-hmac-secret-0123456789abcdef';
  const authToken = 'cli-e2e-auth-bearer-0123456789abcdef';
  const workerToken = 'cli-e2e-worker-token-0123456789abcdef';
  const env = {
    PATH: '/usr/bin:/bin',
    LW_RELAY_SIGNING: signingSecret,
    LW_RELAY_AUTH: authToken,
    LW_WORKER_TOKEN: workerToken,
  };

  const relayCfg = join(root, 'relay.yaml');
  const workerWorkDir = join(root, 'worker-work');
  const workloadsDir = join(root, 'held_out_workloads');
  await mkdir(workerWorkDir, { recursive: true, mode: 0o700 });
  await mkdir(join(workloadsDir, 'gemm-fp16-4096'), { recursive: true, mode: 0o700 });
  await writeFile(
    join(workloadsDir, 'gemm-fp16-4096', 'evaluate.sh'),
    [
      `#!${process.execPath}`,
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const outDir = process.env.LOOPWRIGHT_STAGE_A_OUT;',
      'if (!fs.statSync(path.join(outDir, "cli_gemm.cubin")).isFile()) process.exit(2);',
      'process.stdout.write(\'{"status":"approved","detail":"cli two-stage verified","metrics":{"max_abs_err":0.0002,"tflops":320,"baseline_tflops":200}}\\n\');',
    ].join('\n'),
    { mode: 0o755 },
  );

  await writeFile(
    relayCfg,
    [
      'kind: relay',
      'host: 127.0.0.1',
      'port: 0',
      `casDir: ${join(root, 'relay-cas')}`,
      'signingSecretEnv: LW_RELAY_SIGNING',
      'controllerAuthTokenEnv: LW_RELAY_AUTH',
      'workerTokenEnv: LW_WORKER_TOKEN',
      'leaseTtlMs: 8000',
      'sweepIntervalMs: 100',
    ].join('\n'),
    { mode: 0o600 },
  );

  const relayProc = spawn(process.execPath, [MAIN, 'runner', 'relay', '--config', relayCfg, '--json'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });

  try {
    const { line: relayLine } = await waitForLine(relayProc.stdout);
    const relayStatus = JSON.parse(relayLine) as { data: { url: string; relayBootId: string } };
    const relayUrl = relayStatus.data.url;

    const workerCfg = join(root, 'worker.yaml');
    await writeFile(
      workerCfg,
      [
        'kind: worker',
        'workerId: cli-subprocess-worker-1',
        `relayUrl: ${relayUrl}`,
        'workerTokenEnv: LW_WORKER_TOKEN',
        `workDir: ${workerWorkDir}`,
        `heldOutWorkloadsDir: ${workloadsDir}`,
        'sandboxBackend: native_os',
        'probeMode: synthetic_fixture',
        'pollWaitMs: 0',
        'heartbeatIntervalMs: 100',
        'requestTimeoutMs: 5000',
        'stageATimeoutMs: 15000',
        'stageBTimeoutMs: 15000',
        'toolchainPaths:',
        `  - ${join(process.execPath, '..')}`,
        'capabilities:',
        '  accelerator: sm_90a',
        '  isolationModes: [whole_device]',
        '  deviceCount: 1',
        '  driverVersion: "550.90.07"',
        '  topology: nvlink-single',
        '  workloadIds: [gemm-fp16-4096]',
      ].join('\n'),
      { mode: 0o600 },
    );

    // 1. Idle 204 -> worker --once --json exits 0 with exitReason: 'once_idle'
    const idleRes = spawnSync(
      process.execPath,
      [MAIN, 'runner', 'worker', '--config', workerCfg, '--once', '--json'],
      { encoding: 'utf8', timeout: 10_000, env },
    );
    assert.equal(idleRes.status, 0, idleRes.stdout + idleRes.stderr);
    const idleEnv = JSON.parse(idleRes.stdout) as {
      kind: string;
      data: { role: string; workerId: string; exitReason: string; jobsProcessed: number; settlements: unknown[] };
    };
    assert.equal(idleEnv.kind, 'status');
    assert.equal(idleEnv.data.role, 'worker');
    assert.equal(idleEnv.data.workerId, 'cli-subprocess-worker-1');
    assert.equal(idleEnv.data.exitReason, 'once_idle');
    assert.equal(idleEnv.data.jobsProcessed, 0);
    assert.deepEqual(idleEnv.data.settlements, []);
    assert.equal(idleRes.stdout.includes(workerToken), false);

    // 2. Stage & submit a two-stage job on the CLI relay, then run worker --once --json
    const buildScript = Buffer.from(
      [
        `#!${process.execPath}`,
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'fs.writeFileSync(path.join(process.env.LOOPWRIGHT_STAGE_A_OUT, "cli_gemm.cubin"), "cli-cubin-ok\\n", "utf8");',
      ].join('\n'),
      'utf8',
    );
    const opId = 'verify.0.check.cli-gemm';
    const buildSha = sha256Hex(buildScript);
    const putSig = signRelayPayload(signingSecret, `PUT\n${opId}\n${buildSha}\n${buildScript.byteLength}`);
    const putRes = await fetch(`${relayUrl}/v1/benchmark/jobs/${opId}/blobs/${buildSha}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${authToken}`,
        'x-loopwright-signature': putSig,
        'x-loopwright-blob-sha256': buildSha,
        'x-loopwright-blob-length': String(buildScript.byteLength),
        'content-type': 'application/octet-stream',
      },
      body: new Uint8Array(buildScript),
    });
    assert.ok(putRes.status === 200 || putRes.status === 201, `blob PUT failed: ${putRes.status}`);

    const benchReq = makeRelayBenchmarkRequest(opId, buildScript);
    const reqBytes = Buffer.from(JSON.stringify(benchReq), 'utf8');
    const reqSig = signRelayPayload(signingSecret, reqBytes);
    const postPromise = fetch(`${relayUrl}/v1/benchmark/jobs`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${authToken}`,
        'x-loopwright-signature': reqSig,
        'content-type': 'application/json',
        'x-loopwright-wait-ms': '15000',
      },
      body: new Uint8Array(reqBytes),
    });

    const jobRes = await runCliAsync(
      ['runner', 'worker', '--config', workerCfg, '--once', '--json'],
      env,
    );
    assert.equal(jobRes.status, 0, jobRes.stdout + jobRes.stderr);
    const jobEnv = JSON.parse(jobRes.stdout) as {
      kind: string;
      data: {
        role: string;
        workerId: string;
        exitReason: string;
        jobsProcessed: number;
        lastSettlement: { outcome: string; acknowledgment: string; status: string };
        settlements: readonly { outcome: string }[];
      };
    };
    assert.equal(jobEnv.kind, 'status');
    assert.equal(jobEnv.data.role, 'worker');
    assert.equal(jobEnv.data.exitReason, 'once_completed');
    assert.equal(jobEnv.data.jobsProcessed, 1);
    assert.equal(jobEnv.data.lastSettlement.outcome, 'completed');
    assert.equal(jobEnv.data.lastSettlement.acknowledgment, 'confirmed');
    assert.equal(jobEnv.data.lastSettlement.status, 'approved');
    assert.equal(jobEnv.data.settlements.length, 1);
    assert.equal(jobRes.stdout.includes(workerToken), false);
    assert.equal(jobRes.stdout.includes(signingSecret), false);

    const postRes = await postPromise;
    assert.equal(postRes.status, 200);
    const verdict = (await postRes.json()) as { status: string; metrics: Record<string, number> };
    assert.equal(verdict.status, 'approved');
    assert.equal(verdict.metrics.tflops, 320);

    // 3. SIGTERM preemption on a running CLI worker subprocess -> exit 143
    const slowBuild = Buffer.from(
      [
        `#!${process.execPath}`,
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'fs.writeFileSync(path.join(process.env.LOOPWRIGHT_STAGE_A_OUT, "preempt-marker.txt"), "running\\n", "utf8");',
        'setTimeout(() => {}, 10000);',
      ].join('\n'),
      'utf8',
    );
    const preemptOpId = 'verify.0.check.cli-preempt';
    const slowSha = sha256Hex(slowBuild);
    const slowPutSig = signRelayPayload(signingSecret, `PUT\n${preemptOpId}\n${slowSha}\n${slowBuild.byteLength}`);
    const slowPutRes = await fetch(`${relayUrl}/v1/benchmark/jobs/${preemptOpId}/blobs/${slowSha}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${authToken}`,
        'x-loopwright-signature': slowPutSig,
        'x-loopwright-blob-sha256': slowSha,
        'x-loopwright-blob-length': String(slowBuild.byteLength),
        'content-type': 'application/octet-stream',
      },
      body: new Uint8Array(slowBuild),
    });
    assert.ok(slowPutRes.status === 200 || slowPutRes.status === 201);

    const preemptReq = makeRelayBenchmarkRequest(preemptOpId, slowBuild);
    const preemptBytes = Buffer.from(JSON.stringify(preemptReq), 'utf8');
    const preemptSig = signRelayPayload(signingSecret, preemptBytes);
    const preemptPostPromise = fetch(`${relayUrl}/v1/benchmark/jobs`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${authToken}`,
        'x-loopwright-signature': preemptSig,
        'content-type': 'application/json',
        'x-loopwright-wait-ms': '200',
      },
      body: new Uint8Array(preemptBytes),
    });
    const pendingPostRes = await preemptPostPromise;
    assert.equal(pendingPostRes.status, 200);

    const preemptChild = spawn(
      process.execPath,
      [MAIN, 'runner', 'worker', '--config', workerCfg, '--once', '--json'],
      { stdio: ['ignore', 'pipe', 'pipe'], env },
    );
    try {
      let preemptStdout = '';
      let preemptStderr = '';
      preemptChild.stdout.on('data', (c: Buffer) => {
        preemptStdout += c.toString('utf8');
      });
      preemptChild.stderr.on('data', (c: Buffer) => {
        preemptStderr += c.toString('utf8');
      });

      // Wait until Stage A starts running inside workerWorkDir, then send SIGTERM
      const deadline = Date.now() + 8_000;
      let started = false;
      while (Date.now() < deadline && !started) {
        const entries = await readdir(workerWorkDir).catch(() => []);
        for (const dir of entries) {
          const marker = await readFile(join(workerWorkDir, dir, 'stage-a', 'stage-a-out', 'preempt-marker.txt'), 'utf8').catch(() => null);
          if (marker !== null) {
            started = true;
            break;
          }
        }
        if (!started) await new Promise(r => setTimeout(r, 20));
      }
      assert.equal(started, true, `Stage A did not start in time; stderr=${preemptStderr}`);
      preemptChild.kill('SIGTERM');

      const preemptExit = await new Promise<number | null>(resolveCode => preemptChild.on('close', code => resolveCode(code)));
      assert.equal(preemptExit, 143, `expected 143, got ${preemptExit}; stdout=${preemptStdout}; stderr=${preemptStderr}`);
      const preemptEnv = JSON.parse(preemptStdout.trim()) as {
        kind: string;
        data: { exitReason: string; lastSettlement: { outcome: string; acknowledgment: string } };
      };
      assert.equal(preemptEnv.kind, 'status');
      assert.equal(preemptEnv.data.exitReason, 'preempted');
      assert.equal(preemptEnv.data.lastSettlement.outcome, 'preempted');
      assert.equal(preemptEnv.data.lastSettlement.acknowledgment, 'confirmed');
    } finally {
      if (preemptChild.exitCode === null && preemptChild.signalCode === null) {
        preemptChild.kill('SIGKILL');
        await new Promise<void>(resolveClose => preemptChild.once('close', () => resolveClose()));
      }
    }
  } finally {
    relayProc.kill('SIGTERM');
    await new Promise<void>(resolveClose => relayProc.on('close', () => resolveClose()));
    await rm(root, { recursive: true, force: true });
  }
});

test('runner-cli: in-process main handles SIGINT (130) on worker cleanly', async () => {
  const realTmp = await realpath(tmpdir());
  const root = await mkdtemp(join(realTmp, 'lw-runner-cli-sigint-'));
  const workDir = join(root, 'work');
  const workloadsDir = join(root, 'workloads');
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  await mkdir(workloadsDir, { recursive: true, mode: 0o700 });
  const prevTok = process.env['LW_INPROC_WORKER_TOK'];
  process.env['LW_INPROC_WORKER_TOK'] = 'inproc-worker-token-0123456789abcdef';
  const workerCfg = join(root, 'worker.yaml');
  await writeFile(
    workerCfg,
    [
      'kind: worker',
      'workerId: inproc-worker-1',
      'relayUrl: http://127.0.0.1:1',
      'workerTokenEnv: LW_INPROC_WORKER_TOK',
      `workDir: ${workDir}`,
      `heldOutWorkloadsDir: ${workloadsDir}`,
      'sandboxBackend: native_os',
      'probeMode: synthetic_fixture',
      'pollWaitMs: 5000',
      'capabilities:',
      '  accelerator: sm_90a',
      '  isolationModes: [whole_device]',
      '  deviceCount: 1',
      '  driverVersion: "550.90.07"',
    ].join('\n'),
    { mode: 0o600 },
  );

  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, encodingOrCb?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    if (callback) callback(null);
    return true;
  }) as typeof process.stdout.write;

  const sigintBefore = process.listenerCount('SIGINT');
  try {
    const runPromise = cliMain(['runner', 'worker', '--config', workerCfg, '--json']);
    const readyDeadline = Date.now() + 5_000;
    while (process.listenerCount('SIGINT') <= sigintBefore && Date.now() < readyDeadline) {
      await new Promise(r => setTimeout(r, 10));
    }
    assert.ok(
      process.listenerCount('SIGINT') > sigintBefore,
      'worker did not register SIGINT handler before deadline',
    );
    // Allow one ECONNREFUSED retry cycle into sleepAbortable before emitting SIGINT
    await new Promise(r => setTimeout(r, 50));
    process.emit('SIGINT');
    const code = await runPromise;
    assert.equal(code, 130);
    const env = JSON.parse(chunks.join('').trim()) as { kind: string; data: { exitReason: string } };
    assert.equal(env.kind, 'status');
    assert.equal(env.data.exitReason, 'aborted');

    // Also verify a standalone worker subprocess stays alive across retry backoff
    // (event loop does not drain prematurely) until SIGINT terminates it with exit 130.
    let retryPolls = 0;
    let resolveTwoPolls!: () => void;
    const twoPolls = new Promise<void>(resolveReady => {
      resolveTwoPolls = resolveReady;
    });
    const retryServer = createHttpServer(req => {
      retryPolls += 1;
      req.socket.destroy();
      if (retryPolls >= 2) resolveTwoPolls();
    });
    await new Promise<void>(resolveListen => retryServer.listen(0, '127.0.0.1', () => resolveListen()));
    const retryPort = (retryServer.address() as { port: number }).port;
    const retryWorkerCfg = join(root, 'worker-retry.yaml');
    await writeFile(
      retryWorkerCfg,
      [
        'kind: worker',
        'workerId: inproc-worker-retry',
        `relayUrl: http://127.0.0.1:${retryPort}`,
        'workerTokenEnv: LW_INPROC_WORKER_TOK',
        `workDir: ${workDir}`,
        `heldOutWorkloadsDir: ${workloadsDir}`,
        'sandboxBackend: native_os',
        'probeMode: synthetic_fixture',
        'pollWaitMs: 5000',
        'capabilities:',
        '  accelerator: sm_90a',
        '  isolationModes: [whole_device]',
        '  deviceCount: 1',
        '  driverVersion: "550.90.07"',
      ].join('\n'),
      { mode: 0o600 },
    );
    const daemon = spawn(
      process.execPath,
      [MAIN, 'runner', 'worker', '--config', retryWorkerCfg, '--json'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: '/usr/bin:/bin',
          LW_INPROC_WORKER_TOK: 'inproc-worker-token-0123456789abcdef',
        },
      },
    );
    try {
      let daemonOut = '';
      daemon.stdout.on('data', (c: Buffer) => { daemonOut += c.toString('utf8'); });
      await Promise.race([
        twoPolls,
        new Promise<never>((_res, rej) => {
          const t = setTimeout(() => rej(new Error(`worker did not retry after backoff (polls=${retryPolls}, exit=${daemon.exitCode})`)), 8_000);
          t.unref();
        }),
      ]);
      assert.equal(daemon.exitCode, null, `worker exited prematurely before SIGINT: ${daemonOut}`);
      daemon.kill('SIGINT');
      const daemonExit = await new Promise<number | null>(resolveCode => daemon.once('close', c => resolveCode(c)));
      assert.equal(daemonExit, 130, `expected 130 on SIGINT, got ${daemonExit}; stdout=${daemonOut}`);
    } finally {
      if (daemon.exitCode === null && daemon.signalCode === null) {
        daemon.kill('SIGKILL');
        await new Promise<void>(resolveClose => daemon.once('close', () => resolveClose()));
      }
      await new Promise<void>(resolveClose => retryServer.close(() => resolveClose()));
    }
  } finally {
    process.stdout.write = origWrite;
    if (prevTok === undefined) delete process.env['LW_INPROC_WORKER_TOK'];
    else process.env['LW_INPROC_WORKER_TOK'] = prevTok;
    await rm(root, { recursive: true, force: true });
  }
});

test('runner-cli: in-process main handles relay SIGINT (130), help, missing config (2), and fenced worker lease (7)', async () => {
  const realTmp = await realpath(tmpdir());
  const root = await mkdtemp(join(realTmp, 'lw-runner-cli-inproc-'));
  const workDir = join(root, 'work');
  const workloadsDir = join(root, 'workloads');
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  await mkdir(join(workloadsDir, 'wl-1'), { recursive: true, mode: 0o700 });
  await writeFile(
    join(workloadsDir, 'wl-1', 'evaluate.sh'),
    '#!/bin/sh\nprintf \'{"status":"approved","metrics":{"tflops":10}}\n\'\n',
    { mode: 0o755 },
  );

  const prevSign = process.env['LW_INPROC_SIGN'];
  const prevAuth = process.env['LW_INPROC_AUTH'];
  const prevTok = process.env['LW_INPROC_TOK'];
  process.env['LW_INPROC_SIGN'] = 'inproc-signing-secret-0123456789abcdef';
  process.env['LW_INPROC_AUTH'] = 'inproc-auth-bearer-0123456789abcdef';
  process.env['LW_INPROC_TOK'] = 'inproc-worker-token-0123456789abcdef';

  const chunks: string[] = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array, encodingOrCb?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    if (callback) callback(null);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((_chunk: string | Uint8Array, encodingOrCb?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void) => {
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    if (callback) callback(null);
    return true;
  }) as typeof process.stderr.write;

  // Mock relay that grants a lease and returns 409 QUEUE_LEASE_FENCED on :complete
  const fenceServer = createHttpServer((req, res) => {
    const chunksBody: Buffer[] = [];
    req.on('data', (c: Buffer) => chunksBody.push(c));
    req.on('end', () => {
      if (req.url === '/v1/runner/leases:acquire') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          relayBootId: 'boot-fence-1',
          jobId: 'job-fence-1',
          operationId: 'verify.0.check.fence',
          leaseEpoch: 1,
          leaseToken: 'lease-tok-fence-0123456789abcdef',
          leaseTtlMs: 10_000,
          job: {
            operationId: 'verify.0.check.fence',
            gateId: 'gate-1',
            checkId: 'check-1',
            candidateDigest: 'a'.repeat(64),
            subject: {
              lockHash: { algorithm: 'sha256', hex: 'b'.repeat(64) },
              contractHash: { algorithm: 'sha256', hex: 'c'.repeat(64) },
              repository: 'org/repo',
              baseRevision: '1'.repeat(40),
              sourceRevision: '2'.repeat(40),
              candidateDigest: { algorithm: 'sha256', hex: 'a'.repeat(64) },
              targetMatrixDigest: { algorithm: 'sha256', hex: 'd'.repeat(64) },
            },
            targetCellId: 'cell-1',
            targetHardware: { accelerator: 'sm_90a', isolationMode: 'whole_device', deviceCount: 1 },
            heldOutWorkloadId: 'wl-1',
            metricThresholds: [],
            maxPreemptions: 1,
            preemptionCount: 0,
            candidateArtifacts: { entries: [], deleted: [] },
          },
        }));
        return;
      }
      if (req.url?.endsWith(':heartbeat')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ desiredState: 'running', leaseTtlMs: 10_000 }));
        return;
      }
      if (req.url?.endsWith(':complete')) {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'QUEUE_LEASE_FENCED', message: 'fenced' }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'not found' }));
    });
  });

  try {
    assert.equal(await cliMain(['runner', '--help']), 0);
    assert.equal(await cliMain(['runner', 'relay', '--help']), 0);
    assert.equal(await cliMain(['runner', 'relay', '--config', join(root, 'missing.yaml'), '--json']), 2);

    const relayCfg = join(root, 'relay.yaml');
    await writeFile(
      relayCfg,
      [
        'kind: relay',
        'host: 127.0.0.1',
        'port: 0',
        `casDir: ${join(root, 'cas')}`,
        'signingSecretEnv: env:LW_INPROC_SIGN',
        'controllerAuthTokenEnv: env:LW_INPROC_AUTH',
        'workerTokenEnv: env:LW_INPROC_TOK',
      ].join('\n'),
      { mode: 0o600 },
    );
    chunks.length = 0;
    const relayPromise = cliMain(['runner', 'relay', '--config', relayCfg, '--json']);
    while (chunks.length === 0) await new Promise(r => setTimeout(r, 10));
    process.emit('SIGINT');
    assert.equal(await relayPromise, 130);

    await new Promise<void>(resolveListen => fenceServer.listen(0, '127.0.0.1', () => resolveListen()));
    const fencePort = (fenceServer.address() as { port: number }).port;
    const workerCfg = join(root, 'worker-fence.yaml');
    await writeFile(
      workerCfg,
      [
        'kind: worker',
        'workerId: inproc-fence-worker',
        `relayUrl: http://127.0.0.1:${fencePort}`,
        'workerTokenEnv: LW_INPROC_TOK',
        `workDir: ${workDir}`,
        `heldOutWorkloadsDir: ${workloadsDir}`,
        'sandboxBackend: native_os',
        'probeMode: synthetic_fixture',
        'pollWaitMs: 0',
        'heartbeatIntervalMs: 100',
        'requestTimeoutMs: 5000',
        'stageATimeoutMs: 15000',
        'stageBTimeoutMs: 15000',
        'toolchainPaths:',
        `  - ${join(process.execPath, '..')}`,
        'capabilities:',
        '  accelerator: sm_90a',
        '  isolationModes: [whole_device]',
        '  deviceCount: 1',
        '  driverVersion: "550.90.07"',
        '  workloadIds: [wl-1]',
      ].join('\n'),
      { mode: 0o600 },
    );

    chunks.length = 0;
    const fenceExit = await cliMain(['runner', 'worker', '--config', workerCfg, '--once', '--json']);
    assert.equal(fenceExit, 7, `expected 7, got ${fenceExit}: ${chunks.join('')}`);
    const fenceEnv = JSON.parse(chunks.join('').trim()) as {
      kind: string;
      data: { lastSettlement: { outcome: string; acknowledgment: string } };
    };
    assert.equal(fenceEnv.kind, 'status');
    assert.equal(fenceEnv.data.lastSettlement.outcome, 'fenced');
    assert.equal(fenceEnv.data.lastSettlement.acknowledgment, 'fenced');
  } finally {
    await new Promise<void>(resolveClose => fenceServer.close(() => resolveClose()));
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    if (prevSign === undefined) delete process.env['LW_INPROC_SIGN'];
    else process.env['LW_INPROC_SIGN'] = prevSign;
    if (prevAuth === undefined) delete process.env['LW_INPROC_AUTH'];
    else process.env['LW_INPROC_AUTH'] = prevAuth;
    if (prevTok === undefined) delete process.env['LW_INPROC_TOK'];
    else process.env['LW_INPROC_TOK'] = prevTok;
    await rm(root, { recursive: true, force: true });
  }
});

test('runner-cli: rejects symlinked config ancestor, preserves unknown (8) and fenced (7) preempt outcomes, teardown failure (8), and human-mode output', async () => {
  const realTmp = await realpath(tmpdir());
  const root = await mkdtemp(join(realTmp, 'lw-runner-cli-neg-'));
  const workDir = join(root, 'work');
  const workloadsDir = join(root, 'workloads');
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  await mkdir(join(workloadsDir, 'wl-neg'), { recursive: true, mode: 0o700 });
  await writeFile(
    join(workloadsDir, 'wl-neg', 'evaluate.sh'),
    '#!/bin/sh\nprintf \'{"status":"approved","metrics":{"tflops":10}}\n\'\n',
    { mode: 0o755 },
  );

  const workerToken = 'neg-worker-token-0123456789abcdef';
  const prevTok = process.env['LW_NEG_TOK'];
  const prevJsonSecret = process.env['LW_JSON_SIGN_SECRET'];
  process.env['LW_NEG_TOK'] = workerToken;
  process.env['LW_JSON_SIGN_SECRET'] = 'json-quoted-secret-value-0123456789';

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array, encodingOrCb?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    if (callback) callback(null);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, encodingOrCb?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    if (callback) callback(null);
    return true;
  }) as typeof process.stderr.write;

  let preemptMode: 'unknown_500' | 'fenced_409' = 'unknown_500';
  const slowScriptBytes = Buffer.from(
    [
      `#!${process.execPath}`,
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'fs.writeFileSync(path.join(process.env.LOOPWRIGHT_STAGE_A_OUT, "started.txt"), "1");',
      'setTimeout(() => {}, 30000);',
    ].join('\n'),
    'utf8',
  );
  const slowScriptSha = sha256Hex(slowScriptBytes);
  let currentJobCounter = 0;

  const mockRelay = createHttpServer((req, res) => {
    const bodyChunks: Buffer[] = [];
    req.on('data', (c: Buffer) => bodyChunks.push(c));
    req.on('end', () => {
      if (req.url === '/v1/runner/leases:acquire') {
        currentJobCounter += 1;
        const jobId = `job-neg-${currentJobCounter}`;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          relayBootId: 'boot-neg-1',
          jobId,
          operationId: `verify.0.check.neg${currentJobCounter}`,
          leaseEpoch: 1,
          leaseToken: `lease-tok-neg-${currentJobCounter}-0123456789`,
          leaseTtlMs: 10_000,
          job: {
            operationId: `verify.0.check.neg${currentJobCounter}`,
            gateId: 'gate-1',
            checkId: 'check-1',
            candidateDigest: 'a'.repeat(64),
            subject: {
              lockHash: { algorithm: 'sha256', hex: 'b'.repeat(64) },
              contractHash: { algorithm: 'sha256', hex: 'c'.repeat(64) },
              repository: 'org/repo',
              baseRevision: '1'.repeat(40),
              sourceRevision: '2'.repeat(40),
              candidateDigest: { algorithm: 'sha256', hex: 'a'.repeat(64) },
              targetMatrixDigest: { algorithm: 'sha256', hex: 'd'.repeat(64) },
            },
            targetCellId: 'cell-1',
            targetHardware: { accelerator: 'sm_90a', isolationMode: 'whole_device', deviceCount: 1 },
            heldOutWorkloadId: 'wl-neg',
            metricThresholds: [],
            maxPreemptions: 2,
            preemptionCount: 0,
            candidateArtifacts: {
              entries: [
                {
                  name: 'packages/build.sh',
                  digest: { algorithm: 'sha256', hex: slowScriptSha },
                  byteLength: slowScriptBytes.byteLength,
                  mode: '100755',
                },
              ],
              deleted: [],
            },
          },
        }));
        return;
      }
      if (req.url?.endsWith(`/blobs/${slowScriptSha}`)) {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'x-loopwright-blob-sha256': slowScriptSha,
          'x-loopwright-blob-length': String(slowScriptBytes.byteLength),
        });
        res.end(slowScriptBytes);
        return;
      }
      if (req.url?.endsWith(':heartbeat')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ desiredState: 'running', leaseTtlMs: 10_000 }));
        return;
      }
      if (req.url?.endsWith(':preempt')) {
        if (preemptMode === 'unknown_500') {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 'INTERNAL', message: 'simulated 500 during preempt' }));
        } else {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 'QUEUE_LEASE_FENCED', message: 'stale lease epoch on preempt' }));
        }
        return;
      }
      res.writeHead(204);
      res.end();
    });
  });

  try {
    // 1. Symlinked ancestor directory on --config fails with exit 2 (CONFIG_INVALID) without traversing ancestor
    const realCfgDir = join(root, 'real-cfg-dir');
    const linkCfgDir = join(root, 'link-cfg-dir');
    await mkdir(realCfgDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(realCfgDir, 'relay.json'),
      JSON.stringify({
        kind: 'relay',
        host: '127.0.0.1',
        port: 0,
        casDir: join(root, 'cas'),
        signingSecretEnv: 'LW_JSON_SIGN_SECRET',
        workerTokenEnvs: ['LW_NEG_TOK'],
      }),
      { mode: 0o600 },
    );
    await symlink(realCfgDir, linkCfgDir);
    stdoutChunks.length = 0;
    stderrChunks.length = 0;
    const symAncExit = await cliMain(['runner', 'relay', '--config', join(linkCfgDir, 'relay.json')]);
    assert.equal(symAncExit, 2);
    assert.match(stderrChunks.join(''), /CONFIG_INVALID/);
    assert.equal(stderrChunks.join('').includes('json-quoted-secret-value-0123456789'), false);
    assert.equal(stdoutChunks.join(''), '');

    // 2. Non-JSON human-mode output on relay startup + SIGINT
    const validRelayCfg = join(realCfgDir, 'relay-human.yaml');
    await writeFile(
      validRelayCfg,
      [
        'kind: relay',
        'host: 127.0.0.1',
        'port: 0',
        `casDir: ${join(root, 'cas-human')}`,
        'signingSecretEnv: LW_JSON_SIGN_SECRET',
        'workerTokenEnvs:',
        '  - LW_NEG_TOK',
      ].join('\n'),
      { mode: 0o600 },
    );
    stdoutChunks.length = 0;
    stderrChunks.length = 0;
    const humanRelayPromise = cliMain(['runner', 'relay', '--config', validRelayCfg]);
    while (stdoutChunks.length === 0) await new Promise(r => setTimeout(r, 10));
    process.emit('SIGINT');
    assert.equal(await humanRelayPromise, 130);
    assert.match(stdoutChunks.join(''), /listening: http:\/\/127\.0\.0\.1:\d+/);

    await new Promise<void>(resolveListen => mockRelay.listen(0, '127.0.0.1', () => resolveListen()));
    const mockPort = (mockRelay.address() as { port: number }).port;
    const workerCfg = join(root, 'worker-neg.yaml');
    await writeFile(
      workerCfg,
      [
        'kind: worker',
        'workerId: inproc-neg-worker',
        `relayUrl: http://127.0.0.1:${mockPort}`,
        'workerTokenEnv: LW_NEG_TOK',
        `workDir: ${workDir}`,
        `heldOutWorkloadsDir: ${workloadsDir}`,
        'sandboxBackend: native_os',
        'probeMode: synthetic_fixture',
        'pollWaitMs: 0',
        'heartbeatIntervalMs: 100',
        'requestTimeoutMs: 5000',
        'stageATimeoutMs: 15000',
        'stageBTimeoutMs: 15000',
        'toolchainPaths:',
        `  - ${join(process.execPath, '..')}`,
        'capabilities:',
        '  accelerator: sm_90a',
        '  isolationModes: [whole_device]',
        '  deviceCount: 1',
        '  driverVersion: "550.90.07"',
        '  workloadIds: [wl-neg]',
      ].join('\n'),
      { mode: 0o600 },
    );

    const runPreemptScenario = async (mode: 'unknown_500' | 'fenced_409'): Promise<{ code: number; out: string }> => {
      preemptMode = mode;
      stdoutChunks.length = 0;
      stderrChunks.length = 0;
      const runPromise = cliMain(['runner', 'worker', '--config', workerCfg, '--once', '--json']);
      const waitDeadline = Date.now() + 8_000;
      let started = false;
      while (Date.now() < waitDeadline && !started) {
        const dirs = await readdir(workDir).catch(() => []);
        for (const d of dirs) {
          const marker = await readFile(join(workDir, d, 'stage-a', 'stage-a-out', 'started.txt'), 'utf8').catch(() => null);
          if (marker !== null) {
            started = true;
            break;
          }
        }
        if (!started) await new Promise(r => setTimeout(r, 20));
      }
      assert.equal(started, true, `Stage A did not start for ${mode}`);
      process.emit('SIGTERM');
      const code = await runPromise;
      return { code, out: stdoutChunks.join('').trim() };
    };

    // 3. Unknown :preempt settlement (HTTP 500) preserves exit 8 (uncertainty > SIGTERM 143)
    const unknownRes = await runPreemptScenario('unknown_500');
    assert.equal(unknownRes.code, 8, `expected 8 on unknown preempt, got ${unknownRes.code}: ${unknownRes.out}`);
    const unknownEnv = JSON.parse(unknownRes.out) as { data: { exitReason: string; lastSettlement: { outcome: string; acknowledgment: string } } };
    assert.equal(unknownEnv.data.exitReason, 'preempted');
    assert.equal(unknownEnv.data.lastSettlement.outcome, 'unknown');
    assert.equal(unknownEnv.data.lastSettlement.acknowledgment, 'unknown');

    // 4. Fenced :preempt settlement (HTTP 409 QUEUE_LEASE_FENCED) preserves exit 7 (fenced > SIGTERM 143)
    const fencedRes = await runPreemptScenario('fenced_409');
    assert.equal(fencedRes.code, 7, `expected 7 on fenced preempt, got ${fencedRes.code}: ${fencedRes.out}`);
    const fencedEnv = JSON.parse(fencedRes.out) as { data: { exitReason: string; lastSettlement: { outcome: string; acknowledgment: string } } };
    assert.equal(fencedEnv.data.exitReason, 'preempted');
    assert.equal(fencedEnv.data.lastSettlement.outcome, 'fenced');
    assert.equal(fencedEnv.data.lastSettlement.acknowledgment, 'fenced');

    // 4b. Fenced settlement followed by SIGINT preserves exit 7 (fenced > SIGINT 130)
    preemptMode = 'fenced_409';
    stdoutChunks.length = 0;
    stderrChunks.length = 0;
    const fencedSigintPromise = cliMain(['runner', 'worker', '--config', workerCfg, '--once', '--json']);
    const fsDeadline = Date.now() + 8_000;
    let fsStarted = false;
    while (Date.now() < fsDeadline && !fsStarted) {
      const dirs = await readdir(workDir).catch(() => []);
      for (const d of dirs) {
        const marker = await readFile(join(workDir, d, 'stage-a', 'stage-a-out', 'started.txt'), 'utf8').catch(() => null);
        if (marker !== null) {
          fsStarted = true;
          break;
        }
      }
      if (!fsStarted) await new Promise(r => setTimeout(r, 20));
    }
    assert.equal(fsStarted, true, 'Stage A did not start for fenced+SIGINT test');
    process.emit('SIGTERM');
    process.emit('SIGINT');
    const fencedSigintExit = await fencedSigintPromise;
    assert.equal(fencedSigintExit, 7, `expected 7 on fenced + SIGINT, got ${fencedSigintExit}`);

    // 5. RunnerTeardownError (locked workDir preventing jobRoot removal on SIGTERM) returns exit 8
    stdoutChunks.length = 0;
    stderrChunks.length = 0;
    const tdPromise = cliMain(['runner', 'worker', '--config', workerCfg, '--once', '--json']);
    const tdDeadline = Date.now() + 8_000;
    let tdStarted = false;
    while (Date.now() < tdDeadline && !tdStarted) {
      const dirs = await readdir(workDir).catch(() => []);
      for (const d of dirs) {
        const marker = await readFile(join(workDir, d, 'stage-a', 'stage-a-out', 'started.txt'), 'utf8').catch(() => null);
        if (marker !== null) {
          tdStarted = true;
          break;
        }
      }
      if (!tdStarted) await new Promise(r => setTimeout(r, 20));
    }
    assert.equal(tdStarted, true, 'Stage A did not start for teardown test');
    await chmod(workDir, 0o500);
    try {
      process.emit('SIGTERM');
      const tdExit = await tdPromise;
      assert.equal(tdExit, 8, `expected 8 on teardown error, got ${tdExit}: ${stdoutChunks.join('')}`);
      const tdEnv = JSON.parse(stdoutChunks.join('').trim()) as { kind: string; data: { code: string } };
      assert.equal(tdEnv.kind, 'diagnostic');
      assert.equal(tdEnv.data.code, 'RUNNER_TEARDOWN_FAILED');
    } finally {
      await chmod(workDir, 0o700).catch(() => {});
    }
  } finally {
    await chmod(workDir, 0o700).catch(() => {});
    await new Promise<void>(resolveClose => mockRelay.close(() => resolveClose()));
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    if (prevTok === undefined) delete process.env['LW_NEG_TOK'];
    else process.env['LW_NEG_TOK'] = prevTok;
    if (prevJsonSecret === undefined) delete process.env['LW_JSON_SIGN_SECRET'];
    else process.env['LW_JSON_SIGN_SECRET'] = prevJsonSecret;
    await rm(root, { recursive: true, force: true });
  }
});
