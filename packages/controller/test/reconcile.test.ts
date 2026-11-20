import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { constants } from 'node:fs';
import { mkdir, open as fsOpen, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { bindSubject } from '@loopwright/core';
import { configurationFixture } from './config-fixtures.js';
import { createCycle, Cycle, runCycleWithPorts, type RunCycleInput } from '../src/controller.js';
import { reconcileCycle } from '../src/reconcile.js';
import { resumeCycle } from '../src/recovery.js';
import { inspectRun, readStatus } from '../src/inspect.js';
import { preparePublication } from '../src/publication.js';
import { prepareGate } from '../src/gate.js';
import { incident } from '../src/finalize.js';
import { installedHandlerDigests } from '../src/handlers.js';
import { signGateVerdict, signPayload, verifySignedPayload } from '../src/gate.js';
import { canonical, hash } from '../src/schema.js';
import { stateValue } from '../src/storage.js';
import { setFixture } from './progress-fixtures.js';

const PUBLISHER_SECRET = 'PUBLISHER_SIGNING_CANARY_Dd44Ee55Ff66', PUBLISHER_TOKEN = 'PUBLISHER_AUTH_CANARY_Gg77Hh88Ii99';
const GATE_SECRET = 'GATE_SIGNING_CANARY_Ee11Ff22Gg33';
function publicationServer(): Promise<{ readonly hits: () => number; readonly close: () => Promise<void>; readonly url: string; readonly request: () => Record<string, unknown> | null }> {
  return new Promise(resolve => {
    let hits = 0, captured: Record<string, unknown> | null = null;
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        hits++;
        const signature = request.headers['x-loopwright-signature'];
        if (typeof signature !== 'string' || !verifySignedPayload(PUBLISHER_SECRET, Buffer.concat(chunks), signature)) { response.writeHead(403).end(); return; }
        captured = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        response.destroy();
      })().catch(() => { try { response.writeHead(500).end(); } catch { /* socket already gone */ } });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      hits: () => hits, request: () => captured, url: 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/publish',
      close: () => new Promise((done, fail) => { server.closeAllConnections(); server.close(error => error ? fail(error) : done()); }),
    }));
  });
}
async function publicationFixture(url: string) {
  const f = await configurationFixture();
  f.environment.PUBLISHER_SECRET = PUBLISHER_SECRET; f.environment.PUBLISHER_TOKEN = PUBLISHER_TOKEN;
  setFixture(f.registry, ['spec', 'credentialBindings'], [...f.registry.spec.credentialBindings,
    { id: 'publisher-signer', consumer: 'publisher', destinationRef: 'publisher-service', environmentNames: ['PUBLISHER_SECRET'], template: '${PUBLISHER_SECRET}' },
    { id: 'publisher-auth', consumer: 'publisher', destinationRef: 'publisher-service', environmentNames: ['PUBLISHER_TOKEN'], template: '${PUBLISHER_TOKEN}' }]);
  setFixture(f.registry, ['spec', 'environmentBindings'], [{ name: 'PROVIDER_TOKEN', classification: 'credential', paths: [] },
    { name: 'PUBLISHER_SECRET', classification: 'credential', paths: ['/spec/credentials/0/template'] }, { name: 'PUBLISHER_TOKEN', classification: 'credential', paths: ['/spec/credentials/1/template'] }]);
  setFixture(f.config, ['spec', 'credentials'], [{ ref: 'publisher-signer', template: '${PUBLISHER_SECRET}' }, { ref: 'publisher-auth', template: '${PUBLISHER_TOKEN}' }]);
  setFixture(f.registry, ['spec', 'publicationEndpoints'], [{ id: 'pr-publisher', url, signingCredentialRef: 'publisher-signer', authCredentialRef: 'publisher-auth', timeoutMs: 2000 }]);
  setFixture(f.config, ['spec', 'publication'], { mode: 'pull_request', endpointRef: 'pr-publisher', targetBranch: 'main', headBranchPrefix: 'loopwright/', titleTemplate: 'Loopwright run publication' });
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
function input(f: Awaited<ReturnType<typeof publicationFixture>>, runId: string): RunCycleInput {
  return { configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId };
}
function receiptBody(captured: Record<string, unknown>, outcome: 'succeeded' | 'not_executed'): Record<string, unknown> {
  return { version: 1, kind: 'publication_receipt', storeId: captured.storeId, runId: captured.runId, lockHash: captured.lockHash, operationId: captured.operationId, dispatchId: captured.dispatchId, dispatchGeneration: captured.dispatchGeneration, idempotencyKey: captured.idempotencyKey, outcome, externalUrl: outcome === 'succeeded' ? 'https://x/pull/3' : null, reason: null };
}
test('reconciliation settles an interrupted publication from an operator receipt, idempotently, and refuses conflicts', async () => {
  const publisher = await publicationServer();
  let f: Awaited<ReturnType<typeof publicationFixture>> | null = null;
  try {
    f = await publicationFixture(publisher.url); assert.ok(f !== null); if (f === null) return;
    const runId = 'run-reconcile', execution = await runCycleWithPorts(input(f, runId));
    assert.equal(execution.ok, true); if (!execution.ok) return;
    assert.equal(execution.value.kind, 'result'); if (execution.value.kind !== 'result') return;
    assert.equal(execution.value.result.spec.status, 'reconcile_required');
    const request = publisher.request(); assert.ok(request);
    const receiptPath = join(f.root, 'receipt-succeeded.json');
    await writeFile(receiptPath, JSON.stringify({ ...receiptBody(request, 'succeeded'), signature: signPayload(PUBLISHER_SECRET, canonical(receiptBody(request, 'succeeded'))) }), { mode: 0o600 });
    const reconciled = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId, receipt: receiptPath });
    assert.ok(reconciled.ok && reconciled.value.kind === 'settled', JSON.stringify(reconciled.ok ? reconciled.value : reconciled.error).slice(0, 400));
    if (!reconciled.ok || reconciled.value.kind !== 'settled') return;
    assert.equal(reconciled.value.status, 'completed'); assert.equal(reconciled.value.externalEffects, 'confirmed');
    const again = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId, receipt: receiptPath });
    assert.ok(again.ok && again.value.kind === 'settled');
    const status = await readStatus({ runRoot: f.runRoot, runId });
    assert.ok(status.ok && status.value.source === 'current' && status.value.status === 'completed');
    const bundle = join(f.root, 'bundle'), inspected = await inspectRun({ runRoot: f.runRoot, runId, output: bundle });
    assert.ok(inspected.ok && inspected.value.manifest !== null); if (!inspected.ok || !inspected.value.manifest) return;
    assert.ok(inspected.value.manifest.entries.find(entry => entry.name === 'publication.json')?.presence === 'present');
    const settledResult = JSON.parse(await import('node:fs/promises').then(module => module.readFile(join(bundle, 'result.json'), 'utf8'))) as { spec: { status: string; externalEffects: string } };
    assert.equal(settledResult.spec.status, 'completed'); assert.equal(settledResult.spec.externalEffects, 'confirmed');
    assert.ok(!JSON.stringify(inspected.value).includes(PUBLISHER_SECRET));
    const conflictPath = join(f.root, 'receipt-conflict.json');
    await writeFile(conflictPath, JSON.stringify({ ...receiptBody(request, 'not_executed'), signature: signPayload(PUBLISHER_SECRET, canonical(receiptBody(request, 'not_executed'))) }), { mode: 0o600 });
    const conflict = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId, receipt: conflictPath });
    assert.ok(!conflict.ok && conflict.error.code === 'RECEIPT_CONFLICT', JSON.stringify(conflict.ok ? conflict.value : conflict.error).slice(0, 200));
  } finally { if (f) await f.cleanup(); await publisher.close(); }
});
test('an authenticated not_executed operator receipt settles the run as failed', async () => {
  const publisher = await publicationServer();
  let f: Awaited<ReturnType<typeof publicationFixture>> | null = null;
  try {
    f = await publicationFixture(publisher.url); assert.ok(f !== null); if (f === null) return;
    const runId = 'run-reconcile-not-executed', execution = await runCycleWithPorts(input(f, runId));
    assert.equal(execution.ok, true); if (!execution.ok) return;
    const request = publisher.request(); assert.ok(request);
    const receiptPath = join(f.root, 'receipt-not-executed.json');
    await writeFile(receiptPath, JSON.stringify({ ...receiptBody(request, 'not_executed'), signature: signPayload(PUBLISHER_SECRET, canonical(receiptBody(request, 'not_executed'))) }), { mode: 0o600 });
    const reconciled = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId, receipt: receiptPath });
    assert.ok(reconciled.ok && reconciled.value.kind === 'settled');
    if (!reconciled.ok || reconciled.value.kind !== 'settled') return;
    assert.equal(reconciled.value.status, 'failed'); assert.equal(reconciled.value.outcome, 'not_executed'); assert.equal(reconciled.value.externalEffects, 'none');
  } finally { if (f) await f.cleanup(); await publisher.close(); }
});
test('a receipt with a bad signature or wrong binding refuses without settling', async () => {
  const publisher = await publicationServer();
  let f: Awaited<ReturnType<typeof publicationFixture>> | null = null;
  try {
    f = await publicationFixture(publisher.url); assert.ok(f !== null); if (f === null) return;
    const runId = 'run-reconcile-bad', execution = await runCycleWithPorts(input(f, runId));
    assert.equal(execution.ok, true); if (!execution.ok) return;
    const request = publisher.request(); assert.ok(request);
    const tamperedPath = join(f.root, 'receipt-tampered.json');
    await writeFile(tamperedPath, JSON.stringify({ ...receiptBody(request, 'succeeded'), signature: signPayload('PUBLISHER_WRONG_KEY_Aa11Bb22Cc33', canonical(receiptBody(request, 'succeeded'))) }), { mode: 0o600 });
    const tampered = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId, receipt: tamperedPath });
    assert.ok(!tampered.ok && tampered.error.code === 'EVIDENCE_UNAVAILABLE');
    const wrongIdPath = join(f.root, 'receipt-wrong-id.json');
    const mismatched = { ...receiptBody(request, 'succeeded'), idempotencyKey: 'pub.' + '0'.repeat(40) };
    await writeFile(wrongIdPath, JSON.stringify({ ...mismatched, signature: signPayload(PUBLISHER_SECRET, canonical(receiptBody(request, 'succeeded'))) }), { mode: 0o600 });
    const wrong = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId, receipt: wrongIdPath });
    assert.ok(!wrong.ok && wrong.error.code === 'EVIDENCE_UNAVAILABLE');
    assert.equal(publisher.hits(), 1);
  } finally { if (f) await f.cleanup(); await publisher.close(); }
});
test('a missing receipt file refuses with EVIDENCE_UNAVAILABLE at /receipt, including via a /tmp receipt path', async () => {
  const publisher = await publicationServer();
  let f: Awaited<ReturnType<typeof publicationFixture>> | null = null;
  try {
    f = await publicationFixture(publisher.url); assert.ok(f !== null); if (f === null) return;
    const reconciled = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId: 'run-unreachable', receipt: join(f.root, 'missing.json') });
    assert.ok(!reconciled.ok && reconciled.error.code === 'EVIDENCE_UNAVAILABLE' && reconciled.error.path === '/receipt', JSON.stringify(reconciled.ok ? reconciled.value : reconciled.error).slice(0, 200));
    const viaTmp = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId: 'run-unreachable', receipt: join(tmpdir(), 's05-missing-' + process.pid + '.json') });
    assert.ok(!viaTmp.ok && viaTmp.error.code === 'EVIDENCE_UNAVAILABLE' && viaTmp.error.path === '/receipt');
  } finally { if (f) await f.cleanup(); await publisher.close(); }
});
/** Simulates a SIGKILL mid-POST in-process: real verify retained, publication_pre checkpoint, external_write intent + dispatch, binding marker, no proof, no receipt. With `terminal`, the run is terminalized with an immutable incident before release. */
async function crashMidPublication(f: Awaited<ReturnType<typeof publicationFixture>>, runId: string, terminal = false) {
  const context = await createCycle(input(f, runId), {});
  const cycle = new Cycle(context);
  await cycle.bootstrap();
  await cycle.graph();
  const endpoint = f.loaded.registry.spec.publicationEndpoints[0]!;
  const bound = bindSubject(context.lock, cycle.candidate.manifest); assert.ok(bound.ok); if (!bound.ok) throw new Error('fixture');
  const view = stateValue(context.store.inspect());
  const prepared = preparePublication(context.plan, context.lock, view.storeId, endpoint, bound.value);
  await cycle.events.push('publication', null);
  await cycle.publish({ ...cycle.draft, stage: { ...cycle.draft.stage, kind: 'publication_pre' as const }, publication: { status: 'pending' as const, operationId: prepared.operationId, receipt: null } }, 'publication.pre');
  stateValue(context.store.putIntent(context.authority, { operationId: prepared.operationId, nodeId: context.plan.orderedDAG[0]!.id, attemptId: prepared.idempotencyKey, effect: 'external_write', requestDigest: prepared.requestDigest, targetIdentity: 'publication:' + runId + ':' + bound.value.candidateDigest.hex }));
  const dispatched = stateValue(context.store.authorizeOperationDispatch(context.authority, prepared.operationId)); if (dispatched.kind !== 'new_dispatch') throw new Error('fixture');
  const operation = stateValue(context.store.getOperation(prepared.operationId));
  const request: Record<string, unknown> = { version: 1, kind: 'publication_request', storeId: view.storeId, runId, lockHash: context.lock.spec.lockHash, operationId: prepared.operationId, dispatchId: dispatched.permit.dispatchId, dispatchGeneration: dispatched.permit.generation, idempotencyKey: prepared.idempotencyKey, targetBranch: 'main', headBranch: prepared.headBranch, title: prepared.title, candidateDigest: bound.value.candidateDigest.hex, baseRevision: context.plan.task.spec.target.baseRevision, sourceRevision: context.plan.task.spec.target.sourceRevision, requestDigest: prepared.requestDigest.hex };
  const bindingPath = join(context.artifacts.directory, 'publication-producer-' + hash(prepared.operationId).hex + '.binding.json');
  await writeFile(bindingPath, canonical({ version: 1, planDigest: context.plan.planDigest, operationId: prepared.operationId, requestDigest: prepared.requestDigest, requestBytesDigest: hash(Buffer.from(canonical(request))).hex, intentDigest: operation.intentDigest, subject: bound.value, endpoint: endpoint.id,
    dispatchReceipt: { generation: dispatched.permit.generation, dispatchId: dispatched.permit.dispatchId, revision: dispatched.permit.authorizedRevision, clockEpoch: dispatched.permit.clockEpoch } }), { mode: 0o600 });
  if (terminal) {
    const terminated = await cycle.terminal(incident({ version: 1, code: 'RECOVERY_REQUIRED', phase: 'execution', path: '', stateCode: null, piCode: null, effect: 'none', retryable: false }, context.lock.spec.runId, context.lock.spec.lockHash, [context.descriptor.plan, context.source.inventory], ['authoritative_result'], 'complete'));
    assert.equal(terminated.kind, 'incident');
  }
  // Sealing is the only way to drop the owner's local-activity hold; the sealed bytes are restored as a fresh
  // controller-events.open so the delegated resume revalidates the same pre-seal event stream a SIGKILL leaves behind.
  const events = await cycle.events.close();
  const restored = await fsOpen(join(context.artifacts.directory, 'controller-events.open'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await restored.writeFile(await readFile(join(context.artifacts.directory, events.name))); await restored.sync(); } finally { await restored.close(); }
  stateValue(context.store.release(context.authority));
  stateValue(context.store.close());
  await context.owner.release();
  return request as Record<string, unknown> & { runId: string; storeId: string; lockHash: { algorithm: 'sha256'; hex: string }; operationId: string; dispatchId: string; dispatchGeneration: number; idempotencyKey: string; candidateDigest: string };
}
test('reconciliation settles a mid-POST publication crash before resume, idempotently, and refuses conflicts', async () => {
  const publisher = await publicationServer();
  const f = await publicationFixture(publisher.url);
  try {
    const crash = await crashMidPublication(f, 'run-mid-post');
    const body = { version: 1, kind: 'publication_receipt', storeId: crash.storeId, runId: crash.runId, lockHash: crash.lockHash, operationId: crash.operationId, dispatchId: crash.dispatchId, dispatchGeneration: crash.dispatchGeneration, idempotencyKey: crash.idempotencyKey, candidateDigest: crash.candidateDigest, outcome: 'succeeded', externalUrl: 'https://x/pull/3', reason: null };
    const wrongBody = { ...body, candidateDigest: 'f'.repeat(64) };
    const wrongPath = '/tmp/s05-mid-post-bad-' + process.pid + '.json';
    await writeFile(wrongPath, JSON.stringify({ ...wrongBody, signature: signPayload(PUBLISHER_SECRET, canonical(wrongBody)) }), { mode: 0o600 });
    const wrong = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId: crash.runId, receipt: wrongPath });
    assert.ok(!wrong.ok && wrong.error.code === 'EVIDENCE_UNAVAILABLE' && wrong.error.path === '/receipt');
    const receiptPath = '/tmp/s05-mid-post-' + process.pid + '.json';
    await writeFile(receiptPath, JSON.stringify({ ...body, signature: 'sha256=' + signPayload(PUBLISHER_SECRET, canonical(body)) }), { mode: 0o600 });
    const reconciled = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId: crash.runId, receipt: receiptPath });
    assert.ok(reconciled.ok && reconciled.value.kind === 'settled', JSON.stringify(reconciled.ok ? reconciled.value : reconciled.error).slice(0, 400));
    if (!reconciled.ok || reconciled.value.kind !== 'settled') return;
    assert.equal(reconciled.value.status, 'completed'); assert.equal(reconciled.value.externalEffects, 'confirmed');
    assert.equal(publisher.hits(), 0);
    const status = await readStatus({ runRoot: f.runRoot, runId: crash.runId });
    assert.ok(status.ok && status.value.status === 'completed');
    const checkpointBefore = status.value.checkpoint;
    const bundle = join(f.root, 'bundle-mid-post'), inspected = await inspectRun({ runRoot: f.runRoot, runId: crash.runId, output: bundle });
    assert.ok(inspected.ok && inspected.value.manifest !== null); if (!inspected.ok || !inspected.value.manifest) return;
    assert.ok(inspected.value.manifest.entries.find(entry => entry.name === 'publication.json')?.presence === 'present');
    const again = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId: crash.runId, receipt: receiptPath });
    assert.ok(again.ok && again.value.kind === 'settled' && again.value.status === 'completed');
    // An idempotent replay must not publish any new checkpoint.
    const statusAfter = await readStatus({ runRoot: f.runRoot, runId: crash.runId });
    assert.ok(statusAfter.ok && statusAfter.value.checkpoint === checkpointBefore);
    const conflictPath = '/tmp/s05-mid-post-conflict-' + process.pid + '.json';
    const conflictBody = { version: 1, kind: 'publication_receipt', storeId: crash.storeId, runId: crash.runId, lockHash: crash.lockHash, operationId: crash.operationId, dispatchId: crash.dispatchId, dispatchGeneration: crash.dispatchGeneration, idempotencyKey: crash.idempotencyKey, outcome: 'not_executed', externalUrl: null, reason: null };
    await writeFile(conflictPath, JSON.stringify({ ...conflictBody, signature: signPayload(PUBLISHER_SECRET, canonical(conflictBody)) }), { mode: 0o600 });
    const conflict = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId: crash.runId, receipt: conflictPath });
    assert.ok(!conflict.ok && conflict.error.code === 'RECEIPT_CONFLICT');
    assert.equal(publisher.hits(), 0);
    await rm(receiptPath, { force: true }); await rm(wrongPath, { force: true }); await rm(conflictPath, { force: true });
  } finally { await f.cleanup(); await publisher.close(); }
});
test('a mid-POST crash fails resume closed without re-dispatch, and reconciliation settles it', async () => {
  const publisher = await publicationServer();
  const f = await publicationFixture(publisher.url);
  try {
    const crash = await crashMidPublication(f, 'run-mid-post-resume');
    // Resume replays the retained reconcile_required signal without re-dispatching the publication request.
    const resumed = await resumeCycle({ configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId: crash.runId });
    assert.ok(resumed.ok && resumed.value.kind === 'result', JSON.stringify(resumed.ok ? resumed.value : resumed.error).slice(0, 400)); if (!resumed.ok || resumed.value.kind !== 'result') return;
    assert.equal(resumed.value.result.spec.status, 'reconcile_required');
    assert.equal(publisher.hits(), 0);
    const body = receiptBody(crash, 'succeeded');
    const receiptPath = join(tmpdir(), 's05-resume-first-' + process.pid + '.json');
    await writeFile(receiptPath, JSON.stringify({ ...body, signature: signPayload(PUBLISHER_SECRET, canonical(body)) }), { mode: 0o600 });
    const reconciled = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId: crash.runId, receipt: receiptPath });
    assert.ok(reconciled.ok && reconciled.value.kind === 'settled'); if (!reconciled.ok || reconciled.value.kind !== 'settled') return;
    assert.equal(reconciled.value.status, 'completed'); assert.equal(reconciled.value.externalEffects, 'confirmed');
    const bundle = join(f.root, 'bundle-resume-first'), inspected = await inspectRun({ runRoot: f.runRoot, runId: crash.runId, output: bundle });
    assert.ok(inspected.ok && inspected.value.manifest !== null); if (!inspected.ok || !inspected.value.manifest) return;
    assert.ok(inspected.value.manifest.entries.find(entry => entry.name === 'publication.json')?.presence === 'present');
    assert.equal(publisher.hits(), 0);
    await rm(receiptPath, { force: true });
  } finally { await f.cleanup(); await publisher.close(); }
});

