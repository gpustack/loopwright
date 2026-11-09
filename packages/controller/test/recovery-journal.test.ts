import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { reopenLocalRun, type RequestAdmission, type TrustedEvidence } from '@loopwright/state';
import { ProgressStore, journal, stableId } from '../src/progress.js';
import { nativeSessionId } from '../src/capture.js';
import { stateValue } from '../src/storage.js';
import { canonical, hash } from '../src/schema.js';
import { ControllerFailure } from '../src/errors.js';
import { retainedFixture } from './progress-fixtures.js';

async function activeBoundary(f: Awaited<ReturnType<typeof retainedFixture>>) {
  const head = await f.progress.publish(f.draft, 'bootstrap'), command = await f.artifacts.put('command', Buffer.from('trusted unit command'), 16384);
  const attempt = { ordinal: 1, id: stableId('run-1', 'build', 'task', 'none', 1), nodeId: 'build', nativeStepId: 'build', sessionId: nativeSessionId('run-1', 'builder', 'build', f.plan.roles[0]!.policy),
    purpose: 'task' as const, repair: 'none' as const, command, before: head.progress.stage.watermarks, finished: null };
  return f.progress.publish({ ...head.progress, stage: { ...head.progress.stage, kind: 'role_pre' }, attempts: [attempt] }, 'role.1.pre');
}
function request(f: Awaited<ReturnType<typeof retainedFixture>>): RequestAdmission {
  return { requestId: 'request-1', roleId: 'builder', nodeId: 'build', attemptId: 'native-attempt-unit', purpose: 'task', repair: 'none', transportRetryOf: null,
    requestDigest: hash('unit journal window'), inputUpperBound: 80, outputUpperBound: 20, totalUpperBound: 100,
    capability: { adapterId: 'pi', adapterVersion: '0.0.0', provider: 'github-copilot', model: f.plan.roles[0]!.policy.selection.model, kind: 'soft_only', coversAllBillableTokens: false, enforcesOutputBound: false },
    operationId: 'op-request-1', targetIdentity: 'fixture:synthetic-no-physical-send' };
}
const recovery = (error: unknown) => error instanceof ControllerFailure && error.diagnostic.code === 'RECOVERY_REQUIRED';
test('a real S02 dispatch marker survives reopen, retains its original charge and never recreates a dispatch permit', async () => {
  const f = await retainedFixture();
  try {
    await activeBoundary(f); stateValue(f.store.reserveRequest(f.authority, request(f)));
    const dispatched = stateValue(f.store.authorizeRequestDispatch(f.authority, 'request-1')); assert.equal(dispatched.kind, 'new_dispatch');
    const before = journal(f.store); assert.equal(before.view.ledger.chargedTokens.decimal, '100'); assert.equal(before.view.counts.dispatchedRequests, 1);
    assert.throws(() => f.progress.decision(null), recovery);
    // Close/reopen the actual SQLite store with the original identity; no provider or SDK is involved.
    stateValue(f.store.close()); const store = stateValue(reopenLocalRun(f.identity));
    try {
      const retained = new ProgressStore(store, f.authority, f.artifacts, f.plan, f.lock, f.progress.planRef, f.progress.sourceRef), head = await retained.read();
      assert.ok(head); assert.equal(head.progress.attempts.length, 1); assert.equal(head.progress.stage.phase, 'role.1.pre'); assert.throws(() => retained.decision(head), recovery);
      const duplicate = stateValue(store.authorizeRequestDispatch(f.authority, 'request-1')); assert.equal(duplicate.kind, 'existing'); assert.equal('permit' in duplicate, false);
      const after = journal(store); assert.deepEqual(after.view.clock.basis, before.view.clock.basis); assert.deepEqual(after.view.ledger, before.view.ledger); assert.deepEqual(after.view.counts, before.view.counts);
      await writeFile(join(f.directory, 'unknown-window-result.json'), canonical({ version: 1, kind: 'synthetic-journal-no-physical-send', state: 'dispatch_authorized', chargedTokens: after.view.ledger.chargedTokens, originalClock: after.view.clock.basis, duplicatePermit: false, replayRefused: true }), { mode: 0o600 });
    } finally { stateValue(store.close()); }
  } finally { await f.close(); }
});
test('accounted provider usage without a native candidate/session capture refuses command replay', async () => {
  const f = await retainedFixture();
  try {
    await activeBoundary(f); stateValue(f.store.reserveRequest(f.authority, request(f))); stateValue(f.store.authorizeRequestDispatch(f.authority, 'request-1'));
    const operation = stateValue(f.store.getOperation('op-request-1')), view = stateValue(f.store.inspect()); assert.ok(operation.dispatch);
    const artifact = await f.artifacts.json('unit-receipt', { version: 1, kind: 'synthetic-no-physical-send', usage: { input: 10, output: 5 } });
    const evidence: TrustedEvidence = { evidenceId: 'unit-evidence-1', producerId: 'controller-unit', method: 'synthetic-journal-window',
      subject: { storeId: view.storeId, runId: view.runId, lockHash: view.lockHash, operationId: operation.intent.operationId, requestId: operation.linkedRequestId,
        intentDigest: operation.intentDigest, dispatchGeneration: operation.dispatch.generation, dispatchId: operation.dispatch.dispatchId }, artifact };
    stateValue(f.store.observeRequest(f.authority, 'request-1', { receiptId: 'unit-receipt-1', evidence, termination: 'confirmed', outcome: 'succeeded',
      usage: { requestId: 'request-1', inputTokens: { provenance: 'reported', value: 10 }, outputTokens: { provenance: 'reported', value: 5 }, costMicrousd: { provenance: 'unknown' } } }));
    const before = journal(f.store), head = await f.progress.read(); assert.equal(before.view.counts.observedRequests, 1); assert.equal(before.view.counts.unresolvedRequests, 0);
    assert.equal(before.view.ledger.chargedTokens.decimal, '15'); assert.equal(before.view.ledger.unknownCostRequests, 1); assert.throws(() => f.progress.decision(head), recovery);
    assert.equal(before.checkpoints.length, 2); assert.equal(before.checkpoints.some(cp => cp.privateSession !== null), false);
    assert.deepEqual(journal(f.store).view.ledger, before.view.ledger);
    await writeFile(join(f.directory, 'missing-capture-result.json'), canonical({ version: 1, kind: 'synthetic-journal-no-physical-send', observed: true, nativeCapture: false, replayRefused: true, ledger: before.view.ledger }), { mode: 0o600 });
  } finally { await f.close(); }
});
test('unassigned later journal work cannot be hidden behind a smaller bootstrap snapshot', async () => {
  const f = await retainedFixture();
  try {
    const head = await f.progress.publish(f.draft, 'bootstrap');
    stateValue(f.store.putIntent(f.authority, { operationId: 'unexpected-read', nodeId: 'build', attemptId: 'unexpected-attempt', effect: 'read_only', requestDigest: hash('later work'), targetIdentity: 'fixture:inert' }));
    assert.throws(() => f.progress.decision(head), recovery); assert.throws(() => f.progress.decision(null), recovery);
    assert.equal(journal(f.store).operations.length, 1); assert.equal(journal(f.store).checkpoints.length, 1);
  } finally { await f.close(); }
});
test('a terminal snapshot cannot hide journal work committed after finalization', async () => {
  const f = await retainedFixture();
  try {
    const initial = await f.progress.publish(f.draft, 'bootstrap');
    const terminal = await f.progress.publish({ ...initial.progress, stage: { ...initial.progress.stage, kind: 'terminal_intent' }, terminalIntent: { primary: 'blocked', result: null, observations: null } }, 'terminal.intent');
    assert.equal(f.progress.decision(terminal), 'terminal');
    stateValue(f.store.putIntent(f.authority, { operationId: 'late-after-terminal', nodeId: 'build', attemptId: 'late-terminal-attempt', effect: 'read_only', requestDigest: hash('late after terminal'), targetIdentity: 'fixture:no-send' }));
    assert.throws(() => f.progress.decision(terminal), recovery); assert.equal(journal(f.store).checkpoints.length, 2);
  } finally { await f.close(); }
});
