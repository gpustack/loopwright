import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ExecutionLease } from '../src/execution-lease.js';
import { PiFailure } from '../src/errors.js';
import { constructAdapter } from '../src/adapter.js';
import { Admission } from '../src/admission.js';
import { requestFixture, stateGood } from './request-fixtures.js';
async function retained() {
  const f = await requestFixture(undefined, undefined, 10000), child = join(f.directory, 'owner.mjs'), input = join(f.directory, 'owner-input.json');
  try {
  writeFileSync(input, JSON.stringify({ host: { ...f.host, store: undefined, resolveCredential: undefined }, input: f.input, identity: f.identity }));
  writeFileSync(child, `import{readFileSync,writeFileSync}from'node:fs';import{reopenLocalRun}from${JSON.stringify(import.meta.resolve('@loopwright/state'))};import{ExecutionLease}from${JSON.stringify(new URL('../src/execution-lease.js', import.meta.url).href)};const data=JSON.parse(readFileSync(process.argv[2],'utf8')),opened=reopenLocalRun(data.identity);if(!opened.ok)process.exit(10);await ExecutionLease.acquire({...data.host,store:opened.value,resolveCredential:async()=>{throw Error('unused')}},data.input);opened.value.close();writeFileSync(1,JSON.stringify({pid:process.pid}));process.exit(0);`);
  const owner = JSON.parse(execFileSync(process.execPath, [child, input], { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); assert.throws(() => process.kill(owner.pid, 0));
  const name = readdirSync(f.host.artifactsDirectory).find(name => name.startsWith('pi-execution-')); assert.ok(name);
  return { ...f, path: join(f.host.artifactsDirectory, name) };
  } catch (error) { await f.cleanup(); throw error; }
}
for (const mode of ['changed-endpoint', 'legacy', 'missing-binding', 'missing-endpoint', 'missing-identity', 'malformed-binding', 'alias', 'changed-identity', 'identity-query-failed', 'oversized-identity'] as const) {
  test('controlled retained guard preserves state and refuses ' + mode + ' before container effects', async () => {
    const f = await retained();
    try {
      const host = { ...f.host }, row = JSON.parse(readFileSync(f.path, 'utf8'));
      if (mode === 'changed-endpoint') host.dockerSocket = join(f.directory, 'other.sock');
      if (mode === 'legacy') { row.version = 1; delete row.daemon; }
      if (mode === 'missing-binding') delete row.daemon;
      if (mode === 'missing-endpoint') delete row.daemon.socket;
      if (mode === 'missing-identity') delete row.daemon.id;
      if (mode === 'malformed-binding') row.daemon = { socket: f.host.dockerSocket, id: '' };
      if (mode === 'alias') { host.dockerSocket = join(f.directory, 'alias.sock'); symlinkSync(f.host.dockerSocket, host.dockerSocket); }
      if (mode === 'changed-identity') f.daemon.setIdentity('replacement-daemon');
      if (mode === 'identity-query-failed') f.daemon.setIdentity('unavailable');
      if (mode === 'oversized-identity') f.daemon.setIdentity('X'.repeat(129));
      // A committed marker grants no replay permission. Preserve its original uncertainty/charge on refusal.
      new Admission(f.host, { destination: f.destination, fetch: globalThis.fetch }).issue(f.request, f.payload);
      stateGood(f.host.store.markRequestUnresolved(f.host.authority, f.request.requestId, 'connection_lost'));
      writeFileSync(f.path, JSON.stringify(row) + '\n'); const original = readFileSync(f.path), before = stateGood(f.host.store.inspect()); f.daemon.clearCalls();
      await assert.rejects(ExecutionLease.acquire(host, f.input), error => error instanceof PiFailure && error.detail.code === 'RECOVERY_REQUIRED');
      assert.deepEqual(readFileSync(f.path), original); const after = stateGood(f.host.store.inspect()); assert.equal(after.revision, before.revision); assert.deepEqual(after.clock.basis, before.clock.basis); assert.deepEqual(after.counts, before.counts); assert.deepEqual(after.ledger, before.ledger); assert.equal(after.counts.unresolvedRequests, 1); assert.equal(after.ledger.chargedTokens.decimal, '120');
      const queries = ['changed-identity', 'identity-query-failed', 'oversized-identity'].includes(mode); assert.equal(f.daemon.calls().length, queries ? 1 : 0); assert.ok(f.daemon.calls().every(args => args[4] === 'info')); assert.equal(f.physical(), 0);
    } finally { await f.cleanup(); }
  });
}
test('controlled same-daemon retained guard verifies identity and recovers after actual owner exit', async () => {
  const f = await retained();
  try { const original = JSON.parse(readFileSync(f.path, 'utf8')); f.daemon.clearCalls(); const next = await ExecutionLease.acquire(f.host, f.input); const current = JSON.parse(readFileSync(f.path, 'utf8')); assert.equal(current.version, 2); assert.deepEqual(current.daemon, { socket: f.host.dockerSocket, id: 'fixture-daemon-1' }); assert.notEqual(current.pid, original.pid); assert.notEqual(current.token, original.token); assert.equal(f.daemon.calls().length, 1); assert.equal(f.daemon.calls()[0]![4], 'info'); await next.release(); }
  finally { await f.cleanup(); }
});
for (const mode of ['endpoint', 'identity', 'query-failed'] as const) test('public adapter ' + mode + ' refusal preserves S02 revision and makes zero container or SDK calls', async () => {
  const f = await retained(); let starts = 0;
  try {
    const original = readFileSync(f.path), before = stateGood(f.host.store.inspect()); f.daemon.clearCalls();
    if (mode !== 'endpoint') f.daemon.setIdentity(mode === 'identity' ? 'replacement-daemon' : 'unavailable');
    const result = await constructAdapter({ ...f.host, dockerSocket: mode === 'endpoint' ? join(f.directory, 'unselected.sock') : f.host.dockerSocket }, f.input, { environment: async () => {}, session: () => ({ start: async () => { starts++; throw new Error('No SDK start allowed'); }, command: async () => {}, close: async () => {} }) });
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, 'RECOVERY_REQUIRED'); assert.equal(starts, 0); assert.equal(f.daemon.calls().length, mode === 'endpoint' ? 0 : 1); assert.ok(f.daemon.calls().every(args => args[4] === 'info'));
    assert.deepEqual(readFileSync(f.path), original); assert.equal(stateGood(f.host.store.inspect()).revision, before.revision);
  } finally { await f.cleanup(); }
});

for (const mode of ['alias', 'query-failed'] as const) for (const boundary of ['guard', 'public'] as const) test('fresh ' + boundary + ' ' + mode + ' reports containment unavailable without retaining a guard', async () => {
  const f = await requestFixture(undefined, undefined, 10000); let starts = 0;
  try {
    const host = { ...f.host }; if (mode === 'alias') { host.dockerSocket = join(f.directory, 'alias.sock'); symlinkSync(f.host.dockerSocket, host.dockerSocket); } else f.daemon.setIdentity('unavailable');
    const before = stateGood(f.host.store.inspect()); f.daemon.clearCalls();
    if (boundary === 'guard') await assert.rejects(ExecutionLease.acquire(host, f.input), error => error instanceof PiFailure && error.detail.code === 'CONTAINMENT_UNAVAILABLE');
    else { const result = await constructAdapter(host, f.input, { environment: async () => {}, session: () => ({ start: async () => { starts++; throw new Error('No SDK start allowed'); }, command: async () => {}, close: async () => {} }) }); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, 'CONTAINMENT_UNAVAILABLE'); }
    assert.equal(starts, 0); assert.equal(f.daemon.calls().length, mode === 'alias' ? 0 : 1); assert.ok(f.daemon.calls().every(args => args[4] === 'info')); assert.equal(f.physical(), 0); assert.equal(stateGood(f.host.store.inspect()).revision, before.revision);
    assert.ok(readdirSync(f.host.artifactsDirectory).every(name => !name.startsWith('pi-execution-')));
    f.daemon.setIdentity('fixture-daemon-1'); const valid = await ExecutionLease.acquire(f.host, f.input); await valid.release();
  } finally { await f.cleanup(); }
});
