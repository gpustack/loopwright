import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bindSubject, digestArtifact, type ArtifactManifest } from '@loopwright/core';
import { reopenLocalRun, type LocalRunStore } from '@loopwright/state';
import { retainedFixture, setFixture } from './progress-fixtures.js';
import { retainInventoryInputs } from './verification-fixtures.js';
import { ProgressStore, stableId, validateProgress, verifierOperationId, journal } from '../src/progress.js';
import { Verifier, preflightVerification, authenticatedRefusal, type PreparedRefusal, type PreflightRefusal, type ByteInventory, type VerifiedCheck } from '../src/verification.js';
import { evaluateControllerAcceptance } from '../src/acceptance.js';
import { JSON_FILE_BYTES } from '../src/verifier-protocol.js';
import { canonical, hash } from '../src/schema.js';
import { stateValue } from '../src/storage.js';
import type { ControllerAttempt } from '../src/types.js';

async function refusalFixture(kind: 'file' | 'header' = 'file') {
  const initial = kind === 'file' ? Buffer.concat([Buffer.from('{"ok":true}'), Buffer.alloc(JSON_FILE_BYTES - 11, 32)]) : Buffer.from('{"ok":true}');
  const sourceFiles = [{ name: 'packages/result.json', bytes: initial }], candidateFiles = kind === 'file' ? [{ name: sourceFiles[0]!.name, bytes: Buffer.concat([initial, Buffer.from(' ')]) }]
    : [...sourceFiles, ...Array.from({ length: 100 }, (_, index) => ({ name: 'packages/file-' + String(index).padStart(3, '0') + '-' + 'x'.repeat(40), bytes: Buffer.from('x') }))];
  const f = await retainedFixture(1, 3, 2, 60000, fixture => {
    const handler = fixture.registry.spec.handlers.find(handler => handler.implementation === 'json-artifact.v1')!;
    setFixture(fixture.registry, ['spec', 'handlers'], fixture.registry.spec.handlers.map(item => item === handler ? { ...item, parameters: { ...item.parameters, path: 'packages/result.json' } } : item));
  });
  const inventory = async (files: typeof sourceFiles): Promise<ByteInventory> => {
    const sorted = [...files].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const entries = sorted.map(file => { const ref = digestArtifact(file.name, file.bytes); assert.equal(ref.ok, true); if (!ref.ok) throw new Error('fixture'); return ref.value; });
    const manifest: ArtifactManifest = { apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { entries } }, ref = await f.artifacts.json('manifest', manifest, 32768);
    await retainInventoryInputs(f.artifacts, manifest, ref, sorted); return { manifest, ref, files: sorted };
  };
  const source = await inventory(sourceFiles), candidate = await inventory(candidateFiles), sourceRef = await f.artifacts.json('source', { version: 1, fixture: 'inert-unit-source-only', manifest: source.ref });
  const progress = new ProgressStore(f.store, f.authority, f.artifacts, f.plan, f.lock, f.progress.planRef, sourceRef), bound = bindSubject(f.lock, source.manifest); assert.equal(bound.ok, true); if (!bound.ok) throw new Error('fixture');
  let head = await progress.publish({ ...f.draft, candidate: { ...f.draft.candidate, manifest: source.ref, digest: bound.value.candidateDigest } }, 'bootstrap');
  const command = await f.artifacts.put('unit-command', Buffer.from('synthetic inert candidate transition; no SDK/model execution'));
  const attempt: ControllerAttempt = { ordinal: 1, id: stableId('run-1', 'build', 'task', 'none', 1), nodeId: 'build', nativeStepId: 'build', sessionId: 'unit-session', purpose: 'task', repair: 'none', command, before: head.progress.stage.watermarks, finished: null };
  head = await progress.publish({ ...head.progress, stage: { ...head.progress.stage, kind: 'role_pre' }, attempts: [attempt] }, 'role.1.pre');
  const current = bindSubject(f.lock, candidate.manifest); assert.equal(current.ok, true); if (!current.ok) throw new Error('fixture');
  const workspace = await f.artifacts.json('unit-workspace', { version: 1, kind: 'synthetic-inert-candidate', manifest: candidate.ref, eligibleNativeExecution: false }), outcome = await f.artifacts.json('unit-role', { version: 1, kind: 'synthetic-inert-transition-only', eligibleNativeExecution: false });
  head = await progress.publish({ ...head.progress, stage: { ...head.progress.stage, kind: 'role_post' }, attempts: [{ ...attempt, finished: { after: attempt.before, outcome, nativeCheckpointId: null } }], candidate: { manifest: candidate.ref, digest: current.value.candidateDigest, generation: 1, workspace, privateSession: null } }, 'role.1.post');
  let workers = 0; const verifier = new Verifier(f.store, f.authority, f.artifacts, f.plan, f.lock, () => current.value, { beforeWorker: () => { workers++; } });
  const prepare = () => { const result = preflightVerification(f.plan, f.lock, 'check.tests', source, candidate, 1, 'b'.repeat(32)); assert.equal(result.kind, 'refused'); if (result.kind !== 'refused') throw new Error('fixture'); return result.prepared; };
  const anchor = async (prepared: PreparedRefusal) => {
    const row = await verifier.storeRefusal(prepared);
    head = await progress.publish({ ...head.progress, stage: { ...head.progress.stage, kind: 'verifier_pre' }, verifierRefusals: [...head.progress.verifierRefusals, row] }, 'verify.1.0.pre');
    head = await progress.publish({ ...head.progress, stage: { ...head.progress.stage, kind: 'verifier_post' } }, 'verify.1.0.post'); return { row, refusal: await verifier.restoreRefusal(prepared, row) };
  };
  const run = async (ordinal: number): Promise<VerifiedCheck> => {
    const slot = f.plan.verifierSlots[ordinal]!, result = preflightVerification(f.plan, f.lock, slot.id, source, candidate, 1, 'c'.repeat(32)); assert.equal(result.kind, 'ready'); if (result.kind !== 'ready') throw new Error('fixture'); const job = result.job;
    head = await progress.publish({ ...head.progress, stage: { ...head.progress.stage, kind: 'verifier_pre' }, verifierReceipts: [...head.progress.verifierReceipts, { slot: slot.id, generation: 1, operationId: job.operationId, producerNonce: job.producerNonce, output: null, receipt: null }] }, 'verify.1.' + ordinal + '.pre');
    const checked = await verifier.run(job, new AbortController().signal);
    head = await progress.publish({ ...head.progress, stage: { ...head.progress.stage, kind: 'verifier_post' }, verifierReceipts: head.progress.verifierReceipts.map(row => row.slot === slot.id && row.generation === 1 ? { ...row, output: checked.output, receipt: checked.receipt } : row) }, 'verify.1.' + ordinal + '.post'); return checked;
  };
  return { ...f, source, candidate, subject: current.value, progress, verifier, prepare, anchor, run, workers: () => workers, head: () => head };
}
for (const kind of ['file', 'header'] as const) test('v2 pure later ' + kind + ' sizing refusal blocks without dispatch while original independent inventory jobs continue', async () => {
  const f = await refusalFixture(kind);
  try {
    const { row, refusal } = await f.anchor(f.prepare()); assert.equal(f.workers(), 0); assert.equal(journal(f.store).operations.length, 0);
    const scope = await f.run(1), equality = await f.run(2); assert.equal(scope.status, 'passed'); assert.equal(equality.status, 'failed'); assert.equal(f.workers(), 2);
    const observed = evaluateControllerAcceptance(f.plan, f.lock, f.candidate.manifest, f.candidate.files, 1, [scope, equality], { version: 1, status: 'completed', checks: [], reason: null }, f.store, null, true, [refusal]);
    assert.equal(observed.result.spec.status, 'blocked'); assert.equal(observed.verification.spec.required[0]!.status, 'blocked'); assert.equal(observed.verification.spec.required[0]!.evidenceId, null);
    assert.equal(observed.preflightRefusals.length, 1); assert.equal(observed.preflightRefusals[0]!.origin, 'controller_preflight'); assert.equal(observed.preflightRefusals[0]!.limits.reason, kind === 'file' ? 'json_file_bytes' : 'header_bytes');
    assert.equal(journal(f.store).operations.length, 2); assert.equal(f.store.getOperation(row.prospectiveOperationId).ok, false); assert.equal(f.head().progress.version, 2); assert.equal(f.head().index.entries.filter(entry => entry.kind === 'preflight-refusal').length, 1);
    await writeFile(join(f.directory, 'refusal-core-proof.json'), canonical({ version: 1, kind, source: f.source.ref, candidate: f.candidate.ref, refusal, record: authenticatedRefusal(refusal).value, result: observed, requests: 0, workers: f.workers(), producerOperations: journal(f.store).operations, checkpoint: f.head().checkpoint, progress: f.head().ref, nativeTransition: 'synthetic-unit-only-no-SDK' }), { mode: 0o600 });
  } finally { await f.close(); }
});

