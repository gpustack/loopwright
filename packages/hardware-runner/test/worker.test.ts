import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  canonicalJson,
  HardwareRunnerError,
  isRunnerTeardownError,
  isRunnerTransportError,
  MAX_LEASE_TTL_MS,
  runHardwareWorker,
  RunnerTeardownError,
  RunnerTransportError,
  signRelayPayload,
  startRelayServer,
  type BenchmarkRequest,
  type BenchmarkVerdict,
  type RelayServerHandle,
  type WorkerConfig,
  type WorkerJobSettlementSummary,
} from '../src/index.js';

const CONTROLLER_SECRET = 'worker-suite-controller-hmac-0123456789abcdef';
const WORKER_TOKEN = 'worker-suite-bearer-token-0123456789abcdef';

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function makeWorkerConfig(
  relayUrl: string,
  workDir: string,
  heldOutWorkloadsDir: string,
  overrides: Partial<WorkerConfig> = {},
): WorkerConfig {
  return {
    workerId: 'worker-node-01',
    relayUrl,
    workerToken: WORKER_TOKEN,
    workDir,
    heldOutWorkloadsDir,
    sandboxBackend: 'native_os',
    capabilities: {
      accelerator: 'sm_90a',
      isolationModes: ['whole_device'],
      deviceCount: 1,
      driverVersion: '550.90.07',
      workloadIds: ['gemm-4096'],
    },
    pollWaitMs: 60,
    heartbeatIntervalMs: 50,
    requestTimeoutMs: 5_000,
    stageATimeoutMs: 15_000,
    stageBTimeoutMs: 15_000,
    toolchainPaths: [join(process.execPath, '..')],
    probeMode: 'synthetic_fixture',
    ...overrides,
  };
}

function sendCaScopedHttpsRequest(options: {
  readonly url: string;
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Buffer;
  readonly caPem: Buffer;
}): Promise<{ readonly status: number; readonly bytes: Buffer }> {
  const parsed = new URL(options.url);
  return new Promise((resolveReq, rejectReq) => {
    const req = httpsRequest(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method,
        headers: options.headers,
        ca: options.caPem,
        rejectUnauthorized: true,
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer | Uint8Array) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('error', rejectReq);
        res.on('end', () => resolveReq({ status: res.statusCode ?? 0, bytes: Buffer.concat(chunks) }));
      },
    );
    req.on('error', rejectReq);
    if (options.body !== undefined) req.end(options.body);
    else req.end();
  });
}

async function stageInputAndSubmitJob(
  relay: RelayServerHandle,
  operationId: string,
  files: readonly { readonly name: string; readonly bytes: Buffer; readonly mode?: '100644' | '100755' }[],
  maxPreemptions = 3,
  tlsCaPem?: Buffer,
): Promise<BenchmarkRequest> {
  const entries = [];
  for (const file of files) {
    const sha = sha256Hex(file.bytes);
    const sig = signRelayPayload(CONTROLLER_SECRET, `PUT\n${operationId}\n${sha}\n${file.bytes.byteLength}`);
    const url = `${relay.url}/v1/benchmark/jobs/${operationId}/blobs/${sha}`;
    const headers = {
      'content-type': 'application/octet-stream',
      'content-length': String(file.bytes.byteLength),
      'x-loopwright-blob-sha256': sha,
      'x-loopwright-blob-length': String(file.bytes.byteLength),
      'x-loopwright-signature': sig,
    };
    if (tlsCaPem !== undefined) {
      const putRes = await sendCaScopedHttpsRequest({ url, method: 'PUT', headers, body: file.bytes, caPem: tlsCaPem });
      assert.equal(putRes.status === 200 || putRes.status === 201, true);
    } else {
      const putRes = await fetch(url, { method: 'PUT', headers, body: new Uint8Array(file.bytes) });
      assert.equal(putRes.status === 200 || putRes.status === 201, true);
    }
    entries.push({
      name: file.name,
      digest: { algorithm: 'sha256' as const, hex: sha },
      byteLength: file.bytes.byteLength,
      ...(file.mode !== undefined ? { mode: file.mode } : {}),
    });
  }

  const lockHex = sha256Hex(`lock:${operationId}`);
  const candHex = sha256Hex(`cand:${operationId}`);
  const req: BenchmarkRequest = {
    version: 1,
    kind: 'benchmark_request',
    storeId: 'store-worker-test',
    runId: 'run-worker-test',
    lockHash: { algorithm: 'sha256', hex: lockHex },
    operationId,
    dispatchId: `disp-${operationId}`,
    dispatchGeneration: 1,
    requestDigest: sha256Hex(`req:${operationId}`),
    gateId: 'sm90-gate',
    checkId: 'kernel-bench',
    candidateDigest: candHex,
    subject: {
      lockHash: { algorithm: 'sha256', hex: lockHex },
      contractHash: { algorithm: 'sha256', hex: lockHex },
      repository: 'org/kernels',
      baseRevision: '1'.repeat(40),
      sourceRevision: '1'.repeat(40),
      candidateDigest: { algorithm: 'sha256', hex: candHex },
      targetMatrixDigest: { algorithm: 'sha256', hex: lockHex },
    },
    targetCellId: 'cuda-sm90',
    targetHardware: {
      accelerator: 'sm_90a',
      isolationMode: 'whole_device',
      deviceCount: 1,
      driverConstraint: '>=550.54',
    },
    heldOutWorkloadId: 'gemm-4096',
    metricThresholds: [{ kind: 'bounds', metric: 'speedup', min: 1.1 }],
    maxPreemptions,
    candidateArtifacts: {
      entries,
      deleted: [],
    },
  };

  const body = Buffer.from(canonicalJson(req), 'utf8');
  const postHeaders = {
    'content-type': 'application/json',
    'content-length': String(body.byteLength),
    'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, body),
  };
  if (tlsCaPem !== undefined) {
    const postRes = await sendCaScopedHttpsRequest({
      url: `${relay.url}/v1/benchmark/jobs`,
      method: 'POST',
      headers: postHeaders,
      body,
      caPem: tlsCaPem,
    });
    assert.equal(postRes.status, 200);
  } else {
    const postRes = await fetch(`${relay.url}/v1/benchmark/jobs`, {
      method: 'POST',
      headers: postHeaders,
      body: new Uint8Array(body),
    });
    assert.equal(postRes.status, 200);
  }
  return req;
}

