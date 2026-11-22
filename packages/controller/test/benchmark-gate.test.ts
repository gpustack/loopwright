import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open as fsOpen, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { reopenLocalRun } from '@loopwright/state';
import { admitTask, bindSubject, type HardwareProvenance, type MetricThresholdRule } from '@loopwright/core';
import { configurationFixture } from './config-fixtures.js';
import { setFixture } from './progress-fixtures.js';
import { installedHandlerDigests } from '../src/handlers.js';
import { validateHandler } from '../src/registry.js';
import { checkpointCapacity, compilePlan } from '../src/compile.js';
import { checkedRefusalSubject } from '../src/refusal-record.js';
import { createCycle, Cycle, resolveStoreLeaseMs, runCycleWithPorts } from '../src/controller.js';
import { resumeCycleWithPorts } from '../src/recovery.js';
import { readRetained } from '../src/retained.js';
import { evaluateControllerAcceptance, verifyControllerVerifierCasDescriptors } from '../src/acceptance.js';
import { createBinarySecretStreamScanner, MAX_EXTRA_SECRET_LENGTH, stateValue } from '../src/storage.js';
import { ControllerOwner } from '../src/ownership.js';
import { approvedState } from '../src/config.js';
import { stepCancel, stepNext, stepSubmit, type StepTickResult } from '../src/step.js';
import { signPayload, verifySignedPayload } from '../src/gate.js';
import {
  BenchmarkGate,
  BENCHMARK_RESPONSE_BYTES,
  buildCandidateArtifactsDescriptor,
  checkedBenchmarkCandidateArtifacts,
  createRateLimitedProgress,
  checkedBenchmarkVerdict,
  checkedHardwareProvenance,
  checkedVerifierArtifactRef,
  collectPriorGenerationVerifierBudget,
  computeBenchmarkDisposition,
  decodeBenchmarkBaseTreeBundle,
  evaluateBenchmarkThresholds,
  expectedBenchmarkRequest,
  LWTREE01_MAGIC,
  prepareBenchmarkGate,
  pullBenchmarkOutputBlobs,
  resolveBenchmarkBaseUrl,
  resolveBenchmarkSlotMetadata,
  sealBenchmarkBaseTreeBundle,
  signBenchmarkVerdict,
  validateStoredBenchmarkProof,
  verifyBenchmarkSignature,
  type BenchmarkOutputArtifact,
} from '../src/benchmark-gate.js';
import { canonical, hash } from '../src/schema.js';
import type { ControllerResult } from '../src/errors.js';
import type { CredentialBinding, StepYield } from '../src/types.js';

const BENCH_SECRET = 'BENCH_RELAY_HMAC_CANARY_Aa11Bb22Cc33Dd44';
const BENCH_BEARER = 'BENCH_RELAY_AUTH_CANARY_Ee55Ff66Gg77Hh88';
const WRONG_SECRET = 'BENCH_WRONG_HMAC_CANARY_Zz99Yy88Xx77Ww66';
const WORKLOAD_DIGEST = { algorithm: 'sha256' as const, hex: '7'.repeat(64) };

function assertOk<T>(res: ControllerResult<T>, msg = ''): T {
  assert.equal(res.ok, true, `${msg}: ${res.ok ? '' : JSON.stringify(res.error)}`);
  if (!res.ok) throw new Error('expected ok');
  return res.value;
}

function assertStepYield(tick: StepTickResult): StepYield {
  assert.equal(tick.kind, 'step', `expected step yield, got ${JSON.stringify(tick).slice(0, 300)}`);
  if (tick.kind !== 'step') throw new Error('expected step yield');
  return tick;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function makeProvenance(overrides: Partial<HardwareProvenance> = {}): HardwareProvenance {
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
    topology: 'nvlink-single',
    workloadDigest: WORKLOAD_DIGEST,
    clockLockMode: 'locked',
    ...overrides,
  };
}

interface RelayRouteContext {
  readonly request: Record<string, unknown>;
  readonly pollAttempt: number;
  readonly stagedBlobs: ReadonlyMap<string, Buffer>;
}

interface RelayDirective {
  readonly status: 'pending' | 'approved' | 'denied' | 'expired';
  readonly reason?: string | null;
  readonly expiresAtMs?: string;
  readonly preemptionCount?: number;
  readonly retryablePreemption?: boolean;
  readonly detail?: string | null;
  readonly metrics?: Record<string, number | string | boolean>;
  readonly findings?: readonly Record<string, unknown>[];
  readonly hardwareProvenance?: HardwareProvenance | Record<string, unknown>;
  readonly outputArtifacts?: readonly BenchmarkOutputArtifact[];
  readonly signingKey?: string;
  readonly hang?: boolean;
  readonly delayMs?: number;
  readonly rawJsonOverride?: string;
}

interface MockRelayOptions {
  readonly secret?: string;
  readonly bearer?: string | null;
  readonly onPoll: (ctx: RelayRouteContext) => RelayDirective | Promise<RelayDirective>;
  readonly outputBlobs?: ReadonlyMap<
    string,
    {
      readonly bytes: Buffer;
      readonly chunkSizes?: readonly number[];
      readonly tamperHeaderSig?: boolean;
      readonly tamperHeaderLen?: string;
      readonly httpStatus?: number;
      readonly dropMidStream?: boolean;
      readonly delayMs?: number;
    }
  >;
  readonly putStatus?: number;
  readonly dropFirstPut?: boolean;
  readonly chunkPostResponse?: boolean;
}

async function startMockRelay(options: MockRelayOptions) {
  const secret = options.secret ?? BENCH_SECRET;
  const expectedBearer = options.bearer === undefined ? BENCH_BEARER : options.bearer;
  const stagedBlobs = new Map<string, Buffer>();
  const putRequests: { readonly operationId: string; readonly sha256: string; readonly byteLength: number }[] = [];
  const postRequests: Record<string, unknown>[] = [];
  const getRequests: { readonly operationId: string; readonly sha256: string }[] = [];
  let pollAttempt = 0;
  let droppedPutOnce = false;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (expectedBearer !== null && req.headers.authorization !== 'Bearer ' + expectedBearer) {
        res.writeHead(401).end('unauthorized');
        return;
      }

      const blobMatch = /^\/v1\/benchmark\/jobs\/([^/]+)\/blobs\/([0-9a-f]{64})$/.exec(url.pathname);
      if (req.method === 'PUT' && blobMatch) {
        const operationId = decodeURIComponent(blobMatch[1]!);
        const sha = blobMatch[2]!;
        const headerSha = req.headers['x-loopwright-blob-sha256'];
        const headerLen = req.headers['x-loopwright-blob-length'];
        const sig = req.headers['x-loopwright-signature'];
        if (
          typeof headerSha !== 'string'
          || headerSha !== sha
          || typeof headerLen !== 'string'
          || typeof sig !== 'string'
          || !verifySignedPayload(secret, `PUT\n${operationId}\n${sha}\n${headerLen}`, sig)
        ) {
          res.writeHead(403).end('bad put signature');
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        if (options.dropFirstPut && !droppedPutOnce) {
          droppedPutOnce = true;
          res.destroy();
          return;
        }
        const body = Buffer.concat(chunks);
        if (String(body.byteLength) !== headerLen || sha256Hex(body) !== sha) {
          res.writeHead(400).end('put hash mismatch');
          return;
        }
        stagedBlobs.set(sha, body);
        putRequests.push({ operationId, sha256: sha, byteLength: body.byteLength });
        res.writeHead(options.putStatus ?? 201).end();
        return;
      }

      if (req.method === 'GET' && blobMatch) {
        const operationId = decodeURIComponent(blobMatch[1]!);
        const sha = blobMatch[2]!;
        const sig = req.headers['x-loopwright-signature'];
        if (typeof sig !== 'string' || !verifySignedPayload(secret, `GET\n${operationId}\n${sha}`, sig)) {
          res.writeHead(403).end('bad get signature');
          return;
        }
        getRequests.push({ operationId, sha256: sha });
        const blobSpec = options.outputBlobs?.get(sha);
        if (!blobSpec) {
          res.writeHead(404).end('blob not found');
          return;
        }
        if (blobSpec.httpStatus && blobSpec.httpStatus !== 200) {
          res.writeHead(blobSpec.httpStatus).end('error');
          return;
        }
        const expectedLen = blobSpec.tamperHeaderLen ?? String(blobSpec.bytes.byteLength);
        const blobSig = signPayload(
           blobSpec.tamperHeaderSig ? WRONG_SECRET : secret,
          `BLOB\n${operationId}\n${sha}\n${String(blobSpec.bytes.byteLength)}`,
        );
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'x-loopwright-blob-sha256': sha,
          'x-loopwright-blob-length': expectedLen,
          'x-loopwright-signature': blobSig,
        });
        if (blobSpec.delayMs && blobSpec.delayMs > 0) {
          await new Promise<void>(r => setTimeout(r, blobSpec.delayMs));
        }
        if (blobSpec.dropMidStream) {
          const half = Math.max(1, Math.floor(blobSpec.bytes.byteLength / 2));
          res.write(blobSpec.bytes.subarray(0, half), () => {
            res.destroy();
          });
          return;
        }
        if (blobSpec.chunkSizes && blobSpec.chunkSizes.length > 0) {
          let offset = 0;
          for (const size of blobSpec.chunkSizes) {
            if (offset >= blobSpec.bytes.byteLength) break;
            const end = Math.min(blobSpec.bytes.byteLength, offset + size);
            await new Promise<void>(resolveWrite => {
              res.write(blobSpec.bytes.subarray(offset, end), () => resolveWrite());
            });
            offset = end;
          }
          if (offset < blobSpec.bytes.byteLength) {
            res.write(blobSpec.bytes.subarray(offset));
          }
          res.end();
        } else {
          res.end(blobSpec.bytes);
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/benchmark/jobs') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks);
        const sig = req.headers['x-loopwright-signature'];
        if (typeof sig !== 'string' || !verifySignedPayload(secret, body, sig)) {
          res.writeHead(403).end('bad post signature');
          return;
        }
        const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
        postRequests.push(parsed);
        pollAttempt++;
        const directive = await options.onPoll({ request: parsed, pollAttempt, stagedBlobs });
        if (directive.delayMs && directive.delayMs > 0) {
          await new Promise<void>(r => setTimeout(r, directive.delayMs));
        }
        if (directive.hang) {
          res.destroy();
          return;
        }
        if (directive.rawJsonOverride !== undefined) {
          const rawBytes = Buffer.from(directive.rawJsonOverride, 'utf8');
          res.writeHead(200, {
            'content-type': 'application/json',
            connection: 'close',
            'x-loopwright-signature': signPayload(directive.signingKey ?? secret, rawBytes),
          });
          res.end(rawBytes);
          return;
        }
        const verdict: Record<string, unknown> = {
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
          status: directive.status,
          reason:
            directive.reason !== undefined
              ? directive.reason
              : directive.status === 'pending' || directive.status === 'approved'
                ? null
                : 'benchmark_denied',
          expiresAtMs: directive.expiresAtMs ?? String(Date.now() + 600_000),
          preemptionCount: directive.preemptionCount ?? 0,
          ...(directive.retryablePreemption !== undefined ? { retryablePreemption: directive.retryablePreemption } : {}),
          ...(directive.detail !== undefined ? { detail: directive.detail } : {}),
          ...(directive.metrics !== undefined ? { metrics: directive.metrics } : {}),
          ...(directive.findings !== undefined ? { findings: directive.findings } : {}),
          ...(directive.hardwareProvenance !== undefined
            ? { hardwareProvenance: directive.hardwareProvenance }
            : directive.status === 'approved'
              ? { hardwareProvenance: makeProvenance() }
              : {}),
          ...(directive.outputArtifacts !== undefined ? { outputArtifacts: directive.outputArtifacts } : {}),
        };
        const respBytes = Buffer.from(JSON.stringify(verdict), 'utf8');
        res.writeHead(200, {
          'content-type': 'application/json',
          connection: 'close',
          'x-loopwright-signature': signPayload(directive.signingKey ?? secret, respBytes),
        });
        if (options.chunkPostResponse && respBytes.byteLength > 16) {
          res.write(respBytes.subarray(0, 16), () => {
            res.end(respBytes.subarray(16));
          });
        } else {
          res.end(respBytes);
        }
        return;
      }

      res.writeHead(404).end('not found');
    })().catch(() => {
      try {
        res.writeHead(500).end();
      } catch {
        // Ignore socket already closed.
      }
    });
  });

  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', () => resolveListen()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/v1/benchmark/jobs`,
    stagedBlobs,
    putRequests,
    postRequests,
    getRequests,
    close: () =>
      new Promise<void>((done, fail) => {
        server.closeAllConnections();
        server.close(err => (err ? fail(err) : done()));
      }),
  };
}

async function initGitRepo(directory: string, files: Readonly<Record<string, string | Buffer>>): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const git = (args: string[]) =>
    execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: directory,
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        HOME: '/nonexistent',
        GIT_TERMINAL_PROMPT: '0',
      },
      timeout: 10_000,
      encoding: 'utf8',
    });
  git(['init', '-q']);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(directory, rel);
    await mkdir(join(abs, '..'), { recursive: true, mode: 0o700 });
    await writeFile(abs, content, { mode: 0o600 });
  }
  git(['add', '.']);
  git(['-c', 'user.name=Benchmark Fixture', '-c', 'user.email=bench@localhost.invalid', 'commit', '-qm', 'initial']);
  return git(['rev-parse', 'HEAD']).trim();
}

interface BenchmarkFixtureOptions {
  readonly relayUrl: string;
  readonly bearer?: boolean;
  readonly delegated?: boolean;
  readonly maxPreemptions?: number;
  readonly maxPollMs?: number;
  readonly timeoutMs?: number;
  readonly allowSyntheticHardwareProbe?: boolean;
  readonly metricThresholds?: readonly MetricThresholdRule[];
  readonly maxImplementationRepairs?: number;
  readonly maxAttempts?: number;
  readonly checkOnRework?: { readonly rejectTo: string; readonly maxReworks: number };
  readonly overlay?: { readonly maxFiles: number; readonly maxBytes: number };
  readonly repoFiles?: Readonly<Record<string, string | Buffer>>;
  readonly publicationUrl?: string;
  readonly publisherSecret?: string;
}

