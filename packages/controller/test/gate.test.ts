import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { configurationFixture } from './config-fixtures.js';
import { installedHandlerDigests } from '../src/handlers.js';
import { runCycleWithPorts, type RunCycleInput } from '../src/controller.js';
import { resumeCycle } from '../src/recovery.js';
import { signPayload, verifySignedPayload } from '../src/gate.js';
import type { ControllerEvent } from '../src/events.js';
import { setFixture } from './progress-fixtures.js';

const GATE_SECRET = 'GATE_SIGNING_CANARY_Aa11Bb22Cc33', WRONG_SECRET = 'GATE_WRONG_KEY_CANARY_Zz00Yy11Xx22';
type VerdictScript = (request: Record<string, unknown>, attempt: number) => { readonly kind: 'verdict'; readonly status: 'pending' | 'approved' | 'denied' | 'expired'; readonly key?: string; readonly expiresAtMs?: string } | { readonly kind: 'hang' };
function gateServer(script: VerdictScript): Promise<{ readonly hits: () => number; readonly close: () => Promise<void>; readonly url: string }> {
  return new Promise(resolve => {
    let hits = 0;
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks), attempt = ++hits;
        const signature = request.headers['x-loopwright-signature'];
        if (typeof signature !== 'string' || !verifySignedPayload(GATE_SECRET, body, signature)) { response.writeHead(403).end(); return; }
        const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
        const directive = script(parsed, attempt);
        if (directive.kind === 'hang') { response.destroy(); return; }
        const verdict = { version: 1, kind: 'gate_verdict', storeId: parsed.storeId, runId: parsed.runId, lockHash: parsed.lockHash, operationId: parsed.operationId, dispatchId: parsed.dispatchId, dispatchGeneration: parsed.dispatchGeneration, gateId: parsed.gateId, checkId: parsed.checkId, candidateDigest: parsed.candidateDigest, status: directive.status, reason: directive.status === 'denied' ? 'policy refuses this candidate' : null, expiresAtMs: directive.expiresAtMs ?? String(Date.now() + 600000) };
        const bytes = Buffer.from(JSON.stringify(verdict));
        response.writeHead(200, { 'content-type': 'application/json', connection: 'close', 'x-loopwright-signature': signPayload(directive.key ?? GATE_SECRET, bytes) });
        response.end(bytes);
      })().catch(() => { try { response.writeHead(500).end(); } catch { /* socket already gone */ } });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      hits: () => hits, url: 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/gate',
      close: () => new Promise((done, fail) => { server.closeAllConnections(); server.close(error => error ? fail(error) : done()); }),
    }));
  });
}
async function gateCycleFixture(url: string, maxPollMs = 5000) {
  const f = await configurationFixture();
  f.environment.GATE_SECRET = GATE_SECRET;
  setFixture(f.registry, ['spec', 'credentialBindings'], [...f.registry.spec.credentialBindings, { id: 'gate-signer', consumer: 'gate', destinationRef: 'gate-service', environmentNames: ['GATE_SECRET'], template: '${GATE_SECRET}' }]);
  setFixture(f.registry, ['spec', 'environmentBindings'], [{ name: 'PROVIDER_TOKEN', classification: 'credential', paths: [] }, { name: 'GATE_SECRET', classification: 'credential', paths: ['/spec/credentials/0/template'] }]);
  setFixture(f.config, ['spec', 'credentials'], [{ ref: 'gate-signer', template: '${GATE_SECRET}' }]);
  setFixture(f.registry, ['spec', 'gateEndpoints'], [{ id: 'ci-gate', url, signingCredentialRef: 'gate-signer', authCredentialRef: null, timeoutMs: 1500, maxPollMs, pollInitialMs: 100, pollMaxMs: 200, jitter: 50 }]);
  const installed = await installedHandlerDigests();
  setFixture(f.registry, ['spec', 'handlers'], [...f.registry.spec.handlers, { id: 'approval', kind: 'check', implementation: 'gate.v1', version: 1, digest: installed['gate.v1'], parameters: { checkId: 'approval', endpointRef: 'ci-gate', gateId: 'merge-gate' }, capabilities: ['external_service', 'read_only'] }]);
  setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [{ id: 'approval', kind: 'check', uses: 'approval', roleId: null, dependsOn: [] }]);
  setFixture(f.config, ['spec', 'profiles', 'steps'], [{ stepId: 'approval', handlerRef: 'approval' }]);
  setFixture(f.config, ['spec', 'task', 'spec', 'acceptance'], { required: ['approval'], checks: [{ id: 'approval', allowedEvidenceLevels: ['external_service'] }] });
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
function input(f: Awaited<ReturnType<typeof gateCycleFixture>>, runId: string, onEvent?: (event: ControllerEvent) => Promise<void>, signal?: AbortSignal): RunCycleInput {
  return { configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId, ...(onEvent ? { onEvent } : {}), ...(signal ? { signal } : {}) };
}
async function cycle(input_: RunCycleInput) {
  const result = await runCycleWithPorts(input_);
  assert.equal(result.ok, true);
  if (result.value.kind === 'incident') console.error('INCIDENT', JSON.stringify(result.value.incident).slice(0, 500));
  return result.value;
}
test('gate HMAC verification refuses tampered payloads, wrong keys, uppercase hex, trailing garbage and truncated signatures', () => {
  const payload = 'canonical-bytes';
  assert.equal(verifySignedPayload(GATE_SECRET, payload, signPayload(GATE_SECRET, payload)), true);
  assert.equal(verifySignedPayload(GATE_SECRET, payload, 'sha256=' + signPayload(GATE_SECRET, payload)), true);
  assert.equal(verifySignedPayload(GATE_SECRET, payload, signPayload(GATE_SECRET, payload).toUpperCase()), false);
  assert.equal(verifySignedPayload(GATE_SECRET, payload, signPayload(GATE_SECRET, payload) + 'zz'), false);
  assert.equal(verifySignedPayload(WRONG_SECRET, payload, signPayload(GATE_SECRET, payload)), false);
  const tampered = signPayload(GATE_SECRET, payload), flip = (tampered[0] === 'a' ? 'b' : 'a') + tampered.slice(1);
  assert.equal(verifySignedPayload(GATE_SECRET, payload, flip), false);
  assert.equal(verifySignedPayload(GATE_SECRET, payload, tampered.slice(0, -2)), false);
  assert.equal(verifySignedPayload(GATE_SECRET, payload + '!', tampered), false);
});
test('an authenticated gate approves a pending candidate with bounded polling, gate_waiting events and external_service evidence', async () => {
  const gate = await gateServer((_request, attempt) => attempt === 1 ? { kind: 'verdict', status: 'pending' } : { kind: 'verdict', status: 'approved' });
  let f: Awaited<ReturnType<typeof gateCycleFixture>> | null = null;
  try {
    f = await gateCycleFixture(gate.url);
    const seen: ControllerEvent[] = [], execution = await cycle(input(f, 'run-gate-approved', async event => { seen.push(event); }));
    assert.equal(execution.kind, 'result'); if (execution.kind !== 'result') return;
    assert.equal(execution.result.spec.status, 'completed');
    assert.deepEqual(execution.result.spec.verification.spec.required.map(row => [row.checkId, row.status]), [['approval', 'passed']]);
    const waiting = seen.filter(event => event.stage === 'gate_waiting');
    assert.ok(waiting.length >= 1); assert.equal(waiting.length, new Set(waiting.map(event => JSON.stringify(event.gate))).size);
    assert.ok(waiting.every(event => event.gate !== null && event.gate.gateId === 'merge-gate' && typeof event.gate.operationId === 'string' && event.gate.operationId.length > 0 && event.gate.nextPollMs > 0 && event.gate.elapsedMs >= 0 && Number.isFinite(event.gate.deadlineMs) && event.gate.deadlineMs >= 0));
    assert.ok(!JSON.stringify({ execution, seen }).includes(GATE_SECRET));
    assert.equal(gate.hits(), 2);
  } finally { if (f) await f.cleanup(); await gate.close(); }
});
test('denied, expired and protocol-invalid verdicts fail closed without ever fabricating passed evidence', async () => {
  const cases = [['denied', () => ({ kind: 'verdict' as const, status: 'denied' as const })], ['expired', () => ({ kind: 'verdict' as const, status: 'expired' as const })], ['wrong-key', () => ({ kind: 'verdict' as const, status: 'approved' as const, key: WRONG_SECRET })]] as const;
  for (const [mode, script] of cases) {
    const gate = await gateServer(script);
    let f: Awaited<ReturnType<typeof gateCycleFixture>> | null = null;
    try {
      f = await gateCycleFixture(gate.url);
      const execution = await cycle(input(f, 'run-gate-' + mode));
      assert.equal(execution.kind, 'result', mode); if (execution.kind !== 'result') return;
      const status = execution.result.spec.status;
      if (mode === 'denied') assert.equal(status, 'failed', mode); else assert.equal(status, 'blocked', mode);
      assert.ok(!JSON.stringify(execution).includes(GATE_SECRET), mode);
      assert.equal(gate.hits(), 1, mode);
    } finally { if (f) await f.cleanup(); await gate.close(); }
  }
});
test('an unreachable gate and a pending-forever gate block with GATE_TIMEOUT inside the bounded poll window', async () => {
  const gate = await gateServer(() => ({ kind: 'hang' }));
  try {
    for (const [mode, url] of [['unreachable', 'http://127.0.0.1:1/gate'], ['pending-forever', gate.url]] as const) {
      let f: Awaited<ReturnType<typeof gateCycleFixture>> | null = null;
      try {
        f = await gateCycleFixture(url, 1000);
        const execution = await cycle(input(f, 'run-gate-' + mode));
        assert.equal(execution.kind, 'result', mode); if (execution.kind !== 'result') return;
        assert.equal(execution.result.spec.status, 'blocked', mode);
        assert.equal(execution.result.spec.verification.spec.required.find(row => row.checkId === 'approval')?.status, 'blocked', mode);
        assert.ok(!JSON.stringify(execution).includes(GATE_SECRET), mode);
      } finally { if (f) await f.cleanup(); }
    }
  } finally { await gate.close(); }
});
test('the poll window caps at the permit lease: a 90s maxPollMs clamps to the 60s lease minus its safety margin', async () => {
  const gate = await gateServer((_request, attempt) => attempt === 1 ? { kind: 'verdict', status: 'pending' } : { kind: 'verdict', status: 'approved' });
  let f: Awaited<ReturnType<typeof gateCycleFixture>> | null = null;
  try {
    f = await gateCycleFixture(gate.url, 90000);
    const seen: ControllerEvent[] = [], execution = await cycle(input(f, 'run-gate-lease-cap', async event => { seen.push(event); }));
    assert.equal(execution.kind, 'result'); if (execution.kind !== 'result') return;
    assert.equal(execution.result.spec.status, 'completed');
    const waiting = seen.filter(event => event.stage === 'gate_waiting');
    assert.ok(waiting.length >= 1);
    assert.ok(waiting.every(event => event.gate !== null && event.gate.deadlineMs <= 58000 && event.gate.deadlineMs >= 50000));
  } finally { if (f) await f.cleanup(); await gate.close(); }
});
test('the poll window caps at the remaining task budget after drain reserve, settling blocked GATE_TIMEOUT fast', async () => {
  const gate = await gateServer(() => ({ kind: 'hang' }));
  let f: Awaited<ReturnType<typeof gateCycleFixture>> | null = null;
  try {
    f = await gateCycleFixture(gate.url, 90000);
    // wallTimeMs 128000 leaves ~6s of poll window after the 120s drain reserve and its 2s margin.
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'wallTimeMs'], 128000);
    await f.save(); const loaded = await f.load(); assert.ok(loaded.ok); if (!loaded.ok) return;
    f.loaded = loaded.value;
    const seen: ControllerEvent[] = [], started = Date.now(), execution = await cycle(input(f, 'run-gate-budget-cap', async event => { seen.push(event); }));
    assert.equal(execution.kind, 'result'); if (execution.kind !== 'result') return;
    assert.equal(execution.result.spec.status, 'blocked');
    assert.equal(execution.result.spec.verification.spec.required.find(row => row.checkId === 'approval')?.detail, 'GATE_TIMEOUT');
    assert.ok(Date.now() - started < 12000);
    const waiting = seen.filter(event => event.stage === 'gate_waiting');
    assert.ok(waiting.length >= 1 && waiting.every(event => event.gate !== null && event.gate.deadlineMs <= 6000 && event.gate.deadlineMs >= 0));
  } finally { if (f) await f.cleanup(); await gate.close(); }
});
test('resume replays the retained gate receipt, never sends a replacement request, and an interrupted poll fails closed', async () => {
  const gate = await gateServer((_request, attempt) => attempt === 1 ? { kind: 'verdict', status: 'pending' } : { kind: 'verdict', status: 'approved' });
  let f: Awaited<ReturnType<typeof gateCycleFixture>> | null = null;
  try {
    f = await gateCycleFixture(gate.url, 1000);
    const controller = new AbortController(), seen: string[] = [];
    const execution = await cycle(input(f, 'run-gate-resume', async event => { seen.push(event.stage); if (event.stage === 'gate_waiting') controller.abort(); }, controller.signal));
    assert.ok(seen.includes('gate_waiting'));
    assert.equal(execution.kind, 'result'); if (execution.kind !== 'result') return;
    assert.equal(execution.result.spec.status, 'cancelled');
    const resumed = await resumeCycle(input(f, 'run-gate-resume'));
    assert.equal(resumed.ok, true); if (!resumed.ok) return;
    assert.equal(resumed.value.kind, 'result'); if (resumed.value.kind !== 'result') return;
    assert.equal(resumed.value.result.spec.status, 'cancelled');
    assert.ok(gate.hits() <= 1);
  } finally { if (f) await f.cleanup(); await gate.close(); }
});
test('an expired wall-clock approved verdict blocks on the first attempt without a retry', async () => {
  const gate = await gateServer(() => ({ kind: 'verdict', status: 'approved', expiresAtMs: String(Date.now() - 3600000) }));
  let f: Awaited<ReturnType<typeof gateCycleFixture>> | null = null;
  try {
    f = await gateCycleFixture(gate.url);
    const execution = await cycle(input(f, 'run-gate-expired-approved'));
    assert.equal(execution.kind, 'result'); if (execution.kind !== 'result') return;
    assert.equal(execution.result.spec.status, 'blocked');
    assert.equal(execution.result.spec.verification.spec.required.find(row => row.checkId === 'approval')?.status, 'blocked');
    assert.equal(gate.hits(), 1);
  } finally { if (f) await f.cleanup(); await gate.close(); }
});
test('a cross-candidate verdict terminates polling immediately as blocked', async () => {
  const { createServer } = await import('node:http');
  const crossGate = await new Promise<{ readonly hits: () => number; readonly close: () => Promise<void>; readonly url: string }>(resolve => {
    let hits = 0;
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks); hits++;
        const signature = request.headers['x-loopwright-signature'];
        if (typeof signature !== 'string' || !verifySignedPayload(GATE_SECRET, body, signature)) { response.writeHead(403).end(); return; }
        const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
        const verdict = { version: 1, kind: 'gate_verdict', storeId: parsed.storeId, runId: parsed.runId, lockHash: parsed.lockHash, operationId: parsed.operationId, dispatchId: parsed.dispatchId, dispatchGeneration: parsed.dispatchGeneration, gateId: parsed.gateId, checkId: parsed.checkId, candidateDigest: 'cross-candidate-digest', status: 'approved', reason: null, expiresAtMs: String(Date.now() + 600000) };
        const bytes = Buffer.from(JSON.stringify(verdict));
        response.writeHead(200, { 'content-type': 'application/json', connection: 'close', 'x-loopwright-signature': signPayload(GATE_SECRET, bytes) });
        response.end(bytes);
      })().catch(() => { try { response.writeHead(500).end(); } catch { /* socket already gone */ } });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      hits: () => hits, url: 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/gate',
      close: () => new Promise((done, fail) => { server.closeAllConnections(); server.close(error => error ? fail(error) : done()); }),
    }));
  });
  let f: Awaited<ReturnType<typeof gateCycleFixture>> | null = null;
  try {
    f = await gateCycleFixture(crossGate.url);
    const execution = await cycle(input(f, 'run-gate-cross'));
    assert.equal(execution.kind, 'result'); if (execution.kind !== 'result') return;
    assert.equal(execution.result.spec.status, 'blocked');
    assert.equal(crossGate.hits(), 1);
  } finally { if (f) await f.cleanup(); await crossGate.close(); }
});
test('resume replays a cancelled gate run without replacement requests even after a lost proof marker', async () => {
  const gate = await gateServer(() => ({ kind: 'verdict', status: 'pending' }));
  let f: Awaited<ReturnType<typeof gateCycleFixture>> | null = null;
  try {
    f = await gateCycleFixture(gate.url, 1200);
    const controller = new AbortController(), seen: string[] = [];
    const execution = await cycle(input(f, 'run-gate-crash', async event => { seen.push(event.stage); if (event.stage === 'gate_waiting') controller.abort(); }, controller.signal));
    assert.ok(seen.includes('gate_waiting'));
    assert.equal(execution.kind, 'result'); if (execution.kind !== 'result') return;
    assert.equal(execution.result.spec.status, 'cancelled');
    const artifacts = join(f.runRoot, 'run-gate-crash', 'artifacts');
    const { readdir } = await import('node:fs/promises');
    for (const name of await readdir(artifacts)) if (name.startsWith('gate-producer-') && name.endsWith('.proof.json')) await rm(join(artifacts, name));
    const before = gate.hits(), resumed = await resumeCycle(input(f, 'run-gate-crash'));
    assert.equal(resumed.ok, true); if (!resumed.ok) return;
    assert.equal(resumed.value.kind, 'result'); if (resumed.value.kind !== 'result') return;
    // The cancelled run already terminalized; resume replays the retained result without any replacement request.
    assert.equal(resumed.value.result.spec.status, 'cancelled');
    assert.equal(gate.hits(), before);
  } finally { if (f) await f.cleanup(); await gate.close(); }
});