/** Publication server that answers every signed request with a signed succeeded receipt. */
async function succeedingPublicationServer(): Promise<{ readonly hits: () => number; readonly request: () => Record<string, unknown> | null; readonly close: () => Promise<void>; readonly url: string }> {
  return new Promise(resolve => {
    let hits = 0, captured: Record<string, unknown> | null = null;
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        hits++;
        const signature = request.headers['x-loopwright-signature'];
        if (typeof signature !== 'string' || !verifySignedPayload(PUBLISHER_SECRET, Buffer.concat(chunks), signature)) { response.writeHead(403).end(); return; }
        captured = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        const receipt = { version: 1, kind: 'publication_receipt', storeId: captured.storeId, runId: captured.runId, lockHash: captured.lockHash, operationId: captured.operationId, dispatchId: captured.dispatchId, dispatchGeneration: captured.dispatchGeneration, idempotencyKey: captured.idempotencyKey, outcome: 'succeeded', externalUrl: 'https://x/pull/42', reason: null };
        const bytes = Buffer.from(JSON.stringify(receipt));
        response.writeHead(200, { 'content-type': 'application/json', connection: 'close', 'x-loopwright-signature': signPayload(PUBLISHER_SECRET, bytes) });
        response.end(bytes);
      })().catch(() => { try { response.writeHead(500).end(); } catch { /* socket already gone */ } });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      hits: () => hits, request: () => captured, url: 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/publish',
      close: () => new Promise((done, fail) => { server.closeAllConnections(); server.close(error => error ? fail(error) : done()); }),
    }));
  });
}
async function gateCrashFixture(url: string, withPublication: boolean) {
  const f = await configurationFixture();
  f.environment.GATE_SECRET = GATE_SECRET;
  f.environment.PUBLISHER_SECRET = PUBLISHER_SECRET; f.environment.PUBLISHER_TOKEN = PUBLISHER_TOKEN;
  setFixture(f.registry, ['spec', 'credentialBindings'], [...f.registry.spec.credentialBindings,
    { id: 'gate-signer', consumer: 'gate', destinationRef: 'gate-service', environmentNames: ['GATE_SECRET'], template: '${GATE_SECRET}' },
    { id: 'publisher-signer', consumer: 'publisher', destinationRef: 'publisher-service', environmentNames: ['PUBLISHER_SECRET'], template: '${PUBLISHER_SECRET}' },
    { id: 'publisher-auth', consumer: 'publisher', destinationRef: 'publisher-service', environmentNames: ['PUBLISHER_TOKEN'], template: '${PUBLISHER_TOKEN}' }]);
  const credentials = withPublication
    ? [{ ref: 'gate-signer', template: '${GATE_SECRET}' }, { ref: 'publisher-signer', template: '${PUBLISHER_SECRET}' }, { ref: 'publisher-auth', template: '${PUBLISHER_TOKEN}' }]
    : [{ ref: 'gate-signer', template: '${GATE_SECRET}' }];
  setFixture(f.registry, ['spec', 'environmentBindings'], [{ name: 'PROVIDER_TOKEN', classification: 'credential', paths: [] },
    { name: 'GATE_SECRET', classification: 'credential', paths: withPublication ? ['/spec/credentials/0/template'] : ['/spec/credentials/0/template'] },
    { name: 'PUBLISHER_SECRET', classification: 'credential', paths: withPublication ? ['/spec/credentials/1/template'] : [] },
    { name: 'PUBLISHER_TOKEN', classification: 'credential', paths: withPublication ? ['/spec/credentials/2/template'] : [] }]);
  setFixture(f.config, ['spec', 'credentials'], credentials);
  setFixture(f.registry, ['spec', 'gateEndpoints'], [{ id: 'ci-gate', url, signingCredentialRef: 'gate-signer', authCredentialRef: null, timeoutMs: 1500, maxPollMs: 20000, pollInitialMs: 100, pollMaxMs: 200, jitter: 50 }]);
  const installed = await installedHandlerDigests();
  setFixture(f.registry, ['spec', 'handlers'], [...f.registry.spec.handlers, { id: 'approval', kind: 'check', implementation: 'gate.v1', version: 1, digest: installed['gate.v1'], parameters: { checkId: 'approval', endpointRef: 'ci-gate', gateId: 'merge-gate' }, capabilities: ['external_service', 'read_only'] }]);
  setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [{ id: 'approval', kind: 'check', uses: 'approval', roleId: null, dependsOn: [] }]);
  setFixture(f.config, ['spec', 'profiles', 'steps'], [{ stepId: 'approval', handlerRef: 'approval' }]);
  setFixture(f.config, ['spec', 'task', 'spec', 'acceptance'], { required: ['approval'], checks: [{ id: 'approval', allowedEvidenceLevels: ['external_service'] }] });
  if (withPublication) {
    setFixture(f.registry, ['spec', 'publicationEndpoints'], [{ id: 'pr-publisher', url: url.replace('/gate', '/publish'), signingCredentialRef: 'publisher-signer', authCredentialRef: 'publisher-auth', timeoutMs: 2000 }]);
    setFixture(f.config, ['spec', 'publication'], { mode: 'pull_request', endpointRef: 'pr-publisher', targetBranch: 'main', headBranchPrefix: 'loopwright/', titleTemplate: 'Loopwright run publication' });
  }
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
/** Simulates a SIGKILL mid-poll in-process: verifier_pre row, read_only intent + dispatch, binding marker, no proof. */
async function crashMidGate(f: Awaited<ReturnType<typeof gateCrashFixture>>, runId: string) {
  const context = await createCycle(input(f, runId), {});
  const manifest = await context.artifacts.json('manifest', context.source.manifest, 32768);
  const bound = bindSubject(context.lock, context.source.manifest); assert.ok(bound.ok); if (!bound.ok) throw new Error('fixture');
  await context.progress.publish({ version: 2, runId: context.lock.spec.runId, lockHash: context.lock.spec.lockHash, stage: { kind: 'bootstrap', phase: 'bootstrap', capacity: context.plan.capacity },
    nodes: context.plan.orderedDAG.map(node => ({ id: node.id, state: 'pending' })), attempts: [], nativeCheckpoints: [], submission: null, publication: { status: 'idle', operationId: null, receipt: null },
    candidate: { manifest, digest: bound.value.candidateDigest, generation: 0, workspace: context.source.workspace, privateSession: null }, failures: [], verifierReceipts: [], verifierRefusals: [], eventSequence: 0, terminalIntent: null }, 'bootstrap');
  const slot = context.plan.verifierSlots.find(item => item.handler.implementation === 'gate.v1')!; assert.ok(slot);
  const nonce = randomBytes(16).toString('hex');
  const candidate = { manifest: context.source.manifest, ref: manifest, files: context.source.artifacts };
  const job = prepareGate(context.plan, context.lock, slot.id, candidate, 0, nonce, f.loaded.registry.spec.gateEndpoints);
  const head = await context.progress.read(); assert.ok(head); if (!head) throw new Error('fixture');
  const ordinal = context.plan.verifierSlots.findIndex(item => item.id === slot.id);
  await context.progress.publish({ ...head.progress, stage: { ...head.progress.stage, kind: 'verifier_pre' }, verifierReceipts: [{ slot: slot.id, generation: 0, operationId: job.operationId, producerNonce: nonce, output: null, receipt: null }] }, 'verify.0.' + ordinal + '.pre');
  stateValue(context.store.putIntent(context.authority, { operationId: job.operationId, nodeId: context.plan.orderedDAG[0]!.id, attemptId: 'job.' + hash(job.operationId + '\0' + nonce).hex.slice(0, 40), effect: 'read_only', requestDigest: job.requestDigest, targetIdentity: 'gate:' + slot.id + ':0:' + bound.value.candidateDigest.hex }));
  const dispatched = stateValue(context.store.authorizeOperationDispatch(context.authority, job.operationId)); if (dispatched.kind !== 'new_dispatch') throw new Error('fixture');
  const operation = stateValue(context.store.getOperation(job.operationId));
  const request: Record<string, unknown> = { version: 1, kind: 'gate_request', gateId: 'merge-gate', checkId: slot.checkId, candidateDigest: bound.value.candidateDigest.hex, subject: bound.value, storeId: 'store.' + hash('loopwright.dev/controller/store/v1\0' + runId).hex.slice(0, 40), runId, lockHash: context.lock.spec.lockHash, operationId: job.operationId, dispatchId: dispatched.permit.dispatchId, dispatchGeneration: dispatched.permit.generation, requestDigest: job.requestDigest.hex };
  const prefix = join(context.artifacts.directory, 'gate-producer-' + hash(job.operationId + '\0' + nonce).hex);
  await writeFile(prefix + '.binding.json', canonical({ version: 1, planDigest: context.plan.planDigest, operationId: job.operationId, producerNonce: nonce, requestDigest: job.requestDigest, requestBytesDigest: hash(Buffer.from(canonical(request))).hex, intentDigest: operation.intentDigest, subject: bound.value, generation: 0, endpoint: 'ci-gate',
    dispatchReceipt: { generation: dispatched.permit.generation, dispatchId: dispatched.permit.dispatchId, revision: dispatched.permit.authorizedRevision, clockEpoch: dispatched.permit.clockEpoch } }), { mode: 0o600 });
  stateValue(context.store.release(context.authority));
  stateValue(context.store.close());
  await context.owner.release();
  return request as Record<string, unknown> & { runId: string; storeId: string; lockHash: { algorithm: 'sha256'; hex: string }; operationId: string; dispatchId: string; dispatchGeneration: number; gateId: string; checkId: string; candidateDigest: string; idempotencyKey: string };
}
test('resume settles a gate crash as blocked GATE_TIMEOUT and a gate_verdict reconcile then refuses the invalidated dispatch', async () => {
  const gate = await publicationServer();
  const f = await gateCrashFixture(gate.url.replace('/publish', '/gate'), false);
  try {
    const runId = 'run-gate-crash', request = await crashMidGate(f, runId);
    const resumed = await resumeCycle(input(f, runId));
    assert.ok(resumed.ok && resumed.value.kind === 'result'); if (!resumed.ok || resumed.value.kind !== 'result') return;
    assert.equal(resumed.value.result.spec.status, 'blocked');
    assert.equal(resumed.value.result.spec.verification.spec.required.find(row => row.checkId === 'approval')?.detail, 'GATE_TIMEOUT');
    assert.equal(gate.hits(), 0);
    const body = { version: 1, kind: 'gate_verdict', storeId: request.storeId, runId: request.runId, lockHash: request.lockHash, operationId: request.operationId, dispatchId: request.dispatchId, dispatchGeneration: request.dispatchGeneration, gateId: request.gateId, checkId: request.checkId, candidateDigest: request.candidateDigest, status: 'approved', reason: null, expiresAtMs: String(Date.now() + 600000) };
    const receiptPath = join(tmpdir(), 's05-gate-verdict-' + process.pid + '.json');
    await writeFile(receiptPath, JSON.stringify({ ...body, signature: signPayload(GATE_SECRET, canonical(body)) }), { mode: 0o600 });
    const reconciled = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId, receipt: receiptPath });
    assert.ok(!reconciled.ok && reconciled.error.code === 'RECOVERY_REQUIRED' && reconciled.error.path === '/gate', JSON.stringify(reconciled.ok ? reconciled.value : reconciled.error).slice(0, 400));
    // The settled GATE_TIMEOUT output carries verdict: null, so the invalidated dispatch can never be re-asserted.
  } finally { await f.cleanup(); await gate.close(); }
});

