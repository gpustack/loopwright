import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { VERIFIER_ARTIFACT_LIMITS, type HardwareProvenance } from '@loopwright/core';
import { canonicalJson } from '../src/config.js';
import {
  computeSecretScanOverlapBytes,
  EMPTY_SHA256_HEX,
  MAX_CONTROL_BODY_BYTES,
  parseBenchmarkRequest,
  signBenchmarkVerdict,
  signRelayPayload,
  startRelayServer,
  verifyBenchmarkVerdictSignature,
  verifyRelaySignature,
} from '../src/relay-server.js';
import {
  HardwareRunnerError,
  type BenchmarkRequest,
  type BenchmarkVerdict,
  type ClockSource,
  type LeaseGrant,
  type RelayServerHandle,
  type SignedBenchmarkVerdictReceipt,
} from '../src/types.js';

const CONTROLLER_SECRET = 'controller-hmac-secret-key-0123456789abcdef';
const CONTROLLER_BEARER = 'controller-auth-bearer-token-0123456789abcdef';
const WORKER_TOKEN = 'worker-pull-lease-bearer-token-0123456789abcdef';

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function makeBenchmarkRequest(overrides: Partial<BenchmarkRequest> = {}): BenchmarkRequest {
  const lockHex = sha256Hex('lock-relay-e2e');
  const contractHex = sha256Hex('contract-relay-e2e');
  const candHex = overrides.candidateDigest ?? sha256Hex('candidate-relay-e2e');
  const matrixHex = sha256Hex('matrix-relay-e2e');
  const operationId = overrides.operationId ?? 'verify.0.check.cuda-gemm';
  const reqHex = overrides.requestDigest ?? sha256Hex(`request:${operationId}`);
  return {
    version: 1,
    kind: 'benchmark_request',
    storeId: 'store-e2e',
    runId: 'run-e2e',
    lockHash: { algorithm: 'sha256', hex: lockHex },
    operationId,
    dispatchId: 'dispatch-e2e-1',
    dispatchGeneration: 1,
    requestDigest: reqHex,
    gateId: 'cuda-bench-gate',
    checkId: 'gemm-speedup',
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
    targetCellId: 'h100-sxm',
    targetHardware: {
      accelerator: 'sm_90a',
      isolationMode: 'whole_device',
      deviceCount: 1,
      driverConstraint: '>=550.54.14',
    },
    heldOutWorkloadId: 'gemm-4096-fp16',
    metricThresholds: [
      { kind: 'bounds', metric: 'max_abs_err', max: 0.001 },
      { kind: 'comparative', metric: 'tflops', baselineMetric: 'baseline_tflops', operator: 'min_ratio', threshold: 1.1 },
    ],
    maxPreemptions: 3,
    candidateArtifacts: {
      entries: [],
      deleted: ['legacy/old_kernel.cu'],
    },
    ...overrides,
  };
}

function makeProvenance(): HardwareProvenance {
  return {
    targetCellId: 'h100-sxm',
    probeKind: 'physical',
    vendor: 'NVIDIA',
    deviceModel: 'NVIDIA H100 80GB HBM3',
    accelerator: 'sm_90a',
    isolationMode: 'whole_device',
    deviceCount: 1,
    driverVersion: '550.90.07',
    runtimeVersion: '12.6',
    workloadDigest: { algorithm: 'sha256', hex: sha256Hex('heldout-gemm-4096') },
    clockLockMode: 'locked',
  };
}

async function streamHttpPutUnevenChunks(
  urlStr: string,
  headers: Readonly<Record<string, string>>,
  chunks: readonly Uint8Array[],
  onBeforeFinalChunk?: () => Promise<void>,
): Promise<{ readonly status: number; readonly bodyText: string }> {
  const parsed = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'PUT',
        headers,
      },
      res => {
        const resChunks: Buffer[] = [];
        res.on('data', (c: Buffer) => resChunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            bodyText: Buffer.concat(resChunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);

    void (async () => {
      for (let i = 0; i < chunks.length; i += 1) {
        if (i === chunks.length - 1 && onBeforeFinalChunk !== undefined) {
          await onBeforeFinalChunk();
        }
        const slice = chunks[i]!;
        const ok = req.write(slice);
        if (!ok && !req.destroyed) {
          await new Promise<void>(r => req.once('drain', r));
        }
      }
      if (!req.destroyed) {
        req.end();
      }
    })().catch(reject);
  });
}

function splitIntoUnevenChunks(payload: Buffer, sizes: readonly number[]): Buffer[] {
  const out: Buffer[] = [];
  let offset = 0;
  let idx = 0;
  while (offset < payload.byteLength) {
    const step = sizes[idx % sizes.length]!;
    const end = Math.min(payload.byteLength, offset + step);
    out.push(payload.subarray(offset, end));
    offset = end;
    idx += 1;
  }
  return out;
}

async function postSignedBenchmarkJob(
  relay: RelayServerHandle,
  requestPayload: BenchmarkRequest,
  extraPath = '',
): Promise<{ readonly status: number; readonly bytes: Uint8Array; readonly signature: string; readonly json: unknown }> {
  const rawBody = Buffer.from(canonicalJson(requestPayload), 'utf8');
  const res = await fetch(`${relay.url}/v1/benchmark/jobs${extraPath}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${CONTROLLER_BEARER}`,
      'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, rawBody),
    },
    body: new Uint8Array(rawBody),
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const signature = res.headers.get('x-loopwright-signature') ?? '';
  const json: unknown = bytes.byteLength > 0 ? JSON.parse(Buffer.from(bytes).toString('utf8')) : null;
  return { status: res.status, bytes, signature, json };
}

