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
import { prepareGate, Gate, authenticatedGate, checkedGateVerdict, signPayload, verifySignedPayload } from '../src/gate.js';
import { signGateVerdict, verifyGateSignature, type GateVerdict } from '../src/index.js';
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

test('extended gate_verdict HMAC covers metrics, findings, detail, and retryablePreemption while preserving legacy 11-key compatibility', () => {
  const legacyVerdict: Record<string, unknown> = {
    version: 1,
    kind: 'gate_verdict',
    storeId: 'store.abc',
    runId: 'run-1',
    lockHash: { algorithm: 'sha256', hex: 'a'.repeat(64) },
    operationId: 'verify.op',
    dispatchId: 'dispatch-1',
    dispatchGeneration: 1,
    gateId: 'merge-gate',
    checkId: 'approval',
    candidateDigest: 'b'.repeat(64),
    status: 'approved',
    reason: null,
    expiresAtMs: '1800000000000',
  };
  const legacySig = signPayload(GATE_SECRET, Buffer.from(JSON.stringify(Object.fromEntries(Object.keys(legacyVerdict).sort().map(k => [k, legacyVerdict[k]])))));
  assert.equal(signGateVerdict(GATE_SECRET, legacyVerdict), legacySig);
  assert.equal(verifyGateSignature(GATE_SECRET, legacyVerdict, legacySig), true);

  const extended: Record<string, unknown> = {
    ...legacyVerdict,
    detail: 'Hardware benchmark passed latency target',
    metrics: { latency_us: 42.5, speedup: 1.18, delta: -0, kernel: 'gemm_fp16', verified: true },
    findings: [{ title: 'Minor occupancy note', severity: 'low', path: 'result.json', line: 1, evidence: '78% warps active' }],
    retryablePreemption: false,
  };
  const extSig = signGateVerdict(GATE_SECRET, extended);
  assert.notEqual(extSig, legacySig);
  assert.equal(verifyGateSignature(GATE_SECRET, extended, extSig), true);
  assert.equal(verifyGateSignature(GATE_SECRET, { ...extended, metrics: { latency_us: 42.6, speedup: 1.18, delta: 0, kernel: 'gemm_fp16', verified: true } }, extSig), false);
  assert.equal(verifyGateSignature(GATE_SECRET, { ...extended, findings: [] }, extSig), false);
  assert.equal(verifyGateSignature(GATE_SECRET, { ...extended, detail: 'tampered detail' }, extSig), false);
  assert.equal(verifyGateSignature(GATE_SECRET, { ...extended, retryablePreemption: true }, extSig), false);
  assert.throws(() => signGateVerdict(GATE_SECRET, { ...extended, metrics: { bad: Number.NaN } }));
  assert.throws(() => signGateVerdict(GATE_SECRET, { ...extended, metrics: { bad: Number.POSITIVE_INFINITY } }));

  // Recursive undefined stripping: nested optional undefined fields match omitted canonical signature
  const withNestedUndefined: Record<string, unknown> = {
    ...legacyVerdict,
    findings: [{ title: 't', severity: 'low', path: undefined, line: undefined, evidence: 'e' }],
  };
  const cleanFindings: Record<string, unknown> = {
    ...legacyVerdict,
    findings: [{ title: 't', severity: 'low', evidence: 'e' }],
  };
  const nestedSig = signGateVerdict(GATE_SECRET, withNestedUndefined);
  assert.equal(nestedSig, signGateVerdict(GATE_SECRET, cleanFindings));
  assert.equal(verifyGateSignature(GATE_SECRET, withNestedUndefined, nestedSig), true);
  assert.equal(verifyGateSignature(GATE_SECRET, cleanFindings, nestedSig), true);

  // Public type GateVerdict re-exported from index.ts + checkedGateVerdict rejects invalid retryablePreemption & lone UTF-16 surrogates
  const expected = {
    storeId: legacyVerdict.storeId,
    runId: legacyVerdict.runId,
    lockHash: legacyVerdict.lockHash,
    operationId: legacyVerdict.operationId,
    dispatchId: legacyVerdict.dispatchId,
    dispatchGeneration: legacyVerdict.dispatchGeneration,
    gateId: legacyVerdict.gateId,
    checkId: legacyVerdict.checkId,
    candidateDigest: legacyVerdict.candidateDigest,
  };
  const checkedApproved: GateVerdict = checkedGateVerdict(legacyVerdict, expected);
  assert.equal(checkedApproved.status, 'approved');
  assert.throws(() => checkedGateVerdict({ ...legacyVerdict, status: 'approved', retryablePreemption: true }, expected));
  assert.throws(() => checkedGateVerdict({ ...legacyVerdict, status: 'pending', retryablePreemption: true }, expected));
  assert.throws(() => checkedGateVerdict({ ...legacyVerdict, status: 'pending', retryablePreemption: false }, expected));
  assert.throws(() => checkedGateVerdict({ ...legacyVerdict, detail: 'bad \ud800 surrogate' }, expected));
  assert.throws(() => checkedGateVerdict({ ...legacyVerdict, metrics: { tag: 'bad \udfff surrogate' } }, expected));
  assert.throws(() => checkedGateVerdict({ ...legacyVerdict, findings: [{ title: 'bad \ud800', severity: 'low', evidence: 'ok' }] }, expected));
  assert.throws(() => checkedGateVerdict({ ...legacyVerdict, findings: [{ title: 'ok', severity: 'low', evidence: 'bad \udc00' }] }, expected));
  assert.throws(() => checkedGateVerdict({ ...legacyVerdict, status: 'denied', reason: 'bad \ud800 reason' }, expected));
});

