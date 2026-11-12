import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { bindSubject } from '@loopwright/core';
import { configurationFixture } from './config-fixtures.js';
import { createCycle, Cycle, runCycleWithPorts, type RunCycleInput } from '../src/controller.js';
import { resumeCycle } from '../src/recovery.js';
import { reconcileCycle } from '../src/reconcile.js';
import { preparePublication } from '../src/publication.js';
import { inspectRun } from '../src/inspect.js';
import { signPayload, verifySignedPayload } from '../src/gate.js';
import { canonical, hash } from '../src/schema.js';
import { stateValue } from '../src/storage.js';
import { setFixture } from './progress-fixtures.js';
import type { ControllerEvent } from '../src/events.js';

const PUBLISHER_SECRET = 'PUBLISHER_SIGNING_CANARY_Dd44Ee55Ff66', PUBLISHER_TOKEN = 'PUBLISHER_AUTH_CANARY_Gg77Hh88Ii99', WRONG_SECRET = 'PUBLISHER_WRONG_KEY_Aa11Bb22Cc33';
type OutcomeScript = (request: Record<string, unknown>, attempt: number) => 'succeeded' | 'not_executed' | 'failed' | 'hang' | 'wrong-key';
function publicationServer(script: OutcomeScript): Promise<{ readonly hits: () => number; readonly close: () => Promise<void>; readonly url: string }> {
  return new Promise(resolve => {
    let hits = 0;
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks), attempt = ++hits;
        const signature = request.headers['x-loopwright-signature'];
        if (typeof signature !== 'string' || !verifySignedPayload(PUBLISHER_SECRET, body, signature)) { response.writeHead(403).end(); return; }
        const parsed = JSON.parse(body.toString()) as Record<string, unknown>, directive = script(parsed, attempt);
        if (directive === 'hang') { response.destroy(); return; }
        const receipt = { version: 1, kind: 'publication_receipt', storeId: parsed.storeId, runId: parsed.runId, lockHash: parsed.lockHash, operationId: parsed.operationId, dispatchId: parsed.dispatchId, dispatchGeneration: parsed.dispatchGeneration, idempotencyKey: parsed.idempotencyKey, outcome: directive, externalUrl: directive === 'succeeded' ? 'https://example.internal/pull/7' : null, reason: directive === 'failed' ? 'service refused' : null };
        const bytes = Buffer.from(JSON.stringify(receipt)), key = directive === 'wrong-key' ? WRONG_SECRET : PUBLISHER_SECRET;
        response.writeHead(200, { 'content-type': 'application/json', connection: 'close', 'x-loopwright-signature': signPayload(key, bytes) });
        response.end(bytes);
      })().catch(() => { try { response.writeHead(500).end(); } catch { /* socket already gone */ } });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      hits: () => hits, url: 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/publish',
      close: () => new Promise((done, fail) => { server.closeAllConnections(); server.close(error => error ? fail(error) : done()); }),
    }));
  });
}
async function publicationFixture(url: string, options: { publication?: boolean } = {}) {
  const f = await configurationFixture();
  f.environment.PUBLISHER_SECRET = PUBLISHER_SECRET; f.environment.PUBLISHER_TOKEN = PUBLISHER_TOKEN;
  setFixture(f.registry, ['spec', 'credentialBindings'], [...f.registry.spec.credentialBindings,
    { id: 'publisher-signer', consumer: 'publisher', destinationRef: 'publisher-service', environmentNames: ['PUBLISHER_SECRET'], template: '${PUBLISHER_SECRET}' },
    { id: 'publisher-auth', consumer: 'publisher', destinationRef: 'publisher-service', environmentNames: ['PUBLISHER_TOKEN'], template: '${PUBLISHER_TOKEN}' }]);
  setFixture(f.registry, ['spec', 'environmentBindings'], [{ name: 'PROVIDER_TOKEN', classification: 'credential', paths: [] },
    { name: 'PUBLISHER_SECRET', classification: 'credential', paths: ['/spec/credentials/0/template'] }, { name: 'PUBLISHER_TOKEN', classification: 'credential', paths: ['/spec/credentials/1/template'] }]);
  if (options.publication !== false) {
    setFixture(f.config, ['spec', 'credentials'], [{ ref: 'publisher-signer', template: '${PUBLISHER_SECRET}' }, { ref: 'publisher-auth', template: '${PUBLISHER_TOKEN}' }]);
    setFixture(f.registry, ['spec', 'publicationEndpoints'], [{ id: 'pr-publisher', url, signingCredentialRef: 'publisher-signer', authCredentialRef: 'publisher-auth', timeoutMs: 2000 }]);
    setFixture(f.config, ['spec', 'publication'], { mode: 'pull_request', endpointRef: 'pr-publisher', targetBranch: 'main', headBranchPrefix: 'loopwright/', titleTemplate: 'Loopwright run publication' });
  } else setFixture(f.config, ['spec', 'credentials'], []);
  setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [{ id: 'verify', kind: 'check', uses: 'tests', roleId: null, dependsOn: [] }]);
  setFixture(f.config, ['spec', 'profiles', 'steps'], [{ stepId: 'verify', handlerRef: 'tests' }]);
  const repository = join(f.root, 'repository'), runRoot = join(f.root, 'runs');
  await mkdir(repository, { mode: 0o700 });
  const git = (args: string[]) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repository, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: '/nonexistent', GIT_TERMINAL_PROMPT: '0' }, timeout: 5000, encoding: 'utf8' });
  git(['init', '-q']); await writeFile(join(repository, 'result.json'), JSON.stringify({ ok: true }), { mode: 0o600 }); git(['add', 'result.json']);
  git(['-c', 'user.name=Controller Fixture', '-c', 'user.email=fixture@localhost.invalid', 'commit', '-qm', 'freeze inert input']);
  const revision = git(['rev-parse', 'HEAD']).trim();
  setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], revision); setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], revision);
  await f.save(); const loaded = await f.load(); assert.equal(loaded.ok, true); if (!loaded.ok) throw new Error('fixture');
  return { ...f, repository, runRoot, loaded: loaded.value };
}
function input(f: Awaited<ReturnType<typeof publicationFixture>>, runId: string, onEvent?: (event: ControllerEvent) => Promise<void>, signal?: AbortSignal): RunCycleInput {
  return { configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId, ...(onEvent ? { onEvent } : {}), ...(signal ? { signal } : {}) };
}
async function cycle(input_: RunCycleInput) {
  const result = await runCycleWithPorts(input_);
  assert.equal(result.ok, true);
  assert.equal(result.value.kind, 'result', JSON.stringify(result.value).slice(0, 600));
  return result.value;
}
test('an eligible completed run publishes once, settles externalEffects, and exports publication.json', async () => {
  const publisher = await publicationServer(() => 'succeeded');
  let f: Awaited<ReturnType<typeof publicationFixture>> | null = null;
  try {
    f = await publicationFixture(publisher.url);
    const seen: string[] = [], execution = await cycle(input(f, 'run-pub-success', async event => { seen.push(event.stage); }));
    assert.equal(execution.kind, 'result'); if (execution.kind !== 'result') return;
    assert.equal(execution.result.spec.status, 'completed');
    assert.equal(execution.result.spec.externalEffects, 'confirmed');
    assert.ok(seen.includes('publication'));
    const inspected = await inspectRun({ runRoot: f.runRoot, runId: 'run-pub-success' });
    assert.ok(inspected.ok && inspected.value.manifest !== null); if (!inspected.ok || !inspected.value.manifest) return;
    const publication = inspected.value.manifest.entries.find(entry => entry.name === 'publication.json');
    assert.ok(publication && publication.presence === 'present');
    assert.ok(!JSON.stringify(inspected.value).includes(PUBLISHER_SECRET));
    assert.equal(publisher.hits(), 1);
  } finally { if (f) await f.cleanup(); await publisher.close(); }
});
test('disabled publication never dispatches and records not_run with the disabled reason', async () => {
  const publisher = await publicationServer(() => 'succeeded');
  let f: Awaited<ReturnType<typeof publicationFixture>> | null = null;
  try {
    f = await publicationFixture(publisher.url, { publication: false });
    const execution = await cycle(input(f, 'run-pub-disabled'));
    assert.equal(execution.kind, 'result'); if (execution.kind !== 'result') return;
    assert.equal(execution.result.spec.status, 'completed');
    assert.equal(execution.result.spec.externalEffects, 'none');
    const inspected = await inspectRun({ runRoot: f.runRoot, runId: 'run-pub-disabled' });
    assert.ok(inspected.ok && inspected.value.manifest !== null); if (!inspected.ok || !inspected.value.manifest) return;
    const publication = inspected.value.manifest.entries.find(entry => entry.name === 'publication.json');
    assert.ok(publication && publication.presence === 'not_run' && publication.reason === 'disabled');
    assert.equal(publisher.hits(), 0);
  } finally { if (f) await f.cleanup(); await publisher.close(); }
});
test('an authenticated not_executed receipt settles externalEffects to none with a failed run', async () => {
  const publisher = await publicationServer(() => 'not_executed');
  let f: Awaited<ReturnType<typeof publicationFixture>> | null = null;
  try {
    f = await publicationFixture(publisher.url);
    const execution = await cycle(input(f, 'run-pub-not-executed'));
    assert.equal(execution.kind, 'result'); if (execution.kind !== 'result') return;
    assert.equal(execution.result.spec.status, 'failed');
    assert.equal(execution.result.spec.externalEffects, 'none');
    const bundle = join(f.root, 'bundle-not-executed'), inspected = await inspectRun({ runRoot: f.runRoot, runId: 'run-pub-not-executed', output: bundle });
    assert.ok(inspected.ok && inspected.value.manifest !== null); if (!inspected.ok || !inspected.value.manifest) return;
    const publicationDoc = JSON.parse(await readFile(join(bundle, 'publication.json'), 'utf8')) as { status: string };
    assert.equal(publicationDoc.status, 'failed');
    assert.equal(publisher.hits(), 1);
  } finally { if (f) await f.cleanup(); await publisher.close(); }
});
test('a timed out publication marks the operation unresolved, forces reconcile_required, and resume never re-dispatches', async () => {
  const publisher = await publicationServer(request => request.idempotencyKey ? 'hang' : 'succeeded');
  let f: Awaited<ReturnType<typeof publicationFixture>> | null = null;
  try {
    f = await publicationFixture(publisher.url);
    const execution = await cycle(input(f, 'run-pub-timeout'));
    assert.equal(execution.kind, 'result'); if (execution.kind !== 'result') return;
    assert.equal(execution.result.spec.status, 'reconcile_required');
    assert.equal(execution.result.spec.externalEffects, 'unknown');
    const afterRun = publisher.hits(), resumed = await resumeCycle(input(f, 'run-pub-timeout'));
    assert.ok(resumed.ok && resumed.value.kind === 'result', JSON.stringify(resumed.ok ? resumed.value : resumed.error).slice(0, 600));
    if (!resumed.ok || resumed.value.kind !== 'result') return;
    assert.equal(resumed.value.result.spec.status, 'reconcile_required');
    assert.equal(publisher.hits(), afterRun);
  } finally { if (f) await f.cleanup(); await publisher.close(); }
});
test('a publication response with an invalid signature leaves the operation unresolved and fails closed', async () => {
  const publisher = await publicationServer(() => 'wrong-key');
  let f: Awaited<ReturnType<typeof publicationFixture>> | null = null;
  try {
    f = await publicationFixture(publisher.url);
    const execution = await cycle(input(f, 'run-pub-wrong-key'));
    assert.equal(execution.kind, 'result'); if (execution.kind !== 'result') return;
    assert.equal(execution.result.spec.status, 'reconcile_required');
    assert.equal(execution.result.spec.externalEffects, 'unknown');
    assert.equal(publisher.hits(), 1);
  } finally { if (f) await f.cleanup(); await publisher.close(); }
});
test('the publication POST timeout clamps to the remaining task window and a later receipt still settles completed', { timeout: 30000 }, async () => {
  let captured: Record<string, unknown> | null = null, hits = 0;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks); hits++;
      const signature = request.headers['x-loopwright-signature'];
      if (typeof signature !== 'string' || !verifySignedPayload(PUBLISHER_SECRET, body, signature)) { response.writeHead(403).end(); return; }
      captured = JSON.parse(body.toString()) as Record<string, unknown>;
      // Answer slower than the clamped window: the response can never be processed in-run.
      await new Promise(resolve => setTimeout(resolve, 6000));
      const receipt = { version: 1, kind: 'publication_receipt', storeId: captured.storeId, runId: captured.runId, lockHash: captured.lockHash, operationId: captured.operationId, dispatchId: captured.dispatchId, dispatchGeneration: captured.dispatchGeneration, idempotencyKey: captured.idempotencyKey, outcome: 'succeeded', externalUrl: 'https://example.internal/pull/7', reason: null };
      const bytes = Buffer.from(JSON.stringify(receipt));
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close', 'x-loopwright-signature': signPayload(PUBLISHER_SECRET, bytes) });
      response.end(bytes);
    })().catch(() => { try { response.writeHead(500).end(); } catch { /* socket already gone */ } });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/publish';
  let f: Awaited<ReturnType<typeof publicationFixture>> | null = null;
  try {
    f = await publicationFixture(url);
    // timeoutMs 60000 with wallTimeMs 128000 clamps the POST window to ~3s at the boundary (128s budget minus the
    // ~2.5s already spent, minus the 120s drain reserve and its 2s margin) — the task window, not the endpoint, binds.
    setFixture(f.registry, ['spec', 'publicationEndpoints'], [{ id: 'pr-publisher', url, signingCredentialRef: 'publisher-signer', authCredentialRef: 'publisher-auth', timeoutMs: 60000 }]);
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'wallTimeMs'], 128000);
    await f.save(); const loaded = await f.load(); assert.ok(loaded.ok); if (!loaded.ok) return;
    f.loaded = loaded.value;
    const started = Date.now(), execution = await cycle(input(f, 'run-pub-clamp'));
    assert.ok(Date.now() - started < 10000);
    assert.equal(execution.kind, 'result'); if (execution.kind !== 'result') return;
    // The clamp settles reconcile_required cleanly; without it the expired permit would surface AUTHORITY_REFUSED.
    assert.equal(execution.result.spec.status, 'reconcile_required');
    assert.equal(execution.result.spec.externalEffects, 'unknown');
    assert.equal(hits, 1);
    const request = captured as Record<string, unknown> | null; assert.ok(request !== null);
    const receipt = { version: 1, kind: 'publication_receipt', storeId: request.storeId, runId: request.runId, lockHash: request.lockHash, operationId: request.operationId, dispatchId: request.dispatchId, dispatchGeneration: request.dispatchGeneration, idempotencyKey: request.idempotencyKey, candidateDigest: request.candidateDigest, outcome: 'succeeded', externalUrl: 'https://example.internal/pull/7', reason: null };
    const receiptPath = join(f.root, 'clamp-receipt.json');
    await writeFile(receiptPath, JSON.stringify({ ...receipt, signature: signPayload(PUBLISHER_SECRET, canonical(receipt)) }), { mode: 0o600 });
    const reconciled = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId: 'run-pub-clamp', receipt: receiptPath });
    assert.ok(reconciled.ok && reconciled.value.kind === 'settled', JSON.stringify(reconciled.ok ? reconciled.value : reconciled.error).slice(0, 400));
    if (!reconciled.ok || reconciled.value.kind !== 'settled') return;
    assert.equal(reconciled.value.status, 'completed');
    assert.equal(reconciled.value.externalEffects, 'confirmed');
    assert.equal(hits, 1);
    await rm(receiptPath, { force: true });
  } finally { if (f) await f.cleanup(); server.closeAllConnections(); server.close(); }
});
test('Publication.run clamps to the permit lease and demotes a response that arrives after the permit expires', { timeout: 20000 }, async () => {
  // Parked at publication_pre via the real bootstrap + graph, then Publication.run is driven directly.
  const parked = async function (runId: string, url: string) {
    const f = await publicationFixture(url);
    let context: Awaited<ReturnType<typeof createCycle>> | undefined;
    try {
      context = await createCycle(input(f, runId), {});
      const cycle = new Cycle(context);
      await cycle.bootstrap();
      await cycle.graph();
      const endpoint = f.loaded.registry.spec.publicationEndpoints[0]!;
      const bound = bindSubject(context.lock, cycle.candidate.manifest); assert.ok(bound.ok); if (!bound.ok) throw new Error('fixture');
      const view = stateValue(context.store.inspect());
      const prepared = preparePublication(context.plan, context.lock, view.storeId, endpoint, bound.value);
      await cycle.events.push('publication', null);
      await cycle.publish({ ...cycle.draft, stage: { ...cycle.draft.stage, kind: 'publication_pre' as const }, publication: { status: 'pending' as const, operationId: prepared.operationId, receipt: null } }, 'publication.pre');
      return { f, context, cycle, endpoint, prepared };
    } catch (error) {
      context?.store.close();
      await context?.owner.release().catch(() => {});
      await f.cleanup().catch(() => {});
      throw error;
    }
  };
  // Permit-lease clamp: notAfter forced to now + 2400ms clamps timeoutMs 60000 to ~400ms against a 1500ms publisher.
  {
    let hits = 0;
    const slow = createServer((request: IncomingMessage, response: ServerResponse) => {
      void (async () => { for await (const chunk of request) void chunk; hits++; await new Promise(resolve => setTimeout(resolve, 1500)); try { response.writeHead(200, { 'content-type': 'application/json', connection: 'close' }).end('{"late":true}'); } catch { /* gone */ } })().catch(() => {});
    });
    let state: Awaited<ReturnType<typeof parked>> | undefined;
    try {
      await new Promise<void>(resolve => slow.listen(0, '127.0.0.1', resolve));
      state = await parked('run-permit-clamp', 'http://127.0.0.1:' + (slow.address() as { port: number }).port + '/publish');
      const { context, cycle, endpoint, prepared } = state;
      const original = context.store.authorizeOperationDispatch.bind(context.store);
      (context.store as unknown as Record<string, unknown>).authorizeOperationDispatch = (authority: unknown, operationId: string) => {
        const dispatched = original(authority as never, operationId);
        if (!dispatched.ok || dispatched.value.kind !== 'new_dispatch') return dispatched;
        const now = BigInt(stateValue(context.store.inspect()).clock.sampledNow.monotonicMs);
        return { ok: true as const, value: { ...dispatched.value, permit: { ...dispatched.value.permit, notAfterMonotonicMs: String(now + 2400n) } } };
      };
      const started = Date.now();
      const execution = await cycle.publisher.run(prepared, endpoint, new AbortController().signal) as { kind: string; reason?: string };
      (context.store as unknown as Record<string, unknown>).authorizeOperationDispatch = original;
      assert.ok(Date.now() - started < 1200);
      assert.equal(execution.kind, 'unresolved');
      assert.equal(execution.reason, 'timeout');
      assert.equal(hits, 1);
    } finally {
      state?.context.store.close();
      await state?.context.owner.release().catch(() => {});
      await state?.f.cleanup();
      slow.closeAllConnections();
      slow.close();
    }
  }
  // Post-fetch permit-expiry demotion: an immediate succeeded response is demoted because the post-fetch view reads sampledNow >= notAfter.
  {
    let saw = false, hits = 0;
    const publisher = createServer((request: IncomingMessage, response: ServerResponse) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks); saw = true; hits++;
        const signature = request.headers['x-loopwright-signature'];
        if (typeof signature !== 'string' || !verifySignedPayload(PUBLISHER_SECRET, body, signature)) { response.writeHead(403).end(); return; }
        const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
        const receipt = { version: 1, kind: 'publication_receipt', storeId: parsed.storeId, runId: parsed.runId, lockHash: parsed.lockHash, operationId: parsed.operationId, dispatchId: parsed.dispatchId, dispatchGeneration: parsed.dispatchGeneration, idempotencyKey: parsed.idempotencyKey, candidateDigest: parsed.candidateDigest, outcome: 'succeeded', externalUrl: 'https://x/pull/42', reason: null };
        const bytes = Buffer.from(JSON.stringify(receipt));
        response.writeHead(200, { 'content-type': 'application/json', connection: 'close', 'x-loopwright-signature': signPayload(PUBLISHER_SECRET, bytes) });
        response.end(bytes);
      })().catch(() => { try { response.writeHead(500).end(); } catch { /* socket already gone */ } });
    });
    let state: Awaited<ReturnType<typeof parked>> | undefined;
    try {
      await new Promise<void>(resolve => publisher.listen(0, '127.0.0.1', resolve));
      state = await parked('run-permit-expired', 'http://127.0.0.1:' + (publisher.address() as { port: number }).port + '/publish');
      const { context, cycle, endpoint, prepared } = state;
      let forcedNotAfter: string | null = null;
      const originalInspect = context.store.inspect.bind(context.store);
      (context.store as unknown as Record<string, unknown>).inspect = () => {
        const view = originalInspect();
        if (!view.ok) return view;
        // Force only after the server has seen the request (every in-run inspect before the fetch must read real time).
        if (saw && forcedNotAfter !== null && BigInt(view.value.clock.sampledNow.monotonicMs) < BigInt(forcedNotAfter)) {
          return { ok: true as const, value: { ...view.value, clock: { ...view.value.clock, sampledNow: { ...view.value.clock.sampledNow, monotonicMs: forcedNotAfter } } } };
        }
        return view;
      };
      const originalDispatch = context.store.authorizeOperationDispatch.bind(context.store);
      (context.store as unknown as Record<string, unknown>).authorizeOperationDispatch = (authority: unknown, operationId: string) => {
        const dispatched = originalDispatch(authority as never, operationId);
        if (!dispatched.ok || dispatched.value.kind !== 'new_dispatch') return dispatched;
        forcedNotAfter = String(dispatched.value.permit.notAfterMonotonicMs);
        return dispatched;
      };
      const execution = await cycle.publisher.run(prepared, endpoint, new AbortController().signal) as { kind: string; reason?: string };
      (context.store as unknown as Record<string, unknown>).inspect = originalInspect;
      (context.store as unknown as Record<string, unknown>).authorizeOperationDispatch = originalDispatch;
      assert.equal(execution.kind, 'unresolved');
      assert.equal(execution.reason, 'timeout');
      assert.equal(hits, 1);
      const proofPath = join(context.artifacts.directory, 'publication-producer-' + hash(prepared.operationId).hex + '.proof.json');
      const proof = JSON.parse(await readFile(proofPath, 'utf8')) as { receipt: string | null; evidence: string | null };
      assert.equal(proof.receipt, null);
      assert.equal(proof.evidence, null);
    } finally {
      state?.context.store.close();
      await state?.context.owner.release().catch(() => {});
      await state?.f.cleanup();
      publisher.closeAllConnections();
      publisher.close();
    }
  }
});
