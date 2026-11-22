import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chmod, link, mkdir, open as fsOpen, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reopenLocalRun } from '@loopwright/state';
import { bindSubject, validateDocument, type HardwareProvenance } from '@loopwright/core';
import { configurationFixture } from './config-fixtures.js';
import { setFixture } from './progress-fixtures.js';
import { installedHandlerDigests } from '../src/handlers.js';
import { createCycle, Cycle } from '../src/controller.js';
import { resumeCycleWithPorts } from '../src/recovery.js';
import { reconcileCycle } from '../src/reconcile.js';
import { readRetained } from '../src/retained.js';
import { stepNext, stepSubmit, type StepTickResult } from '../src/step.js';
import { signPayload, verifySignedPayload } from '../src/gate.js';
import {
  expectedBenchmarkRequest,
  prepareBenchmarkGate,
  signBenchmarkVerdict,
  type BenchmarkOutputArtifact,
} from '../src/benchmark-gate.js';
import { canonical, hash } from '../src/schema.js';
import { stateValue } from '../src/storage.js';
import type { CredentialBinding, StepYield } from '../src/types.js';

const BENCH_SECRET = 'BENCH_RECONCILE_HMAC_CANARY_Aa11Bb22Cc33';
const PUB_SECRET = 'BENCH_PUB_HMAC_CANARY_Dd44Ee55Ff66';
const WORKLOAD_DIGEST = { algorithm: 'sha256' as const, hex: '5'.repeat(64) };

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function makeProvenance(): HardwareProvenance {
  return {
    targetCellId: 'cuda-sm90',
    probeKind: 'physical',
    vendor: 'NVIDIA',
    deviceModel: 'NVIDIA H100 80GB HBM3',
    accelerator: 'sm_90a',
    isolationMode: 'whole_device',
    deviceCount: 1,
    driverVersion: '550.90.07',
    runtimeVersion: 'CUDA 12.6',
    workloadDigest: WORKLOAD_DIGEST,
    clockLockMode: 'locked',
  };
}

