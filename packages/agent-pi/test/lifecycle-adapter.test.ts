import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { constructAdapter } from '../src/adapter.js';
import { canonical, digest } from '../src/boundary.js';
import { requestFixture } from './request-fixtures.js';
import type { PiCapabilities } from '../src/types.js';
async function fixture() {
  const f = await requestFixture(undefined, undefined, 10000); let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  try {
  const opened = await constructAdapter(f.host, f.input, { environment: async () => {}, session: () => ({
    start: async (): Promise<PiCapabilities> => ({ version: 1, policyDigest: digest(Buffer.from(canonical(f.input.policy))), runtime: f.input.policy.runtime, requested: f.input.policy.selection, catalogSupported: f.input.policy.selection, sessionEffective: f.input.policy.selection, outboundObserved: null,
      resources: f.input.policy.resources, accounting: 'soft_only', contextFit: 'unproven', defaultMode: 'proven_bound', liveProvenBoundAvailable: false, optInMode: 'estimated_guard', contextEstimator: { id: 'lw-pi-final-json-bytes-v1', version: 1, provenance: 'estimated' }, toolExecution: { candidate: 'read_only', candidateWrites: 'mediated', scratch: 'per_call' } }),
    command: async () => { entered(); await waiting; }, close: async () => { release(); },
  }) }); assert.equal(opened.ok, true); if (!opened.ok) throw new Error('fixture adapter'); return { ...f, adapter: opened.value, started };
  } catch (error) { await f.cleanup(); throw error; }
}
test('the production adapter exposes a redacted resource identity as its first ordered event', async () => {
  const f = await fixture();
  try {
    const next = await f.adapter.events()[Symbol.asyncIterator]().next(); assert.equal(next.done, false); if (next.done) throw new Error('missing first event');
    assert.equal(next.value.kind, 'resource_identity'); assert.equal(next.value.sequence, 1); assert.equal(next.value.sessionId, f.input.sessionId);
    const value = next.value as unknown as Record<string, unknown>; assert.equal(canonical(value.lockHash), canonical(f.input.lock.spec.lockHash)); assert.equal(value.requestId, null); assert.equal(value.operationId, null);
    assert.ok(!JSON.stringify(value).includes('SYNTHETIC_HOST_SECRET'));
  } finally { await f.adapter.close(); await f.cleanup(); }
});
test('capture cannot overlap an executing command in the actual adapter', async () => {
  const f = await fixture(), running = f.adapter.execute({ commandId: 'running', text: 'literal task', purpose: 'task', repair: 'none' }); await f.started;
  try {
    const captured = await f.adapter.capture({ checkpointId: 'checkpoint-1' }); assert.equal(captured.ok, false); if (captured.ok) throw new Error('capture overlapped execution'); assert.equal(captured.error.code, 'SESSION_BUSY');
  } finally { await f.adapter.close(); await running; await f.cleanup(); }
});
test('a second adapter cannot bypass the retained run lifetime guard through another session directory', async () => {
  const f = await fixture();
  try {
    let starts = 0;
    const second = await constructAdapter({ ...f.host, directory: f.host.directory + '-other' }, f.input, { environment: async () => {}, session: () => ({ start: async () => { starts++; return f.adapter.capabilities(); }, command: async () => {}, close: async () => {} }) });
    if (second.ok) await second.value.close(); assert.equal(second.ok, false); assert.equal(starts, 0); if (!second.ok) assert.equal(second.error.code, 'SESSION_BUSY');
  } finally { await f.adapter.close(); await f.cleanup(); }
});

test('an unexecuted session has no settled capture boundary', async () => {
  const f = await fixture(); try { const capture = await f.adapter.capture({ checkpointId: 'before-execution' }); assert.equal(capture.ok, false); if (!capture.ok) assert.equal(capture.error.code, 'REQUEST_REFUSED'); } finally { await f.adapter.close(); await f.cleanup(); }
});

test('unverifiable birth or boot identity cannot remove a live execution guard', async () => {
  const f = await fixture(); let path: string | null = null, original: string | null = null;
  try {
    const name = (await readdir(f.host.artifactsDirectory)).find(name => name.startsWith('pi-execution-')); assert.ok(name); path = join(f.host.artifactsDirectory, name); original = await readFile(path, 'utf8');
    for (const patch of [{ birth: 'unverifiable-prior-birth' }, { boot: 'different-host-boot' }]) {
      const owner = JSON.parse(original.trim()); await writeFile(path, JSON.stringify({ ...owner, ...patch }) + '\n'); let starts = 0;
      const second = await constructAdapter(f.host, f.input, { environment: async () => {}, session: () => ({ start: async () => { starts++; return f.adapter.capabilities(); }, command: async () => {}, close: async () => {} }) });
      assert.equal(second.ok, false); assert.equal(starts, 0); if (!second.ok) assert.equal(second.error.code, 'RECOVERY_REQUIRED'); await writeFile(path, original);
    }
  } finally { if (path && original !== null) await writeFile(path, original); await f.adapter.close(); await f.cleanup(); }
});