test('end-to-end Controller <-> Relay <-> Worker lifecycle with >1 MiB uneven-chunk CAS streaming, idempotency, and signed receipt retention', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lw-relay-e2e-'));
  const casDir = join(dir, 'cas');
  const relay = await startRelayServer({
    port: 0,
    casDir,
    controllerSigningSecret: CONTROLLER_SECRET,
    controllerAuthToken: CONTROLLER_BEARER,
    workerTokens: [WORKER_TOKEN],
    leaseTtlMs: 10_000,
    sweepIntervalMs: 500,
  });

  try {
    // 1. Worker acquire with short waitMs returns 204 when queue is empty
    const emptyAcquire = await fetch(`${relay.url}/v1/runner/leases:acquire`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${WORKER_TOKEN}`,
      },
      body: JSON.stringify({
        workerId: 'worker-01',
        capabilities: {
          accelerator: 'sm_90a',
          isolationModes: ['whole_device'],
          deviceCount: 1,
          driverVersion: '550.90.07',
        },
        waitMs: 30,
      }),
    });
    assert.equal(emptyAcquire.status, 204);

    // 2. Controller stages > 1 MiB (2.25 MiB) candidate input blob in uneven chunks
    const inputBytes = Buffer.alloc(2_359_296);
    for (let i = 0; i < inputBytes.byteLength; i += 4096) {
      randomBytes(64).copy(inputBytes, i, 0, Math.min(64, inputBytes.byteLength - i));
    }
    const inputSha = sha256Hex(inputBytes);
    const operationId = 'verify.0.check.cuda-gemm';
    const putSig = signRelayPayload(
      CONTROLLER_SECRET,
      `PUT\n${operationId}\n${inputSha}\n${inputBytes.byteLength}`,
    );
    const inputChunks = splitIntoUnevenChunks(inputBytes, [71_311, 524_289, 1_100_003, 19, 663_674]);

    const stageRes1 = await streamHttpPutUnevenChunks(
      `${relay.url}/v1/benchmark/jobs/${operationId}/blobs/${inputSha}`,
      {
        authorization: `Bearer ${CONTROLLER_BEARER}`,
        'x-loopwright-blob-sha256': inputSha,
        'x-loopwright-blob-length': String(inputBytes.byteLength),
        'x-loopwright-signature': putSig,
      },
      inputChunks,
    );
    assert.equal(stageRes1.status, 201);

    // Verify CAS blob inode invariants (regular file, nlink === 1, mode 0o400)
    const casInputStat = await lstat(join(casDir, 'blobs', 'sha256', inputSha));
    assert.equal(casInputStat.isFile(), true);
    assert.equal(casInputStat.isSymbolicLink(), false);
    assert.equal(casInputStat.nlink, 1);
    assert.equal(casInputStat.mode & 0o777, 0o400);

    // Re-staging same blob is idempotent (200)
    const stageRes2 = await streamHttpPutUnevenChunks(
      `${relay.url}/v1/benchmark/jobs/${operationId}/blobs/${inputSha}`,
      {
        authorization: `Bearer ${CONTROLLER_BEARER}`,
        'x-loopwright-blob-sha256': inputSha,
        'x-loopwright-blob-length': String(inputBytes.byteLength),
        'x-loopwright-signature': putSig,
      },
      [inputBytes],
    );
    assert.equal(stageRes2.status, 200);

    // 3. Start worker long-poll BEFORE submitting job so long-poll wakes immediately on enqueue
    const longPollPromise = fetch(`${relay.url}/v1/runner/leases:acquire`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${WORKER_TOKEN}`,
      },
      body: JSON.stringify({
        workerId: 'worker-01',
        capabilities: {
          accelerator: 'sm_90a',
          isolationModes: ['whole_device'],
          deviceCount: 2,
          driverVersion: '550.90.07',
          workloadIds: ['gemm-4096-fp16'],
        },
        waitMs: 5_000,
      }),
    });

    const benchReq = makeBenchmarkRequest({
      operationId,
      candidateArtifacts: {
        entries: [
          {
            name: 'src/gemm_kernel.cu',
            digest: { algorithm: 'sha256', hex: inputSha },
            byteLength: inputBytes.byteLength,
          },
        ],
        deleted: ['legacy/old_kernel.cu'],
      },
    });

    const post1 = await postSignedBenchmarkJob(relay, benchReq);
    assert.equal(post1.status, 200);
    assert.equal(verifyRelaySignature(CONTROLLER_SECRET, post1.bytes, post1.signature), true);
    const pendingVerdict = post1.json as BenchmarkVerdict;
    assert.equal(pendingVerdict.status, 'pending');
    assert.equal(pendingVerdict.preemptionCount, 0);
    assert.equal(Object.hasOwn(pendingVerdict as unknown as Record<string, unknown>, 'signature'), false);

    // Duplicate identical POST is idempotent (200); conflicting requestDigest for same operationId returns 409
    const postDup = await postSignedBenchmarkJob(relay, benchReq);
    assert.equal(postDup.status, 200);
    const postConflict = await postSignedBenchmarkJob(
      relay,
      makeBenchmarkRequest({
        ...benchReq,
        requestDigest: sha256Hex('conflicting-digest'),
      }),
    );
    assert.equal(postConflict.status, 409);

    // 4. Worker receives woken lease grant without controller secrets
    const acquireRes = await longPollPromise;
    assert.equal(acquireRes.status, 200);
    const rawGrantText = await acquireRes.text();
    assert.equal(rawGrantText.includes(CONTROLLER_SECRET), false);
    assert.equal(rawGrantText.includes(CONTROLLER_BEARER), false);
    const grant = JSON.parse(rawGrantText) as LeaseGrant;
    assert.equal(grant.relayBootId, relay.relayBootId);
    assert.equal(grant.operationId, operationId);
    assert.equal(grant.leaseEpoch, 1);

    // 5. Worker heartbeats and downloads > 1 MiB input blob
    const hbRes = await fetch(`${relay.url}/v1/runner/leases/${grant.jobId}:heartbeat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${WORKER_TOKEN}`,
      },
      body: JSON.stringify({
        relayBootId: grant.relayBootId,
        leaseEpoch: grant.leaseEpoch,
        leaseToken: grant.leaseToken,
        state: 'running',
      }),
    });
    assert.equal(hbRes.status, 200);
    assert.deepEqual(await hbRes.json(), { desiredState: 'running', leaseTtlMs: 10_000 });

    const workerGetBlob = await fetch(`${relay.url}/v1/runner/leases/${grant.jobId}/blobs/${inputSha}`, {
      headers: {
        authorization: `Bearer ${WORKER_TOKEN}`,
        'x-loopwright-relay-boot-id': grant.relayBootId,
        'x-loopwright-lease-epoch': String(grant.leaseEpoch),
        'x-loopwright-lease-token': grant.leaseToken,
      },
    });
    assert.equal(workerGetBlob.status, 200);
    const downloadedInput = Buffer.from(await workerGetBlob.arrayBuffer());
    assert.equal(downloadedInput.equals(inputBytes), true);

    // 6. Worker uploads > 1 MiB Stage A binary .cubin output in uneven chunks
    const cubinBytes = Buffer.alloc(2_150_400);
    // Include arbitrary high-bit binary bytes (0x00, 0xff, 0x80) to verify binary preservation
    cubinBytes[0] = 0x7f;
    cubinBytes[1] = 0x45;
    cubinBytes[2] = 0x4c;
    cubinBytes[3] = 0x46;
    cubinBytes[4] = 0xff;
    cubinBytes[5] = 0xfe;
    for (let i = 64; i < cubinBytes.byteLength; i += 8192) {
      randomBytes(64).copy(cubinBytes, i, 0, Math.min(64, cubinBytes.byteLength - i));
    }
    const cubinSha = sha256Hex(cubinBytes);
    const cubinUpload = await streamHttpPutUnevenChunks(
      `${relay.url}/v1/runner/leases/${grant.jobId}/blobs/${cubinSha}`,
      {
        authorization: `Bearer ${WORKER_TOKEN}`,
        'x-loopwright-relay-boot-id': grant.relayBootId,
        'x-loopwright-lease-epoch': String(grant.leaseEpoch),
        'x-loopwright-lease-token': grant.leaseToken,
        'x-loopwright-blob-sha256': cubinSha,
        'x-loopwright-blob-length': String(cubinBytes.byteLength),
      },
      splitIntoUnevenChunks(cubinBytes, [99_991, 1_048_576, 400_001, 601_832]),
    );
    assert.equal(cubinUpload.status, 201);

    // 7. Start Controller wait-poll and complete lease on Worker
    const controllerWaitPromise = postSignedBenchmarkJob(relay, benchReq, '?waitMs=5000');

    const completeRes = await fetch(`${relay.url}/v1/runner/leases/${grant.jobId}:complete`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${WORKER_TOKEN}`,
      },
      body: JSON.stringify({
        relayBootId: grant.relayBootId,
        leaseEpoch: grant.leaseEpoch,
        leaseToken: grant.leaseToken,
        status: 'approved',
        reason: null,
        detail: 'Stage A compiled and Stage B passed blind GEMM accuracy + speedup bounds',
        metrics: {
          max_abs_err: 0.00012,
          tflops: 712.5,
          baseline_tflops: 580.0,
        },
        findings: [],
        hardwareProvenance: makeProvenance(),
        outputArtifacts: [
          {
            name: 'stage-a/gemm_sm90a.cubin',
            digest: { algorithm: 'sha256', hex: cubinSha },
            byteLength: cubinBytes.byteLength,
            mediaType: 'application/octet-stream',
          },
        ],
      }),
    });
    assert.equal(completeRes.status, 200);

    const settledPost = await controllerWaitPromise;
    assert.equal(settledPost.status, 200);
    assert.equal(verifyRelaySignature(CONTROLLER_SECRET, settledPost.bytes, settledPost.signature), true);
    const approvedVerdict = settledPost.json as BenchmarkVerdict;
    assert.equal(approvedVerdict.status, 'approved');
    assert.equal(approvedVerdict.reason, null);
    assert.equal(approvedVerdict.outputArtifacts?.length, 1);
    assert.equal(approvedVerdict.outputArtifacts?.[0]?.digest.hex, cubinSha);

    // 8. Controller pulls committed Stage A .cubin output blob and verifies BLOB HMAC signature
    const getOutSig = signRelayPayload(CONTROLLER_SECRET, `GET\n${operationId}\n${cubinSha}`);
    const pullRes = await fetch(`${relay.url}/v1/benchmark/jobs/${operationId}/blobs/${cubinSha}`, {
      headers: {
        authorization: `Bearer ${CONTROLLER_BEARER}`,
        'x-loopwright-signature': getOutSig,
      },
    });
    assert.equal(pullRes.status, 200);
    const expectedBlobSig = signRelayPayload(
      CONTROLLER_SECRET,
      `BLOB\n${operationId}\n${cubinSha}\n${cubinBytes.byteLength}`,
    );
    assert.equal(verifyRelaySignature(CONTROLLER_SECRET, `BLOB\n${operationId}\n${cubinSha}\n${cubinBytes.byteLength}`, pullRes.headers.get('x-loopwright-signature') ?? ''), true);
    assert.equal(pullRes.headers.get('x-loopwright-signature'), expectedBlobSig);
    const pulledCubin = Buffer.from(await pullRes.arrayBuffer());
    assert.equal(pulledCubin.equals(cubinBytes), true);

    // Cross-job output blob read for another operationId is rejected with 403
    const otherOp = 'verify.0.check.other-job';
    const crossReadRes = await fetch(`${relay.url}/v1/benchmark/jobs/${otherOp}/blobs/${cubinSha}`, {
      headers: {
        authorization: `Bearer ${CONTROLLER_BEARER}`,
        'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, `GET\n${otherOp}\n${cubinSha}`),
      },
    });
    assert.equal(crossReadRes.status, 403);

    // 9. Verify persisted <casDir>/receipts/<operationId>.json signature and mode 0o600
    const receiptPath = join(casDir, 'receipts', `${operationId}.json`);
    const receiptStat = await lstat(receiptPath);
    assert.equal(receiptStat.mode & 0o777, 0o600);
    const receiptJson = JSON.parse(await readFile(receiptPath, 'utf8')) as SignedBenchmarkVerdictReceipt;
    assert.equal(receiptJson.operationId, operationId);
    assert.equal(receiptJson.status, 'approved');
    assert.equal(
      verifyBenchmarkVerdictSignature(
        CONTROLLER_SECRET,
        receiptJson as unknown as Record<string, unknown>,
        receiptJson.signature,
      ),
      true,
    );
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('auth isolation, HMAC tamper rejection, early 64 KiB body cap (413), and strict JSON guards', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lw-relay-auth-'));
  const relay = await startRelayServer({
    port: 0,
    casDir: join(dir, 'cas'),
    controllerSigningSecret: CONTROLLER_SECRET,
    controllerAuthToken: CONTROLLER_BEARER,
    workerTokens: [WORKER_TOKEN],
  });

  try {
    const req = makeBenchmarkRequest({ operationId: 'verify.0.check.sec' });
    const rawBody = Buffer.from(canonicalJson(req), 'utf8');

    // Tampered HMAC rejected (401)
    const tamperedSig = await fetch(`${relay.url}/v1/benchmark/jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${CONTROLLER_BEARER}`,
        'x-loopwright-signature': '0'.repeat(64),
      },
      body: new Uint8Array(rawBody),
    });
    assert.equal(tamperedSig.status, 401);

    // Worker token cannot authenticate against Controller endpoint (401)
    const workerOnController = await fetch(`${relay.url}/v1/benchmark/jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${WORKER_TOKEN}`,
        'x-loopwright-signature': signRelayPayload(WORKER_TOKEN, rawBody),
      },
      body: new Uint8Array(rawBody),
    });
    assert.equal(workerOnController.status, 401);

    // Controller secret/bearer cannot authenticate against Worker endpoint (401)
    const controllerOnWorker = await fetch(`${relay.url}/v1/runner/leases:acquire`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${CONTROLLER_BEARER}`,
      },
      body: JSON.stringify({
        workerId: 'spoof',
        capabilities: {
          accelerator: 'sm_90a',
          isolationModes: ['whole_device'],
          deviceCount: 1,
          driverVersion: '550.90.07',
        },
      }),
    });
    assert.equal(controllerOnWorker.status, 401);

    // Early 64 KiB cap with Content-Length > 65536 -> 413
    const oversizedBuf = Buffer.alloc(MAX_CONTROL_BODY_BYTES + 1, 0x20);
    const clOversized = await fetch(`${relay.url}/v1/benchmark/jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${CONTROLLER_BEARER}`,
        'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, oversizedBuf),
      },
      body: new Uint8Array(oversizedBuf),
    });
    assert.equal(clOversized.status, 413);

    // Early 64 KiB cap with Transfer-Encoding: chunked (no Content-Length) -> 413
    const parsed = new URL(`${relay.url}/v1/runner/leases:acquire`);
    const chunkedStatus = await new Promise<number>((resolve, reject) => {
      const cReq = httpRequest(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${WORKER_TOKEN}`,
          },
        },
        res => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      cReq.on('error', reject);
      cReq.write(Buffer.alloc(40_000, 0x20));
      cReq.write(Buffer.alloc(30_000, 0x20));
      cReq.end();
    });
    assert.equal(chunkedStatus, 413);

    // Strict JSON control route rejects -0, unknown keys, and lone surrogates with 400
    for (const badBody of [
      '{"workerId":"w1","waitMs":-0,"capabilities":{"accelerator":"sm_90a","isolationModes":["whole_device"],"deviceCount":1,"driverVersion":"550.0"}}',
      '{"workerId":"w1","unknown":1,"capabilities":{"accelerator":"sm_90a","isolationModes":["whole_device"],"deviceCount":1,"driverVersion":"550.0"}}',
      '{"workerId":"w1\\uD800","capabilities":{"accelerator":"sm_90a","isolationModes":["whole_device"],"deviceCount":1,"driverVersion":"550.0"}}',
    ]) {
      const badRes = await fetch(`${relay.url}/v1/runner/leases:acquire`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${WORKER_TOKEN}`,
        },
        body: badBody,
      });
      assert.equal(badRes.status, 400);
    }
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('SSE cancel watch, 409 QUEUE_LEASE_FENCED on stale epoch/bootId (including mid-upload blob commit), and cross-chunk SecretScrubber binary reject (422)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lw-relay-fence-'));
  const casDir = join(dir, 'cas');
  const relay = await startRelayServer({
    port: 0,
    casDir,
    controllerSigningSecret: CONTROLLER_SECRET,
    workerTokens: [WORKER_TOKEN],
    leaseTtlMs: 10_000,
  });

  try {
    const benchReq = makeBenchmarkRequest({
      operationId: 'verify.0.check.fence-and-scrub',
      maxPreemptions: 1,
    });
    const rawReq = Buffer.from(canonicalJson(benchReq), 'utf8');
    const subRes = await fetch(`${relay.url}/v1/benchmark/jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, rawReq),
      },
      body: new Uint8Array(rawReq),
    });
    assert.equal(subRes.status, 200);

    // Worker 1 acquires epoch 1
    const acq1 = await fetch(`${relay.url}/v1/runner/leases:acquire`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${WORKER_TOKEN}`,
      },
      body: JSON.stringify({
        workerId: 'worker-1',
        capabilities: {
          accelerator: 'sm_90a',
          isolationModes: ['whole_device'],
          deviceCount: 1,
          driverVersion: '550.90.07',
        },
      }),
    });
    const grant1 = (await acq1.json()) as LeaseGrant;
    assert.equal(grant1.leaseEpoch, 1);

    // SSE rejects query-string tokens (400) and streams state + cancel events via headers
    const badQuerySse = await fetch(`${relay.url}/v1/runner/leases/${grant1.jobId}/events?leaseToken=${grant1.leaseToken}`, {
      headers: { authorization: `Bearer ${WORKER_TOKEN}` },
    });
    assert.equal(badQuerySse.status, 400);

    const sseRes = await fetch(`${relay.url}/v1/runner/leases/${grant1.jobId}/events`, {
      headers: {
        authorization: `Bearer ${WORKER_TOKEN}`,
        'x-loopwright-relay-boot-id': grant1.relayBootId,
        'x-loopwright-lease-epoch': String(grant1.leaseEpoch),
        'x-loopwright-lease-token': grant1.leaseToken,
      },
    });
    assert.equal(sseRes.status, 200);
    const sseCollector = (async () => {
      const dec = new TextDecoder();
      let acc = '';
      for await (const chunk of sseRes.body!) {
        acc += dec.decode(chunk as Uint8Array, { stream: true });
      }
      return acc;
    })();

    // Mid-upload fencing: Worker 1 starts streaming an output blob, gets preempted before final chunk, and commit fails with 409!
    const fencedBlob = Buffer.concat([Buffer.from('ELF-STAGE-A-PART-1'), Buffer.alloc(65_536, 0xaa)]);
    const fencedSha = sha256Hex(fencedBlob);
    const midUploadPromise = streamHttpPutUnevenChunks(
      `${relay.url}/v1/runner/leases/${grant1.jobId}/blobs/${fencedSha}`,
      {
        authorization: `Bearer ${WORKER_TOKEN}`,
        'x-loopwright-relay-boot-id': grant1.relayBootId,
        'x-loopwright-lease-epoch': String(grant1.leaseEpoch),
        'x-loopwright-lease-token': grant1.leaseToken,
        'x-loopwright-blob-sha256': fencedSha,
        'x-loopwright-blob-length': String(fencedBlob.byteLength),
      },
      [fencedBlob.subarray(0, 32_768), fencedBlob.subarray(32_768)],
      async () => {
        const preemptRes = await fetch(`${relay.url}/v1/runner/leases/${grant1.jobId}:preempt`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${WORKER_TOKEN}`,
          },
          body: JSON.stringify({
            relayBootId: grant1.relayBootId,
            leaseEpoch: grant1.leaseEpoch,
            leaseToken: grant1.leaseToken,
            reason: 'Kueue eviction',
          }),
        });
        assert.equal(preemptRes.status, 200);
      },
    );

    const midUploadResult = await midUploadPromise;
    assert.equal(midUploadResult.status, 409);
    assert.equal(JSON.parse(midUploadResult.bodyText).code, 'QUEUE_LEASE_FENCED');

    // Verify SSE emitted both running and cancel events and closed cleanly
    const sseText = await sseCollector;
    assert.ok(sseText.includes('event: state\ndata: {"desiredState":"running"}'));
    assert.ok(sseText.includes('event: cancel\ndata: {"desiredState":"cancel"}'));

    // Verify fenced upload recorded ZERO output authorization (403/404 on controller GET, never 200)
    const fencedCtrlGet = await fetch(
      `${relay.url}/v1/benchmark/jobs/verify.0.check.fence-and-scrub/blobs/${fencedSha}`,
      {
        headers: {
          'x-loopwright-signature': signRelayPayload(
            CONTROLLER_SECRET,
            `GET\nverify.0.check.fence-and-scrub\n${fencedSha}`,
          ),
        },
      },
    );
    assert.ok(fencedCtrlGet.status === 403 || fencedCtrlGet.status === 404);

    // Worker 2 acquires epoch 2
    const acq2 = await fetch(`${relay.url}/v1/runner/leases:acquire`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${WORKER_TOKEN}`,
      },
      body: JSON.stringify({
        workerId: 'worker-2',
        capabilities: {
          accelerator: 'sm_90a',
          isolationModes: ['whole_device'],
          deviceCount: 1,
          driverVersion: '550.90.07',
        },
      }),
    });
    const grant2 = (await acq2.json()) as LeaseGrant;
    assert.equal(grant2.leaseEpoch, 2);

    // Stale epoch 1 and fake restarted relayBootId are rejected with 409 QUEUE_LEASE_FENCED
    for (const badCreds of [
      { relayBootId: grant1.relayBootId, leaseEpoch: grant1.leaseEpoch, leaseToken: grant1.leaseToken },
      { relayBootId: 'f'.repeat(32), leaseEpoch: grant2.leaseEpoch, leaseToken: grant2.leaseToken },
    ]) {
      const badComplete = await fetch(`${relay.url}/v1/runner/leases/${grant2.jobId}:complete`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${WORKER_TOKEN}`,
        },
        body: JSON.stringify({
          ...badCreds,
          status: 'approved',
          reason: null,
          hardwareProvenance: makeProvenance(),
        }),
      });
      assert.equal(badComplete.status, 409);
      assert.equal(((await badComplete.json()) as { code: string }).code, 'QUEUE_LEASE_FENCED');
    }

    // Cross-chunk binary SecretScrubber check: split CONTROLLER_SECRET right across two binary chunks -> 422 ARTIFACT_INVALID!
    const secretBytes = Buffer.from(CONTROLLER_SECRET, 'utf8');
    const half = Math.floor(secretBytes.byteLength / 2);
    const binPrefix = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0xff, 0x00, 0xfe]);
    const binSuffix = Buffer.from([0x00, 0xff, 0xab, 0xcd]);
    const chunkA = Buffer.concat([binPrefix, Buffer.alloc(32_000, 0x90), secretBytes.subarray(0, half)]);
    const chunkB = Buffer.concat([secretBytes.subarray(half), Buffer.alloc(16_000, 0x90), binSuffix]);
    const leakyTotal = Buffer.concat([chunkA, chunkB]);
    const leakySha = sha256Hex(leakyTotal);

    const scrubReject = await streamHttpPutUnevenChunks(
      `${relay.url}/v1/runner/leases/${grant2.jobId}/blobs/${leakySha}`,
      {
        authorization: `Bearer ${WORKER_TOKEN}`,
        'x-loopwright-relay-boot-id': grant2.relayBootId,
        'x-loopwright-lease-epoch': String(grant2.leaseEpoch),
        'x-loopwright-lease-token': grant2.leaseToken,
        'x-loopwright-blob-sha256': leakySha,
        'x-loopwright-blob-length': String(leakyTotal.byteLength),
      },
      [chunkA, chunkB],
    );
    assert.equal(scrubReject.status, 422);
    assert.equal(JSON.parse(scrubReject.bodyText).code, 'ARTIFACT_INVALID');
    await assert.rejects(() => lstat(join(casDir, 'blobs', 'sha256', leakySha)));

    // Preempting epoch 2 (exceeding maxPreemptions=1) settles BENCHMARK_PREEMPTED and writes signed reconcile receipt
    const exhaustRes = await fetch(`${relay.url}/v1/runner/leases/${grant2.jobId}:preempt`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${WORKER_TOKEN}`,
      },
      body: JSON.stringify({
        relayBootId: grant2.relayBootId,
        leaseEpoch: grant2.leaseEpoch,
        leaseToken: grant2.leaseToken,
      }),
    });
    assert.equal(exhaustRes.status, 200);
    assert.deepEqual(await exhaustRes.json(), { status: 'preempted_exhausted', preemptionCount: 1 });

    const receiptRaw = JSON.parse(
      await readFile(join(casDir, 'receipts', 'verify.0.check.fence-and-scrub.json'), 'utf8'),
    ) as SignedBenchmarkVerdictReceipt;
    assert.equal(receiptRaw.status, 'expired');
    assert.equal(receiptRaw.reason, 'BENCHMARK_PREEMPTED');
    assert.equal(receiptRaw.retryablePreemption, true);
    assert.equal(receiptRaw.preemptionCount, 1);
    assert.equal(
      verifyBenchmarkVerdictSignature(
        CONTROLLER_SECRET,
        receiptRaw as unknown as Record<string, unknown>,
        receiptRaw.signature,
      ),
      true,
    );
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('baseTree anchor, denied verdict with structured findings, cross-job worker blob isolation, capacity/404/405 guards, and HTTPS TLS loopback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lw-relay-tls-'));
  const certPath = join(dir, 'relay.crt');
  const keyPath = join(dir, 'relay.key');
  execFileSync('openssl', [
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
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore' });

  const certPem = await readFile(certPath);
  const tlsRelay = await startRelayServer({
    port: 0,
    casDir: join(dir, 'tls-cas'),
    controllerSigningSecret: CONTROLLER_SECRET,
    workerTokens: [WORKER_TOKEN],
    tls: { certPath, keyPath, caPath: certPath },
  });

  const httpRelay = await startRelayServer({
    port: 0,
    casDir: join(dir, 'http-cas'),
    controllerSigningSecret: CONTROLLER_SECRET,
    workerTokens: [WORKER_TOKEN],
    maxJobs: 2,
    maxBlobBytes: 1_048_576,
    verdictTtlMs: 30_000,
    sweepIntervalMs: 500,
  });

  try {
    // 1. Verify HTTPS TLS relay responds cleanly with 204 on worker acquire
    assert.equal(tlsRelay.url.startsWith('https://'), true);
    const tlsStatus = await new Promise<number>((resolve, reject) => {
      const parsed = new URL(`${tlsRelay.url}/v1/runner/leases:acquire`);
      const body = Buffer.from(
        JSON.stringify({
          workerId: 'tls-worker',
          capabilities: {
            accelerator: 'sm_90a',
            isolationModes: ['whole_device'],
            deviceCount: 1,
            driverVersion: '550.90.07',
          },
          waitMs: 0,
        }),
      );
      const req = httpsRequest(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname,
          method: 'POST',
          ca: certPem,
          headers: {
            'content-type': 'application/json',
            'content-length': String(body.byteLength),
            authorization: `Bearer ${WORKER_TOKEN}`,
          },
        },
        res => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end(body);
    });
    assert.equal(tlsStatus, 204);

    // 2. Stage blob under opA, then submit opB with baseTree anchor and verify cross-job worker read is 403 and unknown is 404
    const blobOpA = Buffer.from('private-to-op-a');
    const shaOpA = sha256Hex(blobOpA);
    const stageOpA = await streamHttpPutUnevenChunks(
      `${httpRelay.url}/v1/benchmark/jobs/op-a/blobs/${shaOpA}`,
      {
        'x-loopwright-blob-sha256': shaOpA,
        'x-loopwright-blob-length': String(blobOpA.byteLength),
        'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, `PUT\nop-a\n${shaOpA}\n${blobOpA.byteLength}`),
      },
      [blobOpA],
    );
    assert.equal(stageOpA.status, 201);

    const reqA = makeBenchmarkRequest({
      operationId: 'op-a',
      candidateArtifacts: {
        entries: [{ name: 'src/a.cu', digest: { algorithm: 'sha256', hex: shaOpA }, byteLength: blobOpA.byteLength }],
        deleted: [],
        baseTree: {
          objectFormat: 'sha1',
          commitOid: 'a'.repeat(40),
          treeOid: 'b'.repeat(40),
        },
      },
    });
    const reqB = makeBenchmarkRequest({ operationId: 'op-b' });
    for (const r of [reqA, reqB]) {
      const raw = Buffer.from(canonicalJson(r), 'utf8');
      const res = await fetch(`${httpRelay.url}/v1/benchmark/jobs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, raw),
        },
        body: new Uint8Array(raw),
      });
      assert.equal(res.status, 200);
    }

    // 3rd job exceeds maxJobs=2 -> 429
    const reqC = makeBenchmarkRequest({ operationId: 'op-c' });
    const rawC = Buffer.from(canonicalJson(reqC), 'utf8');
    const capRes = await fetch(`${httpRelay.url}/v1/benchmark/jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, rawC),
      },
      body: new Uint8Array(rawC),
    });
    assert.equal(capRes.status, 429);

    // Acquire op-a and op-b; worker holding op-b cannot read op-a's staged blob (403) or unknown blob (404)
    const acqA = await fetch(`${httpRelay.url}/v1/runner/leases:acquire`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
      body: JSON.stringify({
        workerId: 'w-a',
        capabilities: { accelerator: 'sm_90a', isolationModes: ['whole_device'], deviceCount: 1, driverVersion: '550.90.07' },
      }),
    });
    const grantA = (await acqA.json()) as LeaseGrant;
    assert.equal(grantA.operationId, 'op-a');

    const acqB = await fetch(`${httpRelay.url}/v1/runner/leases:acquire`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
      body: JSON.stringify({
        workerId: 'w-b',
        capabilities: { accelerator: 'sm_90a', isolationModes: ['whole_device'], deviceCount: 1, driverVersion: '550.90.07' },
      }),
    });
    const grantB = (await acqB.json()) as LeaseGrant;
    assert.equal(grantB.operationId, 'op-b');

    const crossWorkerGet = await fetch(`${httpRelay.url}/v1/runner/leases/${grantB.jobId}/blobs/${shaOpA}`, {
      headers: {
        authorization: `Bearer ${WORKER_TOKEN}`,
        'x-loopwright-relay-boot-id': grantB.relayBootId,
        'x-loopwright-lease-epoch': String(grantB.leaseEpoch),
        'x-loopwright-lease-token': grantB.leaseToken,
      },
    });
    assert.equal(crossWorkerGet.status, 403);

    const missingHex = 'c'.repeat(64);
    const missingWorkerGet = await fetch(`${httpRelay.url}/v1/runner/leases/${grantB.jobId}/blobs/${missingHex}`, {
      headers: {
        authorization: `Bearer ${WORKER_TOKEN}`,
        'x-loopwright-relay-boot-id': grantB.relayBootId,
        'x-loopwright-lease-epoch': String(grantB.leaseEpoch),
        'x-loopwright-lease-token': grantB.leaseToken,
      },
    });
    assert.equal(missingWorkerGet.status, 404);

    // SHA-256 mismatch on worker blob upload -> 422
    const badShaRes = await streamHttpPutUnevenChunks(
      `${httpRelay.url}/v1/runner/leases/${grantB.jobId}/blobs/${missingHex}`,
      {
        authorization: `Bearer ${WORKER_TOKEN}`,
        'x-loopwright-relay-boot-id': grantB.relayBootId,
        'x-loopwright-lease-epoch': String(grantB.leaseEpoch),
        'x-loopwright-lease-token': grantB.leaseToken,
        'x-loopwright-blob-sha256': missingHex,
        'x-loopwright-blob-length': '4',
      },
      [Buffer.from('nope')],
    );
    assert.equal(badShaRes.status, 422);

    // Complete op-b as denied with structured findings
    const denyRes = await fetch(`${httpRelay.url}/v1/runner/leases/${grantB.jobId}:complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
      body: JSON.stringify({
        relayBootId: grantB.relayBootId,
        leaseEpoch: grantB.leaseEpoch,
        leaseToken: grantB.leaseToken,
        status: 'denied',
        reason: 'metric_threshold_failed',
        detail: 'max_abs_err exceeded 0.001',
        metrics: { max_abs_err: 0.025, passed_stage_a: true, compiler: 'nvcc' },
        findings: [
          {
            title: 'Numerical accuracy regression',
            severity: 'high',
            path: 'src/a.cu',
            line: 42,
            evidence: 'Observed max_abs_err=0.025 > 0.001',
          },
        ],
      }),
    });
    assert.equal(denyRes.status, 200);

    // 404 on unknown route and 405 on wrong method
    const notFound = await fetch(`${httpRelay.url}/v1/unknown`);
    assert.equal(notFound.status, 404);
    const wrongMethod = await fetch(`${httpRelay.url}/v1/benchmark/jobs`, { method: 'GET' });
    assert.equal(wrongMethod.status, 405);

    // Empty 0-byte blob staging on unsubmitted operation, malformed lease headers (400), stale SSE fence (409), comparative threshold variants, and signature tamper checks
    const stageEmpty = await streamHttpPutUnevenChunks(
      `${httpRelay.url}/v1/benchmark/jobs/op-empty-scratch/blobs/${EMPTY_SHA256_HEX}`,
      {
        'x-loopwright-blob-sha256': EMPTY_SHA256_HEX,
        'x-loopwright-blob-length': '0',
        'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, `PUT\nop-empty-scratch\n${EMPTY_SHA256_HEX}\n0`),
      },
      [],
    );
    assert.equal(stageEmpty.status, 201);

    const missingHeadersBlob = await fetch(`${httpRelay.url}/v1/runner/leases/${grantA.jobId}/blobs/${EMPTY_SHA256_HEX}`, {
      headers: { authorization: `Bearer ${WORKER_TOKEN}` },
    });
    assert.equal(missingHeadersBlob.status, 400);

    const staleSse = await fetch(`${httpRelay.url}/v1/runner/leases/${grantB.jobId}/events`, {
      headers: {
        authorization: `Bearer ${WORKER_TOKEN}`,
        'x-loopwright-relay-boot-id': grantB.relayBootId,
        'x-loopwright-lease-epoch': String(grantB.leaseEpoch),
        'x-loopwright-lease-token': grantB.leaseToken,
      },
    });
    assert.equal(staleSse.status, 409);

    // Complete op-a with 0-byte artifact (mediaType: null) after committing empty output blob
    const workerEmptyPut = await streamHttpPutUnevenChunks(
      `${httpRelay.url}/v1/runner/leases/${grantA.jobId}/blobs/${EMPTY_SHA256_HEX}`,
      {
        authorization: `Bearer ${WORKER_TOKEN}`,
        'x-loopwright-relay-boot-id': grantA.relayBootId,
        'x-loopwright-lease-epoch': String(grantA.leaseEpoch),
        'x-loopwright-lease-token': grantA.leaseToken,
        'x-loopwright-blob-sha256': EMPTY_SHA256_HEX,
        'x-loopwright-blob-length': '0',
      },
      [],
    );
    assert.equal(workerEmptyPut.status, 200);

    // .git segment in outputArtifact name rejected (400) and uncommitted outputArtifact rejected (422)
    const badGitPathComplete = await fetch(`${httpRelay.url}/v1/runner/leases/${grantA.jobId}:complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
      body: JSON.stringify({
        relayBootId: grantA.relayBootId,
        leaseEpoch: grantA.leaseEpoch,
        leaseToken: grantA.leaseToken,
        status: 'approved',
        reason: null,
        hardwareProvenance: makeProvenance(),
        outputArtifacts: [
          { name: '.git/config', digest: { algorithm: 'sha256', hex: EMPTY_SHA256_HEX }, byteLength: 0 },
        ],
      }),
    });
    assert.equal(badGitPathComplete.status, 400);

    const uncommittedComplete = await fetch(`${httpRelay.url}/v1/runner/leases/${grantA.jobId}:complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
      body: JSON.stringify({
        relayBootId: grantA.relayBootId,
        leaseEpoch: grantA.leaseEpoch,
        leaseToken: grantA.leaseToken,
        status: 'approved',
        reason: null,
        hardwareProvenance: makeProvenance(),
        outputArtifacts: [
          { name: 'stage-a/missing.cubin', digest: { algorithm: 'sha256', hex: missingHex }, byteLength: 16 },
        ],
      }),
    });
    assert.equal(uncommittedComplete.status, 422);

    const okEmptyComplete = await fetch(`${httpRelay.url}/v1/runner/leases/${grantA.jobId}:complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
      body: JSON.stringify({
        relayBootId: grantA.relayBootId,
        leaseEpoch: grantA.leaseEpoch,
        leaseToken: grantA.leaseToken,
        status: 'approved',
        reason: null,
        hardwareProvenance: makeProvenance(),
        outputArtifacts: [
          { name: 'stage-a/empty.sass', digest: { algorithm: 'sha256', hex: EMPTY_SHA256_HEX }, byteLength: 0, mediaType: null },
        ],
      }),
    });
    assert.equal(okEmptyComplete.status, 200);

    // Direct parseBenchmarkRequest coverage for max_ratio / max_delta / negative finite ratios / min+max bounds and signature tamper helper
    const parsedReq = parseBenchmarkRequest(
      makeBenchmarkRequest({
        metricThresholds: [
          { kind: 'bounds', metric: 'm1', min: 0, max: 10 },
          { kind: 'comparative', metric: 'm2', baselineMetric: 'b2', operator: 'max_ratio', threshold: 1.05 },
          { kind: 'comparative', metric: 'm3', baselineMetric: 'b3', operator: 'max_delta', threshold: -0.5 },
          { kind: 'comparative', metric: 'm4', baselineMetric: 'b4', operator: 'min_ratio', threshold: -0.25 },
          { kind: 'comparative', metric: 'm5', baselineMetric: 'b5', operator: 'max_ratio', threshold: -0.5 },
        ],
      }),
    );
    assert.equal(parsedReq.metricThresholds.length, 5);
    assert.equal(parsedReq.metricThresholds[3]?.kind === 'comparative' && parsedReq.metricThresholds[3].threshold, -0.25);
    assert.equal(parsedReq.metricThresholds[4]?.kind === 'comparative' && parsedReq.metricThresholds[4].threshold, -0.5);
    assert.equal(verifyRelaySignature(CONTROLLER_SECRET, 'abc', 'not-hex'), false);
    assert.equal(verifyBenchmarkVerdictSignature(CONTROLLER_SECRET, { status: 'approved' }, '0'.repeat(64)), false);

    // Negative wire boundary checks: controller blob auth/404, maxBlobBytes 413, truncated stream 422, and schema guards
    const badCtrlPut = await streamHttpPutUnevenChunks(
      `${httpRelay.url}/v1/benchmark/jobs/op-a/blobs/${missingHex}`,
      {
        'x-loopwright-blob-sha256': missingHex,
        'x-loopwright-blob-length': '4',
        'x-loopwright-signature': '0'.repeat(64),
      },
      [Buffer.from('abcd')],
    );
    assert.equal(badCtrlPut.status, 401);

    const badCtrlGetSig = await fetch(`${httpRelay.url}/v1/benchmark/jobs/op-a/blobs/${missingHex}`, {
      headers: { 'x-loopwright-signature': '0'.repeat(64) },
    });
    assert.equal(badCtrlGetSig.status, 401);

    const missingCtrlGet = await fetch(`${httpRelay.url}/v1/benchmark/jobs/op-a/blobs/${missingHex}`, {
      headers: {
        'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, `GET\nop-a\n${missingHex}`),
      },
    });
    assert.equal(missingCtrlGet.status, 404);

    // Declare length > maxBlobBytes (1 MiB on httpRelay) -> 413
    const tooBigLen = 2_000_000;
    const tooBigPut = await streamHttpPutUnevenChunks(
      `${httpRelay.url}/v1/benchmark/jobs/op-a/blobs/${missingHex}`,
      {
        'x-loopwright-blob-sha256': missingHex,
        'x-loopwright-blob-length': String(tooBigLen),
        'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, `PUT\nop-a\n${missingHex}\n${tooBigLen}`),
      },
      [],
    );
    assert.equal(tooBigPut.status, 413);

    // Declare length 10 via chunked stream (no content-length) on unsubmitted op-short but send only 4 bytes -> 422
    const shortPut = await streamHttpPutUnevenChunks(
      `${httpRelay.url}/v1/benchmark/jobs/op-short/blobs/${missingHex}`,
      {
        'x-loopwright-blob-sha256': missingHex,
        'x-loopwright-blob-length': '10',
        'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, `PUT\nop-short\n${missingHex}\n10`),
      },
      [Buffer.from('1234')],
    );
    assert.equal(shortPut.status, 422);

    // parseBenchmarkRequest invalid cases
    for (const invalidReq of [
      { ...makeBenchmarkRequest(), version: 2 },
      { ...makeBenchmarkRequest(), kind: 'gate_request' },
      { ...makeBenchmarkRequest(), candidateDigest: 'f'.repeat(64) },
      {
        ...makeBenchmarkRequest(),
        targetHardware: { accelerator: 'sm_90a', isolationMode: 'whole_device', driverConstraint: '>=not-dotted' },
      },
      {
        ...makeBenchmarkRequest(),
        metricThresholds: [{ kind: 'bounds', metric: 'm1', min: 10, max: 5 }],
      },
      {
        ...makeBenchmarkRequest(),
        metricThresholds: [{ kind: 'bounds', metric: 'm1' }],
      },
      {
        ...makeBenchmarkRequest(),
        metricThresholds: [{ kind: 'comparative', metric: 'm1', baselineMetric: 'b1', operator: 'min_ratio', threshold: -0 }],
      },
      {
        ...makeBenchmarkRequest(),
        metricThresholds: [{ kind: 'comparative', metric: 'm1', baselineMetric: 'b1', operator: 'max_ratio', threshold: Number.POSITIVE_INFINITY }],
      },
      {
        ...makeBenchmarkRequest(),
        candidateArtifacts: {
          entries: [],
          deleted: [],
          baseTreeBundle: { digest: { algorithm: 'sha256', hex: shaOpA }, byteLength: 32 },
        },
      },
      {
        ...makeBenchmarkRequest(),
        candidateArtifacts: {
          entries: [],
          deleted: [],
          baseTree: { objectFormat: 'sha1', commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40) },
          baseTreeBundle: { digest: { algorithm: 'sha256', hex: shaOpA }, byteLength: 11 },
        },
      },
      {
        ...makeBenchmarkRequest(),
        candidateArtifacts: {
          entries: [
            { name: 'dup.cu', digest: { algorithm: 'sha256', hex: shaOpA }, byteLength: blobOpA.byteLength },
            { name: 'DUP.cu', digest: { algorithm: 'sha256', hex: shaOpA }, byteLength: blobOpA.byteLength },
          ],
          deleted: [],
        },
      },
    ]) {
      assert.throws(() => parseBenchmarkRequest(invalidReq));
    }

    // Method 405 & query-token rejection on worker routes + invalid complete payloads (400)
    for (const [m, p] of [
      ['GET', '/v1/runner/leases:acquire'],
      ['GET', `/v1/runner/leases/${grantA.jobId}:heartbeat`],
      ['POST', `/v1/runner/leases/${grantA.jobId}/events`],
      ['DELETE', `/v1/benchmark/jobs/op-a/blobs/${EMPTY_SHA256_HEX}`],
    ] as const) {
      const mRes = await fetch(`${httpRelay.url}${p}`, {
        method: m,
        headers: {
          authorization: `Bearer ${WORKER_TOKEN}`,
          'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, ''),
        },
      });
      assert.equal(mRes.status, 405);
    }

    const queryOnBlob = await fetch(`${httpRelay.url}/v1/runner/leases/${grantA.jobId}/blobs/${EMPTY_SHA256_HEX}?token=x`, {
      headers: { authorization: `Bearer ${WORKER_TOKEN}` },
    });
    assert.equal(queryOnBlob.status, 400);

    for (const badCompleteBody of [
      { relayBootId: 'a', leaseEpoch: 1, leaseToken: 'b', status: 'approved', reason: 'must-be-null' },
      { relayBootId: 'a', leaseEpoch: 1, leaseToken: 'b', status: 'approved', reason: null },
      { relayBootId: 'a', leaseEpoch: 1, leaseToken: 'b', status: 'denied', reason: null },
      {
        relayBootId: 'a',
        leaseEpoch: 1,
        leaseToken: 'b',
        status: 'denied',
        reason: 'bad',
        outputArtifacts: [
          { name: 'a.bin', digest: { algorithm: 'sha256', hex: EMPTY_SHA256_HEX }, byteLength: 0, mediaType: 'bad mime' },
        ],
      },
    ]) {
      const badCRes = await fetch(`${httpRelay.url}/v1/runner/leases/${grantA.jobId}:complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
        body: JSON.stringify(badCompleteBody),
      });
      assert.equal(badCRes.status, 400);
    }

    const sampleVerdict = (await postSignedBenchmarkJob(httpRelay, reqA)).json as BenchmarkVerdict;
    const verdictSig = signBenchmarkVerdict(CONTROLLER_SECRET, sampleVerdict);
    assert.equal(
      verifyBenchmarkVerdictSignature(
        CONTROLLER_SECRET,
        sampleVerdict as unknown as Record<string, unknown>,
        `sha256=${verdictSig}`,
      ),
      true,
    );
  } finally {
    await tlsRelay.close();
    await httpRelay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Relay restart recovers authenticated receipts and output bindings, serves declared outputs, rejects conflicts (409) and unrelated digests (403/404), and supports maxJobs=1 turnover', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lw-relay-restart-'));
  const casDir = join(dir, 'cas');

  const outBytes = Buffer.from('compiled-sm90a-cubin-payload');
  const outSha = sha256Hex(outBytes);
  const unrelatedStagedBytes = Buffer.from('unrelated-cas-blob-bytes');
  const unrelatedSha = sha256Hex(unrelatedStagedBytes);
  const unknownSha = '9'.repeat(64);
  const operationId = 'verify.0.check.restart-persist';
  const req1 = makeBenchmarkRequest({ operationId });

  const relay1 = await startRelayServer({
    port: 0,
    casDir,
    controllerSigningSecret: CONTROLLER_SECRET,
    controllerAuthToken: CONTROLLER_BEARER,
    workerTokens: [WORKER_TOKEN],
    maxJobs: 1,
  });

  try {
    // Stage an unrelated blob under another operation so it resides in CAS
    const stageUnrelated = await streamHttpPutUnevenChunks(
      `${relay1.url}/v1/benchmark/jobs/op-other-staged/blobs/${unrelatedSha}`,
      {
        authorization: `Bearer ${CONTROLLER_BEARER}`,
        'x-loopwright-blob-sha256': unrelatedSha,
        'x-loopwright-blob-length': String(unrelatedStagedBytes.byteLength),
        'x-loopwright-signature': signRelayPayload(
          CONTROLLER_SECRET,
          `PUT\nop-other-staged\n${unrelatedSha}\n${unrelatedStagedBytes.byteLength}`,
        ),
      },
      [unrelatedStagedBytes],
    );
    assert.equal(stageUnrelated.status, 201);

    // Admit and complete req1 under maxJobs=1
    const sub1 = await postSignedBenchmarkJob(relay1, req1);
    assert.equal(sub1.status, 200);
    const acq1 = await fetch(`${relay1.url}/v1/runner/leases:acquire`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
      body: JSON.stringify({
        workerId: 'w-1',
        capabilities: { accelerator: 'sm_90a', isolationModes: ['whole_device'], deviceCount: 1, driverVersion: '550.90.07' },
      }),
    });
    const grant1 = (await acq1.json()) as LeaseGrant;

    const upOut = await streamHttpPutUnevenChunks(
      `${relay1.url}/v1/runner/leases/${grant1.jobId}/blobs/${outSha}`,
      {
        authorization: `Bearer ${WORKER_TOKEN}`,
        'x-loopwright-relay-boot-id': grant1.relayBootId,
        'x-loopwright-lease-epoch': String(grant1.leaseEpoch),
        'x-loopwright-lease-token': grant1.leaseToken,
        'x-loopwright-blob-sha256': outSha,
        'x-loopwright-blob-length': String(outBytes.byteLength),
      },
      [outBytes],
    );
    assert.equal(upOut.status, 201);

    const comp1 = await fetch(`${relay1.url}/v1/runner/leases/${grant1.jobId}:complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
      body: JSON.stringify({
        relayBootId: grant1.relayBootId,
        leaseEpoch: grant1.leaseEpoch,
        leaseToken: grant1.leaseToken,
        status: 'approved',
        reason: null,
        hardwareProvenance: makeProvenance(),
        outputArtifacts: [{ name: 'out.cubin', digest: { algorithm: 'sha256', hex: outSha }, byteLength: outBytes.byteLength }],
      }),
    });
    assert.equal(comp1.status, 200);

    // Verify maxJobs=1 turnover BEFORE restart: admit a 2nd job and exhaust its preemption budget so restart also recovers expired receipts
    const reqTurnover = makeBenchmarkRequest({ operationId: 'verify.0.check.turnover-2', maxPreemptions: 0 });
    const sub2 = await postSignedBenchmarkJob(relay1, reqTurnover);
    assert.equal(sub2.status, 200);
    assert.equal((sub2.json as BenchmarkVerdict).status, 'pending');
    const acq2 = await fetch(`${relay1.url}/v1/runner/leases:acquire`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
      body: JSON.stringify({
        workerId: 'w-2',
        capabilities: { accelerator: 'sm_90a', isolationModes: ['whole_device'], deviceCount: 1, driverVersion: '550.90.07' },
      }),
    });
    const grant2 = (await acq2.json()) as LeaseGrant;
    const exh2 = await fetch(`${relay1.url}/v1/runner/leases/${grant2.jobId}:preempt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
      body: JSON.stringify({
        relayBootId: grant2.relayBootId,
        leaseEpoch: grant2.leaseEpoch,
        leaseToken: grant2.leaseToken,
        reason: 'evict-before-restart',
      }),
    });
    assert.equal(exh2.status, 200);

    // Also admit a 3rd non-terminal operation with a staged candidate blob before shutdown to exercise interrupted-op staging recovery
    const intrBytes = Buffer.from('interrupted-op-input-blob');
    const intrSha = sha256Hex(intrBytes);
    await streamHttpPutUnevenChunks(
      `${relay1.url}/v1/benchmark/jobs/verify.0.check.interrupted/blobs/${intrSha}`,
      {
        authorization: `Bearer ${CONTROLLER_BEARER}`,
        'x-loopwright-blob-sha256': intrSha,
        'x-loopwright-blob-length': String(intrBytes.byteLength),
        'x-loopwright-signature': signRelayPayload(
          CONTROLLER_SECRET,
          `PUT\nverify.0.check.interrupted\n${intrSha}\n${intrBytes.byteLength}`,
        ),
      },
      [intrBytes],
    );
    const subIntr = await postSignedBenchmarkJob(
      relay1,
      makeBenchmarkRequest({
        operationId: 'verify.0.check.interrupted',
        candidateArtifacts: {
          entries: [{ name: 'intr.cu', digest: { algorithm: 'sha256', hex: intrSha }, byteLength: intrBytes.byteLength }],
          deleted: [],
        },
      }),
    );
    assert.equal(subIntr.status, 200);
  } finally {
    await relay1.close();
  }

  // Restart Relay on the exact same casDir with maxJobs=1
  const relay2 = await startRelayServer({
    port: 0,
    casDir,
    controllerSigningSecret: CONTROLLER_SECRET,
    controllerAuthToken: CONTROLLER_BEARER,
    workerTokens: [WORKER_TOKEN],
    maxJobs: 1,
  });

  try {
    // (a) Controller GET succeeds for declared receipt output, returns 403 for unrelated CAS blob, and 404 for unknown digest
    const getDeclared = await fetch(`${relay2.url}/v1/benchmark/jobs/${operationId}/blobs/${outSha}`, {
      headers: {
        authorization: `Bearer ${CONTROLLER_BEARER}`,
        'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, `GET\n${operationId}\n${outSha}`),
      },
    });
    assert.equal(getDeclared.status, 200);
    assert.equal(Buffer.from(await getDeclared.arrayBuffer()).equals(outBytes), true);

    const getUnrelated = await fetch(`${relay2.url}/v1/benchmark/jobs/${operationId}/blobs/${unrelatedSha}`, {
      headers: {
        authorization: `Bearer ${CONTROLLER_BEARER}`,
        'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, `GET\n${operationId}\n${unrelatedSha}`),
      },
    });
    assert.equal(getUnrelated.status, 403);

    const getUnknown = await fetch(`${relay2.url}/v1/benchmark/jobs/${operationId}/blobs/${unknownSha}`, {
      headers: {
        authorization: `Bearer ${CONTROLLER_BEARER}`,
        'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, `GET\n${operationId}\n${unknownSha}`),
      },
    });
    assert.equal(getUnknown.status, 404);

    // (b) Reposting identical benchmark_request returns retained approved verdict idempotently without creating a new job
    const repostSame = await postSignedBenchmarkJob(relay2, req1);
    assert.equal(repostSame.status, 200);
    assert.equal((repostSame.json as BenchmarkVerdict).status, 'approved');

    const emptyAcquire = await fetch(`${relay2.url}/v1/runner/leases:acquire`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
      body: JSON.stringify({
        workerId: 'w-after-restart',
        capabilities: { accelerator: 'sm_90a', isolationModes: ['whole_device'], deviceCount: 1, driverVersion: '550.90.07' },
        waitMs: 0,
      }),
    });
    assert.equal(emptyAcquire.status, 204);

    // (c) Reposting conflicting benchmark_request for recovered operationId returns 409 QUEUE_JOB_CONFLICT
    for (const conflictReq of [
      makeBenchmarkRequest({ ...req1, requestDigest: sha256Hex('different-req-digest') }),
      makeBenchmarkRequest({ ...req1, heldOutWorkloadId: 'forged-workload-id' }),
      makeBenchmarkRequest({ ...req1, dispatchId: 'different-dispatch' }),
    ]) {
      const conflictRes = await postSignedBenchmarkJob(relay2, conflictReq);
      assert.equal(conflictRes.status, 409);
      assert.equal((conflictRes.json as { code: string }).code, 'QUEUE_JOB_CONFLICT');
    }

    // maxJobs=1 remains free for new admissions after recovering terminal operations (including re-submitting interrupted op)
    const repostExpired = await postSignedBenchmarkJob(
      relay2,
      makeBenchmarkRequest({ operationId: 'verify.0.check.turnover-2', maxPreemptions: 0 }),
    );
    assert.equal(repostExpired.status, 200);
    assert.equal((repostExpired.json as BenchmarkVerdict).status, 'expired');
    assert.equal((repostExpired.json as BenchmarkVerdict).retryablePreemption, true);

    const postFresh = await postSignedBenchmarkJob(
      relay2,
      makeBenchmarkRequest({ operationId: 'verify.0.check.fresh-after-restart' }),
    );
    assert.equal(postFresh.status, 200);
  } finally {
    await relay2.close();
  }

  // Receipt-only recovery (when operations/<op>.json is absent):
  // - serves declared output GET (200) and rejects unrelated CAS digest (403)
  // - fails closed with 409 QUEUE_JOB_CONFLICT on both POST and PUT without re-binding or mutating state
  await unlink(join(casDir, 'operations', `${operationId}.json`));
  const relay3 = await startRelayServer({
    port: 0,
    casDir,
    controllerSigningSecret: CONTROLLER_SECRET,
    controllerAuthToken: CONTROLLER_BEARER,
    workerTokens: [WORKER_TOKEN],
    maxJobs: 1,
  });
  try {
    const getOut3 = await fetch(`${relay3.url}/v1/benchmark/jobs/${operationId}/blobs/${outSha}`, {
      headers: {
        authorization: `Bearer ${CONTROLLER_BEARER}`,
        'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, `GET\n${operationId}\n${outSha}`),
      },
    });
    assert.equal(getOut3.status, 200);
    assert.equal(Buffer.from(await getOut3.arrayBuffer()).equals(outBytes), true);

    const getUnrelated3 = await fetch(`${relay3.url}/v1/benchmark/jobs/${operationId}/blobs/${unrelatedSha}`, {
      headers: {
        authorization: `Bearer ${CONTROLLER_BEARER}`,
        'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, `GET\n${operationId}\n${unrelatedSha}`),
      },
    });
    assert.equal(getUnrelated3.status, 403);

    for (const candidatePost of [
      makeBenchmarkRequest({ ...req1, requestDigest: sha256Hex('forged-first-post'), heldOutWorkloadId: 'forged-wl' }),
      req1,
    ]) {
      const repostReceiptOnly = await postSignedBenchmarkJob(relay3, candidatePost);
      assert.equal(repostReceiptOnly.status, 409);
      assert.equal((repostReceiptOnly.json as { code: string }).code, 'QUEUE_JOB_CONFLICT');
    }

    const putOnReceiptOnly = await streamHttpPutUnevenChunks(
      `${relay3.url}/v1/benchmark/jobs/${operationId}/blobs/${unrelatedSha}`,
      {
        authorization: `Bearer ${CONTROLLER_BEARER}`,
        'x-loopwright-blob-sha256': unrelatedSha,
        'x-loopwright-blob-length': String(unrelatedStagedBytes.byteLength),
        'x-loopwright-signature': signRelayPayload(
          CONTROLLER_SECRET,
          `PUT\n${operationId}\n${unrelatedSha}\n${unrelatedStagedBytes.byteLength}`,
        ),
      },
      [unrelatedStagedBytes],
    );
    assert.equal(putOnReceiptOnly.status, 409);
    assert.equal(JSON.parse(putOnReceiptOnly.bodyText).code, 'QUEUE_JOB_CONFLICT');
    await assert.rejects(() => lstat(join(casDir, 'operations', `${operationId}.json`)));
  } finally {
    await relay3.close();
  }

  // Tamper receipt signature -> startup fails closed
  const receiptFile = join(casDir, 'receipts', `${operationId}.json`);
  const parsedReceipt = JSON.parse(await readFile(receiptFile, 'utf8')) as Record<string, unknown>;
  parsedReceipt.signature = '0'.repeat(64);
  await writeFile(receiptFile, JSON.stringify(parsedReceipt), 'utf8');
  await assert.rejects(
    () =>
      startRelayServer({
        port: 0,
        casDir,
        controllerSigningSecret: CONTROLLER_SECRET,
        workerTokens: [WORKER_TOKEN],
      }),
    (err: unknown) => err instanceof HardwareRunnerError && err.code === 'ARTIFACT_INVALID',
  );

  await rm(dir, { recursive: true, force: true });
});

test('verdict SecretScrubber rejection (422), required input verification + frozen worker GET set, waitMs pre-admission validation, and output/verdict byte caps (413)', async () => {
  const specialWorkerToken = 'worker-token-with-special-chars-!@#$%^&*()+=/0123456789';
  const dir = await mkdtemp(join(tmpdir(), 'lw-relay-inputs-scrub-'));
  const casDir = join(dir, 'cas');
  const relay = await startRelayServer({
    port: 0,
    casDir,
    controllerSigningSecret: CONTROLLER_SECRET,
    controllerAuthToken: CONTROLLER_BEARER,
    workerTokens: [WORKER_TOKEN, specialWorkerToken],
    leaseTtlMs: 15_000,
  });

  try {
    // 1. Validate waitMs BEFORE submitJob: malformed waitMs returns 400 and leaves queue empty
    const waitInvalidReq = makeBenchmarkRequest({ operationId: 'op-bad-wait' });
    const badWait1 = await postSignedBenchmarkJob(relay, waitInvalidReq, '?waitMs=notanumber');
    assert.equal(badWait1.status, 400);
    const badWait2 = await postSignedBenchmarkJob(relay, waitInvalidReq, '?unexpectedParam=1');
    assert.equal(badWait2.status, 400);
    const rawWaitBody = Buffer.from(canonicalJson(waitInvalidReq), 'utf8');
    const badWaitHeader = await fetch(`${relay.url}/v1/benchmark/jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${CONTROLLER_BEARER}`,
        'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, rawWaitBody),
        'x-loopwright-wait-ms': '-10',
      },
      body: new Uint8Array(rawWaitBody),
    });
    assert.equal(badWaitHeader.status, 400);

    // Queue is still completely empty (submitting op-bad-wait with a brand new requestDigest succeeds as fresh created job, not 409)
    const emptyAcq = await fetch(`${relay.url}/v1/runner/leases:acquire`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
      body: JSON.stringify({
        workerId: 'w-check',
        capabilities: { accelerator: 'sm_90a', isolationModes: ['whole_device'], deviceCount: 1, driverVersion: '550.90.07' },
        waitMs: 0,
      }),
    });
    assert.equal(emptyAcq.status, 204);

    // 2. Missing declared input blob rejected before enqueue (409 ARTIFACT_MISSING) without admitting job
    const declBytes = Buffer.from('declared-kernel-source-v1');
    const declSha = sha256Hex(declBytes);
    const extraBeforeBytes = Buffer.from('extra-staged-before-submit');
    const extraBeforeSha = sha256Hex(extraBeforeBytes);
    const postAfterBytes = Buffer.from('staged-after-submit');
    const postAfterSha = sha256Hex(postAfterBytes);

    const opInputs = 'verify.0.check.frozen-inputs';
    const reqInputs = makeBenchmarkRequest({
      operationId: opInputs,
      candidateArtifacts: {
        entries: [{ name: 'src/k.cu', digest: { algorithm: 'sha256', hex: declSha }, byteLength: declBytes.byteLength }],
        deleted: [],
      },
    });

    const missingSubmit = await postSignedBenchmarkJob(relay, reqInputs);
    assert.equal(missingSubmit.status, 409);
    assert.equal((missingSubmit.json as { code: string }).code, 'ARTIFACT_MISSING');

    // Stage BOTH declSha and extraBeforeSha under opInputs, then submit declaring ONLY declSha
    for (const [sha, bytes] of [
      [declSha, declBytes],
      [extraBeforeSha, extraBeforeBytes],
    ] as const) {
      const stRes = await streamHttpPutUnevenChunks(
        `${relay.url}/v1/benchmark/jobs/${opInputs}/blobs/${sha}`,
        {
          authorization: `Bearer ${CONTROLLER_BEARER}`,
          'x-loopwright-blob-sha256': sha,
          'x-loopwright-blob-length': String(bytes.byteLength),
          'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, `PUT\n${opInputs}\n${sha}\n${bytes.byteLength}`),
        },
        [bytes],
      );
      assert.equal(stRes.status, 201);
    }

    const okSubmit = await postSignedBenchmarkJob(relay, reqInputs);
    assert.equal(okSubmit.status, 200);

    // Post-submit staging attempt under opInputs for undeclared blob is rejected (409), while staging into CAS under op-other succeeds
    const postSubmitAttempt = await streamHttpPutUnevenChunks(
      `${relay.url}/v1/benchmark/jobs/${opInputs}/blobs/${postAfterSha}`,
      {
        authorization: `Bearer ${CONTROLLER_BEARER}`,
        'x-loopwright-blob-sha256': postAfterSha,
        'x-loopwright-blob-length': String(postAfterBytes.byteLength),
        'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, `PUT\n${opInputs}\n${postAfterSha}\n${postAfterBytes.byteLength}`),
      },
      [postAfterBytes],
    );
    assert.equal(postSubmitAttempt.status, 409);

    const stageInOtherOp = await streamHttpPutUnevenChunks(
      `${relay.url}/v1/benchmark/jobs/op-other-cas/blobs/${postAfterSha}`,
      {
        authorization: `Bearer ${CONTROLLER_BEARER}`,
        'x-loopwright-blob-sha256': postAfterSha,
        'x-loopwright-blob-length': String(postAfterBytes.byteLength),
        'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, `PUT\nop-other-cas\n${postAfterSha}\n${postAfterBytes.byteLength}`),
      },
      [postAfterBytes],
    );
    assert.equal(stageInOtherOp.status, 201);

    const acqRes = await fetch(`${relay.url}/v1/runner/leases:acquire`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
      body: JSON.stringify({
        workerId: 'w-inputs',
        capabilities: { accelerator: 'sm_90a', isolationModes: ['whole_device'], deviceCount: 1, driverVersion: '550.90.07' },
      }),
    });
    const grant = (await acqRes.json()) as LeaseGrant;
    assert.equal(grant.operationId, opInputs);

    const leaseHeaders = {
      authorization: `Bearer ${WORKER_TOKEN}`,
      'x-loopwright-relay-boot-id': grant.relayBootId,
      'x-loopwright-lease-epoch': String(grant.leaseEpoch),
      'x-loopwright-lease-token': grant.leaseToken,
    };

      // Worker GET succeeds for declared input, and returns 403 for both extra pre-submit and post-submit blobs!
      assert.equal((await fetch(`${relay.url}/v1/runner/leases/${grant.jobId}/blobs/${declSha}`, { headers: leaseHeaders })).status, 200);
      assert.equal((await fetch(`${relay.url}/v1/runner/leases/${grant.jobId}/blobs/${extraBeforeSha}`, { headers: leaseHeaders })).status, 403);
      assert.equal((await fetch(`${relay.url}/v1/runner/leases/${grant.jobId}/blobs/${postAfterSha}`, { headers: leaseHeaders })).status, 403);

      // 2b. Optional candidateArtifacts.baseTreeBundle: requires CAS staging prior to admission (409 ARTIFACT_MISSING if unstaged),
      //     freezes baseTreeBundle digest for worker GET, and persists/restores in authenticated operation descriptor!
      const bundleBytes = Buffer.from('PACK-git-bundle-fixture-bytes-v1');
      const bundleSha = sha256Hex(bundleBytes);
      const opBundle = 'verify.0.check.base-tree-bundle';
      const reqBundle = makeBenchmarkRequest({
        operationId: opBundle,
        candidateArtifacts: {
          entries: [],
          deleted: [],
          baseTree: {
            objectFormat: 'sha1',
            commitOid: 'a'.repeat(40),
            treeOid: 'b'.repeat(40),
          },
          baseTreeBundle: {
            digest: { algorithm: 'sha256', hex: bundleSha },
            byteLength: bundleBytes.byteLength,
          },
        },
      });

      const missingBundlePost = await postSignedBenchmarkJob(relay, reqBundle);
      assert.equal(missingBundlePost.status, 409);
      assert.equal((missingBundlePost.json as { code: string }).code, 'ARTIFACT_MISSING');

      const stageBundleRes = await streamHttpPutUnevenChunks(
        `${relay.url}/v1/benchmark/jobs/${opBundle}/blobs/${bundleSha}`,
        {
          authorization: `Bearer ${CONTROLLER_BEARER}`,
          'x-loopwright-blob-sha256': bundleSha,
          'x-loopwright-blob-length': String(bundleBytes.byteLength),
          'x-loopwright-signature': signRelayPayload(
            CONTROLLER_SECRET,
            `PUT\n${opBundle}\n${bundleSha}\n${bundleBytes.byteLength}`,
          ),
        },
        [bundleBytes],
      );
      assert.equal(stageBundleRes.status, 201);

      const okBundlePost = await postSignedBenchmarkJob(relay, reqBundle);
      assert.equal(okBundlePost.status, 200);
      const acqBundle = await fetch(`${relay.url}/v1/runner/leases:acquire`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
        body: JSON.stringify({
          workerId: 'w-bundle',
          capabilities: { accelerator: 'sm_90a', isolationModes: ['whole_device'], deviceCount: 1, driverVersion: '550.90.07' },
        }),
      });
      const grantBundle = (await acqBundle.json()) as LeaseGrant;
      assert.equal(grantBundle.operationId, opBundle);
      assert.equal(grantBundle.job.candidateArtifacts.baseTreeBundle?.digest.hex, bundleSha);

      const getBundleWorker = await fetch(`${relay.url}/v1/runner/leases/${grantBundle.jobId}/blobs/${bundleSha}`, {
        headers: {
          authorization: `Bearer ${WORKER_TOKEN}`,
          'x-loopwright-relay-boot-id': grantBundle.relayBootId,
          'x-loopwright-lease-epoch': String(grantBundle.leaseEpoch),
          'x-loopwright-lease-token': grantBundle.leaseToken,
        },
      });
      assert.equal(getBundleWorker.status, 200);
      assert.equal(Buffer.from(await getBundleWorker.arrayBuffer()).equals(bundleBytes), true);

      const persistedBundleDesc = JSON.parse(
        await readFile(join(casDir, 'operations', `${opBundle}.json`), 'utf8'),
      ) as { request: BenchmarkRequest };
      assert.equal(persistedBundleDesc.request.candidateArtifacts.baseTreeBundle?.digest.hex, bundleSha);

    // 3. Cross-chunk SecretScrubber check for controllerAuthToken and base64 / URL-encoded secret forms with strict <= 1 MiB window
    assert.ok(computeSecretScanOverlapBytes([specialWorkerToken]) >= encodeURIComponent(specialWorkerToken).length + 4);
    for (const leakedForm of [
      CONTROLLER_BEARER,
      Buffer.from(WORKER_TOKEN, 'utf8').toString('base64'),
      encodeURIComponent(specialWorkerToken),
    ]) {
      const leakBytes = Buffer.from(leakedForm, 'utf8');
      const splitIdx = Math.floor(leakBytes.byteLength / 2);
      // Use a full 1 MiB first chunk so scanTail + next slice exercises the strict <= 1 MiB window slicing!
      const part1 = Buffer.concat([Buffer.alloc(1_048_576, 0x41), leakBytes.subarray(0, splitIdx)]);
      const part2 = Buffer.concat([leakBytes.subarray(splitIdx), Buffer.alloc(4_096, 0x42)]);
      const combined = Buffer.concat([part1, part2]);
      const combinedSha = sha256Hex(combined);
      const putLeak = await streamHttpPutUnevenChunks(
        `${relay.url}/v1/runner/leases/${grant.jobId}/blobs/${combinedSha}`,
        {
          ...leaseHeaders,
          'x-loopwright-blob-sha256': combinedSha,
          'x-loopwright-blob-length': String(combined.byteLength),
        },
        [part1, part2],
      );
      assert.equal(putLeak.status, 422);
      assert.equal(putLeak.bodyText.includes(leakedForm), false);
      assert.equal(putLeak.bodyText.includes(WORKER_TOKEN), false);
      assert.equal(putLeak.bodyText.includes(CONTROLLER_BEARER), false);
    }

    // 4. Canonical verdict SecretScrubber check: worker diagnostic containing worker token or controller bearer is rejected (422)
    //    without writing a receipt or exposing the secret in controller polls!
    for (const badEvidence of [
      `diagnostic leaked Bearer ${WORKER_TOKEN}`,
      `encoded=${Buffer.from(CONTROLLER_BEARER, 'utf8').toString('base64')}`,
    ]) {
      const leakComplete = await fetch(`${relay.url}/v1/runner/leases/${grant.jobId}:complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
        body: JSON.stringify({
          relayBootId: grant.relayBootId,
          leaseEpoch: grant.leaseEpoch,
          leaseToken: grant.leaseToken,
          status: 'denied',
          reason: 'compile_error',
          detail: badEvidence,
        }),
      });
      assert.equal(leakComplete.status, 422);
      const errText = await leakComplete.text();
      assert.equal(errText.includes(WORKER_TOKEN), false);
      assert.equal(errText.includes(CONTROLLER_BEARER), false);
    }
    await assert.rejects(() => lstat(join(casDir, 'receipts', `${opInputs}.json`)));
    const pollStillPending = await postSignedBenchmarkJob(relay, reqInputs);
    assert.equal(pollStillPending.status, 200);
    assert.equal((pollStillPending.json as BenchmarkVerdict).status, 'pending');

    // 5. Aggregate outputArtifacts byte budget (> VERIFIER_ARTIFACT_LIMITS.maxTotalBytes) and > 65,536-byte expanded verdict cap -> 413
    const halfPlus = Math.floor(VERIFIER_ARTIFACT_LIMITS.maxTotalBytes / 2) + 1024;
    const overBudgetComplete = await fetch(`${relay.url}/v1/runner/leases/${grant.jobId}:complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
      body: JSON.stringify({
        relayBootId: grant.relayBootId,
        leaseEpoch: grant.leaseEpoch,
        leaseToken: grant.leaseToken,
        status: 'approved',
        reason: null,
        hardwareProvenance: makeProvenance(),
        outputArtifacts: [
          { name: 'a.cubin', digest: { algorithm: 'sha256', hex: '1'.repeat(64) }, byteLength: halfPlus },
          { name: 'b.cubin', digest: { algorithm: 'sha256', hex: '2'.repeat(64) }, byteLength: halfPlus },
        ],
      }),
    });
    assert.equal(overBudgetComplete.status, 413);

    // Incoming body < 65,536 bytes (65,486 bytes), expanded verdict > 65,536 bytes -> 413 before publishing receipt
    const findings24 = Array.from({ length: 24 }, (_, idx) => ({
      title: `f${idx}`,
      severity: 'low' as const,
      evidence: 'x'.repeat(2_000),
    }));
    const templateBody = JSON.stringify({
      relayBootId: grant.relayBootId,
      leaseEpoch: grant.leaseEpoch,
      leaseToken: grant.leaseToken,
      status: 'denied',
      reason: 'threshold_miss',
      detail: '',
      findings: findings24,
    });
    const detailPad = MAX_CONTROL_BODY_BYTES - Buffer.byteLength(templateBody, 'utf8') - 50;
    const expandedOversizeBody = JSON.stringify({
      relayBootId: grant.relayBootId,
      leaseEpoch: grant.leaseEpoch,
      leaseToken: grant.leaseToken,
      status: 'denied',
      reason: 'threshold_miss',
      detail: 'y'.repeat(detailPad),
      findings: findings24,
    });
    assert.ok(Buffer.byteLength(expandedOversizeBody, 'utf8') <= MAX_CONTROL_BODY_BYTES);
    const expandedOversizeRes = await fetch(`${relay.url}/v1/runner/leases/${grant.jobId}:complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
      body: expandedOversizeBody,
    });
    assert.equal(expandedOversizeRes.status, 413);
    await assert.rejects(() => lstat(join(casDir, 'receipts', `${opInputs}.json`)));
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('completion fencing during async verification, post-storage PUT revocation & I/O failure safety, durable receipt ordering, symlink/0o400 guards, backpressure disconnect, and failed startup cleanup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lw-relay-hardening-'));

  try {
    // 1. Symlink ancestor check runs BEFORE mkdir: no directories created outside intended CAS!
    const outsideTarget = join(dir, 'outside-real');
    await mkdir(outsideTarget, { mode: 0o700 });
    const symlinkAncestor = join(dir, 'symlink-parent');
    await symlink(outsideTarget, symlinkAncestor);

    await assert.rejects(
      () =>
        startRelayServer({
          port: 0,
          casDir: join(symlinkAncestor, 'escaped-subdir', 'cas'),
          controllerSigningSecret: CONTROLLER_SECRET,
          workerTokens: [WORKER_TOKEN],
        }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'CONFIG_INVALID',
    );
    await assert.rejects(() => lstat(join(outsideTarget, 'escaped-subdir')));

    // Group/world-writable existing CAS directory is rejected at startup, while 0o755 owner-only-writable dir is tightened to 0o700
    const worldWritableCas = join(dir, 'world-writable-cas');
    await mkdir(worldWritableCas);
    await chmod(worldWritableCas, 0o777);
    await assert.rejects(
      () =>
        startRelayServer({
          port: 0,
          casDir: worldWritableCas,
          controllerSigningSecret: CONTROLLER_SECRET,
          workerTokens: [WORKER_TOKEN],
        }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'CONFIG_INVALID',
    );

    const liveCasInit = join(dir, 'live-cas');
    await mkdir(liveCasInit);
    await chmod(liveCasInit, 0o755);

    // 2. Stepped ClockSource to deterministically test lease expiry mid-completion & post-streaming PUT revocation,
    //    plus I/O failure after staging, 0o444 blob rejection, receipt persistence failure withholding, and backpressure disconnect
    let monoNow = 10_000;
    let wallNow = 1_700_000_000_000;
    let onSampleHook: (() => void) | null = null;
    const clock: ClockSource = {
      nowMonotonicMs(): number {
        onSampleHook?.();
        return monoNow;
      },
      nowWallMs(): number {
        return wallNow;
      },
    };

    let failLiveReceiptWrites = false;
    const casDir = join(dir, 'live-cas');
    const relay = await startRelayServer({
      port: 0,
      casDir,
      controllerSigningSecret: CONTROLLER_SECRET,
      workerTokens: [WORKER_TOKEN],
      leaseTtlMs: 5_000,
      sweepIntervalMs: 60_000,
      clock,
      onBeforeReceiptPersist: () => {
        if (failLiveReceiptWrites) {
          throw new Error('injected deterministic receipt write failure');
        }
      },
    });

    try {
      // Repeated failed starts on already-bound port & bad TLS path clean up queue intervals cleanly
      for (let i = 0; i < 3; i += 1) {
        await assert.rejects(() =>
          startRelayServer({
            host: '127.0.0.1',
            port: relay.port,
            casDir: join(dir, `conflict-cas-${i}`),
            controllerSigningSecret: CONTROLLER_SECRET,
            workerTokens: [WORKER_TOKEN],
          }),
        );
        await assert.rejects(() =>
          startRelayServer({
            port: 0,
            casDir: join(dir, `bad-tls-cas-${i}`),
            controllerSigningSecret: CONTROLLER_SECRET,
            workerTokens: [WORKER_TOKEN],
            tls: { certPath: join(dir, 'missing.crt'), keyPath: join(dir, 'missing.key') },
          }),
        );
      }

      // Submit op-race for post-storage PUT revocation, I/O failure after staging, and mid-complete expiry
      const reqRace = makeBenchmarkRequest({ operationId: 'op-race', maxPreemptions: 2 });
      const rawRace = Buffer.from(canonicalJson(reqRace), 'utf8');
      await fetch(`${relay.url}/v1/benchmark/jobs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, rawRace),
        },
        body: new Uint8Array(rawRace),
      });

      const acq1 = await fetch(`${relay.url}/v1/runner/leases:acquire`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
        body: JSON.stringify({
          workerId: 'w-race-1',
          capabilities: { accelerator: 'sm_90a', isolationModes: ['whole_device'], deviceCount: 1, driverVersion: '550.90.07' },
        }),
      });
      const g1 = (await acq1.json()) as LeaseGrant;

      // (a) I/O failure AFTER staging into tmpDir (make blobs/sha256 0o500 so link() fails with EACCES):
      //     must return 500, clean tmp file, and record ZERO committed-output binding!
      const ioFailBytes = Buffer.from('io-failure-after-staging-bytes');
      const ioFailSha = sha256Hex(ioFailBytes);
      const sha256Dir = join(casDir, 'blobs', 'sha256');
      await chmod(sha256Dir, 0o500);
      let ioFailRes: { readonly status: number; readonly bodyText: string };
      try {
        ioFailRes = await streamHttpPutUnevenChunks(
          `${relay.url}/v1/runner/leases/${g1.jobId}/blobs/${ioFailSha}`,
          {
            authorization: `Bearer ${WORKER_TOKEN}`,
            'x-loopwright-relay-boot-id': g1.relayBootId,
            'x-loopwright-lease-epoch': String(g1.leaseEpoch),
            'x-loopwright-lease-token': g1.leaseToken,
            'x-loopwright-blob-sha256': ioFailSha,
            'x-loopwright-blob-length': String(ioFailBytes.byteLength),
          },
          [ioFailBytes],
        );
      } finally {
        await chmod(sha256Dir, 0o700);
      }
      assert.equal(ioFailRes.status, 500);
      assert.equal((await readdir(join(casDir, 'tmp'))).length, 0);

      // Attempting :complete referencing ioFailSha fails with 422 (zero false bindings recorded!)
      const falseBindComplete = await fetch(`${relay.url}/v1/runner/leases/${g1.jobId}:complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
        body: JSON.stringify({
          relayBootId: g1.relayBootId,
          leaseEpoch: g1.leaseEpoch,
          leaseToken: g1.leaseToken,
          status: 'approved',
          reason: null,
          hardwareProvenance: makeProvenance(),
          outputArtifacts: [{ name: 'io.cubin', digest: { algorithm: 'sha256', hex: ioFailSha }, byteLength: ioFailBytes.byteLength }],
        }),
      });
      assert.equal(falseBindComplete.status, 422);

      // (b) Lease expiry AFTER streaming finishes (at the post-storage recordCommittedOutputBlob check) -> 409 QUEUE_LEASE_FENCED!
      const postStreamBytes = Buffer.from('expire-right-at-post-storage-bind');
      const postStreamSha = sha256Hex(postStreamBytes);
      let putSamples = 0;
      onSampleHook = () => {
        putSamples += 1;
        // Sample 1 is verifyActiveLease pre-stream; Sample 2 is post-storage recordCommittedOutputBlob!
        if (putSamples === 2) {
          monoNow += 5_000;
          wallNow += 5_000;
        }
      };
      const postStreamPut = await streamHttpPutUnevenChunks(
        `${relay.url}/v1/runner/leases/${g1.jobId}/blobs/${postStreamSha}`,
        {
          authorization: `Bearer ${WORKER_TOKEN}`,
          'x-loopwright-relay-boot-id': g1.relayBootId,
          'x-loopwright-lease-epoch': String(g1.leaseEpoch),
          'x-loopwright-lease-token': g1.leaseToken,
          'x-loopwright-blob-sha256': postStreamSha,
          'x-loopwright-blob-length': String(postStreamBytes.byteLength),
        },
        [postStreamBytes],
      );
      onSampleHook = null;
      assert.equal(postStreamPut.status, 409);
      assert.equal(JSON.parse(postStreamPut.bodyText).code, 'QUEUE_LEASE_FENCED');

      // Acquire epoch 2 and test lease expiry DURING :complete preparation (after prepareCompleteLease, before commit/rename)!
      const acq2 = await fetch(`${relay.url}/v1/runner/leases:acquire`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
        body: JSON.stringify({
          workerId: 'w-race-2',
          capabilities: { accelerator: 'sm_90a', isolationModes: ['whole_device'], deviceCount: 1, driverVersion: '550.90.07' },
        }),
      });
      const g2 = (await acq2.json()) as LeaseGrant;
      assert.equal(g2.leaseEpoch, 2);

      let completeSamples = 0;
      onSampleHook = () => {
        completeSamples += 1;
        // Sample 1 = prepareCompleteLease; Sample 2 = verifyActiveLease / commit boundary after async staging!
        if (completeSamples === 3) {
          monoNow += 5_000;
          wallNow += 5_000;
        }
      };
      const expiredMidComplete = await fetch(`${relay.url}/v1/runner/leases/${g2.jobId}:complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
        body: JSON.stringify({
          relayBootId: g2.relayBootId,
          leaseEpoch: g2.leaseEpoch,
          leaseToken: g2.leaseToken,
          status: 'approved',
          reason: null,
          hardwareProvenance: makeProvenance(),
        }),
      });
      onSampleHook = null;
      assert.equal(expiredMidComplete.status, 409);
      // No signed receipt was published!
      await assert.rejects(() => lstat(join(casDir, 'receipts', 'op-race.json')));

      // (c) Durable receipt ordering for preemption exhaustion: if receipt write fails before rename (receiptsDir 0o500),
      //     terminal verdict MUST be withheld (500) until receiptsDir recovers and receipt becomes durable!
      const acq3 = await fetch(`${relay.url}/v1/runner/leases:acquire`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
        body: JSON.stringify({
          workerId: 'w-race-3',
          capabilities: { accelerator: 'sm_90a', isolationModes: ['whole_device'], deviceCount: 1, driverVersion: '550.90.07' },
        }),
      });
      const g3 = (await acq3.json()) as LeaseGrant;
      assert.equal(g3.leaseEpoch, 3);

      const receiptsDir = join(casDir, 'receipts');
      failLiveReceiptWrites = true;
      let pollWhileReceiptBrokenStatus = 0;
      try {
        const preemptFail = await fetch(`${relay.url}/v1/runner/leases/${g3.jobId}:preempt`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
          body: JSON.stringify({
            relayBootId: g3.relayBootId,
            leaseEpoch: g3.leaseEpoch,
            leaseToken: g3.leaseToken,
          }),
        });
        assert.equal(preemptFail.status, 500);

        // Subsequent controller poll MUST ALSO withhold terminal verdict (500) while receipt is missing!
        const pollBroken = await fetch(`${relay.url}/v1/benchmark/jobs`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, rawRace),
          },
          body: new Uint8Array(rawRace),
        });
        pollWhileReceiptBrokenStatus = pollBroken.status;
      } finally {
        failLiveReceiptWrites = false;
      }
      assert.equal(pollWhileReceiptBrokenStatus, 500);

      // Once receiptsDir is writable again, polling persists the exact receipt durably and serves 200 expired!
      const pollRecovered = await fetch(`${relay.url}/v1/benchmark/jobs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, rawRace),
        },
        body: new Uint8Array(rawRace),
      });
      assert.equal(pollRecovered.status, 200);
      const recoveredVerdict = (await pollRecovered.json()) as BenchmarkVerdict;
      assert.equal(recoveredVerdict.status, 'expired');
      assert.equal(recoveredVerdict.reason, 'BENCHMARK_PREEMPTED');
      const durableStat = await lstat(join(receiptsDir, 'op-race.json'));
      assert.equal(durableStat.mode & 0o777, 0o600);

      // (d) Strict 0o400 enforcement on deduplicated blobs & reads (reject 0o444) + backpressure client disconnect
      const bigBytes = Buffer.alloc(6 * 1_048_576, 0x5a);
      const bigSha = sha256Hex(bigBytes);
      const opStream = 'op-backpressure';
      const stageBig = await streamHttpPutUnevenChunks(
        `${relay.url}/v1/benchmark/jobs/${opStream}/blobs/${bigSha}`,
        {
          'x-loopwright-blob-sha256': bigSha,
          'x-loopwright-blob-length': String(bigBytes.byteLength),
          'x-loopwright-signature': signRelayPayload(
            CONTROLLER_SECRET,
            `PUT\n${opStream}\n${bigSha}\n${bigBytes.byteLength}`,
          ),
        },
        [bigBytes],
      );
      assert.equal(stageBig.status, 201);

      // Loosen mode to 0o444 -> deduplicated PUT and admission verification both reject (422)!
      const bigBlobPath = join(sha256Dir, bigSha);
      await chmod(bigBlobPath, 0o444);
      const dedupLoosened = await streamHttpPutUnevenChunks(
        `${relay.url}/v1/benchmark/jobs/${opStream}/blobs/${bigSha}`,
        {
          'x-loopwright-blob-sha256': bigSha,
          'x-loopwright-blob-length': String(bigBytes.byteLength),
          'x-loopwright-signature': signRelayPayload(
            CONTROLLER_SECRET,
            `PUT\n${opStream}\n${bigSha}\n${bigBytes.byteLength}`,
          ),
        },
        [bigBytes],
      );
      assert.equal(dedupLoosened.status, 422);
      await chmod(bigBlobPath, 0o400);

      const reqStream = makeBenchmarkRequest({
        operationId: opStream,
        candidateArtifacts: {
          entries: [{ name: 'big.bin', digest: { algorithm: 'sha256', hex: bigSha }, byteLength: bigBytes.byteLength }],
          deleted: [],
        },
      });
      const rawStreamReq = Buffer.from(canonicalJson(reqStream), 'utf8');
      const subStream = await fetch(`${relay.url}/v1/benchmark/jobs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, rawStreamReq),
        },
        body: new Uint8Array(rawStreamReq),
      });
      assert.equal(subStream.status, 200);

      // Controller wait poll disconnect cleanup via res.once('close')
      const waitAbortCtrl = new AbortController();
      const abortedPoll = fetch(`${relay.url}/v1/benchmark/jobs?waitMs=10000`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, rawStreamReq),
        },
        body: new Uint8Array(rawStreamReq),
        signal: waitAbortCtrl.signal,
      }).catch(() => null);
      await new Promise(r => setTimeout(r, 25));
      waitAbortCtrl.abort();
      await abortedPoll;

      const acqStream = await fetch(`${relay.url}/v1/runner/leases:acquire`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
        body: JSON.stringify({
          workerId: 'w-stream',
          capabilities: { accelerator: 'sm_90a', isolationModes: ['whole_device'], deviceCount: 1, driverVersion: '550.90.07' },
        }),
      });
      const gStream = (await acqStream.json()) as LeaseGrant;

      // Also verify 0o444 is rejected on worker GET
      await chmod(bigBlobPath, 0o444);
      const get0444 = await fetch(`${relay.url}/v1/runner/leases/${gStream.jobId}/blobs/${bigSha}`, {
        headers: {
          authorization: `Bearer ${WORKER_TOKEN}`,
          'x-loopwright-relay-boot-id': gStream.relayBootId,
          'x-loopwright-lease-epoch': String(gStream.leaseEpoch),
          'x-loopwright-lease-token': gStream.leaseToken,
        },
      });
      assert.equal(get0444.status, 422);
      await chmod(bigBlobPath, 0o400);

      // Backpressured download client disconnect: pause reading so server hits res.write() === false, then destroy socket!
      const parsedDownload = new URL(`${relay.url}/v1/runner/leases/${gStream.jobId}/blobs/${bigSha}`);
      await new Promise<void>((resolveDisconnect, rejectDisconnect) => {
        const dlReq = httpRequest(
          {
            hostname: parsedDownload.hostname,
            port: parsedDownload.port,
            path: parsedDownload.pathname,
            method: 'GET',
            headers: {
              authorization: `Bearer ${WORKER_TOKEN}`,
              'x-loopwright-relay-boot-id': gStream.relayBootId,
              'x-loopwright-lease-epoch': String(gStream.leaseEpoch),
              'x-loopwright-lease-token': gStream.leaseToken,
            },
          },
          dlRes => {
            assert.equal(dlRes.statusCode, 200);
            // Deliberately do NOT attach 'data' listener so TCP receive buffer fills and server blocks on drain!
            setTimeout(() => {
              dlRes.destroy();
              dlReq.destroy();
              resolveDisconnect();
            }, 40);
          },
        );
        dlReq.on('error', err => {
          if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') {
            resolveDisconnect();
            return;
          }
          rejectDisconnect(err);
        });
        dlReq.end();
      });

      // Also verify deterministic pre-rename receipt write failure on :complete withholds completion (500) and keeps job pending!
      failLiveReceiptWrites = true;
      try {
        const failComp = await fetch(`${relay.url}/v1/runner/leases/${gStream.jobId}:complete`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
          body: JSON.stringify({
            relayBootId: gStream.relayBootId,
            leaseEpoch: gStream.leaseEpoch,
            leaseToken: gStream.leaseToken,
            status: 'approved',
            reason: null,
            hardwareProvenance: makeProvenance(),
          }),
        });
        assert.equal(failComp.status, 500);
      } finally {
        failLiveReceiptWrites = false;
      }
      const pollAfterFailedComplete = await fetch(`${relay.url}/v1/benchmark/jobs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, rawStreamReq),
        },
        body: new Uint8Array(rawStreamReq),
      });
      assert.equal(((await pollAfterFailedComplete.json()) as BenchmarkVerdict).status, 'pending');

      // Server closes cleanly and promptly without hanging on backpressured drain,
      // an in-flight :complete racing with relay.close() is fenced without publishing a receipt,
      // and concurrent close() callers share the exact same shutdown promise!
      let shutdownSamples = 0;
      let firstClosePromise: Promise<void> | null = null;
      onSampleHook = () => {
        shutdownSamples += 1;
        if (shutdownSamples === 2) {
          firstClosePromise = relay.close();
        }
      };
      const completeDuringClose = await fetch(`${relay.url}/v1/runner/leases/${gStream.jobId}:complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
        body: JSON.stringify({
          relayBootId: gStream.relayBootId,
          leaseEpoch: gStream.leaseEpoch,
          leaseToken: gStream.leaseToken,
          status: 'approved',
          reason: null,
          hardwareProvenance: makeProvenance(),
        }),
      }).catch(() => null);
      onSampleHook = null;
      if (completeDuringClose !== null) {
        assert.equal(completeDuringClose.status, 409);
      }
      await assert.rejects(() => lstat(join(receiptsDir, `${opStream}.json`)));

      assert.ok(firstClosePromise !== null);
      const secondClosePromise = relay.close();
      assert.equal(secondClosePromise, firstClosePromise);
      const closeStart = Date.now();
      await Promise.all([firstClosePromise, secondClosePromise]);
      assert.ok(Date.now() - closeStart < 500);
    } finally {
      await relay.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bounded terminal retention + evicted replay/GET lazy disk recovery, CAS lockfile exclusivity, ancestor writability checks, non-ENOENT record fail-closed, targetCellId live binding, final-fence expiry receipt durability, and concurrent 429 staging preservation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lw-relay-fixpass2-'));
  const directTmpCas = join('/tmp', `lw-sticky-root-cas-${randomBytes(8).toString('hex')}`);

  try {
    // 1. Mutable group/world-writable ancestor directory is rejected BEFORE creating child directories,
    //    while sticky root-owned /tmp (/private/tmp on macOS) and os.tmpdir() continue to pass!
    const mutableAncestor = join(dir, 'mutable-parent');
    await mkdir(mutableAncestor, { mode: 0o700 });
    await chmod(mutableAncestor, 0o775);
    await assert.rejects(
      () =>
        startRelayServer({
          port: 0,
          casDir: join(mutableAncestor, 'sub', 'cas'),
          controllerSigningSecret: CONTROLLER_SECRET,
          workerTokens: [WORKER_TOKEN],
        }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'CONFIG_INVALID',
    );
    await assert.rejects(() => lstat(join(mutableAncestor, 'sub')));

    const stickyTmpRelay = await startRelayServer({
      port: 0,
      casDir: join(directTmpCas, 'cas'),
      controllerSigningSecret: CONTROLLER_SECRET,
      workerTokens: [WORKER_TOKEN],
    });
    const stickyLeafStat = await lstat(join(directTmpCas, 'cas'));
    assert.equal(stickyLeafStat.mode & 0o777, 0o700);
    await stickyTmpRelay.close();

    // 2. Exclusive CAS ownership lock (<casDir>/.relay.lock) refuses overlapping Relay instances BEFORE
    //    any .tmp-* cleanup or recovery scan, and releases cleanly on close()!
    const sharedCasDir = join(dir, 'shared-cas');
    const relayLockHolder = await startRelayServer({
      port: 0,
      casDir: sharedCasDir,
      controllerSigningSecret: CONTROLLER_SECRET,
      controllerAuthToken: CONTROLLER_BEARER,
      workerTokens: [WORKER_TOKEN],
    });
    const liveTmpBlob = join(sharedCasDir, 'tmp', '.tmp-in-progress-upload');
    const liveTmpReceipt = join(sharedCasDir, 'receipts', '.tmp-in-progress-receipt.json');
    await writeFile(liveTmpBlob, 'live-upload-bytes', { mode: 0o600 });
    await writeFile(liveTmpReceipt, '{"live":true}', { mode: 0o600 });

    await assert.rejects(
      () =>
        startRelayServer({
          port: 0,
          casDir: sharedCasDir,
          controllerSigningSecret: CONTROLLER_SECRET,
          controllerAuthToken: CONTROLLER_BEARER,
          workerTokens: [WORKER_TOKEN],
        }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'QUEUE_STATE_INVALID',
    );
    // Case-aliased directory spelling (same dev:ino on case-insensitive APFS/HFS+) MUST also fail closed
    // WITHOUT touching .relay.lock or canceling the original owner's POSIX kernel lock!
    const relayModuleHref = new URL('../src/relay-server.js', import.meta.url).href;
    const caseAliasedCasDir = join(dir, 'SHARED-CAS');
    const sharedDirStat = await lstat(sharedCasDir);
    const aliasDirStat = await lstat(caseAliasedCasDir).catch(() => null);
    if (aliasDirStat !== null && aliasDirStat.dev === sharedDirStat.dev && aliasDirStat.ino === sharedDirStat.ino) {
      await assert.rejects(
        () =>
          startRelayServer({
            port: 0,
            casDir: caseAliasedCasDir,
            controllerSigningSecret: CONTROLLER_SECRET,
            controllerAuthToken: CONTROLLER_BEARER,
            workerTokens: [WORKER_TOKEN],
          }),
        (err: unknown) => err instanceof HardwareRunnerError && err.code === 'QUEUE_STATE_INVALID',
      );
      // Verify the original owner's OS kernel exclusive lock is STILL intact against an external child process!
      const probeScript = `
        import { startRelayServer } from ${JSON.stringify(relayModuleHref)};
        try {
          const r = await startRelayServer({
            port: 0,
            casDir: ${JSON.stringify(sharedCasDir)},
            controllerSigningSecret: ${JSON.stringify(CONTROLLER_SECRET)},
            workerTokens: [${JSON.stringify(WORKER_TOKEN)}],
          });
          await r.close();
          process.exit(0);
        } catch (err) {
          process.stdout.write('CODE:' + (err && typeof err === 'object' && 'code' in err ? err.code : 'ERR') + '\\n');
          process.exit(42);
        }
      `;
      const probeOut = await new Promise<{ code: number | null; stdout: string }>(resolveProbe => {
        const p = spawn(process.execPath, ['--input-type=module', '-e', probeScript], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        p.stdout.on('data', (c: Buffer) => {
          out += c.toString('utf8');
        });
        p.once('exit', code => resolveProbe({ code, stdout: out }));
      });
      assert.equal(probeOut.code, 42);
      assert.match(probeOut.stdout, /CODE:QUEUE_STATE_INVALID/);
    }
    // Running relay's active .tmp-* files and .relay.lock MUST remain intact!
    assert.equal(await readFile(liveTmpBlob, 'utf8'), 'live-upload-bytes');
    assert.equal(await readFile(liveTmpReceipt, 'utf8'), '{"live":true}');
    assert.equal((await lstat(join(sharedCasDir, '.relay.lock'))).isFile(), true);

    await relayLockHolder.close();
    // Lock file inode remains stable on disk so competing processes always lock the same inode;
    // restart after clean close() immediately acquires ownership and cleans stale .tmp-* files!
    const relayAfterClose = await startRelayServer({
      port: 0,
      casDir: sharedCasDir,
      controllerSigningSecret: CONTROLLER_SECRET,
      controllerAuthToken: CONTROLLER_BEARER,
      workerTokens: [WORKER_TOKEN],
    });
    await assert.rejects(() => lstat(liveTmpBlob));
    await assert.rejects(() => lstat(liveTmpReceipt));
    await relayAfterClose.close();

    // Cross-process exclusivity + abrupt SIGKILL kernel lock release:
    // Spawn a real Node child process holding the SQLite EXCLUSIVE lock on sharedCasDir,
    // verify this process cannot start a competing Relay, SIGKILL the child, and verify immediate recovery!
    const childScript = `
      import { startRelayServer } from ${JSON.stringify(relayModuleHref)};
      const relay = await startRelayServer({
        port: 0,
        casDir: ${JSON.stringify(sharedCasDir)},
        controllerSigningSecret: ${JSON.stringify(CONTROLLER_SECRET)},
        workerTokens: [${JSON.stringify(WORKER_TOKEN)}],
      });
      process.stdout.write('READY:' + relay.url + '\\n');
      setInterval(() => {}, 60_000);
    `;
    const childProc = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        let out = '';
        let errOut = '';
        const timer = setTimeout(() => rejectReady(new Error(`child relay timed out: ${errOut}`)), 10_000);
        childProc.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString('utf8');
          if (out.includes('READY:')) {
            clearTimeout(timer);
            resolveReady();
          }
        });
        childProc.stderr.on('data', (chunk: Buffer) => {
          errOut += chunk.toString('utf8');
        });
        childProc.once('exit', code => {
          clearTimeout(timer);
          rejectReady(new Error(`child relay exited early (${code}): ${errOut}`));
        });
      });

      // Competing Relay in another OS process MUST fail closed with QUEUE_STATE_INVALID!
      await assert.rejects(
        () =>
          startRelayServer({
            port: 0,
            casDir: sharedCasDir,
            controllerSigningSecret: CONTROLLER_SECRET,
            workerTokens: [WORKER_TOKEN],
          }),
        (err: unknown) => err instanceof HardwareRunnerError && err.code === 'QUEUE_STATE_INVALID',
      );

      // Abrupt SIGKILL releases OS kernel EXCLUSIVE lock immediately -> restart succeeds cleanly!
      const exitWait = new Promise<void>(resolveExit => {
        childProc.once('exit', () => resolveExit());
      });
      childProc.kill('SIGKILL');
      await exitWait;

      const relayAfterSigkill = await startRelayServer({
        port: 0,
        casDir: sharedCasDir,
        controllerSigningSecret: CONTROLLER_SECRET,
        workerTokens: [WORKER_TOKEN],
      });
      await relayAfterSigkill.close();
    } finally {
      if (childProc.exitCode === null && childProc.signalCode === null) {
        childProc.kill('SIGKILL');
      }
    }

    // 3. Bounded terminal caches (maxRetainedTerminalOps: 2) + evicted settled-op idempotent replay & output GET
    //    + live targetCellId enforcement + concurrent 429 candidate staging preservation + non-ENOENT fail-closed!
    const capCasDir = join(dir, 'cap-cas');
    const relayCap = await startRelayServer({
      port: 0,
      casDir: capCasDir,
      controllerSigningSecret: CONTROLLER_SECRET,
      controllerAuthToken: CONTROLLER_BEARER,
      workerTokens: [WORKER_TOKEN],
      maxJobs: 1,
      maxRetainedTerminalOps: 2,
    });

    const op0InputBytes = Buffer.from('op0-candidate-kernel-cu');
    const op0InputSha = sha256Hex(op0InputBytes);
    const op0OutputBytes = Buffer.from('op0-compiled-sm90a-cubin');
    const op0OutputSha = sha256Hex(op0OutputBytes);
    const op1OutputBytes = Buffer.from('op1-other-output-cubin');
    const op1OutputSha = sha256Hex(op1OutputBytes);

    const reqOp0 = makeBenchmarkRequest({
      operationId: 'verify.0.check.evict-0',
      candidateArtifacts: {
        entries: [{ name: 'k0.cu', digest: { algorithm: 'sha256', hex: op0InputSha }, byteLength: op0InputBytes.byteLength }],
        deleted: [],
      },
    });

    try {
      // Stage input for op-0
      const st0 = await streamHttpPutUnevenChunks(
        `${relayCap.url}/v1/benchmark/jobs/${reqOp0.operationId}/blobs/${op0InputSha}`,
        {
          authorization: `Bearer ${CONTROLLER_BEARER}`,
          'x-loopwright-blob-sha256': op0InputSha,
          'x-loopwright-blob-length': String(op0InputBytes.byteLength),
          'x-loopwright-signature': signRelayPayload(
            CONTROLLER_SECRET,
            `PUT\n${reqOp0.operationId}\n${op0InputSha}\n${op0InputBytes.byteLength}`,
          ),
        },
        [op0InputBytes],
      );
      assert.equal(st0.status, 201);

      // Complete 5 sequential operations (evicting op-0, op-1, op-2 from the 2-entry in-memory caches)
      for (let i = 0; i < 5; i += 1) {
        const reqI = i === 0 ? reqOp0 : makeBenchmarkRequest({ operationId: `verify.0.check.evict-${i}` });
        const subI = await postSignedBenchmarkJob(relayCap, reqI);
        assert.equal(subI.status, 200);

        const acqI = await fetch(`${relayCap.url}/v1/runner/leases:acquire`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
          body: JSON.stringify({
            workerId: `w-cap-${i}`,
            capabilities: { accelerator: 'sm_90a', isolationModes: ['whole_device'], deviceCount: 1, driverVersion: '550.90.07' },
          }),
        });
        const gI = (await acqI.json()) as LeaseGrant;

        if (i === 0) {
          // Item 9: Mismatched hardwareProvenance.targetCellId MUST be rejected live with 422 ARTIFACT_INVALID
          //         before signing or writing any receipt!
          const badCellComplete = await fetch(`${relayCap.url}/v1/runner/leases/${gI.jobId}:complete`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
            body: JSON.stringify({
              relayBootId: gI.relayBootId,
              leaseEpoch: gI.leaseEpoch,
              leaseToken: gI.leaseToken,
              status: 'approved',
              reason: null,
              hardwareProvenance: { ...makeProvenance(), targetCellId: 'wrong-cell-id' },
            }),
          });
          assert.equal(badCellComplete.status, 422);
          assert.equal(((await badCellComplete.json()) as { code: string }).code, 'ARTIFACT_INVALID');
          await assert.rejects(() => lstat(join(capCasDir, 'receipts', `${reqOp0.operationId}.json`)));
        }

        const outPayload = i === 0 ? op0OutputBytes : i === 1 ? op1OutputBytes : null;
        const outDigest = i === 0 ? op0OutputSha : i === 1 ? op1OutputSha : null;
        if (outPayload !== null && outDigest !== null) {
          const upRes = await streamHttpPutUnevenChunks(
            `${relayCap.url}/v1/runner/leases/${gI.jobId}/blobs/${outDigest}`,
            {
              authorization: `Bearer ${WORKER_TOKEN}`,
              'x-loopwright-relay-boot-id': gI.relayBootId,
              'x-loopwright-lease-epoch': String(gI.leaseEpoch),
              'x-loopwright-lease-token': gI.leaseToken,
              'x-loopwright-blob-sha256': outDigest,
              'x-loopwright-blob-length': String(outPayload.byteLength),
            },
            [outPayload],
          );
          assert.equal(upRes.status, 201);
        }

        const compI = await fetch(`${relayCap.url}/v1/runner/leases/${gI.jobId}:complete`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
          body: JSON.stringify({
            relayBootId: gI.relayBootId,
            leaseEpoch: gI.leaseEpoch,
            leaseToken: gI.leaseToken,
            status: 'approved',
            reason: null,
            detail: `completed-${i}`,
            hardwareProvenance: makeProvenance(),
            ...(outPayload !== null && outDigest !== null
              ? {
                  outputArtifacts: [
                    { name: `out-${i}.cubin`, digest: { algorithm: 'sha256', hex: outDigest }, byteLength: outPayload.byteLength },
                  ],
                }
              : {}),
          }),
        });
        assert.equal(compI.status, 200);
      }

      // Terminal caches are strictly bounded to maxRetainedTerminalOps === 2!
      assert.equal(relayCap.retainedTerminalCount(), 2);

      const op0ReceiptPath = join(capCasDir, 'receipts', `${reqOp0.operationId}.json`);
      const receiptStatBefore = await lstat(op0ReceiptPath);
      const receiptBytesBefore = await readFile(op0ReceiptPath);

      // Evicted settled operation replay (Controller PUT + POST) returns original signed verdict WITHOUT
      // enqueuing new work or overwriting the receipt, and cache stays bounded!
      const replayPut0 = await streamHttpPutUnevenChunks(
        `${relayCap.url}/v1/benchmark/jobs/${reqOp0.operationId}/blobs/${op0InputSha}`,
        {
          authorization: `Bearer ${CONTROLLER_BEARER}`,
          'x-loopwright-blob-sha256': op0InputSha,
          'x-loopwright-blob-length': String(op0InputBytes.byteLength),
          'x-loopwright-signature': signRelayPayload(
            CONTROLLER_SECRET,
            `PUT\n${reqOp0.operationId}\n${op0InputSha}\n${op0InputBytes.byteLength}`,
          ),
        },
        [op0InputBytes],
      );
      assert.equal(replayPut0.status, 200);

      const replayPost0 = await postSignedBenchmarkJob(relayCap, reqOp0);
      assert.equal(replayPost0.status, 200);
      assert.equal((replayPost0.json as BenchmarkVerdict).status, 'approved');
      assert.equal((replayPost0.json as BenchmarkVerdict).detail, 'completed-0');
      assert.equal(relayCap.retainedTerminalCount(), 2);

      // Conflicting repost on evicted settled op returns 409 QUEUE_JOB_CONFLICT
      const conflictEvicted = await postSignedBenchmarkJob(
        relayCap,
        makeBenchmarkRequest({ ...reqOp0, requestDigest: sha256Hex('evicted-conflict') }),
      );
      assert.equal(conflictEvicted.status, 409);

      // Worker queue remains completely empty (zero re-enqueued work!) and receipt inode/bytes untouched!
      const emptyAcqAfterReplay = await fetch(`${relayCap.url}/v1/runner/leases:acquire`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
        body: JSON.stringify({
          workerId: 'w-verify-empty',
          capabilities: { accelerator: 'sm_90a', isolationModes: ['whole_device'], deviceCount: 1, driverVersion: '550.90.07' },
          waitMs: 0,
        }),
      });
      assert.equal(emptyAcqAfterReplay.status, 204);
      const receiptStatAfter = await lstat(op0ReceiptPath);
      assert.equal(receiptStatAfter.ino, receiptStatBefore.ino);
      assert.equal((await readFile(op0ReceiptPath)).equals(receiptBytesBefore), true);

      // Evicted settled operation GET still serves declared output (200) and refuses unrelated CAS digest (403)!
      const getEvictedDeclared = await fetch(`${relayCap.url}/v1/benchmark/jobs/${reqOp0.operationId}/blobs/${op0OutputSha}`, {
        headers: {
          authorization: `Bearer ${CONTROLLER_BEARER}`,
          'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, `GET\n${reqOp0.operationId}\n${op0OutputSha}`),
        },
      });
      assert.equal(getEvictedDeclared.status, 200);
      assert.equal(Buffer.from(await getEvictedDeclared.arrayBuffer()).equals(op0OutputBytes), true);

      const getEvictedUnrelated = await fetch(`${relayCap.url}/v1/benchmark/jobs/${reqOp0.operationId}/blobs/${op1OutputSha}`, {
        headers: {
          authorization: `Bearer ${CONTROLLER_BEARER}`,
          'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, `GET\n${reqOp0.operationId}\n${op1OutputSha}`),
        },
      });
      assert.equal(getEvictedUnrelated.status, 403);

      // Item 11: Concurrent two-operation maxJobs=1 admission preserves the 429 loser's staged candidate blobs!
      const concBytesA = Buffer.from('concurrent-cand-blob-a');
      const concShaA = sha256Hex(concBytesA);
      const concBytesB = Buffer.from('concurrent-cand-blob-b');
      const concShaB = sha256Hex(concBytesB);
      for (const [opName, sha, buf] of [
        ['op-conc-a', concShaA, concBytesA],
        ['op-conc-b', concShaB, concBytesB],
      ] as const) {
        const st = await streamHttpPutUnevenChunks(
          `${relayCap.url}/v1/benchmark/jobs/${opName}/blobs/${sha}`,
          {
            authorization: `Bearer ${CONTROLLER_BEARER}`,
            'x-loopwright-blob-sha256': sha,
            'x-loopwright-blob-length': String(buf.byteLength),
            'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, `PUT\n${opName}\n${sha}\n${buf.byteLength}`),
          },
          [buf],
        );
        assert.equal(st.status, 201);
      }

      const reqConcA = makeBenchmarkRequest({
        operationId: 'op-conc-a',
        candidateArtifacts: {
          entries: [{ name: 'a.cu', digest: { algorithm: 'sha256', hex: concShaA }, byteLength: concBytesA.byteLength }],
          deleted: [],
        },
      });
      const reqConcB = makeBenchmarkRequest({
        operationId: 'op-conc-b',
        candidateArtifacts: {
          entries: [{ name: 'b.cu', digest: { algorithm: 'sha256', hex: concShaB }, byteLength: concBytesB.byteLength }],
          deleted: [],
        },
      });

      const [resConcA, resConcB] = await Promise.all([
        postSignedBenchmarkJob(relayCap, reqConcA),
        postSignedBenchmarkJob(relayCap, reqConcB),
      ]);
      const statuses = [resConcA.status, resConcB.status].sort((x, y) => x - y);
      assert.deepEqual(statuses, [200, 429]);

      const loserReq = resConcA.status === 429 ? reqConcA : reqConcB;
      const loserBytes = resConcA.status === 429 ? concBytesA : concBytesB;
      const loserSha = resConcA.status === 429 ? concShaA : concShaB;

      // Complete the winner to free the single maxJobs=1 slot
      const acqWinner = await fetch(`${relayCap.url}/v1/runner/leases:acquire`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
        body: JSON.stringify({
          workerId: 'w-conc-winner',
          capabilities: { accelerator: 'sm_90a', isolationModes: ['whole_device'], deviceCount: 1, driverVersion: '550.90.07' },
        }),
      });
      const grantWinner = (await acqWinner.json()) as LeaseGrant;
      const compWinner = await fetch(`${relayCap.url}/v1/runner/leases/${grantWinner.jobId}:complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
        body: JSON.stringify({
          relayBootId: grantWinner.relayBootId,
          leaseEpoch: grantWinner.leaseEpoch,
          leaseToken: grantWinner.leaseToken,
          status: 'approved',
          reason: null,
          hardwareProvenance: makeProvenance(),
        }),
      });
      assert.equal(compWinner.status, 200);

      // Retry the 429 loser WITHOUT re-PUTting its candidate blobs -> succeeds with 200 (never 409 ARTIFACT_MISSING)!
      const retryLoser = await postSignedBenchmarkJob(relayCap, loserReq);
      assert.equal(retryLoser.status, 200);
      const acqLoser = await fetch(`${relayCap.url}/v1/runner/leases:acquire`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
        body: JSON.stringify({
          workerId: 'w-conc-loser',
          capabilities: { accelerator: 'sm_90a', isolationModes: ['whole_device'], deviceCount: 1, driverVersion: '550.90.07' },
        }),
      });
      const grantLoser = (await acqLoser.json()) as LeaseGrant;
      assert.equal(grantLoser.operationId, loserReq.operationId);
      const loserInputDownload = await fetch(`${relayCap.url}/v1/runner/leases/${grantLoser.jobId}/blobs/${loserSha}`, {
        headers: {
          authorization: `Bearer ${WORKER_TOKEN}`,
          'x-loopwright-relay-boot-id': grantLoser.relayBootId,
          'x-loopwright-lease-epoch': String(grantLoser.leaseEpoch),
          'x-loopwright-lease-token': grantLoser.leaseToken,
        },
      });
      assert.equal(loserInputDownload.status, 200);
      assert.equal(Buffer.from(await loserInputDownload.arrayBuffer()).equals(loserBytes), true);
      await fetch(`${relayCap.url}/v1/runner/leases/${grantLoser.jobId}:complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
        body: JSON.stringify({
          relayBootId: grantLoser.relayBootId,
          leaseEpoch: grantLoser.leaseEpoch,
          leaseToken: grantLoser.leaseToken,
          status: 'approved',
          reason: null,
          hardwareProvenance: makeProvenance(),
        }),
      });

      // Item 2: Non-ENOENT errors (EACCES 0o000, bad mode 0o644, symlink, tampered HMAC) on existing records
      //         MUST fail closed (500) and NEVER overwrite the existing file!
      const unreadableOpPath = join(capCasDir, 'operations', 'op-unreadable-existing.json');
      await writeFile(unreadableOpPath, '{"protected":true}', { mode: 0o600 });
      const unreadableInoBefore = (await lstat(unreadableOpPath)).ino;
      await chmod(unreadableOpPath, 0o000);
      try {
        const resUnreadable = await postSignedBenchmarkJob(
          relayCap,
          makeBenchmarkRequest({ operationId: 'op-unreadable-existing' }),
        );
        assert.equal(resUnreadable.status, 500);
        assert.equal((await lstat(unreadableOpPath)).ino, unreadableInoBefore);
      } finally {
        await chmod(unreadableOpPath, 0o600);
        assert.equal(await readFile(unreadableOpPath, 'utf8'), '{"protected":true}');
        await unlink(unreadableOpPath);
      }

      const symlinkRcptTarget = join(dir, 'outside-rcpt.json');
      await writeFile(symlinkRcptTarget, '{"outside":true}', { mode: 0o600 });
      const symlinkRcptPath = join(capCasDir, 'receipts', 'op-symlink-rcpt.json');
      await symlink(symlinkRcptTarget, symlinkRcptPath);
      try {
        const resSymRcpt = await postSignedBenchmarkJob(
          relayCap,
          makeBenchmarkRequest({ operationId: 'op-symlink-rcpt' }),
        );
        assert.equal(resSymRcpt.status, 500);
        assert.equal((await lstat(symlinkRcptPath)).isSymbolicLink(), true);
      } finally {
        await unlink(symlinkRcptPath);
      }
    } finally {
      await relayCap.close();
    }

    // Restart with maxRetainedTerminalOps: 2 across 7 persisted receipts on disk:
    // verifies startup validates all records without loading unbounded history into memory!
    const relayCapRestart = await startRelayServer({
      port: 0,
      casDir: capCasDir,
      controllerSigningSecret: CONTROLLER_SECRET,
      controllerAuthToken: CONTROLLER_BEARER,
      workerTokens: [WORKER_TOKEN],
      maxJobs: 1,
      maxRetainedTerminalOps: 2,
    });
    try {
      assert.equal(relayCapRestart.retainedTerminalCount(), 2);
      const postEvictedAfterRestart = await postSignedBenchmarkJob(relayCapRestart, reqOp0);
      assert.equal(postEvictedAfterRestart.status, 200);
      assert.equal((postEvictedAfterRestart.json as BenchmarkVerdict).detail, 'completed-0');
      assert.equal(relayCapRestart.retainedTerminalCount(), 2);
    } finally {
      await relayCapRestart.close();
    }

    // 4. Item 10: Final-fence expiry race on final retry (maxPreemptions: 0) at :complete's commit check:
    //    - :complete returns 409 QUEUE_LEASE_FENCED,
    //    - winning expired / BENCHMARK_PREEMPTED receipt IS durably written immediately without a subsequent poll,
    //    - controller poll and restart both return that exact signed expired verdict!
    let raceMono = 20_000;
    let raceWall = 1_700_000_000_000;
    let raceHook: (() => void) | null = null;
    const raceClock: ClockSource = {
      nowMonotonicMs(): number {
        raceHook?.();
        return raceMono;
      },
      nowWallMs(): number {
        return raceWall;
      },
    };
    const finalFenceCas = join(dir, 'final-fence-cas');
    const relayFence = await startRelayServer({
      port: 0,
      casDir: finalFenceCas,
      controllerSigningSecret: CONTROLLER_SECRET,
      controllerAuthToken: CONTROLLER_BEARER,
      workerTokens: [WORKER_TOKEN],
      leaseTtlMs: 5_000,
      sweepIntervalMs: 60_000,
      clock: raceClock,
    });
    const reqFinalFence = makeBenchmarkRequest({ operationId: 'op-final-fence-expire', maxPreemptions: 0 });
    try {
      const subF = await postSignedBenchmarkJob(relayFence, reqFinalFence);
      assert.equal(subF.status, 200);
      const acqF = await fetch(`${relayFence.url}/v1/runner/leases:acquire`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
        body: JSON.stringify({
          workerId: 'w-final-fence',
          capabilities: { accelerator: 'sm_90a', isolationModes: ['whole_device'], deviceCount: 1, driverVersion: '550.90.07' },
        }),
      });
      const gF = (await acqF.json()) as LeaseGrant;

      let fenceSampleCount = 0;
      raceHook = () => {
        fenceSampleCount += 1;
        // Sample 1 = prepareCompleteLease; Sample 2 = verifyActiveLease before staging; Sample 3 = prepared.commit() final fence!
        if (fenceSampleCount === 3) {
          raceMono += 5_000;
          raceWall += 5_000;
        }
      };
      const fencedCompleteRes = await fetch(`${relayFence.url}/v1/runner/leases/${gF.jobId}:complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
        body: JSON.stringify({
          relayBootId: gF.relayBootId,
          leaseEpoch: gF.leaseEpoch,
          leaseToken: gF.leaseToken,
          status: 'approved',
          reason: null,
          hardwareProvenance: makeProvenance(),
        }),
      });
      raceHook = null;
      assert.equal(fencedCompleteRes.status, 409);
      assert.equal(((await fencedCompleteRes.json()) as { code: string }).code, 'QUEUE_LEASE_FENCED');

      // Immediately inspect <casDir>/receipts/op-final-fence-expire.json BEFORE any controller poll!
      const fenceReceiptPath = join(finalFenceCas, 'receipts', 'op-final-fence-expire.json');
      const fenceReceiptStat = await lstat(fenceReceiptPath);
      assert.equal(fenceReceiptStat.mode & 0o777, 0o600);
      const fenceReceiptJson = JSON.parse(await readFile(fenceReceiptPath, 'utf8')) as SignedBenchmarkVerdictReceipt;
      assert.equal(fenceReceiptJson.status, 'expired');
      assert.equal(fenceReceiptJson.reason, 'BENCHMARK_PREEMPTED');
      assert.equal(fenceReceiptJson.retryablePreemption, true);
      assert.equal(
        verifyBenchmarkVerdictSignature(
          CONTROLLER_SECRET,
          fenceReceiptJson as unknown as Record<string, unknown>,
          fenceReceiptJson.signature,
        ),
        true,
      );

      // Controller poll returns the exact signed expired verdict
      const pollAfterFence = await postSignedBenchmarkJob(relayFence, reqFinalFence);
      assert.equal(pollAfterFence.status, 200);
      assert.equal((pollAfterFence.json as BenchmarkVerdict).status, 'expired');
      assert.equal((pollAfterFence.json as BenchmarkVerdict).reason, 'BENCHMARK_PREEMPTED');
    } finally {
      raceHook = null;
      await relayFence.close();
    }

    // Restart on finalFenceCas also recovers and returns the exact signed expired verdict!
    const relayFenceRestart = await startRelayServer({
      port: 0,
      casDir: finalFenceCas,
      controllerSigningSecret: CONTROLLER_SECRET,
      controllerAuthToken: CONTROLLER_BEARER,
      workerTokens: [WORKER_TOKEN],
    });
    try {
      const pollRestartedFence = await postSignedBenchmarkJob(relayFenceRestart, reqFinalFence);
      assert.equal(pollRestartedFence.status, 200);
      assert.equal((pollRestartedFence.json as BenchmarkVerdict).status, 'expired');
      assert.equal((pollRestartedFence.json as BenchmarkVerdict).reason, 'BENCHMARK_PREEMPTED');
    } finally {
      await relayFenceRestart.close();
    }

    // 4. Capacity reservation (effectiveActiveCap = min(maxJobs, maxRetainedTerminalOps)),
    //    simultaneous expiry of 2 leases during deterministic receipt persistence outage (works under any UID),
    //    and orderly shutdown flush + fail-closed recovery fence on unflushable terminal verdicts!
    const capReserveCas = join(dir, 'cap-reserve-cas');
    const relayReserve = await startRelayServer({
      port: 0,
      casDir: capReserveCas,
      controllerSigningSecret: CONTROLLER_SECRET,
      controllerAuthToken: CONTROLLER_BEARER,
      workerTokens: [WORKER_TOKEN],
      maxJobs: 2,
      maxRetainedTerminalOps: 1,
    });
    try {
      const reqRes1 = makeBenchmarkRequest({ operationId: 'op-reserve-1', maxPreemptions: 0 });
      const reqRes2 = makeBenchmarkRequest({ operationId: 'op-reserve-2', maxPreemptions: 0 });
      assert.equal((await postSignedBenchmarkJob(relayReserve, reqRes1)).status, 200);
      // 2nd concurrent admission is rejected with 429 because maxRetainedTerminalOps=1 reserves durability capacity!
      assert.equal((await postSignedBenchmarkJob(relayReserve, reqRes2)).status, 429);
    } finally {
      await relayReserve.close();
    }

    const activeEvictCas = join(dir, 'active-evict-cas');
    let simMono = 900_000;
    let simWall = 1_760_100_000_000;
    const simClock: ClockSource = {
      nowMonotonicMs: () => simMono,
      nowWallMs: () => simWall,
    };
    let failReceiptWrites = false;
    let failLaterFenceUpdates = false;
    let fenceUpdateFailureCount = 0;
    const relayEvict = await startRelayServer({
      port: 0,
      casDir: activeEvictCas,
      controllerSigningSecret: CONTROLLER_SECRET,
      controllerAuthToken: CONTROLLER_BEARER,
      workerTokens: [WORKER_TOKEN],
      maxJobs: 2,
      maxRetainedTerminalOps: 2,
      leaseTtlMs: 1_000,
      sweepIntervalMs: 60_000,
      clock: simClock,
      onBeforeReceiptPersist: () => {
        if (failReceiptWrites) {
          throw new Error('injected deterministic receipt persistence failure');
        }
      },
      onBeforeFenceUpdate: (_opId, reason) => {
        if (failLaterFenceUpdates && reason !== 'operation_admitted') {
          fenceUpdateFailureCount += 1;
          throw new Error('injected deterministic fence storage failure');
        }
      },
    });
    try {
      const reqA = makeBenchmarkRequest({ operationId: 'op-sim-expire-a', maxPreemptions: 0 });
      const reqB = makeBenchmarkRequest({ operationId: 'op-sim-expire-b', maxPreemptions: 0 });
      assert.equal((await postSignedBenchmarkJob(relayEvict, reqA)).status, 200);
      assert.equal((await postSignedBenchmarkJob(relayEvict, reqB)).status, 200);
      for (const workerId of ['w-sim-a', 'w-sim-b']) {
        const acq = await fetch(`${relayEvict.url}/v1/runner/leases:acquire`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
          body: JSON.stringify({
            workerId,
            capabilities: { accelerator: 'sm_90a', isolationModes: ['whole_device'], deviceCount: 1, driverVersion: '550.90.07' },
          }),
        });
        assert.equal(acq.status, 200);
      }

      // Inject deterministic receipt failure and expire BOTH leases simultaneously:
      // retainedTerminalCount NEVER exceeds maxRetainedTerminalOps (2), and 3rd admission returns 429!
      failReceiptWrites = true;
      simMono += 2_000;
      simWall += 2_000;
      const failPollA = await postSignedBenchmarkJob(relayEvict, reqA);
      assert.equal(failPollA.status, 500);
      const failPollB = await postSignedBenchmarkJob(relayEvict, reqB);
      assert.equal(failPollB.status, 500);
      assert.equal(relayEvict.retainedTerminalCount(), 2);

      const reqOverflow = makeBenchmarkRequest({ operationId: 'op-sim-overflow', maxPreemptions: 0 });
      const rejectedOverflow = await postSignedBenchmarkJob(relayEvict, reqOverflow);
      assert.equal(rejectedOverflow.status, 429);

      // Clear outage: both expired verdicts persist durably and return identical expired/BENCHMARK_PREEMPTED verdicts!
      failReceiptWrites = false;
      const okPollA = await postSignedBenchmarkJob(relayEvict, reqA);
      const okPollB = await postSignedBenchmarkJob(relayEvict, reqB);
      assert.equal(okPollA.status, 200);
      assert.equal((okPollA.json as BenchmarkVerdict).status, 'expired');
      assert.equal((okPollA.json as BenchmarkVerdict).reason, 'BENCHMARK_PREEMPTED');
      assert.equal(okPollB.status, 200);
      assert.equal((okPollB.json as BenchmarkVerdict).status, 'expired');
      assert.equal((okPollB.json as BenchmarkVerdict).reason, 'BENCHMARK_PREEMPTED');
      assert.ok(relayEvict.retainedTerminalCount() <= 2);

      // Shutdown flush & fail-closed recovery fence:
      // Expire reqC during receipt outage (including null rejection sentinel check + simultaneous lock-DB read-only!),
      // call close() while outage persists -> close() MUST reject AND preserve pre-allocated recovery_fence!
      const reqC = makeBenchmarkRequest({
        operationId: 'op-fence-unflushed-c',
        maxPreemptions: 0,
        candidateArtifacts: {
          entries: [
            { name: 'run.sh', digest: { algorithm: 'sha256', hex: EMPTY_SHA256_HEX }, byteLength: 0, mode: '100755' },
          ],
          deleted: [],
        },
      });
      const stEmptyC = await streamHttpPutUnevenChunks(
        `${relayEvict.url}/v1/benchmark/jobs/${reqC.operationId}/blobs/${EMPTY_SHA256_HEX}`,
        {
          authorization: `Bearer ${CONTROLLER_BEARER}`,
          'x-loopwright-blob-sha256': EMPTY_SHA256_HEX,
          'x-loopwright-blob-length': '0',
          'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, `PUT\n${reqC.operationId}\n${EMPTY_SHA256_HEX}\n0`),
        },
        [],
      );
      assert.ok(stEmptyC.status === 200 || stEmptyC.status === 201);
      assert.equal((await postSignedBenchmarkJob(relayEvict, reqC)).status, 200);
      const acqC = await fetch(`${relayEvict.url}/v1/runner/leases:acquire`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
        body: JSON.stringify({
          workerId: 'w-sim-c',
          capabilities: { accelerator: 'sm_90a', isolationModes: ['whole_device'], deviceCount: 1, driverVersion: '550.90.07' },
        }),
      });
      assert.equal(acqC.status, 200);
      const grantC = (await acqC.json()) as LeaseGrant;
      assert.equal(grantC.job.candidateArtifacts.entries[0]?.mode, '100755');
      // Force BOTH receipt persistence AND later SQLite fence updates to fail BEFORE the first failed poll!
      failReceiptWrites = true;
      failLaterFenceUpdates = true;
      simMono += 2_000;
      simWall += 2_000;
      assert.equal((await postSignedBenchmarkJob(relayEvict, reqC)).status, 500);
    } finally {
      await assert.rejects(() => relayEvict.close());
    }
    assert.ok(fenceUpdateFailureCount >= 2, 'later fence updates must have failed during both poll and shutdown');
    // Verify the original pre-admission 'operation_admitted' fence row survived untouched on disk!
    const inspectDb = new DatabaseSync(join(activeEvictCas, '.relay.lock'), { readOnly: true });
    try {
      const fenceRow = inspectDb
        .prepare('SELECT operation_id, reason FROM recovery_fence WHERE operation_id = ?')
        .get('op-fence-unflushed-c') as { operation_id?: string; reason?: string } | undefined;
      assert.equal(fenceRow?.operation_id, 'op-fence-unflushed-c');
      assert.equal(fenceRow?.reason, 'operation_admitted');
    } finally {
      inspectDb.close();
    }

    // Clean shutdown racing mid-descriptor-persistence MUST NOT strand a fence for an unadmitted job,
    // and restart on the same casDir MUST succeed cleanly!
    const midShutdownCas = join(dir, 'mid-shutdown-cas');
    let releasePersistGate!: () => void;
    let signalPersistEntered!: () => void;
    const persistEntered = new Promise<void>(resolveEntered => {
      signalPersistEntered = resolveEntered;
    });
    const persistGate = new Promise<void>(resolveGate => {
      releasePersistGate = resolveGate;
    });
    const relayMidShutdown = await startRelayServer({
      port: 0,
      casDir: midShutdownCas,
      controllerSigningSecret: CONTROLLER_SECRET,
      controllerAuthToken: CONTROLLER_BEARER,
      workerTokens: [WORKER_TOKEN],
      onBeforeOperationPersist: async () => {
        signalPersistEntered();
        await persistGate;
      },
    });
    const reqMid = makeBenchmarkRequest({ operationId: 'op-mid-shutdown', maxPreemptions: 0 });
    const midPostPromise = postSignedBenchmarkJob(relayMidShutdown, reqMid);
    await persistEntered;
    const midClosePromise = relayMidShutdown.close();
    releasePersistGate();
    const midPostRes = await midPostPromise;
    await midClosePromise;
    assert.equal(midPostRes.status, 400);
    assert.equal((midPostRes.json as { code?: string }).code, 'QUEUE_STATE_INVALID');
    const relayAfterMidShutdown = await startRelayServer({
      port: 0,
      casDir: midShutdownCas,
      controllerSigningSecret: CONTROLLER_SECRET,
      controllerAuthToken: CONTROLLER_BEARER,
      workerTokens: [WORKER_TOKEN],
    });
    await relayAfterMidShutdown.close();

    // Restarting on activeEvictCas MUST fail closed with QUEUE_STATE_INVALID because reqC's pre-allocated fence survived!
    await assert.rejects(
      () =>
        startRelayServer({
          port: 0,
          casDir: activeEvictCas,
          controllerSigningSecret: CONTROLLER_SECRET,
          workerTokens: [WORKER_TOKEN],
        }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'QUEUE_STATE_INVALID',
    );

    // A fenced operation with a malformed or forged-signature receipt MUST ALSO fail with QUEUE_STATE_INVALID (preserving fence)!
    const fencedReceiptPath = join(activeEvictCas, 'receipts', 'op-fence-unflushed-c.json');
    await writeFile(fencedReceiptPath, '{malformed-json', { mode: 0o600 });
    await assert.rejects(
      () =>
        startRelayServer({
          port: 0,
          casDir: activeEvictCas,
          controllerSigningSecret: CONTROLLER_SECRET,
          workerTokens: [WORKER_TOKEN],
        }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'QUEUE_STATE_INVALID' && err.cause !== undefined,
    );
    await unlink(fencedReceiptPath);

    // Orderly close() rejects even when a persistence failure throws `null`!
    const nullErrCas = join(dir, 'null-reject-cas');
    let nullFail = false;
    let nullMono = 400_000;
    let nullWall = 1_760_150_000_000;
    const relayNullErr = await startRelayServer({
      port: 0,
      casDir: nullErrCas,
      controllerSigningSecret: CONTROLLER_SECRET,
      controllerAuthToken: CONTROLLER_BEARER,
      workerTokens: [WORKER_TOKEN],
      leaseTtlMs: 1_000,
      sweepIntervalMs: 60_000,
      clock: { nowMonotonicMs: () => nullMono, nowWallMs: () => nullWall },
      onBeforeReceiptPersist: () => {
        if (nullFail) throw null;
      },
    });
    const reqNull = makeBenchmarkRequest({ operationId: 'op-null-reject', maxPreemptions: 0 });
    assert.equal((await postSignedBenchmarkJob(relayNullErr, reqNull)).status, 200);
    const acqNull = await fetch(`${relayNullErr.url}/v1/runner/leases:acquire`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
      body: JSON.stringify({
        workerId: 'w-null',
        capabilities: { accelerator: 'sm_90a', isolationModes: ['whole_device'], deviceCount: 1, driverVersion: '550.90.07' },
      }),
    });
    assert.equal(acqNull.status, 200);
    nullFail = true;
    nullMono += 2_000;
    nullWall += 2_000;
    assert.equal((await postSignedBenchmarkJob(relayNullErr, reqNull)).status, 500);
    let rejectedNull = false;
    try {
      await relayNullErr.close();
    } catch (err: unknown) {
      rejectedNull = true;
      assert.equal(err, null);
    }
    assert.equal(rejectedNull, true);

    // Orderly close() flushes an undurable expired verdict cleanly once receipt persistence recovers!
    const flushCas = join(dir, 'shutdown-flush-cas');
    let flushFail = false;
    let flushMono = 500_000;
    let flushWall = 1_760_200_000_000;
    const relayFlush = await startRelayServer({
      port: 0,
      casDir: flushCas,
      controllerSigningSecret: CONTROLLER_SECRET,
      controllerAuthToken: CONTROLLER_BEARER,
      workerTokens: [WORKER_TOKEN],
      leaseTtlMs: 1_000,
      sweepIntervalMs: 60_000,
      clock: { nowMonotonicMs: () => flushMono, nowWallMs: () => flushWall },
      onBeforeReceiptPersist: () => {
        if (flushFail) throw new Error('temporary receipt write failure');
      },
    });
    const reqFlush = makeBenchmarkRequest({ operationId: 'op-shutdown-flush', maxPreemptions: 0 });
    assert.equal((await postSignedBenchmarkJob(relayFlush, reqFlush)).status, 200);
    const acqFlush = await fetch(`${relayFlush.url}/v1/runner/leases:acquire`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${WORKER_TOKEN}` },
      body: JSON.stringify({
        workerId: 'w-flush',
        capabilities: { accelerator: 'sm_90a', isolationModes: ['whole_device'], deviceCount: 1, driverVersion: '550.90.07' },
      }),
    });
    assert.equal(acqFlush.status, 200);
    flushFail = true;
    flushMono += 2_000;
    flushWall += 2_000;
    assert.equal((await postSignedBenchmarkJob(relayFlush, reqFlush)).status, 500);
    flushFail = false;
    await relayFlush.close();

    const relayAfterFlush = await startRelayServer({
      port: 0,
      casDir: flushCas,
      controllerSigningSecret: CONTROLLER_SECRET,
      controllerAuthToken: CONTROLLER_BEARER,
      workerTokens: [WORKER_TOKEN],
    });
    try {
      const replayFlushed = await postSignedBenchmarkJob(relayAfterFlush, reqFlush);
      assert.equal(replayFlushed.status, 200);
      assert.equal((replayFlushed.json as BenchmarkVerdict).status, 'expired');
      assert.equal((replayFlushed.json as BenchmarkVerdict).reason, 'BENCHMARK_PREEMPTED');
    } finally {
      await relayAfterFlush.close();
    }
  } finally {
    await rm(directTmpCas, { recursive: true, force: true }).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