test('v2 refuses orphan/copied/stale/substituted negative proof and invalid body inputs without laundering other errors', async () => {
  const f = await refusalFixture();
  try {
    const prepared = f.prepare(), orphan = await f.verifier.storeRefusal(prepared); await assert.rejects(f.verifier.restoreRefusal(prepared, orphan));
    const { row, refusal } = await f.anchor(prepared); assert.throws(() => authenticatedRefusal({ ...refusal } as PreflightRefusal));
    await assert.rejects(f.verifier.restoreRefusal(prepared, { ...row, producerNonce: 'd'.repeat(32) }));
    assert.throws(() => evaluateControllerAcceptance(f.plan, f.lock, f.candidate.manifest, f.candidate.files, 0, [], null, f.store, null, true, [refusal]));
    const invalid = { ...f.candidate, files: f.candidate.files.map(file => ({ ...file, bytes: Buffer.from('substituted') })) };
    assert.throws(() => preflightVerification(f.plan, f.lock, 'check.tests', f.source, invalid, 1, 'b'.repeat(32)), /ARTIFACT_INVALID/);
    assert.equal(journal(f.store).operations.length, 0); assert.equal(f.workers(), 0);
    await writeFile(join(f.directory, 'refusal-negative-proof.json'), canonical({ version: 1, row, orphanDidNotBrand: true, copiedStaleSubstitutedRefused: true, invalidBodyNotSizing: true, operations: 0, workers: 0 }), { mode: 0o600 });
  } finally { await f.close(); }
});