async function createBenchmarkFixture(opts: BenchmarkFixtureOptions) {
  const f = await configurationFixture();
  const installed = await installedHandlerDigests();
  const useBearer = opts.bearer !== false;
  f.environment.BENCH_SECRET = BENCH_SECRET;
  if (useBearer) f.environment.BENCH_BEARER = BENCH_BEARER;
  if (opts.publicationUrl) {
    f.environment.PUB_SECRET = opts.publisherSecret ?? 'PUB_SIGNING_SECRET_Ii99Jj00Kk11';
  }

  const credBindings: CredentialBinding[] = [
    ...f.registry.spec.credentialBindings,
    { id: 'bench-signer', consumer: 'gate', destinationRef: 'bench-relay', environmentNames: ['BENCH_SECRET'], template: '${BENCH_SECRET}' },
  ];
  const envBindings: Record<string, unknown>[] = [
    { name: 'PROVIDER_TOKEN', classification: 'credential', paths: [] },
  ];
  const configCreds: Record<string, unknown>[] = [];

  const addCred = (ref: string, envName: string) => {
    const idx = configCreds.length;
    configCreds.push({ ref, template: `\${${envName}}` });
    envBindings.push({ name: envName, classification: 'credential', paths: [`/spec/credentials/${idx}/template`] });
  };
  addCred('bench-signer', 'BENCH_SECRET');
  if (useBearer) {
    credBindings.push({ id: 'bench-auth', consumer: 'gate', destinationRef: 'bench-relay', environmentNames: ['BENCH_BEARER'], template: '${BENCH_BEARER}' });
    addCred('bench-auth', 'BENCH_BEARER');
  }
  if (opts.publicationUrl) {
    credBindings.push({ id: 'pub-signer', consumer: 'publisher', destinationRef: 'pub-svc', environmentNames: ['PUB_SECRET'], template: '${PUB_SECRET}' });
    addCred('pub-signer', 'PUB_SECRET');
    setFixture(f.registry, ['spec', 'publicationEndpoints'], [
      { id: 'pr-pub', url: opts.publicationUrl, signingCredentialRef: 'pub-signer', authCredentialRef: null, timeoutMs: 1500 },
    ]);
    setFixture(f.config, ['spec', 'publication'], {
      mode: 'pull_request',
      endpointRef: 'pr-pub',
      targetBranch: 'main',
      headBranchPrefix: 'loopwright/',
      titleTemplate: 'Hardware benchmark PR',
    });
  }

  setFixture(f.registry, ['spec', 'credentialBindings'], credBindings);
  setFixture(f.registry, ['spec', 'environmentBindings'], envBindings);
  setFixture(f.config, ['spec', 'credentials'], configCreds);
  setFixture(f.registry, ['spec', 'gateEndpoints'], [
    {
      id: 'gpu-relay',
      url: opts.relayUrl,
      signingCredentialRef: 'bench-signer',
      authCredentialRef: useBearer ? 'bench-auth' : null,
      timeoutMs: opts.timeoutMs ?? 2000,
      maxPollMs: opts.maxPollMs ?? 8000,
      pollInitialMs: 100,
      pollMaxMs: 200,
      jitter: 0,
    },
  ]);

  const benchParams: Record<string, unknown> = {
    checkId: 'kernel-bench',
    endpointRef: 'gpu-relay',
    gateId: 'sm90-gemm-gate',
    heldOutWorkloadId: 'gemm-fp16-4096',
    ...(opts.maxPreemptions !== undefined ? { maxPreemptions: opts.maxPreemptions } : {}),
  };
  setFixture(f.registry, ['spec', 'handlers'], [
    f.registry.spec.handlers[0]!,
    {
      id: 'kernel-bench',
      kind: 'check',
      implementation: 'benchmark-gate.v1',
      version: 1,
      digest: installed['benchmark-gate.v1'],
      parameters: benchParams,
      capabilities: ['hardware_execution', 'read_only'],
    },
    f.registry.spec.handlers[2]!,
    f.registry.spec.handlers[3]!,
  ]);

  if (opts.delegated) {
    setFixture(f.registry, ['spec', 'roleProfiles'], [
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
    setFixture(f.config, ['spec', 'task', 'spec', 'roles'], [
      {
        id: 'builder',
        adapter: 'delegated',
        provider: 'antigravity',
        model: 'gemini-4-argon',
        thinking: 'high',
        tools: ['read', 'write', 'edit', 'delete'],
      },
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'build', kind: 'agent', uses: 'package.patch', roleId: 'builder', dependsOn: [] },
      {
        id: 'bench-step',
        kind: 'check',
        uses: 'kernel-bench',
        roleId: null,
        dependsOn: ['build'],
        ...(opts.checkOnRework ? { onRework: opts.checkOnRework } : {}),
      },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'build', handlerRef: 'package.patch' },
      { stepId: 'bench-step', handlerRef: 'kernel-bench' },
    ]);
  } else {
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'bench-step', kind: 'check', uses: 'kernel-bench', roleId: null, dependsOn: [] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [{ stepId: 'bench-step', handlerRef: 'kernel-bench' }]);
  }

  setFixture(f.config, ['spec', 'controls', 'maxAttempts'], opts.maxAttempts ?? 4);
  setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxImplementationRepairs'], opts.maxImplementationRepairs ?? 0);
  if (opts.overlay) {
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'overlay'], opts.overlay);
  }
  setFixture(f.config, ['spec', 'task', 'spec', 'scope', 'writable'], ['packages/**']);
  setFixture(f.config, ['spec', 'task', 'spec', 'target', 'matrix'], [
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
  ]);
  setFixture(f.config, ['spec', 'task', 'spec', 'acceptance'], {
    required: ['kernel-bench'],
    checks: [
      {
        id: 'kernel-bench',
        allowedEvidenceLevels: ['hardware_execution'],
        targetCellId: 'cuda-sm90',
        ...(opts.allowSyntheticHardwareProbe !== undefined ? { allowSyntheticHardwareProbe: opts.allowSyntheticHardwareProbe } : {}),
        ...(opts.metricThresholds !== undefined ? { metricThresholds: opts.metricThresholds } : {}),
      },
    ],
  });

  const repository = join(f.root, 'repository');
  const runRoot = join(f.root, 'runs');
  const revision = await initGitRepo(
    repository,
    opts.repoFiles ?? { 'packages/kernel.cu': '__global__ void gemm() {}\n', 'packages/obsolete.cu': '// remove me\n' },
  );
  setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], revision);
  setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], revision);
  await f.save();
  const loaded = assertOk(await f.load(), 'load benchmark fixture');
  return { ...f, repository, runRoot, loaded };
}

test('benchmark-gate.v1 registry validation, D=256/257 checkpoint bounds, store lease scaling, verdict schema, and refusal-record subject', async () => {
  const digests = await installedHandlerDigests();
  assert.equal(digests['benchmark-gate.v1'].algorithm, 'sha256');
  assert.match(digests['benchmark-gate.v1'].hex, /^[0-9a-f]{64}$/);
  assert.notEqual(digests['benchmark-gate.v1'].hex, digests['gate.v1'].hex);

  const validHandler = {
    id: 'bench',
    version: 1,
    digest: digests['benchmark-gate.v1'],
    kind: 'check',
    implementation: 'benchmark-gate.v1',
    parameters: { checkId: 'bench', endpointRef: 'relay', gateId: 'gpu-gate', heldOutWorkloadId: 'workload-1' },
    capabilities: ['hardware_execution', 'read_only'],
  };
  assert.equal(validateHandler(validHandler, '/h').implementation, 'benchmark-gate.v1');
  assert.equal(
    validateHandler({ ...validHandler, parameters: { ...validHandler.parameters, maxPreemptions: 0 } }, '/h').implementation,
    'benchmark-gate.v1',
  );
  assert.equal(
    validateHandler({ ...validHandler, parameters: { ...validHandler.parameters, maxPreemptions: 16 } }, '/h').implementation,
    'benchmark-gate.v1',
  );

  // Reject -0, out-of-range maxPreemptions, unknown keys, empty gateId, and wrong capabilities
  for (const bad of [
    { ...validHandler, capabilities: ['external_service', 'read_only'] },
    { ...validHandler, parameters: { ...validHandler.parameters, maxPreemptions: -0 } },
    { ...validHandler, parameters: { ...validHandler.parameters, maxPreemptions: -1 } },
    { ...validHandler, parameters: { ...validHandler.parameters, maxPreemptions: 17 } },
    { ...validHandler, parameters: { ...validHandler.parameters, extra: 1 } },
    { ...validHandler, parameters: { ...validHandler.parameters, gateId: '' } },
    { ...validHandler, parameters: { ...validHandler.parameters, gateId: 'bad \ud800' } },
    { ...validHandler, parameters: { ...validHandler.parameters, gateId: 'GPU-測試' } },
    { ...validHandler, parameters: { ...validHandler.parameters, gateId: ' bench ' } },
    { ...validHandler, parameters: { ...validHandler.parameters, gateId: 'bench\tgate' } },
  ]) {
    assert.throws(() => validateHandler(bad, '/h'));
  }

  // D = 256 succeeds, D = 257 refuses CONFIG_LIMIT; resolveStoreLeaseMs includes benchmark-gate.v1 maxPollMs
  assert.equal(checkpointCapacity(46, 16, 2, 3, false).D, 256);
  assert.throws(() => checkpointCapacity(47, 16, 2, 3, false));
  const f = await createBenchmarkFixture({ relayUrl: 'https://relay.example.com/v1/benchmark/jobs', maxPollMs: 180_000, timeoutMs: 10_000 });
  try {
    const plan = assertOk(await compilePlan(f.loaded), 'compile benchmark lease plan');
    assert.equal(resolveStoreLeaseMs(f.loaded, plan), 210_000);

    // checkedRefusalSubject allows valid hardware_execution targetMatrixDigest and rejects tampered digest
    const lockRes = admitTask(plan.task, { admissionId: 'adm-hw-refusal', runId: 'run-hw-refusal' });
    assert.equal(lockRes.ok, true);
    if (lockRes.ok) {
      const probeBound = bindSubject(lockRes.value, {
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'ArtifactManifest',
        metadata: { id: 'probe' },
        spec: { entries: [] },
      });
      assert.equal(probeBound.ok, true);
      if (probeBound.ok) {
        const checkedSub = checkedRefusalSubject(probeBound.value, lockRes.value);
        assert.deepEqual(checkedSub.targetMatrixDigest, probeBound.value.targetMatrixDigest);
        assert.throws(
          () =>
            checkedRefusalSubject(
              { ...probeBound.value, targetMatrixDigest: { algorithm: 'sha256', hex: '0'.repeat(64) } },
              lockRes.value,
            ),
          /RECOVERY_REQUIRED/,
        );
      }
    }
  } finally {
    await f.cleanup();
  }

  // checkedBenchmarkVerdict, HMAC helpers, and evaluateBenchmarkThresholds edge cases
  const expectedBinding = {
    storeId: 'store.1',
    runId: 'run-1',
    lockHash: { algorithm: 'sha256', hex: 'a'.repeat(64) },
    operationId: 'verify.1',
    dispatchId: 'dispatch-1',
    dispatchGeneration: 1,
    gateId: 'sm90-gemm-gate',
    checkId: 'kernel-bench',
    candidateDigest: 'b'.repeat(64),
  };
  const baseApproved: Record<string, unknown> = {
    version: 1,
    kind: 'benchmark_verdict',
    ...expectedBinding,
    status: 'approved',
    reason: null,
    expiresAtMs: '1900000000000',
    preemptionCount: 2,
    hardwareProvenance: makeProvenance(),
    metrics: { latency_us: 48.5, baseline_us: 100, delta: -0 },
    outputArtifacts: [{ name: 'build/gemm.cubin', digest: { algorithm: 'sha256', hex: 'c'.repeat(64) }, byteLength: 4096 }],
  };
  const sig = signBenchmarkVerdict(BENCH_SECRET, baseApproved);
  assert.equal(verifyBenchmarkSignature(BENCH_SECRET, baseApproved, sig), true);
  assert.equal(verifyBenchmarkSignature(WRONG_SECRET, baseApproved, sig), false);
  const parsedApproved = checkedBenchmarkVerdict(baseApproved, expectedBinding);
  assert.equal(parsedApproved.preemptionCount, 2);
  assert.equal(Object.is(parsedApproved.metrics?.delta, 0), true);

  for (const invalidVerdict of [
    { ...baseApproved, signature: sig },
    { ...baseApproved, unknownKey: true },
    { ...baseApproved, preemptionCount: -0 },
    { ...baseApproved, status: 'approved', hardwareProvenance: undefined },
    { ...baseApproved, status: 'approved', retryablePreemption: true },
    { ...baseApproved, status: 'pending', reason: 'not-null' },
    { ...baseApproved, status: 'pending', retryablePreemption: false },
    { ...baseApproved, outputArtifacts: [{ name: '.loopwright-verifier/check.kernel-bench/a.cubin', digest: { algorithm: 'sha256', hex: 'c'.repeat(64) }, byteLength: 16 }] },
    { ...baseApproved, outputArtifacts: [
      { name: 'build/Gemm.cubin', digest: { algorithm: 'sha256', hex: 'c'.repeat(64) }, byteLength: 16 },
      { name: 'build/gemm.cubin', digest: { algorithm: 'sha256', hex: 'd'.repeat(64) }, byteLength: 16 },
    ] },
    { ...baseApproved, outputArtifacts: [{ name: 'build/empty.cubin', digest: { algorithm: 'sha256', hex: 'c'.repeat(64) }, byteLength: 0 }] },
  ]) {
    assert.throws(() => checkedBenchmarkVerdict(invalidVerdict, expectedBinding), /ARTIFACT_INVALID/);
  }

  assert.equal(
    evaluateBenchmarkThresholds(
      [
        { kind: 'bounds', metric: 'latency_us', min: 10, max: 50 },
        { kind: 'comparative', metric: 'latency_us', baselineMetric: 'baseline_us', operator: 'max_ratio', threshold: 0.5 },
        { kind: 'comparative', metric: 'baseline_us', baselineMetric: 'latency_us', operator: 'min_ratio', threshold: 2.0 },
        { kind: 'comparative', metric: 'latency_us', baselineMetric: 'baseline_us', operator: 'max_delta', threshold: -50 },
      ],
      { latency_us: 48.5, baseline_us: 100 },
    ),
    true,
  );
  assert.equal(
    evaluateBenchmarkThresholds(
      [{ kind: 'comparative', metric: 'latency_us', baselineMetric: 'zero_base', operator: 'min_ratio', threshold: 1 }],
      { latency_us: 10, zero_base: 0 },
    ),
    false,
  );
});

test('stages candidate overlay blobs > 1 MiB + deletions via signed PUT and ingests uneven > 1 MiB Stage A binary CAS outputs under separate verifier budget', async () => {
  // 2.4 MiB non-UTF8 binary .cubin (> 2 MiB candidate overlay.maxBytes!) + 0-byte .sass
  const cubinBytes = Buffer.alloc(2_516_582);
  for (let i = 0; i < cubinBytes.length; i++) cubinBytes[i] = (i * 131 + 0x80) & 0xff;
  cubinBytes.set([0x7f, 0x45, 0x4c, 0x46, 0x00, 0xff, 0xfe, 0xc3], 0);
  const cubinSha = sha256Hex(cubinBytes);
  const emptySha = sha256Hex(Buffer.alloc(0));

  const outputBlobs = new Map([
    [cubinSha, { bytes: cubinBytes, chunkSizes: [7, 1_350_000, 511, 1_166_064] }],
    [emptySha, { bytes: Buffer.alloc(0) }],
  ]);

  const relay = await startMockRelay({
    outputBlobs,
    onPoll: ({ request, pollAttempt }) => {
      if (pollAttempt === 1) return { status: 'pending', preemptionCount: 0 };
      return {
        status: 'approved',
        preemptionCount: 0,
        detail: 'SM90a FP16 GEMM passed blind verification (1.92x speedup)',
        metrics: { latency_us: 52.0, baseline_us: 100.0, speedup: 1.92 },
        outputArtifacts: [
          { name: 'stage-a/gemm_sm90.cubin', digest: { algorithm: 'sha256', hex: cubinSha }, byteLength: cubinBytes.byteLength, mediaType: 'application/octet-stream' },
          { name: 'stage-a/empty.sass', digest: { algorithm: 'sha256', hex: emptySha }, byteLength: 0, mediaType: 'text/plain' },
        ],
        ...(request.targetCellId ? {} : {}),
      };
    },
  });

  const f = await createBenchmarkFixture({
    relayUrl: relay.url,
    delegated: true,
    overlay: { maxFiles: 129, maxBytes: 2_097_152 }, // v2 baseTree overlay with 2 MiB candidate cap while .cubin is 2.4 MiB!
    metricThresholds: [
      { kind: 'bounds', metric: 'latency_us', max: 60 },
      { kind: 'comparative', metric: 'speedup', baselineMetric: 'latency_us', operator: 'min_ratio', threshold: 0.03 },
    ],
  });

  try {
    const runId = 'run-bench-cas-e2e';
    const step1 = assertStepYield(
      assertOk(
        await stepNext({
          configuration: f.loaded,
          repository: f.repository,
          runRoot: f.runRoot,
          runId,
          environment: name => f.environment[name],
        }),
        'stepNext',
      ),
    );

    // Candidate writes a 0-byte file, a 1.3 MiB source table (> 1 MiB streaming PUT!), updates kernel.cu, and deletes obsolete.cu
    const lutBytes = Buffer.alloc(1_363_148, 0x41);
    const kernelBytes = Buffer.from('__global__ void gemm_sm90_fast() {}\n', 'utf8');
    await writeFile(join(step1.candidateDir, 'packages', 'empty-new.cu'), Buffer.alloc(0), { mode: 0o600 });
    await writeFile(join(step1.candidateDir, 'packages', 'lut.bin'), lutBytes, { mode: 0o600 });
    await writeFile(join(step1.candidateDir, 'packages', 'kernel.cu'), kernelBytes, { mode: 0o600 });
    await rm(join(step1.candidateDir, 'packages', 'obsolete.cu'));

    const settled = assertOk(
      await stepSubmit({
        runRoot: f.runRoot,
        runId,
        leaseToken: step1.leaseToken,
        status: 'completed',
        environment: name => f.environment[name],
      }),
      'stepSubmit',
    );
    assert.equal(settled.kind, 'result');
    if (settled.kind !== 'result') return;
    assert.equal(settled.result.spec.status, 'completed');

    // Verify Relay received exact candidate overlay blobs (empty-new.cu + lut.bin + kernel.cu) and skipped deleted obsolete.cu
    assert.equal(relay.putRequests.length, 3);
    assert.equal(relay.stagedBlobs.get(emptySha)?.byteLength, 0);
    assert.equal(relay.stagedBlobs.get(sha256Hex(lutBytes))?.equals(lutBytes), true);
    assert.equal(relay.stagedBlobs.get(sha256Hex(kernelBytes))?.equals(kernelBytes), true);
    assert.equal(relay.postRequests.length, 2);
    const reqPayload = relay.postRequests[0]!;
    assert.equal(reqPayload.kind, 'benchmark_request');
    assert.equal(reqPayload.targetCellId, 'cuda-sm90');
    assert.equal(reqPayload.heldOutWorkloadId, 'gemm-fp16-4096');
    assert.equal(reqPayload.maxPreemptions, 3);
    const candArts = reqPayload.candidateArtifacts as { entries: { name: string }[]; deleted: string[]; baseTree?: unknown };
    assert.deepEqual(candArts.entries.map(e => e.name), ['packages/empty-new.cu', 'packages/kernel.cu', 'packages/lut.bin']);
    assert.deepEqual(candArts.deleted, ['packages/obsolete.cu']);
    assert.ok(candArts.baseTree !== undefined);

    // Verify Stage A .cubin was sealed at 0o400 with nlink === 1 and exact unmodified binary bytes
    const cubinCasPath = join(f.runRoot, runId, 'artifacts', 'blobs', 'sha256', cubinSha);
    const st = await lstat(cubinCasPath);
    assert.equal(st.isFile(), true);
    assert.equal(st.nlink, 1);
    assert.equal(st.mode & 0o777, 0o400);
    assert.equal((await readFile(cubinCasPath)).equals(cubinBytes), true);

    const row = settled.result.spec.verification.spec.required.find(r => r.checkId === 'kernel-bench')!;
    assert.equal(row.status, 'passed');
    assert.deepEqual({ ...row.metrics }, { baseline_us: 100, latency_us: 52, speedup: 1.92 });
  } finally {
    await f.cleanup();
    await relay.close();
  }
});