test('approved and non-approved HTTP gate_verdicts propagate metrics (-0 -> 0), findings, detail, and retryablePreemption and reject tampering or invalid metrics', async () => {
  const customGate = (buildPayload: (parsed: Record<string, unknown>) => { rawText: string; sigOverride?: string }) =>
    new Promise<{ readonly url: string; readonly close: () => Promise<void> }>(resolve => {
      const server = createServer((request: IncomingMessage, response: ServerResponse) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(chunk as Buffer);
          const body = Buffer.concat(chunks);
          const signature = request.headers['x-loopwright-signature'];
          if (typeof signature !== 'string' || !verifySignedPayload(GATE_SECRET, body, signature)) { response.writeHead(403).end(); return; }
          const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
          const { rawText, sigOverride } = buildPayload(parsed);
          const bytes = Buffer.from(rawText, 'utf8');
          response.writeHead(200, { 'content-type': 'application/json', connection: 'close', 'x-loopwright-signature': sigOverride ?? signPayload(GATE_SECRET, bytes) });
          response.end(bytes);
        })().catch(() => { try { response.writeHead(500).end(); } catch { /* ignore */ } });
      });
      server.listen(0, '127.0.0.1', () => resolve({
        url: 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/gate',
        close: () => new Promise((done, fail) => { server.closeAllConnections(); server.close(error => error ? fail(error) : done()); }),
      }));
    });

  // 1. Approved verdict with float metrics (including -0 in raw JSON), findings, detail, and retryablePreemption: false
  const approvedGate = await customGate(parsed => {
    const base = {
      version: 1, kind: 'gate_verdict', storeId: parsed.storeId, runId: parsed.runId, lockHash: parsed.lockHash,
      operationId: parsed.operationId, dispatchId: parsed.dispatchId, dispatchGeneration: parsed.dispatchGeneration,
      gateId: parsed.gateId, checkId: parsed.checkId, candidateDigest: parsed.candidateDigest,
      status: 'approved', reason: null, expiresAtMs: String(Date.now() + 600000),
      detail: 'Approved with benchmark telemetry',
      findings: [{ title: ' Perf note ', severity: 'low', path: 'result.json', line: 1, evidence: 'p99=42.5us' }],
      retryablePreemption: false,
    };
    const rawText = JSON.stringify(base).slice(0, -1) + ',"metrics":{"latency_us":42.5,"speedup":1.18,"delta":-0}}';
    return { rawText };
  });
  let f1: Awaited<ReturnType<typeof gateCycleFixture>> | null = null;
  try {
    f1 = await gateCycleFixture(approvedGate.url);
    const execution = await cycle(input(f1, 'run-gate-ext-approved'));
    assert.equal(execution.kind, 'result');
    if (execution.kind === 'result') {
      assert.equal(execution.result.spec.status, 'completed');
      const row = execution.result.spec.verification.spec.required.find(r => r.checkId === 'approval')!;
      assert.equal(row.status, 'passed');
      assert.equal(row.reason, 'observed_pass');
      assert.equal(row.detail, 'Approved with benchmark telemetry');
      assert.equal(Object.getPrototypeOf(row.metrics), null);
      assert.deepEqual({ ...row.metrics }, { delta: 0, latency_us: 42.5, speedup: 1.18 });
      assert.equal(Object.is(row.metrics?.delta, 0), true);
      assert.deepEqual(row.findings?.map(item => ({ ...item })), [{ title: ' Perf note ', severity: 'low', path: 'result.json', line: 1, evidence: 'p99=42.5us' }]);
    }
    const resumed = await resumeCycle(input(f1, 'run-gate-ext-approved'));
    assert.equal(resumed.ok, true);
    if (resumed.ok && resumed.value.kind === 'result') {
      const row = resumed.value.result.spec.verification.spec.required.find(r => r.checkId === 'approval')!;
      assert.equal(row.detail, 'Approved with benchmark telemetry');
      assert.deepEqual({ ...row.metrics }, { delta: 0, latency_us: 42.5, speedup: 1.18 });
    }
  } finally { if (f1) await f1.cleanup(); await approvedGate.close(); }

  // 2. Non-approved (expired) verdict with retryablePreemption: true, metrics, findings, and detail -> stays blocked, preserves retryablePreemption
  const preemptedGate = await customGate(parsed => {
    const obj = {
      version: 1, kind: 'gate_verdict', storeId: parsed.storeId, runId: parsed.runId, lockHash: parsed.lockHash,
      operationId: parsed.operationId, dispatchId: parsed.dispatchId, dispatchGeneration: parsed.dispatchGeneration,
      gateId: parsed.gateId, checkId: parsed.checkId, candidateDigest: parsed.candidateDigest,
      status: 'expired', reason: 'spot_instance_evicted', expiresAtMs: String(Date.now() - 1000),
      detail: 'GPU worker preempted mid-benchmark',
      metrics: { completed_iters: 12, progress_ratio: 0.75 },
      findings: [{ title: 'Preempted', severity: 'medium', evidence: 'Spot node reclaimed' }],
      retryablePreemption: true,
    };
    return { rawText: JSON.stringify(obj) };
  });
  let f2: Awaited<ReturnType<typeof gateCycleFixture>> | null = null;
  try {
    f2 = await gateCycleFixture(preemptedGate.url);
    const execution = await cycle(input(f2, 'run-gate-preempted'));
    assert.equal(execution.kind, 'result');
    if (execution.kind === 'result') {
      assert.equal(execution.result.spec.status, 'blocked');
      const row = execution.result.spec.verification.spec.required.find(r => r.checkId === 'approval')!;
      assert.equal(row.status, 'blocked');
      assert.equal(row.detail, 'GPU worker preempted mid-benchmark');
      assert.deepEqual({ ...row.metrics }, { completed_iters: 12, progress_ratio: 0.75 });
      assert.equal(row.findings?.length, 1);
      const { readdir, readFile } = await import('node:fs/promises');
      const artDir = join(f2.runRoot, 'run-gate-preempted', 'artifacts');
      const outName = (await readdir(artDir)).find(name => name.startsWith('gate-output-'))!;
      const savedOut = JSON.parse(await readFile(join(artDir, outName), 'utf8')) as { verdict: { retryablePreemption?: boolean }; disposition: { retryablePreemption?: boolean; status: string } };
      assert.equal(savedOut.verdict.retryablePreemption, true);
      assert.equal(savedOut.disposition.retryablePreemption, true);
      assert.equal(savedOut.disposition.status, 'blocked');
    }
  } finally { if (f2) await f2.cleanup(); await preemptedGate.close(); }

  // 3. Invalid metrics (1e999 -> Infinity, __proto__ key) and tampered metrics after signing fail closed as blocked
  for (const [label, builder] of [
    ['overflow-float', (p: Record<string, unknown>) => ({
      rawText: `{"version":1,"kind":"gate_verdict","storeId":${JSON.stringify(p.storeId)},"runId":${JSON.stringify(p.runId)},"lockHash":${JSON.stringify(p.lockHash)},"operationId":${JSON.stringify(p.operationId)},"dispatchId":${JSON.stringify(p.dispatchId)},"dispatchGeneration":${String(p.dispatchGeneration)},"gateId":${JSON.stringify(p.gateId)},"checkId":${JSON.stringify(p.checkId)},"candidateDigest":${JSON.stringify(p.candidateDigest)},"status":"approved","reason":null,"expiresAtMs":"${Date.now() + 600000}","metrics":{"bad":1e999}}`,
    })],
    ['proto-key', (p: Record<string, unknown>) => ({
      rawText: `{"version":1,"kind":"gate_verdict","storeId":${JSON.stringify(p.storeId)},"runId":${JSON.stringify(p.runId)},"lockHash":${JSON.stringify(p.lockHash)},"operationId":${JSON.stringify(p.operationId)},"dispatchId":${JSON.stringify(p.dispatchId)},"dispatchGeneration":${String(p.dispatchGeneration)},"gateId":${JSON.stringify(p.gateId)},"checkId":${JSON.stringify(p.checkId)},"candidateDigest":${JSON.stringify(p.candidateDigest)},"status":"approved","reason":null,"expiresAtMs":"${Date.now() + 600000}","metrics":{"__proto__":1}}`,
    })],
    ['tampered-metrics', (p: Record<string, unknown>) => {
      const signed = JSON.stringify({
        version: 1, kind: 'gate_verdict', storeId: p.storeId, runId: p.runId, lockHash: p.lockHash,
        operationId: p.operationId, dispatchId: p.dispatchId, dispatchGeneration: p.dispatchGeneration,
        gateId: p.gateId, checkId: p.checkId, candidateDigest: p.candidateDigest,
        status: 'approved', reason: null, expiresAtMs: String(Date.now() + 600000), metrics: { speedup: 1.25 },
      });
      const sig = signPayload(GATE_SECRET, Buffer.from(signed, 'utf8'));
      return { rawText: signed.replace('1.25', '9.99'), sigOverride: sig };
    }],
    ['approved-preempted', (p: Record<string, unknown>) => ({
      rawText: JSON.stringify({
        version: 1, kind: 'gate_verdict', storeId: p.storeId, runId: p.runId, lockHash: p.lockHash,
        operationId: p.operationId, dispatchId: p.dispatchId, dispatchGeneration: p.dispatchGeneration,
        gateId: p.gateId, checkId: p.checkId, candidateDigest: p.candidateDigest,
        status: 'approved', reason: null, expiresAtMs: String(Date.now() + 600000), retryablePreemption: true,
      }),
    })],
    ['lone-surrogate-detail', (p: Record<string, unknown>) => ({
      rawText: `{"version":1,"kind":"gate_verdict","storeId":${JSON.stringify(p.storeId)},"runId":${JSON.stringify(p.runId)},"lockHash":${JSON.stringify(p.lockHash)},"operationId":${JSON.stringify(p.operationId)},"dispatchId":${JSON.stringify(p.dispatchId)},"dispatchGeneration":${String(p.dispatchGeneration)},"gateId":${JSON.stringify(p.gateId)},"checkId":${JSON.stringify(p.checkId)},"candidateDigest":${JSON.stringify(p.candidateDigest)},"status":"approved","reason":null,"expiresAtMs":"${Date.now() + 600000}","detail":"bad \\ud800 surrogate"}`,
    })],
  ] as const) {
    const badGate = await customGate(builder);
    let fb: Awaited<ReturnType<typeof gateCycleFixture>> | null = null;
    try {
      fb = await gateCycleFixture(badGate.url);
      const execution = await cycle(input(fb, 'run-gate-bad-' + label));
      assert.equal(execution.kind, 'result', label);
      if (execution.kind === 'result') assert.equal(execution.result.spec.status, 'blocked', label);
    } finally { if (fb) await fb.cleanup(); await badGate.close(); }
  }
});

