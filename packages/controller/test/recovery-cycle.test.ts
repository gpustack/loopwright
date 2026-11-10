import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, lstat, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { bindSubject } from '@loopwright/core';
import { reopenLocalRun } from '@loopwright/state';
import { cycleFixture } from './scheduling-fixtures.js';
import { createCycle, type CycleContext } from '../src/controller.js';
import { resumeCycle, runCycle } from '../src/index.js';
import { setFixture } from './progress-fixtures.js';
import { hash } from '../src/schema.js';
import { canonical } from '../src/schema.js';
import { stateValue } from '../src/storage.js';
import { prepareVerification, Verifier } from '../src/verification.js';
import type { ControllerProgress } from '../src/types.js';
async function setup(valid = true) {
  const f = await cycleFixture(valid), input = { configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId: 'resume-cycle' };
  const context = await createCycle(input, {}), original = stateValue(context.store.inspect());
  return { f, input, context, original };
}
async function release(context: CycleContext) {
  stateValue(context.store.release(context.authority)); stateValue(context.store.close()); await context.owner.release();
}
async function bootstrap(context: CycleContext) {
  const manifest = await context.artifacts.json('manifest', context.source.manifest, 32768), subject = bindSubject(context.lock, context.source.manifest); assert.ok(subject.ok); if (!subject.ok) throw new Error('fixture');
  const draft: Omit<ControllerProgress, 'sequence' | 'previous' | 'stage'> & { stage: Omit<ControllerProgress['stage'], 'consumed' | 'watermarks'> } = {
    version: 2, runId: context.lock.spec.runId, lockHash: context.lock.spec.lockHash, stage: { kind: 'bootstrap', phase: 'bootstrap', capacity: context.plan.capacity },
    nodes: context.plan.orderedDAG.map(node => ({ id: node.id, state: 'pending' })), attempts: [], nativeCheckpoints: [], submission: null, publication: { status: 'idle', operationId: null, receipt: null },
    candidate: { manifest, digest: subject.value.candidateDigest, generation: 0, workspace: context.source.workspace, privateSession: null }, failures: [], verifierReceipts: [], verifierRefusals: [], eventSequence: 0, terminalIntent: null,
  };
  return context.progress.publish(draft, 'bootstrap');
}
for (const valid of [true, false]) for (const boundary of ['not_started', 'bootstrap', 'verifier_pre', 'verifier_receipt'] as const) test('recovery: public resume continues original ' + boundary + ' valid=' + valid + ' without replacement state or replay', async () => {
  const { input, context, original } = await setup(valid); let head = boundary === 'not_started' ? null : await bootstrap(context);
  if (boundary.startsWith('verifier_')) {
    const slot = context.plan.verifierSlots[0]!, nonce = randomBytes(16).toString('hex');
    const candidate = { manifest: context.source.manifest, ref: head!.progress.candidate.manifest, files: context.source.artifacts };
    const job = prepareVerification(context.plan, context.lock, slot.id, candidate, candidate, 0, nonce);
    head = await context.progress.publish({ ...head!.progress, stage: { ...head!.progress.stage, kind: 'verifier_pre' }, verifierReceipts: [{ slot: slot.id, generation: 0, operationId: job.operationId, producerNonce: nonce, output: null, receipt: null }] }, 'verify.0.0.pre');
    if (boundary === 'verifier_receipt') await new Verifier(context.store, context.authority, context.artifacts, context.plan, context.lock, () => head!.checkpoint.subject).run(job, new AbortController().signal);
  }
  await release(context);
  const result = await resumeCycle(input); assert.ok(result.ok, JSON.stringify(result)); if (!result.ok) return;
  assert.equal(result.value.kind, 'result', JSON.stringify(result)); if (result.value.kind !== 'result') return;
  assert.equal(result.value.result.spec.status, valid ? 'completed' : 'failed'); assert.deepEqual(result.value.secondary, []);
  const store = stateValue(reopenLocalRun(context.descriptor.identity));
  try { const view = stateValue(store.inspect()); assert.deepEqual(view.clock.basis, original.clock.basis); assert.equal(view.counts.requests, 0); assert.equal(view.counts.operations, 3); assert.equal(view.counts.checkpoints, 10); assert.equal(view.owner.mode, null); }
  finally { stateValue(store.close()); }
});
test('recovery: live controller refuses public resume before any state mutation', async () => {
  const { input, context, original } = await setup();
  try { const result = await resumeCycle(input); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, 'OWNER_BUSY'); assert.deepEqual(stateValue(context.store.inspect()).ledger, original.ledger); }
  finally { await release(context); }
});
test('recovery: completed terminal resume retains result and every checkpoint without another verifier or event', async () => {
  const f = await cycleFixture(true), input = { configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId: 'terminal-run' };
  const first = await runCycle(input); assert.ok(first.ok); if (!first.ok) return;
  const result = await resumeCycle(input); assert.ok(result.ok, JSON.stringify(result)); if (!result.ok) return; assert.equal(canonical(result.value), canonical(first.value));
  const descriptor = JSON.parse(await readFile(join(f.runRoot, 'terminal-run', 'run.json'), 'utf8'));
  const store = stateValue(reopenLocalRun(descriptor.identity)); try { const view = stateValue(store.inspect()); assert.equal(view.counts.checkpoints, 10); assert.equal(view.counts.operations, 3); assert.equal(view.counts.requests, 0); } finally { stateValue(store.close()); }
});
for (const damage of ['source', 'missing_state', 'descriptor'] as const) test('recovery: ' + damage + ' refuses retained execution without creating a replacement', async () => {
  const { input, context } = await setup(); await bootstrap(context); await release(context);
  if (damage === 'source') await writeFile(join(context.artifacts.directory, context.source.inventory.name), '{}', { mode: 0o600 });
  if (damage === 'missing_state') await rename(join(context.directory, 'state'), join(context.directory, 'state.retained'));
  if (damage === 'descriptor') await writeFile(join(context.directory, 'run.json'), JSON.stringify({ ...context.descriptor, repository: join(context.directory, 'different') }), { mode: 0o600 });
  const result = await resumeCycle(input); assert.equal(result.ok, false, JSON.stringify(result));
  if (damage === 'missing_state') assert.equal(await lstat(join(context.directory, 'state')).then(() => true, () => false), false);
});