test('the CLI reconcile subprocess exits 0/3/4/7 across receipt outcomes', { timeout: 120000 }, async () => {
  const f = await publicationFixture('http://127.0.0.1:1/publish');
  const repoRoot = process.cwd(), cli = resolve(join(repoRoot, 'packages/cli/dist/main.js'));
  const baseEnv = { ...process.env, PUBLISHER_SECRET: f.environment.PUBLISHER_SECRET, PUBLISHER_TOKEN: f.environment.PUBLISHER_TOKEN };
  const run = (args: string[], env: NodeJS.ProcessEnv = baseEnv) => { try { return execFileSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 60000 }); } catch (error) { const failure = ((error as { cause?: unknown }).cause ?? error) as { stdout?: string; stderr?: string; status?: number }; throw new Error('CLI_EXIT ' + failure.status + ' OUT ' + String(failure.stdout).slice(0, 300) + ' ERR ' + String(failure.stderr).slice(0, 300), { cause: error }); } };
  let gateFixture: Awaited<ReturnType<typeof gateCrashFixture>> | null = null;
  try {
    assert.match(run(['--help']), /reconcile .* \[--output FILE\]/);
    // The crash state comes from the in-process helper: publication_pre + dispatch_uncertain + binding, no proof.
    const crash = await crashMidPublication(f, 'run-cli');
    const body = receiptBody(crash, 'succeeded');
    const receiptPath = join(tmpdir(), 's05-cli-' + process.pid + '.json');
    await writeFile(receiptPath, JSON.stringify({ ...body, signature: 'sha256=' + signPayload(PUBLISHER_SECRET, canonical(body)) }), { mode: 0o600 });
    const base = ['reconcile', '--config', f.input.configPath, '--registry', f.input.registryPath, '--registry-sha256', f.input.registrySha256, '--repo', f.repository, '--run-root', f.runRoot];
    const first = run([...base, '--run-id', crash.runId, '--receipt', receiptPath, '--json', '--output', join(f.root, 'cli-reconciled.json')]);
    assert.match(first, /"status":"completed"/);
    const written = JSON.parse(await import('node:fs/promises').then(module => module.readFile(join(f.root, 'cli-reconciled.json'), 'utf8'))) as { status: string };
    assert.equal(written.status, 'completed');
    const again = run([...base, '--run-id', crash.runId, '--receipt', receiptPath, '--json']);
    assert.match(again, /"status":"completed"/);
    const conflictBody = receiptBody(crash, 'not_executed');
    const conflictPath = join(tmpdir(), 's05-cli-conflict-' + process.pid + '.json');
    await writeFile(conflictPath, JSON.stringify({ ...conflictBody, signature: signPayload(PUBLISHER_SECRET, canonical(conflictBody)) }), { mode: 0o600 });
    let conflictCode = 0;
    try { run([...base, '--run-id', crash.runId, '--receipt', conflictPath, '--json']); } catch (error) { const failure = ((error as { cause?: unknown }).cause ?? error) as { status?: number }; conflictCode = failure.status ?? 0; }
    assert.equal(conflictCode, 7);
    // not_executed settles failed with exit 4 on a fresh crashed run.
    const crash2 = await crashMidPublication(f, 'run-cli-not-executed');
    const body2 = receiptBody(crash2, 'not_executed');
    const receipt2 = join(tmpdir(), 's05-cli-not-executed-' + process.pid + '.json');
    await writeFile(receipt2, JSON.stringify({ ...body2, signature: signPayload(PUBLISHER_SECRET, canonical(body2)) }), { mode: 0o600 });
    let notExecutedCode = 0;
    try { run([...base, '--run-id', crash2.runId, '--receipt', receipt2, '--json']); } catch (error) { const failure = ((error as { cause?: unknown }).cause ?? error) as { status?: number }; notExecutedCode = failure.status ?? 0; }
    assert.equal(notExecutedCode, 4);
    await rm(receiptPath, { force: true }); await rm(conflictPath, { force: true }); await rm(receipt2, { force: true });
    // An expired gate_verdict settles the interrupted gate run as blocked: exit 3.
    gateFixture = await gateCrashFixture('http://127.0.0.1:1/gate', false);
    const gateEnv = { ...process.env, GATE_SECRET: gateFixture.environment.GATE_SECRET };
    const gateBase = ['reconcile', '--config', gateFixture.input.configPath, '--registry', gateFixture.input.registryPath, '--registry-sha256', gateFixture.input.registrySha256, '--repo', gateFixture.repository, '--run-root', gateFixture.runRoot];
    const crashed = await crashMidGate(gateFixture, 'run-cli-gate');
    const verdict = { version: 1, kind: 'gate_verdict', storeId: crashed.storeId, runId: crashed.runId, lockHash: crashed.lockHash, operationId: crashed.operationId, dispatchId: crashed.dispatchId, dispatchGeneration: crashed.dispatchGeneration, gateId: crashed.gateId, checkId: crashed.checkId, candidateDigest: crashed.candidateDigest, status: 'expired', reason: null, expiresAtMs: String(Date.now() - 3600000) };
    const verdictPath = join(tmpdir(), 's05-cli-gate-' + process.pid + '.json');
    await writeFile(verdictPath, JSON.stringify({ ...verdict, signature: signPayload(GATE_SECRET, canonical(verdict)) }), { mode: 0o600 });
    let blockedCode = 0;
    try { run([...gateBase, '--run-id', crashed.runId, '--receipt', verdictPath, '--json'], gateEnv); } catch (error) { const failure = ((error as { cause?: unknown }).cause ?? error) as { status?: number }; blockedCode = failure.status ?? 0; }
    assert.equal(blockedCode, 3);
    await rm(verdictPath, { force: true });
  } finally { await f.cleanup(); if (gateFixture) await gateFixture.cleanup(); }
});