test('prepareGate and Gate.run/restore succeed at rework generation > 16 when plan capacity allows it', async () => {
  const gate = await gateServer(() => ({ kind: 'verdict', status: 'approved' }));
  let f: Awaited<ReturnType<typeof gateCycleFixture>> | null = null;
  try {
    f = await gateCycleFixture(gate.url);
    const { createCycle } = await import('../src/controller.js');
    const { bindSubject } = await import('@loopwright/core');
    const { stateValue } = await import('../src/storage.js');
    const context = await createCycle(input(f, 'run-gate-gen20'), {});
    try {
      const widePlan = { ...context.plan, capacity: { ...context.plan.capacity, V: 32, J: 32 * context.plan.capacity.C } };
      const manifestRef = await context.artifacts.json('manifest', context.source.manifest, 32768);
      const bound = bindSubject(context.lock, context.source.manifest);
      assert.equal(bound.ok, true);
      if (!bound.ok) return;
      const slot = widePlan.verifierSlots.find(s => s.handler.implementation === 'gate.v1')!;
      const prepared = prepareGate(widePlan, context.lock, slot.id, { manifest: context.source.manifest, ref: manifestRef, files: context.source.artifacts }, 20, 'a'.repeat(32), f.loaded.registry.spec.gateEndpoints);
      assert.equal(prepared.generation, 20);
      const client = new Gate(context.store, context.authority, context.artifacts, widePlan, context.lock, () => GATE_SECRET, () => bound.value);
      const verified = await client.run(prepared, new AbortController().signal);
      assert.equal(verified.status, 'passed');
      assert.equal(verified.generation, 20);
      assert.equal(authenticatedGate(verified).evidence.spec.observedStatus, 'passed');
      const restored = await client.restore(prepared);
      assert.equal(restored.status, 'passed');
      assert.equal(restored.generation, 20);
    } finally {
      stateValue(context.store.release(context.authority));
      stateValue(context.store.close());
      await context.owner.release();
    }
  } finally { if (f) await f.cleanup(); await gate.close(); }
});