async function pollRelayVerdict(relay: RelayServerHandle, req: BenchmarkRequest): Promise<BenchmarkVerdict> {
  const body = Buffer.from(canonicalJson(req), 'utf8');
  const res = await fetch(`${relay.url}/v1/benchmark/jobs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, body),
    },
    body: new Uint8Array(body),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as BenchmarkVerdict;
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

function generateSelfSignedCert(certPath: string, keyPath: string, sanExtension: string): void {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=loopwright-relay-test',
      '-addext',
      `subjectAltName=${sanExtension}`,
    ],
    { stdio: 'ignore', timeout: 10_000 },
  );
}

test('HTTPS tlsCaPath enforces rejectUnauthorized=true without ambient TLS override, rejects unrelated CA and wrong SAN, and renews heartbeats past leaseTtlMs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lw-worker-tls-'));
  const casDir = join(root, 'cas');
  const workDir = join(root, 'work');
  const workloadsDir = join(root, 'workloads');
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  await mkdir(join(workloadsDir, 'gemm-4096'), { recursive: true, mode: 0o700 });

  const certPath = join(root, 'relay-cert.pem');
  const keyPath = join(root, 'relay-key.pem');
  const unrelatedCertPath = join(root, 'unrelated-ca.pem');
  const unrelatedKeyPath = join(root, 'unrelated-key.pem');
  const wrongSanCertPath = join(root, 'wrong-san-cert.pem');
  const wrongSanKeyPath = join(root, 'wrong-san-key.pem');

  generateSelfSignedCert(certPath, keyPath, 'IP:127.0.0.1,DNS:localhost');
  generateSelfSignedCert(unrelatedCertPath, unrelatedKeyPath, 'IP:127.0.0.1,DNS:localhost');
  generateSelfSignedCert(wrongSanCertPath, wrongSanKeyPath, 'DNS:wrong-san.example.invalid');

  const relayCaPem = await readFile(certPath);

  await writeFile(
    join(workloadsDir, 'gemm-4096', 'evaluate.sh'),
    [
      `#!${process.execPath}`,
      'const fs = require("node:fs"), path = require("node:path");',
      'setTimeout(() => {',
      '  if (!fs.statSync(path.join(process.env.LOOPWRIGHT_STAGE_A_OUT, "big.cubin")).isFile()) process.exit(2);',
      '  process.stdout.write(\'{"status":"approved","metrics":{"speedup":1.75}}\\n\');',
      '}, 350);',
    ].join('\n'),
    { mode: 0o755 },
  );

  const relay = await startRelayServer({
    host: '127.0.0.1',
    port: 0,
    casDir,
    controllerSigningSecret: CONTROLLER_SECRET,
    workerTokens: [WORKER_TOKEN],
    leaseTtlMs: 240,
    sweepIntervalMs: 40,
    tls: { certPath, keyPath },
  });

  const wrongSanRelay = await startRelayServer({
    host: '127.0.0.1',
    port: 0,
    casDir: join(root, 'cas-wrong-san'),
    controllerSigningSecret: CONTROLLER_SECRET,
    workerTokens: [WORKER_TOKEN],
    tls: { certPath: wrongSanCertPath, keyPath: wrongSanKeyPath },
  });

  try {
    // 1. Rejects unrelated CA certificate
    await assert.rejects(
      () =>
        runHardwareWorker({
          config: makeWorkerConfig(relay.url, workDir, workloadsDir, { tlsCaPath: unrelatedCertPath }),
          once: true,
          registerProcessSignalHandlers: false,
        }),
    );

    // 2. Rejects certificate signed by trusted CA when SAN does not match 127.0.0.1
    await assert.rejects(
      () =>
        runHardwareWorker({
          config: makeWorkerConfig(wrongSanRelay.url, workDir, workloadsDir, { tlsCaPath: wrongSanCertPath }),
          once: true,
          registerProcessSignalHandlers: false,
        }),
    );

    const config = makeWorkerConfig(relay.url, workDir, workloadsDir, {
      tlsCaPath: certPath,
      heartbeatIntervalMs: 50,
    });

    // 3. Idle --once returns once_idle on 204
    const idleResult = await runHardwareWorker({
      config,
      once: true,
      registerProcessSignalHandlers: false,
    });
    assert.equal(idleResult.exitReason, 'once_idle');
    assert.equal(idleResult.jobsProcessed, 0);

    // 4. Submit job using CA-scoped HTTPS client (explicit CA trust, no global TLS override)
    const buildScript = Buffer.from(
      [
        `#!${process.execPath}`,
        'const fs = require("node:fs"), path = require("node:path");',
        'fs.writeFileSync(path.join(process.env.LOOPWRIGHT_STAGE_A_OUT, "big.cubin"), Buffer.alloc(1200 * 1024, 0));',
      ].join('\n'),
      'utf8',
    );
    const req = await stageInputAndSubmitJob(
      relay,
      'verify.0.check.https-job',
      [{ name: 'scripts/build.sh', bytes: buildScript, mode: '100755' }],
      3,
      relayCaPem,
    );

    const jobResult = await runHardwareWorker({
      config,
      once: true,
      registerProcessSignalHandlers: false,
    });
    assert.equal(jobResult.exitReason, 'once_completed');
    assert.equal(jobResult.jobsProcessed, 1);
    assert.equal(jobResult.lastSettlement?.outcome, 'completed');
    assert.equal(jobResult.lastSettlement?.acknowledgment, 'confirmed');
    assert.equal(jobResult.lastSettlement?.status, 'approved');

    const receiptRaw = JSON.parse(await readFile(join(casDir, 'receipts', `${req.operationId}.json`), 'utf8')) as BenchmarkVerdict;
    assert.equal(receiptRaw.status, 'approved');
    assert.equal(receiptRaw.outputArtifacts?.[0]?.byteLength, 1_200 * 1_024);
    const storedBlobStat = await lstat(join(casDir, 'blobs', 'sha256', receiptRaw.outputArtifacts![0]!.digest.hex));
    assert.equal(storedBlobStat.mode & 0o7777, 0o400);
  } finally {
    await wrongSanRelay.close();
    await relay.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('real child-process worker receiving OS SIGTERM kills default evaluator stage + grandchild before releasing lease, and 4th preemption settles BENCHMARK_PREEMPTED', async () => {
  const realTmp = await mkdtemp(join(tmpdir(), 'lw-worker-sigterm-'));
  const casDir = join(realTmp, 'cas');
  const workDir = join(realTmp, 'work');
  const workloadsDir = join(realTmp, 'workloads');
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  await mkdir(join(workloadsDir, 'gemm-4096'), { recursive: true, mode: 0o700 });
  await writeFile(
    join(workloadsDir, 'gemm-4096', 'evaluate.sh'),
    '#!/bin/sh\nprintf \'{"status":"approved","metrics":{"speedup":1.5}}\\n\'\n',
    { mode: 0o755 },
  );

  const relay = await startRelayServer({
    port: 0,
    casDir,
    controllerSigningSecret: CONTROLLER_SECRET,
    workerTokens: [WORKER_TOKEN],
    leaseTtlMs: 10_000,
    sweepIntervalMs: 200,
  });

  try {
    // Stage A runs as a single-process Node script under OS sandbox (Seatbelt deny process-fork on macOS)
    // and sleeps until preempted by real OS SIGTERM!
    const fastGateFlag = join(realTmp, 'allow-fast-compile.flag');
    const stageAScript = [
      `#!${process.execPath}`,
      'const cp = require("node:child_process"), fs = require("node:fs"), path = require("node:path");',
      'if (process.platform === "darwin") {',
      '  const forkRes = cp.spawnSync("/bin/echo", ["hi"]);',
      '  if (!forkRes.error || forkRes.error.code !== "EPERM") process.exit(55);',
      '}',
      'const outDir = process.env.LOOPWRIGHT_STAGE_A_OUT;',
      'fs.writeFileSync(path.join(outDir, "k.cubin"), "cubin", "utf8");',
      'fs.writeFileSync(path.join(outDir, "pids.txt"), String(process.pid) + "\\n", "utf8");',
      'setTimeout(() => {}, 30_000);',
    ].join('\n');
    const req1 = await stageInputAndSubmitJob(
      relay,
      'verify.0.check.real-sigterm',
      [{ name: 'scripts/build.sh', bytes: Buffer.from(stageAScript, 'utf8'), mode: '100755' }],
      3,
    );

    const workerIndexUrl = pathToFileURL(resolve(process.cwd(), '.test-build/packages/hardware-runner/src/index.js')).href;
    const workerEntryScript = join(realTmp, 'run-real-worker.mjs');
    const workerCfg = makeWorkerConfig(relay.url, workDir, workloadsDir);
    await writeFile(
      workerEntryScript,
      [
        `import { runHardwareWorker } from ${JSON.stringify(workerIndexUrl)};`,
        `const res = await runHardwareWorker({ config: ${JSON.stringify(workerCfg)}, once: true, registerProcessSignalHandlers: true });`,
        'process.stdout.write("WORKER_RESULT:" + JSON.stringify(res) + "\\n");',
      ].join('\n'),
      { mode: 0o600 },
    );

    const workerChild = spawn(process.execPath, [workerEntryScript], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let workerStdout = '';
    let workerStderr = '';
    workerChild.stdout.on('data', (c: Buffer) => {
      workerStdout += c.toString('utf8');
    });
    workerChild.stderr.on('data', (c: Buffer) => {
      workerStderr += c.toString('utf8');
    });

    // Wait until real default Stage A inside OS sandbox writes its PID
    let stagePid = 0;
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && stagePid === 0) {
      const jobDirs = await readdir(workDir).catch(() => []);
      for (const jd of jobDirs) {
        const pidFile = join(workDir, jd, 'stage-a', 'stage-a-out', 'pids.txt');
        const txt = await readFile(pidFile, 'utf8').catch(() => '');
        const parsedPid = Number.parseInt(txt.trim(), 10);
        if (Number.isSafeInteger(parsedPid) && parsedPid > 0) {
          stagePid = parsedPid;
          break;
        }
      }
      if (stagePid === 0) {
        await new Promise(r => setTimeout(r, 20));
      }
    }
    assert.equal(stagePid > 0, true, `stage did not start; stderr=${workerStderr}`);
    assert.equal(isPidAlive(stagePid), true);

    // Send real OS SIGTERM to the worker Node process!
    process.kill(workerChild.pid!, 'SIGTERM');
    const exitCode = await new Promise<number | null>(r => workerChild.on('close', code => r(code)));
    assert.equal(exitCode, 0, `worker exited ${String(exitCode)}; stderr=${workerStderr}`);

    // Sandboxed Stage A process MUST be dead immediately upon worker exit, and workDir cleaned!
    assert.equal(isPidAlive(stagePid), false);
    assert.deepEqual(await readdir(workDir), []);

    const resultLine = workerStdout.split(/\r?\n/).find(l => l.startsWith('WORKER_RESULT:'));
    assert.ok(resultLine, `missing WORKER_RESULT in ${workerStdout}`);
    const parsedWorkerRes = JSON.parse(resultLine.slice('WORKER_RESULT:'.length)) as {
      exitReason: string;
      lastSettlement: WorkerJobSettlementSummary;
    };
    assert.equal(parsedWorkerRes.exitReason, 'preempted');
    assert.equal(parsedWorkerRes.lastSettlement.outcome, 'preempted');
    assert.equal(parsedWorkerRes.lastSettlement.acknowledgment, 'confirmed');
    assert.equal(parsedWorkerRes.lastSettlement.preemptionStatus, 'requeued');
    assert.equal(parsedWorkerRes.lastSettlement.preemptionCount, 1);

    // Preempt epochs 2 and 3, then complete epoch 4 via override Stage A command so it finishes immediately
    for (const expectedEpoch of [2, 3]) {
      const preemptCtrl = new AbortController();
      const r = await runHardwareWorker({
        config: workerCfg,
        once: true,
        preemptSignal: preemptCtrl.signal,
        registerProcessSignalHandlers: false,
        onLeaseAcquired: grant => {
          assert.equal(grant.leaseEpoch, expectedEpoch);
          setTimeout(() => preemptCtrl.abort(), 30);
        },
      });
      assert.equal(r.exitReason, 'preempted');
      assert.equal(r.lastSettlement?.acknowledgment, 'confirmed');
      assert.equal(r.lastSettlement?.preemptionStatus, 'requeued');
    }

    await writeFile(fastGateFlag, '1', 'utf8');
    const fourthRes = await runHardwareWorker({
      config: workerCfg,
      once: true,
      registerProcessSignalHandlers: false,
      evaluator: async opts => {
        const { evaluateBenchmarkJob: realEval } = await import('../src/index.js');
        return realEval({
          ...opts,
          stageACommand: {
            command: '/bin/sh',
            args: ['-c', 'printf "cubin" > "$LOOPWRIGHT_STAGE_A_OUT/k.cubin"'],
          },
        });
      },
    });
    assert.equal(fourthRes.exitReason, 'once_completed');
    assert.equal(fourthRes.lastSettlement?.leaseEpoch, 4);
    assert.equal(fourthRes.lastSettlement?.status, 'approved');

    const settledVerdict = await pollRelayVerdict(relay, req1);
    assert.equal(settledVerdict.status, 'approved');
    assert.equal(settledVerdict.preemptionCount, 3);
  } finally {
    await relay.close();
    await rm(realTmp, { recursive: true, force: true });
  }
});

test('local monotonic lease deadline terminates stage on heartbeat partition or malformed heartbeat response before Relay leaseTtlMs expires', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lw-worker-deadline-'));
  const workDir = join(root, 'work');
  const workloadsDir = join(root, 'workloads');
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  await mkdir(join(workloadsDir, 'gemm-4096'), { recursive: true, mode: 0o700 });
  await writeFile(
    join(workloadsDir, 'gemm-4096', 'evaluate.sh'),
    '#!/bin/sh\nprintf \'{"status":"approved","metrics":{"speedup":2.0}}\\n\'\n',
    { mode: 0o755 },
  );

  let hbCount = 0;
  let completeCalled = false;
  const hex = 'c'.repeat(64);
  const partitionSrv = createServer((req, res) => {
    if (req.url === '/v1/runner/leases:acquire') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          relayBootId: 'boot-part',
          jobId: 'job-part-1',
          operationId: 'op-part-1',
          leaseEpoch: 1,
          leaseToken: 'tok-part-1',
          leaseTtlMs: 260,
          job: {
            operationId: 'op-part-1',
            gateId: 'g1',
            checkId: 'c1',
            candidateDigest: hex,
            subject: {
              lockHash: { algorithm: 'sha256', hex },
              contractHash: { algorithm: 'sha256', hex },
              repository: 'org/repo',
              baseRevision: '1'.repeat(40),
              sourceRevision: '1'.repeat(40),
              candidateDigest: { algorithm: 'sha256', hex },
              targetMatrixDigest: null,
            },
            targetCellId: 'cuda-sm90',
            targetHardware: { accelerator: 'sm_90a', isolationMode: 'whole_device' },
            heldOutWorkloadId: 'gemm-4096',
            metricThresholds: [],
            maxPreemptions: 2,
            preemptionCount: 0,
            candidateArtifacts: { entries: [], deleted: [] },
          },
        }),
      );
      return;
    }
    if (req.url?.includes('/events')) {
      // Simulate SSE stream dropping right after initial state frame
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: state\ndata: {"desiredState":"running"}\n\n');
      setTimeout(() => res.destroy(), 20);
      return;
    }
    if (req.url?.endsWith(':heartbeat')) {
      hbCount += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      // Return malformed heartbeat fields (invalid desiredState or negative leaseTtlMs) -> MUST NOT extend local deadline!
      if (hbCount % 2 === 1) {
        res.end('{"desiredState":"bogus","leaseTtlMs":260}');
      } else {
        res.end('{"desiredState":"running","leaseTtlMs":0}');
      }
      return;
    }
    if (req.url?.endsWith(':complete')) {
      completeCalled = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true,"operationId":"op-part-1","status":"approved"}');
      return;
    }
    res.writeHead(500);
    res.end();
  });
  await new Promise<void>(r => partitionSrv.listen(0, '127.0.0.1', () => r()));
  const port = (partitionSrv.address() as { port: number }).port;

  let spawnedChildPid = 0;
  const startedAt = performance.now();
  try {
    const res = await runHardwareWorker({
      config: makeWorkerConfig(`http://127.0.0.1:${port}`, workDir, workloadsDir, {
        heartbeatIntervalMs: 40,
      }),
      once: true,
      enableSseEvents: true,
      registerProcessSignalHandlers: false,
      evaluator: async ({ signal }) =>
        await new Promise((_resolve, reject) => {
          const child = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
          spawnedChildPid = child.pid ?? 0;
          signal?.addEventListener(
            'abort',
            () => {
              try {
                if (child.pid) process.kill(-child.pid, 'SIGKILL');
              } catch {
                child.kill('SIGKILL');
              }
            },
            { once: true },
          );
          child.on('close', () => reject(new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'aborted on expiry')));
        }),
    });

    const elapsedMs = performance.now() - startedAt;
    // Must abort strictly near conservative deadline (< 600ms, never sleeping 30s!) and NEVER call :complete!
    assert.equal(elapsedMs < 1_000, true, `took too long (${elapsedMs}ms)`);
    assert.equal(hbCount >= 1, true);
    assert.equal(completeCalled, false);
    assert.equal(isPidAlive(spawnedChildPid), false);
    assert.equal(res.lastSettlement?.outcome, 'fenced');
    assert.equal(res.lastSettlement?.acknowledgment, 'fenced');
  } finally {
    partitionSrv.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('deterministic artifact/policy errors settle via :complete with preemptionCount=0 in continuous loop; infrastructure errors never call :preempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lw-worker-determ-'));
  const casDir = join(root, 'cas');
  const workDir = join(root, 'work');
  const workloadsDir = join(root, 'workloads');
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  await mkdir(join(workloadsDir, 'gemm-4096'), { recursive: true, mode: 0o700 });
  await writeFile(
    join(workloadsDir, 'gemm-4096', 'evaluate.sh'),
    '#!/bin/sh\nprintf \'{"status":"approved","metrics":{"speedup":1.8}}\\n\'\n',
    { mode: 0o755 },
  );

  // Rejects native_os + physical probeMode before even polling Relay
  await assert.rejects(
    () =>
      runHardwareWorker({
        config: makeWorkerConfig('http://127.0.0.1:9', workDir, workloadsDir, {
          sandboxBackend: 'native_os',
          probeMode: 'physical',
        }),
        once: true,
        registerProcessSignalHandlers: false,
      }),
    /docker backend is required/,
  );

  const relay = await startRelayServer({
    port: 0,
    casDir,
    controllerSigningSecret: CONTROLLER_SECRET,
    workerTokens: [WORKER_TOKEN],
    leaseTtlMs: 5_000,
  });

  try {
    // Queue 3 jobs:
    // 1) PAYLOAD_TOO_LARGE (e.g. oversized Stage A output) -> settles denied via :complete (preemptionCount=0)
    // 2) ARTIFACT_INVALID (e.g. malformed candidate LWTREE01) -> settles denied via :complete (preemptionCount=0)
    // 3) Healthy Stage A + Stage B job -> settles approved (preemptionCount=0)
    // All processed sequentially by ONE continuous (once=false) worker without throwing or calling :preempt!
    const reqOversized = await stageInputAndSubmitJob(relay, 'verify.0.check.oversized-out', []);
    const reqInvalidCand = await stageInputAndSubmitJob(relay, 'verify.0.check.invalid-cand', []);
    const reqHealthy = await stageInputAndSubmitJob(relay, 'verify.0.check.healthy-after-errors', [
      {
        name: 'scripts/build.sh',
        bytes: Buffer.from('#!/bin/sh\nprintf "ok" > "$LOOPWRIGHT_STAGE_A_OUT/a.cubin"\n', 'utf8'),
        mode: '100755',
      },
    ]);

    const stopCtrl = new AbortController();
    const settlements: WorkerJobSettlementSummary[] = [];
    const loopRes = await runHardwareWorker({
      config: makeWorkerConfig(relay.url, workDir, workloadsDir, { pollWaitMs: 30 }),
      once: false,
      signal: stopCtrl.signal,
      registerProcessSignalHandlers: false,
      evaluator: async opts => {
        if (opts.grant.operationId === 'verify.0.check.oversized-out') {
          throw new HardwareRunnerError('PAYLOAD_TOO_LARGE', 'Stage A output exceeded per-file byte limit');
        }
        if (opts.grant.operationId === 'verify.0.check.invalid-cand') {
          throw new HardwareRunnerError('ARTIFACT_INVALID', 'malformed candidate LWTREE01 bundle');
        }
        const { evaluateBenchmarkJob: realEval } = await import('../src/index.js');
        return realEval(opts);
      },
      onJobSettled: summary => {
        settlements.push(summary);
        if (settlements.length === 3) {
          setTimeout(() => stopCtrl.abort(), 20);
        }
      },
    });

    assert.equal(loopRes.exitReason, 'aborted');
    assert.equal(loopRes.jobsProcessed, 3);
    assert.deepEqual(
      settlements.map(s => [s.outcome, s.acknowledgment, s.status]),
      [
        ['completed', 'confirmed', 'denied'],
        ['completed', 'confirmed', 'denied'],
        ['completed', 'confirmed', 'approved'],
      ],
    );

    const vOversized = await pollRelayVerdict(relay, reqOversized);
    assert.equal(vOversized.status, 'denied');
    assert.equal(vOversized.reason, 'PAYLOAD_TOO_LARGE');
    assert.equal(vOversized.preemptionCount, 0);

    const vInvalidCand = await pollRelayVerdict(relay, reqInvalidCand);
    assert.equal(vInvalidCand.status, 'denied');
    assert.equal(vInvalidCand.reason, 'ARTIFACT_INVALID');
    assert.equal(vInvalidCand.preemptionCount, 0);

    const vHealthy = await pollRelayVerdict(relay, reqHealthy);
    assert.equal(vHealthy.status, 'approved');
    assert.equal(vHealthy.preemptionCount, 0);

    // Missing worker-owned held-out workload directory (ENOENT on <heldOutWorkloadsDir>/gemm-4096)
    // MUST throw a worker infrastructure error (CONFIG_INVALID) and NEVER settle denied via :complete!
    const emptyWorkloadsDir = join(root, 'empty-workloads');
    await mkdir(emptyWorkloadsDir, { recursive: true, mode: 0o700 });
    const reqMissingWorkerWl = await stageInputAndSubmitJob(relay, 'verify.0.check.missing-worker-wl', []);
    await assert.rejects(
      () =>
        runHardwareWorker({
          config: makeWorkerConfig(relay.url, workDir, emptyWorkloadsDir),
          once: true,
          registerProcessSignalHandlers: false,
        }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'CONFIG_INVALID',
    );
    const vMissingWorkerWl = await pollRelayVerdict(relay, reqMissingWorkerWl);
    assert.equal(vMissingWorkerWl.status, 'pending', 'missing worker workload MUST NOT settle candidate denied!');
    assert.equal(vMissingWorkerWl.preemptionCount, 0);

    // Infrastructure RUNNER_SANDBOX_FAILED throws out of worker WITHOUT calling :preempt (preemptionCount stays 0 immediately!)
    const reqInfra = await stageInputAndSubmitJob(relay, 'verify.0.check.infra-err', []);
    await assert.rejects(
      () =>
        runHardwareWorker({
          config: makeWorkerConfig(relay.url, workDir, workloadsDir),
          once: true,
          registerProcessSignalHandlers: false,
          evaluator: async () => {
            throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'docker daemon unreachable');
          },
        }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'RUNNER_SANDBOX_FAILED',
    );
    const vInfraImmediate = await pollRelayVerdict(relay, reqInfra);
    assert.equal(vInfraImmediate.status, 'pending');
    assert.equal(vInfraImmediate.preemptionCount, 0);
  } finally {
    await relay.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('separate confirmed/fenced/unknown outcomes on :preempt and :complete, specific 409 error codes, synchronized PUT digest check, and 64 KiB control caps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lw-worker-proto-'));
  const workDir = join(root, 'work');
  const workloadsDir = join(root, 'workloads');
  const sealedBlobPath = join(root, 'sealed-stage-a.cubin');
  const sealedBytes = Buffer.from('SEALED_STAGE_A_CUBIN_PAYLOAD', 'utf8');
  const sealedSha = sha256Hex(sealedBytes);
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  await mkdir(join(workloadsDir, 'gemm-4096'), { recursive: true, mode: 0o700 });
  await writeFile(sealedBlobPath, sealedBytes, { mode: 0o400 });

  type ProtoMode =
    | 'http_302'
    | 'http_401'
    | 'http_403'
    | 'http_404'
    | 'http_409_missing'
    | 'http_413'
    | 'http_429'
    | 'http_500'
    | 'oversized_body'
    | 'bad_grant'
    | 'blob_dl_oversized_err'
    | 'blob_dl_missing_headers'
    | 'blob_dl_bad_headers'
    | 'blob_dl_corrupt'
    | 'blob_ul_early_201_corrupt_local'
    | 'blob_ul_oversized_resp'
    | 'blob_ul_409_fenced'
    | 'preempt_409_fenced'
    | 'preempt_500_unknown'
    | 'complete_409_fenced'
    | 'complete_409_missing_artifact'
    | 'complete_409_job_conflict'
    | 'complete_500_unknown'
    | 'complete_oversized_req'
    | 'hb_cancel'
    | 'sse_cancel';
  let mode: ProtoMode = 'http_302';

  const makeValidGrantJson = (entries: readonly unknown[] = []) => {
    const hex = 'b'.repeat(64);
    return JSON.stringify({
      relayBootId: 'boot-proto',
      jobId: 'job-proto-1',
      operationId: 'op-proto-1',
      leaseEpoch: 1,
      leaseToken: 'tok-proto-1',
      leaseTtlMs: 5_000,
      job: {
        operationId: 'op-proto-1',
        gateId: 'g1',
        checkId: 'c1',
        candidateDigest: hex,
        subject: {
          lockHash: { algorithm: 'sha256', hex },
          contractHash: { algorithm: 'sha256', hex },
          repository: 'org/repo',
          baseRevision: '1'.repeat(40),
          sourceRevision: '1'.repeat(40),
          candidateDigest: { algorithm: 'sha256', hex },
          targetMatrixDigest: null,
        },
        targetCellId: 'cuda-sm90',
        targetHardware: { accelerator: 'sm_90a', isolationMode: 'whole_device' },
        heldOutWorkloadId: 'gemm-4096',
        metricThresholds: [],
        maxPreemptions: 2,
        preemptionCount: 0,
        candidateArtifacts: { entries, deleted: [] },
      },
    });
  };

  const srv = createServer((req, res) => {
    if (req.url === '/v1/runner/leases:acquire') {
      if (mode === 'http_302') {
        res.writeHead(302, { location: 'http://127.0.0.1:9/evil' });
        res.end();
        return;
      }
      if (mode === 'http_401') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"code":"AUTH_UNAUTHORIZED"}');
        return;
      }
      if (mode === 'http_403') {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end('{"code":"AUTH_FORBIDDEN"}');
        return;
      }
      if (mode === 'http_404') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"code":"NOT_FOUND"}');
        return;
      }
      if (mode === 'http_409_missing') {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end('{"code":"ARTIFACT_MISSING"}');
        return;
      }
      if (mode === 'http_413') {
        res.writeHead(413);
        res.end('too big');
        return;
      }
      if (mode === 'http_429') {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end('{"code":"QUEUE_CAPACITY_EXCEEDED"}');
        return;
      }
      if (mode === 'http_500') {
        res.writeHead(500);
        res.end('internal error');
        return;
      }
      if (mode === 'oversized_body') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('x'.repeat(70_000));
        return;
      }
      if (mode === 'bad_grant') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"relayBootId":"","jobId":"j","operationId":"o","leaseEpoch":0,"leaseToken":"t","leaseTtlMs":5,"job":{}}');
        return;
      }
      const inputBlobBytes = Buffer.from('expected-bytes', 'utf8');
      const inputSha = sha256Hex(inputBlobBytes);
      const entries =
        mode === 'blob_dl_corrupt'
        || mode === 'blob_dl_missing_headers'
        || mode === 'blob_dl_bad_headers'
        || mode === 'blob_dl_oversized_err'
          ? [{ name: 'build.sh', digest: { algorithm: 'sha256', hex: inputSha }, byteLength: inputBlobBytes.byteLength, mode: '100755' }]
          : [];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(makeValidGrantJson(entries));
      return;
    }

    if (req.url?.includes('/events')) {
      if (mode === 'sse_cancel') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        setTimeout(() => {
          res.write('event: cancel\ndata: {"desiredState":"cancel"}\n\n');
          res.end();
        }, 20);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: state\ndata: {"desiredState":"running"}\n\n');
      return;
    }

    if (req.method === 'GET' && req.url?.includes('/blobs/')) {
      if (mode === 'blob_dl_oversized_err') {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('E'.repeat(70_000));
        return;
      }
      const expected = Buffer.from('expected-bytes', 'utf8');
      const expectedSha = sha256Hex(expected);
      if (mode === 'blob_dl_missing_headers') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(expected);
        return;
      }
      if (mode === 'blob_dl_bad_headers') {
        res.writeHead(200, {
          'x-loopwright-blob-sha256': '0'.repeat(64),
          'x-loopwright-blob-length': String(expected.byteLength),
        });
        res.end(expected);
        return;
      }
      res.writeHead(200, {
        'x-loopwright-blob-sha256': expectedSha,
        'x-loopwright-blob-length': String(expected.byteLength),
      });
      res.end(Buffer.from('corrupted-byte', 'utf8'));
      return;
    }

    if (req.method === 'PUT' && req.url?.includes('/blobs/')) {
      if (mode === 'blob_ul_early_201_corrupt_local') {
        // Respond 201 IMMEDIATELY before draining body to race against local digest verification!
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sha256: '9'.repeat(64), byteLength: sealedBytes.byteLength }));
        req.resume();
        return;
      }
      req.resume();
      req.on('end', () => {
        if (mode === 'blob_ul_oversized_resp') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('R'.repeat(70_000));
          return;
        }
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end('{"code":"QUEUE_LEASE_FENCED"}');
      });
      return;
    }

    if (req.url?.endsWith(':heartbeat')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ desiredState: mode === 'hb_cancel' ? 'cancel' : 'running', leaseTtlMs: 5_000 }));
      return;
    }

    if (req.url?.endsWith(':preempt')) {
      if (mode === 'preempt_409_fenced') {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end('{"code":"QUEUE_LEASE_FENCED"}');
        return;
      }
      if (mode === 'preempt_500_unknown') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"internal"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"requeued","preemptionCount":1}');
      return;
    }

    if (req.url?.endsWith(':complete')) {
      if (mode === 'complete_409_fenced') {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end('{"code":"QUEUE_LEASE_FENCED"}');
        return;
      }
      if (mode === 'complete_409_missing_artifact') {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end('{"code":"ARTIFACT_MISSING"}');
        return;
      }
      if (mode === 'complete_409_job_conflict') {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end('{"code":"QUEUE_JOB_CONFLICT"}');
        return;
      }
      if (mode === 'complete_500_unknown') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"error":"unavailable"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true,"operationId":"op-proto-1","status":"denied"}');
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  const baseCfg = makeWorkerConfig(`http://127.0.0.1:${port}`, workDir, workloadsDir, {
    pollWaitMs: 0,
    heartbeatIntervalMs: 30,
  });

  try {
    const expectedAcquireErrors: readonly [ProtoMode, string][] = [
      ['http_302', 'AUTH_FORBIDDEN'],
      ['http_401', 'AUTH_UNAUTHORIZED'],
      ['http_403', 'AUTH_FORBIDDEN'],
      ['http_404', 'NOT_FOUND'],
      ['http_409_missing', 'ARTIFACT_MISSING'],
      ['http_413', 'PAYLOAD_TOO_LARGE'],
      ['http_429', 'QUEUE_CAPACITY_EXCEEDED'],
      ['http_500', 'RUNNER_SANDBOX_FAILED'],
      ['oversized_body', 'PAYLOAD_TOO_LARGE'],
      ['bad_grant', 'ARTIFACT_INVALID'],
    ];
    for (const [m, expectedCode] of expectedAcquireErrors) {
      mode = m;
      await assert.rejects(
        () => runHardwareWorker({ config: baseCfg, once: true, registerProcessSignalHandlers: false }),
        (err: unknown) => err instanceof HardwareRunnerError && err.code === expectedCode,
      );
    }

    // GET blob >64 KiB HTTP 500 error page throws RunnerTransportError (infrastructure error, NEVER denied :complete!)
    mode = 'blob_dl_oversized_err';
    await assert.rejects(
      () =>
        runHardwareWorker({
          config: baseCfg,
          once: true,
          enableSseEvents: false,
          registerProcessSignalHandlers: false,
        }),
      (err: unknown) => err instanceof RunnerTransportError && isRunnerTransportError(err),
    );

    // Relay HTTP 200 GET with missing or mismatched digest/length headers is a Relay transport/protocol fault
    // (RunnerTransportError) and MUST NOT settle candidate denied via :complete!
    for (const hdrMode of ['blob_dl_missing_headers', 'blob_dl_bad_headers'] as const) {
      mode = hdrMode;
      await assert.rejects(
        () =>
          runHardwareWorker({
            config: baseCfg,
            once: true,
            enableSseEvents: false,
            registerProcessSignalHandlers: false,
          }),
        (err: unknown) => err instanceof RunnerTransportError && isRunnerTransportError(err),
      );
    }

    // Verified candidate byte hash mismatch on complete HTTP 200 GET body settles denied via :complete
    mode = 'blob_dl_corrupt';
    const dlRes = await runHardwareWorker({
      config: baseCfg,
      once: true,
      enableSseEvents: false,
      registerProcessSignalHandlers: false,
    });
    assert.equal(dlRes.lastSettlement?.outcome, 'completed');
    assert.equal(dlRes.lastSettlement?.status, 'denied');

    // PUT blob early 201 response MUST still fail if local streaming digest check mismatches!
    mode = 'blob_ul_early_201_corrupt_local';
    await assert.rejects(
      () =>
        runHardwareWorker({
          config: baseCfg,
          once: true,
          enableSseEvents: false,
          registerProcessSignalHandlers: false,
          evaluator: async () => ({
            status: 'approved',
            reason: null,
            sealedOutputs: [
              {
                // Declare wrong sha256 so local streaming check catches mismatch even after server sends early 201!
                artifact: { name: 'a.cubin', digest: { algorithm: 'sha256', hex: '9'.repeat(64) }, byteLength: sealedBytes.byteLength },
                sealedFilePath: sealedBlobPath,
              },
            ],
            cleanup: async () => {},
          }),
        }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'ARTIFACT_INVALID',
    );

    // PUT blob >64 KiB response body rejected with PAYLOAD_TOO_LARGE
    mode = 'blob_ul_oversized_resp';
    await assert.rejects(
      () =>
        runHardwareWorker({
          config: baseCfg,
          once: true,
          enableSseEvents: false,
          registerProcessSignalHandlers: false,
          evaluator: async () => ({
            status: 'approved',
            reason: null,
            sealedOutputs: [
              {
                artifact: { name: 'a.cubin', digest: { algorithm: 'sha256', hex: sealedSha }, byteLength: sealedBytes.byteLength },
                sealedFilePath: sealedBlobPath,
              },
            ],
            cleanup: async () => {},
          }),
        }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'PAYLOAD_TOO_LARGE',
    );

    // PUT blob 409 QUEUE_LEASE_FENCED settles fenced
    mode = 'blob_ul_409_fenced';
    const ulFenceRes = await runHardwareWorker({
      config: baseCfg,
      once: true,
      registerProcessSignalHandlers: false,
      evaluator: async () => ({
        status: 'approved',
        reason: null,
        sealedOutputs: [
          {
            artifact: { name: 'a.cubin', digest: { algorithm: 'sha256', hex: sealedSha }, byteLength: sealedBytes.byteLength },
            sealedFilePath: sealedBlobPath,
          },
        ],
        cleanup: async () => {},
      }),
    });
    assert.equal(ulFenceRes.lastSettlement?.outcome, 'fenced');
    assert.equal(ulFenceRes.lastSettlement?.acknowledgment, 'fenced');

    // :preempt 409 QUEUE_LEASE_FENCED -> outcome='fenced' (NEVER 'preempted'!)
    mode = 'preempt_409_fenced';
    const pFenceCtrl = new AbortController();
    const pFenceRes = await runHardwareWorker({
      config: baseCfg,
      once: true,
      preemptSignal: pFenceCtrl.signal,
      registerProcessSignalHandlers: false,
      evaluator: async ({ signal }) => {
        setTimeout(() => pFenceCtrl.abort(), 15);
        await new Promise<void>(r => signal?.addEventListener('abort', () => r(), { once: true }));
        throw new Error('preempted');
      },
    });
    assert.equal(pFenceRes.lastSettlement?.outcome, 'fenced');
    assert.equal(pFenceRes.lastSettlement?.acknowledgment, 'fenced');
    assert.equal(pFenceRes.lastSettlement?.relayErrorCode, 'QUEUE_LEASE_FENCED');

    // :preempt 500 -> outcome='unknown', acknowledgment='unknown' (NEVER 'preempted'!)
    mode = 'preempt_500_unknown';
    const pUnkCtrl = new AbortController();
    const pUnkRes = await runHardwareWorker({
      config: baseCfg,
      once: true,
      preemptSignal: pUnkCtrl.signal,
      registerProcessSignalHandlers: false,
      evaluator: async ({ signal }) => {
        setTimeout(() => pUnkCtrl.abort(), 15);
        await new Promise<void>(r => signal?.addEventListener('abort', () => r(), { once: true }));
        throw new Error('preempted');
      },
    });
    assert.equal(pUnkRes.lastSettlement?.outcome, 'unknown');
    assert.equal(pUnkRes.lastSettlement?.acknowledgment, 'unknown');

    // :complete 409 QUEUE_LEASE_FENCED -> outcome='fenced', acknowledgment='fenced'
    mode = 'complete_409_fenced';
    const cFenceRes = await runHardwareWorker({
      config: baseCfg,
      once: true,
      enableSseEvents: false,
      registerProcessSignalHandlers: false,
      evaluator: async () => ({ status: 'denied', reason: 'FAIL', sealedOutputs: [], cleanup: async () => {} }),
    });
    assert.equal(cFenceRes.lastSettlement?.outcome, 'fenced');
    assert.equal(cFenceRes.lastSettlement?.relayErrorCode, 'QUEUE_LEASE_FENCED');

    // :complete 409 ARTIFACT_MISSING and 409 QUEUE_JOB_CONFLICT preserve exact Relay error code (NOT fenced!)
    for (const [cMode, expectedErrCode] of [
      ['complete_409_missing_artifact', 'ARTIFACT_MISSING'],
      ['complete_409_job_conflict', 'QUEUE_JOB_CONFLICT'],
    ] as const) {
      mode = cMode;
      await assert.rejects(
        () =>
          runHardwareWorker({
            config: baseCfg,
            once: true,
            enableSseEvents: false,
            registerProcessSignalHandlers: false,
            evaluator: async () => ({ status: 'denied', reason: 'FAIL', sealedOutputs: [], cleanup: async () => {} }),
          }),
        (err: unknown) => err instanceof HardwareRunnerError && err.code === expectedErrCode,
      );
    }

    // :complete 503 -> records lastSettlement outcome='unknown', acknowledgment='unknown' and throws
    mode = 'complete_500_unknown';
    const capturedUnknownSettlements: WorkerJobSettlementSummary[] = [];
    await assert.rejects(() =>
      runHardwareWorker({
        config: baseCfg,
        once: true,
        enableSseEvents: false,
        registerProcessSignalHandlers: false,
        evaluator: async () => ({ status: 'denied', reason: 'FAIL', sealedOutputs: [], cleanup: async () => {} }),
        onJobSettled: s => {
          capturedUnknownSettlements.push(s);
        },
      }),
    );
    assert.equal(capturedUnknownSettlements[0]?.outcome, 'unknown');
    assert.equal(capturedUnknownSettlements[0]?.acknowledgment, 'unknown');

    // :complete serialized control request > 64 KiB rejected locally before sending (PAYLOAD_TOO_LARGE) — NEVER publishes outcome='unknown'!
    mode = 'complete_oversized_req';
    const preSendSettlements: WorkerJobSettlementSummary[] = [];
    await assert.rejects(
      () =>
        runHardwareWorker({
          config: baseCfg,
          once: true,
          enableSseEvents: false,
          registerProcessSignalHandlers: false,
          evaluator: async () => ({
            status: 'denied',
            reason: 'FAIL',
            detail: 'X'.repeat(70_000),
            sealedOutputs: [],
            cleanup: async () => {},
          }),
          onJobSettled: s => {
            preSendSettlements.push(s);
          },
        }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'PAYLOAD_TOO_LARGE',
    );
    assert.deepEqual(preSendSettlements, []);

    // Heartbeat cancel and SSE cancel settle as 'cancelled'
    for (const cancelMode of ['hb_cancel', 'sse_cancel'] as const) {
      mode = cancelMode;
      const cancelRes = await runHardwareWorker({
        config: baseCfg,
        once: true,
        enableSseEvents: cancelMode === 'sse_cancel',
        registerProcessSignalHandlers: false,
        evaluator: async ({ signal }) => {
          await new Promise<void>(r => signal?.addEventListener('abort', () => r(), { once: true }));
          throw new Error('cancelled');
        },
      });
      assert.equal(cancelRes.lastSettlement?.outcome, 'cancelled');
    }
  } finally {
    srv.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('continuous worker loop survives transient 503 acquire errors, pollWaitMs=0 idle sleep, SSE 409 fencing, SSE frame overflow wakeup, and :preempt socket reset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lw-worker-cont-'));
  const workDir = join(root, 'work');
  const workloadsDir = join(root, 'workloads');
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  await mkdir(join(workloadsDir, 'gemm-fp16-4096'), { recursive: true, mode: 0o700 });

  let phase: 'transient_retry' | 'sse_409_fence' | 'sse_overflow_and_preempt_drop' = 'transient_retry';
  let acquireAttempts = 0;

  const srv = createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'POST' && url === '/v1/runner/leases:acquire') {
      acquireAttempts += 1;
      if (phase === 'transient_retry') {
        if (acquireAttempts === 1) {
          req.socket.destroy();
          return;
        }
        if (acquireAttempts === 2) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'RELAY_UNAVAILABLE', message: 'busy' } }));
          return;
        }
        res.writeHead(204);
        res.end();
        return;
      }
      const hex = '1'.repeat(64);
      const grant = {
        relayBootId: 'boot-cont-1',
        jobId: 'job-cont-1',
        operationId: 'op-cont-1',
        leaseEpoch: 1,
        leaseToken: 'lease-tok-cont-0123456789',
        leaseTtlMs: 2_000,
        job: {
          operationId: 'op-cont-1',
          gateId: 'g1',
          checkId: 'c1',
          candidateDigest: hex,
          subject: {
            lockHash: { algorithm: 'sha256', hex },
            contractHash: { algorithm: 'sha256', hex },
            repository: 'org/repo',
            baseRevision: '1'.repeat(40),
            sourceRevision: '1'.repeat(40),
            candidateDigest: { algorithm: 'sha256', hex },
            targetMatrixDigest: null,
          },
          targetCellId: 'cuda-sm90',
          targetHardware: { accelerator: 'sm_90a', isolationMode: 'whole_device', deviceCount: 1 },
          heldOutWorkloadId: 'gemm-fp16-4096',
          metricThresholds: [],
          maxPreemptions: 2,
          preemptionCount: 0,
          candidateArtifacts: { entries: [], deleted: [] },
        },
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(grant));
      return;
    }
    if (req.method === 'GET' && url.endsWith('/events')) {
      if (phase === 'sse_409_fence') {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'QUEUE_LEASE_FENCED', message: 'fenced' } }));
        return;
      }
      // Send > 16 KiB without \n\n to trigger bounded SSE buffer disconnect + immediate heartbeat wakeup
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': ' + 'x'.repeat(17_000));
      return;
    }
    if (req.method === 'POST' && url.endsWith(':heartbeat')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ desiredState: 'running', leaseEpoch: 1, leaseTtlMs: 2_000 }));
      return;
    }
    if (req.method === 'POST' && url.endsWith(':preempt')) {
      // Simulate abrupt TCP reset during :preempt -> worker must record outcome='unknown'!
      req.socket.destroy();
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const addr = srv.address();
  assert.equal(addr !== null && typeof addr === 'object', true);
  const port = (addr as { port: number }).port;
  const cfg: WorkerConfig = {
    ...makeWorkerConfig(`http://127.0.0.1:${port}`, workDir, workloadsDir),
    pollWaitMs: 0,
    heartbeatIntervalMs: 500,
    requestTimeoutMs: 1_500,
  };

  try {
    // 1. Continuous mode retries transient 503 + pollWaitMs=0 idle sleep until shutdown signal aborts
    const stopCtrl = new AbortController();
    setTimeout(() => stopCtrl.abort(), 90);
    const contRes = await runHardwareWorker({
      config: cfg,
      once: false,
      idleRetryDelayMs: 15,
      signal: stopCtrl.signal,
      registerProcessSignalHandlers: false,
    });
    assert.equal(contRes.exitReason, 'aborted');
    assert.equal(contRes.polls >= 2, true);

    // 2. SSE 409 immediately fences active lease
    phase = 'sse_409_fence';
    const sseFenceRes = await runHardwareWorker({
      config: cfg,
      once: true,
      enableSseEvents: true,
      registerProcessSignalHandlers: false,
      evaluator: async ({ signal }) => {
        await new Promise<void>(r => signal?.addEventListener('abort', () => r(), { once: true }));
        throw new Error('aborted by sse 409');
      },
    });
    assert.equal(sseFenceRes.lastSettlement?.outcome, 'fenced');

    // 3. SSE >16 KiB overflow triggers immediate heartbeat + :preempt TCP reset records outcome='unknown'
    phase = 'sse_overflow_and_preempt_drop';
    const preemptDropCtrl = new AbortController();
    const dropRes = await runHardwareWorker({
      config: cfg,
      once: true,
      enableSseEvents: true,
      preemptSignal: preemptDropCtrl.signal,
      registerProcessSignalHandlers: false,
      evaluator: async ({ signal }) => {
        setTimeout(() => preemptDropCtrl.abort(), 60);
        await new Promise<void>(r => signal?.addEventListener('abort', () => r(), { once: true }));
        throw new Error('preempted');
      },
    });
    assert.equal(dropRes.exitReason, 'preempted');
    assert.equal(dropRes.lastSettlement?.outcome, 'unknown');
    assert.equal(dropRes.lastSettlement?.acknowledgment, 'unknown');

    // 4. native_os + physical probeMode refused immediately + pre-aborted signals return cleanly
    await assert.rejects(
      () =>
        runHardwareWorker({
          config: { ...cfg, probeMode: 'physical' },
          once: true,
          registerProcessSignalHandlers: false,
        }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'RUNNER_SANDBOX_FAILED',
    );
    const prePreempt = new AbortController();
    prePreempt.abort();
    const ppRes = await runHardwareWorker({
      config: cfg,
      once: true,
      preemptSignal: prePreempt.signal,
      registerProcessSignalHandlers: false,
    });
    assert.equal(ppRes.exitReason, 'preempted');
    assert.equal(ppRes.polls, 0);
  } finally {
    srv.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('delayed acquisition pre-start renewal, shorter renewal TTL shrinking deadline, max TTL cap, PUT receipt validation, GET 503 non-denial, SIGINT cancelled outcome, malformed 200 & impossible preempt receipts, and teardown failure withholding :preempt', async () => {
  const realRootTmp = await realpath(tmpdir());
  const root = await mkdtemp(join(realRootTmp, 'lw-worker-fix2-'));
  const workDir = join(root, 'work');
  const workloadsDir = join(root, 'workloads');
  const sealedPath = join(root, 'sealed.cubin');
  const sealedBytes = Buffer.from('SEALED_CUBIN_FIX2', 'utf8');
  const sealedSha = sha256Hex(sealedBytes);
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  await mkdir(join(workloadsDir, 'gemm-4096'), { recursive: true, mode: 0o700 });
  await writeFile(join(workloadsDir, 'gemm-4096', 'evaluate.sh'), '#!/bin/sh\nprintf \'{"status":"approved"}\\n\'\n', {
    mode: 0o755,
  });
  await writeFile(sealedPath, sealedBytes, { mode: 0o400 });

  type Fix2Scenario =
    | 'delayed_acq_renew_ok'
    | 'delayed_acq_renew_fenced'
    | 'ttl_exceeds_ceiling'
    | 'shorter_renewal_ttl'
    | 'put_empty_200'
    | 'put_mismatch_sha_200'
    | 'get_503_transient'
    | 'complete_malformed_200'
    | 'preempt_impossible_requeue_zero_budget'
    | 'preempt_cleanup_teardown_fail'
    | 'preempt_docker_rm_fail'
    | 'shutdown_during_eval';

  let scenario: Fix2Scenario = 'delayed_acq_renew_ok';
  let virtualMonoMs = 1_000;
  let hbCalls = 0;
  let completeCalls = 0;
  let preemptCalls = 0;

  const makeGrantPayload = (opts: {
    leaseTtlMs?: number;
    maxPreemptions?: number;
    preemptionCount?: number;
    entries?: readonly unknown[];
  } = {}) => {
    const hex = 'd'.repeat(64);
    return JSON.stringify({
      relayBootId: 'boot-fix2',
      jobId: 'job-fix2-1',
      operationId: 'op-fix2-1',
      leaseEpoch: 1,
      leaseToken: 'tok-fix2-0123456789',
      leaseTtlMs: opts.leaseTtlMs ?? 1_000,
      job: {
        operationId: 'op-fix2-1',
        gateId: 'g1',
        checkId: 'c1',
        candidateDigest: hex,
        subject: {
          lockHash: { algorithm: 'sha256', hex },
          contractHash: { algorithm: 'sha256', hex },
          repository: 'org/repo',
          baseRevision: '1'.repeat(40),
          sourceRevision: '1'.repeat(40),
          candidateDigest: { algorithm: 'sha256', hex },
          targetMatrixDigest: null,
        },
        targetCellId: 'cuda-sm90',
        targetHardware: { accelerator: 'sm_90a', isolationMode: 'whole_device', deviceCount: 1 },
        heldOutWorkloadId: 'gemm-4096',
        metricThresholds: [],
        maxPreemptions: opts.maxPreemptions ?? 2,
        preemptionCount: opts.preemptionCount ?? 0,
        candidateArtifacts: { entries: opts.entries ?? [], deleted: [] },
      },
    });
  };

  const srv = createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'POST' && url === '/v1/runner/leases:acquire') {
      if (scenario === 'delayed_acq_renew_ok' || scenario === 'delayed_acq_renew_fenced') {
        // Advance monotonic clock by 750ms on a 1,000ms lease so turnaround leaves < effectiveHbMs!
        virtualMonoMs += 750;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(makeGrantPayload({ leaseTtlMs: 1_000 }));
        return;
      }
      if (scenario === 'ttl_exceeds_ceiling') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(makeGrantPayload({ leaseTtlMs: MAX_LEASE_TTL_MS + 1 }));
        return;
      }
      if (scenario === 'shorter_renewal_ttl') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(makeGrantPayload({ leaseTtlMs: 5_000 }));
        return;
      }
      if (scenario === 'get_503_transient') {
        const b = Buffer.from('cand', 'utf8');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          makeGrantPayload({
            entries: [{ name: 'build.sh', digest: { algorithm: 'sha256', hex: sha256Hex(b) }, byteLength: b.byteLength, mode: '100755' }],
          }),
        );
        return;
      }
      if (scenario === 'preempt_impossible_requeue_zero_budget') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(makeGrantPayload({ maxPreemptions: 0, preemptionCount: 0 }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(makeGrantPayload({ leaseTtlMs: 5_000 }));
      return;
    }

    if (req.method === 'POST' && url.endsWith(':heartbeat')) {
      hbCalls += 1;
      if (scenario === 'delayed_acq_renew_fenced') {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end('{"code":"QUEUE_LEASE_FENCED"}');
        return;
      }
      if (scenario === 'shorter_renewal_ttl') {
        // Shrink leaseTtlMs from 5,000ms down to 80ms on first heartbeat, then drop subsequent heartbeats!
        if (hbCalls === 1) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ desiredState: 'running', leaseTtlMs: 80 }));
        } else {
          res.writeHead(503);
          res.end();
        }
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ desiredState: 'running', leaseTtlMs: 1_000 }));
      return;
    }

    if (req.method === 'GET' && url.includes('/blobs/')) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"code":"SERVICE_UNAVAILABLE","message":"temporary storage outage"}');
      return;
    }

    if (req.method === 'PUT' && url.includes('/blobs/')) {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        if (scenario === 'put_empty_200') {
          res.end('');
          return;
        }
        if (scenario === 'put_mismatch_sha_200') {
          res.end(JSON.stringify({ ok: true, sha256: 'f'.repeat(64), byteLength: sealedBytes.byteLength }));
          return;
        }
        res.end(JSON.stringify({ ok: true, sha256: sealedSha, byteLength: sealedBytes.byteLength }));
      });
      return;
    }

    if (req.method === 'POST' && url.endsWith(':preempt')) {
      preemptCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (scenario === 'preempt_impossible_requeue_zero_budget') {
        // Impossible requeue when maxPreemptions === 0!
        res.end(JSON.stringify({ status: 'requeued', preemptionCount: 1 }));
        return;
      }
      res.end(JSON.stringify({ status: 'requeued', preemptionCount: 1 }));
      return;
    }

    if (req.method === 'POST' && url.endsWith(':complete')) {
      completeCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (scenario === 'complete_malformed_200') {
        res.end('{"ok":true,"operationId":"wrong-op","status":"approved"}');
        return;
      }
      res.end('{"ok":true,"operationId":"op-fix2-1","status":"approved"}');
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  const baseCfg = makeWorkerConfig(`http://127.0.0.1:${port}`, workDir, workloadsDir, {
    pollWaitMs: 0,
    heartbeatIntervalMs: 35,
  });

  try {
    // 1a. Delayed acquisition triggers synchronous pre-start :heartbeat BEFORE evaluator starts
    scenario = 'delayed_acq_renew_ok';
    hbCalls = 0;
    let hbBeforeEval = 0;
    const delayedOkRes = await runHardwareWorker({
      config: baseCfg,
      once: true,
      enableSseEvents: false,
      registerProcessSignalHandlers: false,
      clock: { nowMonotonicMs: () => virtualMonoMs },
      evaluator: async () => {
        hbBeforeEval = hbCalls;
        return { status: 'approved', reason: null, sealedOutputs: [], cleanup: async () => {} };
      },
    });
    assert.equal(hbBeforeEval, 1, 'expected synchronous pre-start heartbeat before evaluator launch');
    assert.equal(delayedOkRes.lastSettlement?.outcome, 'completed');

    // 1b. Delayed acquisition where pre-start :heartbeat returns 409 QUEUE_LEASE_FENCED NEVER starts evaluator!
    scenario = 'delayed_acq_renew_fenced';
    hbCalls = 0;
    let evalStartedOnStaleGrant = false;
    const delayedFencedRes = await runHardwareWorker({
      config: baseCfg,
      once: true,
      enableSseEvents: false,
      registerProcessSignalHandlers: false,
      clock: { nowMonotonicMs: () => virtualMonoMs },
      evaluator: async () => {
        evalStartedOnStaleGrant = true;
        return { status: 'approved', reason: null, sealedOutputs: [], cleanup: async () => {} };
      },
    });
    assert.equal(hbCalls, 1);
    assert.equal(evalStartedOnStaleGrant, false, 'stale delayed grant must NEVER start evaluator');
    assert.equal(delayedFencedRes.lastSettlement?.outcome, 'fenced');

    // 1c. Grant leaseTtlMs > MAX_LEASE_TTL_MS rejected
    scenario = 'ttl_exceeds_ceiling';
    await assert.rejects(
      () => runHardwareWorker({ config: baseCfg, once: true, enableSseEvents: false, registerProcessSignalHandlers: false }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'ARTIFACT_INVALID',
    );

    // 1d. Shorter renewal TTL (5,000ms -> 80ms) shrinks localLeaseDeadlineMono and aborts evaluator quickly!
    scenario = 'shorter_renewal_ttl';
    hbCalls = 0;
    const shrinkStart = performance.now();
    const shrinkRes = await runHardwareWorker({
      config: baseCfg,
      once: true,
      enableSseEvents: false,
      registerProcessSignalHandlers: false,
      evaluator: async ({ signal }) => {
        await new Promise<void>(r => signal?.addEventListener('abort', () => r(), { once: true }));
        throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'aborted by shortened lease');
      },
    });
    const shrinkElapsed = performance.now() - shrinkStart;
    assert.equal(shrinkElapsed < 800, true, `expected shortened renewal to abort quickly, took ${shrinkElapsed}ms`);
    assert.equal(shrinkRes.lastSettlement?.outcome, 'fenced');

    // 2. PUT blob empty 200 body and mismatched-digest 200 receipt fail BEFORE :complete,
    //    cleaning disposable scratch while PRESERVING the sealed 0o400 Stage A output on disk for reconciliation!
    for (const putMode of ['put_empty_200', 'put_mismatch_sha_200'] as const) {
      scenario = putMode;
      completeCalls = 0;

      // 2a. Cleanup hook that genuinely deletes sealed file unless preserveSealedOutputs === true:
      const hookDir = join(root, `hook-${putMode}`);
      await mkdir(hookDir, { recursive: true, mode: 0o700 });
      const hookDisposable = join(hookDir, 'scratch.tmp');
      const hookSealed = join(hookDir, 'a.cubin');
      await writeFile(hookDisposable, 'disposable-scratch', { mode: 0o600 });
      await writeFile(hookSealed, sealedBytes, { mode: 0o400 });
      await chmod(hookSealed, 0o400);

      let cleanupCalled = false;
      await assert.rejects(
        () =>
          runHardwareWorker({
            config: baseCfg,
            once: true,
            enableSseEvents: false,
            registerProcessSignalHandlers: false,
            evaluator: async () => ({
              status: 'approved',
              reason: null,
              sealedOutputs: [
                {
                  artifact: { name: 'a.cubin', digest: { algorithm: 'sha256', hex: sealedSha }, byteLength: sealedBytes.byteLength },
                  sealedFilePath: hookSealed,
                },
              ],
              cleanup: async opts => {
                cleanupCalled = true;
                await rm(hookDisposable, { force: true });
                if (opts?.preserveSealedOutputs !== true) {
                  await rm(hookSealed, { force: true });
                }
              },
            }),
          }),
        (err: unknown) => err instanceof HardwareRunnerError && err.code === 'ARTIFACT_INVALID',
      );
      assert.equal(completeCalls, 0);
      assert.equal(cleanupCalled, true);
      await assert.rejects(() => lstat(hookDisposable), { code: 'ENOENT' });
      assert.equal((await lstat(hookSealed)).size, sealedBytes.byteLength);

      // 2b. End-to-end with real evaluateBenchmarkJob: disposable supervisor/stage-b/candidate/scratch
      //     are removed fail-closed while stage-a/stage-a-out/a.cubin (0o400) SURVIVES on disk!
      const realPutWorkDir = join(root, `real-put-work-${putMode}`);
      await mkdir(realPutWorkDir, { recursive: true, mode: 0o700 });
      const { evaluateBenchmarkJob: realEvalForPut } = await import('../src/index.js');
      await assert.rejects(
        () =>
          runHardwareWorker({
            config: { ...baseCfg, workDir: realPutWorkDir },
            once: true,
            enableSseEvents: false,
            registerProcessSignalHandlers: false,
            evaluator: opts =>
              realEvalForPut({
                ...opts,
                stageACommand: {
                  command: '/bin/sh',
                  args: ['-c', `printf 'SEALED_CUBIN_FIX2' > "$LOOPWRIGHT_STAGE_A_OUT/a.cubin"`],
                },
              }),
          }),
        (err: unknown) => err instanceof HardwareRunnerError && err.code === 'ARTIFACT_INVALID',
      );
      assert.equal(completeCalls, 0);
      const retainedJobDirs = await readdir(realPutWorkDir);
      assert.equal(retainedJobDirs.length, 1);
      const retainedJobRoot = join(realPutWorkDir, retainedJobDirs[0]!);
      await assert.rejects(() => lstat(join(retainedJobRoot, 'supervisor')), { code: 'ENOENT' });
      await assert.rejects(() => lstat(join(retainedJobRoot, 'stage-b')), { code: 'ENOENT' });
      await assert.rejects(() => lstat(join(retainedJobRoot, 'stage-a', 'candidate')), { code: 'ENOENT' });
      await assert.rejects(() => lstat(join(retainedJobRoot, 'stage-a', 'scratch')), { code: 'ENOENT' });
      const preservedCubinStat = await lstat(join(retainedJobRoot, 'stage-a', 'stage-a-out', 'a.cubin'));
      assert.equal(preservedCubinStat.mode & 0o7777, 0o400);
      assert.equal(preservedCubinStat.size, sealedBytes.byteLength);
      await chmod(join(retainedJobRoot, 'stage-a', 'stage-a-out'), 0o700);
      await rm(realPutWorkDir, { recursive: true, force: true });
    }

    // 3. Transient HTTP 503 on input-blob GET throws RunnerTransportError and NEVER settles denied :complete or :preempt!
    scenario = 'get_503_transient';
    completeCalls = 0;
    preemptCalls = 0;
    await assert.rejects(
      () => runHardwareWorker({ config: baseCfg, once: true, enableSseEvents: false, registerProcessSignalHandlers: false }),
      (err: unknown) => err instanceof RunnerTransportError && isRunnerTransportError(err),
    );
    assert.equal(completeCalls, 0);
    assert.equal(preemptCalls, 0);

    // 4. Post-send malformed HTTP 200 on :complete publishes outcome='unknown', acknowledgment='unknown'
    scenario = 'complete_malformed_200';
    const malformedCompleteSettlements: WorkerJobSettlementSummary[] = [];
    await assert.rejects(
      () =>
        runHardwareWorker({
          config: baseCfg,
          once: true,
          enableSseEvents: false,
          registerProcessSignalHandlers: false,
          evaluator: async () => ({ status: 'approved', reason: null, sealedOutputs: [], cleanup: async () => {} }),
          onJobSettled: s => {
            malformedCompleteSettlements.push(s);
          },
        }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'ARTIFACT_INVALID',
    );
    assert.equal(malformedCompleteSettlements[0]?.outcome, 'unknown');
    assert.equal(malformedCompleteSettlements[0]?.acknowledgment, 'unknown');

    // 5. Impossible requeue receipt on :preempt when maxPreemptions === 0 settles outcome='unknown' (NEVER confirmed!)
    scenario = 'preempt_impossible_requeue_zero_budget';
    const zeroBudgetPreempt = new AbortController();
    const zeroBudgetRes = await runHardwareWorker({
      config: baseCfg,
      once: true,
      enableSseEvents: false,
      preemptSignal: zeroBudgetPreempt.signal,
      registerProcessSignalHandlers: false,
      evaluator: async ({ signal }) => {
        setTimeout(() => zeroBudgetPreempt.abort(), 15);
        await new Promise<void>(r => signal?.addEventListener('abort', () => r(), { once: true }));
        throw new Error('preempted');
      },
    });
    assert.equal(zeroBudgetRes.lastSettlement?.outcome, 'unknown');
    assert.equal(zeroBudgetRes.lastSettlement?.acknowledgment, 'unknown');

    // 6a. Workspace cleanup failure during SIGTERM/preemption withholds :preempt and propagates RunnerTeardownError!
    scenario = 'preempt_cleanup_teardown_fail';
    preemptCalls = 0;
    const cleanupFailPreempt = new AbortController();
    const teardownSettlements: WorkerJobSettlementSummary[] = [];
    await assert.rejects(
      () =>
        runHardwareWorker({
          config: baseCfg,
          once: true,
          enableSseEvents: false,
          preemptSignal: cleanupFailPreempt.signal,
          registerProcessSignalHandlers: false,
          evaluator: async ({ signal }) => {
            setTimeout(() => cleanupFailPreempt.abort(), 15);
            await new Promise<void>(r => signal?.addEventListener('abort', () => r(), { once: true }));
            throw new RunnerTeardownError('failed to unlink sealed job directory during SIGTERM eviction');
          },
          onJobSettled: s => {
            teardownSettlements.push(s);
          },
        }),
      (err: unknown) => err instanceof RunnerTeardownError && isRunnerTeardownError(err),
    );
    assert.equal(preemptCalls, 0, 'confirmed :preempt MUST NOT be sent when teardown fails');
    assert.equal(teardownSettlements[0]?.outcome, 'unknown');
    assert.equal(teardownSettlements[0]?.acknowledgment, 'local_only');

    // 6b. Real Docker stage runner where `docker rm -f` fails during SIGTERM preemption propagates RunnerTeardownError and withholds :preempt!
    scenario = 'preempt_docker_rm_fail';
    preemptCalls = 0;
    const mockDockerDir = join(root, 'mock-docker-fail');
    await mkdir(mockDockerDir, { recursive: true, mode: 0o755 });
    const mockDockerScript = join(mockDockerDir, 'docker');
    await writeFile(
      mockDockerScript,
      [
        '#!/bin/sh',
        'if [ "$1" = "rm" ]; then',
        '  echo "docker daemon unreachable during rm -f" >&2',
        '  exit 1',
        'fi',
        'sleep 10',
      ].join('\n'),
      { mode: 0o555 },
    );
    await chmod(mockDockerScript, 0o555);
    await chmod(mockDockerDir, 0o555);
    const dockerFailPreempt = new AbortController();
    const { evaluateBenchmarkJob: realEval } = await import('../src/index.js');
    try {
      await assert.rejects(
        () =>
          runHardwareWorker({
            config: {
              ...baseCfg,
              sandboxBackend: 'docker',
              dockerImage: 'nvidia/cuda:12.6.0-base',
              probeMode: 'synthetic_fixture',
            },
            once: true,
            enableSseEvents: false,
            preemptSignal: dockerFailPreempt.signal,
            registerProcessSignalHandlers: false,
            evaluator: opts => {
              setTimeout(() => dockerFailPreempt.abort(), 40);
              return realEval({
                ...opts,
                stageACommand: { command: '/bin/sleep', args: ['10'] },
                _testOnlyTrustedDockerRoot: mockDockerDir,
                host: {
                  platform: 'linux',
                  arch: 'x64',
                  dockerExecutable: mockDockerScript,
                  probeExecutables: false,
                },
              });
            },
          }),
        (err: unknown) => err instanceof RunnerTeardownError && isRunnerTeardownError(err),
      );
      assert.equal(preemptCalls, 0, ':preempt MUST NOT be sent when docker rm -f fails');
    } finally {
      await chmod(mockDockerDir, 0o700).catch(() => {});
    }

    // 7. Graceful shutdown (SIGINT / caller stopSignal) during active evaluation reports outcome='cancelled' (NEVER 'fenced' or 'once_completed')!
    scenario = 'shutdown_during_eval';
    const sigintCtrl = new AbortController();
    const shutdownRes = await runHardwareWorker({
      config: baseCfg,
      once: true,
      enableSseEvents: false,
      signal: sigintCtrl.signal,
      registerProcessSignalHandlers: false,
      evaluator: async ({ signal }) => {
        setTimeout(() => sigintCtrl.abort(), 15);
        await new Promise<void>(r => signal?.addEventListener('abort', () => r(), { once: true }));
        throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'aborted by caller shutdown');
      },
    });
    assert.equal(shutdownRes.exitReason, 'aborted');
    assert.equal(shutdownRes.lastSettlement?.outcome, 'cancelled');
    assert.equal(shutdownRes.lastSettlement?.acknowledgment, 'local_only');
  } finally {
    srv.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('setup failure after mkdir(jobRoot) enters rollback immediately and propagates RunnerTeardownError on SIGTERM, ECONNREFUSED on :complete avoids post-send unknown settlement, and pre-spawn clock expiry fences without spawning', async () => {
  const realRootTmp = await realpath(tmpdir());
  const root = await mkdtemp(join(realRootTmp, 'lw-worker-fix3-'));
  const workDir = join(root, 'work');
  const workloadsDir = join(root, 'workloads');
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  await mkdir(join(workloadsDir, 'gemm-4096'), { recursive: true, mode: 0o700 });
  await writeFile(
    join(workloadsDir, 'gemm-4096', 'evaluate.sh'),
    'printf \'{"status":"approved"}\\n\'\n',
    { mode: 0o644 },
  );

  const hex = 'e'.repeat(64);
  const makeGrantJson = (entries: readonly unknown[] = []) =>
    JSON.stringify({
      relayBootId: 'boot-fix3',
      jobId: 'job-fix3-1',
      operationId: 'op-fix3-1',
      leaseEpoch: 1,
      leaseToken: 'tok-fix3-0123456789',
      leaseTtlMs: 5_000,
      job: {
        operationId: 'op-fix3-1',
        gateId: 'g1',
        checkId: 'c1',
        candidateDigest: hex,
        subject: {
          lockHash: { algorithm: 'sha256', hex },
          contractHash: { algorithm: 'sha256', hex },
          repository: 'org/repo',
          baseRevision: '1'.repeat(40),
          sourceRevision: '1'.repeat(40),
          candidateDigest: { algorithm: 'sha256', hex },
          targetMatrixDigest: null,
        },
        targetCellId: 'cuda-sm90',
        targetHardware: { accelerator: 'sm_90a', isolationMode: 'whole_device', deviceCount: 1 },
        heldOutWorkloadId: 'gemm-4096',
        metricThresholds: [],
        maxPreemptions: 2,
        preemptionCount: 0,
        candidateArtifacts: { entries, deleted: [] },
      },
    });

  let preemptCalls = 0;
  let completeCalls = 0;
  let closeBeforeComplete = false;
  let resetAfterCompleteConnect = false;
  let stageAScriptBytes: Buffer | null = null;

  const srv = createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'POST' && url === '/v1/runner/leases:acquire') {
      const entries = stageAScriptBytes !== null
        ? [{ name: 'build.sh', digest: { algorithm: 'sha256', hex: sha256Hex(stageAScriptBytes) }, byteLength: stageAScriptBytes.byteLength, mode: '100755' }]
        : [];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(makeGrantJson(entries));
      return;
    }
    if (req.method === 'GET' && url.includes('/blobs/') && stageAScriptBytes !== null) {
      res.writeHead(200, {
        'x-loopwright-blob-sha256': sha256Hex(stageAScriptBytes),
        'x-loopwright-blob-length': String(stageAScriptBytes.byteLength),
      });
      res.end(stageAScriptBytes);
      return;
    }
    if (req.method === 'POST' && url.endsWith(':heartbeat')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"desiredState":"running","leaseTtlMs":5000}');
      return;
    }
    if (req.method === 'POST' && url.endsWith(':preempt')) {
      preemptCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"requeued","preemptionCount":1}');
      return;
    }
    if (req.method === 'POST' && url.endsWith(':complete')) {
      completeCalls += 1;
      if (resetAfterCompleteConnect) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true,"operationId":"op-fix3-1","status":"approved"}');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  const baseCfg = makeWorkerConfig(`http://127.0.0.1:${port}`, workDir, workloadsDir, {
    pollWaitMs: 0,
    heartbeatIntervalMs: 500,
  });

  try {
    // 1a. Early setup failure right after mkdir(jobRoot) (normal writable workDir) rolls back jobRoot cleanly!
    const setupFailPreemptClean = new AbortController();
    const resCleanRollback = await runHardwareWorker({
      config: baseCfg,
      once: true,
      enableSseEvents: false,
      preemptSignal: setupFailPreemptClean.signal,
      registerProcessSignalHandlers: false,
      probe: async () => {
        // jobRoot & subdirectories already exist here; simulate ENOSPC + SIGTERM arriving together
        setupFailPreemptClean.abort();
        const enospc = Object.assign(new Error('ENOSPC: no space left on device, mkdir'), { code: 'ENOSPC' });
        throw enospc;
      },
    });
    assert.equal(resCleanRollback.exitReason, 'preempted');
    assert.deepEqual(await readdir(workDir), [], 'jobRoot must be rolled back on early setup failure');

    // 1b. Early setup failure after mkdir(jobRoot) + rollback failure (workDir locked 0o500 so rmdir(jobRoot) fails)
    //     while SIGTERM arrived MUST propagate RunnerTeardownError and WITHHOLD :preempt!
    preemptCalls = 0;
    const setupRollbackWorkDir = join(root, 'work-rollback-fail');
    await mkdir(setupRollbackWorkDir, { recursive: true, mode: 0o700 });
    const setupFailPreemptLocked = new AbortController();
    const rollbackFailSettlements: WorkerJobSettlementSummary[] = [];
    try {
      await assert.rejects(
        () =>
          runHardwareWorker({
            config: { ...baseCfg, workDir: setupRollbackWorkDir },
            once: true,
            enableSseEvents: false,
            preemptSignal: setupFailPreemptLocked.signal,
            registerProcessSignalHandlers: false,
            probe: async () => {
              // Lock parent workDir so removeTreeFailClosed(jobRoot) fails on rmdir(jobRoot), AND fire SIGTERM!
              await chmod(setupRollbackWorkDir, 0o500);
              setupFailPreemptLocked.abort();
              throw Object.assign(new Error('ENOSPC: setup failure after jobRoot creation'), { code: 'ENOSPC' });
            },
            onJobSettled: s => {
              rollbackFailSettlements.push(s);
            },
          }),
        (err: unknown) => err instanceof RunnerTeardownError && isRunnerTeardownError(err),
      );
      assert.equal(preemptCalls, 0, ':preempt MUST NOT be sent when setup rollback fails during SIGTERM!');
      assert.equal(rollbackFailSettlements[0]?.outcome, 'unknown');
      assert.equal(rollbackFailSettlements[0]?.acknowledgment, 'local_only');
    } finally {
      await chmod(setupRollbackWorkDir, 0o700).catch(() => {});
      await rm(setupRollbackWorkDir, { recursive: true, force: true });
    }

    // 2a. Post-connect TCP reset during :complete DOES publish outcome='unknown', acknowledgment='unknown'
    resetAfterCompleteConnect = true;
    const postConnectSettlements: WorkerJobSettlementSummary[] = [];
    await assert.rejects(
      () =>
        runHardwareWorker({
          config: baseCfg,
          once: true,
          enableSseEvents: false,
          registerProcessSignalHandlers: false,
          evaluator: async () => ({ status: 'approved', reason: null, sealedOutputs: [], cleanup: async () => {} }),
          onJobSettled: s => {
            postConnectSettlements.push(s);
          },
        }),
      (err: unknown) => err instanceof RunnerTransportError,
    );
    resetAfterCompleteConnect = false;
    assert.equal(postConnectSettlements.length, 1);
    assert.equal(postConnectSettlements[0]?.outcome, 'unknown');
    assert.equal(postConnectSettlements[0]?.acknowledgment, 'unknown');

    // 2b. Pre-connect ECONNREFUSED on :complete (Relay closed before TCP connect opens)
    //     MUST NOT falsely publish post-send outcome='unknown' (requestSent === false)!
    const ephemeralSrv = createServer((req, res) => {
      if (req.url === '/v1/runner/leases:acquire') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(makeGrantJson([]));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>(r => ephemeralSrv.listen(0, '127.0.0.1', () => r()));
    const ephPort = (ephemeralSrv.address() as { port: number }).port;
    closeBeforeComplete = true;
    const connRefusedSettlements: WorkerJobSettlementSummary[] = [];
    await assert.rejects(
      () =>
        runHardwareWorker({
          config: { ...baseCfg, relayUrl: `http://127.0.0.1:${ephPort}` },
          once: true,
          enableSseEvents: false,
          registerProcessSignalHandlers: false,
          evaluator: async () => {
            if (closeBeforeComplete) {
              await new Promise<void>(r => ephemeralSrv.close(() => r()));
            }
            return { status: 'approved', reason: null, sealedOutputs: [], cleanup: async () => {} };
          },
          onJobSettled: s => {
            connRefusedSettlements.push(s);
          },
        }),
      (err: unknown) => err instanceof RunnerTransportError,
    );
    assert.deepEqual(
      connRefusedSettlements,
      [],
      'pre-connect ECONNREFUSED on :complete must NOT publish post-send unknown settlement',
    );

    // 3. Worker monotonic clock crossing localLeaseDeadlineMono during Stage A preparation inside real evaluateBenchmarkJob
    //    settles outcome='fenced', acknowledgment='fenced' without ever spawning Stage A or calling :complete!
    const largeTc = join(root, 'worker-tc');
    await mkdir(largeTc, { recursive: true, mode: 0o755 });
    for (let i = 0; i < 300; i += 1) {
      await writeFile(join(largeTc, `f-${String(i)}.txt`), '1', { mode: 0o644 });
    }
    const neverRunMarker = join(root, 'worker-stage-a-ran.txt');
    stageAScriptBytes = Buffer.from(
      `#!${process.execPath}\nrequire("node:fs").writeFileSync(process.env.LOOPWRIGHT_STAGE_A_OUT + "/ran", "1");\n`,
      'utf8',
    );
    completeCalls = 0;
    let workerClock = 1_000;
    let clockReads = 0;
    const fencedBeforeSpawnRes = await runHardwareWorker({
      config: { ...baseCfg, toolchainPaths: [largeTc, join(process.execPath, '..')] },
      once: true,
      enableSseEvents: false,
      registerProcessSignalHandlers: false,
      clock: {
        nowMonotonicMs: () => {
          clockReads += 1;
          // Advance past 5_000ms lease deadline during synchronous toolchain scan before spawn!
          if (clockReads >= 14) {
            workerClock = 10_000;
          }
          return workerClock;
        },
      },
    });
    assert.equal(fencedBeforeSpawnRes.lastSettlement?.outcome, 'fenced');
    assert.equal(fencedBeforeSpawnRes.lastSettlement?.acknowledgment, 'fenced');
    assert.equal(completeCalls, 0);
    await assert.rejects(() => lstat(neverRunMarker), { code: 'ENOENT' });
  } finally {
    srv.close();
    await rm(root, { recursive: true, force: true });
  }
});