async function startCasRelayServer(
  blobs: Map<string, Buffer>,
  options?: { readonly getDelayMs?: number; readonly outputArtifacts?: readonly BenchmarkOutputArtifact[] },
) {
  let postHits = 0;
  let putHits = 0;
  const getHitsBySha = new Map<string, number>();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const blobMatch = /^\/v1\/benchmark\/jobs\/([^/]+)\/blobs\/([0-9a-f]{64})$/.exec(url.pathname);

      if (req.method === 'PUT' && blobMatch) {
        for await (const chunk of req) {
          void chunk;
        }
        putHits++;
        res.writeHead(201).end();
        return;
      }

      if (req.method === 'GET' && blobMatch) {
        const operationId = decodeURIComponent(blobMatch[1]!);
        const sha = blobMatch[2]!;
        const sig = req.headers['x-loopwright-signature'];
        if (typeof sig !== 'string' || !verifySignedPayload(BENCH_SECRET, `GET\n${operationId}\n${sha}`, sig)) {
          res.writeHead(403).end();
          return;
        }
        getHitsBySha.set(sha, (getHitsBySha.get(sha) ?? 0) + 1);
        const bytes = blobs.get(sha);
        if (!bytes) {
          res.writeHead(404).end();
          return;
        }
        if (options?.getDelayMs && options.getDelayMs > 0) {
          await new Promise<void>(r => setTimeout(r, options.getDelayMs));
        }
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'x-loopwright-blob-sha256': sha,
          'x-loopwright-blob-length': String(bytes.byteLength),
          'x-loopwright-signature': signPayload(BENCH_SECRET, `BLOB\n${operationId}\n${sha}\n${String(bytes.byteLength)}`),
        });
        res.end(bytes);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/benchmark/jobs') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks);
        const sig = req.headers['x-loopwright-signature'];
        if (typeof sig !== 'string' || !verifySignedPayload(BENCH_SECRET, body, sig)) {
          res.writeHead(403).end();
          return;
        }
        postHits++;
        const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
        const verdict = {
          version: 1,
          kind: 'benchmark_verdict',
          storeId: parsed.storeId,
          runId: parsed.runId,
          lockHash: parsed.lockHash,
          operationId: parsed.operationId,
          dispatchId: parsed.dispatchId,
          dispatchGeneration: parsed.dispatchGeneration,
          gateId: parsed.gateId,
          checkId: parsed.checkId,
          candidateDigest: parsed.candidateDigest,
          status: 'approved',
          reason: null,
          expiresAtMs: String(Date.now() + 600_000),
          preemptionCount: 0,
          hardwareProvenance: makeProvenance(),
          metrics: { latency_us: 44.0 },
          ...(options?.outputArtifacts ? { outputArtifacts: options.outputArtifacts } : {}),
        };
        const respBytes = Buffer.from(JSON.stringify(verdict), 'utf8');
        res.writeHead(200, {
          'content-type': 'application/json',
          connection: 'close',
          'x-loopwright-signature': signPayload(BENCH_SECRET, respBytes),
        });
        res.end(respBytes);
        return;
      }

      res.writeHead(404).end();
    })();
  });

  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/v1/benchmark/jobs`,
    postHits: () => postHits,
    putHits: () => putHits,
    getHits: (sha: string) => getHitsBySha.get(sha) ?? 0,
    close: () =>
      new Promise<void>((done, fail) => {
        server.closeAllConnections();
        server.close(err => (err ? fail(err) : done()));
      }),
  };
}

async function benchmarkReconcileFixture(relayUrl: string, publicationUrl?: string) {
  const f = await configurationFixture();
  const installed = await installedHandlerDigests();
  f.environment.BENCH_SECRET = BENCH_SECRET;
  const creds: Record<string, unknown>[] = [{ ref: 'bench-signer', template: '${BENCH_SECRET}' }];
  const credBindings: CredentialBinding[] = [
    ...f.registry.spec.credentialBindings,
    { id: 'bench-signer', consumer: 'gate', destinationRef: 'bench-relay', environmentNames: ['BENCH_SECRET'], template: '${BENCH_SECRET}' },
  ];
  const envBindings: Record<string, unknown>[] = [
    { name: 'PROVIDER_TOKEN', classification: 'credential', paths: [] },
    { name: 'BENCH_SECRET', classification: 'credential', paths: ['/spec/credentials/0/template'] },
  ];

  if (publicationUrl) {
    f.environment.PUB_SECRET = PUB_SECRET;
    credBindings.push({ id: 'pub-signer', consumer: 'publisher', destinationRef: 'pub-svc', environmentNames: ['PUB_SECRET'], template: '${PUB_SECRET}' });
    creds.push({ ref: 'pub-signer', template: '${PUB_SECRET}' });
    envBindings.push({ name: 'PUB_SECRET', classification: 'credential', paths: ['/spec/credentials/1/template'] });
    setFixture(f.registry, ['spec', 'publicationEndpoints'], [
      { id: 'pr-pub', url: publicationUrl, signingCredentialRef: 'pub-signer', authCredentialRef: null, timeoutMs: 1500 },
    ]);
    setFixture(f.config, ['spec', 'publication'], {
      mode: 'pull_request',
      endpointRef: 'pr-pub',
      targetBranch: 'main',
      headBranchPrefix: 'loopwright/',
      titleTemplate: 'Benchmark reconcile PR',
    });
  }

  setFixture(f.registry, ['spec', 'credentialBindings'], credBindings);
  setFixture(f.registry, ['spec', 'environmentBindings'], envBindings);
  setFixture(f.config, ['spec', 'credentials'], creds);
  setFixture(f.registry, ['spec', 'gateEndpoints'], [
    {
      id: 'gpu-relay',
      url: relayUrl,
      signingCredentialRef: 'bench-signer',
      authCredentialRef: null,
      timeoutMs: 2000,
      maxPollMs: 15_000,
      pollInitialMs: 100,
      pollMaxMs: 200,
      jitter: 0,
    },
  ]);
  setFixture(f.registry, ['spec', 'handlers'], [
    f.registry.spec.handlers[0]!,
    {
      id: 'kernel-bench',
      kind: 'check',
      implementation: 'benchmark-gate.v1',
      version: 1,
      digest: installed['benchmark-gate.v1'],
      parameters: { checkId: 'kernel-bench', endpointRef: 'gpu-relay', gateId: 'sm90-gemm-gate', heldOutWorkloadId: 'gemm-fp16-4096' },
      capabilities: ['hardware_execution', 'read_only'],
    },
    f.registry.spec.handlers[2]!,
    f.registry.spec.handlers[3]!,
  ]);
  setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
    { id: 'bench-step', kind: 'check', uses: 'kernel-bench', roleId: null, dependsOn: [] },
  ]);
  setFixture(f.config, ['spec', 'profiles', 'steps'], [{ stepId: 'bench-step', handlerRef: 'kernel-bench' }]);
  setFixture(f.config, ['spec', 'task', 'spec', 'target', 'matrix'], [
    { id: 'cuda-sm90', platform: 'linux-x64', variant: 'sm90', hardware: { accelerator: 'sm_90a', isolationMode: 'whole_device' } },
  ]);
  setFixture(f.config, ['spec', 'task', 'spec', 'acceptance'], {
    required: ['kernel-bench'],
    checks: [
      {
        id: 'kernel-bench',
        allowedEvidenceLevels: ['hardware_execution'],
        targetCellId: 'cuda-sm90',
        metricThresholds: [{ kind: 'bounds', metric: 'latency_us', max: 100 }],
      },
    ],
  });

  const repository = join(f.root, 'repository');
  const runRoot = join(f.root, 'runs');
  await mkdir(repository, { mode: 0o700 });
  const git = (args: string[]) =>
    execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: repository,
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        HOME: '/nonexistent',
        GIT_TERMINAL_PROMPT: '0',
      },
      timeout: 5000,
      encoding: 'utf8',
    });
  git(['init', '-q']);
  await writeFile(join(repository, 'kernel.cu'), '__global__ void gemm() {}\n', { mode: 0o600 });
  git(['add', 'kernel.cu']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost.invalid', 'commit', '-qm', 'init']);
  const revision = git(['rev-parse', 'HEAD']).trim();
  setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], revision);
  setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], revision);
  await f.save();
  const loaded = await f.load();
  assert.equal(loaded.ok, true);
  if (!loaded.ok) throw new Error('fixture load failed');
  return { ...f, repository, runRoot, loaded: loaded.value };
}

async function injectBenchmarkCrash(
  f: Awaited<ReturnType<typeof benchmarkReconcileFixture>>,
  runId: string,
  stage: 'pre_put_intent' | 'post_dispatch_before_binding' | 'mid_cas_pull' | 'after_proof_before_receipt',
  casSetup?: { readonly localBlob?: { readonly name: string; readonly bytes: Buffer } },
) {
  const context = await createCycle({ configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId }, {});
  const manifestRef = await context.artifacts.json('manifest', context.source.manifest, 32_768);
  const bound = bindSubject(context.lock, context.source.manifest);
  assert.equal(bound.ok, true);
  if (!bound.ok) throw new Error('bindSubject failed');

  await context.progress.publish(
    {
      version: 2,
      runId: context.lock.spec.runId,
      lockHash: context.lock.spec.lockHash,
      stage: { kind: 'bootstrap', phase: 'bootstrap', capacity: context.plan.capacity },
      nodes: context.plan.orderedDAG.map(node => ({ id: node.id, state: 'pending' })),
      attempts: [],
      nativeCheckpoints: [],
      submission: null,
      publication: { status: 'idle', operationId: null, receipt: null },
      candidate: { manifest: manifestRef, digest: bound.value.candidateDigest, generation: 0, workspace: context.source.workspace, privateSession: null },
      failures: [],
      verifierReceipts: [],
      verifierRefusals: [],
      eventSequence: 0,
      terminalIntent: null,
    },
    'bootstrap',
  );

  const slot = context.plan.verifierSlots.find(item => item.handler.implementation === 'benchmark-gate.v1')!;
  const nonce = randomBytes(16).toString('hex');
  const candidate = { manifest: context.source.manifest, ref: manifestRef, files: context.source.artifacts };
  const job = prepareBenchmarkGate(context.plan, context.lock, slot.id, candidate, 0, nonce, f.loaded.registry.spec.gateEndpoints);
  const head = await context.progress.read();
  assert.ok(head);
  if (!head) throw new Error('head missing');
  const ordinal = context.plan.verifierSlots.findIndex(item => item.id === slot.id);

  await context.progress.publish(
    {
      ...head.progress,
      stage: { ...head.progress.stage, kind: 'verifier_pre' },
      verifierReceipts: [{ slot: slot.id, generation: 0, operationId: job.operationId, producerNonce: nonce, output: null, receipt: null }],
    },
    `verify.0.${ordinal}.pre`,
  );

  if (stage === 'pre_put_intent') {
    stateValue(context.store.release(context.authority));
    stateValue(context.store.close());
    await context.owner.release();
    return { runId, operationId: job.operationId, slotId: slot.id, candidateDigest: bound.value.candidateDigest.hex, dispatchId: '', dispatchGeneration: 0, storeId: '' };
  }

  if (stage === 'after_proof_before_receipt') {
    const cycle = new Cycle(context, await context.progress.read(), candidate);
    const origRecord = context.store.recordOperationReceipt.bind(context.store);
    (context.store as unknown as Record<string, unknown>).recordOperationReceipt = () => {
      throw new Error('SIMULATED_CRASH_BEFORE_RECORD_RECEIPT');
    };
    try {
      await cycle.benchmarkGate.run(job, new AbortController().signal);
    } catch {
      // Expected simulated crash right after .proof.json write.
    }
    (context.store as unknown as Record<string, unknown>).recordOperationReceipt = origRecord;
    await cycle.deadline.dispose();
    const eventsRef = await cycle.events.close();
    const restoredEvents = await fsOpen(
      join(context.artifacts.directory, 'controller-events.open'),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await restoredEvents.writeFile(await readFile(join(context.artifacts.directory, eventsRef.name)));
      await restoredEvents.sync();
    } finally {
      await restoredEvents.close();
    }
    const op = stateValue(context.store.getOperation(job.operationId));
    const storeId = stateValue(context.store.inspect()).storeId;
    stateValue(context.store.release(context.authority));
    stateValue(context.store.close());
    await context.owner.release();
    return {
      runId,
      storeId,
      lockHash: context.lock.spec.lockHash,
      operationId: job.operationId,
      slotId: slot.id,
      dispatchId: op.dispatch!.dispatchId,
      dispatchGeneration: op.dispatch!.generation,
      candidateDigest: bound.value.candidateDigest.hex,
    };
  }

  stateValue(
    context.store.putIntent(context.authority, {
      operationId: job.operationId,
      nodeId: context.plan.orderedDAG[0]!.id,
      attemptId: 'job.' + hash(job.operationId + '\0' + nonce).hex.slice(0, 40),
      effect: 'read_only',
      requestDigest: job.requestDigest,
      targetIdentity: `benchmark:${slot.id}:0:${bound.value.candidateDigest.hex}`,
    }),
  );
  const dispatched = stateValue(context.store.authorizeOperationDispatch(context.authority, job.operationId));
  if (dispatched.kind !== 'new_dispatch') throw new Error('expected new_dispatch');
  const op = stateValue(context.store.getOperation(job.operationId));
  const storeId = stateValue(context.store.inspect()).storeId;

  if (stage !== 'post_dispatch_before_binding') {
    const endpoint = f.loaded.registry.spec.gateEndpoints[0]!;
    const req: Record<string, unknown> = {
      ...expectedBenchmarkRequest(context.plan, slot, endpoint, bound.value, context.source.manifest),
      storeId,
      runId,
      lockHash: context.lock.spec.lockHash,
      operationId: job.operationId,
      dispatchId: dispatched.permit.dispatchId,
      dispatchGeneration: dispatched.permit.generation,
      requestDigest: job.requestDigest.hex,
    };
    const prefix = join(context.artifacts.directory, 'benchmark-producer-' + hash(job.operationId + '\0' + nonce).hex);
    await writeFile(
      prefix + '.binding.json',
      canonical({
        version: 1,
        planDigest: context.plan.planDigest,
        operationId: job.operationId,
        producerNonce: nonce,
        requestDigest: job.requestDigest,
        requestBytesDigest: hash(Buffer.from(canonical(req))).hex,
        intentDigest: op.intentDigest,
        subject: bound.value,
        generation: 0,
        endpoint: endpoint.id,
        dispatchReceipt: {
          generation: dispatched.permit.generation,
          dispatchId: dispatched.permit.dispatchId,
          revision: dispatched.permit.authorizedRevision,
          clockEpoch: dispatched.permit.clockEpoch,
        },
      }),
      { mode: 0o600 },
    );

    if (stage === 'mid_cas_pull') {
      if (casSetup?.localBlob) {
        await context.artifacts.putCasBlobFromBytes(
          `.loopwright-verifier/${slot.id}/${casSetup.localBlob.name}`,
          casSetup.localBlob.bytes,
        );
      }
      const shaDir = join(context.artifacts.directory, 'blobs', 'sha256');
      await mkdir(shaDir, { recursive: true, mode: 0o700 });
      await writeFile(join(shaDir, '.tmp-interrupted-cas-pull'), Buffer.from('partial-cubin-stream'), { mode: 0o600 });
    }
  }

  stateValue(context.store.release(context.authority));
  stateValue(context.store.close());
  await context.owner.release();
  return {
    runId,
    storeId,
    lockHash: context.lock.spec.lockHash,
    operationId: job.operationId,
    slotId: slot.id,
    dispatchId: dispatched.permit.dispatchId,
    dispatchGeneration: dispatched.permit.generation,
    candidateDigest: bound.value.candidateDigest.hex,
  };
}

test('crash before binding: pre-putIntent resumes once cleanly while post-dispatch missing binding fails closed with zero replacement POSTs', async () => {
  const relay = await startCasRelayServer(new Map());
  const f = await benchmarkReconcileFixture(relay.url);
  try {
    // 1a. Crash after verify.0.0.pre BEFORE putIntent -> zero prior dispatch, resumes cleanly with 1 POST
    await injectBenchmarkCrash(f, 'run-crash-pre-intent', 'pre_put_intent');
    const preResumed = await resumeCycleWithPorts({
      configuration: f.loaded,
      repository: f.repository,
      runRoot: f.runRoot,
      runId: 'run-crash-pre-intent',
    });
    assert.equal(preResumed.ok, true);
    if (preResumed.ok && preResumed.value.kind === 'result') {
      assert.equal(preResumed.value.result.spec.status, 'completed');
    }
    assert.equal(relay.postHits(), 1);

    // 1b. Crash after authorizeOperationDispatch BEFORE .binding.json -> fails closed with RECOVERY_REQUIRED and ZERO replacement POSTs
    const postsBefore = relay.postHits();
    await injectBenchmarkCrash(f, 'run-crash-before-binding', 'post_dispatch_before_binding');
    const missingBindingRes = await resumeCycleWithPorts({
      configuration: f.loaded,
      repository: f.repository,
      runRoot: f.runRoot,
      runId: 'run-crash-before-binding',
    });
    assert.equal(missingBindingRes.ok, false);
    if (!missingBindingRes.ok) {
      assert.equal(missingBindingRes.error.code, 'RECOVERY_REQUIRED');
    }
    assert.equal(relay.postHits(), postsBefore, 'must send zero replacement POSTs');
  } finally {
    await f.cleanup();
    await relay.close();
  }
});

test('crash during CAS pull: reconcile settles signed benchmark_verdict reusing local CAS + pulling missing blob (rejecting secrets), while resume settles GATE_TIMEOUT and rejects late receipts', async () => {
  const localCubin = Buffer.from('sealed-local-stage-a-cubin');
  const localSha = sha256Hex(localCubin);
  const remoteSass = Buffer.from('MOV R1, R2; EXIT;');
  const remoteSha = sha256Hex(remoteSass);
  const secretBlob = Buffer.from(`poisoned-${BENCH_SECRET}-tail`);
  const secretSha = sha256Hex(secretBlob);

  const blobStore = new Map([
    [localSha, localCubin],
    [remoteSha, remoteSass],
    [secretSha, secretBlob],
  ]);
  const relay = await startCasRelayServer(blobStore);
  const f = await benchmarkReconcileFixture(relay.url);

  try {
    const buildReceipt = async (
      crash: Awaited<ReturnType<typeof injectBenchmarkCrash>>,
      filename: string,
      outputs: readonly BenchmarkOutputArtifact[],
      status: 'approved' | 'denied' = 'approved',
      extra: Record<string, unknown> = {},
    ) => {
      const body: Record<string, unknown> = {
        version: 1,
        kind: 'benchmark_verdict',
        storeId: crash.storeId,
        runId: crash.runId,
        lockHash: crash.lockHash,
        operationId: crash.operationId,
        dispatchId: crash.dispatchId,
        dispatchGeneration: crash.dispatchGeneration,
        gateId: 'sm90-gemm-gate',
        checkId: 'kernel-bench',
        candidateDigest: crash.candidateDigest,
        status,
        reason: status === 'denied' ? 'threshold_miss' : null,
        expiresAtMs: String(Date.now() + 600_000),
        preemptionCount: 1,
        hardwareProvenance: makeProvenance(),
        metrics: { latency_us: 41.5 },
        outputArtifacts: outputs,
        ...extra,
      };
      const rPath = join(tmpdir(), `lw-bench-rec-${filename}-${process.pid}.json`);
      await writeFile(rPath, JSON.stringify({ ...body, signature: signBenchmarkVerdict(BENCH_SECRET, body) }), { mode: 0o600 });
      return rPath;
    };

    // P5a: Poisoned CAS output in signed receipt settles status: 'blocked' (ARTIFACT_INVALID), retains receipt identity, and rejects replacement!
    const crashPoison = await injectBenchmarkCrash(f, 'run-crash-poisoned-cas-settles-blocked', 'mid_cas_pull');
    const poisonedPath = await buildReceipt(crashPoison, 'poisoned', [
      { name: 'out/poison.cubin', digest: { algorithm: 'sha256', hex: secretSha }, byteLength: secretBlob.byteLength },
    ]);
    const poisonedRec = await reconcileCycle({
      configuration: f.loaded,
      runRoot: f.runRoot,
      runId: crashPoison.runId,
      receipt: poisonedPath,
    });
    assert.equal(poisonedRec.ok, true, poisonedRec.ok ? '' : JSON.stringify(poisonedRec.error));
    if (poisonedRec.ok && poisonedRec.value.kind === 'settled') {
      assert.equal(poisonedRec.value.status, 'blocked');
      assert.equal(poisonedRec.value.outcome, 'succeeded');
    }
    const poisonReplay = await reconcileCycle({
      configuration: f.loaded,
      runRoot: f.runRoot,
      runId: crashPoison.runId,
      receipt: poisonedPath,
    });
    assert.equal(poisonReplay.ok && poisonReplay.value.kind === 'settled' && poisonReplay.value.status === 'blocked', true);

    const poisonReplacePath = await buildReceipt(crashPoison, 'poison-replace', []);
    const poisonReplace = await reconcileCycle({
      configuration: f.loaded,
      runRoot: f.runRoot,
      runId: crashPoison.runId,
      receipt: poisonReplacePath,
    });
    assert.equal(!poisonReplace.ok && poisonReplace.error.code === 'RECEIPT_CONFLICT', true, 'replacement after blocked poisoned CAS must refuse RECEIPT_CONFLICT');
    await rm(poisonedPath, { force: true });
    await rm(poisonReplacePath, { force: true });

    // P5b: Transient CAS transport failure (404 missing blob) locks receipt commitment, rejects conflicting verdict, and succeeds on retry!
    const transientBytes = Buffer.from('transient-stage-a-sass');
    const transientSha = sha256Hex(transientBytes);
    const crashTransient = await injectBenchmarkCrash(f, 'run-crash-transient-cas-reconcile', 'mid_cas_pull', {
      localBlob: { name: 'out/local.cubin', bytes: localCubin },
    });
    const transientGoodPath = await buildReceipt(crashTransient, 'transient-good', [
      { name: 'out/local.cubin', digest: { algorithm: 'sha256', hex: localSha }, byteLength: localCubin.byteLength },
      { name: 'out/transient.sass', digest: { algorithm: 'sha256', hex: transientSha }, byteLength: transientBytes.byteLength },
    ]);
    const transientAttempt1 = await reconcileCycle({
      configuration: f.loaded,
      runRoot: f.runRoot,
      runId: crashTransient.runId,
      receipt: transientGoodPath,
    });
    assert.equal(transientAttempt1.ok, false);
    if (!transientAttempt1.ok) assert.equal(transientAttempt1.error.code, 'EVIDENCE_UNAVAILABLE');

    const transientDiffPath = await buildReceipt(crashTransient, 'transient-diff', [], 'denied');
    const transientDiffRec = await reconcileCycle({
      configuration: f.loaded,
      runRoot: f.runRoot,
      runId: crashTransient.runId,
      receipt: transientDiffPath,
    });
    assert.equal(!transientDiffRec.ok && transientDiffRec.error.code === 'RECEIPT_CONFLICT', true, 'different verdict after transient CAS pull must refuse RECEIPT_CONFLICT');

    // Restore blob on Relay and retry exact same signed receipt -> settles completed reusing localCubin (0 GETs)!
    blobStore.set(transientSha, transientBytes);
    const settled = await reconcileCycle({
      configuration: f.loaded,
      runRoot: f.runRoot,
      runId: crashTransient.runId,
      receipt: transientGoodPath,
    });
    assert.equal(settled.ok, true, settled.ok ? '' : JSON.stringify(settled.error));
    if (settled.ok && settled.value.kind === 'settled') {
      assert.equal(settled.value.status, 'completed');
      assert.equal(settled.value.outcome, 'succeeded');
    }
    assert.equal(relay.postHits(), 0, 'reconcile must send zero replacement POSTs');
    assert.equal(relay.getHits(localSha), 0, 'already-verified local CAS blob must be reused without HTTP GET');
    assert.equal(relay.getHits(transientSha), 2, 'missing CAS blob tried once on 404 then pulled once after recovery');

    const shaDir = join(f.runRoot, crashTransient.runId, 'artifacts', 'blobs', 'sha256');
    const casEntries = await readdir(shaDir);
    assert.equal(casEntries.some(e => e.startsWith('.tmp-')), false, 'temp files must be cleaned');
    assert.equal(casEntries.includes(secretSha), false, 'poisoned blob must never exist in CAS');

    // Idempotent replay succeeds even after expiresAtMs has elapsed (P8); conflicting denied receipt refuses RECEIPT_CONFLICT
    const replay = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId: crashTransient.runId, receipt: transientGoodPath });
    assert.equal(replay.ok && replay.value.kind === 'settled' && replay.value.status === 'completed', true);
    const conflict = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId: crashTransient.runId, receipt: transientDiffPath });
    assert.equal(!conflict.ok && conflict.error.code === 'RECEIPT_CONFLICT', true);
    await rm(transientGoodPath, { force: true });
    await rm(transientDiffPath, { force: true });

    // 2b. Crash before proof -> resumeCycle settles blocked GATE_TIMEOUT with zero replacement POSTs, then late receipt is rejected!
    const crash2 = await injectBenchmarkCrash(f, 'run-crash-timeout-then-late', 'mid_cas_pull');
    const resumedTimeout = await resumeCycleWithPorts({
      configuration: f.loaded,
      repository: f.repository,
      runRoot: f.runRoot,
      runId: crash2.runId,
    });
    assert.equal(resumedTimeout.ok, true);
    if (resumedTimeout.ok && resumedTimeout.value.kind === 'result') {
      assert.equal(resumedTimeout.value.result.spec.status, 'blocked');
      assert.equal(resumedTimeout.value.result.spec.verification.spec.required[0]!.detail, 'GATE_TIMEOUT');
    }
    assert.equal(relay.postHits(), 0, 'resumeCycle must send zero replacement POSTs');

    const lateBody: Record<string, unknown> = {
      version: 1,
      kind: 'benchmark_verdict',
      storeId: crash2.storeId,
      runId: crash2.runId,
      lockHash: crash2.lockHash,
      operationId: crash2.operationId,
      dispatchId: crash2.dispatchId,
      dispatchGeneration: crash2.dispatchGeneration,
      gateId: 'sm90-gemm-gate',
      checkId: 'kernel-bench',
      candidateDigest: crash2.candidateDigest,
      status: 'approved',
      reason: null,
      expiresAtMs: String(Date.now() + 600_000),
      preemptionCount: 0,
      hardwareProvenance: makeProvenance(),
      metrics: { latency_us: 40.0 },
    };
    const latePath = join(tmpdir(), `lw-bench-late-${process.pid}.json`);
    await writeFile(latePath, JSON.stringify({ ...lateBody, signature: signBenchmarkVerdict(BENCH_SECRET, lateBody) }), { mode: 0o600 });
    const lateRec = await reconcileCycle({
      configuration: f.loaded,
      runRoot: f.runRoot,
      runId: crash2.runId,
      receipt: latePath,
    });
    assert.equal(lateRec.ok, false);
    if (!lateRec.ok) {
      assert.equal(lateRec.error.code, 'RECOVERY_REQUIRED');
      assert.equal(lateRec.error.path, '/gate');
    }
    await rm(latePath, { force: true });
  } finally {
    await f.cleanup();
    await relay.close();
  }
});

test('crash after .proof.json recovers in both resume and reconcile orders with zero replacement POSTs, while uncertain external_write stays reconcile_required', async () => {
  for (const order of ['resume', 'reconcile'] as const) {
    const relay = await startCasRelayServer(new Map());
    const f = await benchmarkReconcileFixture(relay.url);
    try {
      const crash = await injectBenchmarkCrash(f, 'run-after-proof-' + order, 'after_proof_before_receipt');
      const postsAfterCrash = relay.postHits();
      assert.equal(postsAfterCrash, 1);

      const receiptBody: Record<string, unknown> = {
        version: 1,
        kind: 'benchmark_verdict',
        storeId: crash.storeId,
        runId: crash.runId,
        lockHash: crash.lockHash,
        operationId: crash.operationId,
        dispatchId: crash.dispatchId,
        dispatchGeneration: crash.dispatchGeneration,
        gateId: 'sm90-gemm-gate',
        checkId: 'kernel-bench',
        candidateDigest: crash.candidateDigest,
        status: 'approved',
        reason: null,
        expiresAtMs: '',
        preemptionCount: 0,
        hardwareProvenance: makeProvenance(),
        metrics: { latency_us: 44.0 },
      };
      // Read exact expiresAtMs from the retained benchmark-output artifact so receipt matches live verdict
      const artDir = join(f.runRoot, crash.runId, 'artifacts');
      const outName = (await readdir(artDir)).find(n => n.startsWith('benchmark-output-'))!;
      const savedOut = JSON.parse(await readFile(join(artDir, outName), 'utf8')) as { verdict: { expiresAtMs: string } };
      receiptBody.expiresAtMs = savedOut.verdict.expiresAtMs;
      const receiptPath = join(tmpdir(), `lw-after-proof-${order}-${process.pid}.json`);
      await writeFile(receiptPath, JSON.stringify({ ...receiptBody, signature: signBenchmarkVerdict(BENCH_SECRET, receiptBody) }), { mode: 0o600 });

      if (order === 'resume') {
        const resumed = await resumeCycleWithPorts({
          configuration: f.loaded,
          repository: f.repository,
          runRoot: f.runRoot,
          runId: crash.runId,
        });
        assert.equal(resumed.ok && resumed.value.kind === 'result' && resumed.value.result.spec.status === 'completed', true);
        assert.equal(relay.postHits(), postsAfterCrash, 'zero replacement POSTs on resume');
        const replayRec = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId: crash.runId, receipt: receiptPath });
        assert.equal(replayRec.ok && replayRec.value.kind === 'settled' && replayRec.value.status === 'completed', true);
      } else {
        const reconciled = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId: crash.runId, receipt: receiptPath });
        assert.equal(reconciled.ok && reconciled.value.kind === 'settled' && reconciled.value.status === 'completed', true);
        assert.equal(relay.postHits(), postsAfterCrash, 'zero replacement POSTs on reconcile');
      }
      await rm(receiptPath, { force: true });
    } finally {
      await f.cleanup();
      await relay.close();
    }
  }

  // Uncertain external_write publication stays unresolved remaining_unresolved_work (reconcile_required) after benchmark_verdict reconcile
  let capturedPubReq: Record<string, unknown> | null = null;
  const hangingPub = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      capturedPubReq = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      res.destroy();
    })();
  });
  await new Promise<void>(r => hangingPub.listen(0, '127.0.0.1', () => r()));
  const pubPort = (hangingPub.address() as { port: number }).port;
  const relay = await startCasRelayServer(new Map());
  const fPub = await benchmarkReconcileFixture(relay.url, `http://127.0.0.1:${pubPort}/publish`);
  try {
    const crash = await injectBenchmarkCrash(fPub, 'run-bench-rec-pub-uncertain', 'mid_cas_pull');
    const benchBody: Record<string, unknown> = {
      version: 1,
      kind: 'benchmark_verdict',
      storeId: crash.storeId,
      runId: crash.runId,
      lockHash: crash.lockHash,
      operationId: crash.operationId,
      dispatchId: crash.dispatchId,
      dispatchGeneration: crash.dispatchGeneration,
      gateId: 'sm90-gemm-gate',
      checkId: 'kernel-bench',
      candidateDigest: crash.candidateDigest,
      status: 'approved',
      reason: null,
      expiresAtMs: String(Date.now() + 600_000),
      preemptionCount: 0,
      hardwareProvenance: makeProvenance(),
      metrics: { latency_us: 39.0 },
    };
    const benchReceiptPath = join(tmpdir(), `lw-bench-pub-uncertain-${process.pid}.json`);
    await writeFile(benchReceiptPath, JSON.stringify({ ...benchBody, signature: signBenchmarkVerdict(BENCH_SECRET, benchBody) }), { mode: 0o600 });

    const rec1 = await reconcileCycle({
      configuration: fPub.loaded,
      runRoot: fPub.runRoot,
      runId: crash.runId,
      receipt: benchReceiptPath,
    });
    assert.equal(rec1.ok, true);
    if (rec1.ok) {
      assert.equal(rec1.value.kind, 'unresolved');
      if (rec1.value.kind === 'unresolved') assert.equal(rec1.value.reason, 'remaining_unresolved_work');
    }
    assert.ok(capturedPubReq !== null, 'publication was dispatched once and left uncertain');

    // Reconciling the publication_receipt then settles the run as completed!
    const pubReq = capturedPubReq as Record<string, unknown>;
    const pubBody: Record<string, unknown> = {
      version: 1,
      kind: 'publication_receipt',
      storeId: pubReq.storeId,
      runId: pubReq.runId,
      lockHash: pubReq.lockHash,
      operationId: pubReq.operationId,
      dispatchId: pubReq.dispatchId,
      dispatchGeneration: pubReq.dispatchGeneration,
      idempotencyKey: pubReq.idempotencyKey,
      outcome: 'succeeded',
      externalUrl: 'https://example.com/pull/99',
      reason: null,
    };
    const pubReceiptPath = join(tmpdir(), `lw-bench-pub-settled-${process.pid}.json`);
    await writeFile(pubReceiptPath, JSON.stringify({ ...pubBody, signature: signPayload(PUB_SECRET, canonical(pubBody)) }), { mode: 0o600 });
    const rec2 = await reconcileCycle({
      configuration: fPub.loaded,
      runRoot: fPub.runRoot,
      runId: crash.runId,
      receipt: pubReceiptPath,
    });
    assert.equal(rec2.ok && rec2.value.kind === 'settled' && rec2.value.status === 'completed', true);
    await rm(benchReceiptPath, { force: true });
    await rm(pubReceiptPath, { force: true });
  } finally {
    await fPub.cleanup();
    await relay.close();
    await new Promise<void>(r => {
      hangingPub.closeAllConnections();
      hangingPub.close(() => r());
    });
  }
});

