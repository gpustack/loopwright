import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admitTask, evaluateAcceptance, validateDocument } from '../src/index.js';
import { contract, evaluationFixture, value, code } from './fixtures.js';

test('evidence binds check ID, observed outcome and host-selected subject', () => {
  const fixture = evaluationFixture();
  assert.equal(validateDocument(fixture.input.trusted.eligibleEvidence[0], 'Evidence').ok, true);
  assert.equal(value(evaluateAcceptance(fixture.input, fixture.artifacts)).spec.satisfied, true);
  fixture.input.trusted.eligibleEvidence[0]!.spec.observedStatus = 'failed';
  fixture.input.trusted.eligibleEvidence[0]!.spec.reason = 'command failed';
  assert.equal(code(evaluateAcceptance(fixture.input, fixture.artifacts)), 'EVIDENCE_CONTRADICTORY');
});
test('evidence stale destination base is rejected with fixed source and candidate bytes', () => {
  const fixture = evaluationFixture(), changed = contract();
  changed.spec.target.baseRevision = 'base-2';
  const oldLock = fixture.input.trusted.expectedLock;
  fixture.input.trusted.expectedLock = value(admitTask(changed, { admissionId: 'admission-1', runId: 'run-1' }));
  assert.notEqual(fixture.input.trusted.expectedLock.spec.contractHash.hex, oldLock.spec.contractHash.hex);
  assert.equal(fixture.input.trusted.expectedLock.spec.contract.spec.target.sourceRevision, oldLock.spec.contract.spec.target.sourceRevision);
  assert.equal(code(evaluateAcceptance(fixture.input, fixture.artifacts)), 'IDENTITY_MISMATCH');
});
test('evidence directly rejects every stale subject component', () => {
  for (const field of ['lockHash', 'contractHash', 'repository', 'baseRevision', 'sourceRevision', 'candidateDigest', 'targetMatrixDigest'] as const) {
    const fixture = evaluationFixture(), subject = fixture.input.trusted.eligibleEvidence[0]!.spec.subject;
    Object.assign(subject, { [field]: field.endsWith('Hash') || field.endsWith('Digest') ? { algorithm: 'sha256', hex: '0'.repeat(64) } : 'changed' });
    const result = evaluateAcceptance(fixture.input, fixture.artifacts);
    assert.equal(code(result), 'IDENTITY_MISMATCH', field);
    if (!result.ok) assert.equal(result.errors[0]!.path.endsWith('/' + field), true);
  }
});
test('evidence duplicate, contradictory and cross-check receipts are rejected', () => {
  for (const contradictory of [false, true]) {
    const fixture = evaluationFixture(), duplicate = structuredClone(fixture.input.trusted.eligibleEvidence[0]!);
    duplicate.metadata.id = 'observation-2';
    if (contradictory) { duplicate.spec.observedStatus = 'blocked'; duplicate.spec.reason = 'not available'; }
    fixture.input.trusted.eligibleEvidence.push(duplicate);
    assert.equal(code(evaluateAcceptance(fixture.input, fixture.artifacts)), contradictory ? 'EVIDENCE_CONTRADICTORY' : 'EVIDENCE_DUPLICATE');
  }
  const task = contract(); task.spec.acceptance.checks.push({ id: 'optional', allowedEvidenceLevels: ['local_execution'] });
  const fixture = evaluationFixture(task, 'optional'); fixture.input.claims[0]!.checkId = 'tests';
  assert.equal(code(evaluateAcceptance(fixture.input, fixture.artifacts)), 'EVIDENCE_CONTRADICTORY');
});
test('evidence level is an explicit allowed set, never a universal ordering', () => {
  const task = contract(); task.spec.acceptance.checks[0]!.allowedEvidenceLevels = ['hardware_execution'];
  const fixture = evaluationFixture(task);
  fixture.input.trusted.eligibleEvidence[0]!.spec.level = 'synthetic_fixture';
  const result = value(evaluateAcceptance(fixture.input, fixture.artifacts));
  assert.equal(result.spec.required[0]!.status, 'blocked');
  assert.equal(result.spec.diagnostics[0]!.code, 'EVIDENCE_LEVEL_DISALLOWED');
});

test('evidence target matrix identity is mandatory when a matrix is applicable', () => {
  const task = contract(); task.spec.target.matrix = [{ id: 'linux-cpu', platform: 'linux', variant: 'cpu' }];
  const fixture = evaluationFixture(task);
  assert.notEqual(fixture.input.trusted.eligibleEvidence[0]!.spec.subject.targetMatrixDigest, null);
  assert.equal(value(evaluateAcceptance(fixture.input, fixture.artifacts)).spec.satisfied, true);
  Object.assign(fixture.input.trusted.eligibleEvidence[0]!.spec.subject, { targetMatrixDigest: null });
  assert.equal(code(evaluateAcceptance(fixture.input, fixture.artifacts)), 'IDENTITY_MISMATCH');
});