test('v2 cannot convert an existing original intent or uncertain dispatch into a non-dispatch refusal', async () => {
  for (const dispatch of [false, true]) {
    const f = await refusalFixture();
    try {
      const prepared = f.prepare(); stateValue(f.store.putIntent(f.authority, { operationId: prepared.prospectiveOperationId, nodeId: 'build', attemptId: 'unit-existing', effect: 'read_only', requestDigest: hash('existing original operation'), targetIdentity: 'unit:existing' }));
      if (dispatch) stateValue(f.store.authorizeOperationDispatch(f.authority, prepared.prospectiveOperationId)); const before = journal(f.store);
      await assert.rejects(f.verifier.storeRefusal(prepared)); assert.equal(canonical(journal(f.store).operations), canonical(before.operations)); assert.equal(f.workers(), 0);
      await writeFile(join(f.directory, 'refusal-existing-proof.json'), canonical({ version: 1, dispatch, refused: true, originalOperations: before.operations, workers: 0 }), { mode: 0o600 });
    } finally { await f.close(); }
  }
});

test('v2 original refusal pre anchor survives actual SQLite reopen and lost post ACK without another slot or Worker', async () => {
  const f = await refusalFixture(); let reopened: LocalRunStore | undefined;
  try {
    const prepared = f.prepare(), row = await f.verifier.storeRefusal(prepared), pre = await f.progress.publish({ ...f.head().progress, stage: { ...f.head().progress.stage, kind: 'verifier_pre' }, verifierRefusals: [row] }, 'verify.1.0.pre');
    const before = journal(f.store); stateValue(f.store.close()); const store = stateValue(reopenLocalRun(f.identity)); reopened = store;
    const progress = new ProgressStore(store, f.authority, f.artifacts, f.plan, f.lock, f.progress.planRef, f.progress.sourceRef), verifier = new Verifier(store, f.authority, f.artifacts, f.plan, f.lock, () => f.subject);
    await verifier.validateStoredRefusal(prepared, row); await assert.rejects(verifier.restoreRefusal(prepared, row));
    const draft = { ...pre.progress, stage: { ...pre.progress.stage, kind: 'verifier_post' as const } };
    await assert.rejects(progress.publish(draft, 'verify.1.0.post', () => { throw new Error('planned post ACK loss'); }));
    const post = await progress.publish(draft, 'verify.1.0.post'), a = await verifier.restoreRefusal(prepared, row), b = await verifier.restoreRefusal(prepared, row);
    assert.equal(canonical(a), canonical(b)); assert.equal(journal(store).checkpoints.length, before.checkpoints.length + 1); assert.equal(journal(store).operations.length, 0); assert.equal(canonical(journal(store).view.ledger), canonical(before.view.ledger)); assert.equal(canonical(journal(store).view.clock.basis), canonical(before.view.clock.basis));
    await writeFile(join(f.directory, 'refusal-reopen-proof.json'), canonical({ version: 1, a, b, row, pre: pre.checkpoint, post: post.checkpoint, originalClock: before.view.clock.basis, operations: 0, workers: 0, restoredWithoutNewSlot: true }), { mode: 0o600 });
  } finally { if (reopened) stateValue(reopened.close()); await f.close(); }
});

test('v2 rejects historical v1 and a physical/negative slot collision without consuming another checkpoint', async () => {
  const f = await refusalFixture();
  try {
    assert.throws(() => validateProgress({ ...f.head().progress, version: 1 }, f.plan, f.lock));
    const prepared = f.prepare(), row = await f.verifier.storeRefusal(prepared), count = journal(f.store).checkpoints.length;
    await assert.rejects(f.progress.publish({ ...f.head().progress, stage: { ...f.head().progress.stage, kind: 'verifier_pre' }, verifierRefusals: [row], verifierReceipts: [{ slot: row.slot, generation: 1, operationId: verifierOperationId('run-1', row.slot, 1), producerNonce: row.producerNonce, output: null, receipt: null }] }, 'verify.1.0.pre'));
    assert.equal(journal(f.store).checkpoints.length, count); assert.equal(journal(f.store).operations.length, 0);
  } finally { await f.close(); }
});