test('S3 & S4: inconsistent .proof.json leaves SQLite dispatch_uncertain (recoverable), and atomic .tmp-* marker interruptions clean up safely', async () => {
  const outBytes = Buffer.from('stage-a-artifact');
  const outSha = sha256Hex(outBytes);
  const relay = await startCasRelayServer(new Map([[outSha, outBytes]]));
  const f = await benchmarkReconcileFixture(relay.url);

  try {
    // S3: inconsistent proof missing verifierArtifacts descriptor refuses RECOVERY_REQUIRED BEFORE settling SQLite!
    const crashS3 = await injectBenchmarkCrash(f, 'run-s3-inconsistent-proof', 'mid_cas_pull');
    const artDir = join(f.runRoot, crashS3.runId, 'artifacts');
    const bindingFile = (await readdir(artDir)).find(n => n.endsWith('.binding.json'))!;
    const prefixName = bindingFile.slice(0, -'.binding.json'.length);
    const bindingJson = JSON.parse(await readFile(join(artDir, bindingFile), 'utf8')) as Record<string, unknown>;
    const nonce = String(bindingJson.producerNonce);

    const verdictBody: Record<string, unknown> = {
      version: 1,
      kind: 'benchmark_verdict',
      storeId: crashS3.storeId,
      runId: crashS3.runId,
      lockHash: crashS3.lockHash,
      operationId: crashS3.operationId,
      dispatchId: crashS3.dispatchId,
      dispatchGeneration: crashS3.dispatchGeneration,
      gateId: 'sm90-gemm-gate',
      checkId: 'kernel-bench',
      candidateDigest: crashS3.candidateDigest,
      status: 'approved',
      reason: null,
      expiresAtMs: String(Date.now() + 600_000),
      preemptionCount: 0,
      hardwareProvenance: makeProvenance(),
      metrics: { latency_us: 40.0 },
      outputArtifacts: [{ name: 'out/a.cubin', digest: { algorithm: 'sha256', hex: outSha }, byteLength: outBytes.byteLength }],
    };
    const sig = signBenchmarkVerdict(BENCH_SECRET, verdictBody);
    const respBytes = Buffer.from(canonical(verdictBody), 'utf8');

    // Reopen store/owner briefly to write an inconsistent benchmark-output (verifierArtifacts: [] despite outputArtifacts.length === 1) + .proof.json
    const retainedS3 = await readRetained({ runRoot: f.runRoot, runId: crashS3.runId });
    const badOutObj = {
      version: 1,
      binding: {
        planDigest: bindingJson.planDigest,
        operationId: crashS3.operationId,
        producerNonce: nonce,
        generation: 0,
        endpoint: 'gpu-relay',
        subject: bindingJson.subject,
        requestBytesDigest: bindingJson.requestBytesDigest,
      },
      observation: {
        attempts: 1,
        elapsedMs: 5,
        transport: 'completed',
        sawPreemption: false,
        wallClockValid: true,
        casOutcome: 'ok',
      },
      verdict: {
        status: 'approved',
        reason: null,
        expiresAtMs: verdictBody.expiresAtMs,
        preemptionCount: 0,
        hardwareProvenance: makeProvenance(),
        metrics: { latency_us: 40 },
        outputArtifacts: verdictBody.outputArtifacts,
      },
      responseBytes: respBytes.toString('base64'),
      responseSignature: sig,
      verifierArtifacts: [], // <-- MISSING DESCRIPTOR!
      disposition: { status: 'passed', reason: null, method: 'benchmark-gate.v1' },
    };
    const badOutBytes = Buffer.from(canonical(badOutObj), 'utf8');
    const badOutName = 'benchmark-output-' + hash('loopwright.dev/controller/artifact/benchmark-output/v1\0' + hash(badOutBytes).hex).hex + '.bin';
    await writeFile(join(artDir, badOutName), badOutBytes, { mode: 0o600 });
    const badOutRef = { name: badOutName, digest: hash(badOutBytes), byteLength: badOutBytes.byteLength };
    const suffix = hash(crashS3.operationId + '\0' + nonce).hex.slice(0, 40);
    const fakeReceipt = {
      receiptId: 'receipt.' + suffix,
      outcome: 'succeeded',
      evidence: {
        evidenceId: 'receipt-evidence.' + suffix,
        producerId: 'loopwright.benchmark-gate.v1',
        method: 'benchmark-gate.v1',
        subject: {
          storeId: crashS3.storeId,
          runId: crashS3.runId,
          lockHash: crashS3.lockHash,
          operationId: crashS3.operationId,
          requestId: null,
          intentDigest: bindingJson.intentDigest,
          dispatchGeneration: crashS3.dispatchGeneration,
          dispatchId: crashS3.dispatchId,
        },
        artifact: badOutRef,
      },
    };
    const fakeRecBytes = Buffer.from(canonical(fakeReceipt), 'utf8');
    const fakeRecName = 'benchmark-receipt-' + hash('loopwright.dev/controller/artifact/benchmark-receipt/v1\0' + hash(fakeRecBytes).hex).hex + '.bin';
    await writeFile(join(artDir, fakeRecName), fakeRecBytes, { mode: 0o600 });
    const fakeRecRef = { name: fakeRecName, digest: hash(fakeRecBytes), byteLength: fakeRecBytes.byteLength };
    await writeFile(
      join(artDir, prefixName + '.proof.json'),
      canonical({ version: 1, output: badOutRef, receipt: fakeRecRef, evidence: {} }),
      { mode: 0o600 },
    );

    const recPath = join(tmpdir(), `lw-s3-rec-${process.pid}.json`);
    await writeFile(recPath, JSON.stringify({ ...verdictBody, signature: sig }), { mode: 0o600 });
    const badRecRes = await reconcileCycle({
      configuration: f.loaded,
      runRoot: f.runRoot,
      runId: crashS3.runId,
      receipt: recPath,
    });
    assert.equal(badRecRes.ok, false);
    if (!badRecRes.ok) assert.equal(badRecRes.error.code, 'RECOVERY_REQUIRED');

    // SQLite MUST remain dispatch_uncertain (not prematurely confirmed!)
    const checkStore = stateValue(reopenLocalRun(retainedS3.descriptor.identity));
    try {
      const opAfter = stateValue(checkStore.getOperation(crashS3.operationId));
      assert.equal(opAfter.state, 'dispatch_uncertain', 'SQLite must not confirm an inconsistent proof');
    } finally {
      stateValue(checkStore.close());
    }
    await rm(recPath, { force: true });

    // S4: partial/interrupted .tmp-* sibling markers AND crash between link(tmp, .proof.json) and unlink(tmp) (nlink === 2) recover cleanly!
    const crashS4 = await injectBenchmarkCrash(f, 'run-s4-atomic-marker-tmp', 'after_proof_before_receipt');
    const s4ArtDir = join(f.runRoot, crashS4.runId, 'artifacts');
    const s4ProofName = (await readdir(s4ArtDir)).find(n => n.endsWith('.proof.json'))!;
    const s4ProofPath = join(s4ArtDir, s4ProofName);
    // Simulate crash right between link(tmpPath, finalPath) and unlink(tmpPath) (leaving nlink === 2) + partial binding .tmp-*
    const s4HardlinkTmp = s4ProofPath + '.tmp-' + 'a'.repeat(32);
    await link(s4ProofPath, s4HardlinkTmp);
    const s4PartialBindingTmp = join(s4ArtDir, s4ProofName.replace('.proof.json', '.binding.json') + '.tmp-' + 'b'.repeat(32));
    await writeFile(s4PartialBindingTmp, '{"partial":', { mode: 0o600 });

    const s4Resumed = await resumeCycleWithPorts({
      configuration: f.loaded,
      repository: f.repository,
      runRoot: f.runRoot,
      runId: crashS4.runId,
    });
    assert.equal(s4Resumed.ok && s4Resumed.value.kind === 'result' && s4Resumed.value.result.spec.status === 'completed', true);
    const remainingFiles = await readdir(s4ArtDir);
    assert.equal(remainingFiles.some(n => n.includes('.tmp-')), false, 'stale .tmp-* marker siblings must be cleaned on recovery');
  } finally {
    await f.cleanup();
    await relay.close();
  }
});

