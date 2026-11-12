import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { compilePlan, loadTrustedConfiguration, signPayload, verifySignedPayload } from '@loopwright/controller';
import { RUNNER_PROPOSAL_PATH, RUNNER_PROPOSAL_REQUIRED_FIELDS, compileRunnerTaskpack } from '../src/compile-taskpack.js';
import { computeRunnerCandidateDigest, startRunnerTaskpackService } from '../src/service.js';

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
});