test('recovery: unresolved original operation blocks public resume without an effect replay or allowance reset', async () => {
  const { input, context } = await setup(); await bootstrap(context);
  stateValue(context.store.putIntent(context.authority, { operationId: 'original-uncertain', nodeId: 'verify', attemptId: 'original-attempt', effect: 'read_only', requestDigest: hash('no physical worker in this journal window test'), targetIdentity: 'synthetic-dispatch-window' }));
  stateValue(context.store.authorizeOperationDispatch(context.authority, 'original-uncertain')); const before = stateValue(context.store.inspect()); await release(context);
  const result = await resumeCycle(input); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, 'RECOVERY_REQUIRED');
  const store = stateValue(reopenLocalRun(context.descriptor.identity)); try { const after = stateValue(store.inspect()); assert.deepEqual(after.clock.basis, before.clock.basis); assert.deepEqual(after.ledger, before.ledger); assert.deepEqual(after.counts, before.counts); } finally { stateValue(store.close()); }
});
test('recovery: original work cutoff finalizes expired within its retained drain reserve', async () => {
  const f = await cycleFixture(true); setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'wallTimeMs'], 120001); await f.save(); const loaded = await f.load(); assert.ok(loaded.ok); if (!loaded.ok) return;
  const input = { configuration: loaded.value, repository: f.repository, runRoot: f.runRoot, runId: 'cutoff-run' }, context = await createCycle(input, {}); await bootstrap(context); const original = stateValue(context.store.inspect()); await release(context);
  const result = await resumeCycle(input); assert.ok(result.ok, JSON.stringify(result)); if (!result.ok || result.value.kind !== 'result') return; assert.equal(result.value.result.spec.status, 'expired');
  const store = stateValue(reopenLocalRun(context.descriptor.identity)); try { const after = stateValue(store.inspect()); assert.equal(after.counts.operations, 0); assert.deepEqual(after.clock.basis, original.clock.basis); } finally { stateValue(store.close()); }
});
test('recovery: operator cancellation revokes new verifier dispatch then returns accounted cancellation', async () => {
  const f = await cycleFixture(true), abort = new AbortController(); const result = await runCycle({ configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId: 'cancel-run', signal: abort.signal, onEvent: async event => { if (event.stage === 'verification') abort.abort(); } });
  assert.ok(result.ok, JSON.stringify(result)); if (!result.ok) return; assert.equal(result.value.kind, 'result', JSON.stringify(result)); if (result.value.kind === 'result') assert.equal(result.value.result.spec.status, 'cancelled');
});