test('reconcileCycle with a gate_verdict receipt refuses invalid verdicts, settles an interrupted gate, dispatches publication, and replays idempotently', { timeout: 120000 }, async () => {
  const gate = await publicationServer();
  const publisher = await succeedingPublicationServer();
  const f = await gateCrashFixture(publisher.url, true);
  try {
    const runId = 'run-gate-verdict-pub', captured = await crashMidGate(f, runId);
    const negative = async (status: 'approved' | 'denied' | 'pending', overrides: { candidateDigest?: string; expiresAtMs?: string } = {}) => {
      const body = { version: 1, kind: 'gate_verdict', storeId: captured.storeId, runId: captured.runId, lockHash: captured.lockHash, operationId: captured.operationId, dispatchId: captured.dispatchId, dispatchGeneration: captured.dispatchGeneration, gateId: captured.gateId, checkId: captured.checkId, candidateDigest: overrides.candidateDigest ?? captured.candidateDigest, status, reason: status === 'denied' ? 'policy refuses this candidate' : null, expiresAtMs: overrides.expiresAtMs ?? String(Date.now() + 600000) };
      const path = join(tmpdir(), 's05-negative-' + process.pid + '.json');
      await writeFile(path, JSON.stringify({ ...body, signature: signPayload(GATE_SECRET, canonical(body)) }), { mode: 0o600 });
      const reconciled = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId, receipt: path });
      assert.ok(!reconciled.ok && reconciled.error.code === 'EVIDENCE_UNAVAILABLE' && reconciled.error.path === '/receipt', JSON.stringify({ status, reconciled: reconciled.ok ? reconciled.value.kind : reconciled.error }).slice(0, 300));
      await rm(path, { force: true });
    };
    await negative('pending');
    await negative('approved', { expiresAtMs: String(Date.now() - 3600000) });
    await negative('approved', { expiresAtMs: String(Date.now() + 3 * 86400000) });
    await negative('approved', { candidateDigest: 'f'.repeat(64) });
    // The valid approved receipt settles, delegates to resume, and the resumed cycle dispatches publication.
    const goodBody = { version: 1, kind: 'gate_verdict', storeId: captured.storeId, runId: captured.runId, lockHash: captured.lockHash, operationId: captured.operationId, dispatchId: captured.dispatchId, dispatchGeneration: captured.dispatchGeneration, gateId: captured.gateId, checkId: captured.checkId, candidateDigest: captured.candidateDigest, status: 'approved', reason: null, expiresAtMs: String(Date.now() + 600000) };
    const goodPath = join(tmpdir(), 's05-gate-good-' + process.pid + '.json');
    await writeFile(goodPath, JSON.stringify({ ...goodBody, signature: signPayload(GATE_SECRET, canonical(goodBody)) }), { mode: 0o600 });
    const reconciled = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId, receipt: goodPath });
    assert.ok(reconciled.ok && reconciled.value.kind === 'settled', JSON.stringify(reconciled.ok ? reconciled.value : reconciled.error).slice(0, 400)); if (!reconciled.ok || reconciled.value.kind !== 'settled') return;
    assert.equal(reconciled.value.status, 'completed'); assert.equal(reconciled.value.outcome, 'succeeded'); assert.equal(reconciled.value.externalEffects, 'confirmed');
    assert.equal(publisher.hits(), 1);
    // Idempotent replay with the same approved receipt.
    const again = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId, receipt: goodPath });
    assert.ok(again.ok && again.value.kind === 'settled'); if (!again.ok || again.value.kind !== 'settled') return;
    assert.equal(again.value.externalEffects, 'confirmed');
    assert.equal(publisher.hits(), 1);
    // A conflicting denied receipt refuses.
    const deniedBody = { version: 1, kind: 'gate_verdict', storeId: captured.storeId, runId: captured.runId, lockHash: captured.lockHash, operationId: captured.operationId, dispatchId: captured.dispatchId, dispatchGeneration: captured.dispatchGeneration, gateId: captured.gateId, checkId: captured.checkId, candidateDigest: captured.candidateDigest, status: 'denied', reason: 'conflict', expiresAtMs: String(Date.now() + 600000) };
    const deniedPath = join(tmpdir(), 's05-gate-denied-' + process.pid + '.json');
    await writeFile(deniedPath, JSON.stringify({ ...deniedBody, signature: signPayload(GATE_SECRET, canonical(deniedBody)) }), { mode: 0o600 });
    const conflict = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId, receipt: deniedPath });
    assert.ok(!conflict.ok && conflict.error.code === 'RECEIPT_CONFLICT' && conflict.error.path === '/receipt');
    // The resumed run replays the settled completion.
    const replay = await resumeCycle(input(f, runId));
    assert.ok(replay.ok && replay.value.kind === 'result'); if (!replay.ok || replay.value.kind !== 'result') return;
    assert.equal(replay.value.result.spec.status, 'completed'); assert.equal(replay.value.result.spec.externalEffects, 'confirmed');
    await rm(goodPath, { force: true }); await rm(deniedPath, { force: true });
  } finally { await f.cleanup(); await publisher.close(); await gate.close(); }
});
test('a crash between the settled publication proof and its receipt reconciles without rewriting live evidence, in both recovery orders', { timeout: 120000 }, async () => {
  for (const order of ['reconcile', 'resume'] as const) {
    const publisher = await succeedingPublicationServer();
    const f = await publicationFixture(publisher.url);
    try {
      const runId = 'run-proof-' + order;
      const context = await createCycle(input(f, runId), {});
      const cycle = new Cycle(context);
      await cycle.bootstrap();
      await cycle.graph();
      const endpoint = f.loaded.registry.spec.publicationEndpoints[0]!;
      const bound = bindSubject(context.lock, cycle.candidate.manifest); assert.ok(bound.ok); if (!bound.ok) throw new Error('fixture');
      const view = stateValue(context.store.inspect());
      const prepared = preparePublication(context.plan, context.lock, view.storeId, endpoint, bound.value);
      await cycle.events.push('publication', null);
      await cycle.publish({ ...cycle.draft, stage: { ...cycle.draft.stage, kind: 'publication_pre' as const }, publication: { status: 'pending' as const, operationId: prepared.operationId, receipt: null } }, 'publication.pre');
      // SIGKILL between the settled .proof.json and recordOperationReceipt: the live proof stays on disk, the op stays dispatch_uncertain.
      const original = context.store.recordOperationReceipt.bind(context.store);
      (context.store as unknown as Record<string, unknown>).recordOperationReceipt = () => { throw new Error('SIMULATED_SIGKILL'); };
      let returned = false;
      try { await cycle.publisher.run(prepared, endpoint, new AbortController().signal); returned = true; } catch { /* crash */ }
      (context.store as unknown as Record<string, unknown>).recordOperationReceipt = original;
      assert.equal(returned, false);
      const events = await cycle.events.close();
      const restored = await fsOpen(join(context.artifacts.directory, 'controller-events.open'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await restored.writeFile(await readFile(join(context.artifacts.directory, events.name))); await restored.sync(); } finally { await restored.close(); }
      stateValue(context.store.release(context.authority));
      stateValue(context.store.close());
      await context.owner.release();
      if (order === 'resume') {
        const resumed = await resumeCycle(input(f, runId));
        assert.ok(resumed.ok && resumed.value.kind === 'result', JSON.stringify(resumed.ok ? resumed.value : resumed.error).slice(0, 400)); if (!resumed.ok || resumed.value.kind !== 'result') return;
        assert.equal(resumed.value.result.spec.status, 'completed');
        assert.equal(resumed.value.result.spec.externalEffects, 'confirmed');
        assert.equal(publisher.hits(), 1);
      }
      const request = publisher.request(); assert.ok(request);
      // The operator receipt must match the on-disk live proof byte for byte (the server answered succeeded with x/pull/42).
      const body = { version: 1, kind: 'publication_receipt', storeId: request.storeId, runId: request.runId, lockHash: request.lockHash, operationId: request.operationId, dispatchId: request.dispatchId, dispatchGeneration: request.dispatchGeneration, idempotencyKey: request.idempotencyKey, outcome: 'succeeded', externalUrl: 'https://x/pull/42', reason: null };
      const receiptPath = join(tmpdir(), 's05-proof-' + order + '-' + process.pid + '.json');
      await writeFile(receiptPath, JSON.stringify({ ...body, signature: signPayload(PUBLISHER_SECRET, canonical(body)) }), { mode: 0o600 });
      const reconciled = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId, receipt: receiptPath });
      assert.ok(reconciled.ok && reconciled.value.kind === 'settled', JSON.stringify(reconciled.ok ? reconciled.value : reconciled.error).slice(0, 400));
      if (!reconciled.ok || reconciled.value.kind !== 'settled') return;
      assert.equal(reconciled.value.status, 'completed'); assert.equal(reconciled.value.externalEffects, 'confirmed');
      assert.equal(publisher.hits(), 1);
      const again = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId, receipt: receiptPath });
      assert.ok(again.ok && again.value.kind === 'settled' && again.value.status === 'completed');
      assert.equal(publisher.hits(), 1);
      const bundle = join(f.root, 'bundle-proof-' + order), inspected = await inspectRun({ runRoot: f.runRoot, runId, output: bundle });
      assert.ok(inspected.ok && inspected.value.manifest !== null); if (!inspected.ok || !inspected.value.manifest) return;
      assert.ok(inspected.value.manifest.entries.find(entry => entry.name === 'publication.json')?.presence === 'present');
      assert.ok(inspected.value.manifest.entries.find(entry => entry.name === 'result.json')?.presence === 'present');
      await rm(receiptPath, { force: true });
    } finally { await f.cleanup(); await publisher.close(); }
  }
});
test('a crash between the unresolved publication proof and markOperationUnresolved resumes reconcile_required and settles', { timeout: 60000 }, async () => {
  const publisher = await publicationServer();
  const f = await publicationFixture(publisher.url);
  try {
    const runId = 'run-unrproof';
    const context = await createCycle(input(f, runId), {});
    const cycle = new Cycle(context);
    await cycle.bootstrap();
    await cycle.graph();
    const endpoint = f.loaded.registry.spec.publicationEndpoints[0]!;
    const bound = bindSubject(context.lock, cycle.candidate.manifest); assert.ok(bound.ok); if (!bound.ok) throw new Error('fixture');
    const view = stateValue(context.store.inspect());
    const prepared = preparePublication(context.plan, context.lock, view.storeId, endpoint, bound.value);
    await cycle.events.push('publication', null);
    await cycle.publish({ ...cycle.draft, stage: { ...cycle.draft.stage, kind: 'publication_pre' as const }, publication: { status: 'pending' as const, operationId: prepared.operationId, receipt: null } }, 'publication.pre');
    // SIGKILL between the unresolved .proof.json and markOperationUnresolved: the proof carries receipt null while the op stays dispatch_uncertain.
    const original = context.store.markOperationUnresolved.bind(context.store);
    (context.store as unknown as Record<string, unknown>).markOperationUnresolved = () => { throw new Error('SIMULATED_SIGKILL'); };
    let returned = false;
    try { await cycle.publisher.run(prepared, endpoint, new AbortController().signal); returned = true; } catch { /* crash */ }
    (context.store as unknown as Record<string, unknown>).markOperationUnresolved = original;
    assert.equal(returned, false);
    const events = await cycle.events.close();
    const restored = await fsOpen(join(context.artifacts.directory, 'controller-events.open'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await restored.writeFile(await readFile(join(context.artifacts.directory, events.name))); await restored.sync(); } finally { await restored.close(); }
    stateValue(context.store.release(context.authority));
    stateValue(context.store.close());
    await context.owner.release();
    const resumed = await resumeCycle(input(f, runId));
    assert.ok(resumed.ok && resumed.value.kind === 'result', JSON.stringify(resumed.ok ? resumed.value : resumed.error).slice(0, 400)); if (!resumed.ok || resumed.value.kind !== 'result') return;
    assert.equal(resumed.value.result.spec.status, 'reconcile_required');
    assert.equal(publisher.hits(), 1);
    const request = publisher.request(); assert.ok(request);
    const receiptPath = join(tmpdir(), 's05-unrproof-' + process.pid + '.json');
    await writeFile(receiptPath, JSON.stringify({ ...receiptBody(request, 'succeeded'), signature: signPayload(PUBLISHER_SECRET, canonical(receiptBody(request, 'succeeded'))) }), { mode: 0o600 });
    const reconciled = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId, receipt: receiptPath });
    assert.ok(reconciled.ok && reconciled.value.kind === 'settled', JSON.stringify(reconciled.ok ? reconciled.value : reconciled.error).slice(0, 400));
    if (!reconciled.ok || reconciled.value.kind !== 'settled') return;
    assert.equal(reconciled.value.status, 'completed'); assert.equal(reconciled.value.externalEffects, 'confirmed');
    assert.equal(publisher.hits(), 1);
    await rm(receiptPath, { force: true });
  } finally { await f.cleanup(); await publisher.close(); }
});
test('a symlinked receipt file and a directory receipt path refuse with EVIDENCE_UNAVAILABLE at /receipt', async () => {
  const base = join(tmpdir(), 's05-rp-' + process.pid);
  await mkdir(base, { recursive: true });
  try {
    const real = join(base, 'real.json');
    await writeFile(real, JSON.stringify({ kind: 'publication_receipt' }), { mode: 0o600 });
    await symlink(real, join(base, 'link.json'));
    await mkdir(join(base, 'dir.json'));
    for (const path of [join(base, 'link.json'), join(base, 'dir.json')]) {
      const reconciled = await reconcileCycle({ configuration: {} as unknown as import('../src/types.js').LoadedConfiguration, runRoot: '/nonexistent', runId: 'x', receipt: path });
      assert.ok(!reconciled.ok && reconciled.error.code === 'EVIDENCE_UNAVAILABLE' && reconciled.error.path === '/receipt', path);
    }
  } finally { await rm(base, { recursive: true, force: true }); }
});
test('reconciliation with unrelated unresolved work reports remaining_unresolved_work', async () => {
  const publisher = await publicationServer();
  const f = await publicationFixture(publisher.url);
  try {
    const runId = 'run-remaining', execution = await runCycleWithPorts(input(f, runId));
    assert.equal(execution.ok, true); if (!execution.ok) return;
    assert.equal(execution.value.kind, 'result'); if (execution.value.kind !== 'result') return;
    assert.equal(execution.value.result.spec.status, 'reconcile_required');
    const request = publisher.request(); assert.ok(request);
    const { readRetained } = await import('../src/retained.js');
    const { reopenLocalRun } = await import('@loopwright/state');
    const retained = await readRetained({ runRoot: f.runRoot, runId });
    const store = stateValue(reopenLocalRun(retained.descriptor.identity));
    const current = stateValue(store.inspect());
    const authority = stateValue(store.claim({ ownerId: 'controller.test-remaining', expectedGeneration: current.owner.generation, expectedRevision: current.revision, mode: 'active' })).authority;
    const dummyId = 'publish.' + hash('dummy\0' + runId).hex.slice(0, 40);
    stateValue(store.putIntent(authority, { operationId: dummyId, nodeId: retained.plan.orderedDAG[0]!.id, attemptId: 'attempt.' + hash('dummy-attempt\0' + runId).hex.slice(0, 40), effect: 'read_only', requestDigest: { algorithm: 'sha256', hex: 'aa'.repeat(32) }, targetIdentity: 'gate:dummy:0:read_only' }));
    stateValue(store.authorizeOperationDispatch(authority, dummyId));
    stateValue(store.release(authority));
    stateValue(store.close());
    const receiptPath = join(tmpdir(), 's05-remaining-' + process.pid + '.json');
    await writeFile(receiptPath, JSON.stringify({ ...receiptBody(request, 'succeeded'), signature: signPayload(PUBLISHER_SECRET, canonical(receiptBody(request, 'succeeded'))) }), { mode: 0o600 });
    const reconciled = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId, receipt: receiptPath });
    assert.ok(reconciled.ok && reconciled.value.kind === 'unresolved' && reconciled.value.reason === 'remaining_unresolved_work', JSON.stringify(reconciled.ok ? reconciled.value : reconciled.error).slice(0, 300));
    await rm(receiptPath, { force: true });
  } finally { await f.cleanup(); await publisher.close(); }
});
test('reconciling an incident-terminalized publication run records the receipt and retains the incident', async () => {
  const publisher = await publicationServer();
  const f = await publicationFixture(publisher.url);
  try {
    const crash = await crashMidPublication(f, 'run-incident', true);
    const body = receiptBody(crash, 'succeeded');
    const receiptPath = join(tmpdir(), 's05-incident-' + process.pid + '.json');
    await writeFile(receiptPath, JSON.stringify({ ...body, signature: signPayload(PUBLISHER_SECRET, canonical(body)) }), { mode: 0o600 });
    const reconciled = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId: crash.runId, receipt: receiptPath });
    assert.ok(reconciled.ok && reconciled.value.kind === 'unresolved' && reconciled.value.reason === 'incident_retained', JSON.stringify(reconciled.ok ? reconciled.value : reconciled.error).slice(0, 300));
    const bundle = join(f.root, 'bundle-incident'), inspected = await inspectRun({ runRoot: f.runRoot, runId: crash.runId, output: bundle });
    assert.ok(inspected.ok && inspected.value.manifest !== null); if (!inspected.ok || !inspected.value.manifest) return;
    assert.ok(inspected.value.manifest.entries.find(entry => entry.name === 'publication.json')?.presence === 'present');
    assert.ok(inspected.value.manifest.entries.find(entry => entry.name === 'result.json')?.presence === 'absent');
    const publication = JSON.parse(await readFile(join(bundle, 'publication.json'), 'utf8')) as { status: string };
    assert.equal(publication.status, 'confirmed');
    const again = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId: crash.runId, receipt: receiptPath });
    assert.ok(again.ok && again.value.kind === 'unresolved' && again.value.reason === 'incident_retained');
    const conflictPath = join(tmpdir(), 's05-incident-conflict-' + process.pid + '.json');
    await writeFile(conflictPath, JSON.stringify({ ...receiptBody(crash, 'not_executed'), signature: signPayload(PUBLISHER_SECRET, canonical(receiptBody(crash, 'not_executed'))) }), { mode: 0o600 });
    const conflict = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId: crash.runId, receipt: conflictPath });
    assert.ok(!conflict.ok && conflict.error.code === 'RECEIPT_CONFLICT');
    await rm(receiptPath, { force: true }); await rm(conflictPath, { force: true });
  } finally { await f.cleanup(); await publisher.close(); }
});

