import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, link } from 'node:fs/promises';
import { join } from 'node:path';
import { ProgressStore, journal, phaseSchedule } from '../src/progress.js';
import { readArtifact, stateValue } from '../src/storage.js';
import { ControllerFailure } from '../src/errors.js';
import { retainedFixture } from './progress-fixtures.js';
import { canonical } from '../src/schema.js';
test('real S02 anchors immutable progress with exactly four additional refs and unchanged original clock', async () => {
  const f = await retainedFixture();
  try {
    const before = stateValue(f.store.inspect()), first = await f.progress.publish(f.draft, 'bootstrap');
    assert.equal(first.checkpoint.additionalArtifacts.length, 4); assert.equal(first.checkpoint.privateSession, null);
    assert.deepEqual(first.checkpoint.clockBasis, before.clock.basis); assert.equal(first.progress.sequence, 1); assert.equal(first.progress.previous, null);
    const loaded = await f.progress.read(); assert.equal(canonical(loaded), canonical(first)); assert.equal(f.progress.decision(loaded), 'safe');
    const readonly = new ProgressStore(f.store, null, { read: (ref, maximum) => readArtifact(f.artifacts.directory, ref, maximum) }, f.plan, f.lock, f.progress.planRef, f.progress.sourceRef);
    assert.equal(canonical(await readonly.read()), canonical(first)); await assert.rejects(readonly.publish(f.draft, 'bootstrap'));
    assert.equal(stateValue(f.store.inspect()).counts.checkpoints, 1);
  } finally { await f.close(); }
});
test('a lost post-commit ACK adopts the same authoritative checkpoint and cannot consume another slot', async () => {
  const f = await retainedFixture();
  try {
    await assert.rejects(f.progress.publish(f.draft, 'bootstrap', () => { throw new Error('planned lost ACK'); }));
    const before = journal(f.store), recovered = await f.progress.read(); assert.ok(recovered); assert.equal(recovered.progress.sequence, 1);
    const adopted = await f.progress.publish(f.draft, 'bootstrap'); assert.deepEqual(adopted, recovered);
    const after = journal(f.store); assert.equal(after.checkpoints.length, 1); assert.deepEqual(after.view.clock.basis, before.view.clock.basis); assert.deepEqual(after.view.ledger, before.view.ledger);
  } finally { await f.close(); }
});
test('unanchored orphan bytes grant no progress and replaced or hardlinked artifacts fail closed', async () => {
  const f = await retainedFixture();
  try {
    await f.artifacts.json('progress', { version: 1, orphan: true }); assert.equal(await f.progress.read(), null); assert.equal(f.progress.decision(null), 'not_started');
    const head = await f.progress.publish(f.draft, 'bootstrap'), path = join(f.artifacts.directory, head.ref.name), original = await readFile(path);
    await writeFile(path, Buffer.from('corrupt')); await assert.rejects(f.progress.read(), (error: unknown) => error instanceof ControllerFailure && error.diagnostic.code === 'ARTIFACT_INVALID');
    await writeFile(path, original); await link(path, join(f.artifacts.directory, 'hardlink.bin')); await assert.rejects(f.progress.read());
  } finally { await f.close(); }
});
test('the original complete phase schedule survives reads and cannot allocate unknown phases or reset capacity', async () => {
  const f = await retainedFixture();
  try {
    const head = await f.progress.publish(f.draft, 'bootstrap'), phases = phaseSchedule(f.plan.capacity);
    assert.equal(phases.length, f.plan.capacity.D); assert.equal(new Set(phases).size, phases.length);
    const altered = { ...f.draft, stage: { ...f.draft.stage, capacity: { ...f.plan.capacity, A: 16 } } };
    await assert.rejects(f.progress.publish(altered, 'terminal.intent')); await assert.rejects(f.progress.publish(f.draft, 'unplanned'));
    assert.deepEqual((await f.progress.read())!.progress.stage.capacity, head.progress.stage.capacity); assert.equal(stateValue(f.store.inspect()).counts.checkpoints, 1);
  } finally { await f.close(); }
});