test('P6 & P8 (reconcile): receipt expiring during CAS pull settles blocked, and Slot A / Gen 0 receipt replays cleanly while Slot B or Gen 1 is active', async () => {
  // P6 (reconcile): receipt fresh at admission (now + 450ms) expires during 650ms CAS GET -> settles blocked (never hardcodes wallClockValid: true)
  const slowBytes = Buffer.from('slow-reconcile-cubin');
  const slowSha = sha256Hex(slowBytes);
  const slowRelay = await startCasRelayServer(new Map([[slowSha, slowBytes]]), { getDelayMs: 650 });
  const fSlow = await benchmarkReconcileFixture(slowRelay.url);
  try {
    const crashExpire = await injectBenchmarkCrash(fSlow, 'run-p6-rec-expire-mid-pull', 'mid_cas_pull');
    const expBody: Record<string, unknown> = {
      version: 1,
      kind: 'benchmark_verdict',
      storeId: crashExpire.storeId,
      runId: crashExpire.runId,
      lockHash: crashExpire.lockHash,
      operationId: crashExpire.operationId,
      dispatchId: crashExpire.dispatchId,
      dispatchGeneration: crashExpire.dispatchGeneration,
      gateId: 'sm90-gemm-gate',
      checkId: 'kernel-bench',
      candidateDigest: crashExpire.candidateDigest,
      status: 'approved',
      reason: null,
      expiresAtMs: String(Date.now() + 450),
      preemptionCount: 0,
      hardwareProvenance: makeProvenance(),
      metrics: { latency_us: 42.0 },
      outputArtifacts: [{ name: 'out/slow.cubin', digest: { algorithm: 'sha256', hex: slowSha }, byteLength: slowBytes.byteLength }],
    };
    const expPath = join(tmpdir(), `lw-p6-rec-exp-${process.pid}.json`);
    await writeFile(expPath, JSON.stringify({ ...expBody, signature: signBenchmarkVerdict(BENCH_SECRET, expBody) }), { mode: 0o600 });
    const expRec = await reconcileCycle({
      configuration: fSlow.loaded,
      runRoot: fSlow.runRoot,
      runId: crashExpire.runId,
      receipt: expPath,
    });
    assert.equal(expRec.ok, true, expRec.ok ? '' : JSON.stringify(expRec.error));
    if (expRec.ok && expRec.value.kind === 'settled') {
      assert.equal(expRec.value.status, 'blocked', 'receipt expiring during CAS pull in reconcile must settle blocked');
    }
    await rm(expPath, { force: true });
  } finally {
    await fSlow.cleanup();
    await slowRelay.close();
  }

  // P8a: Two-slot run where Slot A is confirmed (with already-elapsed expiresAtMs!) and Slot B crashes at dispatch_uncertain:
  // Replaying Slot A resolves Slot A first and returns unresolved remaining_unresolved_work without timing out Slot B!
  const twoSlotCapture: {
    slotAPassedVerdict: Record<string, unknown> | null;
    slotBRequest: Record<string, unknown> | null;
  } = { slotAPassedVerdict: null, slotBRequest: null };
  const twoSlotServer = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'PUT') {
        for await (const c of req) void c;
        res.writeHead(201).end();
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/benchmark/jobs') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        if (parsed.checkId === 'bench-a') {
          const v: Record<string, unknown> = {
            version: 1,
            kind: 'benchmark_verdict',
            storeId: parsed.storeId,
            runId: parsed.runId,
            lockHash: parsed.lockHash,
            operationId: parsed.operationId,
            dispatchId: parsed.dispatchId,
            dispatchGeneration: parsed.dispatchGeneration,
            gateId: parsed.gateId,
            checkId: parsed.checkId,
            candidateDigest: parsed.candidateDigest,
            status: 'approved',
            reason: null,
            expiresAtMs: String(Date.now() + 500), // stays fresh across proof fsync under load, then expires before replay
            preemptionCount: 0,
            hardwareProvenance: makeProvenance(),
            metrics: { latency_us: 38.0 },
          };
          twoSlotCapture.slotAPassedVerdict = v;
          const b = Buffer.from(JSON.stringify(v), 'utf8');
          res.writeHead(200, { 'content-type': 'application/json', 'x-loopwright-signature': signPayload(BENCH_SECRET, b) });
          res.end(b);
          return;
        }
        twoSlotCapture.slotBRequest = parsed;
        res.writeHead(500).end('simulated disconnect');
        return;
      }
      res.writeHead(404).end();
    })();
  });
  await new Promise<void>(r => twoSlotServer.listen(0, '127.0.0.1', () => r()));
  let fTwo: Awaited<ReturnType<typeof benchmarkReconcileFixture>> | null = null;
  try {
    const twoPort = (twoSlotServer.address() as { port: number }).port;
    fTwo = await benchmarkReconcileFixture(`http://127.0.0.1:${twoPort}/v1/benchmark/jobs`);
    const installed = await installedHandlerDigests();
    setFixture(fTwo.registry, ['spec', 'handlers'], [
      fTwo.registry.spec.handlers[0]!,
      {
        id: 'bench-a',
        kind: 'check',
        implementation: 'benchmark-gate.v1',
        version: 1,
        digest: installed['benchmark-gate.v1'],
        parameters: { checkId: 'bench-a', endpointRef: 'gpu-relay', gateId: 'gate-a', heldOutWorkloadId: 'wl-1' },
        capabilities: ['hardware_execution', 'read_only'],
      },
      {
        id: 'bench-b',
        kind: 'check',
        implementation: 'benchmark-gate.v1',
        version: 1,
        digest: installed['benchmark-gate.v1'],
        parameters: { checkId: 'bench-b', endpointRef: 'gpu-relay', gateId: 'gate-b', heldOutWorkloadId: 'wl-1' },
        capabilities: ['hardware_execution', 'read_only'],
      },
      fTwo.registry.spec.handlers[2]!,
      fTwo.registry.spec.handlers[3]!,
    ]);
    setFixture(fTwo.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'step-a', kind: 'check', uses: 'bench-a', roleId: null, dependsOn: [] },
      { id: 'step-b', kind: 'check', uses: 'bench-b', roleId: null, dependsOn: ['step-a'] },
    ]);
    setFixture(fTwo.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'step-a', handlerRef: 'bench-a' },
      { stepId: 'step-b', handlerRef: 'bench-b' },
    ]);
    setFixture(fTwo.config, ['spec', 'task', 'spec', 'acceptance'], {
      required: ['bench-a', 'bench-b'],
      checks: [
        { id: 'bench-a', allowedEvidenceLevels: ['hardware_execution'], targetCellId: 'cuda-sm90' },
        { id: 'bench-b', allowedEvidenceLevels: ['hardware_execution'], targetCellId: 'cuda-sm90' },
      ],
    });
    await fTwo.save();
    const loadedTwo = await fTwo.load();
    assert.equal(loadedTwo.ok, true);

    if (loadedTwo.ok) {
      const runId = 'run-p8-two-slots-active';
      const ctx = await createCycle({ configuration: loadedTwo.value, repository: fTwo.repository, runRoot: fTwo.runRoot, runId }, {});
      const cycle = new Cycle(ctx);
      await cycle.bootstrap();
      const resA = await cycle.runVerifier('check.bench-a');
      assert.equal(resA.status, 'passed');

      // Start Slot B and simulate crash right after Slot B sends its first POST (leaving Slot B dispatch_uncertain at verify.0.1.pre!)
      const origRecord = ctx.store.recordOperationReceipt.bind(ctx.store);
      (ctx.store as unknown as Record<string, unknown>).recordOperationReceipt = () => {
        throw new Error('CRASH_SLOT_B_OPEN');
      };
      try {
        await cycle.runVerifier('check.bench-b');
      } catch {
        // Expected simulated crash leaving Slot B dispatch_uncertain.
      }
      (ctx.store as unknown as Record<string, unknown>).recordOperationReceipt = origRecord;
      // Remove Slot B's timeout .proof.json so Slot B is genuinely parked mid-flight with only .binding.json!
      const artDir = join(fTwo.runRoot, runId, 'artifacts');
      for (const fName of await readdir(artDir)) {
        if (fName.endsWith('.proof.json')) {
          const parsedProof = JSON.parse(await readFile(join(artDir, fName), 'utf8')) as { output: { name: string } };
          const parsedOut = JSON.parse(await readFile(join(artDir, parsedProof.output.name), 'utf8')) as { verdict: unknown };
          if (parsedOut.verdict === null) await rm(join(artDir, fName), { force: true });
        }
      }
      await cycle.deadline.dispose();
      const evRef = await cycle.events.close();
      const evOpen = await fsOpen(join(artDir, 'controller-events.open'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        await evOpen.writeFile(await readFile(join(artDir, evRef.name)));
        await evOpen.sync();
      } finally {
        await evOpen.close();
      }
      stateValue(ctx.store.release(ctx.authority));
      stateValue(ctx.store.close());
      await ctx.owner.release();

      // Wait until Slot A's expiresAtMs is strictly in the past!
      assert.ok(twoSlotCapture.slotAPassedVerdict !== null && twoSlotCapture.slotBRequest !== null);
      const waitUntilExpiredMs = Math.max(50, Number(twoSlotCapture.slotAPassedVerdict.expiresAtMs) - Date.now() + 50);
      await new Promise<void>(r => setTimeout(r, waitUntilExpiredMs));

      const slotARecPath = join(tmpdir(), `lw-p8-slot-a-${process.pid}.json`);
      await writeFile(
        slotARecPath,
        JSON.stringify({
          ...twoSlotCapture.slotAPassedVerdict,
          signature: signBenchmarkVerdict(BENCH_SECRET, twoSlotCapture.slotAPassedVerdict),
        }),
        { mode: 0o600 },
      );

      // Replay Slot A while Slot B is active AND after Slot A's expiresAtMs: resolves Slot A first and keeps Slot B open!
      const replayA = await reconcileCycle({
        configuration: loadedTwo.value,
        runRoot: fTwo.runRoot,
        runId,
        receipt: slotARecPath,
      });
      assert.equal(replayA.ok, true, replayA.ok ? '' : JSON.stringify(replayA.error));
      if (replayA.ok) {
        assert.equal(replayA.value.kind, 'unresolved');
        if (replayA.value.kind === 'unresolved') assert.equal(replayA.value.reason, 'remaining_unresolved_work');
      }

      // Now reconcile Slot B -> settles the entire run as completed!
      const bReq = twoSlotCapture.slotBRequest;
      const slotBBody: Record<string, unknown> = {
        version: 1,
        kind: 'benchmark_verdict',
        storeId: bReq.storeId,
        runId: bReq.runId,
        lockHash: bReq.lockHash,
        operationId: bReq.operationId,
        dispatchId: bReq.dispatchId,
        dispatchGeneration: bReq.dispatchGeneration,
        gateId: bReq.gateId,
        checkId: bReq.checkId,
        candidateDigest: bReq.candidateDigest,
        status: 'approved',
        reason: null,
        expiresAtMs: String(Date.now() + 600_000),
        preemptionCount: 0,
        hardwareProvenance: makeProvenance(),
        metrics: { latency_us: 39.0 },
      };
      const slotBRecPath = join(tmpdir(), `lw-p8-slot-b-${process.pid}.json`);
      await writeFile(
        slotBRecPath,
        JSON.stringify({ ...slotBBody, signature: signBenchmarkVerdict(BENCH_SECRET, slotBBody) }),
        { mode: 0o600 },
      );
      const settledB = await reconcileCycle({
        configuration: loadedTwo.value,
        runRoot: fTwo.runRoot,
        runId,
        receipt: slotBRecPath,
      });
      assert.equal(settledB.ok && settledB.value.kind === 'settled' && settledB.value.status === 'completed', true);
      await rm(slotARecPath, { force: true });
      await rm(slotBRecPath, { force: true });
    }
  } finally {
    if (fTwo) await fTwo.cleanup();
    await new Promise<void>(r => {
      twoSlotServer.closeAllConnections();
      twoSlotServer.close(() => r());
    });
  }

  // P8b: Replay generation 0's confirmed receipt AFTER a later candidate generation 1 has run and completed!
  const genCapture: { gen0Verdict: Record<string, unknown> | null } = { gen0Verdict: null };
  let postIdx = 0;
  const multiGenServer = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'PUT') {
        for await (const c of req) void c;
        res.writeHead(201).end();
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/benchmark/jobs') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        postIdx++;
        const isFirst = postIdx === 1;
        const v: Record<string, unknown> = {
          version: 1,
          kind: 'benchmark_verdict',
          storeId: parsed.storeId,
          runId: parsed.runId,
          lockHash: parsed.lockHash,
          operationId: parsed.operationId,
          dispatchId: parsed.dispatchId,
          dispatchGeneration: parsed.dispatchGeneration,
          gateId: parsed.gateId,
          checkId: parsed.checkId,
          candidateDigest: parsed.candidateDigest,
          status: isFirst ? 'denied' : 'approved',
          reason: isFirst ? 'threshold_miss' : null,
          expiresAtMs: String(Date.now() + 600_000),
          preemptionCount: 0,
          hardwareProvenance: makeProvenance(),
          metrics: { latency_us: isFirst ? 150.0 : 45.0 },
        };
        if (isFirst) genCapture.gen0Verdict = v;
        const b = Buffer.from(JSON.stringify(v), 'utf8');
        res.writeHead(200, { 'content-type': 'application/json', 'x-loopwright-signature': signPayload(BENCH_SECRET, b) });
        res.end(b);
        return;
      }
      res.writeHead(404).end();
    })();
  });
  await new Promise<void>(r => multiGenServer.listen(0, '127.0.0.1', () => r()));
  let fMg: Awaited<ReturnType<typeof benchmarkReconcileFixture>> | null = null;
  try {
    const mgPort = (multiGenServer.address() as { port: number }).port;
    fMg = await benchmarkReconcileFixture(`http://127.0.0.1:${mgPort}/v1/benchmark/jobs`);
    setFixture(fMg.registry, ['spec', 'roleProfiles'], [
      {
        id: 'builder',
        adapter: 'delegated',
        runtimeRef: null,
        providerCredentialRef: null,
        selection: { provider: 'antigravity', model: 'gemini-4-argon', thinking: 'high' },
        tools: ['read', 'write', 'edit', 'delete'],
        mcp: null,
      },
    ]);
    setFixture(fMg.config, ['spec', 'task', 'spec', 'roles'], [
      { id: 'builder', adapter: 'delegated', provider: 'antigravity', model: 'gemini-4-argon', thinking: 'high', tools: ['read', 'write', 'edit', 'delete'] },
    ]);
    setFixture(fMg.config, ['spec', 'task', 'spec', 'scope', 'writable'], ['**']);
    setFixture(fMg.config, ['spec', 'task', 'spec', 'budgets', 'maxImplementationRepairs'], 1);
    setFixture(fMg.config, ['spec', 'controls', 'maxAttempts'], 4);
    setFixture(fMg.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'build', kind: 'agent', uses: 'package.patch', roleId: 'builder', dependsOn: [] },
      { id: 'bench-step', kind: 'check', uses: 'kernel-bench', roleId: null, dependsOn: ['build'] },
    ]);
    setFixture(fMg.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'build', handlerRef: 'package.patch' },
      { stepId: 'bench-step', handlerRef: 'kernel-bench' },
    ]);
    await fMg.save();
    const loadedMg = await fMg.load();
    assert.equal(loadedMg.ok, true);

    if (loadedMg.ok) {
      const fMgRef = fMg;
      const runId = 'run-p8-multi-gen-replay';
      const tick1 = await stepNext({
        configuration: loadedMg.value,
        repository: fMgRef.repository,
        runRoot: fMgRef.runRoot,
        runId,
        environment: name => fMgRef.environment[name],
      });
      assert.equal(tick1.ok && tick1.value.kind === 'step', true);
      const step1 = (tick1 as { ok: true; value: StepTickResult }).value as StepYield;
      await writeFile(join(step1.candidateDir, 'kernel.cu'), '// gen1 slow\n', { mode: 0o600 });

      const tick2 = await stepSubmit({
        runRoot: fMgRef.runRoot,
        runId,
        leaseToken: step1.leaseToken,
        status: 'completed',
        environment: name => fMgRef.environment[name],
      });
      assert.equal(tick2.ok && tick2.value.kind === 'step', true);
      const repairStep = (tick2 as { ok: true; value: StepTickResult }).value as StepYield;
      assert.equal(repairStep.repair, 'implementation');

      // While generation 2 repair step is yielded, replay generation 1's denied receipt -> binds to gen 1's subject and returns delegated_step_required!
      assert.ok(genCapture.gen0Verdict !== null);
      const gen0RecPath = join(tmpdir(), `lw-p8-gen0-${process.pid}.json`);
      await writeFile(
        gen0RecPath,
        JSON.stringify({ ...genCapture.gen0Verdict, signature: signBenchmarkVerdict(BENCH_SECRET, genCapture.gen0Verdict) }),
        { mode: 0o600 },
      );
      const midReplay = await reconcileCycle({
        configuration: loadedMg.value,
        runRoot: fMgRef.runRoot,
        runId,
        receipt: gen0RecPath,
      });
      assert.equal(midReplay.ok && midReplay.value.kind === 'unresolved' && midReplay.value.reason === 'delegated_step_required', true);

      // Finish generation 2 -> completed, then replay generation 1's receipt again!
      await writeFile(join(repairStep.candidateDir, 'kernel.cu'), '// gen2 fast\n', { mode: 0o600 });
      const tick3 = await stepSubmit({
        runRoot: fMgRef.runRoot,
        runId,
        leaseToken: repairStep.leaseToken,
        status: 'completed',
        environment: name => fMgRef.environment[name],
      });
      assert.equal(tick3.ok && tick3.value.kind === 'result' && tick3.value.result.spec.status === 'completed', true);

      const postReplay = await reconcileCycle({
        configuration: loadedMg.value,
        runRoot: fMgRef.runRoot,
        runId,
        receipt: gen0RecPath,
      });
      assert.equal(postReplay.ok && postReplay.value.kind === 'settled' && postReplay.value.status === 'completed', true);
      await rm(gen0RecPath, { force: true });
    }
  } finally {
    if (fMg) await fMg.cleanup();
    await new Promise<void>(r => {
      multiGenServer.closeAllConnections();
      multiGenServer.close(() => r());
    });
  }
});

