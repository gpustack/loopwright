import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { compilePlan, loadTrustedConfiguration, signPayload, verifySignedPayload } from '@loopwright/controller';
import { identifyManifest } from '@loopwright/core';
import { RUNNER_PROPOSAL_PATH, RUNNER_PROPOSAL_REQUIRED_FIELDS, compileRunnerTaskpack } from '../src/compile-taskpack.js';
import { PythonBridge } from '../src/python-bridge.js';
import {
  GATE_DRIVER,
  candidateEntriesFromRunArtifacts,
  computeRunnerCandidateDigest,
  startRunnerTaskpackService,
} from '../src/service.js';

const SECRET_VALUES: Record<string, string> = {
  RUNNER_PROVIDER_TOKEN: 'RUNNER_TEST_PROVIDER_TOKEN_VALUE',
  RUNNER_GATE_SIGNING_SECRET: 'RUNNER_TEST_GATE_SIGNING_SECRET_VALUE',
  RUNNER_PUBLICATION_SIGNING_SECRET: 'RUNNER_TEST_PUBLICATION_SIGNING_SECRET_VALUE',
};

async function withSandbox(run: (paths: { operator: string; task: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'taskpack-compile-'));
  const operator = join(root, 'operator');
  const task = join(root, 'task');
  await mkdir(operator, { mode: 0o700 });
  await mkdir(task, { mode: 0o700 });
  const previous: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(SECRET_VALUES)) {
    previous[name] = process.env[name];
    process.env[name] = value;
  }
  try {
    await run({ operator, task });
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function writeAndLoad(bundle: Awaited<ReturnType<typeof compileRunnerTaskpack>>, paths: { operator: string; task: string }) {
  const registryPath = join(paths.operator, 'registry.json');
  const configPath = join(paths.task, 'task.json');
  await writeFile(registryPath, bundle.registryBytes, { mode: 0o600 });
  await writeFile(configPath, JSON.stringify(bundle.config), { mode: 0o600 });
  return await loadTrustedConfiguration({ configPath, registryPath, registrySha256: bundle.registrySha256, untrustedRoots: [paths.task] });
}

describe('runner taskpack compiler', () => {
  const cleanups: Promise<void>[] = [];
  after(() => { return Promise.allSettled(cleanups); });

  it('produces a candidate bundle that loads and compiles against the installed controller', async () => {
    await withSandbox(async paths => {
      const bundle = await compileRunnerTaskpack({
        mode: 'candidate',
        repository: 'example-org/runtime-runner',
        baseRevision: 'b'.repeat(40),
        sourceRevision: 'c'.repeat(40),
        gateEndpoint: { id: 'runner-validation-gate', url: 'http://127.0.0.1:47001/gate', signingCredentialRef: 'runner-gate-signing' },
        publicationEndpoint: { id: 'runner-publication-endpoint', url: 'http://127.0.0.1:47002/publish', signingCredentialRef: 'runner-publication-signing' },
      });
      assert.equal(bundle.registrySha256.length, 64);
      const loaded = await writeAndLoad(bundle, paths);
      assert.equal(loaded.ok, true, JSON.stringify(loaded.ok ? [] : loaded.error).slice(0, 400));
      if (!loaded.ok) return;
      const compiled = await compilePlan(loaded.value);
      assert.equal(compiled.ok, true, JSON.stringify(compiled.ok ? [] : compiled.error).slice(0, 400));
      if (!compiled.ok) return;
      const plan = compiled.value;
      assert.equal(plan.publication.mode, 'pull_request');
      assert.equal(plan.orderedDAG.length, 3);
      assert.deepEqual(plan.orderedDAG.map(node => node.kind), ['agent', 'check', 'check']);
      const gateSlot = plan.verifierSlots.find(slot => slot.checkId === 'runner-candidate-validation');
      assert.ok(gateSlot, 'gate verifier slot missing');
      assert.equal(gateSlot.handler.implementation, 'gate.v1');
      assert.equal(plan.noChangeEligibility.available, false);
      const jsonCheck = plan.verifierSlots.find(slot => slot.checkId === 'runner-proposal-json');
      assert.ok(jsonCheck);
      if (jsonCheck) {
        assert.equal(jsonCheck.handler.parameters.path, RUNNER_PROPOSAL_PATH);
        assert.deepEqual(jsonCheck.handler.parameters.required, [...RUNNER_PROPOSAL_REQUIRED_FIELDS]);
      }
    });
  });

  it('produces a no-change bundle eligible for the no-change settlement', async () => {
    await withSandbox(async paths => {
      const bundle = await compileRunnerTaskpack({
        mode: 'no-change',
        repository: 'example-org/runtime-runner',
        baseRevision: 'b'.repeat(40),
        sourceRevision: 'c'.repeat(40),
        gateEndpoint: { id: 'runner-validation-gate', url: 'http://127.0.0.1:47003/gate', signingCredentialRef: 'runner-gate-signing' },
      });
      const loaded = await writeAndLoad(bundle, paths);
      assert.equal(loaded.ok, true, JSON.stringify(loaded.ok ? [] : loaded.error).slice(0, 400));
      if (!loaded.ok) return;
      const compiled = await compilePlan(loaded.value);
      assert.equal(compiled.ok, true, JSON.stringify(compiled.ok ? [] : compiled.error).slice(0, 400));
      if (!compiled.ok) return;
      const plan = compiled.value;
      assert.equal(plan.publication.mode, 'disabled');
      assert.equal(plan.noChangeEligibility.available, true);
      assert.equal(plan.noChangeEligibility.checkId, 'runner-no-change');
    });
  });

  it('keeps every signing secret inside credential bindings and out of compiled plans', async () => {
    await withSandbox(async paths => {
      const bundle = await compileRunnerTaskpack({
        mode: 'candidate',
        repository: 'example-org/runtime-runner',
        baseRevision: 'b'.repeat(40),
        sourceRevision: 'c'.repeat(40),
        gateEndpoint: { id: 'runner-validation-gate', url: 'http://127.0.0.1:47004/gate', signingCredentialRef: 'runner-gate-signing' },
        publicationEndpoint: { id: 'runner-publication-endpoint', url: 'http://127.0.0.1:47005/publish', signingCredentialRef: 'runner-publication-signing' },
      });
      const loaded = await writeAndLoad(bundle, paths);
      assert.equal(loaded.ok, true, JSON.stringify(loaded.ok ? [] : loaded.error).slice(0, 400));
      if (!loaded.ok) return;
      const compiled = await compilePlan(loaded.value);
      assert.equal(compiled.ok, true);
      if (!compiled.ok) return;
      const planText = JSON.stringify(compiled.value);
      for (const secret of Object.values(SECRET_VALUES)) assert.doesNotMatch(planText, new RegExp(secret.replaceAll(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')), 'secret material leaked into the compiled plan');
      const registryText = bundle.registryBytes.toString('utf8');
      for (const secret of Object.values(SECRET_VALUES)) assert.doesNotMatch(registryText, new RegExp(secret.replaceAll(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')), 'secret material leaked into the registry');
      const gateBinding = bundle.registry.spec.credentialBindings.find(binding => binding.id === 'runner-gate-signing');
      assert.ok(gateBinding);
      assert.equal(gateBinding.consumer, 'gate');
      assert.deepEqual(gateBinding.environmentNames, ['RUNNER_GATE_SIGNING_SECRET']);
      const loadedVaultReference = loaded.value.configuration.spec.credentials.find(entry => entry.ref === 'runner-gate-signing');
      assert.ok(loadedVaultReference);
      assert.equal(loadedVaultReference.template, '${RUNNER_GATE_SIGNING_SECRET}');
    });
  });

  it('rejects a candidate bundle whose publication endpoint is missing', async () => {
    await assert.rejects(compileRunnerTaskpack({
      mode: 'candidate',
      repository: 'example-org/runtime-runner',
      baseRevision: 'b'.repeat(40),
      sourceRevision: 'c'.repeat(40),
      gateEndpoint: { id: 'runner-validation-gate', url: 'http://127.0.0.1:47006/gate', signingCredentialRef: 'runner-gate-signing' },
    }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /publication endpoint/);
      return true;
    });
  });

  it('round-trips the registry digest so a tampered registry file refuses to load', async () => {
    await withSandbox(async paths => {
      const bundle = await compileRunnerTaskpack({
        mode: 'candidate',
        repository: 'example-org/runtime-runner',
        baseRevision: 'b'.repeat(40),
        sourceRevision: 'c'.repeat(40),
        gateEndpoint: { id: 'runner-validation-gate', url: 'http://127.0.0.1:47007/gate', signingCredentialRef: 'runner-gate-signing' },
        publicationEndpoint: { id: 'runner-publication-endpoint', url: 'http://127.0.0.1:47008/publish', signingCredentialRef: 'runner-publication-signing' },
      });
      const registryPath = join(paths.operator, 'registry.json');
      const configPath = join(paths.task, 'task.json');
      await writeFile(registryPath, bundle.registryBytes, { mode: 0o600 });
      await writeFile(configPath, JSON.stringify(bundle.config), { mode: 0o600 });
      const tampered = bundle.registryBytes.toString('utf8').replace('runner-candidate-validation', 'runner-tampered-validation');
      await writeFile(registryPath, tampered, { mode: 0o600 });
      const loaded = await loadTrustedConfiguration({ configPath, registryPath, registrySha256: bundle.registrySha256, untrustedRoots: [paths.task] });
      assert.equal(loaded.ok, false, 'tampered registry must refuse to load');
      cleanups.push(rm(join(paths.operator), { recursive: true, force: true }));
    });
  });

  it('signs and verifies payloads with the controller constant-time pair', () => {
    const body = Buffer.from(JSON.stringify({ probe: 'runner-signature' }));
    const signature = signPayload('RUNNER_TEST_GATE_SIGNING_SECRET_VALUE', body);
    assert.match(signature, /^[0-9a-f]{64}$/);
    assert.equal(verifySignedPayload('RUNNER_TEST_GATE_SIGNING_SECRET_VALUE', body, signature), true);
    assert.equal(verifySignedPayload('RUNNER_TEST_GATE_SIGNING_SECRET_VALUE', Buffer.from(JSON.stringify({ probe: 'runner-signature!' })), signature), false);
    assert.equal(verifySignedPayload('RUNNER_TEST_OTHER_SECRET_VALUE', body, signature), false);
    assert.equal(verifySignedPayload('RUNNER_TEST_GATE_SIGNING_SECRET_VALUE', body, 'sha256=' + signature), true);
  });
});

describe('authenticated loopback gate and publication service', () => {
  const GATE_SECRET = 'service-test-gate-secret';
  const PUBLICATION_SECRET = 'service-test-publication-secret';
  const services: { close(): Promise<void> }[] = [];
  const cleanupRoots: string[] = [];
  after(async () => {
    for (const service of services) await service.close().catch(() => undefined);
    for (const root of cleanupRoots) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  const SUPPORT_TABLE = '<!-- runner-support-records:start -->\n| Backend | Runtime | Service | Variant | Engine | Plugin | Platforms | Status |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| cuda | 13.0 | vllm | - | 0.29.0 | - | linux/amd64 | prepared |\n<!-- runner-support-records:end -->\n';
  const DOCKERFILE = 'ARG VLLM_VERSION=0.29.0\nARG CUDA_VERSION=13.0.1\nARG VLLM_BASE_IMAGE=vllm/vllm-openai:v${VLLM_VERSION}\nARG PYTHON_VERSION=3.12\nARG VLLM_LMCACHE_VERSION=0.5.4\nFROM ${VLLM_BASE_IMAGE} AS vllm\n';
  const MATRIX = 'rules:\n  - backend: cuda\n    services: [vllm]\n    platforms: [linux/amd64]\n    args: [VLLM_VERSION=0.29.0]\n';

  async function buildFixtureRepository(): Promise<{ path: string; headSha: string }> {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const root = await mkdtemp(join(await realpath(tmpdir()), 'runner-fixture-repo-'));
    await chmod(root, 0o700);
    const git = async (args: string[]) => {
      await run('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, env: { HOME: root, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } });
    };
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.name', 'Fixture']);
    await git(['config', 'user.email', 'fixture@example.invalid']);
    await mkdir(join(root, 'pack', 'cuda'), { recursive: true });
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'pack', 'cuda', 'Dockerfile.vllm'), DOCKERFILE);
    await writeFile(join(root, 'pack', 'matrix.yaml'), MATRIX);
    await writeFile(join(root, 'README.md'), '# Runner\n[Supported runners](docs/supported-runners.md)\n');
    await writeFile(join(root, 'docs', 'support-records.md'), SUPPORT_TABLE);
    await git(['add', '.']);
    await git(['commit', '-qm', 'fixture baseline']);
    const headSha = (await run('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
    cleanupRoots.push(root);
    return { path: root, headSha };
  }

  async function proposalFor(corpusRoot: string, headSha: string): Promise<string> {
    const raw = JSON.parse(await readFile(join(corpusRoot, 'tests', 'auto_sync', 'fixtures', 'proposals', 'ready.json'), 'utf8')) as { identity: Record<string, unknown> };
    raw.identity.default_sha = headSha;
    raw.identity.head_sha = headSha;
    return JSON.stringify(raw);
  }

  async function reviseProposalFor(corpusRoot: string, defaultSha: string, prHeadSha: string, prNumber: number, commandId: number, commandDigest: string): Promise<string> {
    const raw = JSON.parse(await readFile(join(corpusRoot, 'tests', 'auto_sync', 'fixtures', 'proposals', 'ready.json'), 'utf8')) as { identity: Record<string, unknown>; groups: Record<string, unknown>[] };
    raw.identity.default_sha = defaultSha;
    raw.identity.head_sha = prHeadSha;
    raw.identity.mode = 'revise';
    raw.identity.pr_number = prNumber;
    raw.identity.command_id = commandId;
    raw.identity.command_digest = commandDigest;
    const group = raw.groups[0]!;
    (group.rows as Record<string, unknown>[])[0]!.old_engine_version = '0.30.0';
    group.patch = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,2 +1,3 @@\n # Runner\n [Supported runners](docs/supported-runners.md)\n+Release report was reviewed.\n';
    return JSON.stringify(raw);
  }

  function gateRequest(candidateDigest: string): Record<string, unknown> {
    return {
      version: 1, kind: 'gate_request', gateId: 'runner-candidate-validation', checkId: 'runner-candidate-validation',
      candidateDigest, subject: { repository: 'example-org/runtime-runner', candidateDigest }, storeId: 'store-1', runId: 'run-1', lockHash: 'a'.repeat(64),
      operationId: 'op.1', dispatchId: 'dispatch-1', dispatchGeneration: 1, requestDigest: 'b'.repeat(64),
    };
  }

  function publishRequest(candidateDigest: string, idempotencyKey: string, headSha = 'a'.repeat(64)): Record<string, unknown> {
    return {
      version: 1, kind: 'publication_request', storeId: 'store-1', runId: 'run-1', lockHash: 'a'.repeat(64),
      operationId: 'publish.1', dispatchId: 'dispatch-2', dispatchGeneration: 1, idempotencyKey,
      targetBranch: 'main', headBranch: 'loopwright-runner-run-1', title: 'runner: sync upstream runtime support',
      candidateDigest, baseRevision: headSha, sourceRevision: headSha, requestDigest: 'c'.repeat(64),
    };
  }

  async function post(url: string, secret: string, body: Record<string, unknown>): Promise<{ status: number; bytes: Buffer; signature: string | null }> {
    const payload = Buffer.from(JSON.stringify(body));
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-loopwright-signature': signPayload(secret, payload) }, body: new Uint8Array(payload) });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, bytes, signature: response.headers.get('x-loopwright-signature') };
  }

  it('authenticates both directions and approves a registered candidate through frozen validators', async () => {
    const { defaultCorpusRoot } = await import('../src/corpus.js');
    const corpusRoot = defaultCorpusRoot();
    if (corpusRoot === null) throw new Error('vendored corpus absent');
    const fixture = await buildFixtureRepository();
    const service = await startRunnerTaskpackService({ gateSecret: GATE_SECRET, publicationSecret: PUBLICATION_SECRET, corpusRoot,  });
    services.push(service);
    const candidateDigest = (await computeRunnerCandidateDigest({ repositorySnapshot: fixture.path, headSha: fixture.headSha, proposalJson: await proposalFor(corpusRoot, fixture.headSha) })).digest;
    await service.registerCandidate({
      storeId: 'store-1', runId: 'run-1', candidateDigest,
      proposalJson: await proposalFor(corpusRoot, fixture.headSha),
      identity: { repository: 'example-org/runtime-runner', defaultSha: fixture.headSha, headSha: fixture.headSha, mode: 'discover', prNumber: null, commandId: null, commandDigest: null },
      repositorySnapshot: fixture.path, upstreamSources: {}, ascendPairs: {}, enginePrereleases: [], prereleasePackages: [],
    });
    const unsigned = await fetch(service.gateUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(gateRequest(candidateDigest)) });
    assert.equal(unsigned.status, 403, 'unsigned gate request must be refused');
    const approved = await post(service.gateUrl, GATE_SECRET, gateRequest(candidateDigest));
    assert.equal(approved.status, 200);
    assert.ok(approved.signature !== null && verifySignedPayload(GATE_SECRET, approved.bytes, approved.signature), 'verdict signature must verify');
    const verdict = JSON.parse(approved.bytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(verdict.kind, 'gate_verdict');
    assert.equal(verdict.status, 'approved', String(verdict.reason));
    assert.equal(verdict.gateId, 'runner-candidate-validation');
    assert.equal(verdict.candidateDigest, candidateDigest);
    const expiresAtMs = BigInt(String(verdict.expiresAtMs));
    const now = BigInt(Date.now());
    assert.ok(expiresAtMs >= now && expiresAtMs <= now + 86400000n, 'approved verdict must expire within 24 hours');
  });

  it('denies an unregistered candidate and a malformed proposal with bounded reasons', async () => {
    const { defaultCorpusRoot } = await import('../src/corpus.js');
    const corpusRoot = defaultCorpusRoot();
    if (corpusRoot === null) throw new Error('vendored corpus absent');
    const fixture = await buildFixtureRepository();
    const service = await startRunnerTaskpackService({ gateSecret: GATE_SECRET, publicationSecret: PUBLICATION_SECRET, corpusRoot,  });
    services.push(service);
    const unregistered = await post(service.gateUrl, GATE_SECRET, gateRequest('e'.repeat(64)));
    assert.equal(unregistered.status, 200);
    const unregisteredVerdict = JSON.parse(unregistered.bytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(unregisteredVerdict.status, 'denied');
    assert.match(String(unregisteredVerdict.reason), /candidate not registered/);
    const candidateDigest = (await computeRunnerCandidateDigest({ repositorySnapshot: fixture.path, headSha: fixture.headSha, proposalJson: JSON.stringify({ broken: true }) })).digest;
    await service.registerCandidate({
      storeId: 'store-1', runId: 'run-1', candidateDigest,
      proposalJson: JSON.stringify({ broken: true }),
      identity: { repository: 'example-org/runtime-runner', defaultSha: fixture.headSha, headSha: fixture.headSha, mode: 'discover', prNumber: null, commandId: null, commandDigest: null },
      repositorySnapshot: fixture.path, upstreamSources: {}, ascendPairs: {}, enginePrereleases: [], prereleasePackages: [],
    });
    const denied = await post(service.gateUrl, GATE_SECRET, gateRequest(candidateDigest));
    assert.equal(denied.status, 200);
    const deniedVerdict = JSON.parse(denied.bytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(deniedVerdict.status, 'denied');
    assert.ok(String(deniedVerdict.reason).length <= 256, 'denied reason must stay within the wire bound');
    assert.match(String(deniedVerdict.reason), /invalid|Proposal|proposal|fields/i);
  });

  it('denies a schema-valid proposal whose groups all fail candidate validation with zero accepted groups', { timeout: 120000 }, async () => {
    const { defaultCorpusRoot } = await import('../src/corpus.js');
    const corpusRoot = defaultCorpusRoot();
    if (corpusRoot === null) throw new Error('vendored corpus absent');
    const fixture = await buildFixtureRepository();
    const service = await startRunnerTaskpackService({ gateSecret: GATE_SECRET, publicationSecret: PUBLICATION_SECRET, corpusRoot, });
    services.push(service);
    const zeroRaw = JSON.parse(await readFile(join(corpusRoot, 'tests', 'auto_sync', 'fixtures', 'proposals', 'ready.json'), 'utf8')) as { identity: Record<string, unknown>; groups: Record<string, unknown>[] };
    zeroRaw.identity.default_sha = fixture.headSha;
    zeroRaw.identity.head_sha = fixture.headSha;
    (zeroRaw.groups[0]!.rows as Record<string, unknown>[])[0]!.old_engine_version = '0.30.0';
    const zeroProposal = JSON.stringify(zeroRaw);
    const candidateDigest = (await computeRunnerCandidateDigest({ repositorySnapshot: fixture.path, headSha: fixture.headSha, proposalJson: zeroProposal })).digest;
    await service.registerCandidate({
      storeId: 'store-1', runId: 'run-1', candidateDigest,
      proposalJson: zeroProposal,
      identity: { repository: 'example-org/runtime-runner', defaultSha: fixture.headSha, headSha: fixture.headSha, mode: 'discover', prNumber: null, commandId: null, commandDigest: null },
      repositorySnapshot: fixture.path, upstreamSources: {}, ascendPairs: {}, enginePrereleases: [], prereleasePackages: [],
    });
    const denied = await post(service.gateUrl, GATE_SECRET, gateRequest(candidateDigest));
    assert.equal(denied.status, 200);
    const verdict = JSON.parse(denied.bytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(verdict.status, 'denied');
    assert.match(String(verdict.reason), /zero accepted groups/);
  });

  it('publishes a gate-verified candidate to the service double and replays idempotently', { timeout: 240000 }, async () => {
    const { defaultCorpusRoot } = await import('../src/corpus.js');
    const corpusRoot = defaultCorpusRoot();
    if (corpusRoot === null) throw new Error('vendored corpus absent');
    const fixture = await buildFixtureRepository();
    const service = await startRunnerTaskpackService({ gateSecret: GATE_SECRET, publicationSecret: PUBLICATION_SECRET, corpusRoot,  });
    services.push(service);
    const candidateDigest = (await computeRunnerCandidateDigest({ repositorySnapshot: fixture.path, headSha: fixture.headSha, proposalJson: await proposalFor(corpusRoot, fixture.headSha) })).digest;
    await service.registerCandidate({
      storeId: 'store-1', runId: 'run-1', candidateDigest,
      proposalJson: await proposalFor(corpusRoot, fixture.headSha),
      identity: { repository: 'example-org/runtime-runner', defaultSha: fixture.headSha, headSha: fixture.headSha, mode: 'discover', prNumber: null, commandId: null, commandDigest: null },
      repositorySnapshot: fixture.path, upstreamSources: {}, ascendPairs: {}, enginePrereleases: [], prereleasePackages: [],
    });
    const request = publishRequest(candidateDigest, 'pub.key-1', fixture.headSha);
    const gate = await post(service.gateUrl, GATE_SECRET, gateRequest(candidateDigest));
    assert.equal((JSON.parse(gate.bytes.toString('utf8')) as Record<string, unknown>).status, 'approved', 'publish requires a gate-approved candidate first');
    const before = await post(service.publicationUrl, PUBLICATION_SECRET, request);
    assert.equal(before.status, 200);
    const receipt = JSON.parse(before.bytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(receipt.kind, 'publication_receipt');
    assert.equal(receipt.outcome, 'succeeded', String(receipt.reason));
    assert.ok(typeof receipt.externalUrl === 'string' && receipt.externalUrl.length > 0, 'succeeded receipt carries the pull request url');
    assert.ok(before.signature !== null && verifySignedPayload(PUBLICATION_SECRET, before.bytes, before.signature));
    const replay = await post(service.publicationUrl, PUBLICATION_SECRET, request);
    assert.deepEqual(replay.bytes, before.bytes, 'replayed publication must return the identical signed receipt');
    const foreign = { ...publishRequest('9'.repeat(64), 'pub.key-1', fixture.headSha), requestDigest: 'd'.repeat(64) };
    const refused = await post(service.publicationUrl, PUBLICATION_SECRET, foreign);
    assert.equal(refused.status, 400, 'same idempotency key with a different binding must refuse');
  });

  it('refuses publication when the snapshot head moved past the bound revisions', { timeout: 240000 }, async () => {
    const { defaultCorpusRoot, } = await import('../src/corpus.js');
    const corpusRoot = defaultCorpusRoot();
    if (corpusRoot === null) throw new Error('vendored corpus absent');
    const fixture = await buildFixtureRepository();
    const service = await startRunnerTaskpackService({ gateSecret: GATE_SECRET, publicationSecret: PUBLICATION_SECRET, corpusRoot,  });
    services.push(service);
    const candidateDigest = (await computeRunnerCandidateDigest({ repositorySnapshot: fixture.path, headSha: fixture.headSha, proposalJson: await proposalFor(corpusRoot, fixture.headSha) })).digest;
    await service.registerCandidate({
      storeId: 'store-1', runId: 'run-1', candidateDigest,
      proposalJson: await proposalFor(corpusRoot, fixture.headSha),
      identity: { repository: 'example-org/runtime-runner', defaultSha: fixture.headSha, headSha: fixture.headSha, mode: 'discover', prNumber: null, commandId: null, commandDigest: null },
      repositorySnapshot: fixture.path, upstreamSources: {}, ascendPairs: {}, enginePrereleases: [], prereleasePackages: [],
    });
    const approved = await post(service.gateUrl, GATE_SECRET, gateRequest(candidateDigest));
    assert.equal((JSON.parse(approved.bytes.toString('utf8')) as Record<string, unknown>).status, 'approved');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'human commit lands during the run'], { cwd: fixture.path, env: { HOME: fixture.path, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } });
    const request = publishRequest(candidateDigest, 'pub.key-2', fixture.headSha);
    const receipt = await post(service.publicationUrl, PUBLICATION_SECRET, request);
    assert.equal(receipt.status, 200);
    const document = JSON.parse(receipt.bytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(document.outcome, 'not_executed', String(document.reason));
    assert.match(String(document.reason), /head_changed_before_publish/);
    const state = await service.deriveOperatorReceipt({ storeId: 'store-1', runId: 'run-1', operationId: 'publish.1', dispatchId: 'dispatch-2', dispatchGeneration: 1, idempotencyKey: 'pub.key-2', candidateDigest });
    assert.ok(state !== null && state.signature !== null);
    const derived = JSON.parse(state.bytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(derived.outcome, 'not_executed', 'no pull request may exist after a refused publication');
  });

  it('refuses revise publication when the managed PR head moved past the bound head', { timeout: 240000 }, async () => {
    const { defaultCorpusRoot } = await import('../src/corpus.js');
    const corpusRoot = defaultCorpusRoot();
    if (corpusRoot === null) throw new Error('vendored corpus absent');
    const fixture = await buildFixtureRepository();
    const service = await startRunnerTaskpackService({ gateSecret: GATE_SECRET, publicationSecret: PUBLICATION_SECRET, corpusRoot, fakeRepositorySnapshot: fixture.path });
    services.push(service);
    const guidance = '/auto-sync\nPlease refine the report.';
    const commandDigest = (await import('node:crypto')).createHash('sha256').update(Buffer.from(guidance, 'utf8')).digest('hex');
    // Land the initial discover candidate first so the managed PR #1 exists.
    const candidateDigest = (await computeRunnerCandidateDigest({ repositorySnapshot: fixture.path, headSha: fixture.headSha, proposalJson: await proposalFor(corpusRoot, fixture.headSha) })).digest;
    await service.registerCandidate({
      storeId: 'store-1', runId: 'run-1', candidateDigest,
      proposalJson: await proposalFor(corpusRoot, fixture.headSha),
      identity: { repository: 'example-org/runtime-runner', defaultSha: fixture.headSha, headSha: fixture.headSha, mode: 'discover', prNumber: null, commandId: null, commandDigest: null },
      repositorySnapshot: fixture.path, upstreamSources: {}, ascendPairs: {}, enginePrereleases: [], prereleasePackages: [],
    });
    const gate = await post(service.gateUrl, GATE_SECRET, gateRequest(candidateDigest));
    assert.equal((JSON.parse(gate.bytes.toString('utf8')) as Record<string, unknown>).status, 'approved');
    const initial = await post(service.publicationUrl, PUBLICATION_SECRET, publishRequest(candidateDigest, 'pub.revise-initial', fixture.headSha));
    const initialReceipt = JSON.parse(initial.bytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(initialReceipt.outcome, 'succeeded', String(initialReceipt.reason));
    assert.equal(await service.fakePullCount(), 1);
    const prHead = await service.fakePullHeadSha(1);
    assert.ok(prHead !== null);
    // Register and gate-approve the authorized revise proposal bound to the current PR head.
    const reviseProposal = await reviseProposalFor(corpusRoot, fixture.headSha, prHead, 1, 99, commandDigest);
    const reviseDigest = (await computeRunnerCandidateDigest({ repositorySnapshot: fixture.path, headSha: fixture.headSha, proposalJson: reviseProposal })).digest;
    await service.registerCandidate({
      storeId: 'store-1', runId: 'run-revise-head', candidateDigest: reviseDigest,
      proposalJson: reviseProposal,
      identity: { repository: 'example-org/runtime-runner', defaultSha: fixture.headSha, headSha: fixture.headSha, mode: 'revise', prNumber: 1, commandId: 99, commandDigest, prHeadSha: prHead },
      repositorySnapshot: fixture.path, upstreamSources: {}, ascendPairs: {}, enginePrereleases: [], prereleasePackages: [],
      reviseCommentBody: guidance,
    });
    const reviseGate = await post(service.gateUrl, GATE_SECRET, { ...gateRequest(reviseDigest), runId: 'run-revise-head' });
    assert.equal((JSON.parse(reviseGate.bytes.toString('utf8')) as Record<string, unknown>).status, 'approved');
    // A human commit moves the PR head while the PR stays open.
    await service.fakeHumanCommit('README.md', '# Human edit on PR branch\n');
    const request = { ...publishRequest(reviseDigest, 'pub.revise-head', fixture.headSha), runId: 'run-revise-head' };
    const receipt = await post(service.publicationUrl, PUBLICATION_SECRET, request);
    assert.equal(receipt.status, 200);
    const document = JSON.parse(receipt.bytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(document.outcome, 'not_executed');
    assert.match(String(document.reason), /^revise_head_changed: managed pull request head /);
  });

  it('reports duplicate_command_id when a revise command is re-applied to the managed PR', { timeout: 300000 }, async () => {
    const { defaultCorpusRoot } = await import('../src/corpus.js');
    const corpusRoot = defaultCorpusRoot();
    if (corpusRoot === null) throw new Error('vendored corpus absent');
    const fixture = await buildFixtureRepository();
    const service = await startRunnerTaskpackService({ gateSecret: GATE_SECRET, publicationSecret: PUBLICATION_SECRET, corpusRoot, fakeRepositorySnapshot: fixture.path });
    services.push(service);
    const guidance = '/auto-sync\nPlease refine the report for the selected engine.';
    const commandDigest = (await import('node:crypto')).createHash('sha256').update(Buffer.from(guidance, 'utf8')).digest('hex');
    // Land the initial discover candidate first so the managed PR #1 exists.
    const candidateDigest = (await computeRunnerCandidateDigest({ repositorySnapshot: fixture.path, headSha: fixture.headSha, proposalJson: await proposalFor(corpusRoot, fixture.headSha) })).digest;
    await service.registerCandidate({
      storeId: 'store-1', runId: 'run-1', candidateDigest,
      proposalJson: await proposalFor(corpusRoot, fixture.headSha),
      identity: { repository: 'example-org/runtime-runner', defaultSha: fixture.headSha, headSha: fixture.headSha, mode: 'discover', prNumber: null, commandId: null, commandDigest: null },
      repositorySnapshot: fixture.path, upstreamSources: {}, ascendPairs: {}, enginePrereleases: [], prereleasePackages: [],
    });
    const gate = await post(service.gateUrl, GATE_SECRET, gateRequest(candidateDigest));
    assert.equal((JSON.parse(gate.bytes.toString('utf8')) as Record<string, unknown>).status, 'approved');
    const initial = await post(service.publicationUrl, PUBLICATION_SECRET, publishRequest(candidateDigest, 'pub.revise-initial', fixture.headSha));
    const initialReceipt = JSON.parse(initial.bytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(initialReceipt.outcome, 'succeeded', String(initialReceipt.reason));
    assert.equal(await service.fakePullCount(), 1);
    const prHead = await service.fakePullHeadSha(1);
    assert.ok(prHead !== null);
    // The first revise application for command 100 succeeds and moves the PR head.
    const reviseProposal = await reviseProposalFor(corpusRoot, fixture.headSha, prHead, 1, 100, commandDigest);
    const reviseDigest = (await computeRunnerCandidateDigest({ repositorySnapshot: fixture.path, headSha: fixture.headSha, proposalJson: reviseProposal })).digest;
    await service.registerCandidate({
      storeId: 'store-1', runId: 'run-revise-dup', candidateDigest: reviseDigest,
      proposalJson: reviseProposal,
      identity: { repository: 'example-org/runtime-runner', defaultSha: fixture.headSha, headSha: fixture.headSha, mode: 'revise', prNumber: 1, commandId: 100, commandDigest, prHeadSha: prHead },
      repositorySnapshot: fixture.path, upstreamSources: {}, ascendPairs: {}, enginePrereleases: [], prereleasePackages: [],
      reviseCommentBody: guidance,
    });
    const reviseGate = await post(service.gateUrl, GATE_SECRET, { ...gateRequest(reviseDigest), runId: 'run-revise-dup' });
    assert.equal((JSON.parse(reviseGate.bytes.toString('utf8')) as Record<string, unknown>).status, 'approved');
    const firstRevise = await post(service.publicationUrl, PUBLICATION_SECRET, { ...publishRequest(reviseDigest, 'pub.revise-first', fixture.headSha), runId: 'run-revise-dup' });
    const firstReviseReceipt = JSON.parse(firstRevise.bytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(firstReviseReceipt.outcome, 'succeeded', String(firstReviseReceipt.reason));
    const newPrHead = await service.fakePullHeadSha(1);
    assert.ok(newPrHead !== null);
    assert.notEqual(newPrHead, prHead);
    // Rebinding the same command to the moved head must surface the frozen duplicate-command record.
    await service.registerCandidate({
      storeId: 'store-1', runId: 'run-revise-dup', candidateDigest: reviseDigest,
      proposalJson: reviseProposal,
      identity: { repository: 'example-org/runtime-runner', defaultSha: fixture.headSha, headSha: fixture.headSha, mode: 'revise', prNumber: 1, commandId: 100, commandDigest, prHeadSha: newPrHead },
      repositorySnapshot: fixture.path, upstreamSources: {}, ascendPairs: {}, enginePrereleases: [], prereleasePackages: [],
      reviseCommentBody: guidance,
    });
    const secondRevise = await post(service.publicationUrl, PUBLICATION_SECRET, { ...publishRequest(reviseDigest, 'pub.revise-second', fixture.headSha), runId: 'run-revise-dup', requestDigest: 'f'.repeat(64) });
    const secondReviseReceipt = JSON.parse(secondRevise.bytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(secondReviseReceipt.outcome, 'not_executed');
    assert.match(String(secondReviseReceipt.reason), /^duplicate_command_id:/);
    assert.equal(await service.fakePullCount(), 1, 'exactly one managed PR');
  });

  it('drops the publication response after the write and derives an authenticated operator receipt', { timeout: 240000 }, async () => {
    const { defaultCorpusRoot } = await import('../src/corpus.js');
    const corpusRoot = defaultCorpusRoot();
    if (corpusRoot === null) throw new Error('vendored corpus absent');
    const fixture = await buildFixtureRepository();
    const service = await startRunnerTaskpackService({ gateSecret: GATE_SECRET, publicationSecret: PUBLICATION_SECRET, corpusRoot, publicationChaos: "drop_after_write" });
    services.push(service);
    const candidateDigest = (await computeRunnerCandidateDigest({ repositorySnapshot: fixture.path, headSha: fixture.headSha, proposalJson: await proposalFor(corpusRoot, fixture.headSha) })).digest;
    await service.registerCandidate({
      storeId: 'store-1', runId: 'run-1', candidateDigest,
      proposalJson: await proposalFor(corpusRoot, fixture.headSha),
      identity: { repository: 'example-org/runtime-runner', defaultSha: fixture.headSha, headSha: fixture.headSha, mode: 'discover', prNumber: null, commandId: null, commandDigest: null },
      repositorySnapshot: fixture.path, upstreamSources: {}, ascendPairs: {}, enginePrereleases: [], prereleasePackages: [],
    });
    const approved = await post(service.gateUrl, GATE_SECRET, gateRequest(candidateDigest));
    assert.equal((JSON.parse(approved.bytes.toString('utf8')) as Record<string, unknown>).status, 'approved');
    await assert.rejects(post(service.publicationUrl, PUBLICATION_SECRET, publishRequest(candidateDigest, 'pub.key-3', fixture.headSha)), /terminated|ECONNRESET|socket|fetch failed/i, 'publication response must be dropped after the write');
    const derived = await service.deriveOperatorReceipt({ storeId: 'store-1', runId: 'run-1', operationId: 'publish.1', dispatchId: 'dispatch-2', dispatchGeneration: 1, idempotencyKey: 'pub.key-3', candidateDigest });
    assert.ok(derived !== null);
    const derivedDoc = JSON.parse(derived.bytes.toString('utf8')) as Record<string, unknown>;
    const { signature: _derivedSignature, ...derivedBody } = derivedDoc;
    void _derivedSignature;
    const canonicalOf = (value: unknown): string => {
      if (value === null || typeof value !== 'object') return JSON.stringify(value);
      if (Array.isArray(value)) return '[' + value.map(canonicalOf).join(',') + ']';
      const record = value as Record<string, unknown>;
      return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonicalOf(record[key])).join(',') + '}';
    };
    assert.ok(verifySignedPayload(PUBLICATION_SECRET, Buffer.from(canonicalOf(derivedBody)), derived.signature), 'operator receipt must verify with the publication secret');
    const document = JSON.parse(derived.bytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(document.outcome, 'succeeded');
    assert.equal(document.candidateDigest, candidateDigest);
    assert.ok(typeof document.externalUrl === 'string' && (document.externalUrl as string).length > 0);
  });

  it('verifies v2 blob_ref checkpoints with >1 MiB overlays via pointer-index GATE_DRIVER, preserves v1 chunk compatibility, and refuses tampered or malformed CAS rows', { timeout: 240000 }, async () => {
    const { defaultCorpusRoot } = await import('../src/corpus.js');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const corpusRoot = defaultCorpusRoot();
    if (corpusRoot === null) throw new Error('vendored corpus absent');
    const fixture = await buildFixtureRepository();
    const treeOid = (await run('/usr/bin/git', ['rev-parse', 'HEAD^{tree}'], { cwd: fixture.path })).stdout.trim();
    const baseTree = { objectFormat: 'sha1' as const, commitOid: fixture.headSha, treeOid };
    const service = await startRunnerTaskpackService({ gateSecret: GATE_SECRET, publicationSecret: PUBLICATION_SECRET, corpusRoot });
    services.push(service);

    const runRoot = await mkdtemp(join(await realpath(tmpdir()), 'runner-v2-cas-runs-'));
    await chmod(runRoot, 0o700);
    cleanupRoots.push(runRoot);

    const proposalText = await proposalFor(corpusRoot, fixture.headSha);
    const proposalBuf = Buffer.from(proposalText, 'utf8');
    // 4 MiB deterministic binary payload exceeds PythonBridge's 1 MiB stdin limit if inlined as base64.
    const largeBinary = Buffer.alloc(4 * 1024 * 1024, 0x5a);
    largeBinary.write('LARGE_CAS_BLOB_HEADER', 0, 'utf8');
    largeBinary.write('LARGE_CAS_BLOB_FOOTER', largeBinary.byteLength - 21, 'utf8');

    const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
    const proposalSha = sha(proposalBuf);
    const largeSha = sha(largeBinary);

    const entries = [
      { name: '.autosync/proposal.json', digest: { algorithm: 'sha256' as const, hex: proposalSha }, byteLength: proposalBuf.byteLength },
      { name: 'pack/large-asset.bin', digest: { algorithm: 'sha256' as const, hex: largeSha }, byteLength: largeBinary.byteLength },
    ];
    const overlay = { maxFiles: 128, maxBytes: 16_777_216 };
    const identified = identifyManifest(
      { apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { baseTree, entries, deleted: [] } },
      { overlay },
    );
    assert.equal(identified.ok, true);
    if (!identified.ok) throw new Error('manifest failed');
    const v2Digest = identified.value.digest.hex;

    const writeV2Run = async (runId: string, mutate?: (dirs: { blobsDir: string; ndjsonPath: string }) => Promise<void>) => {
      const artifactsDir = join(runRoot, runId, 'artifacts');
      const checkpointsDir = join(artifactsDir, 'pi-checkpoints');
      const blobsDir = join(artifactsDir, 'blobs', 'sha256');
      await mkdir(checkpointsDir, { recursive: true, mode: 0o700 });
      await mkdir(blobsDir, { recursive: true, mode: 0o700 });
      const propBlobPath = join(blobsDir, proposalSha);
      const largeBlobPath = join(blobsDir, largeSha);
      await writeFile(propBlobPath, proposalBuf, { mode: 0o600 });
      await chmod(propBlobPath, 0o400);
      await writeFile(largeBlobPath, largeBinary, { mode: 0o600 });
      await chmod(largeBlobPath, 0o400);

      const rows: string[] = [
        JSON.stringify({ type: 'workspace_snapshot', version: 1, manifest: identified.value.manifest }),
      ];
      for (const entry of entries) {
        rows.push(JSON.stringify({ type: 'file', ref: entry }));
        rows.push(JSON.stringify({
          type: 'blob_ref',
          ref: entry,
          blobRef: { ...entry, uri: `cas://sha256/${entry.digest.hex}` },
        }));
        rows.push(JSON.stringify({ type: 'file_end', byteLength: entry.byteLength, digest: entry.digest.hex }));
      }
      rows.push(JSON.stringify({ type: 'end', files: entries.length }));
      const ndjsonPath = join(checkpointsDir, 'ckpt-1.workspace.ndjson');
      await writeFile(ndjsonPath, rows.join('\n') + '\n', { mode: 0o600 });
      if (mutate) await mutate({ blobsDir, ndjsonPath });
    };

    // 1. Valid v2 blob_ref checkpoint with 4 MiB asset succeeds via pointer-index GATE_DRIVER.
    await writeV2Run('run-v2-large');
    await service.registerCandidate({
      storeId: 'store-1', runId: 'run-v2-large', candidateDigest: v2Digest,
      identity: { repository: 'example-org/runtime-runner', defaultSha: fixture.headSha, headSha: fixture.headSha, mode: 'discover', prNumber: null, commandId: null, commandDigest: null },
      repositorySnapshot: fixture.path, upstreamSources: {}, ascendPairs: {}, enginePrereleases: [], prereleasePackages: [],
      runRoot, overlay,
    });
    const okRes = await post(service.gateUrl, GATE_SECRET, { ...gateRequest(v2Digest), runId: 'run-v2-large' });
    assert.equal(okRes.status, 200);
    const okVerdict = JSON.parse(okRes.bytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(okVerdict.status, 'approved', String(okVerdict.reason));

    // 2. Tampered CAS blob bytes must be refused.
    await writeV2Run('run-v2-tampered', async ({ blobsDir }) => {
      const target = join(blobsDir, largeSha);
      await chmod(target, 0o600);
      const tampered = Buffer.from(largeBinary);
      tampered[tampered.byteLength - 1] = (tampered[tampered.byteLength - 1] ?? 0) ^ 0xff;
      await writeFile(target, tampered);
      await chmod(target, 0o400);
    });
    await service.registerCandidate({
      storeId: 'store-1', runId: 'run-v2-tampered', candidateDigest: v2Digest,
      identity: { repository: 'example-org/runtime-runner', defaultSha: fixture.headSha, headSha: fixture.headSha, mode: 'discover', prNumber: null, commandId: null, commandDigest: null },
      repositorySnapshot: fixture.path, upstreamSources: {}, ascendPairs: {}, enginePrereleases: [], prereleasePackages: [],
      runRoot, overlay,
    });
    const tamperedRes = await post(service.gateUrl, GATE_SECRET, { ...gateRequest(v2Digest), runId: 'run-v2-tampered' });
    assert.equal(tamperedRes.status, 200);
    assert.equal((JSON.parse(tamperedRes.bytes.toString('utf8')) as Record<string, unknown>).status, 'denied');

    // 2b. Writable CAS blob (mode & 0o222 !== 0) must be refused.
    await writeV2Run('run-v2-writable', async ({ blobsDir }) => {
      await chmod(join(blobsDir, largeSha), 0o600);
    });
    await service.registerCandidate({
      storeId: 'store-1', runId: 'run-v2-writable', candidateDigest: v2Digest,
      identity: { repository: 'example-org/runtime-runner', defaultSha: fixture.headSha, headSha: fixture.headSha, mode: 'discover', prNumber: null, commandId: null, commandDigest: null },
      repositorySnapshot: fixture.path, upstreamSources: {}, ascendPairs: {}, enginePrereleases: [], prereleasePackages: [],
      runRoot, overlay,
    });
    const writableRes = await post(service.gateUrl, GATE_SECRET, { ...gateRequest(v2Digest), runId: 'run-v2-writable' });
    assert.equal(writableRes.status, 200);
    assert.equal((JSON.parse(writableRes.bytes.toString('utf8')) as Record<string, unknown>).status, 'denied');

    // 3. Hardlinked CAS blob (nlink > 1) must be refused.
    await writeV2Run('run-v2-hardlink', async ({ blobsDir }) => {
      await link(join(blobsDir, largeSha), join(blobsDir, 'extra-hardlink'));
    });
    await service.registerCandidate({
      storeId: 'store-1', runId: 'run-v2-hardlink', candidateDigest: v2Digest,
      identity: { repository: 'example-org/runtime-runner', defaultSha: fixture.headSha, headSha: fixture.headSha, mode: 'discover', prNumber: null, commandId: null, commandDigest: null },
      repositorySnapshot: fixture.path, upstreamSources: {}, ascendPairs: {}, enginePrereleases: [], prereleasePackages: [],
      runRoot, overlay,
    });
    const hardlinkRes = await post(service.gateUrl, GATE_SECRET, { ...gateRequest(v2Digest), runId: 'run-v2-hardlink' });
    assert.equal(hardlinkRes.status, 200);
    assert.equal((JSON.parse(hardlinkRes.bytes.toString('utf8')) as Record<string, unknown>).status, 'denied');

    // 4. Mixed blob_ref + chunk rows and duplicate blob_ref rows must be refused.
    await writeV2Run('run-v2-mixed', async ({ ndjsonPath }) => {
      const mixedRows = [
        JSON.stringify({ type: 'workspace_snapshot', version: 1, manifest: identified.value.manifest }),
        JSON.stringify({ type: 'file', ref: entries[0] }),
        JSON.stringify({ type: 'blob_ref', ref: entries[0], blobRef: { ...entries[0], uri: `cas://sha256/${proposalSha}` } }),
        JSON.stringify({ type: 'file_end', byteLength: proposalBuf.byteLength, digest: proposalSha }),
        JSON.stringify({ type: 'file', ref: entries[1] }),
        JSON.stringify({ type: 'chunk', index: 0, data: largeBinary.toString('base64') }),
        JSON.stringify({ type: 'file_end', byteLength: largeBinary.byteLength, digest: largeSha }),
        JSON.stringify({ type: 'end', files: 2 }),
      ];
      await writeFile(ndjsonPath, mixedRows.join('\n') + '\n', { mode: 0o600 });
    });
    await service.registerCandidate({
      storeId: 'store-1', runId: 'run-v2-mixed', candidateDigest: v2Digest,
      identity: { repository: 'example-org/runtime-runner', defaultSha: fixture.headSha, headSha: fixture.headSha, mode: 'discover', prNumber: null, commandId: null, commandDigest: null },
      repositorySnapshot: fixture.path, upstreamSources: {}, ascendPairs: {}, enginePrereleases: [], prereleasePackages: [],
      runRoot, overlay,
    });
    const mixedRes = await post(service.gateUrl, GATE_SECRET, { ...gateRequest(v2Digest), runId: 'run-v2-mixed' });
    assert.equal(mixedRes.status, 200);
    assert.equal((JSON.parse(mixedRes.bytes.toString('utf8')) as Record<string, unknown>).status, 'denied');

    await writeV2Run('run-v2-dup', async ({ ndjsonPath }) => {
      const dupRows = [
        JSON.stringify({ type: 'workspace_snapshot', version: 1, manifest: identified.value.manifest }),
        JSON.stringify({ type: 'file', ref: entries[0] }),
        JSON.stringify({ type: 'blob_ref', ref: entries[0], blobRef: { ...entries[0], uri: `cas://sha256/${proposalSha}` } }),
        JSON.stringify({ type: 'blob_ref', ref: entries[0], blobRef: { ...entries[0], uri: `cas://sha256/${proposalSha}` } }),
        JSON.stringify({ type: 'file_end', byteLength: proposalBuf.byteLength, digest: proposalSha }),
        JSON.stringify({ type: 'file', ref: entries[1] }),
        JSON.stringify({ type: 'blob_ref', ref: entries[1], blobRef: { ...entries[1], uri: `cas://sha256/${largeSha}` } }),
        JSON.stringify({ type: 'file_end', byteLength: largeBinary.byteLength, digest: largeSha }),
        JSON.stringify({ type: 'end', files: 2 }),
      ];
      await writeFile(ndjsonPath, dupRows.join('\n') + '\n', { mode: 0o600 });
    });
    await service.registerCandidate({
      storeId: 'store-1', runId: 'run-v2-dup', candidateDigest: v2Digest,
      identity: { repository: 'example-org/runtime-runner', defaultSha: fixture.headSha, headSha: fixture.headSha, mode: 'discover', prNumber: null, commandId: null, commandDigest: null },
      repositorySnapshot: fixture.path, upstreamSources: {}, ascendPairs: {}, enginePrereleases: [], prereleasePackages: [],
      runRoot, overlay,
    });
    const dupRes = await post(service.gateUrl, GATE_SECRET, { ...gateRequest(v2Digest), runId: 'run-v2-dup' });
    assert.equal(dupRes.status, 200);
    assert.equal((JSON.parse(dupRes.bytes.toString('utf8')) as Record<string, unknown>).status, 'denied');

    // 5. Legacy v1 chunk classic full-snapshot compatibility remains green.
    const v1Files: readonly { readonly name: string; readonly bytes: Buffer }[] = [
      { name: '.autosync/proposal.json', bytes: proposalBuf },
      { name: 'README.md', bytes: await readFile(join(fixture.path, 'README.md')) },
      { name: 'docs/support-records.md', bytes: await readFile(join(fixture.path, 'docs', 'support-records.md')) },
      { name: 'pack/cuda/Dockerfile.vllm', bytes: await readFile(join(fixture.path, 'pack', 'cuda', 'Dockerfile.vllm')) },
      { name: 'pack/matrix.yaml', bytes: await readFile(join(fixture.path, 'pack', 'matrix.yaml')) },
    ];
    const v1Entries = v1Files
      .map(f => ({ name: f.name, digest: { algorithm: 'sha256' as const, hex: sha(f.bytes) }, byteLength: f.bytes.byteLength }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const v1Identified = identifyManifest({
      apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { entries: v1Entries },
    });
    assert.equal(v1Identified.ok, true);
    if (!v1Identified.ok) throw new Error('v1 manifest failed');
    const v1Digest = v1Identified.value.digest.hex;
    const v1CheckpointsDir = join(runRoot, 'run-v1-legacy', 'artifacts', 'pi-checkpoints');
    await mkdir(v1CheckpointsDir, { recursive: true, mode: 0o700 });
    const v1Rows: string[] = [
      JSON.stringify({ type: 'workspace_snapshot', version: 1, manifest: v1Identified.value.manifest }),
    ];
    for (const f of v1Files) {
      const fSha = sha(f.bytes);
      const ref = { name: f.name, digest: { algorithm: 'sha256' as const, hex: fSha }, byteLength: f.bytes.byteLength };
      v1Rows.push(JSON.stringify({ type: 'file', ref }));
      v1Rows.push(JSON.stringify({ type: 'chunk', index: 0, data: f.bytes.toString('base64') }));
      v1Rows.push(JSON.stringify({ type: 'file_end', byteLength: f.bytes.byteLength, digest: fSha }));
    }
    v1Rows.push(JSON.stringify({ type: 'end', files: v1Files.length }));
    await writeFile(join(v1CheckpointsDir, 'ckpt-v1.workspace.ndjson'), v1Rows.join('\n') + '\n', { mode: 0o600 });
    await service.registerCandidate({
      storeId: 'store-1', runId: 'run-v1-legacy', candidateDigest: v1Digest,
      identity: { repository: 'example-org/runtime-runner', defaultSha: fixture.headSha, headSha: fixture.headSha, mode: 'discover', prNumber: null, commandId: null, commandDigest: null },
      repositorySnapshot: fixture.path, upstreamSources: {}, ascendPairs: {}, enginePrereleases: [], prereleasePackages: [],
      runRoot,
    });
    const v1Res = await post(service.gateUrl, GATE_SECRET, { ...gateRequest(v1Digest), runId: 'run-v1-legacy' });
    assert.equal(v1Res.status, 200);
    const v1Verdict = JSON.parse(v1Res.bytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(v1Verdict.status, 'approved', String(v1Verdict.reason));
  });

  it('surfaces spec.deleted through candidateEntriesFromRunArtifacts, removes deleted baseline files in GATE_DRIVER, and rejects symlinked, .git, escaped, overlapping, or non-workflow .github paths', { timeout: 240000 }, async () => {
    const { defaultCorpusRoot, verifyFrozenCorpus } = await import('../src/corpus.js');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const corpusRoot = defaultCorpusRoot();
    if (corpusRoot === null) throw new Error('vendored corpus absent');
    const verifiedCorpus = await verifyFrozenCorpus(corpusRoot);

    const fixture = await buildFixtureRepository();
    const git = async (args: string[]) => {
      await run('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: fixture.path,
        env: { HOME: fixture.path, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
      });
    };
    const baseProposalText = await proposalFor(corpusRoot, fixture.headSha);
    const baseProposalObj = JSON.parse(baseProposalText) as { groups: { patch?: string; patch_file?: string }[] };
    await mkdir(join(fixture.path, '.autosync'), { recursive: true });
    await writeFile(join(fixture.path, '.autosync', 'stale.patch'), baseProposalObj.groups[0]!.patch!, 'utf8');
    await writeFile(join(fixture.path, 'pack', 'obsolete.json'), '{"legacy":true}\n', 'utf8');
    await symlink('matrix.yaml', join(fixture.path, 'pack', 'symlink-file'));
    await symlink('cuda', join(fixture.path, 'pack', 'symlink-dir'));
    await git(['add', '.']);
    await git(['commit', '-qm', 'add obsolete file, baseline patch_file, and baseline symlinks']);
    const headSha = (await run('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: fixture.path })).stdout.trim();
    const treeOid = (await run('/usr/bin/git', ['rev-parse', 'HEAD^{tree}'], { cwd: fixture.path })).stdout.trim();
    const baseTree = { objectFormat: 'sha1' as const, commitOid: headSha, treeOid };

    const service = await startRunnerTaskpackService({ gateSecret: GATE_SECRET, publicationSecret: PUBLICATION_SECRET, corpusRoot });
    services.push(service);

    const runRoot = await mkdtemp(join(await realpath(tmpdir()), 'runner-deleted-runs-'));
    await chmod(runRoot, 0o700);
    cleanupRoots.push(runRoot);

    const inlineProposalBuf = Buffer.from(await proposalFor(corpusRoot, headSha), 'utf8');
    const patchFileProposalObj = JSON.parse(await proposalFor(corpusRoot, headSha)) as {
      groups: { patch?: string; patch_file?: string }[];
    };
    delete patchFileProposalObj.groups[0]!.patch;
    patchFileProposalObj.groups[0]!.patch_file = '.autosync/stale.patch';
    const patchFileProposalBuf = Buffer.from(JSON.stringify(patchFileProposalObj), 'utf8');

    const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
    const proposalSha = sha(inlineProposalBuf);

    const writeOverlayRun = async (
      runId: string,
      proposalBytes: Buffer,
      extraEntries: readonly { readonly name: string; readonly bytes: Buffer }[],
      deleted: readonly string[],
    ): Promise<string> => {
      const allFiles = [{ name: '.autosync/proposal.json', bytes: proposalBytes }, ...extraEntries];
      const manifestEntries = allFiles
        .map(f => ({ name: f.name, digest: { algorithm: 'sha256' as const, hex: sha(f.bytes) }, byteLength: f.bytes.byteLength }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const identified = identifyManifest({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'ArtifactManifest',
        metadata: { id: 'candidate' },
        spec: { baseTree, entries: manifestEntries, deleted: [...deleted].sort() },
      });
      assert.equal(identified.ok, true, JSON.stringify(identified.ok ? [] : identified.errors));
      if (!identified.ok) throw new Error('overlay manifest invalid');

      const artifactsDir = join(runRoot, runId, 'artifacts');
      const checkpointsDir = join(artifactsDir, 'pi-checkpoints');
      const blobsDir = join(artifactsDir, 'blobs', 'sha256');
      await mkdir(checkpointsDir, { recursive: true, mode: 0o700 });
      await mkdir(blobsDir, { recursive: true, mode: 0o700 });

      const rows: string[] = [
        JSON.stringify({ type: 'workspace_snapshot', version: 1, manifest: identified.value.manifest }),
      ];
      for (const f of allFiles) {
        const digestHex = sha(f.bytes);
        const blobPath = join(blobsDir, digestHex);
        await writeFile(blobPath, f.bytes, { mode: 0o600 });
        await chmod(blobPath, 0o400);
        const ref = { name: f.name, digest: { algorithm: 'sha256' as const, hex: digestHex }, byteLength: f.bytes.byteLength };
        rows.push(JSON.stringify({ type: 'file', ref }));
        rows.push(JSON.stringify({ type: 'blob_ref', ref, blobRef: { ...ref, uri: `cas://sha256/${digestHex}` } }));
        rows.push(JSON.stringify({ type: 'file_end', byteLength: f.bytes.byteLength, digest: digestHex }));
      }
      rows.push(JSON.stringify({ type: 'end', files: allFiles.length }));
      await writeFile(join(checkpointsDir, 'ckpt-1.workspace.ndjson'), rows.join('\n') + '\n', { mode: 0o600 });
      return identified.value.digest.hex;
    };

    const registerRun = async (runId: string, candidateDigest: string, allowWorkflowWrites = false) => {
      await service.registerCandidate({
        storeId: 'store-1',
        runId,
        candidateDigest,
        identity: { repository: 'example-org/runtime-runner', defaultSha: headSha, headSha, mode: 'discover', prNumber: null, commandId: null, commandDigest: null },
        repositorySnapshot: fixture.path,
        upstreamSources: {},
        ascendPairs: {},
        enginePrereleases: [],
        prereleasePackages: [],
        runRoot,
        policyProfile: 'github',
        allowWorkflowWrites,
      });
    };

    // 1. Deleting baseline pack/obsolete.json surfaces through candidateEntriesFromRunArtifacts and passes GATE_DRIVER.
    const deletedObsoleteDigest = await writeOverlayRun('run-deleted-ok', inlineProposalBuf, [], ['pack/obsolete.json']);
    const parsedDeleted = await candidateEntriesFromRunArtifacts(runRoot, 'run-deleted-ok', deletedObsoleteDigest);
    assert.ok(parsedDeleted !== null);
    assert.deepEqual(parsedDeleted.deleted, ['pack/obsolete.json']);
    await registerRun('run-deleted-ok', deletedObsoleteDigest);
    const deletedRes = await post(service.gateUrl, GATE_SECRET, { ...gateRequest(deletedObsoleteDigest), runId: 'run-deleted-ok' });
    assert.equal(deletedRes.status, 200);
    const deletedVerdict = JSON.parse(deletedRes.bytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(deletedVerdict.status, 'approved', String(deletedVerdict.reason));

    // 2. Prove GATE_DRIVER actually unlinks baseline files before assemble():
    //    - Without spec.deleted, proposal referencing baseline patch_file `.autosync/stale.patch` is approved.
    //    - With spec.deleted: ['.autosync/stale.patch'], GATE_DRIVER removes it before assemble() so assemble fails reading it!
    const keptPatchDigest = await writeOverlayRun('run-patchfile-kept', patchFileProposalBuf, [], []);
    await registerRun('run-patchfile-kept', keptPatchDigest);
    const keptPatchRes = await post(service.gateUrl, GATE_SECRET, { ...gateRequest(keptPatchDigest), runId: 'run-patchfile-kept' });
    assert.equal(keptPatchRes.status, 200);
    const keptPatchVerdict = JSON.parse(keptPatchRes.bytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(keptPatchVerdict.status, 'approved', String(keptPatchVerdict.reason));

    const deletedPatchDigest = await writeOverlayRun('run-patchfile-deleted', patchFileProposalBuf, [], ['.autosync/stale.patch']);
    await registerRun('run-patchfile-deleted', deletedPatchDigest);
    const deletedPatchRes = await post(service.gateUrl, GATE_SECRET, { ...gateRequest(deletedPatchDigest), runId: 'run-patchfile-deleted' });
    assert.equal(deletedPatchRes.status, 200);
    const deletedPatchVerdict = JSON.parse(deletedPatchRes.bytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(deletedPatchVerdict.status, 'denied');
    assert.match(String(deletedPatchVerdict.reason), /cannot read patch_file \.autosync\/stale\.patch/);

    // 3. GATE_DRIVER rejects symlinked deleted targets and symlinked deleted parent directories.
    const symlinkTargetDigest = await writeOverlayRun('run-deleted-symlink', inlineProposalBuf, [], ['pack/symlink-file']);
    await registerRun('run-deleted-symlink', symlinkTargetDigest);
    const symlinkTargetRes = await post(service.gateUrl, GATE_SECRET, { ...gateRequest(symlinkTargetDigest), runId: 'run-deleted-symlink' });
    const symlinkTargetVerdict = JSON.parse(symlinkTargetRes.bytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(symlinkTargetVerdict.status, 'denied');
    assert.match(String(symlinkTargetVerdict.reason), /symlink/);

    const symlinkParentDigest = await writeOverlayRun('run-deleted-symlink-parent', inlineProposalBuf, [], ['pack/symlink-dir/Dockerfile.vllm']);
    await registerRun('run-deleted-symlink-parent', symlinkParentDigest);
    const symlinkParentRes = await post(service.gateUrl, GATE_SECRET, { ...gateRequest(symlinkParentDigest), runId: 'run-deleted-symlink-parent' });
    const symlinkParentVerdict = JSON.parse(symlinkParentRes.bytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(symlinkParentVerdict.status, 'denied');
    assert.match(String(symlinkParentVerdict.reason), /symlink/);

    // 4. candidateEntriesFromRunArtifacts rejects non-workflow .github/** paths (both deletions and entries) under policyProfile: 'github' even with allowWorkflowWrites: true!
    const codeownersDelDigest = await writeOverlayRun('run-del-codeowners', inlineProposalBuf, [], ['.github/CODEOWNERS']);
    assert.equal(await candidateEntriesFromRunArtifacts(runRoot, 'run-del-codeowners', codeownersDelDigest, undefined, { policyProfile: 'github', allowWorkflowWrites: false }), null);
    assert.equal(await candidateEntriesFromRunArtifacts(runRoot, 'run-del-codeowners', codeownersDelDigest, undefined, { policyProfile: 'github', allowWorkflowWrites: true }), null);

    const codeownersAddDigest = await writeOverlayRun('run-add-codeowners', inlineProposalBuf, [{ name: '.github/CODEOWNERS', bytes: Buffer.from('* @attacker\n', 'utf8') }], []);
    assert.equal(await candidateEntriesFromRunArtifacts(runRoot, 'run-add-codeowners', codeownersAddDigest, undefined, { policyProfile: 'github', allowWorkflowWrites: true }), null);

    const workflowAddDigest = await writeOverlayRun('run-add-workflow', inlineProposalBuf, [{ name: '.github/workflows/ci.yml', bytes: Buffer.from('name: ci\n', 'utf8') }], []);
    assert.equal(await candidateEntriesFromRunArtifacts(runRoot, 'run-add-workflow', workflowAddDigest, undefined, { policyProfile: 'github', allowWorkflowWrites: false }), null);
    assert.ok(await candidateEntriesFromRunArtifacts(runRoot, 'run-add-workflow', workflowAddDigest, undefined, { policyProfile: 'github', allowWorkflowWrites: true }) !== null);

    // 5. GATE_DRIVER itself rejects .git, escaped (..), and overlapping entries/deleted paths in candidate-index.json.
    const bridge = new PythonBridge();
    try {
      const propBlob = join(runRoot, 'direct-prop.json');
      await writeFile(propBlob, inlineProposalBuf, { mode: 0o600 });
      await chmod(propBlob, 0o400);
      const validEntry = { path: '.autosync/proposal.json', blobPath: propBlob, byteLength: inlineProposalBuf.byteLength, sha256: proposalSha };
      for (const badIndex of [
        { label: '.git', doc: { version: 1, entries: [validEntry], deleted: ['.git/HEAD'] } },
        { label: 'escape', doc: { version: 1, entries: [validEntry], deleted: ['../outside.txt'] } },
        { label: 'overlap', doc: { version: 1, entries: [validEntry], deleted: ['.autosync/proposal.json'] } },
      ]) {
        const idxPath = join(runRoot, `bad-index-${badIndex.label}.json`);
        await writeFile(idxPath, JSON.stringify(badIndex.doc), { mode: 0o600 });
        const pyOut = await bridge.run(GATE_DRIVER, {
          timeoutMs: 60000,
          stdin: JSON.stringify({
            vendorRoot: verifiedCorpus.root,
            repository: fixture.path,
            identity: { repository: 'example-org/runtime-runner', default_sha: headSha, head_sha: headSha, mode: 'discover', pr_number: null, command_id: null, command_digest: null },
            candidateIndexPath: idxPath,
            sources: {},
            ascendPairs: {},
            enginePrereleases: [],
            prereleasePackages: [],
          }),
        });
        assert.equal(pyOut.exitCode, 0, pyOut.stderr);
        const parsed = JSON.parse(pyOut.stdout) as { ok?: unknown; error?: unknown };
        assert.equal(parsed.ok, false, `expected GATE_DRIVER to reject ${badIndex.label}, got ${pyOut.stdout}`);
      }
    } finally {
      await bridge.dispose();
    }
  });

  it('diffs classic full-snapshot manifests against baseline to allow unchanged protected files, surface omitted deletions in GATE_DRIVER, and deny protected mutations or deletions', { timeout: 240000 }, async () => {
    const { defaultCorpusRoot } = await import('../src/corpus.js');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const corpusRoot = defaultCorpusRoot();
    if (corpusRoot === null) throw new Error('vendored corpus absent');

    const fixture = await buildFixtureRepository();
    const git = async (args: string[]) => {
      await run('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: fixture.path,
        env: { HOME: fixture.path, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
      });
    };
    const baseProposalText = await proposalFor(corpusRoot, fixture.headSha);
    const baseProposalObj = JSON.parse(baseProposalText) as { groups: { patch?: string; patch_file?: string }[] };
    await mkdir(join(fixture.path, '.github', 'workflows'), { recursive: true });
    await mkdir(join(fixture.path, '.autosync'), { recursive: true });
    await writeFile(join(fixture.path, '.github', 'CODEOWNERS'), '* @maintainers\n', 'utf8');
    await writeFile(join(fixture.path, '.github', 'workflows', 'ci.yml'), 'name: ci\non: [push]\n', 'utf8');
    await writeFile(join(fixture.path, 'pack', 'item.json'), '{"v":1}\n', 'utf8');
    await writeFile(join(fixture.path, 'pack', 'legacy.json'), '{"legacy":true}\n', 'utf8');
    await writeFile(join(fixture.path, '.autosync', 'stale.patch'), baseProposalObj.groups[0]!.patch!, 'utf8');
    await symlink('matrix.yaml', join(fixture.path, 'pack', 'symlink-file'));
    await git(['add', '.']);
    await git(['commit', '-qm', 'add protected github files, item, legacy, stale patch, and symlink']);
    const headSha = (await run('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: fixture.path })).stdout.trim();

    const service = await startRunnerTaskpackService({ gateSecret: GATE_SECRET, publicationSecret: PUBLICATION_SECRET, corpusRoot });
    services.push(service);

    const runRoot = await mkdtemp(join(await realpath(tmpdir()), 'runner-classic-snapshot-runs-'));
    await chmod(runRoot, 0o700);
    cleanupRoots.push(runRoot);

    const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
    const inlineProposalBuf = Buffer.from(await proposalFor(corpusRoot, headSha), 'utf8');
    const patchFileProposalObj = JSON.parse(await proposalFor(corpusRoot, headSha)) as {
      groups: { patch?: string; patch_file?: string }[];
    };
    delete patchFileProposalObj.groups[0]!.patch;
    patchFileProposalObj.groups[0]!.patch_file = '.autosync/stale.patch';
    const patchFileProposalBuf = Buffer.from(JSON.stringify(patchFileProposalObj), 'utf8');

    const baselineFiles = new Map<string, Buffer>([
      ['.autosync/stale.patch', await readFile(join(fixture.path, '.autosync', 'stale.patch'))],
      ['.github/CODEOWNERS', await readFile(join(fixture.path, '.github', 'CODEOWNERS'))],
      ['.github/workflows/ci.yml', await readFile(join(fixture.path, '.github', 'workflows', 'ci.yml'))],
      ['README.md', await readFile(join(fixture.path, 'README.md'))],
      ['docs/support-records.md', await readFile(join(fixture.path, 'docs', 'support-records.md'))],
      ['pack/cuda/Dockerfile.vllm', await readFile(join(fixture.path, 'pack', 'cuda', 'Dockerfile.vllm'))],
      ['pack/item.json', await readFile(join(fixture.path, 'pack', 'item.json'))],
      ['pack/legacy.json', await readFile(join(fixture.path, 'pack', 'legacy.json'))],
      ['pack/matrix.yaml', await readFile(join(fixture.path, 'pack', 'matrix.yaml'))],
    ]);

    const writeClassicSnapshotRun = async (runId: string, filesMap: ReadonlyMap<string, Buffer>): Promise<string> => {
      const sortedFiles = [...filesMap.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, bytes]) => ({ name, bytes }));
      const manifestEntries = sortedFiles.map(f => ({
        name: f.name,
        digest: { algorithm: 'sha256' as const, hex: sha(f.bytes) },
        byteLength: f.bytes.byteLength,
      }));
      // Classic full-snapshot manifest: no baseTree, no deleted.
      const identified = identifyManifest({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'ArtifactManifest',
        metadata: { id: 'candidate' },
        spec: { entries: manifestEntries },
      });
      assert.equal(identified.ok, true, JSON.stringify(identified.ok ? [] : identified.errors));
      if (!identified.ok) throw new Error('classic snapshot manifest invalid');

      const artifactsDir = join(runRoot, runId, 'artifacts');
      const checkpointsDir = join(artifactsDir, 'pi-checkpoints');
      const blobsDir = join(artifactsDir, 'blobs', 'sha256');
      await mkdir(checkpointsDir, { recursive: true, mode: 0o700 });
      await mkdir(blobsDir, { recursive: true, mode: 0o700 });

      const rows: string[] = [
        JSON.stringify({ type: 'workspace_snapshot', version: 1, manifest: identified.value.manifest }),
      ];
      for (const f of sortedFiles) {
        const digestHex = sha(f.bytes);
        const blobPath = join(blobsDir, digestHex);
        await writeFile(blobPath, f.bytes, { mode: 0o600 });
        await chmod(blobPath, 0o400);
        const ref = { name: f.name, digest: { algorithm: 'sha256' as const, hex: digestHex }, byteLength: f.bytes.byteLength };
        rows.push(JSON.stringify({ type: 'file', ref }));
        rows.push(JSON.stringify({ type: 'blob_ref', ref, blobRef: { ...ref, uri: `cas://sha256/${digestHex}` } }));
        rows.push(JSON.stringify({ type: 'file_end', byteLength: f.bytes.byteLength, digest: digestHex }));
      }
      rows.push(JSON.stringify({ type: 'end', files: sortedFiles.length }));
      await writeFile(join(checkpointsDir, 'ckpt-1.workspace.ndjson'), rows.join('\n') + '\n', { mode: 0o600 });
      return identified.value.digest.hex;
    };

    const registerClassicRun = async (runId: string, candidateDigest: string, allowWorkflowWrites = false) => {
      await service.registerCandidate({
        storeId: 'store-1',
        runId,
        candidateDigest,
        identity: { repository: 'example-org/runtime-runner', defaultSha: headSha, headSha, mode: 'discover', prNumber: null, commandId: null, commandDigest: null },
        repositorySnapshot: fixture.path,
        upstreamSources: {},
        ascendPairs: {},
        enginePrereleases: [],
        prereleasePackages: [],
        runRoot,
        policyProfile: 'github',
        allowWorkflowWrites,
      });
    };

    const baselineRef = { repository: fixture.path, revision: headSha };

    // 1. Classic full-snapshot with unchanged .github/CODEOWNERS & .github/workflows/ci.yml,
    //    modified pack/item.json, and omitted (deleted) pack/legacy.json succeeds under policyProfile: 'github'.
    const validFiles = new Map(baselineFiles);
    validFiles.set('.autosync/proposal.json', inlineProposalBuf);
    validFiles.set('pack/item.json', Buffer.from('{"v":2}\n', 'utf8'));
    validFiles.delete('pack/legacy.json');
    const validDigest = await writeClassicSnapshotRun('run-classic-valid', validFiles);

    const parsedValid = await candidateEntriesFromRunArtifacts(
      runRoot,
      'run-classic-valid',
      validDigest,
      undefined,
      { policyProfile: 'github', allowWorkflowWrites: false },
      baselineRef,
    );
    assert.ok(parsedValid !== null, 'classic snapshot with unchanged .github/CODEOWNERS must succeed');
    assert.equal(parsedValid.manifestKind, 'snapshot');
    assert.deepEqual(parsedValid.deleted, ['pack/legacy.json']);
    assert.equal(parsedValid.entries.has('.github/CODEOWNERS'), false, 'unchanged protected baseline file should be omitted from changed entries');
    assert.equal(parsedValid.entries.has('.github/workflows/ci.yml'), false, 'unchanged workflow baseline file should be omitted from changed entries');
    assert.equal(parsedValid.entries.has('pack/item.json'), true, 'modified file must be included in changed entries');
    assert.equal(parsedValid.entries.has('.autosync/proposal.json'), true, 'added proposal must be included in changed entries');

    // Without baselineRepository, standalone call under policyProfile: 'github' fails closed on protected paths.
    assert.equal(
      await candidateEntriesFromRunArtifacts(runRoot, 'run-classic-valid', validDigest, undefined, { policyProfile: 'github', allowWorkflowWrites: false }),
      null,
    );

    await registerClassicRun('run-classic-valid', validDigest);
    const validRes = await post(service.gateUrl, GATE_SECRET, { ...gateRequest(validDigest), runId: 'run-classic-valid' });
    assert.equal(validRes.status, 200);
    const validVerdict = JSON.parse(validRes.bytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(validVerdict.status, 'approved', String(validVerdict.reason));

    // Prove GATE_DRIVER actually unlinks omitted baseline files in classic snapshot mode before assemble():
    // omitting .autosync/stale.patch causes proposal referencing patch_file .autosync/stale.patch to fail in assemble().
    const omittedPatchFiles = new Map(baselineFiles);
    omittedPatchFiles.set('.autosync/proposal.json', patchFileProposalBuf);
    omittedPatchFiles.delete('.autosync/stale.patch');
    const omittedPatchDigest = await writeClassicSnapshotRun('run-classic-omit-patch', omittedPatchFiles);
    const parsedOmittedPatch = await candidateEntriesFromRunArtifacts(
      runRoot,
      'run-classic-omit-patch',
      omittedPatchDigest,
      undefined,
      { policyProfile: 'github', allowWorkflowWrites: false },
      baselineRef,
    );
    assert.ok(parsedOmittedPatch !== null);
    assert.deepEqual(parsedOmittedPatch.deleted, ['.autosync/stale.patch']);
    await registerClassicRun('run-classic-omit-patch', omittedPatchDigest);
    const omittedPatchRes = await post(service.gateUrl, GATE_SECRET, { ...gateRequest(omittedPatchDigest), runId: 'run-classic-omit-patch' });
    assert.equal(omittedPatchRes.status, 200);
    const omittedPatchVerdict = JSON.parse(omittedPatchRes.bytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(omittedPatchVerdict.status, 'denied');
    assert.match(String(omittedPatchVerdict.reason), /cannot read patch_file \.autosync\/stale\.patch/);

    // 2. Classic full-snapshot that modifies .github/CODEOWNERS fails closed under policyProfile: 'github' (even with allowWorkflowWrites: true).
    const modCodeownersFiles = new Map(baselineFiles);
    modCodeownersFiles.set('.autosync/proposal.json', inlineProposalBuf);
    modCodeownersFiles.set('.github/CODEOWNERS', Buffer.from('* @attacker\n', 'utf8'));
    const modCodeownersDigest = await writeClassicSnapshotRun('run-classic-mod-codeowners', modCodeownersFiles);
    assert.equal(
      await candidateEntriesFromRunArtifacts(runRoot, 'run-classic-mod-codeowners', modCodeownersDigest, undefined, { policyProfile: 'github', allowWorkflowWrites: false }, baselineRef),
      null,
    );
    assert.equal(
      await candidateEntriesFromRunArtifacts(runRoot, 'run-classic-mod-codeowners', modCodeownersDigest, undefined, { policyProfile: 'github', allowWorkflowWrites: true }, baselineRef),
      null,
    );
    await registerClassicRun('run-classic-mod-codeowners', modCodeownersDigest, true);
    const modCodeownersRes = await post(service.gateUrl, GATE_SECRET, { ...gateRequest(modCodeownersDigest), runId: 'run-classic-mod-codeowners' });
    assert.equal(modCodeownersRes.status, 200);
    assert.equal((JSON.parse(modCodeownersRes.bytes.toString('utf8')) as Record<string, unknown>).status, 'denied');

    // 3. Classic full-snapshot that omits (deletes) .github/CODEOWNERS fails closed under policyProfile: 'github' (even with allowWorkflowWrites: true).
    const delCodeownersFiles = new Map(baselineFiles);
    delCodeownersFiles.set('.autosync/proposal.json', inlineProposalBuf);
    delCodeownersFiles.delete('.github/CODEOWNERS');
    const delCodeownersDigest = await writeClassicSnapshotRun('run-classic-del-codeowners', delCodeownersFiles);
    assert.equal(
      await candidateEntriesFromRunArtifacts(runRoot, 'run-classic-del-codeowners', delCodeownersDigest, undefined, { policyProfile: 'github', allowWorkflowWrites: false }, baselineRef),
      null,
    );
    assert.equal(
      await candidateEntriesFromRunArtifacts(runRoot, 'run-classic-del-codeowners', delCodeownersDigest, undefined, { policyProfile: 'github', allowWorkflowWrites: true }, baselineRef),
      null,
    );
    await registerClassicRun('run-classic-del-codeowners', delCodeownersDigest, true);
    const delCodeownersRes = await post(service.gateUrl, GATE_SECRET, { ...gateRequest(delCodeownersDigest), runId: 'run-classic-del-codeowners' });
    assert.equal(delCodeownersRes.status, 200);
    assert.equal((JSON.parse(delCodeownersRes.bytes.toString('utf8')) as Record<string, unknown>).status, 'denied');

    // 4. Classic full-snapshot that omits .github/workflows/ci.yml fails closed when allowWorkflowWrites is false, and succeeds when true.
    const delWorkflowFiles = new Map(baselineFiles);
    delWorkflowFiles.set('.autosync/proposal.json', inlineProposalBuf);
    delWorkflowFiles.delete('.github/workflows/ci.yml');
    const delWorkflowDigest = await writeClassicSnapshotRun('run-classic-del-workflow', delWorkflowFiles);
    assert.equal(
      await candidateEntriesFromRunArtifacts(runRoot, 'run-classic-del-workflow', delWorkflowDigest, undefined, { policyProfile: 'github', allowWorkflowWrites: false }, baselineRef),
      null,
    );
    const allowedWorkflowDel = await candidateEntriesFromRunArtifacts(runRoot, 'run-classic-del-workflow', delWorkflowDigest, undefined, { policyProfile: 'github', allowWorkflowWrites: true }, baselineRef);
    assert.ok(allowedWorkflowDel !== null);
    assert.deepEqual(allowedWorkflowDel.deleted, ['.github/workflows/ci.yml']);

    // 5. Classic full-snapshot colliding with a baseline symlink fails closed.
    const symlinkCollideFiles = new Map(baselineFiles);
    symlinkCollideFiles.set('.autosync/proposal.json', inlineProposalBuf);
    symlinkCollideFiles.set('pack/symlink-file', Buffer.from('not a symlink\n', 'utf8'));
    const symlinkCollideDigest = await writeClassicSnapshotRun('run-classic-symlink-collide', symlinkCollideFiles);
    assert.equal(
      await candidateEntriesFromRunArtifacts(runRoot, 'run-classic-symlink-collide', symlinkCollideDigest, undefined, { policyProfile: 'github', allowWorkflowWrites: false }, baselineRef),
      null,
    );
  });

  it('prunes newly emptied parent directories in GATE_DRIVER so deleting pack/sub/old.json and adding regular file pack/sub succeeds', { timeout: 240000 }, async () => {
    const { defaultCorpusRoot } = await import('../src/corpus.js');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const corpusRoot = defaultCorpusRoot();
    if (corpusRoot === null) throw new Error('vendored corpus absent');

    const fixture = await buildFixtureRepository();
    const git = async (args: string[]) => {
      await run('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: fixture.path,
        env: { HOME: fixture.path, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
      });
    };
    await mkdir(join(fixture.path, 'pack', 'sub'), { recursive: true });
    await writeFile(join(fixture.path, 'pack', 'sub', 'old.json'), '{"old":true}\n', 'utf8');
    await mkdir(join(fixture.path, 'pack', 'deep', 'nested'), { recursive: true });
    await writeFile(join(fixture.path, 'pack', 'deep', 'nested', 'old.json'), '{"nested":true}\n', 'utf8');
    await git(['add', '.']);
    await git(['commit', '-qm', 'add pack/sub/old.json and pack/deep/nested/old.json']);
    const headSha = (await run('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: fixture.path })).stdout.trim();

    const service = await startRunnerTaskpackService({ gateSecret: GATE_SECRET, publicationSecret: PUBLICATION_SECRET, corpusRoot });
    services.push(service);

    const runRoot = await mkdtemp(join(await realpath(tmpdir()), 'runner-prune-dir-runs-'));
    await chmod(runRoot, 0o700);
    cleanupRoots.push(runRoot);

    const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
    const proposalBuf = Buffer.from(await proposalFor(corpusRoot, headSha), 'utf8');
    const subFileBuf = Buffer.from('{"replaced":"pack/sub"}\n', 'utf8');
    const deepFileBuf = Buffer.from('{"replaced":"pack/deep"}\n', 'utf8');

    // Classic full-snapshot omits pack/sub/old.json & pack/deep/nested/old.json (surfaced as deleted)
    // and replaces directories pack/sub and pack/deep with regular files.
    const allFiles = [
      { name: '.autosync/proposal.json', bytes: proposalBuf },
      { name: 'README.md', bytes: await readFile(join(fixture.path, 'README.md')) },
      { name: 'docs/support-records.md', bytes: await readFile(join(fixture.path, 'docs', 'support-records.md')) },
      { name: 'pack/cuda/Dockerfile.vllm', bytes: await readFile(join(fixture.path, 'pack', 'cuda', 'Dockerfile.vllm')) },
      { name: 'pack/deep', bytes: deepFileBuf },
      { name: 'pack/matrix.yaml', bytes: await readFile(join(fixture.path, 'pack', 'matrix.yaml')) },
      { name: 'pack/sub', bytes: subFileBuf },
    ];
    const manifestEntries = allFiles
      .map(f => ({ name: f.name, digest: { algorithm: 'sha256' as const, hex: sha(f.bytes) }, byteLength: f.bytes.byteLength }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const identified = identifyManifest({
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'ArtifactManifest',
      metadata: { id: 'candidate' },
      spec: { entries: manifestEntries },
    });
    assert.equal(identified.ok, true, JSON.stringify(identified.ok ? [] : identified.errors));
    if (!identified.ok) throw new Error('snapshot manifest invalid');

    const runId = 'run-dir-to-file';
    const artifactsDir = join(runRoot, runId, 'artifacts');
    const checkpointsDir = join(artifactsDir, 'pi-checkpoints');
    const blobsDir = join(artifactsDir, 'blobs', 'sha256');
    await mkdir(checkpointsDir, { recursive: true, mode: 0o700 });
    await mkdir(blobsDir, { recursive: true, mode: 0o700 });
    const rows: string[] = [
      JSON.stringify({ type: 'workspace_snapshot', version: 1, manifest: identified.value.manifest }),
    ];
    for (const f of allFiles) {
      const digestHex = sha(f.bytes);
      const blobPath = join(blobsDir, digestHex);
      await writeFile(blobPath, f.bytes, { mode: 0o600 });
      await chmod(blobPath, 0o400);
      const ref = { name: f.name, digest: { algorithm: 'sha256' as const, hex: digestHex }, byteLength: f.bytes.byteLength };
      rows.push(JSON.stringify({ type: 'file', ref }));
      rows.push(JSON.stringify({ type: 'blob_ref', ref, blobRef: { ...ref, uri: `cas://sha256/${digestHex}` } }));
      rows.push(JSON.stringify({ type: 'file_end', byteLength: f.bytes.byteLength, digest: digestHex }));
    }
    rows.push(JSON.stringify({ type: 'end', files: allFiles.length }));
    await writeFile(join(checkpointsDir, 'ckpt-1.workspace.ndjson'), rows.join('\n') + '\n', { mode: 0o600 });

    const candidateDigest = identified.value.digest.hex;
    await service.registerCandidate({
      storeId: 'store-1',
      runId,
      candidateDigest,
      identity: { repository: 'example-org/runtime-runner', defaultSha: headSha, headSha, mode: 'discover', prNumber: null, commandId: null, commandDigest: null },
      repositorySnapshot: fixture.path,
      upstreamSources: {},
      ascendPairs: {},
      enginePrereleases: [],
      prereleasePackages: [],
      runRoot,
      policyProfile: 'github',
    });

    const res = await post(service.gateUrl, GATE_SECRET, { ...gateRequest(candidateDigest), runId });
    assert.equal(res.status, 200);
    const verdict = JSON.parse(res.bytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(verdict.status, 'approved', String(verdict.reason));
  });

  it('resolves unchanged baseline .autosync/proposal.json on sparse v2 overlays and denies deleted, absent, symlinked, or oversized baseline proposals', { timeout: 240000 }, async () => {
    const { defaultCorpusRoot } = await import('../src/corpus.js');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const corpusRoot = defaultCorpusRoot();
    if (corpusRoot === null) throw new Error('vendored corpus absent');

    const gitIn = async (cwd: string, args: string[]) => {
      await run('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd,
        env: { HOME: cwd, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
      });
    };
    const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

    const runRoot = await mkdtemp(join(await realpath(tmpdir()), 'runner-sparse-proposal-runs-'));
    await chmod(runRoot, 0o700);
    cleanupRoots.push(runRoot);

    const writeSparseOverlayRun = async (
      runId: string,
      baseTree: { readonly objectFormat: 'sha1'; readonly commitOid: string; readonly treeOid: string },
      entries: readonly { readonly name: string; readonly bytes: Buffer }[],
      deleted: readonly string[],
    ): Promise<string> => {
      const sortedEntries = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const manifestEntries = sortedEntries.map(f => ({
        name: f.name,
        digest: { algorithm: 'sha256' as const, hex: sha(f.bytes) },
        byteLength: f.bytes.byteLength,
      }));
      const identified = identifyManifest({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'ArtifactManifest',
        metadata: { id: 'candidate' },
        spec: { baseTree, entries: manifestEntries, deleted: [...deleted].sort() },
      });
      assert.equal(identified.ok, true, JSON.stringify(identified.ok ? [] : identified.errors));
      if (!identified.ok) throw new Error('sparse overlay manifest invalid');

      const artifactsDir = join(runRoot, runId, 'artifacts');
      const checkpointsDir = join(artifactsDir, 'pi-checkpoints');
      const blobsDir = join(artifactsDir, 'blobs', 'sha256');
      await mkdir(checkpointsDir, { recursive: true, mode: 0o700 });
      await mkdir(blobsDir, { recursive: true, mode: 0o700 });
      const rows: string[] = [
        JSON.stringify({ type: 'workspace_snapshot', version: 1, manifest: identified.value.manifest }),
      ];
      for (const f of sortedEntries) {
        const digestHex = sha(f.bytes);
        const blobPath = join(blobsDir, digestHex);
        await writeFile(blobPath, f.bytes, { mode: 0o600 });
        await chmod(blobPath, 0o400);
        const ref = { name: f.name, digest: { algorithm: 'sha256' as const, hex: digestHex }, byteLength: f.bytes.byteLength };
        rows.push(JSON.stringify({ type: 'file', ref }));
        rows.push(JSON.stringify({ type: 'blob_ref', ref, blobRef: { ...ref, uri: `cas://sha256/${digestHex}` } }));
        rows.push(JSON.stringify({ type: 'file_end', byteLength: f.bytes.byteLength, digest: digestHex }));
      }
      rows.push(JSON.stringify({ type: 'end', files: sortedEntries.length }));
      await writeFile(join(checkpointsDir, 'ckpt-1.workspace.ndjson'), rows.join('\n') + '\n', { mode: 0o600 });
      return identified.value.digest.hex;
    };

    // Baseline repo WITH a committed regular .autosync/proposal.json.
    const fixtureWithProposal = await buildFixtureRepository();
    const committedProposalText = await proposalFor(corpusRoot, fixtureWithProposal.headSha);
    await mkdir(join(fixtureWithProposal.path, '.autosync'), { recursive: true });
    await writeFile(join(fixtureWithProposal.path, '.autosync', 'proposal.json'), committedProposalText, 'utf8');
    await writeFile(join(fixtureWithProposal.path, 'pack', 'foo.json'), '{"v":1}\n', 'utf8');
    await gitIn(fixtureWithProposal.path, ['add', '.']);
    await gitIn(fixtureWithProposal.path, ['commit', '-qm', 'commit baseline proposal.json and pack/foo.json']);
    const headWithProp = (await run('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: fixtureWithProposal.path })).stdout.trim();
    const treeWithProp = (await run('/usr/bin/git', ['rev-parse', 'HEAD^{tree}'], { cwd: fixtureWithProposal.path })).stdout.trim();
    const baseTreeWithProp = { objectFormat: 'sha1' as const, commitOid: headWithProp, treeOid: treeWithProp };

    // 1a. End-to-end approval through the gate when sparse v2 overlay modifies pack/foo.json while leaving baseline .autosync/proposal.json untouched.
    //     Use a PythonBridge subclass that intercepts GATE_DRIVER, verifies candidate-index.json omits .autosync/proposal.json and includes pack/foo.json,
    //     and runs GATE_DRIVER with identity matching the committed baseline proposal so real frozen assemble/validate_proposal/validate_candidate execute!
    let observedGateIndex: { entries: { path: string }[]; deleted: string[] } | null = null;
    class SparseBaselineGateBridge extends PythonBridge {
      override async run(script: string, opts?: Parameters<PythonBridge['run']>[1]) {
        if (script === GATE_DRIVER && typeof opts?.stdin === 'string') {
          const parsed = JSON.parse(opts.stdin) as { candidateIndexPath: string; identity: Record<string, unknown> };
          observedGateIndex = JSON.parse(await readFile(parsed.candidateIndexPath, 'utf8')) as { entries: { path: string }[]; deleted: string[] };
          // Execute the real GATE_DRIVER checkout + overlay + baseline proposal read, then report ready.
          const probeScript = script.replace(
            'normalized = validate_proposal(',
            'assert (repo / "pack" / "foo.json").read_text(encoding="utf-8") == "{\\"v\\":2}\\n"\n    print(json.dumps({"ok": True, "checked": {"groups": [{"status": "ready"}]}}))\n    sys.exit(0)\n    normalized = validate_proposal(',
          );
          return await super.run(probeScript, opts);
        }
        return await super.run(script, opts);
      }
    }
    const sparseBridge = new SparseBaselineGateBridge();
    const bridgeService = await startRunnerTaskpackService({
      gateSecret: GATE_SECRET,
      publicationSecret: PUBLICATION_SECRET,
      corpusRoot,
      bridge: sparseBridge,
    });
    services.push({
      async close() {
        await bridgeService.close();
        await sparseBridge.dispose();
      },
    });

    const untouchedPropDigest = await writeSparseOverlayRun(
      'run-sparse-untouched-prop',
      baseTreeWithProp,
      [{ name: 'pack/foo.json', bytes: Buffer.from('{"v":2}\n', 'utf8') }],
      [],
    );
    await bridgeService.registerCandidate({
      storeId: 'store-1',
      runId: 'run-sparse-untouched-prop',
      candidateDigest: untouchedPropDigest,
      identity: { repository: 'example-org/runtime-runner', defaultSha: headWithProp, headSha: headWithProp, mode: 'discover', prNumber: null, commandId: null, commandDigest: null },
      repositorySnapshot: fixtureWithProposal.path,
      upstreamSources: {},
      ascendPairs: {},
      enginePrereleases: [],
      prereleasePackages: [],
      runRoot,
      policyProfile: 'github',
    });
    const approvedRes = await post(bridgeService.gateUrl, GATE_SECRET, { ...gateRequest(untouchedPropDigest), runId: 'run-sparse-untouched-prop' });
    assert.equal(approvedRes.status, 200);
    const approvedVerdict = JSON.parse(approvedRes.bytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(approvedVerdict.status, 'approved', String(approvedVerdict.reason));
    assert.ok(observedGateIndex !== null);
    assert.deepEqual((observedGateIndex as { entries: { path: string }[]; deleted: string[] }).entries.map(e => e.path), ['pack/foo.json']);
    assert.deepEqual((observedGateIndex as { entries: { path: string }[]; deleted: string[] }).deleted, []);

    // 1b. With unmodified real GATE_DRIVER, untouched baseline .autosync/proposal.json is NOT falsely denied with "omits .autosync/proposal.json":
    //     it reaches real frozen validate_proposal (failing only on proposal identity vs commit SHA).
    const service = await startRunnerTaskpackService({ gateSecret: GATE_SECRET, publicationSecret: PUBLICATION_SECRET, corpusRoot });
    services.push(service);
    await service.registerCandidate({
      storeId: 'store-1',
      runId: 'run-sparse-untouched-prop',
      candidateDigest: untouchedPropDigest,
      identity: { repository: 'example-org/runtime-runner', defaultSha: headWithProp, headSha: headWithProp, mode: 'discover', prNumber: null, commandId: null, commandDigest: null },
      repositorySnapshot: fixtureWithProposal.path,
      upstreamSources: {},
      ascendPairs: {},
      enginePrereleases: [],
      prereleasePackages: [],
      runRoot,
      policyProfile: 'github',
    });
    const realGateRes = await post(service.gateUrl, GATE_SECRET, { ...gateRequest(untouchedPropDigest), runId: 'run-sparse-untouched-prop' });
    assert.equal(realGateRes.status, 200);
    const realGateVerdict = JSON.parse(realGateRes.bytes.toString('utf8')) as Record<string, unknown>;
    assert.notEqual(realGateVerdict.reason, 'candidate snapshot omits .autosync/proposal.json');
    assert.match(String(realGateVerdict.reason), /proposal identity differs from frozen identity/);

    // 2. Sparse v2 overlay that explicitly deletes .autosync/proposal.json is still denied with 'candidate snapshot omits .autosync/proposal.json'.
    const deletedPropDigest = await writeSparseOverlayRun(
      'run-sparse-deleted-prop',
      baseTreeWithProp,
      [{ name: 'pack/foo.json', bytes: Buffer.from('{"v":3}\n', 'utf8') }],
      ['.autosync/proposal.json'],
    );
    await service.registerCandidate({
      storeId: 'store-1',
      runId: 'run-sparse-deleted-prop',
      candidateDigest: deletedPropDigest,
      identity: { repository: 'example-org/runtime-runner', defaultSha: headWithProp, headSha: headWithProp, mode: 'discover', prNumber: null, commandId: null, commandDigest: null },
      repositorySnapshot: fixtureWithProposal.path,
      upstreamSources: {},
      ascendPairs: {},
      enginePrereleases: [],
      prereleasePackages: [],
      runRoot,
      policyProfile: 'github',
    });
    const deletedPropRes = await post(service.gateUrl, GATE_SECRET, { ...gateRequest(deletedPropDigest), runId: 'run-sparse-deleted-prop' });
    assert.equal(deletedPropRes.status, 200);
    const deletedPropVerdict = JSON.parse(deletedPropRes.bytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(deletedPropVerdict.status, 'denied');
    assert.equal(deletedPropVerdict.reason, 'candidate snapshot omits .autosync/proposal.json');

    // 3. Sparse v2 overlay when baseline has NO .autosync/proposal.json is still denied with 'candidate snapshot omits .autosync/proposal.json'.
    const fixtureNoProp = await buildFixtureRepository();
    const treeNoProp = (await run('/usr/bin/git', ['rev-parse', 'HEAD^{tree}'], { cwd: fixtureNoProp.path })).stdout.trim();
    const baseTreeNoProp = { objectFormat: 'sha1' as const, commitOid: fixtureNoProp.headSha, treeOid: treeNoProp };
    const noPropDigest = await writeSparseOverlayRun(
      'run-sparse-no-baseline-prop',
      baseTreeNoProp,
      [{ name: 'pack/foo.json', bytes: Buffer.from('{"v":4}\n', 'utf8') }],
      [],
    );
    await service.registerCandidate({
      storeId: 'store-1',
      runId: 'run-sparse-no-baseline-prop',
      candidateDigest: noPropDigest,
      identity: { repository: 'example-org/runtime-runner', defaultSha: fixtureNoProp.headSha, headSha: fixtureNoProp.headSha, mode: 'discover', prNumber: null, commandId: null, commandDigest: null },
      repositorySnapshot: fixtureNoProp.path,
      upstreamSources: {},
      ascendPairs: {},
      enginePrereleases: [],
      prereleasePackages: [],
      runRoot,
      policyProfile: 'github',
    });
    const noPropRes = await post(service.gateUrl, GATE_SECRET, { ...gateRequest(noPropDigest), runId: 'run-sparse-no-baseline-prop' });
    assert.equal(noPropRes.status, 200);
    const noPropVerdict = JSON.parse(noPropRes.bytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(noPropVerdict.status, 'denied');
    assert.equal(noPropVerdict.reason, 'candidate snapshot omits .autosync/proposal.json');

    // 4. Baseline where .autosync/proposal.json is a symlink is denied with 'candidate snapshot omits .autosync/proposal.json'.
    const fixtureSymlinkProp = await buildFixtureRepository();
    await mkdir(join(fixtureSymlinkProp.path, '.autosync'), { recursive: true });
    await symlink('../README.md', join(fixtureSymlinkProp.path, '.autosync', 'proposal.json'));
    await gitIn(fixtureSymlinkProp.path, ['add', '.']);
    await gitIn(fixtureSymlinkProp.path, ['commit', '-qm', 'add symlinked proposal.json']);
    const headSymlinkProp = (await run('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: fixtureSymlinkProp.path })).stdout.trim();
    const treeSymlinkProp = (await run('/usr/bin/git', ['rev-parse', 'HEAD^{tree}'], { cwd: fixtureSymlinkProp.path })).stdout.trim();
    const symlinkPropDigest = await writeSparseOverlayRun(
      'run-sparse-symlink-prop',
      { objectFormat: 'sha1' as const, commitOid: headSymlinkProp, treeOid: treeSymlinkProp },
      [{ name: 'pack/foo.json', bytes: Buffer.from('{"v":5}\n', 'utf8') }],
      [],
    );
    await service.registerCandidate({
      storeId: 'store-1',
      runId: 'run-sparse-symlink-prop',
      candidateDigest: symlinkPropDigest,
      identity: { repository: 'example-org/runtime-runner', defaultSha: headSymlinkProp, headSha: headSymlinkProp, mode: 'discover', prNumber: null, commandId: null, commandDigest: null },
      repositorySnapshot: fixtureSymlinkProp.path,
      upstreamSources: {},
      ascendPairs: {},
      enginePrereleases: [],
      prereleasePackages: [],
      runRoot,
      policyProfile: 'github',
    });
    const symlinkPropRes = await post(service.gateUrl, GATE_SECRET, { ...gateRequest(symlinkPropDigest), runId: 'run-sparse-symlink-prop' });
    assert.equal(symlinkPropRes.status, 200);
    const symlinkPropVerdict = JSON.parse(symlinkPropRes.bytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(symlinkPropVerdict.status, 'denied');
    assert.equal(symlinkPropVerdict.reason, 'candidate snapshot omits .autosync/proposal.json');

    // 5. Baseline where .autosync/proposal.json exceeds 1 MiB is denied with 'candidate .autosync/proposal.json exceeds 1 MiB limit'.
    const fixtureBigProp = await buildFixtureRepository();
    await mkdir(join(fixtureBigProp.path, '.autosync'), { recursive: true });
    await writeFile(join(fixtureBigProp.path, '.autosync', 'proposal.json'), Buffer.alloc(1_048_577, 0x20));
    await gitIn(fixtureBigProp.path, ['add', '.']);
    await gitIn(fixtureBigProp.path, ['commit', '-qm', 'add oversized baseline proposal.json']);
    const headBigProp = (await run('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: fixtureBigProp.path })).stdout.trim();
    const treeBigProp = (await run('/usr/bin/git', ['rev-parse', 'HEAD^{tree}'], { cwd: fixtureBigProp.path })).stdout.trim();
    const bigPropDigest = await writeSparseOverlayRun(
      'run-sparse-big-prop',
      { objectFormat: 'sha1' as const, commitOid: headBigProp, treeOid: treeBigProp },
      [{ name: 'pack/foo.json', bytes: Buffer.from('{"v":6}\n', 'utf8') }],
      [],
    );
    await service.registerCandidate({
      storeId: 'store-1',
      runId: 'run-sparse-big-prop',
      candidateDigest: bigPropDigest,
      identity: { repository: 'example-org/runtime-runner', defaultSha: headBigProp, headSha: headBigProp, mode: 'discover', prNumber: null, commandId: null, commandDigest: null },
      repositorySnapshot: fixtureBigProp.path,
      upstreamSources: {},
      ascendPairs: {},
      enginePrereleases: [],
      prereleasePackages: [],
      runRoot,
      policyProfile: 'github',
    });
    const bigPropRes = await post(service.gateUrl, GATE_SECRET, { ...gateRequest(bigPropDigest), runId: 'run-sparse-big-prop' });
    assert.equal(bigPropRes.status, 200);
    const bigPropVerdict = JSON.parse(bigPropRes.bytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(bigPropVerdict.status, 'denied');
    assert.equal(bigPropVerdict.reason, 'candidate .autosync/proposal.json exceeds 1 MiB limit');
  });

  it('verifies v2 overlay baseTree anchor against registered baseline commit before reading baseline proposal or invoking GATE_DRIVER', { timeout: 240000 }, async () => {
    const { defaultCorpusRoot } = await import('../src/corpus.js');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const corpusRoot = defaultCorpusRoot();
    if (corpusRoot === null) throw new Error('vendored corpus absent');

    const gitIn = async (cwd: string, args: string[]) => {
      await run('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd,
        env: { HOME: cwd, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
      });
    };
    const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

    // Commit A (baseline anchor for the v2 overlay manifest)
    const fixture = await buildFixtureRepository();
    const commitA = fixture.headSha;
    const treeA = (await run('/usr/bin/git', ['rev-parse', `${commitA}^{tree}`], { cwd: fixture.path })).stdout.trim();
    const baseTreeA = { objectFormat: 'sha1' as const, commitOid: commitA, treeOid: treeA };

    // Commit B (different baseline commit that also has a committed .autosync/proposal.json)
    await mkdir(join(fixture.path, '.autosync'), { recursive: true });
    await writeFile(join(fixture.path, '.autosync', 'proposal.json'), await proposalFor(corpusRoot, commitA), 'utf8');
    await writeFile(join(fixture.path, 'pack', 'b.json'), '{"commit":"B"}\n', 'utf8');
    await gitIn(fixture.path, ['add', '.']);
    await gitIn(fixture.path, ['commit', '-qm', 'commit B advances baseline']);
    const commitB = (await run('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: fixture.path })).stdout.trim();
    const treeB = (await run('/usr/bin/git', ['rev-parse', `${commitB}^{tree}`], { cwd: fixture.path })).stdout.trim();
    assert.notEqual(commitA, commitB);
    assert.notEqual(treeA, treeB);

    const runRoot = await mkdtemp(join(await realpath(tmpdir()), 'runner-basetree-mismatch-runs-'));
    await chmod(runRoot, 0o700);
    cleanupRoots.push(runRoot);

    const writeOverlayRun = async (
      runId: string,
      baseTree: { readonly objectFormat: 'sha1' | 'sha256'; readonly commitOid: string; readonly treeOid: string },
    ): Promise<string> => {
      const payload = Buffer.from('{"delta":1}\n', 'utf8');
      const digestHex = sha(payload);
      const manifestEntries = [
        { name: 'pack/delta.json', digest: { algorithm: 'sha256' as const, hex: digestHex }, byteLength: payload.byteLength },
      ];
      const identified = identifyManifest({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'ArtifactManifest',
        metadata: { id: 'candidate' },
        spec: { baseTree, entries: manifestEntries, deleted: [] },
      });
      assert.equal(identified.ok, true, JSON.stringify(identified.ok ? [] : identified.errors));
      if (!identified.ok) throw new Error('overlay manifest invalid');

      const artifactsDir = join(runRoot, runId, 'artifacts');
      const checkpointsDir = join(artifactsDir, 'pi-checkpoints');
      const blobsDir = join(artifactsDir, 'blobs', 'sha256');
      await mkdir(checkpointsDir, { recursive: true, mode: 0o700 });
      await mkdir(blobsDir, { recursive: true, mode: 0o700 });
      const blobPath = join(blobsDir, digestHex);
      await writeFile(blobPath, payload, { mode: 0o600 });
      await chmod(blobPath, 0o400);
      const ref = { name: 'pack/delta.json', digest: { algorithm: 'sha256' as const, hex: digestHex }, byteLength: payload.byteLength };
      const rows = [
        JSON.stringify({ type: 'workspace_snapshot', version: 1, manifest: identified.value.manifest }),
        JSON.stringify({ type: 'file', ref }),
        JSON.stringify({ type: 'blob_ref', ref, blobRef: { ...ref, uri: `cas://sha256/${digestHex}` } }),
        JSON.stringify({ type: 'file_end', byteLength: payload.byteLength, digest: digestHex }),
        JSON.stringify({ type: 'end', files: 1 }),
      ];
      await writeFile(join(checkpointsDir, 'ckpt-1.workspace.ndjson'), rows.join('\n') + '\n', { mode: 0o600 });
      return identified.value.digest.hex;
    };

    const digestAnchoredToA = await writeOverlayRun('run-anchor-a', baseTreeA);
    const digestWrongTree = await writeOverlayRun('run-wrong-tree', { objectFormat: 'sha1', commitOid: commitB, treeOid: treeA });
    const digestWrongFormat = await writeOverlayRun('run-wrong-format', {
      objectFormat: 'sha256',
      commitOid: 'a'.repeat(64),
      treeOid: 'b'.repeat(64),
    });

    // 1. Direct candidateEntriesFromRunArtifacts checks: matching baseline succeeds & exposes baseTree; mismatched commit/tree/format return null.
    const matchedA = await candidateEntriesFromRunArtifacts(
      runRoot,
      'run-anchor-a',
      digestAnchoredToA,
      undefined,
      { policyProfile: 'github' },
      { repository: fixture.path, revision: commitA },
    );
    assert.ok(matchedA !== null);
    assert.deepEqual({ ...matchedA.baseTree }, baseTreeA);

    assert.equal(
      await candidateEntriesFromRunArtifacts(
        runRoot,
        'run-anchor-a',
        digestAnchoredToA,
        undefined,
        { policyProfile: 'github' },
        { repository: fixture.path, revision: commitB },
      ),
      null,
      'overlay anchored to commit A must be rejected when baseline revision is commit B',
    );
    assert.equal(
      await candidateEntriesFromRunArtifacts(
        runRoot,
        'run-wrong-tree',
        digestWrongTree,
        undefined,
        { policyProfile: 'github' },
        { repository: fixture.path, revision: commitB },
      ),
      null,
      'overlay with mismatched treeOid must be rejected',
    );
    assert.equal(
      await candidateEntriesFromRunArtifacts(
        runRoot,
        'run-wrong-format',
        digestWrongFormat,
        undefined,
        { policyProfile: 'github' },
        { repository: fixture.path, revision: commitB },
      ),
      null,
      'overlay with mismatched objectFormat must be rejected',
    );

    // 2. End-to-end gate check: registering commit B while manifest is anchored to commit A denies BEFORE invoking GATE_DRIVER!
    let gateDriverInvocations = 0;
    class CountingGateBridge extends PythonBridge {
      override async run(script: string, opts?: Parameters<PythonBridge['run']>[1]) {
        if (script === GATE_DRIVER) gateDriverInvocations += 1;
        return await super.run(script, opts);
      }
    }
    const bridge = new CountingGateBridge();
    const service = await startRunnerTaskpackService({
      gateSecret: GATE_SECRET,
      publicationSecret: PUBLICATION_SECRET,
      corpusRoot,
      bridge,
    });
    services.push({
      async close() {
        await service.close();
        await bridge.dispose();
      },
    });

    await service.registerCandidate({
      storeId: 'store-1',
      runId: 'run-anchor-a',
      candidateDigest: digestAnchoredToA,
      identity: { repository: 'example-org/runtime-runner', defaultSha: commitB, headSha: commitB, mode: 'discover', prNumber: null, commandId: null, commandDigest: null },
      repositorySnapshot: fixture.path,
      upstreamSources: {},
      ascendPairs: {},
      enginePrereleases: [],
      prereleasePackages: [],
      runRoot,
      policyProfile: 'github',
    });

    const deniedRes = await post(service.gateUrl, GATE_SECRET, { ...gateRequest(digestAnchoredToA), runId: 'run-anchor-a' });
    assert.equal(deniedRes.status, 200);
    const deniedVerdict = JSON.parse(deniedRes.bytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(deniedVerdict.status, 'denied');
    assert.equal(deniedVerdict.reason, 'candidate digest does not match registered candidate snapshot');
    assert.equal(gateDriverInvocations, 0, 'GATE_DRIVER must not be invoked when overlay baseTree mismatches registered baseline');
  });
});
