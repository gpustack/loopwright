import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { reopenLocalRun, type OperationReceipt } from '@loopwright/state';
import { retainedFixture } from './progress-fixtures.js';
import { ProgressStore, journal, phaseCheckpointId, phaseSchedule, stableId, verifierOperationId } from '../src/progress.js';
import { nativeSessionId } from '../src/capture.js';
import { stateValue } from '../src/storage.js';
import { canonical, hash } from '../src/schema.js';
import type { ControllerAttempt, ControllerProgress } from '../src/types.js';

// Real S02 capacity vectors. Native session/verifier/result bodies are deliberately synthetic and ineligible.
// These cases prove journal capacity/ordering/reopen behavior, never Pi execution or core acceptance.
async function schedule(checks: number, A: number, I: number, compaction = false) {
  const f = await retainedFixture(checks, A, I); let store = f.store, progress = f.progress;
  let head = await progress.publish(f.draft, 'bootstrap');
  const failure = { signature: hash('identical unit failure'), count: 1, generation: 0, evidence: null };
  const draft = (kind: ControllerProgress['stage']['kind']) => ({ ...head.progress, stage: { ...head.progress.stage, kind } });
  const verify = async () => {
    const generation = head.progress.candidate.generation;
    for (const [ordinal, slot] of f.plan.verifierSlots.entries()) {
      const operationId = verifierOperationId('run-1', slot.id, generation), producerNonce = hash('unit.' + operationId).hex.slice(0, 32);
      head = await progress.publish({ ...draft('verifier_pre'), verifierReceipts: [...head.progress.verifierReceipts, { slot: slot.id, generation, operationId, producerNonce, output: null, receipt: null }] }, `verify.${generation}.${ordinal}.pre`);
      stateValue(store.putIntent(f.authority, { operationId, nodeId: 'build', attemptId: 'unit-verifier-' + generation + '-' + ordinal, effect: 'read_only', requestDigest: hash('synthetic packet ' + operationId), targetIdentity: 'fixture:unit-verifier' }));
      const dispatched = stateValue(store.authorizeOperationDispatch(f.authority, operationId)); assert.equal(dispatched.kind, 'new_dispatch');
      const operation = stateValue(store.getOperation(operationId)), view = stateValue(store.inspect()); assert.ok(operation.dispatch);
      const output = await f.artifacts.json('unit-output', { version: 1, kind: 'synthetic-unit-producer', eligibleEvidence: false, producerNonce, generation, operationId });
      const receipt: OperationReceipt = { receiptId: 'unit-receipt-' + generation + '-' + ordinal, outcome: 'succeeded', evidence: { evidenceId: 'unit-evidence-' + generation + '-' + ordinal,
        producerId: 'unit-schedule', method: 'synthetic-capacity-vector', artifact: output, subject: { storeId: view.storeId, runId: view.runId, lockHash: view.lockHash, operationId, requestId: null,
          intentDigest: operation.intentDigest, dispatchGeneration: operation.dispatch.generation, dispatchId: operation.dispatch.dispatchId } } };
      const receiptRef = await f.artifacts.json('unit-receipt', receipt); stateValue(store.recordOperationReceipt(f.authority, operationId, receipt));
      head = await progress.publish({ ...draft('verifier_post'), verifierReceipts: head.progress.verifierReceipts.map(item => item.operationId === operationId ? { ...item, output, receipt: receiptRef } : item),
        failures: [generation === 0 ? failure : { ...failure, count: 2 }] }, `verify.${generation}.${ordinal}.post`);
    }
  };
  try {
    await verify();
    for (let ordinal = 1; ordinal <= A; ordinal++) {
      const purpose = compaction && ordinal === A ? 'compaction' : 'task', repair = ordinal === 1 || purpose === 'compaction' ? 'none' : 'implementation';
      const command = await f.artifacts.put('unit-command', Buffer.from('synthetic schedule command ' + ordinal));
      const attempt: ControllerAttempt = { ordinal, id: stableId('run-1', 'build', purpose, repair, ordinal), nodeId: 'build', nativeStepId: 'build', sessionId: nativeSessionId('run-1', 'builder', 'build', f.plan.roles[0]!.policy),
        purpose, repair, command, before: head.progress.stage.watermarks, finished: null };
      head = await progress.publish({ ...draft('role_pre'), attempts: [...head.progress.attempts, attempt] }, `role.${ordinal}.pre`);
      const candidate = purpose === 'compaction' ? head.progress.candidate : await f.candidate(ordinal), session = await f.artifacts.json('unit-session', { version: 1, kind: 'synthetic-native-slot', ordinal });
      const checkpointId = phaseCheckpointId('run-1', `role.${ordinal}.native`), manifest = await progress.manifest(candidate.manifest);
      const native = stateValue(store.writeCheckpoint(f.authority, { checkpointId, expectedRevision: stateValue(store.inspect()).revision, candidateManifest: manifest, workspace: candidate.workspace, privateSession: session, additionalArtifacts: [] })).record;
      assert.equal(native.additionalArtifacts.length, 0);
      if (ordinal === 1) {
        const before = journal(store); stateValue(store.close()); store = stateValue(reopenLocalRun(f.identity));
        progress = new ProgressStore(store, f.authority, f.artifacts, f.plan, f.lock, f.progress.planRef, f.progress.sourceRef);
        const reopened = await progress.read(); assert.ok(reopened); assert.equal(reopened.progress.attempts.length, 1); assert.equal(progress.decision(reopened), 'adopt_capture');
        assert.deepEqual(reopened.progress.stage.capacity, f.plan.capacity); assert.deepEqual(journal(store).view.clock.basis, before.view.clock.basis); assert.equal(journal(store).view.counts.checkpoints, before.view.counts.checkpoints);
        assert.equal(reopened.progress.failures[0]!.count, 1);
        await writeFile(join(f.directory, 'capacity-resume.json'), canonical({ version: 1, kind: 'synthetic-native-capacity-only', originalCapacity: f.plan.capacity, checkpointCount: before.view.counts.checkpoints, noNewCheckpointOnResume: true, attempts: reopened.progress.attempts.length, failureCount: reopened.progress.failures[0]!.count }), { mode: 0o600 });
      }
      const outcome = await f.artifacts.json('unit-role', { version: 1, attemptId: attempt.id, command, roleId: 'builder', nodeId: 'build', stepId: 'build', sessionId: attempt.sessionId, checkpointId,
        originalManifest: candidate.manifest, manifest: candidate.manifest, workspace: candidate.workspace, session, submission: null, journal: { requestIds: [], operationIds: [] } });
      head = await progress.publish({ ...draft('role_post'), candidate: { ...candidate, privateSession: session }, attempts: head.progress.attempts.map(item => item.ordinal === ordinal ? { ...item, finished: { after: head.progress.stage.watermarks, outcome, nativeCheckpointId: checkpointId } } : item),
        nativeCheckpoints: [...head.progress.nativeCheckpoints, { attemptId: attempt.id, checkpointId, outcome }] }, `role.${ordinal}.post`);
      if (purpose !== 'compaction') await verify();
    }
    head = await progress.publish({ ...draft('terminal_intent'), terminalIntent: { primary: 'unit_schedule_only', result: null, observations: null } }, 'terminal.intent');
    const result = await f.artifacts.json('unit-result', { version: 1, kind: 'synthetic-no-core-result', eligibleEvidence: false });
    head = await progress.publish({ ...draft('terminal_result'), terminalIntent: { ...head.progress.terminalIntent!, result } }, 'terminal.result');
    const observations = await f.artifacts.json('unit-observations', { version: 1, kind: 'unit-schedule-complete' });
    head = await progress.publish({ ...draft('terminal_observations'), terminalIntent: { ...head.progress.terminalIntent!, observations } }, 'terminal.observations');
    const records = journal(store), phases = phaseSchedule(f.plan.capacity);
    assert.equal(records.checkpoints.length, f.plan.capacity.D); assert.equal(head.progress.sequence, f.plan.capacity.D); assert.equal(new Set(head.progress.stage.consumed).size, phases.length);
    assert.equal(head.progress.attempts.length, A); assert.equal(head.progress.verifierReceipts.length, f.plan.capacity.J); assert.equal(head.progress.failures[0]!.count, 2);
    assert.ok(head.progress.stage.consumed.every(phase => phases.includes(phase))); assert.equal(progress.decision(head), 'terminal');
    for (const cp of records.checkpoints) { assert.equal(cp.additionalArtifacts.length, cp.checkpointId.startsWith('pi.') ? 0 : 4); assert.deepEqual(cp.clockBasis, records.view.clock.basis); }
    assert.equal(head.index.entries.length, 2 * f.plan.capacity.J + A + 4); assert.ok(Buffer.byteLength(canonical(head.progress)) <= 65536); assert.ok(Buffer.byteLength(canonical(head.index)) <= 65536);
    assert.equal(records.view.counts.requests, 0); assert.equal(records.view.counts.unresolvedOperations, 0); assert.equal(records.operations.length, f.plan.capacity.J);
    await assert.rejects(progress.publish(draft('terminal_observations'), 'unplanned.extra')); assert.equal(journal(store).checkpoints.length, f.plan.capacity.D);
    await writeFile(join(f.directory, 'capacity-result.json'), canonical({ version: 1, kind: 'real-s02-synthetic-native-verifier-capacity-vector', actualPiExecution: false, actualWorkerExecution: false, coreAcceptance: false,
      capacity: f.plan.capacity, compactionAttempt: compaction, counts: records.view.counts, progressBytes: Buffer.byteLength(canonical(head.progress)), indexBytes: Buffer.byteLength(canonical(head.index)), indexEntries: head.index.entries.length, lastCheckpoint: head.checkpoint.checkpointId,
      checkpoints: records.checkpoints.map(cp => ({ id: cp.checkpointId, sequence: cp.sequence, additionalRefs: cp.additionalArtifacts.length, inputDigest: cp.inputDigest })), unplannedPhaseRefused: true }), { mode: 0o600 });
  } finally { if (store !== f.store) stateValue(store.close()); await f.close(); }
}
test('the worked 37-checkpoint capacity retains three attempts, all four verification generations and terminal reserve after reopen', async () => { await schedule(1, 3, 2); });
test('the exact-fit 64-checkpoint capacity consumes every slot once with four-ref controller anchors after reopen', async () => { await schedule(7, 2, 1); });
test('a compaction attempt consumes its native/pre/post phases without creating another candidate generation or verifier job', async () => { await schedule(1, 2, 0, true); });