test('cross-chunk SecretScrubber and HMAC/hash checks reject poisoned or tampered Stage A blobs without mutating bytes or committing CAS files', async () => {
  // 1. Cross-chunk vault secret straddling the 1 MiB boundary inside binary .cubin
  const crossVaultBytes = Buffer.alloc(1_200_000, 0x90);
  const splitOffset = 1_048_576 - 6;
  crossVaultBytes.write(BENCH_SECRET, splitOffset, 'latin1');
  const originalSnapshot = Buffer.from(crossVaultBytes);
  const crossVaultSha = sha256Hex(crossVaultBytes);

  // 2. Cross-chunk @loopwright/core SecretScrubber generic token straddling uneven HTTP chunks
  const crossScrubberBytes = Buffer.alloc(65_536, 0xfe);
  crossScrubberBytes.write('OPENAI_API_KEY', 1000, 'latin1');
  const crossScrubberSha = sha256Hex(crossScrubberBytes);

  // 3. Tampered BLOB header signature
  const cleanBytes = Buffer.from('clean-cubin-bytes');
  const cleanSha = sha256Hex(cleanBytes);

  for (const [label, sha, spec] of [
    ['cross-chunk-vault-secret', crossVaultSha, { bytes: crossVaultBytes, chunkSizes: [1_048_576, 151_424] }],
    ['cross-chunk-core-scrubber', crossScrubberSha, { bytes: crossScrubberBytes, chunkSizes: [1006, 64_530] }],
    ['tampered-blob-sig', cleanSha, { bytes: cleanBytes, tamperHeaderSig: true }],
    ['tampered-blob-len', cleanSha, { bytes: cleanBytes, tamperHeaderLen: '999999' }],
  ] as const) {
    const relay = await startMockRelay({
      outputBlobs: new Map([[sha, spec]]),
      onPoll: () => ({
        status: 'approved',
        outputArtifacts: [{ name: 'out/kernel.cubin', digest: { algorithm: 'sha256', hex: sha }, byteLength: spec.bytes.byteLength }],
      }),
    });
    const f = await createBenchmarkFixture({ relayUrl: relay.url });
    try {
      const runId = 'run-poison-' + label;
      const res = assertOk(await runCycleWithPorts({ configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId }), label);
      assert.equal(res.kind, 'result', label);
      if (res.kind === 'result') {
        assert.equal(res.result.spec.status, 'blocked', label);
        const row = res.result.spec.verification.spec.required[0]!;
        assert.equal(row.status, 'blocked', label);
        assert.equal(row.detail, 'ARTIFACT_INVALID', label);
      }
      // Source bytes were never mutated and poisoned blob was never linked into blobs/sha256
      assert.equal(crossVaultBytes.equals(originalSnapshot), true, label);
      const shaDir = join(f.runRoot, runId, 'artifacts', 'blobs', 'sha256');
      const entries = await readdir(shaDir).catch(() => [] as string[]);
      assert.equal(entries.includes(sha), false, `${label}: poisoned CAS file must not be committed`);
      assert.equal(entries.some(e => e.startsWith('.tmp-')), false, `${label}: temp files must be unlinked`);
    } finally {
      await f.cleanup();
      await relay.close();
    }
  }
});

test('preemption handling: 3 requeues succeed on 4th worker; exhausted maxPreemptions=3/0 or preempted timeout settles blocked BENCHMARK_PREEMPTED with zero repair/rework', async () => {
  // Case A: maxPreemptions = 3, 3 worker preemptions requeued at Relay, 4th succeeds -> completed
  const requeueRelay = await startMockRelay({
    onPoll: ({ pollAttempt }) => {
      if (pollAttempt <= 4) {
        return { status: 'pending', preemptionCount: pollAttempt - 1 };
      }
      return { status: 'approved', preemptionCount: 3, metrics: { latency_us: 40 } };
    },
  });
  const fOk = await createBenchmarkFixture({ relayUrl: requeueRelay.url, maxPreemptions: 3 });
  try {
    const res = assertOk(
      await runCycleWithPorts({ configuration: fOk.loaded, repository: fOk.repository, runRoot: fOk.runRoot, runId: 'run-preempt-3-ok' }),
      '3 preemptions succeed',
    );
    assert.equal(res.kind, 'result');
    if (res.kind === 'result') {
      assert.equal(res.result.spec.status, 'completed');
    }
    assert.equal(requeueRelay.postRequests.length, 5);
  } finally {
    await fOk.cleanup();
    await requeueRelay.close();
  }

  // Case B: 4th eviction under maxPreemptions = 3, 1st eviction under maxPreemptions = 0, and poll timeout after preemptionCount > 0
  // All settle blocked BENCHMARK_PREEMPTED with ZERO implementationRepair and ZERO onRework!
  for (const [label, maxPreemptions, maxPollMs, onPoll] of [
    [
      'exhausted-3',
      3,
      8000,
      ({ pollAttempt }: RelayRouteContext): RelayDirective =>
        pollAttempt < 4
          ? { status: 'pending', preemptionCount: pollAttempt }
          : { status: 'expired', reason: 'BENCHMARK_PREEMPTED', preemptionCount: 3, retryablePreemption: true },
    ],
    [
      'exhausted-0',
      0,
      8000,
      (): RelayDirective => ({ status: 'expired', reason: 'BENCHMARK_PREEMPTED', preemptionCount: 0, retryablePreemption: true }),
    ],
    [
      'timeout-after-preemption',
      3,
      1000,
      (): RelayDirective => ({ status: 'pending', preemptionCount: 1 }),
    ],
  ] as const) {
    const relay = await startMockRelay({ onPoll });
    const f = await createBenchmarkFixture({
      relayUrl: relay.url,
      delegated: true,
      maxPreemptions,
      maxPollMs,
      maxImplementationRepairs: 2,
      maxAttempts: 6,
      checkOnRework: { rejectTo: 'build', maxReworks: 2 },
    });
    try {
      const runId = 'run-' + label;
      const step1 = assertStepYield(
        assertOk(
          await stepNext({
            configuration: f.loaded,
            repository: f.repository,
            runRoot: f.runRoot,
            runId,
            environment: name => f.environment[name],
          }),
          label,
        ),
      );
      await writeFile(join(step1.candidateDir, 'packages', 'kernel.cu'), '__global__ void gemm_v2() {}\n', { mode: 0o600 });
      const tick2 = assertOk(
        await stepSubmit({
          runRoot: f.runRoot,
          runId,
          leaseToken: step1.leaseToken,
          status: 'completed',
          environment: name => f.environment[name],
        }),
        label,
      );
      // Must NOT yield repair or rework step; must finish immediately as blocked BENCHMARK_PREEMPTED!
      assert.equal(tick2.kind, 'result', `${label}: expected terminal result, not repair/rework yield`);
      if (tick2.kind === 'result') {
        assert.equal(tick2.result.spec.status, 'blocked', label);
        const row = tick2.result.spec.verification.spec.required[0]!;
        assert.equal(row.status, 'blocked', label);
        assert.equal(row.detail, 'BENCHMARK_PREEMPTED', label);
        assert.equal(tick2.stepVerdicts ?? undefined, undefined, `${label}: zero check rework verdicts`);
      }
    } finally {
      await f.cleanup();
      await relay.close();
    }
  }
});

test('genuine measured benchmark denial settles failed and triggers implementationRepair and check-step onRework with verdict detail', async () => {
  // 1. implementationRepair path on genuine threshold miss
  let candidatePass = 0;
  const repairRelay = await startMockRelay({
    onPoll: () => {
      candidatePass++;
      if (candidatePass === 1) {
        return {
          status: 'denied',
          reason: 'METRIC_THRESHOLD_FAILED',
          detail: 'Measured latency_us=142.8 exceeds max bound 80.0 on sm_90a',
          preemptionCount: 0,
          retryablePreemption: false,
          metrics: { latency_us: 142.8 },
          hardwareProvenance: makeProvenance(),
        };
      }
      return { status: 'approved', preemptionCount: 0, metrics: { latency_us: 61.2 } };
    },
  });
  const fRepair = await createBenchmarkFixture({
    relayUrl: repairRelay.url,
    delegated: true,
    maxImplementationRepairs: 1,
    maxAttempts: 4,
    metricThresholds: [{ kind: 'bounds', metric: 'latency_us', max: 80 }],
  });
  try {
    const runId = 'run-bench-impl-repair';
    const step1 = assertStepYield(
      assertOk(
        await stepNext({
          configuration: fRepair.loaded,
          repository: fRepair.repository,
          runRoot: fRepair.runRoot,
          runId,
          environment: name => fRepair.environment[name],
        }),
      ),
    );
    await writeFile(join(step1.candidateDir, 'packages', 'kernel.cu'), '// slow v1\n', { mode: 0o600 });
    const repairStep = assertStepYield(
      assertOk(
        await stepSubmit({
          runRoot: fRepair.runRoot,
          runId,
          leaseToken: step1.leaseToken,
          status: 'completed',
          environment: name => fRepair.environment[name],
        }),
      ),
    );
    assert.equal(repairStep.repair, 'implementation');
    assert.match(repairStep.prompt, /latency_us=142\.8 exceeds max bound 80\.0/);

    await writeFile(join(repairStep.candidateDir, 'packages', 'kernel.cu'), '// tiled fast v2\n', { mode: 0o600 });
    const finalTick = assertOk(
      await stepSubmit({
        runRoot: fRepair.runRoot,
        runId,
        leaseToken: repairStep.leaseToken,
        status: 'completed',
        environment: name => fRepair.environment[name],
      }),
    );
    assert.equal(finalTick.kind, 'result');
    if (finalTick.kind === 'result') assert.equal(finalTick.result.spec.status, 'completed');
  } finally {
    await fRepair.cleanup();
    await repairRelay.close();
  }

  // 2. check-step onRework path on genuine denial
  let reworkPass = 0;
  const reworkRelay = await startMockRelay({
    onPoll: () => {
      reworkPass++;
      if (reworkPass === 1) {
        return {
          status: 'denied',
          reason: 'correctness_mismatch',
          detail: 'Max abs error 3.2e-2 > 1e-3 on held-out shape 4096x4096',
          preemptionCount: 0,
        };
      }
      return { status: 'approved', preemptionCount: 0, metrics: { latency_us: 55.0 } };
    },
  });
  const fRework = await createBenchmarkFixture({
    relayUrl: reworkRelay.url,
    delegated: true,
    maxImplementationRepairs: 0,
    maxAttempts: 4,
    checkOnRework: { rejectTo: 'build', maxReworks: 1 },
  });
  try {
    const runId = 'run-bench-rework';
    const step1 = assertStepYield(
      assertOk(
        await stepNext({
          configuration: fRework.loaded,
          repository: fRework.repository,
          runRoot: fRework.runRoot,
          runId,
          environment: name => fRework.environment[name],
        }),
      ),
    );
    await writeFile(join(step1.candidateDir, 'packages', 'kernel.cu'), '// buggy accum\n', { mode: 0o600 });
    const reworkStep = assertStepYield(
      assertOk(
        await stepSubmit({
          runRoot: fRework.runRoot,
          runId,
          leaseToken: step1.leaseToken,
          status: 'completed',
          environment: name => fRework.environment[name],
        }),
      ),
    );
    assert.equal(reworkStep.reworkEpoch, 1);
    assert.match(reworkStep.rework?.summary ?? '', /Max abs error 3\.2e-2/);

    await writeFile(join(reworkStep.candidateDir, 'packages', 'kernel.cu'), '// fp32 accum fixed\n', { mode: 0o600 });
    const finalTick = assertOk(
      await stepSubmit({
        runRoot: fRework.runRoot,
        runId,
        leaseToken: reworkStep.leaseToken,
        status: 'completed',
        environment: name => fRework.environment[name],
      }),
    );
    assert.equal(finalTick.kind, 'result');
    if (finalTick.kind === 'result') assert.equal(finalTick.result.spec.status, 'completed');
  } finally {
    await fRework.cleanup();
    await reworkRelay.close();
  }
});

test('forged provenance, synthetic_fixture without opt-in, and contradictory approved threshold violations settle blocked while uncertain external_write stays reconcile_required', async () => {
  const blockedCases = new Map<string, { readonly directive: RelayDirective; readonly expectedDetail: string }>([
    ['run-synthetic-without-opt-in', { directive: { status: 'approved', hardwareProvenance: makeProvenance({ probeKind: 'synthetic_fixture' }), metrics: { latency_us: 40 } }, expectedDetail: 'HARDWARE_PROVENANCE_MISMATCH' }],
    ['run-wrong-accelerator', { directive: { status: 'approved', hardwareProvenance: makeProvenance({ accelerator: 'sm_89' }), metrics: { latency_us: 40 } }, expectedDetail: 'HARDWARE_PROVENANCE_MISMATCH' }],
    ['run-wrong-driver', { directive: { status: 'approved', hardwareProvenance: makeProvenance({ driverVersion: '535.104.05' }), metrics: { latency_us: 40 } }, expectedDetail: 'HARDWARE_PROVENANCE_MISMATCH' }],
    ['run-contradictory-approved-threshold', { directive: { status: 'approved', metrics: { latency_us: 250 } }, expectedDetail: 'METRIC_THRESHOLD_FAILED' }],
  ]);
  const sharedBlockedRelay = await startMockRelay({
    onPoll: ({ request }) => blockedCases.get(String(request.runId))!.directive,
  });
  const sharedBlockedFixture = await createBenchmarkFixture({
    relayUrl: sharedBlockedRelay.url,
    allowSyntheticHardwareProbe: false,
    metricThresholds: [{ kind: 'bounds', metric: 'latency_us', max: 100 }],
  });
  try {
    for (const [runId, { expectedDetail }] of blockedCases) {
      const res = assertOk(
        await runCycleWithPorts({
          configuration: sharedBlockedFixture.loaded,
          repository: sharedBlockedFixture.repository,
          runRoot: sharedBlockedFixture.runRoot,
          runId,
        }),
        runId,
      );
      assert.equal(res.kind, 'result', runId);
      if (res.kind === 'result') {
        assert.equal(res.result.spec.status, 'blocked', runId);
        assert.equal(res.result.spec.verification.spec.required[0]!.detail, expectedDetail, runId);
      }
    }
  } finally {
    await sharedBlockedFixture.cleanup();
    await sharedBlockedRelay.close();
  }

  // With allowSyntheticHardwareProbe: true, synthetic_fixture passes benchmark-gate.v1;
  // when paired with an interrupted external_write publication, RunResult stays reconcile_required!
  const hangingPub = createServer((_req, res) => {
    res.destroy();
  });
  await new Promise<void>(r => hangingPub.listen(0, '127.0.0.1', () => r()));
  let okRelay: Awaited<ReturnType<typeof startMockRelay>> | null = null;
  let fPub: Awaited<ReturnType<typeof createBenchmarkFixture>> | null = null;
  try {
    const pubPort = (hangingPub.address() as { port: number }).port;
    okRelay = await startMockRelay({
      onPoll: () => ({
        status: 'approved',
        hardwareProvenance: makeProvenance({ probeKind: 'synthetic_fixture' }),
        metrics: { latency_us: 45 },
      }),
    });
    fPub = await createBenchmarkFixture({
      relayUrl: okRelay.url,
      allowSyntheticHardwareProbe: true,
      metricThresholds: [{ kind: 'bounds', metric: 'latency_us', max: 100 }],
      publicationUrl: `http://127.0.0.1:${pubPort}/publish`,
    });
    const res = assertOk(
      await runCycleWithPorts({ configuration: fPub.loaded, repository: fPub.repository, runRoot: fPub.runRoot, runId: 'run-synth-pub-uncertain' }),
      'synthetic opt-in + uncertain publication',
    );
    assert.equal(res.kind, 'result');
    if (res.kind === 'result') {
      assert.equal(res.result.spec.verification.spec.required[0]!.status, 'passed');
      assert.equal(res.result.spec.status, 'reconcile_required');
      assert.equal(res.result.spec.externalEffects, 'unknown');
    }
    void canonical;
    void hash;
  } finally {
    if (fPub) await fPub.cleanup();
    if (okRelay) await okRelay.close();
    await new Promise<void>(r => {
      hangingPub.closeAllConnections();
      hangingPub.close(() => r());
    });
  }
});