test('reconcileCycle preserves extended HMAC gate_verdict metrics (-0 -> 0), findings, detail, and retryablePreemption and refuses tampering or conflicts', { timeout: 120000 }, async () => {
  const gate = await publicationServer();
  const f = await gateCrashFixture(gate.url.replace('/publish', '/gate'), false);
  try {
    const runId = 'run-gate-ext-reconcile', captured = await crashMidGate(f, runId);
    const baseBody: Record<string, unknown> = {
      version: 1,
      kind: 'gate_verdict',
      storeId: captured.storeId,
      runId: captured.runId,
      lockHash: captured.lockHash,
      operationId: captured.operationId,
      dispatchId: captured.dispatchId,
      dispatchGeneration: captured.dispatchGeneration,
      gateId: captured.gateId,
      checkId: captured.checkId,
      candidateDigest: captured.candidateDigest,
      status: 'approved',
      reason: null,
      expiresAtMs: String(Date.now() + 600000),
      detail: 'Reconciled benchmark verdict approved',
      metrics: { latency_us: 19.25, speedup: 1.42, delta: -0, arch: 'sm90', verified: true },
      findings: [{ title: 'Occupancy advisory', severity: 'low', path: 'result.json', line: 1, evidence: 'register pressure nominal' }],
      retryablePreemption: false,
    };
    const validSig = signGateVerdict(GATE_SECRET, baseBody);

    // Tampering with metrics, findings, detail, or retryablePreemption without re-signing fails HMAC verification
    for (const [label, tampered] of [
      ['metrics', { ...baseBody, metrics: { latency_us: 99.9, speedup: 1.42, delta: 0, arch: 'sm90', verified: true } }],
      ['findings', { ...baseBody, findings: [] }],
      ['detail', { ...baseBody, detail: 'forged detail' }],
      ['retryablePreemption', { ...baseBody, retryablePreemption: true }],
    ] as const) {
      const badPath = join(tmpdir(), `s05-ext-tampered-${label}-${process.pid}.json`);
      await writeFile(badPath, JSON.stringify({ ...tampered, signature: validSig }), { mode: 0o600 });
      const badRes = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId, receipt: badPath });
      assert.ok(!badRes.ok && badRes.error.code === 'EVIDENCE_UNAVAILABLE' && badRes.error.path === '/receipt', label);
      await rm(badPath, { force: true });
    }

    // Properly signed contradictory verdicts (approved+retryablePreemption, pending+retryablePreemption, lone UTF-16 surrogates) fail closed as EVIDENCE_UNAVAILABLE at /receipt
    for (const [label, invalidBody] of [
      ['approved-preempted', { ...baseBody, retryablePreemption: true }],
      ['pending-preempted', { ...baseBody, status: 'pending', retryablePreemption: true }],
      ['surrogate-detail', { ...baseBody, detail: 'bad \ud800 detail' }],
      ['surrogate-metric', { ...baseBody, metrics: { tag: 'bad \udfff metric' } }],
      ['surrogate-finding', { ...baseBody, findings: [{ title: 'bad \ud800', severity: 'low', evidence: 'e' }] }],
    ] as const) {
      const invalidPath = join(tmpdir(), `s05-ext-invalid-${label}-${process.pid}.json`);
      const sig = signGateVerdict(GATE_SECRET, invalidBody);
      await writeFile(invalidPath, JSON.stringify({ ...invalidBody, signature: sig }), { mode: 0o600 });
      const invalidRes = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId, receipt: invalidPath });
      assert.ok(!invalidRes.ok && invalidRes.error.code === 'EVIDENCE_UNAVAILABLE' && invalidRes.error.path === '/receipt', label);
      await rm(invalidPath, { force: true });
    }

    // Write raw JSON receipt containing literal -0 in metrics to verify -0 -> 0 normalization on operator receipt load
    const goodPath = join(tmpdir(), `s05-ext-good-${process.pid}.json`);
    const rawWithNegZero = JSON.stringify({ ...baseBody, signature: validSig }).replace('"delta":0', '"delta":-0');
    await writeFile(goodPath, rawWithNegZero, { mode: 0o600 });

    const reconciled = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId, receipt: goodPath });
    assert.ok(reconciled.ok && reconciled.value.kind === 'settled', JSON.stringify(reconciled.ok ? reconciled.value : reconciled.error));
    if (!reconciled.ok || reconciled.value.kind !== 'settled') return;
    assert.equal(reconciled.value.status, 'completed');
    assert.equal(reconciled.value.outcome, 'succeeded');

    // Idempotent replay succeeds
    const again = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId, receipt: goodPath });
    assert.ok(again.ok && again.value.kind === 'settled' && again.value.status === 'completed');

    // Conflicting signed receipt where only metrics differ refuses with RECEIPT_CONFLICT
    const conflictBody = { ...baseBody, metrics: { latency_us: 20.0, speedup: 1.42, delta: 0, arch: 'sm90', verified: true } };
    const conflictPath = join(tmpdir(), `s05-ext-conflict-${process.pid}.json`);
    await writeFile(conflictPath, JSON.stringify({ ...conflictBody, signature: signGateVerdict(GATE_SECRET, conflictBody) }), { mode: 0o600 });
    const conflict = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId, receipt: conflictPath });
    assert.ok(!conflict.ok && conflict.error.code === 'RECEIPT_CONFLICT' && conflict.error.path === '/receipt');

    // Verify Evidence -> evaluateAcceptance -> constructRunResult -> inspectRun propagated all fields
    const bundle = join(f.root, 'bundle-ext-gate');
    const inspected = await inspectRun({ runRoot: f.runRoot, runId, output: bundle });
    assert.ok(inspected.ok && inspected.value.manifest !== null);
    const resultJson = JSON.parse(await readFile(join(bundle, 'result.json'), 'utf8')) as {
      spec: { status: string; verification: { spec: { required: { checkId: string; status: string; detail: string | null; metrics?: Record<string, unknown>; findings?: unknown[] }[] } } };
    };
    assert.equal(resultJson.spec.status, 'completed');
    const approvalRow = resultJson.spec.verification.spec.required.find(r => r.checkId === 'approval')!;
    assert.equal(approvalRow.status, 'passed');
    assert.equal(approvalRow.detail, 'Reconciled benchmark verdict approved');
    assert.deepEqual(approvalRow.metrics, { arch: 'sm90', delta: 0, latency_us: 19.25, speedup: 1.42, verified: true });
    assert.deepEqual(approvalRow.findings, [{ title: 'Occupancy advisory', severity: 'low', path: 'result.json', line: 1, evidence: 'register pressure nominal' }]);

    await rm(goodPath, { force: true });
    await rm(conflictPath, { force: true });

    // Non-approved (expired) verdict with retryablePreemption: true settles blocked without falsely marking passed
    const runId2 = 'run-gate-ext-preempt', captured2 = await crashMidGate(f, runId2);
    const preemptBody: Record<string, unknown> = {
      version: 1,
      kind: 'gate_verdict',
      storeId: captured2.storeId,
      runId: captured2.runId,
      lockHash: captured2.lockHash,
      operationId: captured2.operationId,
      dispatchId: captured2.dispatchId,
      dispatchGeneration: captured2.dispatchGeneration,
      gateId: captured2.gateId,
      checkId: captured2.checkId,
      candidateDigest: captured2.candidateDigest,
      status: 'expired',
      reason: 'spot_preempted',
      expiresAtMs: String(Date.now() - 5000),
      detail: 'Node reclaimed during kernel warmup',
      metrics: { warmup_ms: 120.5 },
      retryablePreemption: true,
    };
    const preemptPath = join(tmpdir(), `s05-ext-preempt-${process.pid}.json`);
    await writeFile(preemptPath, JSON.stringify({ ...preemptBody, signature: signGateVerdict(GATE_SECRET, preemptBody) }), { mode: 0o600 });
    const preemptRes = await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId: runId2, receipt: preemptPath });
    assert.ok(preemptRes.ok && preemptRes.value.kind === 'settled');
    if (preemptRes.ok && preemptRes.value.kind === 'settled') {
      assert.equal(preemptRes.value.status, 'blocked');
      const savedOut = JSON.parse(await readFile(join(f.runRoot, runId2, 'artifacts', preemptRes.value.receipt.evidence.artifact.name), 'utf8')) as {
        verdict: { retryablePreemption?: boolean };
        disposition: { status: string; retryablePreemption?: boolean };
      };
      assert.equal(savedOut.verdict.retryablePreemption, true);
      assert.equal(savedOut.disposition.retryablePreemption, true);
      assert.equal(savedOut.disposition.status, 'blocked');
    }
    await rm(preemptPath, { force: true });
  } finally { await f.cleanup(); await gate.close(); }
});