test('signed gate_verdict HTTP body between 20 KiB and 50 KiB verifies and propagates structured findings + metrics while > 64 KiB fails closed', async () => {
  const buildGate = (payloadBuilder: (parsed: Record<string, unknown>) => Buffer) =>
    new Promise<{ readonly url: string; readonly lastSize: () => number; readonly close: () => Promise<void> }>(resolve => {
      let lastSize = 0;
      const server = createServer((request: IncomingMessage, response: ServerResponse) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(chunk as Buffer);
          const body = Buffer.concat(chunks);
          const signature = request.headers['x-loopwright-signature'];
          if (typeof signature !== 'string' || !verifySignedPayload(GATE_SECRET, body, signature)) {
            response.writeHead(403).end();
            return;
          }
          const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
          const bytes = payloadBuilder(parsed);
          lastSize = bytes.byteLength;
          response.writeHead(200, {
            'content-type': 'application/json',
            connection: 'close',
            'x-loopwright-signature': signPayload(GATE_SECRET, bytes),
          });
          response.end(bytes);
        })().catch(() => {
          try { response.writeHead(500).end(); } catch { /* ignore */ }
        });
      });
      server.listen(0, '127.0.0.1', () =>
        resolve({
          url: 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/gate',
          lastSize: () => lastSize,
          close: () => new Promise((done, fail) => { server.closeAllConnections(); server.close(err => (err ? fail(err) : done())); }),
        }),
      );
    });

  // 1. ~36 KiB signed verdict (strictly between 20 KiB and 50 KiB) with 24 structured findings + 16 metrics
  const expectedFindings = Array.from({ length: 24 }, (_, idx) => ({
    title: `Benchmark regression advisory #${idx}`,
    severity: (idx % 2 === 0 ? 'low' : 'medium') as 'low' | 'medium',
    path: 'result.json',
    line: idx + 1,
    evidence: `tile_${idx}: ` + 'x'.repeat(1300),
  }));
  const expectedMetrics: Record<string, number | string | boolean> = {
    suite_passed: true,
    profile_name: 'hopper-fp8-dense',
  };
  for (let i = 0; i < 14; i++) {
    expectedMetrics[`kernel_${String(i).padStart(2, '0')}_ms`] = Number((1.25 + i * 0.5).toFixed(2));
  }

  const valid36kGate = await buildGate(parsed =>
    Buffer.from(
      JSON.stringify({
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
        detail: '36 KiB structured check verdict approved',
        metrics: expectedMetrics,
        findings: expectedFindings,
      }),
      'utf8',
    ),
  );
  let fValid: Awaited<ReturnType<typeof gateCycleFixture>> | null = null;
  try {
    fValid = await gateCycleFixture(valid36kGate.url);
    const execution = await cycle(input(fValid, 'run-gate-36k'));
    assert.ok(valid36kGate.lastSize() >= 20 * 1024 && valid36kGate.lastSize() <= 50 * 1024, `expected 20-50 KiB body, got ${valid36kGate.lastSize()}`);
    assert.equal(execution.kind, 'result');
    if (execution.kind === 'result') {
      assert.equal(execution.result.spec.status, 'completed');
      const checkRow = execution.result.spec.verification.spec.required.find(r => r.checkId === 'approval')!;
      assert.equal(checkRow.status, 'passed');
      assert.equal(checkRow.detail, '36 KiB structured check verdict approved');
      assert.deepEqual({ ...checkRow.metrics }, expectedMetrics);
      assert.equal(checkRow.findings?.length, 24);
      assert.deepEqual(checkRow.findings?.map(item => ({ ...item })), expectedFindings);
    }
    const resumed = await resumeCycle(input(fValid, 'run-gate-36k'));
    assert.equal(resumed.ok, true);
    if (resumed.ok && resumed.value.kind === 'result') {
      assert.equal(resumed.value.result.spec.status, 'completed');
      const checkRow = resumed.value.result.spec.verification.spec.required.find(r => r.checkId === 'approval')!;
      assert.equal(checkRow.findings?.length, 24);
    }
  } finally {
    if (fValid) await fValid.cleanup();
    await valid36kGate.close();
  }

  // 2. > 65_536 bytes signed verdict still fails closed as blocked (EVIDENCE_UNAVAILABLE)
  const oversizeGate = await buildGate(parsed => {
    const hugeFindings = Array.from({ length: 36 }, (_, idx) => ({
      title: `Oversize finding #${idx}`,
      severity: 'low' as const,
      evidence: 'y'.repeat(1900),
    }));
    return Buffer.from(
      JSON.stringify({
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
        findings: hugeFindings,
      }),
      'utf8',
    );
  });
  let fOver: Awaited<ReturnType<typeof gateCycleFixture>> | null = null;
  try {
    fOver = await gateCycleFixture(oversizeGate.url);
    const execution = await cycle(input(fOver, 'run-gate-over-64k'));
    assert.ok(oversizeGate.lastSize() > 65_536, `expected > 65536 body, got ${oversizeGate.lastSize()}`);
    assert.equal(execution.kind, 'result');
    if (execution.kind === 'result') {
      assert.equal(execution.result.spec.status, 'blocked');
      const checkRow = execution.result.spec.verification.spec.required.find(r => r.checkId === 'approval')!;
      assert.equal(checkRow.status, 'blocked');
      assert.equal(checkRow.detail, 'EVIDENCE_UNAVAILABLE');
    }
  } finally {
    if (fOver) await fOver.cleanup();
    await oversizeGate.close();
  }
});