test('classic v1 in-memory staging, 0-byte overlay staging, PUT retry, >64 KiB POST cap, GET 404/mid-stream drops, duplicate CAS dedup, and disposition matrix', async () => {
  // 1. Unit checks for checkedVerifierArtifactRef, checkedHardwareProvenance, resolveBenchmarkBaseUrl, and computeBenchmarkDisposition
  const sampleSha = sha256Hex(Buffer.from('sample'));
  const validVerRef = checkedVerifierArtifactRef({
    name: '.loopwright-verifier/check.kernel-bench/out/trace.json',
    digest: { algorithm: 'sha256', hex: sampleSha },
    byteLength: 6,
    uri: 'cas://sha256/' + sampleSha,
    mediaType: null,
  });
  assert.equal(validVerRef.name, '.loopwright-verifier/check.kernel-bench/out/trace.json');
  for (const badRef of [
    null,
    { name: 'packages/kernel.cu', digest: { algorithm: 'sha256', hex: sampleSha }, byteLength: 6 },
    { name: '.loopwright-verifier/check.kernel-bench/out/trace.json', digest: { algorithm: 'sha256', hex: sampleSha }, byteLength: 6, extra: 1 },
  ]) {
    assert.throws(() => checkedVerifierArtifactRef(badRef), /ARTIFACT_INVALID/);
  }
  for (const badProv of [
    null,
    { ...makeProvenance(), probeKind: 'emulated' },
    { ...makeProvenance(), isolationMode: 'shared' },
    { ...makeProvenance(), clockLockMode: 'boost' },
    { ...makeProvenance(), vendor: 'bad\nvendor' },
    { ...makeProvenance(), accelerator: 'non-ascii-µ' },
  ]) {
    assert.throws(() => checkedHardwareProvenance(badProv), /ARTIFACT_INVALID/);
  }

  const endpointSample = {
    id: 'gpu-relay',
    url: 'http://127.0.0.1:9000/v1/benchmark/jobs///',
    signingCredentialRef: 'bench-signer',
    authCredentialRef: null,
    timeoutMs: 1000,
    maxPollMs: 5000,
    pollInitialMs: 100,
    pollMaxMs: 200,
    jitter: 10,
  };
  assert.equal(
    resolveBenchmarkBaseUrl(endpointSample, { 'gpu-relay': 'http://127.0.0.1:9111/v1/benchmark/jobs/' }),
    'http://127.0.0.1:9111/v1/benchmark/jobs',
  );

  const dispBase = {
    timedOut: false,
    sawPreemption: false,
    wallClockValid: true,
    targetHardware: { accelerator: 'sm_90a', isolationMode: 'whole_device' as const },
    targetCellId: 'cuda-sm90',
    allowSyntheticHardwareProbe: false,
    metricThresholds: [] as readonly MetricThresholdRule[],
    casOutcome: 'ok' as const,
  };
  assert.equal(computeBenchmarkDisposition({ ...dispBase, verdict: null }).reason, 'EVIDENCE_UNAVAILABLE');
  assert.equal(computeBenchmarkDisposition({ ...dispBase, verdict: null, timedOut: true }).reason, 'GATE_TIMEOUT');
  assert.equal(
    computeBenchmarkDisposition({
      ...dispBase,
      verdict: { status: 'expired', reason: 'BENCHMARK_PREEMPTED', expiresAtMs: '100', preemptionCount: 2 },
    }).reason,
    'BENCHMARK_PREEMPTED',
  );
  assert.equal(
    computeBenchmarkDisposition({
      ...dispBase,
      verdict: { status: 'expired', reason: null, expiresAtMs: '100', preemptionCount: 0 },
    }).reason,
    'EVIDENCE_UNAVAILABLE',
  );
  for (const [casOutcome, expectedReason] of [
    ['artifact_invalid', 'ARTIFACT_INVALID'],
    ['gate_timeout', 'GATE_TIMEOUT'],
    ['evidence_unavailable', 'EVIDENCE_UNAVAILABLE'],
  ] as const) {
    assert.equal(
      computeBenchmarkDisposition({
        ...dispBase,
        casOutcome,
        verdict: { status: 'denied', reason: 'miss', expiresAtMs: '100', preemptionCount: 0 },
      }).reason,
      expectedReason,
    );
    assert.equal(
      computeBenchmarkDisposition({
        ...dispBase,
        casOutcome,
        verdict: { status: 'approved', reason: null, expiresAtMs: '100', preemptionCount: 0, hardwareProvenance: makeProvenance() },
      }).reason,
      expectedReason,
    );
  }
  assert.equal(
    computeBenchmarkDisposition({
      ...dispBase,
      wallClockValid: false,
      verdict: { status: 'approved', reason: null, expiresAtMs: '100', preemptionCount: 0, hardwareProvenance: makeProvenance() },
    }).reason,
    'EVIDENCE_UNAVAILABLE',
  );

  // 2. Classic v1 manifest ({ name, bytes } in-memory staging including 0-byte + >1 MiB), transient PUT retry, chunked POST,
  // gateUrlOverrides loopback override, bearer=false, findings + mediaType: null, and duplicate Stage A CAS digest dedup!
  const dupBlobBytes = Buffer.from('shared-stage-a-sass-text');
  const dupSha = sha256Hex(dupBlobBytes);
  const classicRelay = await startMockRelay({
    bearer: null,
    dropFirstPut: true,
    chunkPostResponse: true,
    outputBlobs: new Map([[dupSha, { bytes: dupBlobBytes }]]),
    onPoll: () => ({
      status: 'approved',
      preemptionCount: 0,
      findings: [{ severity: 'low', title: 'occupancy 94%', evidence: 'sm90 active warps 60/64' }],
      outputArtifacts: [
        { name: 'out/a.sass', digest: { algorithm: 'sha256', hex: dupSha }, byteLength: dupBlobBytes.byteLength, mediaType: null },
        { name: 'out/b.sass', digest: { algorithm: 'sha256', hex: dupSha }, byteLength: dupBlobBytes.byteLength },
      ],
    }),
  });
  // Pre-seed a CAS blob in a second v2 0-byte overlay run and use gateUrlOverrides on classicRelay
  const fClassic = await createBenchmarkFixture({
    relayUrl: 'http://127.0.0.1:9/v1/benchmark/jobs',
    bearer: false,
    repoFiles: {
      'packages/empty.cu': '',
      'packages/table.bin': Buffer.alloc(1_100_000, 0x5a),
    },
  });
  setFixture(fClassic.registry, ['spec', 'gateEndpoints', 0, 'jitter'], 15);
  await fClassic.save();
  const loadedClassic = assertOk(await fClassic.load(), 'reload classic with jitter');
  const waitEvents: unknown[] = [];
  try {
    const res = assertOk(
      await runCycleWithPorts(
        {
          configuration: loadedClassic,
          repository: fClassic.repository,
          runRoot: fClassic.runRoot,
          runId: 'run-classic-bytes-staging',
          onEvent: async ev => {
            if (ev.stage === 'gate_waiting') waitEvents.push(ev);
          },
        },
        { gateUrlOverrides: { 'gpu-relay': classicRelay.url } },
      ),
      'classic v1 staging + PUT retry',
    );
    assert.equal(res.kind, 'result');
    if (res.kind === 'result') {
      assert.equal(res.result.spec.status, 'completed');
      assert.equal(res.result.spec.verification.spec.required[0]!.findings?.[0]?.title, 'occupancy 94%');
    }
    assert.equal(classicRelay.putRequests.length, 2);
    assert.ok(waitEvents.length >= 1, 'PUT retry emitted gate_waiting event');
    assert.equal(classicRelay.getRequests.length, 2);
  } finally {
    await fClassic.cleanup();
    await classicRelay.close();
  }

  // Direct pullBenchmarkOutputBlobs timeout, unreachable network, and abort branches + prepareBenchmarkGate negative guards
  const pullTimeout = await pullBenchmarkOutputBlobs({
    baseUrl: 'http://127.0.0.1:1/v1/benchmark/jobs',
    operationId: 'verify.timeout',
    slotId: 'check.kernel-bench',
    secret: BENCH_SECRET,
    bearerToken: BENCH_BEARER,
    outputArtifacts: [{ name: 'out/a.cubin', digest: { algorithm: 'sha256', hex: sampleSha }, byteLength: 6 }],
    artifacts: {} as never,
    signal: new AbortController().signal,
    resolveTimeoutMs: () => null,
  });
  assert.deepEqual(pullTimeout, { ok: false, casOutcome: 'gate_timeout' });

  const pullUnreachable = await pullBenchmarkOutputBlobs({
    baseUrl: 'http://127.0.0.1:1/v1/benchmark/jobs',
    operationId: 'verify.net',
    slotId: 'check.kernel-bench',
    secret: BENCH_SECRET,
    bearerToken: BENCH_BEARER,
    outputArtifacts: [{ name: 'out/a.cubin', digest: { algorithm: 'sha256', hex: sampleSha }, byteLength: 6 }],
    artifacts: {} as never,
    signal: new AbortController().signal,
    resolveTimeoutMs: () => 500,
  });
  assert.deepEqual(pullUnreachable, { ok: false, casOutcome: 'evidence_unavailable' });

  const abortedCtrl = new AbortController();
  abortedCtrl.abort();
  await assert.rejects(
    () =>
      pullBenchmarkOutputBlobs({
        baseUrl: 'http://127.0.0.1:1/v1/benchmark/jobs',
        operationId: 'verify.abort',
        slotId: 'check.kernel-bench',
        secret: BENCH_SECRET,
        bearerToken: null,
        outputArtifacts: [{ name: 'out/a.cubin', digest: { algorithm: 'sha256', hex: sampleSha }, byteLength: 6 }],
        artifacts: {} as never,
        signal: abortedCtrl.signal,
        resolveTimeoutMs: () => 500,
      }),
    /CANCELLED/,
  );

  // 3. >64 KiB POST body rejection + wall-clock expired approved + GET 404 + GET mid-stream drop + PUT 500 invalid
  const midStreamBytes = Buffer.alloc(32_768, 0x33);
  const midStreamSha = sha256Hex(midStreamBytes);
  const missingSha = 'e'.repeat(64);
  for (const [label, relayOpts, expectedDetail] of [
    [
      'oversize-post-response',
      {
        onPoll: (): RelayDirective => ({
          status: 'approved',
          rawJsonOverride: '{"pad":"' + 'x'.repeat(BENCHMARK_RESPONSE_BYTES + 1024) + '"}',
        }),
      },
      'EVIDENCE_UNAVAILABLE',
    ],
    [
      'expired-wall-clock',
      {
        onPoll: (): RelayDirective => ({
          status: 'approved',
          expiresAtMs: '1000',
        }),
      },
      'EVIDENCE_UNAVAILABLE',
    ],
    [
      'get-404-missing-blob',
      {
        onPoll: (): RelayDirective => ({
          status: 'approved',
          outputArtifacts: [{ name: 'out/missing.cubin', digest: { algorithm: 'sha256', hex: missingSha }, byteLength: 64 }],
        }),
      },
      'EVIDENCE_UNAVAILABLE',
    ],
    [
      'get-mid-stream-drop',
      {
        outputBlobs: new Map([[midStreamSha, { bytes: midStreamBytes, dropMidStream: true }]]),
        onPoll: (): RelayDirective => ({
          status: 'approved',
          outputArtifacts: [{ name: 'out/drop.cubin', digest: { algorithm: 'sha256', hex: midStreamSha }, byteLength: midStreamBytes.byteLength }],
        }),
      },
      'EVIDENCE_UNAVAILABLE',
    ],
    [
      'put-500-invalid',
      {
        putStatus: 500,
        onPoll: (): RelayDirective => ({ status: 'approved' }),
      },
      'EVIDENCE_UNAVAILABLE',
    ],
  ] as const) {
    const relay = await startMockRelay(relayOpts);
    const f = await createBenchmarkFixture({
      relayUrl: relay.url,
      repoFiles: { 'packages/zero.cu': '' },
    });
    try {
      if (label === 'put-500-invalid') {
        const plan = assertOk(await compilePlan(f.loaded));
        const lockRes = admitTask(plan.task, { admissionId: 'adm-neg', runId: 'run-neg' });
        assert.equal(lockRes.ok, true);
        if (lockRes.ok) {
          const emptyManifest = {
            apiVersion: 'loopwright.dev/v1alpha1' as const,
            kind: 'ArtifactManifest' as const,
            metadata: { id: 'm1' },
            spec: { entries: [] },
          };
          const dummyInv = { manifest: emptyManifest, ref: { name: 'm', digest: WORKLOAD_DIGEST, byteLength: 2 }, files: [] };
          assert.throws(() => prepareBenchmarkGate(plan, lockRes.value, 'check.kernel-bench', dummyInv, 0, 'bad-nonce', f.loaded.registry.spec.gateEndpoints));
          assert.throws(() => prepareBenchmarkGate(plan, lockRes.value, 'implicit.scope', dummyInv, 0, 'a'.repeat(32), f.loaded.registry.spec.gateEndpoints));
          assert.throws(() => prepareBenchmarkGate(plan, lockRes.value, 'check.kernel-bench', dummyInv, 0, 'a'.repeat(32), []));
          assert.throws(() =>
            prepareBenchmarkGate(
              plan,
              lockRes.value,
              'check.kernel-bench',
              { ...dummyInv, files: [{ name: 'packages/extra.cu', bytes: new Uint8Array(1) }] },
              0,
              'a'.repeat(32),
              f.loaded.registry.spec.gateEndpoints,
            ),
          );
        }
      }
      const res = assertOk(
        await runCycleWithPorts({ configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId: 'run-' + label }),
        label,
      );
      assert.equal(res.kind, 'result', label);
      if (res.kind === 'result') {
        assert.equal(res.result.spec.status, 'blocked', label);
        assert.equal(res.result.spec.verification.spec.required[0]!.detail, expectedDetail, label);
      }
    } finally {
      await f.cleanup();
      await relay.close();
    }
  }
});

test('S1: preflight > 64 KiB outbound benchmark_request refuses OUTPUT_LIMIT before putIntent/dispatch with zero uncertain operations and identical resume', async () => {
  const relay = await startMockRelay({ onPoll: () => ({ status: 'approved' }) });
  const f = await createBenchmarkFixture({
    relayUrl: relay.url,
    delegated: true,
    overlay: { maxFiles: 600, maxBytes: 1_048_576 },
  });
  try {
    const runId = 'run-s1-outbound-request-limit';
    const step1 = assertStepYield(
      assertOk(
        await stepNext({
          configuration: f.loaded,
          repository: f.repository,
          runRoot: f.runRoot,
          runId,
          environment: name => f.environment[name],
        }),
      ),
    );
    // Write 420 1-byte files (~185 JSON bytes/descriptor => > 77 KiB > 65,536-byte BENCHMARK_REQUEST_BYTES)
    const longSubdir = join(step1.candidateDir, 'packages', 'deep_module_' + 'a'.repeat(36));
    await mkdir(longSubdir, { recursive: true, mode: 0o700 });
    for (let i = 0; i < 420; i++) {
      const fileName = `kernel_tile_variant_${String(i).padStart(4, '0')}_${'x'.repeat(24)}.cu`;
      await writeFile(join(longSubdir, fileName), Buffer.from([i & 0xff]), { mode: 0o600 });
    }

    const settled = assertOk(
      await stepSubmit({
        runRoot: f.runRoot,
        runId,
        leaseToken: step1.leaseToken,
        status: 'completed',
        environment: name => f.environment[name],
      }),
    );
    assert.equal(settled.kind, 'incident');
    if (settled.kind === 'incident') {
      assert.equal(settled.incident.code, 'OUTPUT_LIMIT');
    }
    assert.equal(relay.putRequests.length, 0, 'zero PUTs sent on preflight size refusal');
    assert.equal(relay.postRequests.length, 0, 'zero POSTs sent on preflight size refusal');

    const retained = await readRetained({ runRoot: f.runRoot, runId });
    const store = stateValue(reopenLocalRun(retained.descriptor.identity));
    try {
      const view = stateValue(store.inspect());
      assert.equal(view.counts.operations, 0, 'zero operations written to LocalRunStore');
      assert.equal(view.counts.unresolvedOperations, 0, 'zero uncertain operations in LocalRunStore');
    } finally {
      stateValue(store.close());
    }

    const resumed = assertOk(
      await resumeCycleWithPorts({
        configuration: f.loaded,
        repository: f.repository,
        runRoot: f.runRoot,
        runId,
      }),
    );
    assert.equal(resumed.kind, 'incident');
    if (resumed.kind === 'incident') {
      assert.equal(resumed.incident.code, 'OUTPUT_LIMIT');
    }
    assert.equal(relay.postRequests.length, 0);
  } finally {
    await f.cleanup();
    await relay.close();
  }
});

