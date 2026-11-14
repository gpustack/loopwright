import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bindSubject, type ArtifactManifest } from '@loopwright/core';
import { retainedFixture } from './progress-fixtures.js';
import { adoptRoleCapture, nativeSessionId } from '../src/capture.js';
import type { FrozenSource } from '../src/source.js';
import { journal, phaseCheckpointId, stableId } from '../src/progress.js';
import { stateValue } from '../src/storage.js';
import { canonical, hash } from '../src/schema.js';
import { ControllerFailure } from '../src/errors.js';
import type { ControllerAttempt } from '../src/types.js';

async function snapshotFixture() {
  const f = await retainedFixture(), bootstrap = await f.progress.publish(f.draft, 'bootstrap'), role = f.plan.roles[0]!, text = 'trusted unit command';
  const attempt: ControllerAttempt = { ordinal: 1, id: stableId('run-1', 'build', 'task', 'none', 1), nodeId: 'build', nativeStepId: 'build', sessionId: nativeSessionId('run-1', role.roleId, 'build', role.policy), purpose: 'task', repair: 'none', command: await f.artifacts.put('command', Buffer.from(text), 16384), before: bootstrap.progress.stage.watermarks, finished: null };
  const pre = await f.progress.publish({ ...bootstrap.progress, stage: { ...bootstrap.progress.stage, kind: 'role_pre' }, attempts: [attempt] }, 'role.1.pre');
  stateValue(f.store.reserveRequest(f.authority, { requestId: 'unit-request', roleId: role.roleId, nodeId: 'build', attemptId: 'unit-native-attempt', purpose: 'task', repair: 'none', transportRetryOf: null, requestDigest: hash('synthetic counted request'), inputUpperBound: 80, outputUpperBound: 20, totalUpperBound: 100,
    capability: { adapterId: 'pi', adapterVersion: '0.0.0', provider: role.policy.selection.provider, model: role.policy.selection.model, kind: 'soft_only', coversAllBillableTokens: false, enforcesOutputBound: false }, operationId: 'unit-model-op', targetIdentity: 'fixture:no-physical-send' }));
  stateValue(f.store.authorizeRequestDispatch(f.authority, 'unit-request'));
  const operation = stateValue(f.store.getOperation('unit-model-op')), view = stateValue(f.store.inspect()); assert.ok(operation.dispatch);
  stateValue(f.store.observeRequest(f.authority, 'unit-request', { receiptId: 'unit-request-receipt', termination: 'confirmed', outcome: 'succeeded',
    evidence: { evidenceId: 'unit-request-evidence', producerId: 'unit-capture', method: 'synthetic-snapshot-vector', artifact: await f.artifacts.json('unit-usage', { input: 10, output: 5 }),
      subject: { storeId: view.storeId, runId: view.runId, lockHash: view.lockHash, operationId: 'unit-model-op', requestId: 'unit-request', intentDigest: operation.intentDigest, dispatchGeneration: operation.dispatch.generation, dispatchId: operation.dispatch.dispatchId } },
    usage: { requestId: 'unit-request', inputTokens: { provenance: 'reported', value: 10 }, outputTokens: { provenance: 'reported', value: 5 }, costMicrousd: { provenance: 'unknown' } } }));
  const manifest: ArtifactManifest = await f.progress.manifest(pre.progress.candidate.manifest), subject = bindSubject(f.lock, manifest); assert.equal(subject.ok, true); if (!subject.ok) throw new Error('fixture');
  const checkpointId = phaseCheckpointId('run-1', 'role.1.native'), current = stateValue(f.store.inspect()), sourcePolicy = role.policy;
  // Synthetic bytes follow the documented v2 snapshot binding. The public production decoder validates them.
  // This is not an SDK/parser/native execution qualification and sends no provider request.
  const sourceDigest = hash('loopwright.dev/pi-policy/v2\0' + canonical(sourcePolicy)), nativePolicy = { ...sourcePolicy, version: 1, policyId: 'v2.' + BigInt('0x' + sourceDigest.hex).toString(36) };
  const binding = { version: 1, checkpointId, storeId: current.storeId, runId: current.runId, lockHash: current.lockHash, sessionId: attempt.sessionId, roleId: role.roleId, stepId: 'build', runtime: sourcePolicy.runtime,
    policyDigest: hash(canonical(nativePolicy)), resourcesDigest: hash(canonical(sourcePolicy.resources)), candidateDigest: subject.value.candidateDigest, clockBasis: current.clock.basis,
    accountingDigest: hash(canonical({ ledger: current.ledger, requests: current.counts.requests, operations: current.counts.operations })), sequence: 1 };
  const line = (value: unknown) => JSON.stringify(value) + '\n', timestamp = '2026-11-06T00:00:00.000Z', file = Buffer.from('export const value = 0;\n'), fileRef = manifest.spec.entries[0]!;
  assert.equal(hash(file).hex, fileRef.digest.hex);
  const workspace = await f.artifacts.put('unit-workspace', Buffer.from(line({ type: 'workspace_snapshot', version: 1, binding, manifest }) + line({ type: 'file', ref: fileRef }) + line({ type: 'chunk', index: 0, data: file.toString('base64') }) + line({ type: 'file_end', byteLength: file.byteLength, digest: hash(file).hex }) + line({ type: 'end', files: 1 })));
  const submission = '{"version":1,"status":"blocked","checks":[],"reason":"unit fixture"}';
  const session = await f.artifacts.put('unit-session', Buffer.from(line({ type: 'session_snapshot', version: 1, binding }) + [
    { type: 'session', version: 3, id: 'unit_native', cwd: '/workspace/candidate', timestamp },
    { type: 'message', id: 'u0', parentId: null, timestamp, message: { role: 'user', content: 'old command' } },
    { type: 'message', id: 'a0', parentId: 'u0', timestamp, message: { role: 'assistant', ...sourcePolicy.selection, content: [{ type: 'text', text: 'OLD OUTPUT' }], stopReason: 'stop' } },
    { type: 'message', id: 'u1', parentId: 'a0', timestamp, message: { role: 'user', content: text } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp, message: { role: 'assistant', ...sourcePolicy.selection, content: [{ type: 'thinking', thinking: 'PRIVATE THINKING' }, { type: 'text', text: submission }], stopReason: 'stop' } },
  ].map(line).join('')), 2097152);
  const native = stateValue(f.store.writeCheckpoint(f.authority, { checkpointId, expectedRevision: stateValue(f.store.inspect()).revision, candidateManifest: manifest, workspace, privateSession: session, additionalArtifacts: [] })).record;
  const source: FrozenSource = { version: 1, repository: f.plan.task.spec.target.repository, directory: f.taskDirectory, baseObject: '0'.repeat(40), sourceObject: '0'.repeat(40), manifest, inventory: f.progress.sourceRef, workspace: pre.progress.candidate.workspace, artifacts: [] };
  return { ...f, role, attempt, pre, native, submission, source };
}
test('a known original capture adopts current-command bytes without adapter startup or a second journal effect', async () => {
  const f = await snapshotFixture();
  try {
    const before = journal(f.store), adopted = await adoptRoleCapture(f.store, f.artifacts, f.lock, f.role, f.attempt, undefined, f.source), again = await adoptRoleCapture(f.store, f.artifacts, f.lock, f.role, f.attempt, undefined, f.source);
    assert.equal(canonical(adopted), canonical(again)); assert.equal(adopted.checkpointId, f.native.checkpointId); assert.equal(Buffer.from(await f.artifacts.read(adopted.submission!)).toString(), f.submission);
    assert.equal(adopted.artifacts.length, 1); assert.equal(Buffer.from(adopted.artifacts[0]!.bytes).toString(), 'export const value = 0;\n');
    assert.deepEqual(journal(f.store).view.counts, before.view.counts); assert.deepEqual(journal(f.store).view.ledger, before.view.ledger);
    const finished = { ...f.attempt, finished: { after: { requests: before.view.counts.requests, operations: before.view.counts.operations }, outcome: adopted.outcome, nativeCheckpointId: adopted.checkpointId } };
    const post = await f.progress.publish({ ...f.pre.progress, stage: { ...f.pre.progress.stage, kind: 'role_post' }, attempts: [finished], nativeCheckpoints: [{ attemptId: f.attempt.id, checkpointId: adopted.checkpointId, outcome: adopted.outcome }], submission: adopted.submission,
      candidate: { ...f.pre.progress.candidate, manifest: adopted.manifest, digest: adopted.digest, workspace: adopted.workspace, privateSession: adopted.session } }, 'role.1.post');
    assert.notEqual(post.checkpoint.checkpointId, f.native.checkpointId); assert.match(post.checkpoint.checkpointId, /^controller\./); assert.match(f.native.checkpointId, /^pi\./); assert.equal(post.checkpoint.additionalArtifacts.length, 4);
    assert.equal(post.progress.sequence, 4); assert.equal(f.progress.decision(post), 'safe');
    assert.equal(canonical(await f.progress.read()), canonical(post));
    await writeFile(join(f.artifacts.directory, adopted.originalManifest.name), Buffer.from('replaced transitive native manifest')); await assert.rejects(f.progress.read());
    await writeFile(join(f.directory, 'capture-adoption-result.json'), canonical({ version: 1, kind: 'synthetic-passive-capture-vector', actualNativeExecution: false, nativeCheckpointId: f.native.checkpointId, controllerCheckpointId: post.checkpoint.checkpointId, adoptedOutcome: adopted.outcome, submission: adopted.submission, countsBeforePost: before.view.counts, noNewRequestOrOperation: true, transitiveRefCorruptionRefused: true }), { mode: 0o600 });
  } finally { await f.close(); }
});
test('capture adoption rejects wrong session, command and request interval without replay', async () => {
  const f = await snapshotFixture();
  try {
    const before = journal(f.store), wrongCommand = await f.artifacts.put('command', Buffer.from('a different command'));
    for (const attempt of [{ ...f.attempt, sessionId: 'wrong-session' }, { ...f.attempt, command: wrongCommand }, { ...f.attempt, before: { requests: 1, operations: 1 } }]) {
      await assert.rejects(adoptRoleCapture(f.store, f.artifacts, f.lock, f.role, attempt, undefined, f.source), (error: unknown) => error instanceof ControllerFailure && error.diagnostic.code === 'RECOVERY_REQUIRED');
    }
    await assert.rejects(adoptRoleCapture(f.store, f.artifacts, f.lock, f.role, f.attempt, ['another-request'], f.source));
    assert.deepEqual(journal(f.store).view.counts, before.view.counts); assert.deepEqual(journal(f.store).view.ledger, before.view.ledger);
  } finally { await f.close(); }
});
test('later journal work and corrupt original native bytes prevent capture adoption', async () => {
  const f = await snapshotFixture();
  try {
    await writeFile(join(f.artifacts.directory, f.native.workspace.name), Buffer.from('replaced original snapshot'));
    await assert.rejects(f.progress.read()); await assert.rejects(adoptRoleCapture(f.store, f.artifacts, f.lock, f.role, f.attempt, undefined, f.source));
    stateValue(f.store.putIntent(f.authority, { operationId: 'late-read', nodeId: 'build', attemptId: 'late-attempt', effect: 'read_only', requestDigest: hash('later journal'), targetIdentity: 'fixture:no-send' }));
    await assert.rejects(adoptRoleCapture(f.store, f.artifacts, f.lock, f.role, f.attempt, undefined, f.source)); assert.equal(journal(f.store).checkpoints.length, 3);
  } finally { await f.close(); }
});