test('reconcileCycle(input, ports) threads allowWorkflowWrites: true, decisions, and gateUrlOverrides into Cycle repair resumption', { timeout: 120000 }, async () => {
  // Approving local gate server used when the post-reconcile repair re-runs verification
  const approvingGate = await new Promise<{ readonly url: string; readonly close: () => Promise<void> }>(resolveServer => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks);
        const sig = req.headers['x-loopwright-signature'];
        if (typeof sig !== 'string' || !verifySignedPayload(GATE_SECRET, body, sig)) {
          res.writeHead(403).end();
          return;
        }
        const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
        const verdict = {
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
          status: 'approved',
          reason: null,
          expiresAtMs: String(Date.now() + 600_000),
        };
        const bytes = Buffer.from(JSON.stringify(verdict), 'utf8');
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close', 'x-loopwright-signature': signPayload(GATE_SECRET, bytes) });
        res.end(bytes);
      })().catch(() => { try { res.writeHead(500).end(); } catch { /* ignore */ } });
    });
    server.listen(0, '127.0.0.1', () =>
      resolveServer({
        url: 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/gate',
        close: () => new Promise((done, fail) => { server.closeAllConnections(); server.close(err => (err ? fail(err) : done())); }),
      }),
    );
  });

  // Hanging gate server to park the initial run mid-gate at verifier_pre (dispatch_uncertain)
  const hangingGate = await publicationServer();
  const f = await configurationFixture();
  try {
    f.environment.GATE_SECRET = GATE_SECRET;
    setFixture(f.registry, ['spec', 'credentialBindings'], [
      ...f.registry.spec.credentialBindings,
      { id: 'gate-signer', consumer: 'gate', destinationRef: 'gate-service', environmentNames: ['GATE_SECRET'], template: '${GATE_SECRET}' },
    ]);
    setFixture(f.registry, ['spec', 'environmentBindings'], [
      { name: 'PROVIDER_TOKEN', classification: 'credential', paths: ['/spec/credentials/0/template'] },
      { name: 'GATE_SECRET', classification: 'credential', paths: ['/spec/credentials/1/template'] },
    ]);
    setFixture(f.config, ['spec', 'credentials'], [
      { ref: 'copilot', template: '${PROVIDER_TOKEN}' },
      { ref: 'gate-signer', template: '${GATE_SECRET}' },
    ]);
    setFixture(f.registry, ['spec', 'gateEndpoints'], [
      { id: 'ci-gate', url: hangingGate.url.replace('/publish', '/gate'), signingCredentialRef: 'gate-signer', authCredentialRef: null, timeoutMs: 1500, maxPollMs: 20_000, pollInitialMs: 100, pollMaxMs: 200, jitter: 0 },
    ]);
    const installed = await installedHandlerDigests();
    setFixture(f.registry, ['spec', 'handlers'], [
      ...f.registry.spec.handlers,
      { id: 'approval', kind: 'check', implementation: 'gate.v1', version: 1, digest: installed['gate.v1'], parameters: { checkId: 'approval', endpointRef: 'ci-gate', gateId: 'merge-gate' }, capabilities: ['external_service', 'read_only'] },
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'scope'], {
      writable: ['result.json', '.github/workflows/**'],
      protected: ['docs/**'],
    });
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxImplementationRepairs'], 1);
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxModelCalls'], 4);
    setFixture(f.config, ['spec', 'controls', 'maxAttempts'], 4);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'build', kind: 'agent', uses: 'package.patch', roleId: 'builder', dependsOn: [] },
      { id: 'approval', kind: 'check', uses: 'approval', roleId: null, dependsOn: ['build'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'build', handlerRef: 'package.patch' },
      { stepId: 'approval', handlerRef: 'approval' },
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'acceptance'], {
      required: ['approval'],
      checks: [{ id: 'approval', allowedEvidenceLevels: ['external_service'] }],
    });
    // Ensure builder role has write tool
    setFixture(f.registry, ['spec', 'roleProfiles', '0', 'tools'], ['read', 'write']);
    setFixture(f.config, ['spec', 'task', 'spec', 'roles', '0', 'tools'], ['read', 'write']);

    const repository = join(f.root, 'repository');
    const runRoot = join(f.root, 'runs');
    await mkdir(join(repository, '.github', 'workflows'), { recursive: true, mode: 0o700 });
    const git = (args: string[]) =>
      execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: repository,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: '/nonexistent', GIT_TERMINAL_PROMPT: '0' },
        timeout: 5000,
        encoding: 'utf8',
      });
    git(['init', '-q']);
    await writeFile(join(repository, 'result.json'), JSON.stringify({ ok: false }), { mode: 0o600 });
    await writeFile(join(repository, '.github', 'workflows', 'ci.yml'), 'name: CI\n', { mode: 0o600 });
    git(['add', '.']);
    git(['-c', 'user.name=Reconcile Ports', '-c', 'user.email=fixture@localhost.invalid', 'commit', '-qm', 'init']);
    const rev = git(['rev-parse', 'HEAD']).trim();
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], rev);
    await f.save();
    const loadedRes = await f.load();
    assert.equal(loadedRes.ok, true);
    if (!loadedRes.ok) return;
    const loaded = loadedRes.value;

    let turnSeq = 0;
    const openAdapter: import('../src/controller.js').ControllerPorts['openAdapter'] = async (host, openInput) => {
      const files = new Map<string, Uint8Array>(
        await Promise.all(
          openInput.candidate.artifacts.map(async a => [
            a.name,
            'bytes' in a ? new Uint8Array(a.bytes) : new Uint8Array(await readFile(a.blobPath)),
          ] as const),
        ),
      );
      let lastPrompt = '';
      let subText = '';
      const adapter: import('@loopwright/agent-pi').PiAdapterV2 = {
        capabilities: () => { throw new Error('unused'); },
        events: () => ({ async *[Symbol.asyncIterator]() { yield* []; } }),
        cancel: async () => ({
          ok: true,
          value: { status: 'cancelled', requestIds: [], operationIds: [], providerTermination: 'none', usage: 'none', localCleanup: 'complete', error: null, cleanupError: null },
        }),
        compact: async () => { throw new Error('unused'); },
        close: async () => ({ ok: true, value: { closed: true } }),
        execute: async cmd => {
          turnSeq++;
          lastPrompt = cmd.text;
          files.set('result.json', new Uint8Array(Buffer.from(JSON.stringify({ ok: true, turn: turnSeq }), 'utf8')));
          if (cmd.repair === 'implementation') {
            files.set('.github/workflows/ci.yml', new Uint8Array(Buffer.from('name: CI\non: push\n', 'utf8')));
          }
          subText = JSON.stringify({
            version: 1,
            status: 'completed',
            checks: [{ checkId: 'approval', status: 'passed', evidenceId: null, reason: null }],
            reason: null,
          });
          const reqId = `rec-port-req-${turnSeq}`;
          const opId = `rec-port-op-${turnSeq}`;
          stateValue(host.store.reserveRequest(host.authority, {
            requestId: reqId, roleId: openInput.roleId, nodeId: openInput.stepId, attemptId: cmd.commandId,
            purpose: 'task', repair: cmd.repair, transportRetryOf: null, requestDigest: hash(reqId),
            inputUpperBound: 100, outputUpperBound: 50, totalUpperBound: 150,
            capability: { adapterId: 'pi', adapterVersion: '0.0.0', provider: openInput.policy.selection.provider, model: openInput.policy.selection.model, kind: 'soft_only', coversAllBillableTokens: false, enforcesOutputBound: false },
            operationId: opId, targetIdentity: 'fixture:reconcile-ports',
          }));
          stateValue(host.store.authorizeRequestDispatch(host.authority, reqId));
          const op = stateValue(host.store.getOperation(opId));
          const view = stateValue(host.store.inspect());
          const uBytes = Buffer.from(canonical({ turnSeq }));
          const uName = `rec-u-${hash(uBytes).hex}.bin`;
          await writeFile(join(host.artifactsDirectory, uName), uBytes, { mode: 0o600 });
          stateValue(host.store.observeRequest(host.authority, reqId, {
            receiptId: `rec-rcpt-${turnSeq}`, termination: 'confirmed', outcome: 'succeeded',
            evidence: {
              evidenceId: `rec-ev-${turnSeq}`, producerId: 'rec-mock', method: 'synthetic',
              artifact: { name: uName, byteLength: uBytes.byteLength, digest: hash(uBytes) },
              subject: { storeId: view.storeId, runId: view.runId, lockHash: view.lockHash, operationId: opId, requestId: reqId, intentDigest: op.intentDigest, dispatchGeneration: op.dispatch!.generation, dispatchId: op.dispatch!.dispatchId },
            },
            usage: { requestId: reqId, inputTokens: { provenance: 'reported', value: 50 }, outputTokens: { provenance: 'reported', value: 10 }, costMicrousd: { provenance: 'reported', value: 50 } },
          }));
          return { ok: true, value: { status: 'execution_settled', requestIds: [reqId], operationIds: [opId], providerTermination: 'confirmed', usage: 'complete', localCleanup: 'complete', error: null, cleanupError: null } };
        },
        capture: async ({ checkpointId }) => {
          const sorted = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, bytes]) => ({ name, bytes, ref: { name, byteLength: bytes.byteLength, digest: hash(bytes) } }));
          const manifest = { apiVersion: 'loopwright.dev/v1alpha1' as const, kind: 'ArtifactManifest' as const, metadata: { id: 'candidate' }, spec: { entries: sorted.map(s => s.ref) } };
          const current = stateValue(host.store.inspect());
          const sourceDigest = hash('loopwright.dev/pi-policy/v2\0' + canonical(openInput.policy));
          const nativePolicy = { ...openInput.policy, version: 1, policyId: 'v2.' + BigInt('0x' + sourceDigest.hex).toString(36) };
          const candidateDigest = hash('loopwright.dev/artifact-manifest/v1alpha1\0' + canonical(manifest));
          const binding = {
            version: 1, checkpointId, storeId: current.storeId, runId: current.runId, lockHash: current.lockHash,
            sessionId: openInput.sessionId, roleId: openInput.roleId, stepId: openInput.stepId, runtime: openInput.policy.runtime,
            policyDigest: hash(canonical(nativePolicy)), resourcesDigest: hash(canonical(openInput.policy.resources)), candidateDigest,
            clockBasis: current.clock.basis, accountingDigest: hash(canonical({ ledger: current.ledger, requests: current.counts.requests, operations: current.counts.operations })), sequence: 1,
          };
          const line = (v: unknown) => JSON.stringify(v) + '\n';
          let wsBody = line({ type: 'workspace_snapshot', version: 1, binding, manifest });
          for (const s of sorted) {
            wsBody += line({ type: 'file', ref: s.ref });
            if (s.bytes.byteLength > 0) wsBody += line({ type: 'chunk', index: 0, data: Buffer.from(s.bytes).toString('base64') });
            wsBody += line({ type: 'file_end', byteLength: s.bytes.byteLength, digest: s.ref.digest.hex });
          }
          wsBody += line({ type: 'end', files: sorted.length });
          const wsBytes = Buffer.from(wsBody, 'utf8');
          const wsName = `rec-ws-${hash(wsBytes).hex}.bin`;
          await writeFile(join(host.artifactsDirectory, wsName), wsBytes, { mode: 0o600 });
          const wsRef = { name: wsName, byteLength: wsBytes.byteLength, digest: hash(wsBytes) };
          const ts = '2026-11-19T00:00:00.000Z';
          const sessBody =
            line({ type: 'session_snapshot', version: 1, binding }) +
            line({ type: 'session', version: 3, id: 's1', cwd: '/workspace/candidate', timestamp: ts }) +
            line({ type: 'message', id: 'u1', parentId: null, timestamp: ts, message: { role: 'user', content: lastPrompt } }) +
            line({ type: 'message', id: 'a1', parentId: 'u1', timestamp: ts, message: { role: 'assistant', ...openInput.policy.selection, content: [{ type: 'text', text: subText }], stopReason: 'stop' } });
          const sessBytes = Buffer.from(sessBody, 'utf8');
          const sessName = `rec-sess-${hash(sessBytes).hex}.bin`;
          await writeFile(join(host.artifactsDirectory, sessName), sessBytes, { mode: 0o600 });
          const sessRef = { name: sessName, byteLength: sessBytes.byteLength, digest: hash(sessBytes) };
          stateValue(host.store.writeCheckpoint(host.authority, { checkpointId, expectedRevision: stateValue(host.store.inspect()).revision, candidateManifest: manifest, workspace: wsRef, privateSession: sessRef, additionalArtifacts: [] }));
          return { ok: true, value: { checkpointId, candidate: manifest, workspace: wsRef, session: sessRef } };
        },
      };
      return { ok: true, value: adapter };
    };

    const parkRunMidGate = async (runId: string, allowWorkflowWrites: boolean) => {
      const context = await createCycle(
        { configuration: loaded, repository, runRoot, runId },
        { openAdapter, policyProfile: 'github', allowWorkflowWrites },
      );
      const cycle = new Cycle(context);
      await cycle.bootstrap();
      await cycle.role('build');
      const slot = context.plan.verifierSlots.find(s => s.handler.implementation === 'gate.v1')!;
      const nonce = randomBytes(16).toString('hex');
      const job = prepareGate(context.plan, context.lock, slot.id, cycle.candidate, cycle.generation, nonce, loaded.registry.spec.gateEndpoints);
      const bound = bindSubject(context.lock, cycle.candidate.manifest);
      assert.ok(bound.ok);
      if (!bound.ok) throw new Error('bindSubject');
      const head = await context.progress.read();
      assert.ok(head);
      if (!head) throw new Error('head');
      const ordinal = context.plan.verifierSlots.findIndex(item => item.id === slot.id);
      await cycle.publish(
        {
          ...cycle.draft,
          stage: { ...cycle.draft.stage, kind: 'verifier_pre' },
          verifierReceipts: [{ slot: slot.id, generation: cycle.generation, operationId: job.operationId, producerNonce: nonce, output: null, receipt: null }],
        },
        `verify.${cycle.generation}.${ordinal}.pre`,
      );
      stateValue(context.store.putIntent(context.authority, {
        operationId: job.operationId, nodeId: context.plan.orderedDAG[0]!.id,
        attemptId: 'job.' + hash(job.operationId + '\0' + nonce).hex.slice(0, 40),
        effect: 'read_only', requestDigest: job.requestDigest,
        targetIdentity: `gate:${slot.id}:${cycle.generation}:${bound.value.candidateDigest.hex}`,
      }));
      const dispatched = stateValue(context.store.authorizeOperationDispatch(context.authority, job.operationId));
      if (dispatched.kind !== 'new_dispatch') throw new Error('dispatch');
      const op = stateValue(context.store.getOperation(job.operationId));
      const storeId = stateValue(context.store.inspect()).storeId;
      const req: Record<string, unknown> = {
        version: 1, kind: 'gate_request', gateId: 'merge-gate', checkId: slot.checkId,
        candidateDigest: bound.value.candidateDigest.hex, subject: bound.value,
        storeId, runId, lockHash: context.lock.spec.lockHash, operationId: job.operationId,
        dispatchId: dispatched.permit.dispatchId, dispatchGeneration: dispatched.permit.generation, requestDigest: job.requestDigest.hex,
      };
      const prefix = join(context.artifacts.directory, 'gate-producer-' + hash(job.operationId + '\0' + nonce).hex);
      await writeFile(prefix + '.binding.json', canonical({
        version: 1, planDigest: context.plan.planDigest, operationId: job.operationId, producerNonce: nonce,
        requestDigest: job.requestDigest, requestBytesDigest: hash(Buffer.from(canonical(req))).hex, intentDigest: op.intentDigest,
        subject: bound.value, generation: cycle.generation, endpoint: 'ci-gate',
        dispatchReceipt: { generation: dispatched.permit.generation, dispatchId: dispatched.permit.dispatchId, revision: dispatched.permit.authorizedRevision, clockEpoch: dispatched.permit.clockEpoch },
      }), { mode: 0o600 });
      await cycle.deadline.dispose();
      await cycle.events.suspend();
      stateValue(context.store.release(context.authority));
      stateValue(context.store.close());
      await context.owner.release();
      const deniedBody = {
        version: 1, kind: 'gate_verdict', storeId, runId, lockHash: context.lock.spec.lockHash,
        operationId: job.operationId, dispatchId: dispatched.permit.dispatchId, dispatchGeneration: dispatched.permit.generation,
        gateId: 'merge-gate', checkId: slot.checkId, candidateDigest: bound.value.candidateDigest.hex,
        status: 'denied' as const, reason: 'workflow_fix_required', expiresAtMs: String(Date.now() + 600_000),
      };
      const rPath = join(tmpdir(), `s05-rec-ports-${runId}-${process.pid}.json`);
      await writeFile(rPath, JSON.stringify({ ...deniedBody, signature: signGateVerdict(GATE_SECRET, deniedBody) }), { mode: 0o600 });
      return rPath;
    };

    // 1. Under policyProfile: 'github' with allowWorkflowWrites: false, repair touching .github/workflows/ci.yml fails closed (even when ports omit policyProfile!)
    const rPathBlocked = await parkRunMidGate('run-rec-wf-blocked', false);
    const blockedRes = await reconcileCycle(
      { configuration: loaded, runRoot, runId: 'run-rec-wf-blocked', receipt: rPathBlocked },
      { openAdapter, gateUrlOverrides: { 'ci-gate': approvingGate.url } },
    );
    assert.equal(blockedRes.ok, false);
    await rm(rPathBlocked, { force: true });

    // 2. With { policyProfile: 'github', allowWorkflowWrites: true }, repair touching .github/workflows/ci.yml succeeds and settles completed!
    let routingCalls = 0;
    const decisions: import('../src/types.js').AdvisoryDecisionPort = {
      routeCapabilityTier: async () => {
        routingCalls++;
        return { tier: 'balanced', source: 'deterministic_heuristic' };
      },
    };
    const rPathAllowed = await parkRunMidGate('run-rec-wf-allowed', true);
    const allowedRes = await reconcileCycle(
      { configuration: loaded, runRoot, runId: 'run-rec-wf-allowed', receipt: rPathAllowed },
      { policyProfile: 'github', allowWorkflowWrites: true, openAdapter, gateUrlOverrides: { 'ci-gate': approvingGate.url }, decisions },
    );
    assert.ok(allowedRes.ok && allowedRes.value.kind === 'settled', JSON.stringify(allowedRes.ok ? allowedRes.value : allowedRes.error));
    if (allowedRes.ok && allowedRes.value.kind === 'settled') {
      assert.equal(allowedRes.value.status, 'completed');
    }
    assert.ok(routingCalls >= 1, 'expected AdvisoryDecisionPort to be invoked during reconciled repair');
    await rm(rPathAllowed, { force: true });
  } finally {
    await f.cleanup();
    await hangingGate.close();
    await approvingGate.close();
  }
});