test('S2 & S5: exact 0o400 CAS mode enforced across reuse/dedup/acceptance (rejecting 0o444) and async streaming verifier CAS hash pass cancels cleanly', async () => {
  const cubinBytes = Buffer.alloc(2_300_000, 0x7a);
  const cubinSha = sha256Hex(cubinBytes);
  const relay = await startMockRelay({
    outputBlobs: new Map([[cubinSha, { bytes: cubinBytes }]]),
    onPoll: () => ({
      status: 'approved',
      outputArtifacts: [{ name: 'out/kernel.cubin', digest: { algorithm: 'sha256', hex: cubinSha }, byteLength: cubinBytes.byteLength }],
    }),
  });
  const f = await createBenchmarkFixture({ relayUrl: relay.url });
  try {
    const runId = 'run-s2-s5-cas-mode-async';
    const ctx = await createCycle({ configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId }, {});
    try {
      const cycle = new Cycle(ctx);
      await cycle.bootstrap();
      const slot = ctx.plan.verifierSlots.find(s => s.handler.implementation === 'benchmark-gate.v1')!;
      const checked = await cycle.runVerifier(slot.id);
      assert.equal(checked.status, 'passed');

      for (const s of ctx.plan.verifierSlots) {
        if (s.id !== slot.id) await cycle.runVerifier(s.id);
      }
      await cycle.ensureSubmissionForAcceptance();

      // S5: async streaming verifyControllerVerifierCasDescriptors invokes checkAuthority across 1 MiB chunks and cancels cleanly
      let authorityChecks = 0;
      const preverified = await verifyControllerVerifierCasDescriptors(ctx.plan, cycle.currentChecks(), {
        checkAuthority: () => {
          authorityChecks++;
        },
      });
      assert.ok(authorityChecks >= 3, `expected >= 3 chunk authority checks for 2.3 MiB blob, got ${authorityChecks}`);

      const abortMidStream = new AbortController();
      let seenChunks = 0;
      await assert.rejects(
        () =>
          verifyControllerVerifierCasDescriptors(ctx.plan, cycle.currentChecks(), {
            signal: abortMidStream.signal,
            checkAuthority: () => {
              seenChunks++;
              if (seenChunks === 2) abortMidStream.abort();
            },
          }),
        /CANCELLED/,
      );

      // S2: chmod 0o444 on the committed CAS blob is rejected by reuse, dedup, async pre-verifier, AND sync acceptance!
      const blobPath = join(ctx.artifacts.directory, 'blobs', 'sha256', cubinSha);
      await chmod(blobPath, 0o444);
      try {
        await assert.rejects(
          () =>
            ctx.artifacts.verifyOrReuseVerifierCasBlob({
              logicalName: `.loopwright-verifier/${slot.id}/out/kernel.cubin`,
              expectedSha256: cubinSha,
              expectedByteLength: cubinBytes.byteLength,
            }),
          /ARTIFACT_INVALID/,
        );
        await assert.rejects(
          () =>
            ctx.artifacts.ingestVerifiedCasBlobStream(
              {
                logicalName: `.loopwright-verifier/${slot.id}/out/kernel.cubin`,
                expectedSha256: cubinSha,
                expectedByteLength: cubinBytes.byteLength,
              },
              async consume => {
                await consume(cubinBytes);
              },
            ),
          /ARTIFACT_INVALID/,
        );
        await assert.rejects(
          () => verifyControllerVerifierCasDescriptors(ctx.plan, cycle.currentChecks()),
          /ARTIFACT_INVALID/,
        );
        assert.throws(
          () =>
            evaluateControllerAcceptance(
              ctx.plan,
              ctx.lock,
              cycle.candidate.manifest,
              cycle.candidate.files,
              cycle.generation,
              cycle.currentChecks(),
              cycle.submission!.value,
              ctx.store,
              null,
              true,
              [],
              null,
              preverified,
            ),
          /ARTIFACT_INVALID/,
        );
      } finally {
        await chmod(blobPath, 0o400);
      }
      await cycle.deadline.dispose();
      await cycle.events.close();
    } finally {
      stateValue(ctx.store.release(ctx.authority));
      stateValue(ctx.store.close());
      await ctx.owner.release();
    }
  } finally {
    await f.cleanup();
    await relay.close();
  }
});

test('S6, S7, S8: dynamic secret overlap (>16 KiB encoded + UTF-8 Unicode split), abort during onWait without listener leak, and separate stage vs poll backoff counters', async () => {
  // S7: dynamic overlap catches > 16 KiB URL-encoded 4096-char secret & UTF-8 Unicode secret split mid-codepoint; > 4096 refuses admission
  const f = await createBenchmarkFixture({ relayUrl: 'http://127.0.0.1:9/v1/benchmark/jobs' });
  try {
    const vault = approvedState(f.loaded).vault;
    assert.throws(
      () => createBinarySecretStreamScanner(vault, '.loopwright-verifier/check.kernel-bench/a.bin', 'verification', ['S'.repeat(MAX_EXTRA_SECRET_LENGTH + 1)]),
      /CONFIG_CREDENTIAL_INVALID/,
    );

    const maxLenSecret = ('SECRET_CANARY_' + '語'.repeat(2500)).slice(0, MAX_EXTRA_SECRET_LENGTH);
    const urlEncodedForm = Buffer.from(encodeURIComponent(maxLenSecret), 'utf8');
    assert.ok(urlEncodedForm.byteLength > 16_384, `expected encoded form > 16 KiB, got ${urlEncodedForm.byteLength}`);
    const scannerLong = createBinarySecretStreamScanner(vault, '.loopwright-verifier/check.kernel-bench/a.bin', 'verification', [maxLenSecret]);
    assert.ok(scannerLong.overlapBytes >= urlEncodedForm.byteLength);
    // Split so the first half is > 16,384 bytes before the boundary — old 16 KiB fixed carry would have truncated the prefix!
    const splitAt = urlEncodedForm.byteLength - 500;
    const chunkA = Buffer.concat([Buffer.alloc(4096, 0xaa), urlEncodedForm.subarray(0, splitAt)]);
    const chunkB = Buffer.concat([urlEncodedForm.subarray(splitAt), Buffer.alloc(4096, 0xbb)]);
    scannerLong.push(chunkA);
    assert.throws(() => scannerLong.push(chunkB), /ARTIFACT_INVALID/);

    // Registered UTF-8 Unicode secret split right inside a 4-byte emoji inside non-UTF8 0xff binary framing
    const unicodeSecret = '機密トークン_🔑_BENCH_CANARY';
    const unicodeBytes = Buffer.from(unicodeSecret, 'utf8');
    const emojiIdx = unicodeBytes.indexOf(Buffer.from('🔑', 'utf8'));
    const binaryPrefix = Buffer.alloc(2048, 0xff);
    const binarySuffix = Buffer.alloc(2048, 0xfe);
    const fullUnicodePayload = Buffer.concat([binaryPrefix, unicodeBytes, binarySuffix]);
    const snapshotUnicode = Buffer.from(fullUnicodePayload);
    const cutPoint = binaryPrefix.byteLength + emojiIdx + 2; // middle of 4-byte UTF-8 sequence!
    const scannerUtf8 = createBinarySecretStreamScanner(vault, '.loopwright-verifier/check.kernel-bench/u.bin', 'verification', [unicodeSecret]);
    scannerUtf8.push(fullUnicodePayload.subarray(0, cutPoint));
    assert.throws(() => scannerUtf8.push(fullUnicodePayload.subarray(cutPoint)), /ARTIFACT_INVALID/);
    assert.equal(fullUnicodePayload.equals(snapshotUnicode), true, 'scanner must never mutate input buffer bytes');
  } finally {
    await f.cleanup();
  }

  // S8 + S6: 10 candidate files staged via PUT do NOT push the first pending POST wait to pollMaxMs (2000ms);
  // and aborting inside onWait rejects immediately without waiting 2000ms!
  const manyRepoFiles: Record<string, string> = {};
  for (let i = 0; i < 10; i++) {
    manyRepoFiles[`packages/part-${i}.cu`] = `// content ${i}\n`;
  }
  const relay = await startMockRelay({
    onPoll: ({ request, pollAttempt }) =>
      request.runId === 'run-s6-abort-during-onwait' || pollAttempt === 1 ? { status: 'pending' } : { status: 'approved' },
  });
  const fBackoff = await createBenchmarkFixture({ relayUrl: relay.url, repoFiles: manyRepoFiles });
  setFixture(fBackoff.registry, ['spec', 'gateEndpoints', 0, 'pollInitialMs'], 100);
  setFixture(fBackoff.registry, ['spec', 'gateEndpoints', 0, 'pollMaxMs'], 2000);
  setFixture(fBackoff.registry, ['spec', 'gateEndpoints', 0, 'jitter'], 0);
  await fBackoff.save();
  const loadedBackoff = assertOk(await fBackoff.load());
  try {
    const observedDelays: number[] = [];
    const res = assertOk(
      await runCycleWithPorts({
        configuration: loadedBackoff,
        repository: fBackoff.repository,
        runRoot: fBackoff.runRoot,
        runId: 'run-s8-separate-counters',
        onEvent: async ev => {
          if (ev.stage === 'gate_waiting' && ev.gate) {
            observedDelays.push(ev.gate.nextPollMs);
          }
        },
      }),
    );
    assert.equal(res.kind, 'result');
    assert.equal(relay.putRequests.length, 10);
    assert.deepEqual(observedDelays, [100], 'first pending poll after 10 PUTs must use pollInitialMs=100, not pollMaxMs=2000');

    // S6: aborting during onWait cancels immediately before sleep starts (measuring from abort inside gate_waiting, with pollInitialMs=5000)
    setFixture(fBackoff.registry, ['spec', 'gateEndpoints', 0, 'pollInitialMs'], 5000);
    setFixture(fBackoff.registry, ['spec', 'gateEndpoints', 0, 'pollMaxMs'], 5000);
    await fBackoff.save();
    const loadedSlowPoll = assertOk(await fBackoff.load());
    const abortCtrl = new AbortController();
    let abortedAt = 0;
    const cancelRes = assertOk(
      await runCycleWithPorts({
        configuration: loadedSlowPoll,
        repository: fBackoff.repository,
        runRoot: fBackoff.runRoot,
        runId: 'run-s6-abort-during-onwait',
        signal: abortCtrl.signal,
        onEvent: async ev => {
          if (ev.stage === 'gate_waiting') {
            abortedAt = Date.now();
            abortCtrl.abort();
          }
        },
      }),
    );
    const postAbortMs = Date.now() - abortedAt;
    assert.ok(abortedAt > 0, 'gate_waiting callback must have fired');
    assert.equal(cancelRes.kind, 'result');
    if (cancelRes.kind === 'result') assert.equal(cancelRes.result.spec.status, 'reconcile_required');
    assert.ok(postAbortMs < 2500, `expected immediate cancellation without sleeping 5000ms, post-abort took ${postAbortMs}ms`);
  } finally {
    await fBackoff.cleanup();
    await relay.close();
  }
});

test('P1 & P2: denied with reason BENCHMARK_PREEMPTED (omitted flag) and denied with mismatched/synthetic hardwareProvenance settle blocked with zero repair/rework, while gate.v1 keeps repair', async () => {
  const dispBase = {
    timedOut: false,
    sawPreemption: false,
    wallClockValid: true,
    targetHardware: { accelerator: 'sm_90a', isolationMode: 'whole_device' as const },
    targetCellId: 'cuda-sm90',
    allowSyntheticHardwareProbe: false,
    metricThresholds: [] as readonly MetricThresholdRule[],
    casOutcome: 'ok' as const,
  };
  // P1 pure check: denied + reason: 'BENCHMARK_PREEMPTED' + omitted retryablePreemption => blocked + retryablePreemption: true
  const p1Disp = computeBenchmarkDisposition({
    ...dispBase,
    verdict: { status: 'denied', reason: 'BENCHMARK_PREEMPTED', expiresAtMs: '1000', preemptionCount: 2 },
  });
  assert.deepEqual(p1Disp, {
    status: 'blocked',
    reason: 'BENCHMARK_PREEMPTED',
    method: 'benchmark-gate.v1',
    retryablePreemption: true,
  });

  // P2 pure check: denied + disallowed synthetic or wrong cell => blocked HARDWARE_PROVENANCE_MISMATCH
  const p2SynthDisp = computeBenchmarkDisposition({
    ...dispBase,
    verdict: {
      status: 'denied',
      reason: 'threshold_miss',
      expiresAtMs: '1000',
      preemptionCount: 0,
      hardwareProvenance: makeProvenance({ probeKind: 'synthetic_fixture' }),
    },
  });
  assert.equal(p2SynthDisp.status, 'blocked');
  assert.equal(p2SynthDisp.reason, 'HARDWARE_PROVENANCE_MISMATCH');

  const dummySha = sha256Hex(Buffer.from('unpulled'));
  const p1p2Cases = new Map<string, { readonly directive: RelayDirective; readonly expectedReason: string }>([
    [
      'run-denied-preempted-no-flag',
      {
        directive: { status: 'denied', reason: 'BENCHMARK_PREEMPTED', preemptionCount: 1 },
        expectedReason: 'BENCHMARK_PREEMPTED',
      },
    ],
    [
      'run-denied-wrong-cell',
      {
        directive: {
          status: 'denied',
          reason: 'threshold_miss',
          hardwareProvenance: makeProvenance({ targetCellId: 'rocm-gfx942' }),
          outputArtifacts: [{ name: 'out/skip.cubin', digest: { algorithm: 'sha256', hex: dummySha }, byteLength: 8 }],
        },
        expectedReason: 'HARDWARE_PROVENANCE_MISMATCH',
      },
    ],
    [
      'run-denied-disallowed-synthetic',
      {
        directive: {
          status: 'denied',
          reason: 'threshold_miss',
          hardwareProvenance: makeProvenance({ probeKind: 'synthetic_fixture' }),
          outputArtifacts: [{ name: 'out/skip.cubin', digest: { algorithm: 'sha256', hex: dummySha }, byteLength: 8 }],
        },
        expectedReason: 'HARDWARE_PROVENANCE_MISMATCH',
      },
    ],
  ]);
  const sharedP1P2Relay = await startMockRelay({
    outputBlobs: new Map([[dummySha, { bytes: Buffer.from('unpulled') }]]),
    onPoll: ({ request }) => p1p2Cases.get(String(request.runId))!.directive,
  });
  const sharedP1P2Fixture = await createBenchmarkFixture({
    relayUrl: sharedP1P2Relay.url,
    delegated: true,
    allowSyntheticHardwareProbe: false,
    maxImplementationRepairs: 2,
    maxAttempts: 6,
    checkOnRework: { rejectTo: 'build', maxReworks: 2 },
  });
  try {
    for (const [runId, { expectedReason }] of p1p2Cases) {
      const step1 = assertStepYield(
        assertOk(
          await stepNext({
            configuration: sharedP1P2Fixture.loaded,
            repository: sharedP1P2Fixture.repository,
            runRoot: sharedP1P2Fixture.runRoot,
            runId,
            environment: name => sharedP1P2Fixture.environment[name],
          }),
          runId,
        ),
      );
      await writeFile(join(step1.candidateDir, 'packages', 'kernel.cu'), '// candidate edit\n', { mode: 0o600 });
      const settled = assertOk(
        await stepSubmit({
          runRoot: sharedP1P2Fixture.runRoot,
          runId,
          leaseToken: step1.leaseToken,
          status: 'completed',
          environment: name => sharedP1P2Fixture.environment[name],
        }),
        runId,
      );
      assert.equal(settled.kind, 'result', `${runId}: must not trigger implementationRepair or onRework`);
      if (settled.kind === 'result') {
        assert.equal(settled.result.spec.status, 'blocked', runId);
        assert.equal(settled.result.spec.verification.spec.required[0]!.detail, expectedReason, runId);
      }
      assert.equal(sharedP1P2Relay.getRequests.length, 0, `${runId}: must not pull outputs on preempted or mismatched-provenance denial`);

      // Delegated resume eligibility must also see blocked and return retained result, never CAPABILITY_UNSUPPORTED!
      const resumed = assertOk(
        await resumeCycleWithPorts({
          configuration: sharedP1P2Fixture.loaded,
          repository: sharedP1P2Fixture.repository,
          runRoot: sharedP1P2Fixture.runRoot,
          runId,
        }),
        runId + '-resume',
      );
      assert.equal(resumed.kind, 'result');
      if (resumed.kind === 'result') {
        assert.equal(resumed.result.spec.status, 'blocked');
      }
    }
  } finally {
    await sharedP1P2Fixture.cleanup();
    await sharedP1P2Relay.close();
  }

  // P1 scoping check: an ordinary gate.v1 denial with reason 'BENCHMARK_PREEMPTED' (and omitted flag) retains implementationRepair!
  const ordinaryGateServer = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      const v: Record<string, unknown> = {
        version: 1,
        kind: 'gate_verdict',
        storeId: parsed.storeId,
        runId: parsed.runId,
        lockHash: parsed.lockHash,
        operationId: parsed.operationId,
        dispatchId: parsed.dispatchId,
        dispatchGeneration: parsed.dispatchGeneration,
        gateId: parsed.gateId,
        checkId: parsed.checkId,
        candidateDigest: parsed.candidateDigest,
        status: 'denied',
        reason: 'BENCHMARK_PREEMPTED',
        expiresAtMs: String(Date.now() + 600_000),
      };
      const b = Buffer.from(JSON.stringify(v), 'utf8');
      res.writeHead(200, { 'content-type': 'application/json', 'x-loopwright-signature': signPayload(BENCH_SECRET, b) });
      res.end(b);
    })();
  });
  await new Promise<void>(r => ordinaryGateServer.listen(0, '127.0.0.1', () => r()));
  let fOrd: Awaited<ReturnType<typeof createBenchmarkFixture>> | null = null;
  try {
    const ordPort = (ordinaryGateServer.address() as { port: number }).port;
    fOrd = await createBenchmarkFixture({
      relayUrl: `http://127.0.0.1:${ordPort}/v1/gate`,
      delegated: true,
      maxImplementationRepairs: 1,
      maxAttempts: 4,
    });
    const installedOrd = await installedHandlerDigests();
    setFixture(fOrd.registry, ['spec', 'handlers'], [
      fOrd.registry.spec.handlers[0]!,
      {
        id: 'kernel-bench',
        kind: 'check',
        implementation: 'gate.v1',
        version: 1,
        digest: installedOrd['gate.v1'],
        parameters: { checkId: 'kernel-bench', endpointRef: 'gpu-relay', gateId: 'ordinary-gate-1' },
        capabilities: ['external_service', 'read_only'],
      },
      fOrd.registry.spec.handlers[2]!,
      fOrd.registry.spec.handlers[3]!,
    ]);
    setFixture(fOrd.config, ['spec', 'task', 'spec', 'acceptance'], {
      required: ['kernel-bench'],
      checks: [{ id: 'kernel-bench', allowedEvidenceLevels: ['external_service'] }],
    });
    await fOrd.save();
    const loadedOrd = assertOk(await fOrd.load(), 'load ordinary gate.v1 fixture');
    const fOrdRef = fOrd;
    const step1 = assertStepYield(
      assertOk(
        await stepNext({
          configuration: loadedOrd,
          repository: fOrdRef.repository,
          runRoot: fOrdRef.runRoot,
          runId: 'run-p1-ordinary-gate-keeps-repair',
          environment: name => fOrdRef.environment[name],
        }),
      ),
    );
    await writeFile(join(step1.candidateDir, 'packages', 'kernel.cu'), '// ordinary edit\n', { mode: 0o600 });
    const repairYield = assertStepYield(
      assertOk(
        await stepSubmit({
          runRoot: fOrdRef.runRoot,
          runId: 'run-p1-ordinary-gate-keeps-repair',
          leaseToken: step1.leaseToken,
          status: 'completed',
          environment: name => fOrdRef.environment[name],
        }),
      ),
    );
    assert.equal(repairYield.repair, 'implementation', 'ordinary gate.v1 denial must keep implementationRepair eligibility');
  } finally {
    if (fOrd) await fOrd.cleanup();
    await new Promise<void>(r => {
      ordinaryGateServer.closeAllConnections();
      ordinaryGateServer.close(() => r());
    });
  }
});

