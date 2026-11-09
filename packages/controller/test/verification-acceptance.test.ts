import { retainInventoryInputs } from './verification-fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bindSubject, digestArtifact, type ArtifactManifest } from '@loopwright/core';
import { retainedFixture, setFixture } from './progress-fixtures.js';
import { Verifier, prepareVerification, authenticatedCheck, type ByteInventory } from '../src/verification.js';
import { evaluateControllerAcceptance } from '../src/acceptance.js';
import { normalizeSubmission } from '../src/submission.js';
import { canonical, hash } from '../src/schema.js';
import { stateValue } from '../src/storage.js';
import { journal } from '../src/progress.js';
type Binding = 'absent' | 'required' | 'optional' | 'disallowed' | 'wrong_handler' | 'multiple';
async function fixture(binding: Binding = 'absent', candidateText = '{"ok":true,"revision":2}', protectedChange = false) {
  const f = await retainedFixture(1, 3, 2, 60000, config => {
    const tests = config.registry.spec.handlers.find(handler => handler.id === 'tests')!; setFixture(tests, ['parameters', 'path'], 'packages/result.json');
    if (binding === 'absent') return;
    const ids = binding === 'multiple' ? ['zeta', 'alpha'] : ['unchanged'], prototype = config.registry.spec.handlers.find(handler => handler.implementation === (binding === 'wrong_handler' ? 'json-artifact.v1' : 'no-change.v1'))!;
    setFixture(config.registry, ['spec', 'handlers'], [...config.registry.spec.handlers, ...ids.map(id => ({ ...prototype, id: 'predicate.' + id, parameters: binding === 'wrong_handler' ? { ...prototype.parameters, checkId: id } : { checkId: id } }))]);
    setFixture(config.config, ['spec', 'task', 'spec', 'acceptance'], { required: ['tests', ...(binding === 'optional' ? [] : ids)], checks: [...config.config.spec.task.spec.acceptance.checks, ...ids.map(id => ({ id, allowedEvidenceLevels: binding === 'disallowed' ? ['external_service'] : ['local_execution'] }))] });
  });
  const inventory = async (files: { name: string; bytes: Buffer }[]): Promise<ByteInventory> => {
    const entries = files.map(file => { const value = digestArtifact(file.name, file.bytes); assert.equal(value.ok, true); if (!value.ok) throw new Error('fixture'); return value.value; });
    const manifest: ArtifactManifest = { apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { entries } };
    const ref = await f.artifacts.json('manifest', manifest, 32768); await retainInventoryInputs(f.artifacts, manifest, ref, files); return { manifest, ref, files };
  };
  const source = await inventory([{ name: 'packages/result.json', bytes: Buffer.from('{"ok":true,"revision":1}') }]), candidate = await inventory([{ name: 'packages/result.json', bytes: Buffer.from(candidateText) }, ...(protectedChange ? [{ name: 'packages/policy/denied', bytes: Buffer.from('changed') }] : [])]);
  const bound = bindSubject(f.lock, candidate.manifest); assert.equal(bound.ok, true); if (!bound.ok) throw new Error('fixture');
  const verifier = new Verifier(f.store, f.authority, f.artifacts, f.plan, f.lock, () => bound.value);
  const execute = async (skip?: string) => {
    const checked = [];
    for (const [index, slot] of f.plan.verifierSlots.entries()) { if (slot.checkId === skip) continue; checked.push(await verifier.run(prepareVerification(f.plan, f.lock, slot.id, source, candidate, 0, index.toString(16).padStart(32, '0')), new AbortController().signal)); }
    return checked;
  };
  const submitted = (status: 'completed' | 'no_change') => normalizeSubmission(Buffer.from(JSON.stringify({ version: 1, status, checks: f.plan.task.spec.acceptance.checks.map(check => ({ checkId: check.id, status: 'passed', evidenceId: 'model.forged', reason: null })), reason: null })), f.plan.task);
  return { ...f, source, candidate, execute, submitted };
}
test('changed completed uses actual core acceptance while preserving honest failed implicit equality and model claims', async () => {
  const f = await fixture();
  try {
    const checked = await f.execute(), result = evaluateControllerAcceptance(f.plan, f.lock, f.candidate.manifest, f.candidate.files, 0, checked, f.submitted('completed'), f.store);
    assert.equal(result.result.spec.status, 'completed'); assert.equal(result.verification.spec.satisfied, true); assert.equal(result.verifierMatrix.find(row => row.implicit === 'no_change')!.status, 'failed');
    assert.notEqual(result.result.spec.verification.spec.required[0]!.evidenceId, 'model.forged'); assert.equal(result.result.spec.usage.requests.length, 0);
    await writeFile(join(f.directory, 'core-completed-result.json'), canonical({ version: 1, kind: 'real-worker-core-component', nativeAgentExecution: false, result }), { mode: 0o600 });
  } finally { await f.close(); }
});
test('no_change requires its own original required declared proof plus a separate passing implicit equality', async () => {
  const f = await fixture('required', '{"ok":true,"revision":1}');
  try {
    const checked = await f.execute(), result = evaluateControllerAcceptance(f.plan, f.lock, f.candidate.manifest, f.candidate.files, 0, checked, f.submitted('no_change'), f.store);
    assert.equal(result.result.spec.status, 'no_change'); assert.equal(result.result.spec.noChange!.checkId, 'unchanged');
    const declared = checked.find(check => check.checkId === 'unchanged')!, implicit = checked.find(check => check.slotId === 'controller.no-change')!;
    assert.notEqual(declared.operationId, implicit.operationId); assert.notEqual(declared.output.name, implicit.output.name); assert.equal(authenticatedCheck(declared).evidence.spec.method, 'verify_no_change');
    assert.equal(result.result.spec.noChange!.evidenceId, authenticatedCheck(declared).evidence.metadata.id); assert.equal(result.verifierMatrix.every(row => row.status === 'passed'), true);
    await writeFile(join(f.directory, 'core-no-change-result.json'), canonical({ version: 1, kind: 'real-worker-core-component', nativeAgentExecution: false, result, declared, implicit }), { mode: 0o600 });
  } finally { await f.close(); }
});
test('absent/optional/disallowed/wrong-handler no-change binding blocks without status downgrade or a reused implicit proof', async () => {
  for (const binding of ['absent', 'optional', 'disallowed', 'wrong_handler'] as const) {
    const f = await fixture(binding, '{"ok":true,"revision":1}');
    try {
      const checked = await f.execute(), result = evaluateControllerAcceptance(f.plan, f.lock, f.candidate.manifest, f.candidate.files, 0, checked, f.submitted('no_change'), f.store);
      assert.equal(result.result.spec.status, 'blocked'); assert.equal(result.requestedStatus, 'no_change'); assert.equal(result.diagnostic, 'EVIDENCE_UNAVAILABLE'); assert.equal(result.result.spec.noChange, null);
    } finally { await f.close(); }
  }
});
test('lexical no-change selection cannot fall back to a later passing proof when the selected required job is missing', async () => {
  const f = await fixture('multiple', '{"ok":true,"revision":1}');
  try {
    const checked = await f.execute('alpha'), result = evaluateControllerAcceptance(f.plan, f.lock, f.candidate.manifest, f.candidate.files, 0, checked, f.submitted('no_change'), f.store);
    assert.equal(result.selectedNoChangeCheck, 'alpha'); assert.equal(result.result.spec.status, 'blocked'); assert.equal(checked.find(check => check.checkId === 'zeta')!.status, 'passed');
  } finally { await f.close(); }
});
test('failed scope or required predicate prevents success and an actual failed comparison outranks missing binding', async () => {
  for (const [body, protect, request] of [['{"ok":true,"revision":2}', true, 'completed'], ['{"ok":false}', false, 'completed'], ['{"ok":true,"revision":2}', false, 'no_change']] as const) {
    const f = await fixture('absent', body, protect);
    try {
      const checked = await f.execute(), result = evaluateControllerAcceptance(f.plan, f.lock, f.candidate.manifest, f.candidate.files, 0, checked, f.submitted(request), f.store);
      assert.equal(result.result.spec.status, 'failed'); if (body.includes('false')) assert.deepEqual(result.contradictions, ['tests']);
    } finally { await f.close(); }
  }
});
test('stale generation, forged handle, changed artifact bytes and another plan cannot make core success', async () => {
  const f = await fixture();
  try {
    const checked = await f.execute(), submission = f.submitted('completed');
    assert.throws(() => evaluateControllerAcceptance(f.plan, f.lock, f.candidate.manifest, f.candidate.files, 1, checked, submission, f.store));
    assert.throws(() => evaluateControllerAcceptance(f.plan, f.lock, f.candidate.manifest, f.candidate.files, 0, checked.map(check => ({ ...check })), submission, f.store));
    assert.throws(() => evaluateControllerAcceptance({ ...f.plan, planDigest: { algorithm: 'sha256', hex: '0'.repeat(64) } }, f.lock, f.candidate.manifest, f.candidate.files, 0, checked, submission, f.store));
    const result = evaluateControllerAcceptance(f.plan, f.lock, f.candidate.manifest, [{ name: 'packages/result.json', bytes: Buffer.from('different bytes') }], 0, checked, submission, f.store);
    assert.equal(result.result.spec.status, 'blocked'); assert.equal(result.verification.spec.required[0]!.reason, 'artifact_length_mismatch');
  } finally { await f.close(); }
});
test('core usage keeps original reported amounts and unknown costs or later dispatch usage unknown', async () => {
  const f = await fixture();
  try {
    const reserve = (id: string) => {
      stateValue(f.store.reserveRequest(f.authority, { requestId: id, operationId: 'op.' + id, roleId: 'builder', nodeId: 'build', attemptId: 'attempt.' + id, purpose: 'task', repair: 'none', transportRetryOf: null, requestDigest: hash(id), inputUpperBound: 80, outputUpperBound: 20, totalUpperBound: 100,
        capability: { adapterId: 'pi', adapterVersion: '0.0.0', provider: 'github-copilot', model: f.plan.roles[0]!.policy.selection.model, kind: 'soft_only', coversAllBillableTokens: false, enforcesOutputBound: false }, targetIdentity: 'fixture:synthetic-usage-no-physical-send' }));
      stateValue(f.store.authorizeRequestDispatch(f.authority, id));
    };
    reserve('usage-1'); const operation = stateValue(f.store.getOperation('op.usage-1')), view = stateValue(f.store.inspect()); assert.ok(operation.dispatch);
    stateValue(f.store.observeRequest(f.authority, 'usage-1', { receiptId: 'usage-receipt', termination: 'confirmed', outcome: 'succeeded', evidence: { evidenceId: 'usage-evidence', producerId: 'controller.unit', method: 'synthetic_usage_window', artifact: await f.artifacts.json('unit-usage', { input: 10, output: 5, physicalSend: false }),
      subject: { storeId: view.storeId, runId: view.runId, lockHash: view.lockHash, operationId: 'op.usage-1', requestId: 'usage-1', intentDigest: operation.intentDigest, dispatchGeneration: operation.dispatch.generation, dispatchId: operation.dispatch.dispatchId } },
      usage: { requestId: 'usage-1', inputTokens: { provenance: 'reported', value: 10 }, outputTokens: { provenance: 'reported', value: 5 }, costMicrousd: { provenance: 'unknown' } } }));
    const checked = await f.execute(), first = evaluateControllerAcceptance(f.plan, f.lock, f.candidate.manifest, f.candidate.files, 0, checked, f.submitted('completed'), f.store);
    assert.equal(first.result.spec.status, 'completed'); assert.equal(first.result.spec.usage.totalTokens.knownSubtotal, 15); assert.equal(first.result.spec.usage.costMicrousd.unknownCount, 1); assert.equal(first.result.spec.usage.costMicrousd.completeness, 'partial');
    reserve('usage-2'); const after = evaluateControllerAcceptance(f.plan, f.lock, f.candidate.manifest, f.candidate.files, 0, checked, f.submitted('completed'), f.store);
    assert.equal(after.result.spec.status, 'reconcile_required'); assert.equal(after.result.spec.usage.inputTokens.unknownCount, 1); assert.equal(after.result.spec.usage.costMicrousd.unknownCount, 2); assert.equal(journal(f.store).view.ledger.chargedTokens.decimal, '115');
    await writeFile(join(f.directory, 'core-usage-result.json'), canonical({ version: 1, kind: 'synthetic-usage-journal-real-worker-core', physicalProviderSends: 0, first, after, ledger: journal(f.store).view.ledger }), { mode: 0o600 });
  } finally { await f.close(); }
});
async function byteInventory(f: Pick<Awaited<ReturnType<typeof retainedFixture>>, 'artifacts'>, files: { name: string; bytes: Buffer }[]): Promise<ByteInventory> {
  const entries = files.map(file => { const result = digestArtifact(file.name, file.bytes); assert.equal(result.ok, true); if (!result.ok) throw new Error('fixture'); return result.value; });
  const manifest: ArtifactManifest = { apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { entries } };
  const ref = await f.artifacts.json('manifest', manifest, 32768); await retainInventoryInputs(f.artifacts, manifest, ref, files); return { manifest, ref, files };
}
test('real independent Worker/core no-change checks hash complete 4-MiB bodies and reject a last-byte mutation', async () => {
  for (const changed of [false, true]) {
    const f = await fixture('required', '{"ok":true,"revision":1}');
    try {
      const json = Buffer.from('{"ok":true}'), large = Buffer.alloc(4194304 - json.byteLength, 97), candidateLarge = Buffer.from(large); if (changed) candidateLarge[candidateLarge.length - 1] = 98;
      const source = await byteInventory(f, [{ name: 'packages/result.json', bytes: json }, { name: 'packages/large', bytes: large }]), candidate = await byteInventory(f, [{ name: 'packages/result.json', bytes: json }, { name: 'packages/large', bytes: candidateLarge }]);
      const subject = bindSubject(f.lock, candidate.manifest); assert.equal(subject.ok, true); if (!subject.ok) throw new Error('fixture');
      const verifier = new Verifier(f.store, f.authority, f.artifacts, f.plan, f.lock, () => subject.value), checked = [];
      for (const [index, slot] of f.plan.verifierSlots.entries()) checked.push(await verifier.run(prepareVerification(f.plan, f.lock, slot.id, source, candidate, 0, index.toString(16).padStart(32, '0')), new AbortController().signal));
      const result = evaluateControllerAcceptance(f.plan, f.lock, candidate.manifest, candidate.files, 0, checked, f.submitted('no_change'), f.store);
      assert.equal(result.result.spec.status, changed ? 'failed' : 'no_change'); assert.equal(checked.find(check => check.checkId === 'unchanged')!.status, changed ? 'failed' : 'passed'); assert.equal(checked.find(check => check.slotId === 'controller.no-change')!.status, changed ? 'failed' : 'passed');
      await writeFile(join(f.directory, 'core-4mib-result.json'), canonical({ version: 1, kind: 'real-worker-core-complete-inventory', nativeAgentExecution: false, sourceBytes: 4194304, candidateBytes: 4194304, lastByteChanged: changed, result, checked }), { mode: 0o600 });
    } finally { await f.close(); }
  }
});
test('actual Workers accept the complete exact-limit manifest and reject one extra byte before any intent', async () => {
  const f = await retainedFixture(1, 3, 2, 60000, config => {
    const prototype = config.registry.spec.handlers.find(handler => handler.implementation === 'no-change.v1')!;
    setFixture(config.registry, ['spec', 'handlers'], [...config.registry.spec.handlers, { ...prototype, id: 'declared.unchanged', parameters: { checkId: 'unchanged' } }]);
    setFixture(config.config, ['spec', 'task', 'spec', 'acceptance'], { required: ['unchanged'], checks: [{ id: 'unchanged', allowedEvidenceLevels: ['local_execution'] }] });
  });
  try {
    const files = Array.from({ length: 200 }, (_, index) => ({ name: 'packages/f' + String(index).padStart(3, '0'), bytes: Buffer.alloc(0) }));
    const rawManifest = () => ({ apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { entries: files.map(file => ({ name: file.name, byteLength: 0, digest: hash(file.bytes) })) } });
    let remaining = 32768 - Buffer.byteLength(canonical(rawManifest())); assert.ok(remaining > 0);
    for (const file of files) { const padding = Math.min(180, remaining); file.name = file.name + 'p'.repeat(padding); remaining -= padding; }
    assert.equal(remaining, 0); const candidate = await byteInventory(f, files); assert.equal(Buffer.byteLength(canonical(candidate.manifest)), 32768);
    const extra = { ...candidate.manifest, spec: { entries: candidate.manifest.spec.entries.map((entry, index) => index ? entry : { ...entry, name: entry.name + 'x' }) } }, extraRef = { name: 'extra.bin', digest: hash(canonical(extra)), byteLength: 32769 };
    assert.equal(Buffer.byteLength(canonical(extra)), 32769); const before = journal(f.store);
    assert.throws(() => prepareVerification(f.plan, f.lock, f.plan.verifierSlots[0]!.id, candidate, { manifest: extra, ref: extraRef, files: [{ ...files[0]!, name: files[0]!.name + 'x' }, ...files.slice(1)] }, 0, 'a'.repeat(32)));
    assert.deepEqual(journal(f.store).view.counts, before.view.counts);
    const subject = bindSubject(f.lock, candidate.manifest); assert.equal(subject.ok, true); if (!subject.ok) throw new Error('fixture'); const verifier = new Verifier(f.store, f.authority, f.artifacts, f.plan, f.lock, () => subject.value), checked = [];
    for (const [index, slot] of f.plan.verifierSlots.entries()) checked.push(await verifier.run(prepareVerification(f.plan, f.lock, slot.id, candidate, candidate, 0, index.toString(16).padStart(32, '0')), new AbortController().signal));
    const submission = normalizeSubmission(Buffer.from('{"version":1,"status":"no_change","checks":[{"checkId":"unchanged","status":"passed","evidenceId":null,"reason":null}],"reason":null}'), f.plan.task);
    const result = evaluateControllerAcceptance(f.plan, f.lock, candidate.manifest, candidate.files, 0, checked, submission, f.store); assert.equal(result.result.spec.status, 'no_change');
    await writeFile(join(f.directory, 'core-max-manifest-result.json'), canonical({ version: 1, kind: 'real-worker-core-complete-manifest', nativeAgentExecution: false, manifestBytes: 32768, entryCount: 200, overflowBytes: 32769, overflowIntentCount: before.operations.length, result, checked }), { mode: 0o600 });
  } finally { await f.close(); }
});