test('Fix Pass #2 — S3 signed mediaType proof validation, P5 poisoned local CAS settlement, P6/P8 first-confirmation expiry vs replay, and P8 sibling pre-intent isolation', async () => {
  const cleanBlob = Buffer.from('clean-stage-a-cubin-bytes');
  const cleanSha = sha256Hex(cleanBlob);
  const secretLocalBlob = Buffer.from(`local-cas-${BENCH_SECRET}-poison`);
  const secretLocalSha = sha256Hex(secretLocalBlob);

  const relay = await startCasRelayServer(new Map([[cleanSha, cleanBlob]]));
  const f = await benchmarkReconcileFixture(relay.url);

  try {
    // 1. S3: .proof.json + Evidence carrying a tampered valid mediaType ('text/plain' vs signed absent mediaType) is rejected BEFORE SQLite settlement!
    const crashS3Media = await injectBenchmarkCrash(f, 'run-fp2-s3-tampered-mediatype', 'mid_cas_pull', {
      localBlob: { name: 'out/clean.cubin', bytes: cleanBlob },
    });
    const s3ArtDir = join(f.runRoot, crashS3Media.runId, 'artifacts');
    const s3BindingFile = (await readdir(s3ArtDir)).find(n => n.endsWith('.binding.json'))!;
    const s3PrefixName = s3BindingFile.slice(0, -'.binding.json'.length);
    const s3BindingJson = JSON.parse(await readFile(join(s3ArtDir, s3BindingFile), 'utf8')) as Record<string, unknown>;
    const s3Nonce = String(s3BindingJson.producerNonce);

    const signedMediaVerdict: Record<string, unknown> = {
      version: 1,
      kind: 'benchmark_verdict',
      storeId: crashS3Media.storeId,
      runId: crashS3Media.runId,
      lockHash: crashS3Media.lockHash,
      operationId: crashS3Media.operationId,
      dispatchId: crashS3Media.dispatchId,
      dispatchGeneration: crashS3Media.dispatchGeneration,
      gateId: 'sm90-gemm-gate',
      checkId: 'kernel-bench',
      candidateDigest: crashS3Media.candidateDigest,
      status: 'approved',
      reason: null,
      expiresAtMs: String(Date.now() + 600_000),
      preemptionCount: 0,
      hardwareProvenance: makeProvenance(),
      metrics: { latency_us: 40.0 },
      // Signed outputArtifacts omits mediaType (or sets application/octet-stream), while tampered proof claims text/plain!
      outputArtifacts: [{ name: 'out/clean.cubin', digest: { algorithm: 'sha256', hex: cleanSha }, byteLength: cleanBlob.byteLength }],
    };
    const s3Sig = signBenchmarkVerdict(BENCH_SECRET, signedMediaVerdict);
    const s3RespBytes = Buffer.from(canonical(signedMediaVerdict), 'utf8');
    const tamperedVerifierRef = {
      name: `.loopwright-verifier/${crashS3Media.slotId}/out/clean.cubin`,
      digest: { algorithm: 'sha256' as const, hex: cleanSha },
      byteLength: cleanBlob.byteLength,
      uri: 'cas://sha256/' + cleanSha,
      mediaType: 'text/plain',
    };
    const tamperedOutObj = {
      version: 1,
      binding: {
        planDigest: s3BindingJson.planDigest,
        operationId: crashS3Media.operationId,
        producerNonce: s3Nonce,
        generation: 0,
        endpoint: 'gpu-relay',
        subject: s3BindingJson.subject,
        requestBytesDigest: s3BindingJson.requestBytesDigest,
      },
      observation: {
        attempts: 1,
        elapsedMs: 5,
        transport: 'completed',
        sawPreemption: false,
        wallClockValid: true,
        casOutcome: 'ok',
      },
      verdict: {
        status: 'approved',
        reason: null,
        expiresAtMs: signedMediaVerdict.expiresAtMs,
        preemptionCount: 0,
        hardwareProvenance: makeProvenance(),
        metrics: { latency_us: 40 },
        outputArtifacts: signedMediaVerdict.outputArtifacts,
      },
      responseBytes: s3RespBytes.toString('base64'),
      responseSignature: s3Sig,
      verifierArtifacts: [tamperedVerifierRef],
      disposition: { status: 'passed', reason: null, method: 'benchmark-gate.v1' },
    };
    const tamperedOutBytes = Buffer.from(canonical(tamperedOutObj), 'utf8');
    const tamperedOutName =
      'benchmark-output-' + hash('loopwright.dev/controller/artifact/benchmark-output/v1\0' + hash(tamperedOutBytes).hex).hex + '.bin';
    await writeFile(join(s3ArtDir, tamperedOutName), tamperedOutBytes, { mode: 0o600 });
    const tamperedOutRef = { name: tamperedOutName, digest: hash(tamperedOutBytes), byteLength: tamperedOutBytes.byteLength };
    const s3Suffix = hash(crashS3Media.operationId + '\0' + s3Nonce).hex.slice(0, 40);
    const tamperedEv = validateDocument(
      {
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'Evidence',
        metadata: { id: 'evidence.' + s3Suffix },
        spec: {
          checkId: 'kernel-bench',
          observedStatus: 'passed',
          producerId: 'loopwright.benchmark-gate.v1',
          method: 'benchmark-gate.v1',
          level: 'hardware_execution',
          subject: s3BindingJson.subject,
          artifacts: [tamperedOutRef, tamperedVerifierRef],
          reason: null,
          metrics: { latency_us: 40 },
          hardwareProvenance: makeProvenance(),
        },
      },
      'Evidence',
    );
    assert.equal(tamperedEv.ok, true);
    if (tamperedEv.ok) {
      const tamperedReceipt = {
        receiptId: 'receipt.' + s3Suffix,
        outcome: 'succeeded',
        evidence: {
          evidenceId: 'receipt-evidence.' + s3Suffix,
          producerId: 'loopwright.benchmark-gate.v1',
          method: 'benchmark-gate.v1',
          subject: {
            storeId: crashS3Media.storeId,
            runId: crashS3Media.runId,
            lockHash: crashS3Media.lockHash,
            operationId: crashS3Media.operationId,
            requestId: null,
            intentDigest: s3BindingJson.intentDigest,
            dispatchGeneration: crashS3Media.dispatchGeneration,
            dispatchId: crashS3Media.dispatchId,
          },
          artifact: tamperedOutRef,
        },
      };
      const tamperedRecBytes = Buffer.from(canonical(tamperedReceipt), 'utf8');
      const tamperedRecName =
        'benchmark-receipt-' + hash('loopwright.dev/controller/artifact/benchmark-receipt/v1\0' + hash(tamperedRecBytes).hex).hex + '.bin';
      await writeFile(join(s3ArtDir, tamperedRecName), tamperedRecBytes, { mode: 0o600 });
      const tamperedRecRef = { name: tamperedRecName, digest: hash(tamperedRecBytes), byteLength: tamperedRecBytes.byteLength };
      await writeFile(
        join(s3ArtDir, s3PrefixName + '.proof.json'),
        canonical({ version: 1, output: tamperedOutRef, receipt: tamperedRecRef, evidence: tamperedEv.value }),
        { mode: 0o600 },
      );

      const s3RecPath = join(tmpdir(), `lw-fp2-s3-media-${process.pid}.json`);
      await writeFile(s3RecPath, JSON.stringify({ ...signedMediaVerdict, signature: s3Sig }), { mode: 0o600 });
      const s3RecRes = await reconcileCycle({
        configuration: f.loaded,
        runRoot: f.runRoot,
        runId: crashS3Media.runId,
        receipt: s3RecPath,
      });
      assert.equal(s3RecRes.ok, false);
      if (!s3RecRes.ok) assert.equal(s3RecRes.error.code, 'RECOVERY_REQUIRED');

      const retainedMedia = await readRetained({ runRoot: f.runRoot, runId: crashS3Media.runId });
      const mediaStore = stateValue(reopenLocalRun(retainedMedia.descriptor.identity));
      try {
        assert.equal(
          stateValue(mediaStore.getOperation(crashS3Media.operationId)).state,
          'dispatch_uncertain',
          'tampered mediaType in .proof.json must be rejected BEFORE SQLite settlement',
        );
      } finally {
        stateValue(mediaStore.close());
      }
      await rm(s3RecPath, { force: true });
    }

    // 2. P5: Poisoned LOCAL CAS files (wrong mode 0o644, wrong bytes, and secret content) settle SQLite as blocked / ARTIFACT_INVALID!
    for (const variant of ['wrong_mode', 'wrong_bytes', 'secret_bytes'] as const) {
      const crashLocalPoison = await injectBenchmarkCrash(f, `run-fp2-p5-local-${variant}`, 'mid_cas_pull');
      const targetSha = variant === 'secret_bytes' ? secretLocalSha : cleanSha;
      const targetLen = variant === 'secret_bytes' ? secretLocalBlob.byteLength : cleanBlob.byteLength;
      const localShaDir = join(f.runRoot, crashLocalPoison.runId, 'artifacts', 'blobs', 'sha256');
      await mkdir(localShaDir, { recursive: true, mode: 0o700 });
      const localBlobFile = join(localShaDir, targetSha);
      if (variant === 'wrong_mode') {
        await writeFile(localBlobFile, cleanBlob, { mode: 0o644 });
        await chmod(localBlobFile, 0o644);
      } else if (variant === 'wrong_bytes') {
        const fh = await fsOpen(localBlobFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400);
        try {
          await fh.writeFile(Buffer.alloc(cleanBlob.byteLength, 0xee));
          await fh.chmod(0o400);
          await fh.sync();
        } finally {
          await fh.close();
        }
      } else {
        const fh = await fsOpen(localBlobFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400);
        try {
          await fh.writeFile(secretLocalBlob);
          await fh.chmod(0o400);
          await fh.sync();
        } finally {
          await fh.close();
        }
      }

      const getsBefore = relay.getHits(targetSha);
      const localPoisonVerdict: Record<string, unknown> = {
        version: 1,
        kind: 'benchmark_verdict',
        storeId: crashLocalPoison.storeId,
        runId: crashLocalPoison.runId,
        lockHash: crashLocalPoison.lockHash,
        operationId: crashLocalPoison.operationId,
        dispatchId: crashLocalPoison.dispatchId,
        dispatchGeneration: crashLocalPoison.dispatchGeneration,
        gateId: 'sm90-gemm-gate',
        checkId: 'kernel-bench',
        candidateDigest: crashLocalPoison.candidateDigest,
        status: 'approved',
        reason: null,
        expiresAtMs: String(Date.now() + 600_000),
        preemptionCount: 0,
        hardwareProvenance: makeProvenance(),
        metrics: { latency_us: 39.5 },
        outputArtifacts: [{ name: 'out/local.cubin', digest: { algorithm: 'sha256', hex: targetSha }, byteLength: targetLen }],
      };
      const localPoisonRecPath = join(tmpdir(), `lw-fp2-p5-${variant}-${process.pid}.json`);
      await writeFile(
        localPoisonRecPath,
        JSON.stringify({ ...localPoisonVerdict, signature: signBenchmarkVerdict(BENCH_SECRET, localPoisonVerdict) }),
        { mode: 0o600 },
      );

      const settledLocalPoison = await reconcileCycle({
        configuration: f.loaded,
        runRoot: f.runRoot,
        runId: crashLocalPoison.runId,
        receipt: localPoisonRecPath,
      });
      assert.equal(settledLocalPoison.ok, true, `${variant}: ${settledLocalPoison.ok ? '' : JSON.stringify(settledLocalPoison.error)}`);
      if (settledLocalPoison.ok) {
        assert.equal(settledLocalPoison.value.kind, 'settled', variant);
        if (settledLocalPoison.value.kind === 'settled') {
          assert.equal(settledLocalPoison.value.status, 'blocked', variant);
        }
      }
      assert.equal(relay.getHits(targetSha), getsBefore, `${variant}: invalid local CAS must settle blocked without HTTP GET`);

      const retainedP5 = await readRetained({ runRoot: f.runRoot, runId: crashLocalPoison.runId });
      const p5Store = stateValue(reopenLocalRun(retainedP5.descriptor.identity));
      try {
        assert.equal(stateValue(p5Store.getOperation(crashLocalPoison.operationId)).state, 'confirmed', variant);
      } finally {
        stateValue(p5Store.close());
      }
      await rm(localPoisonRecPath, { force: true });
    }
  } finally {
    await f.cleanup();
    await relay.close();
  }

  // 3. P6/P8: First SQLite confirmation from existing .proof.json after expiresAtMs is REJECTED by reconcile and settles BLOCKED on resume,
  // while post-expiry replay of an ALREADY-confirmed receipt is ACCEPTED!
  let shortExpiryMs = 150;
  const shortTtlServer = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'PUT') {
        for await (const c of req) void c;
        res.writeHead(201).end();
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/benchmark/jobs') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        const v: Record<string, unknown> = {
          version: 1,
          kind: 'benchmark_verdict',
          storeId: parsed.storeId,
          runId: parsed.runId,
          lockHash: parsed.lockHash,
          operationId: parsed.operationId,
          dispatchId: parsed.dispatchId,
          dispatchGeneration: parsed.dispatchGeneration,
          gateId: parsed.gateId,
          checkId: parsed.checkId,
          candidateDigest: parsed.candidateDigest,
          status: 'approved',
          reason: null,
          expiresAtMs: String(Date.now() + shortExpiryMs),
          preemptionCount: 0,
          hardwareProvenance: makeProvenance(),
          metrics: { latency_us: 41.0 },
        };
        const b = Buffer.from(JSON.stringify(v), 'utf8');
        res.writeHead(200, { 'content-type': 'application/json', 'x-loopwright-signature': signPayload(BENCH_SECRET, b) });
        res.end(b);
        return;
      }
      res.writeHead(404).end();
    })();
  });
  await new Promise<void>(r => shortTtlServer.listen(0, '127.0.0.1', () => r()));
  let fTtl: Awaited<ReturnType<typeof benchmarkReconcileFixture>> | null = null;
  try {
    const ttlPort = (shortTtlServer.address() as { port: number }).port;
    fTtl = await benchmarkReconcileFixture(`http://127.0.0.1:${ttlPort}/v1/benchmark/jobs`);

    // 3a. Unconfirmed operation with existing .proof.json whose expiresAtMs elapses before first SQLite confirmation:
    shortExpiryMs = 500;
    const crashExpiredProof = await injectBenchmarkCrash(fTtl, 'run-fp2-expired-proof-unconfirmed', 'after_proof_before_receipt');
    const expArtDir = join(fTtl.runRoot, crashExpiredProof.runId, 'artifacts');
    const expOutName = (await readdir(expArtDir)).find(n => n.startsWith('benchmark-output-'))!;
    const expSavedOut = JSON.parse(await readFile(join(expArtDir, expOutName), 'utf8')) as {
      verdict: { expiresAtMs: string };
      observation: { wallClockValid: boolean };
    };
    assert.equal(expSavedOut.observation.wallClockValid, true, 'pre-crash saved boolean was true');

    // Wait past expiresAtMs while SQLite is still dispatch_uncertain
    await new Promise<void>(r => setTimeout(r, Math.max(50, Number(expSavedOut.verdict.expiresAtMs) - Date.now() + 50)));

    const expProofRecBody: Record<string, unknown> = {
      version: 1,
      kind: 'benchmark_verdict',
      storeId: crashExpiredProof.storeId,
      runId: crashExpiredProof.runId,
      lockHash: crashExpiredProof.lockHash,
      operationId: crashExpiredProof.operationId,
      dispatchId: crashExpiredProof.dispatchId,
      dispatchGeneration: crashExpiredProof.dispatchGeneration,
      gateId: 'sm90-gemm-gate',
      checkId: 'kernel-bench',
      candidateDigest: crashExpiredProof.candidateDigest,
      status: 'approved',
      reason: null,
      expiresAtMs: expSavedOut.verdict.expiresAtMs,
      preemptionCount: 0,
      hardwareProvenance: makeProvenance(),
      metrics: { latency_us: 41.0 },
    };
    const expProofRecPath = join(tmpdir(), `lw-fp2-exp-proof-${process.pid}.json`);
    await writeFile(
      expProofRecPath,
      JSON.stringify({ ...expProofRecBody, signature: signBenchmarkVerdict(BENCH_SECRET, expProofRecBody) }),
      { mode: 0o600 },
    );

    // Reconcile MUST reject first confirmation of the expired proof!
    const rejectedFirstConfirm = await reconcileCycle({
      configuration: fTtl.loaded,
      runRoot: fTtl.runRoot,
      runId: crashExpiredProof.runId,
      receipt: expProofRecPath,
    });
    assert.equal(rejectedFirstConfirm.ok, false);
    if (!rejectedFirstConfirm.ok) {
      assert.equal(rejectedFirstConfirm.error.code, 'EVIDENCE_UNAVAILABLE');
    }
    const retainedAfterReject = await readRetained({ runRoot: fTtl.runRoot, runId: crashExpiredProof.runId });
    const storeAfterReject = stateValue(reopenLocalRun(retainedAfterReject.descriptor.identity));
    try {
      assert.equal(
        stateValue(storeAfterReject.getOperation(crashExpiredProof.operationId)).state,
        'dispatch_uncertain',
        'reconcile must NOT confirm expired approval in SQLite',
      );
    } finally {
      stateValue(storeAfterReject.close());
    }

    // Resume MUST also catch expired first confirmation in BenchmarkGate.restore and settle blocked (never completed)!
    const resumedExpiredProof = await resumeCycleWithPorts({
      configuration: fTtl.loaded,
      repository: fTtl.repository,
      runRoot: fTtl.runRoot,
      runId: crashExpiredProof.runId,
    });
    assert.equal(resumedExpiredProof.ok, true, resumedExpiredProof.ok ? '' : JSON.stringify(resumedExpiredProof.error));
    if (resumedExpiredProof.ok && resumedExpiredProof.value.kind === 'result') {
      assert.equal(resumedExpiredProof.value.result.spec.status, 'blocked');
      assert.equal(resumedExpiredProof.value.result.spec.verification.spec.required[0]!.detail, 'EVIDENCE_UNAVAILABLE');
    }
    await rm(expProofRecPath, { force: true });

    // 3b. Contrast: ALREADY-confirmed receipt (confirmed before expiry) replays cleanly AFTER expiresAtMs has elapsed!
    shortExpiryMs = 500;
    const confirmedRunId = 'run-fp2-already-confirmed-post-expiry';
    const ctxConf = await createCycle({ configuration: fTtl.loaded, repository: fTtl.repository, runRoot: fTtl.runRoot, runId: confirmedRunId }, {});
    const cycleConf = new Cycle(ctxConf);
    await cycleConf.bootstrap();
    const slotConf = ctxConf.plan.verifierSlots.find(s => s.handler.implementation === 'benchmark-gate.v1')!;
    const checkedConf = await cycleConf.runVerifier(slotConf.id);
    assert.equal(checkedConf.status, 'passed');
    const confView = stateValue(ctxConf.store.inspect());
    const confOp = stateValue(ctxConf.store.getOperation(checkedConf.operationId));
    assert.equal(confOp.state, 'confirmed');
    const confArtDir = ctxConf.artifacts.directory;
    const confOutName = (await readdir(confArtDir)).find(n => n.startsWith('benchmark-output-'))!;
    const confSavedOut = JSON.parse(await readFile(join(confArtDir, confOutName), 'utf8')) as { verdict: { expiresAtMs: string } };
    const confBound = bindSubject(ctxConf.lock, ctxConf.source.manifest);
    assert.equal(confBound.ok, true);
    await cycleConf.deadline.dispose();
    const confEvRef = await cycleConf.events.close();
    const confEvOpen = await fsOpen(join(confArtDir, 'controller-events.open'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      await confEvOpen.writeFile(await readFile(join(confArtDir, confEvRef.name)));
      await confEvOpen.sync();
    } finally {
      await confEvOpen.close();
    }
    stateValue(ctxConf.store.release(ctxConf.authority));
    stateValue(ctxConf.store.close());
    await ctxConf.owner.release();

    // Wait past expiresAtMs!
    await new Promise<void>(r => setTimeout(r, Math.max(50, Number(confSavedOut.verdict.expiresAtMs) - Date.now() + 50)));
    if (confBound.ok) {
      const confRecBody: Record<string, unknown> = {
        version: 1,
        kind: 'benchmark_verdict',
        storeId: confView.storeId,
        runId: confirmedRunId,
        lockHash: confView.lockHash,
        operationId: checkedConf.operationId,
        dispatchId: confOp.dispatch!.dispatchId,
        dispatchGeneration: confOp.dispatch!.generation,
        gateId: 'sm90-gemm-gate',
        checkId: 'kernel-bench',
        candidateDigest: confBound.value.candidateDigest.hex,
        status: 'approved',
        reason: null,
        expiresAtMs: confSavedOut.verdict.expiresAtMs,
        preemptionCount: 0,
        hardwareProvenance: makeProvenance(),
        metrics: { latency_us: 41.0 },
      };
      const confRecPath = join(tmpdir(), `lw-fp2-conf-replay-${process.pid}.json`);
      await writeFile(
        confRecPath,
        JSON.stringify({ ...confRecBody, signature: signBenchmarkVerdict(BENCH_SECRET, confRecBody) }),
        { mode: 0o600 },
      );
      const acceptedReplay = await reconcileCycle({
        configuration: fTtl.loaded,
        runRoot: fTtl.runRoot,
        runId: confirmedRunId,
        receipt: confRecPath,
      });
      assert.equal(acceptedReplay.ok && acceptedReplay.value.kind === 'settled' && acceptedReplay.value.status === 'completed', true);
      await rm(confRecPath, { force: true });
    }
  } finally {
    if (fTtl) await fTtl.cleanup();
    await new Promise<void>(r => {
      shortTtlServer.closeAllConnections();
      shortTtlServer.close(() => r());
    });
  }

  // 4. P8: Confirmed replay of Slot A when Slot B has a verify.0.<ordinalB>.pre checkpoint with NO SQLite operation yet
  // performs ZERO network POSTs and does NOT advance or dispatch Slot B!
  let siblingPosts = 0;
  let slotAVerdictBody: Record<string, unknown> | null = null;
  const siblingServer = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'PUT') {
        for await (const c of req) void c;
        res.writeHead(201).end();
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/benchmark/jobs') {
        siblingPosts++;
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        const v: Record<string, unknown> = {
          version: 1,
          kind: 'benchmark_verdict',
          storeId: parsed.storeId,
          runId: parsed.runId,
          lockHash: parsed.lockHash,
          operationId: parsed.operationId,
          dispatchId: parsed.dispatchId,
          dispatchGeneration: parsed.dispatchGeneration,
          gateId: parsed.gateId,
          checkId: parsed.checkId,
          candidateDigest: parsed.candidateDigest,
          status: 'approved',
          reason: null,
          expiresAtMs: String(Date.now() + 600_000),
          preemptionCount: 0,
          hardwareProvenance: makeProvenance(),
          metrics: { latency_us: 37.0 },
        };
        if (parsed.checkId === 'bench-a') slotAVerdictBody = v;
        const b = Buffer.from(JSON.stringify(v), 'utf8');
        res.writeHead(200, { 'content-type': 'application/json', 'x-loopwright-signature': signPayload(BENCH_SECRET, b) });
        res.end(b);
        return;
      }
      res.writeHead(404).end();
    })();
  });
  await new Promise<void>(r => siblingServer.listen(0, '127.0.0.1', () => r()));
  let fSib: Awaited<ReturnType<typeof benchmarkReconcileFixture>> | null = null;
  try {
    const sibPort = (siblingServer.address() as { port: number }).port;
    fSib = await benchmarkReconcileFixture(`http://127.0.0.1:${sibPort}/v1/benchmark/jobs`);
    const installed = await installedHandlerDigests();
    setFixture(fSib.registry, ['spec', 'handlers'], [
      fSib.registry.spec.handlers[0]!,
      {
        id: 'bench-a',
        kind: 'check',
        implementation: 'benchmark-gate.v1',
        version: 1,
        digest: installed['benchmark-gate.v1'],
        parameters: { checkId: 'bench-a', endpointRef: 'gpu-relay', gateId: 'gate-a', heldOutWorkloadId: 'wl-1' },
        capabilities: ['hardware_execution', 'read_only'],
      },
      {
        id: 'bench-b',
        kind: 'check',
        implementation: 'benchmark-gate.v1',
        version: 1,
        digest: installed['benchmark-gate.v1'],
        parameters: { checkId: 'bench-b', endpointRef: 'gpu-relay', gateId: 'gate-b', heldOutWorkloadId: 'wl-1' },
        capabilities: ['hardware_execution', 'read_only'],
      },
      fSib.registry.spec.handlers[2]!,
      fSib.registry.spec.handlers[3]!,
    ]);
    setFixture(fSib.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'step-a', kind: 'check', uses: 'bench-a', roleId: null, dependsOn: [] },
      { id: 'step-b', kind: 'check', uses: 'bench-b', roleId: null, dependsOn: ['step-a'] },
    ]);
    setFixture(fSib.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'step-a', handlerRef: 'bench-a' },
      { stepId: 'step-b', handlerRef: 'bench-b' },
    ]);
    setFixture(fSib.config, ['spec', 'task', 'spec', 'acceptance'], {
      required: ['bench-a', 'bench-b'],
      checks: [
        { id: 'bench-a', allowedEvidenceLevels: ['hardware_execution'], targetCellId: 'cuda-sm90' },
        { id: 'bench-b', allowedEvidenceLevels: ['hardware_execution'], targetCellId: 'cuda-sm90' },
      ],
    });
    await fSib.save();
    const loadedSib = await fSib.load();
    assert.equal(loadedSib.ok, true);

    if (loadedSib.ok) {
      const sibRunId = 'run-fp2-p8-sibling-pre-intent';
      const ctxSib = await createCycle({ configuration: loadedSib.value, repository: fSib.repository, runRoot: fSib.runRoot, runId: sibRunId }, {});
      const cycleSib = new Cycle(ctxSib);
      await cycleSib.bootstrap();
      const resA = await cycleSib.runVerifier('check.bench-a');
      assert.equal(resA.status, 'passed');

      // Publish Slot B's verify.0.<ordinalB>.pre checkpoint WITHOUT calling putIntent (no SQLite operation for Slot B!)
      const ordinalB = ctxSib.plan.verifierSlots.findIndex(s => s.id === 'check.bench-b');
      const nonceB = randomBytes(16).toString('hex');
      const jobB = prepareBenchmarkGate(
        ctxSib.plan,
        ctxSib.lock,
        'check.bench-b',
        cycleSib.candidate,
        0,
        nonceB,
        loadedSib.value.registry.spec.gateEndpoints,
      );
      await cycleSib.publish(
        {
          ...cycleSib.draft,
          stage: { ...cycleSib.draft.stage, kind: 'verifier_pre' },
          verifierReceipts: [
            ...cycleSib.draft.verifierReceipts,
            { slot: 'check.bench-b', generation: 0, operationId: jobB.operationId, producerNonce: nonceB, output: null, receipt: null },
          ],
        },
        `verify.0.${ordinalB}.pre`,
      );
      await cycleSib.deadline.dispose();
      const sibEvRef = await cycleSib.events.close();
      const sibEvOpen = await fsOpen(
        join(ctxSib.artifacts.directory, 'controller-events.open'),
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await sibEvOpen.writeFile(await readFile(join(ctxSib.artifacts.directory, sibEvRef.name)));
        await sibEvOpen.sync();
      } finally {
        await sibEvOpen.close();
      }
      stateValue(ctxSib.store.release(ctxSib.authority));
      stateValue(ctxSib.store.close());
      await ctxSib.owner.release();

      const postsBeforeReplay = siblingPosts;
      assert.equal(postsBeforeReplay, 1);
      assert.ok(slotAVerdictBody !== null);
      const capturedSlotAVerdict = slotAVerdictBody as Record<string, unknown>;
      const slotAPath = join(tmpdir(), `lw-fp2-sib-a-${process.pid}.json`);
      await writeFile(
        slotAPath,
        JSON.stringify({ ...capturedSlotAVerdict, signature: signBenchmarkVerdict(BENCH_SECRET, capturedSlotAVerdict) }),
        { mode: 0o600 },
      );

      const replayRes = await reconcileCycle({
        configuration: loadedSib.value,
        runRoot: fSib.runRoot,
        runId: sibRunId,
        receipt: slotAPath,
      });
      assert.equal(replayRes.ok, true, replayRes.ok ? '' : JSON.stringify(replayRes.error));
      if (replayRes.ok) {
        assert.equal(replayRes.value.kind, 'unresolved');
        if (replayRes.value.kind === 'unresolved') {
          assert.equal(replayRes.value.reason, 'remaining_unresolved_work');
        }
      }
      assert.equal(siblingPosts, postsBeforeReplay, 'confirmed replay of Slot A must perform ZERO network POSTs');

      const retainedSib = await readRetained({ runRoot: fSib.runRoot, runId: sibRunId });
      const sibStore = stateValue(reopenLocalRun(retainedSib.descriptor.identity));
      try {
        const opBCheck = sibStore.getOperation(jobB.operationId);
        assert.equal(!opBCheck.ok && opBCheck.error.code === 'RECORD_NOT_FOUND', true, 'Slot B must remain pre-intent without SQLite operation');
      } finally {
        stateValue(sibStore.close());
      }
      await rm(slotAPath, { force: true });
    }
  } finally {
    if (fSib) await fSib.cleanup();
    await new Promise<void>(r => {
      siblingServer.closeAllConnections();
      siblingServer.close(() => r());
    });
  }
});

