import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { bindSubject } from '@loopwright/core';
import { reopenLocalRun } from '@loopwright/state';
import { retainedFixture } from './progress-fixtures.js';
import { packetFixture, retainInventoryInputs } from './verification-fixtures.js';
import { cycleFixture } from './scheduling-fixtures.js';
import { ControllerEvents } from '../src/events.js';
import { evaluateControllerAcceptance } from '../src/acceptance.js';
import { ControllerFailure } from '../src/errors.js';
import { createCycle, Cycle, runCycleWithPorts, type RunDescriptor } from '../src/controller.js';
import { prepareVerification } from '../src/verification.js';
import { stateValue } from '../src/storage.js';
import { canonical, hash } from '../src/schema.js';

test('scheduling: queued events preserve a terminal slot and retain every accepted record after bounded backpressure', async () => {
  const f = await retainedFixture(); let stopped = 0, calls = 0, enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const events = new ControllerEvents(f.store, f.artifacts, async () => { calls++; enter(); await new Promise<void>(() => {}); }, () => { stopped++; });
  try {
    const first = events.push('waiting', null); void first.catch(() => {}); await entered;
    const before = await lstat(join(f.artifacts.directory, 'controller-events.open'));
    const pending = Array.from({ length: 126 }, () => events.push('waiting', null)); pending.forEach(promise => { void promise.catch(() => {}); });
    await assert.rejects(events.push('waiting', null), /OUTPUT_LIMIT/);
    const terminal = events.push('terminal', 'OUTPUT_LIMIT');
    const outcomes = await Promise.allSettled([first, ...pending, terminal]); assert.equal(outcomes.filter(outcome => outcome.status === 'rejected').length, 1);
    const ref = await events.close(), bytes = await f.artifacts.read(ref, 4194304), rows = Buffer.from(bytes).toString().trimEnd().split('\n').map(line => JSON.parse(line));
    assert.equal(rows.length, 128); assert.equal(rows.at(-1)!.stage, 'terminal'); assert.deepEqual(rows.map(row => row.sequence), Array.from({ length: 128 }, (_, index) => index + 1));
    assert.equal(calls, 1); assert.ok(stopped >= 1); const after = await lstat(join(f.artifacts.directory, ref.name)); assert.equal(after.ino, before.ino); assert.equal(after.nlink, 1);
    assert.equal(await lstat(join(f.artifacts.directory, 'controller-events.open')).then(() => false, error => error.code === 'ENOENT'), true);
    await writeFile(join(f.directory, 'event-backpressure-proof.json'), JSON.stringify({ version: 1, ref, accepted: 128, rejectedOrdinary: 1, callbacks: calls, beforeInode: before.ino, afterInode: after.ino, noBodyCopyAtSeal: true, providerRequests: 0 }), { mode: 0o600 });
  } finally { await events.close(); await f.close(); }
});

test('scheduling: an oversized public event is refused before append while the bounded terminal record remains available', async () => {
  const f = await retainedFixture(), events = new ControllerEvents(f.store, f.artifacts, undefined, () => {});
  try {
    const refs = Array.from({ length: 16 }, (_, index) => ({ name: 'a'.repeat(110) + index + '.bin', byteLength: 0, digest: hash('') }));
    await assert.rejects(events.push('role', null, null, null, refs), /OUTPUT_LIMIT/);
    await events.push('terminal', 'OUTPUT_LIMIT'); const ref = await events.close(), rows = Buffer.from(await f.artifacts.read(ref)).toString().trimEnd().split('\n').map(line => JSON.parse(line));
    assert.equal(rows.length, 1); assert.equal(rows[0].sequence, 1); assert.equal(rows[0].stage, 'terminal');
    await writeFile(join(f.directory, 'event-byte-cap-proof.json'), JSON.stringify({ version: 1, ref, acceptedTerminal: 1, refusedOversizeBeforeAppend: true }), { mode: 0o600 });
  } finally { await events.close(); await f.close(); }
});

test('scheduling: absent captured submission is null, cannot succeed, and preserves accounted cancellation with not_run checks', async () => {
  const packet = packetFixture(), f = await retainedFixture();
  try {
    const ref = await f.artifacts.json('manifest', packet.candidate, 32768); await retainInventoryInputs(f.artifacts, packet.candidate, ref, packet.candidateFiles);
    const blocked = evaluateControllerAcceptance(f.plan, f.lock, packet.candidate, packet.candidateFiles, 0, [], null, f.store);
    const cancelled = evaluateControllerAcceptance(f.plan, f.lock, packet.candidate, packet.candidateFiles, 0, [], null, f.store, 'cancelled');
    assert.equal(blocked.requestedStatus, null); assert.equal(blocked.result.spec.status, 'blocked'); assert.equal(cancelled.requestedStatus, null); assert.equal(cancelled.result.spec.status, 'cancelled');
    assert.ok(blocked.verifierMatrix.every(row => row.status === 'not_run')); assert.ok(cancelled.verifierMatrix.every(row => row.status === 'not_run'));
    assert.equal(stateValue(f.store.inspect()).counts.requests, 0); await writeFile(join(f.directory, 'null-submission-proof.json'), JSON.stringify({ version: 1, manifest: ref, blocked, cancelled, source: 'fresh-retained-unit-input', producerClaims: 0, requests: 0 }), { mode: 0o600 });
  } finally { await f.close(); }
});