test('P3: cross-slot aggregate verifier output budget (256 files and shared byte limit) is enforced BEFORE local CAS reuse or HTTP GET', async () => {
  const blob1 = Buffer.alloc(600, 0x11);
  const sha1 = sha256Hex(blob1);
  const blob2 = Buffer.alloc(600, 0x22);
  const sha2 = sha256Hex(blob2);
  const slotOverFilesSha = sha256Hex(Buffer.from('over-256-never-downloaded'));

  const installed = await installedHandlerDigests();
  const budgetRelay = await startMockRelay({
    outputBlobs: new Map([
      [sha1, { bytes: blob1 }],
      [sha2, { bytes: blob2 }],
      [slotOverFilesSha, { bytes: Buffer.from('over-256-never-downloaded') }],
    ]),
    onPoll: ({ request }) => {
      if (request.checkId === 'bench-a') {
        return {
          status: 'approved',
          outputArtifacts: [
            { name: 'out/part-1.cubin', digest: { algorithm: 'sha256', hex: sha1 }, byteLength: 600 },
            { name: 'out/part-2.cubin', digest: { algorithm: 'sha256', hex: sha1 }, byteLength: 600 },
          ],
        };
      }
      if (request.checkId === 'bench-c') {
        // Proposes 20 files (<= 64 per-slot cap), pushing 240 + 20 = 260 > 256 default VERIFIER_ARTIFACT_LIMITS.maxTotalFiles!
        const outputs: BenchmarkOutputArtifact[] = [];
        for (let i = 0; i < 20; i++) {
          outputs.push({ name: `out/f-${i}.cubin`, digest: { algorithm: 'sha256', hex: slotOverFilesSha }, byteLength: 25 });
        }
        return { status: 'approved', outputArtifacts: outputs };
      }
      return {
        status: 'approved',
        outputArtifacts: [{ name: 'out/part-b.cubin', digest: { algorithm: 'sha256', hex: sha2 }, byteLength: 600 }],
      };
    },
  });

  const fBytes = await createBenchmarkFixture({ relayUrl: budgetRelay.url });
  setFixture(fBytes.registry, ['spec', 'handlers'], [
    fBytes.registry.spec.handlers[0]!,
    ...(['bench-a', 'bench-b', 'bench-c'] as const).map(cid => ({
      id: cid,
      kind: 'check',
      implementation: 'benchmark-gate.v1',
      version: 1,
      digest: installed['benchmark-gate.v1'],
      parameters: { checkId: cid, endpointRef: 'gpu-relay', gateId: 'gate-' + cid, heldOutWorkloadId: 'wl-1' },
      capabilities: ['hardware_execution', 'read_only'],
    })),
    fBytes.registry.spec.handlers[2]!,
    fBytes.registry.spec.handlers[3]!,
  ]);
  setFixture(fBytes.config, ['spec', 'task', 'spec', 'steps'], [
    { id: 'step-a', kind: 'check', uses: 'bench-a', roleId: null, dependsOn: [] },
    { id: 'step-b', kind: 'check', uses: 'bench-b', roleId: null, dependsOn: ['step-a'] },
    { id: 'step-c', kind: 'check', uses: 'bench-c', roleId: null, dependsOn: ['step-b'] },
  ]);
  setFixture(fBytes.config, ['spec', 'profiles', 'steps'], [
    { stepId: 'step-a', handlerRef: 'bench-a' },
    { stepId: 'step-b', handlerRef: 'bench-b' },
    { stepId: 'step-c', handlerRef: 'bench-c' },
  ]);
  setFixture(fBytes.config, ['spec', 'task', 'spec', 'acceptance'], {
    required: ['bench-a', 'bench-b', 'bench-c'],
    checks: [
      { id: 'bench-a', allowedEvidenceLevels: ['hardware_execution'], targetCellId: 'cuda-sm90' },
      { id: 'bench-b', allowedEvidenceLevels: ['hardware_execution'], targetCellId: 'cuda-sm90' },
      { id: 'bench-c', allowedEvidenceLevels: ['hardware_execution'], targetCellId: 'cuda-sm90' },
    ],
  });
  await fBytes.save();
  const loadedBytes = assertOk(await fBytes.load());
  try {
    const ctx = await createCycle(
      { configuration: loadedBytes, repository: fBytes.repository, runRoot: fBytes.runRoot, runId: 'run-p3-multi-slot-budgets' },
      {},
    );
    try {
      const cycle = new Cycle(ctx);
      await cycle.bootstrap();
      // 1. Run bench-a via real Cycle -> commits 2 verifier refs (1200 bytes) into retained progress + in-memory checks
      const resA = await cycle.runVerifier('check.bench-a');
      assert.equal(resA.status, 'passed');

      // Verify collectPriorGenerationVerifierBudget counts bench-a for bench-b, and deduplicates bench-a on recovery replay!
      const priorFromMem = await collectPriorGenerationVerifierBudget(ctx.plan, ctx.artifacts, 0, 'check.bench-b', cycle.checks, cycle.head?.progress.verifierReceipts);
      assert.deepEqual(priorFromMem, { files: 2, bytes: 1200 });
      const priorFromDisk = await collectPriorGenerationVerifierBudget(ctx.plan, ctx.artifacts, 0, 'check.bench-b', undefined, cycle.head?.progress.verifierReceipts);
      assert.deepEqual(priorFromDisk, { files: 2, bytes: 1200 });
      const priorReplaySelf = await collectPriorGenerationVerifierBudget(ctx.plan, ctx.artifacts, 0, 'check.bench-a', cycle.checks, cycle.head?.progress.verifierReceipts);
      assert.deepEqual(priorReplaySelf, { files: 0, bytes: 0 }, 'recovery replay of same slot must be excluded from prior budget');

      const bound = bindSubject(ctx.lock, ctx.source.manifest);
      assert.equal(bound.ok, true);
      if (bound.ok) {
        const cand = { manifest: ctx.source.manifest, ref: { name: 'm', digest: WORKLOAD_DIGEST, byteLength: 2 }, files: ctx.source.artifacts };

        // 2. Shared byte cap: Slot A used 1200B, Slot B proposes 600B (1800B > 1500B shared cap) -> rejected BEFORE HTTP GET!
        const byteGate = new BenchmarkGate(
          ctx.store,
          ctx.authority,
          ctx.artifacts,
          ctx.plan,
          ctx.lock,
          ref => approvedState(loadedBytes).vault.resolveNetworkCredential(ref),
          () => bound.value,
          null,
          undefined,
          (gen, excludeSlot) => collectPriorGenerationVerifierBudget(ctx.plan, ctx.artifacts, gen, excludeSlot, cycle.checks, cycle.head?.progress.verifierReceipts),
          { maxTotalFiles: 256, maxTotalBytes: 1500 },
        );
        const jobB = prepareBenchmarkGate(ctx.plan, ctx.lock, 'check.bench-b', cand, 0, '2'.repeat(32), loadedBytes.registry.spec.gateEndpoints);
        const resB = await byteGate.run(jobB, new AbortController().signal);
        assert.equal(resB.status, 'blocked');
        assert.equal(resB.reason, 'ARTIFACT_INVALID');
        assert.equal(budgetRelay.getRequests.some(g => g.sha256 === sha2), false, 'Slot B over-byte-cap blob must not be downloaded');

        // 3. Default 256-file cap (no verifierTotalLimits override!): 240 prior files + 20 proposed = 260 > 256 -> rejected BEFORE HTTP GET!
        const defaultFilesGate = new BenchmarkGate(
          ctx.store,
          ctx.authority,
          ctx.artifacts,
          ctx.plan,
          ctx.lock,
          ref => approvedState(loadedBytes).vault.resolveNetworkCredential(ref),
          () => bound.value,
          null,
          undefined,
          () => ({ files: 240, bytes: 2400 }),
        );
        const jobC = prepareBenchmarkGate(ctx.plan, ctx.lock, 'check.bench-c', cand, 0, '3'.repeat(32), loadedBytes.registry.spec.gateEndpoints);
        const resC = await defaultFilesGate.run(jobC, new AbortController().signal);
        assert.equal(resC.status, 'blocked');
        assert.equal(resC.reason, 'ARTIFACT_INVALID');
        assert.equal(
          budgetRelay.getRequests.some(g => g.sha256 === slotOverFilesSha),
          false,
          'Slot C exceeding default 256-file cap must be rejected BEFORE any HTTP GET',
        );
      }
      await cycle.deadline.dispose();
      await cycle.events.close();
    } finally {
      stateValue(ctx.store.release(ctx.authority));
      stateValue(ctx.store.close());
      await ctx.owner.release();
    }
  } finally {
    await fBytes.cleanup();
    await budgetRelay.close();
  }
});

test('P4: v2 overlay stages deterministic LWTREE01 baseTreeBundle for unchanged files before POST, allowing clean worker reconstruction', async () => {
  let reconstructedTree = new Map<string, string>();
  let observedTopLevelKeys: string[] = [];

  const relay = await startMockRelay({
    onPoll: ({ request, stagedBlobs }) => {
      observedTopLevelKeys = Object.keys(request).sort();
      const candArts = request.candidateArtifacts as {
        entries: readonly { name: string; digest: { hex: string }; byteLength: number }[];
        deleted: readonly string[];
        baseTree?: unknown;
        baseTreeBundle?: { digest: { hex: string }; byteLength: number };
      };
      assert.ok(candArts.baseTreeBundle !== undefined, 'v2 request with surviving unchanged files must include baseTreeBundle');
      const bundleBuf = stagedBlobs.get(candArts.baseTreeBundle.digest.hex);
      assert.ok(bundleBuf !== undefined, 'baseTreeBundle must be staged via PUT before POST');
      assert.equal(bundleBuf.byteLength, candArts.baseTreeBundle.byteLength);
      assert.equal(bundleBuf.subarray(0, 8).toString('ascii'), LWTREE01_MAGIC);

      // Clean mock worker reconstructs full candidate tree strictly from staged baseTreeBundle + staged overlay entries!
      const tree = new Map<string, string>();
      for (const baseEntry of decodeBenchmarkBaseTreeBundle(bundleBuf)) {
        tree.set(baseEntry.name, Buffer.from(baseEntry.bytes).toString('utf8'));
      }
      for (const del of candArts.deleted) {
        assert.equal(tree.has(del), false, 'deleted baseline file must already be excluded from baseTreeBundle');
      }
      for (const ov of candArts.entries) {
        const ovBytes = stagedBlobs.get(ov.digest.hex);
        assert.ok(ovBytes !== undefined, `overlay entry ${ov.name} must be staged`);
        tree.set(ov.name, ovBytes.toString('utf8'));
      }
      reconstructedTree = tree;
      return { status: 'approved', metrics: { latency_us: 35.0 } };
    },
  });

  const f = await createBenchmarkFixture({
    relayUrl: relay.url,
    delegated: true,
    overlay: { maxFiles: 129, maxBytes: 2_097_152 }, // forces v2 tree_overlay mode
    repoFiles: {
      'include/math.h': '#pragma once\ninline float fast_mul(float a, float b) { return a * b; }\n',
      'packages/src/kernel.cu': '#include "../../include/math.h"\n__global__ void k() {}\n',
      'packages/old.txt': 'obsolete baseline file\n',
    },
  });

  try {
    const runId = 'run-p4-base-tree-bundle';
    const step1 = assertStepYield(
      assertOk(
        await stepNext({
          configuration: f.loaded,
          repository: f.repository,
          runRoot: f.runRoot,
          runId,
          environment: name => f.environment[name],
        }),
      ),
    );
    const updatedKernel = '#include "../../include/math.h"\n__global__ void k_v2(float* x) { x[0] = fast_mul(x[0], 2.0f); }\n';
    await writeFile(join(step1.candidateDir, 'packages', 'src', 'kernel.cu'), updatedKernel, { mode: 0o600 });
    await rm(join(step1.candidateDir, 'packages', 'old.txt'));

    const settled = assertOk(
      await stepSubmit({
        runRoot: f.runRoot,
        runId,
        leaseToken: step1.leaseToken,
        status: 'completed',
        environment: name => f.environment[name],
      }),
    );
    assert.equal(settled.kind, 'result');
    if (settled.kind === 'result') assert.equal(settled.result.spec.status, 'completed');

    assert.equal(observedTopLevelKeys.length, 19, 'top-level benchmark_request must preserve exact 19-key schema');
    assert.equal(relay.putRequests.length, 2, 'must stage baseTreeBundle + modified packages/src/kernel.cu');
    assert.deepEqual([...reconstructedTree.keys()].sort(), ['include/math.h', 'packages/src/kernel.cu']);
    assert.match(reconstructedTree.get('include/math.h') ?? '', /fast_mul/);
    assert.equal(reconstructedTree.get('packages/src/kernel.cu'), updatedKernel);
    assert.equal(reconstructedTree.has('packages/old.txt'), false);

    // Negative decoder checks: bad magic and trailing bytes refuse ARTIFACT_INVALID
    assert.throws(() => decodeBenchmarkBaseTreeBundle(Buffer.from('BADMAGIC\x00\x00\x00\x00')), /ARTIFACT_INVALID/);
    assert.throws(() => decodeBenchmarkBaseTreeBundle(Buffer.from('LWTREE01\x00\x00\x00\x00\xff')), /ARTIFACT_INVALID/);
    void resolveBenchmarkSlotMetadata;
  } finally {
    await f.cleanup();
    await relay.close();
  }
});