test('Fix Pass #3 — unconfirmed existing-proof invalid local CAS settlement, cancelled existing-proof reconciliation, and owner cleanup', async () => {
  const cleanBlob = Buffer.from('fp3-existing-proof-cas-blob-bytes');
  const cleanSha = sha256Hex(cleanBlob);
  const relay = await startCasRelayServer(new Map([[cleanSha, cleanBlob]]), {
    outputArtifacts: [{ name: 'out/kernel.cubin', digest: { algorithm: 'sha256', hex: cleanSha }, byteLength: cleanBlob.byteLength }],
  });
  const f = await benchmarkReconcileFixture(relay.url);

  const readProofVerdict = async (runId: string): Promise<Record<string, unknown>> => {
    const artDir = join(f.runRoot, runId, 'artifacts');
    const proofName = (await readdir(artDir)).find(name => name.endsWith('.proof.json'));
    assert.ok(proofName, `expected .proof.json in ${artDir}`);
    const proof = JSON.parse(await readFile(join(artDir, proofName), 'utf8')) as { output: { name: string } };
    const saved = JSON.parse(await readFile(join(artDir, proof.output.name), 'utf8')) as { responseBytes: string };
    return JSON.parse(Buffer.from(saved.responseBytes, 'base64').toString('utf8')) as Record<string, unknown>;
  };

  try {
    // 1. Unconfirmed existing .proof.json with poisoned local CAS (mode 0o644) must settle blocked/ARTIFACT_INVALID in reconcileCycle
    // instead of stranding dispatch_uncertain.
    const crashReconcile = await injectBenchmarkCrash(f, 'run-fp3-proof-bad-cas-reconcile', 'after_proof_before_receipt');
    const proofVerdictRec = await readProofVerdict(crashReconcile.runId);
    const recBlobPath = join(f.runRoot, crashReconcile.runId, 'artifacts', 'blobs', 'sha256', cleanSha);
    await chmod(recBlobPath, 0o644);

    const recPath = join(tmpdir(), `lw-fp3-badcas-rec-${process.pid}.json`);
    await writeFile(
      recPath,
      JSON.stringify({ ...proofVerdictRec, signature: signBenchmarkVerdict(BENCH_SECRET, proofVerdictRec) }),
      { mode: 0o600 },
    );
    const settledRec = await reconcileCycle({
      configuration: f.loaded,
      runRoot: f.runRoot,
      runId: crashReconcile.runId,
      receipt: recPath,
    });
    assert.equal(settledRec.ok, true, settledRec.ok ? '' : JSON.stringify(settledRec.error));
    if (settledRec.ok) {
      assert.equal(settledRec.value.kind, 'settled');
      if (settledRec.value.kind === 'settled') {
        assert.equal(settledRec.value.status, 'blocked', 'unconfirmed existing proof with bad local CAS must settle blocked');
      }
    }
    const retainedRec = await readRetained({ runRoot: f.runRoot, runId: crashReconcile.runId });
    const recStore = stateValue(reopenLocalRun(retainedRec.descriptor.identity));
    try {
      const op = stateValue(recStore.getOperation(crashReconcile.operationId));
      assert.equal(op.state, 'confirmed', 'operation must no longer be stranded in dispatch_uncertain');
    } finally {
      stateValue(recStore.close());
    }
    await rm(recPath, { force: true });

    // 2. Unconfirmed existing .proof.json with poisoned local CAS (corrupted bytes) must settle blocked/ARTIFACT_INVALID in resumeCycleWithPorts (restore).
    const crashRestore = await injectBenchmarkCrash(f, 'run-fp3-proof-bad-cas-restore', 'after_proof_before_receipt');
    const resBlobPath = join(f.runRoot, crashRestore.runId, 'artifacts', 'blobs', 'sha256', cleanSha);
    await chmod(resBlobPath, 0o600);
    await writeFile(resBlobPath, Buffer.alloc(cleanBlob.byteLength, 0xaa), { mode: 0o400 });
    await chmod(resBlobPath, 0o400);

    const resumedBadCas = await resumeCycleWithPorts(
      {
        configuration: f.loaded,
        repository: f.repository,
        runRoot: f.runRoot,
        runId: crashRestore.runId,
      },
      {},
    );
    assert.equal(resumedBadCas.ok, true, resumedBadCas.ok ? '' : JSON.stringify(resumedBadCas.error));
    if (resumedBadCas.ok) {
      assert.equal(resumedBadCas.value.kind, 'result');
      if (resumedBadCas.value.kind === 'result') {
        assert.equal(resumedBadCas.value.result.spec.status, 'blocked');
        assert.equal(resumedBadCas.value.result.spec.verification.spec.required[0]!.detail, 'ARTIFACT_INVALID');
      }
    }
    const retainedRes = await readRetained({ runRoot: f.runRoot, runId: crashRestore.runId });
    const resStore = stateValue(reopenLocalRun(retainedRes.descriptor.identity));
    try {
      const op = stateValue(resStore.getOperation(crashRestore.operationId));
      assert.equal(op.state, 'confirmed', 'restore must settle unconfirmed poisoned-CAS operation rather than stranding');
    } finally {
      stateValue(resStore.close());
    }

    // 3. Cancelled existing-proof reconciliation must refuse CANCELLED without confirming SQLite AND must release owner cleanly so retry succeeds.
    const crashCancel = await injectBenchmarkCrash(f, 'run-fp3-proof-cancel-owner', 'after_proof_before_receipt');
    const proofVerdictCancel = await readProofVerdict(crashCancel.runId);
    const cancelRecPath = join(tmpdir(), `lw-fp3-cancel-rec-${process.pid}.json`);
    await writeFile(
      cancelRecPath,
      JSON.stringify({ ...proofVerdictCancel, signature: signBenchmarkVerdict(BENCH_SECRET, proofVerdictCancel) }),
      { mode: 0o600 },
    );
    const abortCtrl = new AbortController();
    abortCtrl.abort();
    const cancelRes = await reconcileCycle({
      configuration: f.loaded,
      runRoot: f.runRoot,
      runId: crashCancel.runId,
      receipt: cancelRecPath,
      signal: abortCtrl.signal,
    });
    assert.equal(cancelRes.ok, false);
    if (!cancelRes.ok) {
      assert.equal(cancelRes.error.code, 'CANCELLED');
    }
    const retainedCancel = await readRetained({ runRoot: f.runRoot, runId: crashCancel.runId });
    const cancelStore = stateValue(reopenLocalRun(retainedCancel.descriptor.identity));
    try {
      const op = stateValue(cancelStore.getOperation(crashCancel.operationId));
      assert.equal(op.state, 'dispatch_uncertain', 'cancelled existing-proof reconcile must NOT confirm SQLite');
    } finally {
      stateValue(cancelStore.close());
    }

    // Retry without cancellation must succeed immediately (proving local controller owner was released cleanly).
    const retryRes = await reconcileCycle({
      configuration: f.loaded,
      runRoot: f.runRoot,
      runId: crashCancel.runId,
      receipt: cancelRecPath,
    });
    assert.equal(retryRes.ok, true, retryRes.ok ? '' : JSON.stringify(retryRes.error));
    if (retryRes.ok) {
      assert.equal(retryRes.value.kind, 'settled');
      if (retryRes.value.kind === 'settled') {
        assert.equal(retryRes.value.status, 'completed');
      }
    }
    await rm(cancelRecPath, { force: true });

    // 4. Managed resumeCycleWithPorts with aborted signal must refuse CANCELLED without confirming SQLite.
    const crashResumeCancel = await injectBenchmarkCrash(f, 'run-fp3-resume-cancel', 'after_proof_before_receipt');
    const resumeAbort = new AbortController();
    resumeAbort.abort();
    const cancelledResume = await resumeCycleWithPorts(
      {
        configuration: f.loaded,
        repository: f.repository,
        runRoot: f.runRoot,
        runId: crashResumeCancel.runId,
        signal: resumeAbort.signal,
      },
      {},
    );
    assert.equal(cancelledResume.ok, false);
    if (!cancelledResume.ok) {
      assert.equal(cancelledResume.error.code, 'CANCELLED');
    }
    const retainedResCancel = await readRetained({ runRoot: f.runRoot, runId: crashResumeCancel.runId });
    const resCancelStore = stateValue(reopenLocalRun(retainedResCancel.descriptor.identity));
    try {
      const op = stateValue(resCancelStore.getOperation(crashResumeCancel.operationId));
      assert.equal(op.state, 'dispatch_uncertain', 'cancelled managed resume must NOT confirm SQLite');
    } finally {
      stateValue(resCancelStore.close());
    }

    // 5. Proof marker with special permission bit (0o1600) must be rejected by exact 0o600 marker reading.
    const crashMarkerBit = await injectBenchmarkCrash(f, 'run-fp3-marker-special-bit', 'after_proof_before_receipt');
    const markerArtDir = join(f.runRoot, crashMarkerBit.runId, 'artifacts');
    const markerProofName = (await readdir(markerArtDir)).find(name => name.endsWith('.proof.json'))!;
    const markerProofPath = join(markerArtDir, markerProofName);
    await chmod(markerProofPath, 0o1600);
    const markerCheckRes = await resumeCycleWithPorts(
      {
        configuration: f.loaded,
        repository: f.repository,
        runRoot: f.runRoot,
        runId: crashMarkerBit.runId,
      },
      {},
    );
    assert.equal(markerCheckRes.ok, false, '0o1600 proof marker must be refused');
    if (!markerCheckRes.ok) {
      assert.equal(markerCheckRes.error.code, 'RECOVERY_REQUIRED');
    }

    // 6. Mid-persistence abort during #settleTimeout (binding present, no proof) must refuse CANCELLED and leave SQLite dispatch_uncertain.
    const crashTimeoutCancel = await injectBenchmarkCrash(f, 'run-fp3-timeout-mid-cancel', 'mid_cas_pull');
    const retainedTc = await readRetained({ runRoot: f.runRoot, runId: crashTimeoutCancel.runId });
    const tcAbort = new AbortController();
    const tcOwner = await (await import('../src/ownership.js')).ControllerOwner.acquire(
      join(f.runRoot, crashTimeoutCancel.runId),
      crashTimeoutCancel.runId,
      retainedTc.plan.planDigest,
    );
    const tcStore = stateValue(reopenLocalRun(retainedTc.descriptor.identity));
    let tcAuth: import('@loopwright/state').Authority | null = null;
    try {
      const tcView = stateValue(tcStore.inspect());
      tcAuth = stateValue(
        tcStore.claim({
          ownerId: 'controller.' + tcOwner.nonce,
          expectedGeneration: tcView.owner.generation,
          expectedRevision: tcView.revision,
          mode: 'recovery',
        }),
      ).authority;
      const tcState = (await import('../src/config.js')).approvedState(f.loaded);
      const tcArtifacts = new (await import('../src/storage.js')).ArtifactStore(
        join(f.runRoot, crashTimeoutCancel.runId, 'artifacts'),
        tcOwner,
        tcState.vault,
      );
      const tcProgress = new (await import('../src/progress.js')).ProgressStore(
        tcStore,
        tcAuth,
        tcArtifacts,
        retainedTc.plan,
        retainedTc.lock,
        retainedTc.descriptor.plan,
        retainedTc.descriptor.source,
      );
      const tcHead = await tcProgress.read();
      assert.ok(tcHead);
      const tcRow = tcHead.progress.verifierReceipts[0]!;
      const tcSource = await (await import('../src/source.js')).restoreSource(
        f.repository,
        retainedTc.plan.task,
        tcOwner,
        tcArtifacts,
        retainedTc.descriptor.source,
        retainedTc.descriptor.sourceWorkspace,
        [],
      );
      const tcJob = prepareBenchmarkGate(
        retainedTc.plan,
        retainedTc.lock,
        tcRow.slot,
        { manifest: tcSource.manifest, ref: tcHead.progress.candidate.manifest, files: tcSource.artifacts },
        0,
        tcRow.producerNonce,
        f.loaded.registry.spec.gateEndpoints,
      );
      // Abort AFTER #settleTimeout has persisted its provisional timeout .proof.json on disk,
      // right when it renews before reconcileOperation (leaving a real provisional timeout proof on disk!).
      const origRenew = tcStore.renew.bind(tcStore);
      let renewCount = 0;
      (tcStore as unknown as { renew: typeof origRenew }).renew = auth => {
        renewCount++;
        const res = origRenew(auth);
        if (renewCount === 2) {
          tcAbort.abort();
        }
        return res;
      };
      const gate = new (await import('../src/benchmark-gate.js')).BenchmarkGate(
        tcStore,
        tcAuth,
        tcArtifacts,
        retainedTc.plan,
        retainedTc.lock,
        ref => tcState.vault.resolveNetworkCredential(ref),
        () => tcHead.checkpoint.subject,
        null,
      );
      await assert.rejects(() => gate.restore(tcJob, tcAbort.signal), /CANCELLED/);
      assert.equal(
        stateValue(tcStore.getOperation(crashTimeoutCancel.operationId)).state,
        'dispatch_uncertain',
        'mid-persistence abort during #settleTimeout must leave SQLite dispatch_uncertain so signed receipt can still reconcile',
      );
    } finally {
      if (tcAuth) stateValue(tcStore.release(tcAuth));
      stateValue(tcStore.close());
      await tcOwner.release();
    }

    // Verify the provisional timeout .proof.json actually exists on disk pointing to a null-verdict gate_timeout output!
    const tcArtDir = join(f.runRoot, crashTimeoutCancel.runId, 'artifacts');
    const tcProofName = (await readdir(tcArtDir)).find(name => name.endsWith('.proof.json'));
    assert.ok(tcProofName, 'expected provisional timeout .proof.json on disk before reconcileCycle');
    const tcProofPath = join(tcArtDir, tcProofName);
    const provisionalProof = JSON.parse(await readFile(tcProofPath, 'utf8')) as { output: { name: string } };
    const provisionalOut = JSON.parse(await readFile(join(tcArtDir, provisionalProof.output.name), 'utf8')) as {
      verdict: unknown;
      observation: { transport: string; casOutcome: string };
    };
    assert.equal(provisionalOut.verdict, null, 'provisional timeout proof must carry verdict: null');
    assert.equal(provisionalOut.observation.transport, 'deadline');
    assert.equal(provisionalOut.observation.casOutcome, 'gate_timeout');

    // A valid signed receipt MUST now supersede the on-disk provisional timeout .proof.json and settle completed!
    const tcVerdict: Record<string, unknown> = {
      version: 1,
      kind: 'benchmark_verdict',
      storeId: crashTimeoutCancel.storeId,
      runId: crashTimeoutCancel.runId,
      lockHash: crashTimeoutCancel.lockHash,
      operationId: crashTimeoutCancel.operationId,
      dispatchId: crashTimeoutCancel.dispatchId,
      dispatchGeneration: crashTimeoutCancel.dispatchGeneration,
      gateId: 'sm90-gemm-gate',
      checkId: 'kernel-bench',
      candidateDigest: crashTimeoutCancel.candidateDigest,
      status: 'approved',
      reason: null,
      expiresAtMs: String(Date.now() + 600_000),
      preemptionCount: 0,
      hardwareProvenance: makeProvenance(),
      metrics: { latency_us: 41.0 },
      outputArtifacts: [{ name: 'out/kernel.cubin', digest: { algorithm: 'sha256', hex: cleanSha }, byteLength: cleanBlob.byteLength }],
    };
    const tcRecPath = join(tmpdir(), `lw-fp5-timeout-supersede-${process.pid}.json`);
    await writeFile(
      tcRecPath,
      JSON.stringify({ ...tcVerdict, signature: signBenchmarkVerdict(BENCH_SECRET, tcVerdict) }),
      { mode: 0o600 },
    );
    const supersededTimeoutRes = await reconcileCycle({
      configuration: f.loaded,
      runRoot: f.runRoot,
      runId: crashTimeoutCancel.runId,
      receipt: tcRecPath,
    });
    assert.equal(
      supersededTimeoutRes.ok,
      true,
      supersededTimeoutRes.ok ? '' : JSON.stringify(supersededTimeoutRes.error),
    );
    if (supersededTimeoutRes.ok) {
      assert.equal(supersededTimeoutRes.value.kind, 'settled');
      if (supersededTimeoutRes.value.kind === 'settled') {
        assert.equal(supersededTimeoutRes.value.status, 'completed', 'signed receipt must supersede cancelled provisional timeout proof');
      }
    }
    const replacedProof = JSON.parse(await readFile(tcProofPath, 'utf8')) as { output: { name: string } };
    const replacedOut = JSON.parse(await readFile(join(tcArtDir, replacedProof.output.name), 'utf8')) as {
      verdict: { status: string } | null;
    };
    assert.equal(replacedOut.verdict?.status, 'approved', 'the same .proof.json marker must now point to the signed approved verdict');
    await rm(tcRecPath, { force: true });
  } finally {
    await f.cleanup();
    await relay.close();
  }
});
