import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalRun, type StateResult } from '@loopwright/state';
import { constructAdapter, type FactoryPorts } from '../src/adapter.js';
import { canonical, digest } from '../src/boundary.js';
import type { PiHost, PiOpenInput, PiCapabilities } from '../src/types.js';
import { sessionInput } from './session-fixtures.js';
import { daemonFixture } from './daemon-fixtures.js';
function good<T>(result: StateResult<T>): T { assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw new Error('fixture failed'); return result.value; }
function fixture() {
  const input = sessionInput(), directory = mkdtempSync(join(realpathSync(tmpdir()), 'loopwright-pi-session-'));
  mkdirSync(join(directory, 'runtime')); mkdirSync(join(directory, 'artifacts')); const daemon = daemonFixture(directory);
  const store = good(createLocalRun({ directory: join(directory, 'state'), storeId: 'store-1', lock: input.lock,
    policy: { version: 1, leaseMs: 10000, cost: 'observe_only' }, binding: { coreApiVersion: 'loopwright.dev/v1alpha1', hostVersion: 'test', adapters: [{ id: 'pi', version: '0.0.0' }], resourceVersion: input.policy.resourceVersion, clockEpoch: 'fixture-boot' } }));
  const view = good(store.inspect()), claimed = good(store.claim({ ownerId: 'owner-1', expectedGeneration: view.owner.generation, expectedRevision: view.revision, mode: 'active' }));
  const host: PiHost = { store, authority: claimed.authority, directory: join(directory, 'runtime'), artifactsDirectory: join(directory, 'artifacts'), dockerExecutable: daemon.dockerExecutable, dockerSocket: daemon.dockerSocket, runtime: input.policy.runtime,
    resolveCredential: async () => { throw new Error('preflight must not request credentials'); } };
  let starts = 0, closes = 0, environments = 0;
  const ports: FactoryPorts = { environment: async () => { environments++; }, session: (_host, owned: PiOpenInput) => ({
    start: async (): Promise<PiCapabilities> => { starts++; return { version: 1, policyDigest: digest(Buffer.from(canonical(owned.policy))), runtime: owned.policy.runtime,
      requested: owned.policy.selection, catalogSupported: owned.policy.selection, sessionEffective: owned.policy.selection, outboundObserved: null, resources: owned.policy.resources, accounting: 'soft_only', contextFit: 'unproven', defaultMode: 'proven_bound', liveProvenBoundAvailable: false, optInMode: 'estimated_guard', contextEstimator: { id: 'lw-pi-final-json-bytes-v1', version: 1, provenance: 'estimated' }, toolExecution: { candidate: 'read_only', candidateWrites: 'mediated', scratch: 'per_call' } }; },
    command: async () => { throw new Error('T1 public factory cannot send yet'); }, close: async () => { closes++; },
  }) };
  return { input, host, ports, counts: () => ({ starts, closes, environments }), cleanup: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
test('public package exports one factory and keeps test/SDK/state constructors internal', async () => {
  const exported = await import('../src/index.js'); assert.deepEqual(Object.keys(exported), ['openPiAdapter']);
});
test('factory validates before any runtime or credential effect and owns capability facts', async () => {
  const f = fixture();
  try {
    const bad = await constructAdapter(f.host, { ...f.input, roleId: 'forged' }, f.ports); assert.equal(bad.ok, false); assert.deepEqual(f.counts(), { starts: 0, closes: 0, environments: 0 });
    const opened = await constructAdapter(f.host, f.input, f.ports); assert.equal(opened.ok, true); if (!opened.ok) return;
    const facts = opened.value.capabilities(); assert.ok(Object.isFrozen(facts)); assert.equal(facts.outboundObserved, null); assert.equal(facts.contextFit, 'unproven');
    assert.equal((await opened.value.execute({ commandId: 'command-1', text: '/login', purpose: 'task', repair: 'none' })).ok, false);
    assert.equal((await opened.value.close()).ok, true); assert.equal((await opened.value.close()).ok, true); assert.equal(f.counts().closes, 1);
  } finally { f.cleanup(); }
});
test('stale supplied owner cannot start SDK or obtain a replacement claim', async () => {
  const f = fixture();
  try {
    const opened = await constructAdapter({ ...f.host, authority: { ...f.host.authority, generation: f.host.authority.generation + 1 } }, f.input, f.ports);
    assert.equal(opened.ok, false); if (!opened.ok) { assert.equal(opened.error.code, 'AUTHORITY_REFUSED'); assert.ok(opened.error.stateErrorCode); }
    assert.equal(f.counts().starts, 0); assert.equal(good(f.host.store.inspect()).owner.generation, f.host.authority.generation);
  } finally { f.cleanup(); }
});