test('P6: delayed final poll after pollDeadlineMono and approval expiring during Stage A CAS pull both settle blocked (never passing late approval)', async () => {
  // (a) Delayed final poll arriving after maxPollMs=1000 following an initial preempted pending poll -> blocked BENCHMARK_PREEMPTED
  const latePollRelay = await startMockRelay({
    onPoll: ({ pollAttempt }) => {
      if (pollAttempt === 1) {
        return { status: 'pending', preemptionCount: 1 };
      }
      // Fast poll1 (<10ms) records sawPreemption=true + 100ms sleep; poll2 delayed 980ms -> past maxPollMs=1000!
      return { status: 'approved', preemptionCount: 1, delayMs: 980 };
    },
  });
  const fLatePoll = await createBenchmarkFixture({
    relayUrl: latePollRelay.url,
    maxPollMs: 1000,
    timeoutMs: 1000,
  });
  try {
    const res = assertOk(
      await runCycleWithPorts({
        configuration: fLatePoll.loaded,
        repository: fLatePoll.repository,
        runRoot: fLatePoll.runRoot,
        runId: 'run-p6-late-final-poll',
      }),
    );
    assert.equal(res.kind, 'result');
    if (res.kind === 'result') {
      assert.equal(res.result.spec.status, 'blocked', 'late final approval after pollDeadlineMono must NEVER pass');
      assert.equal(res.result.spec.verification.spec.required[0]!.detail, 'BENCHMARK_PREEMPTED');
    }
  } finally {
    await fLatePoll.cleanup();
    await latePollRelay.close();
  }

  // (b) Verdict fresh at POST completion (expiresAtMs = now + 180ms) that expires during a 380ms Stage A CAS blob pull -> blocked EVIDENCE_UNAVAILABLE
  const slowOutBytes = Buffer.from('slow-stage-a-cubin');
  const slowOutSha = sha256Hex(slowOutBytes);
  const expiringPullRelay = await startMockRelay({
    outputBlobs: new Map([[slowOutSha, { bytes: slowOutBytes, delayMs: 380 }]]),
    onPoll: () => ({
      status: 'approved',
      expiresAtMs: String(Date.now() + 180),
      outputArtifacts: [{ name: 'out/slow.cubin', digest: { algorithm: 'sha256', hex: slowOutSha }, byteLength: slowOutBytes.byteLength }],
    }),
  });
  const fExpirePull = await createBenchmarkFixture({ relayUrl: expiringPullRelay.url });
  try {
    const res = assertOk(
      await runCycleWithPorts({
        configuration: fExpirePull.loaded,
        repository: fExpirePull.repository,
        runRoot: fExpirePull.runRoot,
        runId: 'run-p6-expire-during-cas-pull',
      }),
    );
    assert.equal(res.kind, 'result');
    if (res.kind === 'result') {
      assert.equal(res.result.spec.status, 'blocked', 'verdict expiring during CAS pull must settle blocked');
      assert.equal(res.result.spec.verification.spec.required[0]!.detail, 'EVIDENCE_UNAVAILABLE');
    }
    assert.equal(expiringPullRelay.getRequests.length, 1, 'blob pull ran while verdict was initially fresh, then post-pull wall clock caught expiry');
  } finally {
    await fExpirePull.cleanup();
    await expiringPullRelay.close();
  }
});