test('scheduling: a full persisted failure-history bound refuses the next producer before an intent or Worker', async () => {
  const f = await cycleFixture(true), context = await createCycle({ configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId: 'run-limit' }, {}), cycle = new Cycle(context);
  try {
    await cycle.bootstrap(); const source = cycle.candidate, slot = context.plan.verifierSlots[1]!, job = prepareVerification(context.plan, context.lock, slot.id, source, source, 0, 'a'.repeat(32));
    const failures = Array.from({ length: 16 }, (_, index) => ({ signature: hash('explicit-synthetic-negative-history-' + index), count: 1, generation: 0, evidence: null }));
    await cycle.publish({ ...cycle.draft, stage: { ...cycle.draft.stage, kind: 'verifier_pre' }, failures, verifierReceipts: [{ slot: slot.id, generation: 0, operationId: job.operationId, producerNonce: job.producerNonce, output: null, receipt: null }] }, 'verify.0.1.pre');
    await assert.rejects(cycle.runVerifier(context.plan.verifierSlots[0]!.id), /OUTPUT_LIMIT/); assert.equal(stateValue(context.store.inspect()).counts.operations, 0);
    const reopened = await context.progress.read(); assert.equal(reopened!.progress.failures.length, 16);
    await writeFile(join(context.directory, 'failure-cap-proof.json'), JSON.stringify({ version: 1, checkpoint: reopened!.checkpoint, progress: reopened!.ref, history: 'explicit-synthetic-negative-fixture-no-positive-authority', nextProducerRefused: true, operations: 0, workerStarts: 0 }), { mode: 0o600 });
  } finally { await cycle.deadline.dispose(); await cycle.events.close(); stateValue(context.store.release(context.authority)); stateValue(context.store.close()); await context.owner.release(); }
});

test('scheduling: a secondary finalization failure preserves the original S02-bound primary without an extra command', async () => {
  const f = await cycleFixture(true); let opens = 0;
  const execution = await runCycleWithPorts({ configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId: 'run-secondary' }, {
    openAdapter: async () => { opens++; throw new Error('check-only'); },
    afterCheckpoint: async phase => { if (phase === 'terminal.result') throw new ControllerFailure({ version: 1, code: 'OUTPUT_LIMIT', phase: 'finalization', path: '', stateCode: null, piCode: null, effect: 'none', retryable: false }); },
  });
  const directory = join(f.runRoot, 'run-secondary');
  await writeFile(join(directory, 'unit-secondary-raw-return.json'), JSON.stringify({ version: 1, rawReturned: execution, opens, retainedBeforeAssertions: true }), { mode: 0o600 });
  assert.equal(execution.ok, true); if (!execution.ok) return; assert.equal(execution.value.kind, 'result'); if (execution.value.kind !== 'result') return;
  assert.equal(execution.value.result.spec.status, 'completed'); assert.deepEqual(execution.value.secondary, ['OUTPUT_LIMIT']); assert.equal(execution.value.observations, null); assert.equal(opens, 0);
  const descriptor = JSON.parse(await readFile(join(directory, 'run.json'), 'utf8')) as RunDescriptor, store = stateValue(reopenLocalRun(descriptor.identity));
  try {
    const checkpoints = stateValue(store.listCheckpoints({ limit: 100, cursor: null })).items, last = checkpoints.at(-1)!;
    const progress = JSON.parse(await readFile(join(directory, 'artifacts', last.additionalArtifacts[0]!.name), 'utf8'));
    assert.equal(progress.stage.phase, 'terminal.result'); assert.equal(last.sequence, 9); assert.equal(progress.terminalIntent.primary, 'completed');
    const primaryBytes = await readFile(join(directory, 'artifacts', progress.terminalIntent.result.name));
    assert.equal(primaryBytes.toString(), canonical(execution.value.result));
    assert.deepEqual(hash(primaryBytes), progress.terminalIntent.result.digest);
    assert.equal(primaryBytes.byteLength, progress.terminalIntent.result.byteLength);
    const bound = bindSubject(descriptor.identity.lock, JSON.parse(await readFile(join(directory, 'artifacts', progress.candidate.manifest.name), 'utf8'))); assert.equal(bound.ok, true);
    const view = stateValue(store.inspect()); assert.equal(view.counts.requests, 0); assert.equal(view.counts.operations, 3); assert.equal(view.owner.mode, null);
    await writeFile(join(directory, 'secondary-finalization-proof.json'), JSON.stringify({ version: 1, execution: execution.value, last, progress: last.additionalArtifacts[0], state: view, immutablePrimary: progress.terminalIntent.result, opens, nativeExecution: false }), { mode: 0o600 });
  } finally { stateValue(store.close()); }
});