test('Fix Pass #2 — S2, S5, S7, child ownership, activity hold, P3 proof budget preflight, and P4 executable mode + strict magic bytes', async () => {
  // 1. P4 strict magic header: high-bit-set byte (0x80 | 0x4c) decodes to 'LWTREE01' in Node ASCII, MUST refuse ARTIFACT_INVALID
  const highBitMagic0 = Buffer.from('LWTREE01\x00\x00\x00\x00', 'ascii');
  highBitMagic0[0] = 0x80 | 0x4c;
  assert.equal(highBitMagic0.subarray(0, 8).toString('ascii'), LWTREE01_MAGIC);
  assert.throws(() => decodeBenchmarkBaseTreeBundle(highBitMagic0), /ARTIFACT_INVALID/);

  const highBitMagic7WithOffset = Buffer.concat([Buffer.from([0xaa, 0xbb, 0xcc]), Buffer.from('LWTREE01\x00\x00\x00\x00', 'ascii')]);
  highBitMagic7WithOffset[3 + 7] = 0x80 | 0x31;
  assert.throws(() => decodeBenchmarkBaseTreeBundle(highBitMagic7WithOffset.subarray(3)), /ARTIFACT_INVALID/);

  // 2. S7: production vault checker + binary secret scanner combined window stays strictly <= 1_048_576 bytes across multi-MiB uneven chunks
  const fVault = await createBenchmarkFixture({ relayUrl: 'http://127.0.0.1:9/v1/benchmark/jobs' });
  try {
    const prodVault = approvedState(fVault.loaded).vault;
    const directChecker = prodVault.createStreamChecker();
    const unevenSizes = [1_048_576, 1_500_003, 777_777, 1_048_576, 2_100_019];
    for (const sz of unevenSizes) {
      directChecker.push(Buffer.alloc(sz, 0x61));
    }
    directChecker.finish();
    assert.ok(
      (directChecker.maxObservedWindowBytes ?? 0) > 0 && (directChecker.maxObservedWindowBytes ?? 0) <= 1_048_576,
      `expected production vault maxObservedWindowBytes <= 1_048_576, got ${String(directChecker.maxObservedWindowBytes)}`,
    );

    const longExtra = ('EXTRA_CANARY_' + '語'.repeat(2500)).slice(0, MAX_EXTRA_SECRET_LENGTH);
    const binScanner = createBinarySecretStreamScanner(
      prodVault,
      '.loopwright-verifier/check.kernel-bench/window.bin',
      'verification',
      [longExtra],
    );
    for (const sz of unevenSizes) {
      binScanner.push(Buffer.alloc(sz, 0x62));
    }
    binScanner.finish();
    assert.ok(
      binScanner.maxObservedWindowBytes > 0 && binScanner.maxObservedWindowBytes <= 1_048_576,
      `expected combined scanner maxObservedWindowBytes <= 1_048_576, got ${binScanner.maxObservedWindowBytes}`,
    );

    // Cross-boundary vault secret split across two 1 MiB chunks still trips ARTIFACT_INVALID while staying <= 1 MiB
    const secretBytes = Buffer.from(BENCH_SECRET, 'utf8');
    const half = Math.floor(secretBytes.byteLength / 2);
    const splitScanner = createBinarySecretStreamScanner(
      prodVault,
      '.loopwright-verifier/check.kernel-bench/split-vault.bin',
      'verification',
    );
    const c1 = Buffer.concat([Buffer.alloc(1_048_576 - half, 0x41), secretBytes.subarray(0, half)]);
    const c2 = Buffer.concat([secretBytes.subarray(half), Buffer.alloc(1_048_576 - (secretBytes.byteLength - half), 0x42)]);
    splitScanner.push(c1);
    assert.throws(() => splitScanner.push(c2), /ARTIFACT_INVALID/);
    assert.ok(splitScanner.maxObservedWindowBytes <= 1_048_576);
  } finally {
    await fVault.cleanup();
  }

  // 3. S2 (dedup inode replacement rejected) + P3 (existing-proof aggregate budget prevalidated before first local CAS hash)
  const validCubin = Buffer.alloc(400, 0x5a);
  const validCubinSha = sha256Hex(validCubin);
  const validCubin2 = Buffer.alloc(400, 0x5b);
  const validCubin2Sha = sha256Hex(validCubin2);
  const s2Relay = await startMockRelay({
    outputBlobs: new Map([
      [validCubinSha, { bytes: validCubin }],
      [validCubin2Sha, { bytes: validCubin2 }],
    ]),
    onPoll: () => ({
      status: 'approved',
      outputArtifacts: [
        { name: 'out/part1.cubin', digest: { algorithm: 'sha256', hex: validCubinSha }, byteLength: validCubin.byteLength },
        { name: 'out/part2.cubin', digest: { algorithm: 'sha256', hex: validCubin2Sha }, byteLength: validCubin2.byteLength },
      ],
    }),
  });
  const fS2 = await createBenchmarkFixture({ relayUrl: s2Relay.url });
  try {
    const ctx = await createCycle({ configuration: fS2.loaded, repository: fS2.repository, runRoot: fS2.runRoot, runId: 'run-fp2-s2-p3' }, {});
    try {
      const cycle = new Cycle(ctx);
      await cycle.bootstrap();
      const slot = ctx.plan.verifierSlots.find(s => s.handler.implementation === 'benchmark-gate.v1')!;
      const checked = await cycle.runVerifier(slot.id);
      assert.equal(checked.status, 'passed');

      // S2: replace the verified CAS inode mid-stream during duplicate ingestion -> MUST reject ARTIFACT_INVALID!
      const casBlobPath = join(ctx.artifacts.directory, 'blobs', 'sha256', validCubinSha);
      const originalStat = await lstat(casBlobPath);
      await assert.rejects(
        () =>
          ctx.artifacts.ingestVerifiedCasBlobStream(
            {
              logicalName: `.loopwright-verifier/${slot.id}/out/part1.cubin`,
              expectedSha256: validCubinSha,
              expectedByteLength: validCubin.byteLength,
            },
            async consume => {
              await consume(validCubin.subarray(0, 200));
              // Replace CAS file on disk with a new 0o400 owned regular file of identical length (different inode + bytes)
              await chmod(casBlobPath, 0o600);
              await unlink(casBlobPath);
              const fh = await fsOpen(casBlobPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400);
              try {
                await fh.writeFile(Buffer.alloc(validCubin.byteLength, 0x99));
                await fh.chmod(0o400);
                await fh.sync();
              } finally {
                await fh.close();
              }
              const replacedStat = await lstat(casBlobPath);
              assert.notEqual(replacedStat.ino, originalStat.ino, 'replacement must allocate a distinct inode');
              await consume(validCubin.subarray(200));
            },
          ),
        /ARTIFACT_INVALID/,
      );
      // Restore valid CAS blob for subsequent P3 check
      await chmod(casBlobPath, 0o600);
      await unlink(casBlobPath);
      await ctx.artifacts.ingestVerifiedCasBlobStream(
        {
          logicalName: `.loopwright-verifier/${slot.id}/out/part1.cubin`,
          expectedSha256: validCubinSha,
          expectedByteLength: validCubin.byteLength,
        },
        async consume => {
          await consume(validCubin);
        },
      );

      // S5 fail-closed missing stamp: calling evaluateControllerAcceptance without preverified token throws EVIDENCE_UNAVAILABLE
      for (const s of ctx.plan.verifierSlots) {
        if (s.id !== slot.id) await cycle.runVerifier(s.id);
      }
      await cycle.ensureSubmissionForAcceptance();
      assert.throws(
        () =>
          evaluateControllerAcceptance(
            ctx.plan,
            ctx.lock,
            cycle.candidate.manifest,
            cycle.candidate.files,
            cycle.generation,
            cycle.currentChecks(),
            cycle.submission!.value,
            ctx.store,
          ),
        /EVIDENCE_UNAVAILABLE/,
        'verifier output refs without async preverification stamp must fail closed',
      );
      // Non-benchmark checks alone (zero verifier output refs) still evaluate synchronously without preverified!
      const nonBenchChecks = cycle.currentChecks().filter(c => c.slotId !== slot.id);
      const syncObs = evaluateControllerAcceptance(
        ctx.plan,
        ctx.lock,
        cycle.candidate.manifest,
        cycle.candidate.files,
        cycle.generation,
        nonBenchChecks,
        cycle.submission!.value,
        ctx.store,
      );
      assert.equal(syncObs.result.spec.status, 'blocked');

      // P3 existing-proof recovery preflight: priorBudget=1000B + two 400B refs = 1800B > 1500B cap -> ZERO local CAS hashes!
      const row = cycle.head!.progress.verifierReceipts.find(r => r.slot === slot.id)!;
      const proofFile = (await readdir(ctx.artifacts.directory)).find(n => n.endsWith('.proof.json'))!;
      const proofBytes = await readFile(join(ctx.artifacts.directory, proofFile));
      const view = stateValue(ctx.store.inspect());
      const op = stateValue(ctx.store.getOperation(row.operationId));
      const bound = bindSubject(ctx.lock, ctx.source.manifest);
      assert.equal(bound.ok, true);
      if (bound.ok) {
        const endpoint = fS2.loaded.registry.spec.gateEndpoints[0]!;
        const req: Record<string, unknown> = {
          ...expectedBenchmarkRequest(ctx.plan, slot, endpoint, bound.value, ctx.source.manifest),
          storeId: view.storeId,
          runId: view.runId,
          lockHash: view.lockHash,
          operationId: row.operationId,
          dispatchId: op.dispatch!.dispatchId,
          dispatchGeneration: op.dispatch!.generation,
          requestDigest: op.intent.requestDigest.hex,
        };
        const reqBytesDigest = hash(Buffer.from(canonical(req))).hex;
        let verifyCalls = 0;
        const origVerify = ctx.artifacts.verifyOrReuseVerifierCasBlob.bind(ctx.artifacts);
        (ctx.artifacts as unknown as Record<string, unknown>).verifyOrReuseVerifierCasBlob = async (
          ...args: Parameters<typeof origVerify>
        ) => {
          verifyCalls++;
          return origVerify(...args);
        };
        try {
          await assert.rejects(
            () =>
              validateStoredBenchmarkProof({
                proofBytes,
                artifacts: ctx.artifacts,
                plan: ctx.plan,
                slot,
                endpoint,
                targetHardware: { accelerator: 'sm_90a', isolationMode: 'whole_device' },
                targetCellId: 'cuda-sm90',
                allowSyntheticHardwareProbe: true,
                metricThresholds: [{ kind: 'bounds', metric: 'latency_us', max: 100 }],
                view,
                operation: op,
                dispatch: op.dispatch!,
                operationId: row.operationId,
                producerNonce: row.producerNonce,
                generation: 0,
                subject: bound.value,
                request: req,
                requestBytesDigest: reqBytesDigest,
                secret: BENCH_SECRET,
                bearerToken: BENCH_BEARER,
                priorBudget: { files: 1, bytes: 1000 },
                totalLimits: { maxTotalFiles: 256, maxTotalBytes: 1500 },
              }),
            /RECOVERY_REQUIRED/,
          );
          assert.equal(verifyCalls, 0, 'must reject aggregate byte overflow BEFORE hashing first local CAS blob');
        } finally {
          (ctx.artifacts as unknown as Record<string, unknown>).verifyOrReuseVerifierCasBlob = origVerify;
        }
      }

      await cycle.deadline.dispose();
      await cycle.events.close();
    } finally {
      stateValue(ctx.store.release(ctx.authority));
      stateValue(ctx.store.close());
      await ctx.owner.release();
    }
  } finally {
    await fS2.cleanup();
    await s2Relay.close();
  }

  // 4. Owned child lifecycle (intent/started/exit in controller.owner.ndjson) + activity-hold release on temp open failure
  const fOwn = await createBenchmarkFixture({
    relayUrl: 'http://127.0.0.1:9/v1/benchmark/jobs',
    overlay: { maxFiles: 129, maxBytes: 2_097_152 }, // v2 tree_overlay mode
    repoFiles: {
      'include/a.h': '#pragma once\n',
      'packages/k.cu': '__global__ void k() {}\n',
    },
  });
  try {
    const ctx = await createCycle({ configuration: fOwn.loaded, repository: fOwn.repository, runRoot: fOwn.runRoot, runId: 'run-fp2-owner' }, {});
    const planDigest = ctx.plan.planDigest;
    const frozenSource = ctx.source;
    stateValue(ctx.store.release(ctx.authority));
    stateValue(ctx.store.close());
    await ctx.owner.release();

    const subOwnerDir = join(fOwn.runRoot, 'owner-lifecycle-probe');
    await mkdir(subOwnerDir, { mode: 0o700 });
    let sawInFlightStartedRecord = false;
    let observedReaderNonce = '';
    const probeOwner = await ControllerOwner.acquire(subOwnerDir, 'probe-run', planDigest, {
      afterGitExec: async ({ pid, nonce }) => {
        observedReaderNonce = nonce;
        const ownerLines = (await readFile(join(subOwnerDir, 'controller.owner.ndjson'), 'utf8'))
          .trim()
          .split('\n')
          .map(line => JSON.parse(line) as Record<string, unknown>);
        const hasIntent = ownerLines.some(r => r.type === 'intent' && r.nonce === nonce);
        const hasStarted = ownerLines.some(r => r.type === 'started' && r.nonce === nonce && r.pid === pid);
        const hasExitYet = ownerLines.some(r => r.type === 'exit' && r.nonce === nonce);
        sawInFlightStartedRecord = hasIntent && hasStarted && !hasExitYet;
      },
    });
    const probeArtDir = join(subOwnerDir, 'artifacts');
    await mkdir(probeArtDir, { mode: 0o700 });
    const probeArtifacts = new (await import('../src/storage.js')).ArtifactStore(
      probeArtDir,
      probeOwner,
      approvedState(fOwn.loaded).vault,
    );

    const sealed = await sealBenchmarkBaseTreeBundle(
      frozenSource,
      frozenSource.manifest,
      probeArtifacts,
      probeOwner,
      new AbortController().signal,
    );
    assert.ok(sealed !== undefined);
    assert.equal(sawInFlightStartedRecord, true, 'must record durable intent + started rows while git-reader child is active');
    const postLines = (await readFile(join(subOwnerDir, 'controller.owner.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
    assert.equal(
      postLines.some(r => r.type === 'exit' && r.nonce === observedReaderNonce && r.code === 0 && r.signal === null),
      true,
      'must record durable exit row after git-reader batch finishes',
    );

    // Simulate temp open failure (EACCES on read-only blobs/sha256 dir) and verify probeOwner.release() succeeds cleanly!
    const sha256Dir = join(probeArtDir, 'blobs', 'sha256');
    await chmod(sha256Dir, 0o500);
    try {
      await assert.rejects(() =>
        sealBenchmarkBaseTreeBundle(
          frozenSource,
          frozenSource.manifest,
          probeArtifacts,
          probeOwner,
          new AbortController().signal,
        ),
      );
    } finally {
      await chmod(sha256Dir, 0o700);
    }
    await probeOwner.release();
  } finally {
    await fOwn.cleanup();
  }

  // 5. S5 delegated cancel & error paths + single async CAS verification pass + P4 executable overlay mode ('100755') on wire
  const execBlob = Buffer.alloc(1_200_000, 0x33);
  const execBlobSha = sha256Hex(execBlob);
  let observedExecWireEntries: readonly Record<string, unknown>[] = [];
  let observedTopKeys: string[] = [];
  const execRelay = await startMockRelay({
    outputBlobs: new Map([[execBlobSha, { bytes: execBlob }]]),
    onPoll: ({ request }) => {
      observedTopKeys = Object.keys(request).sort();
      const candArts = request.candidateArtifacts as { entries: readonly Record<string, unknown>[] };
      observedExecWireEntries = candArts.entries;
      return {
        status: 'denied',
        reason: 'perf_regression',
        metrics: { latency_us: 140.0 },
        outputArtifacts: [{ name: 'out/trace.cubin', digest: { algorithm: 'sha256', hex: execBlobSha }, byteLength: execBlob.byteLength }],
      };
    },
  });
  const fExec = await createBenchmarkFixture({
    relayUrl: execRelay.url,
    delegated: true,
    maxImplementationRepairs: 1,
    maxAttempts: 4,
    overlay: { maxFiles: 129, maxBytes: 2_097_152 }, // v2 tree_overlay mode
    repoFiles: {
      'include/base.h': '#pragma once\n',
      'packages/kernel.cu': '__global__ void k() {}\n',
    },
  });
  try {
    // Pure P4 check: identical bytes with 100755 vs 100644 yield distinct descriptors and distinct requestDigests, and invalid modes refuse!
    const compiled = assertOk(await compilePlan(fExec.loaded));
    const admitted = admitTask(compiled.task, { admissionId: 'adm.mode', runId: 'run-mode' });
    assert.equal(admitted.ok, true);
    if (admitted.ok) {
      const scriptBytes = Buffer.from('#!/bin/sh\necho build\n', 'utf8');
      const scriptSha = sha256Hex(scriptBytes);
      const manifestWithScript = {
        apiVersion: 'loopwright.dev/v1alpha1' as const,
        kind: 'ArtifactManifest' as const,
        metadata: { id: 'candidate' },
        spec: {
          entries: [{ name: 'packages/build.sh', digest: { algorithm: 'sha256' as const, hex: scriptSha }, byteLength: scriptBytes.byteLength }],
        },
      };
      const desc755 = buildCandidateArtifactsDescriptor(manifestWithScript, undefined, [{ name: 'packages/build.sh', mode: '100755' }]);
      const desc644 = buildCandidateArtifactsDescriptor(manifestWithScript, undefined, [{ name: 'packages/build.sh', mode: '100644' }]);
      assert.equal(desc755.entries[0]!.mode, '100755');
      assert.equal('mode' in desc644.entries[0]!, false, '100644 must omit mode for canonical backward compatibility');
      assert.deepEqual(checkedBenchmarkCandidateArtifacts(desc755), desc755);
      assert.deepEqual(checkedBenchmarkCandidateArtifacts({ entries: [{ ...desc644.entries[0]!, mode: '100644' }], deleted: [] }), desc644);
      assert.throws(
        () => checkedBenchmarkCandidateArtifacts({ entries: [{ ...desc644.entries[0]!, mode: '100600' }], deleted: [] }),
        /ARTIFACT_INVALID/,
      );

      const job755 = prepareBenchmarkGate(
        compiled,
        admitted.value,
        'check.kernel-bench',
        { manifest: manifestWithScript, ref: { name: 'm', digest: WORKLOAD_DIGEST, byteLength: 2 }, files: [{ name: 'packages/build.sh', bytes: scriptBytes, mode: '100755' }] },
        0,
        'a'.repeat(32),
        fExec.loaded.registry.spec.gateEndpoints,
      );
      const job644 = prepareBenchmarkGate(
        compiled,
        admitted.value,
        'check.kernel-bench',
        { manifest: manifestWithScript, ref: { name: 'm', digest: WORKLOAD_DIGEST, byteLength: 2 }, files: [{ name: 'packages/build.sh', bytes: scriptBytes, mode: '100644' }] },
        0,
        'a'.repeat(32),
        fExec.loaded.registry.spec.gateEndpoints,
      );
      assert.notEqual(job755.requestDigest.hex, job644.requestDigest.hex, '100755 vs 100644 must produce distinct requestDigests');
      assert.throws(
        () =>
          prepareBenchmarkGate(
            compiled,
            admitted.value,
            'check.kernel-bench',
            {
              manifest: manifestWithScript,
              ref: { name: 'm', digest: WORKLOAD_DIGEST, byteLength: 2 },
              files: [{ name: 'packages/build.sh', bytes: scriptBytes, mode: '0755' as '100755' }],
            },
            0,
            'a'.repeat(32),
            fExec.loaded.registry.spec.gateEndpoints,
          ),
        /ARTIFACT_INVALID/,
      );
    }

    // End-to-end delegated v2 run: add executable helper (0o755) + ordinary kernel edit (0o600), hit denied -> yields repair -> stepCancel!
    const runId = 'run-fp2-exec-mode-and-step-cancel';
    const step1 = assertStepYield(
      assertOk(
        await stepNext({
          configuration: fExec.loaded,
          repository: fExec.repository,
          runRoot: fExec.runRoot,
          runId,
          environment: name => fExec.environment[name],
        }),
      ),
    );
    await writeFile(join(step1.candidateDir, 'packages', 'helper.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await chmod(join(step1.candidateDir, 'packages', 'helper.sh'), 0o755);
    await writeFile(join(step1.candidateDir, 'packages', 'kernel.cu'), '__global__ void k_edited() {}\n', { mode: 0o600 });

    const repairStep = assertStepYield(
      assertOk(
        await stepSubmit({
          runRoot: fExec.runRoot,
          runId,
          leaseToken: step1.leaseToken,
          status: 'completed',
          environment: name => fExec.environment[name],
        }),
      ),
    );
    assert.equal(repairStep.repair, 'implementation');
    assert.equal(observedTopKeys.length, 19, 'benchmark_request must keep exact 19 top-level keys');
    const helperWire = observedExecWireEntries.find(e => e.name === 'packages/helper.sh');
    const kernelWire = observedExecWireEntries.find(e => e.name === 'packages/kernel.cu');
    assert.equal(helperWire?.mode, '100755', 'executable overlay script must carry mode 100755 on wire');
    assert.equal(kernelWire !== undefined && 'mode' in kernelWire, false, 'ordinary 100644 overlay file must omit mode on wire');

    // S5 delegated cancel path (step.ts ~1105): restores benchmark check with 1.2 MiB verifier output and pre-verifies asynchronously!
    const cancelled = assertOk(
      await stepCancel({
        runRoot: fExec.runRoot,
        runId,
        environment: name => fExec.environment[name],
      }),
    );
    assert.equal(cancelled.kind, 'result', 'stepCancel must settle cleanly via async CAS preverification without throwing EVIDENCE_UNAVAILABLE');
    if (cancelled.kind === 'result') {
      assert.equal(cancelled.result.spec.status, 'cancelled');
    }

    // S5 delegated error/forced path (step.ts ~825): hitting ATTEMPT_LIMIT during repairBound with a 1.2 MiB verifier output
    // settles status: 'exhausted' cleanly via async CAS preverification (never throwing EVIDENCE_UNAVAILABLE or incidents)!
    setFixture(fExec.config, ['spec', 'controls', 'maxAttempts'], 2);
    setFixture(fExec.config, ['spec', 'task', 'spec', 'budgets', 'maxImplementationRepairs'], 2);
    await fExec.save();
    const loadedCap2 = assertOk(await fExec.load());
    const errRunId = 'run-fp2-step-error-forced-exhausted';
    const errStep1 = assertStepYield(
      assertOk(
        await stepNext({
          configuration: loadedCap2,
          repository: fExec.repository,
          runRoot: fExec.runRoot,
          runId: errRunId,
          environment: name => fExec.environment[name],
        }),
      ),
    );
    await writeFile(join(errStep1.candidateDir, 'packages', 'kernel.cu'), '__global__ void k_attempt1() {}\n', { mode: 0o600 });
    const errRepair = assertStepYield(
      assertOk(
        await stepSubmit({
          runRoot: fExec.runRoot,
          runId: errRunId,
          leaseToken: errStep1.leaseToken,
          status: 'completed',
          environment: name => fExec.environment[name],
        }),
      ),
    );
    assert.equal(errRepair.repair, 'implementation');
    // Submit modified candidate on attempt 2: bench-step runs (ingesting 1.2 MiB CAS), then prepareImplementationRepair throws ATTEMPT_LIMIT -> caught at step.ts ~825!
    await writeFile(join(errRepair.candidateDir, 'packages', 'kernel.cu'), '__global__ void k_attempt2() {}\n', { mode: 0o600 });
    const exhaustedRes = assertOk(
      await stepSubmit({
        runRoot: fExec.runRoot,
        runId: errRunId,
        leaseToken: errRepair.leaseToken,
        status: 'completed',
        environment: name => fExec.environment[name],
      }),
    );
    assert.equal(exhaustedRes.kind, 'result', 'step error path must preverify verifier CAS asynchronously and return RunResult');
    if (exhaustedRes.kind === 'result') {
      assert.equal(exhaustedRes.result.spec.status, 'exhausted');
    }
  } finally {
    await fExec.cleanup();
    await execRelay.close();
  }
});

test('Fix Pass #3 — exact 0o7777 CAS permission mask (rejects 0o1400) and mixed-adapter non-baseline executable refusal', async () => {
  // 1. Special permission bits (0o1400 sticky bit) must be rejected by verifier CAS reuse, dedup ingestion, and acceptance.
  const relay = await startMockRelay({ onPoll: () => ({ status: 'approved' }) });
  const f = await createBenchmarkFixture({ relayUrl: relay.url });
  try {
    const ctx = await createCycle(
      {
        configuration: f.loaded,
        repository: f.repository,
        runRoot: f.runRoot,
        runId: 'run-fp3-special-bits',
      },
      {},
    );
    try {
      const payload = Buffer.from('fp3-sticky-bit-cas-blob-payload');
      const payloadSha = sha256Hex(payload);
      const stored = await ctx.artifacts.ingestVerifiedCasBlobStream(
        {
          logicalName: '.loopwright-verifier/check.kernel-bench/sticky.bin',
          expectedSha256: payloadSha,
          expectedByteLength: payload.byteLength,
          phase: 'verification',
        },
        async consume => {
          await consume(payload);
        },
      );
      await chmod(stored.path, 0o1400);
      const afterChmod = await lstat(stored.path);
      if ((afterChmod.mode & 0o7777) === 0o1400) {
        await assert.rejects(
          () =>
            ctx.artifacts.verifyOrReuseVerifierCasBlob({
              logicalName: '.loopwright-verifier/check.kernel-bench/sticky.bin',
              expectedSha256: payloadSha,
              expectedByteLength: payload.byteLength,
              phase: 'verification',
            }),
          /ARTIFACT_INVALID/,
          'verifyOrReuseVerifierCasBlob must reject 0o1400 (special permission bits)',
        );
        await assert.rejects(
          () =>
            ctx.artifacts.ingestVerifiedCasBlobStream(
              {
                logicalName: '.loopwright-verifier/check.kernel-bench/sticky.bin',
                expectedSha256: payloadSha,
                expectedByteLength: payload.byteLength,
                phase: 'verification',
              },
              async consume => {
                await consume(payload);
              },
            ),
          /ARTIFACT_INVALID/,
          'ingestVerifiedCasBlobStream must reject existing 0o1400 CAS blob',
        );
      }
      await chmod(stored.path, 0o400);

      // 1b. Rate-limited progress helper throttles SQLite renewals during multi-chunk scans.
      let renewCalls = 0;
      const throttled = createRateLimitedProgress(() => {
        renewCalls++;
      }, 40)!;
      for (let i = 0; i < 20; i++) await throttled();
      assert.equal(renewCalls, 0, 'immediate burst within minIntervalMs must not flood SQLite renewals');
      await new Promise<void>(r => setTimeout(r, 55));
      await throttled();
      assert.equal(renewCalls, 1, 'progress callback must fire once elapsed >= minIntervalMs');

      // 1c. Concurrent expiry must not obscure ARTIFACT_INVALID when CAS integrity failed on an approved verdict.
      const disp = computeBenchmarkDisposition({
        verdict: {
          status: 'approved',
          reason: null,
          expiresAtMs: '1',
          preemptionCount: 0,
          hardwareProvenance: makeProvenance(),
          metrics: { latency_us: 40 },
        },
        timedOut: false,
        sawPreemption: false,
        wallClockValid: false,
        targetHardware: {
          accelerator: 'sm_90a',
          isolationMode: 'whole_device',
          deviceCount: 1,
          driverConstraint: '550.*',
        },
        targetCellId: 'cuda-sm90',
        allowSyntheticHardwareProbe: false,
        metricThresholds: [{ kind: 'bounds', metric: 'latency_us', max: 100 }],
        casOutcome: 'artifact_invalid',
      });
      assert.equal(disp.status, 'blocked');
      assert.equal(disp.reason, 'ARTIFACT_INVALID', 'known CAS integrity failure must preserve ARTIFACT_INVALID even when expired');
    } finally {
      stateValue(ctx.store.release(ctx.authority));
      stateValue(ctx.store.close());
      await ctx.owner.release();
    }
  } finally {
    await f.cleanup();
    await relay.close();
  }

  // 2. Mixed-adapter pipeline (delegated author adds executable helper -> native Pi read-only reviewer -> benchmark-gate.v1):
  // native Pi cannot materialize non-baseline 100755 modes, so controller must refuse CAPABILITY_UNSUPPORTED BEFORE openAdapter!
  const mixedRelay = await startMockRelay({ onPoll: () => ({ status: 'approved' }) });
  const baseNative = await configurationFixture();
  const fMixed = await createBenchmarkFixture({
    relayUrl: mixedRelay.url,
    delegated: true,
    overlay: { maxFiles: 129, maxBytes: 2_097_152 },
    repoFiles: {
      'include/base.h': '#pragma once\n',
      'packages/kernel.cu': '__global__ void k() {}\n',
    },
  });
  try {
    const nativeProfile = { ...baseNative.registry.spec.roleProfiles[0]!, id: 'reviewer' };
    const nativeRole = { ...baseNative.config.spec.task.spec.roles[0]!, id: 'reviewer' };
    const existingCreds = [...fMixed.config.spec.credentials];
    const providerCred = baseNative.config.spec.credentials[0]!;
    const providerCredIdx = existingCreds.length;
    existingCreds.push(providerCred);
    setFixture(fMixed.config, ['spec', 'credentials'], existingCreds);
    const updatedEnvBindings = fMixed.registry.spec.environmentBindings.map(item =>
      item.name === 'PROVIDER_TOKEN'
        ? { ...item, paths: [`/spec/credentials/${String(providerCredIdx)}/template`] }
        : item,
    );
    setFixture(fMixed.registry, ['spec', 'environmentBindings'], updatedEnvBindings);
    setFixture(fMixed.registry, ['spec', 'roleProfiles'], [
      fMixed.registry.spec.roleProfiles[0]!,
      nativeProfile,
    ]);
    setFixture(fMixed.config, ['spec', 'task', 'spec', 'roles'], [
      fMixed.config.spec.task.spec.roles[0]!,
      nativeRole,
    ]);
    setFixture(fMixed.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'build', kind: 'agent', uses: 'package.patch', roleId: 'builder', dependsOn: [] },
      { id: 'review', kind: 'agent', uses: 'package.patch', roleId: 'reviewer', dependsOn: ['build'] },
      { id: 'bench-step', kind: 'check', uses: 'kernel-bench', roleId: null, dependsOn: ['review'] },
    ]);
    setFixture(fMixed.config, ['spec', 'profiles', 'roles'], [
      { roleId: 'builder', profileRef: 'builder' },
      { roleId: 'reviewer', profileRef: 'reviewer' },
    ]);
    setFixture(fMixed.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'build', handlerRef: 'package.patch' },
      { stepId: 'review', handlerRef: 'package.patch' },
      { stepId: 'bench-step', handlerRef: 'kernel-bench' },
    ]);
    await fMixed.save();
    const loadedMixed = assertOk(await fMixed.load());

    const mixedRunId = 'run-fp3-mixed-exec-refusal';
    const step1 = assertStepYield(
      assertOk(
        await stepNext({
          configuration: loadedMixed,
          repository: fMixed.repository,
          runRoot: fMixed.runRoot,
          runId: mixedRunId,
          environment: name => fMixed.environment[name],
        }),
      ),
    );
    await writeFile(join(step1.candidateDir, 'packages', 'helper.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await chmod(join(step1.candidateDir, 'packages', 'helper.sh'), 0o755);

    const submitted = await stepSubmit({
      runRoot: fMixed.runRoot,
      runId: mixedRunId,
      leaseToken: step1.leaseToken,
      status: 'completed',
      environment: name => fMixed.environment[name],
    });
    assert.equal(submitted.ok, true, submitted.ok ? '' : JSON.stringify(submitted.error));
    if (submitted.ok) {
      assert.equal(submitted.value.kind, 'result');
      if (submitted.value.kind === 'result') {
        assert.equal(
          submitted.value.result.spec.status,
          'blocked',
          'mixed-adapter handoff with non-baseline 100755 executable must fail closed before running native Pi',
        );
      }
    }
    assert.equal(mixedRelay.postRequests.length, 0, 'benchmark gate must never execute after refused native Pi handoff');
  } finally {
    await baseNative.cleanup();
    await fMixed.cleanup();
    await mixedRelay.close();
  }
});
