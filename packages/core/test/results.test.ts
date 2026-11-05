import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constructRunResult, evaluateAcceptance, validateDocument } from '../src/index.js';
import { contract, evaluationFixture, value, code } from './fixtures.js';

export function runFixture() {
  const base = evaluationFixture();
  return { input: { trusted: { ...base.input.trusted, usage: [{ requestId: 'lost-call', inputTokens: { provenance: 'unknown' }, outputTokens: { provenance: 'unknown' }, costMicrousd: { provenance: 'unknown' } }],
    externalEffects: 'none', noChange: null as null | { checkId: string; evidenceId: string; reason: string } },
  candidate: { status: 'completed', checks: base.input.claims, memory: { status: 'pending', reason: 'awaiting independent memory review' } } }, artifacts: base.artifacts };
}
test('result completed derives fresh verification and preserves unknown usage and pending memory', () => {
  const fixture = runFixture(), result = value(constructRunResult(fixture.input, fixture.artifacts));
  assert.equal(result.spec.status, 'completed');
  assert.equal(result.spec.verification.spec.satisfied, true);
  assert.equal(result.spec.usage.totalTokens.completeness, 'partial');
  assert.equal(result.spec.memory.status, 'pending');
  assert.equal(validateDocument(result, 'RunResult').ok, true);
  assert.deepEqual(value(constructRunResult(fixture.input, fixture.artifacts)), result);
});
test('result rejects completed with incomplete matrix and forged serialized acceptance', () => {
  const fixture = runFixture(); fixture.input.candidate.checks = [];
  assert.equal(code(constructRunResult(fixture.input, fixture.artifacts)), 'RUN_ACCEPTANCE_REQUIRED');
  const fake = runFixture(), original = value(evaluateAcceptance(evaluationFixture().input, fake.artifacts));
  Object.assign(fake.input.candidate, { verification: original, satisfied: true });
  assert.equal(code(constructRunResult(fake.input, fake.artifacts)), 'FIELD_UNKNOWN');
  const noEvidence = runFixture(); noEvidence.input.trusted.eligibleEvidence = [];
  assert.equal(code(constructRunResult(noEvidence.input, noEvidence.artifacts)), 'RUN_ACCEPTANCE_REQUIRED');
});
test('result no_change requires trusted no-change receipt plus complete required acceptance', () => {
  const fixture = runFixture(); fixture.input.candidate.status = 'no_change';
  assert.equal(code(constructRunResult(fixture.input, fixture.artifacts)), 'RUN_NO_CHANGE_REQUIRED');
  fixture.input.trusted.noChange = { checkId: 'tests', evidenceId: 'observation-1', reason: 'no_applicable_update' };
  assert.equal(code(constructRunResult(fixture.input, fixture.artifacts)), 'RUN_NO_CHANGE_REQUIRED');
  fixture.input.trusted.eligibleEvidence[0]!.spec.method = 'verify_no_change';
  const result = value(constructRunResult(fixture.input, fixture.artifacts));
  assert.equal(result.spec.status, 'no_change');
  assert.equal(validateDocument(result, 'RunResult').ok, true);
  fixture.input.candidate.checks = [];
  assert.equal(code(constructRunResult(fixture.input, fixture.artifacts)), 'RUN_NO_CHANGE_REQUIRED');
});
test('result unknown external effects require reconcile_required for every other status', () => {
  for (const status of ['completed', 'no_change', 'blocked', 'exhausted', 'expired', 'cancelled', 'failed']) {
    const fixture = runFixture(); fixture.input.candidate.status = status; fixture.input.trusted.externalEffects = 'unknown';
    assert.equal(code(constructRunResult(fixture.input, fixture.artifacts)), 'RUN_RECONCILIATION_REQUIRED', status);
  }
  const fixture = runFixture(); fixture.input.candidate.status = 'reconcile_required'; fixture.input.trusted.externalEffects = 'unknown';
  assert.equal(value(constructRunResult(fixture.input, fixture.artifacts)).spec.status, 'reconcile_required');
});
test('result lifecycle and memory do not rewrite failed verification', () => {
  for (const status of ['blocked', 'exhausted', 'expired', 'cancelled', 'failed', 'reconcile_required']) {
    const fixture = runFixture(); fixture.input.candidate.status = status;
    fixture.input.trusted.eligibleEvidence = [];
    Object.assign(fixture.input.candidate.checks[0]!, { status: 'failed', evidenceId: null, reason: 'test failure' });
    fixture.input.candidate.memory = { status: 'unavailable', reason: 'memory budget unavailable' };
    const result = value(constructRunResult(fixture.input, fixture.artifacts));
    assert.equal(result.spec.verification.spec.required[0]!.status, 'failed');
    assert.equal(result.spec.status, status);
    assert.equal(result.spec.memory.status, 'unavailable');
  }
});

test('review R1 duplicate and overflowing usage precedes an invalid artifact inventory', () => {
  const duplicate = runFixture();
  duplicate.input.trusted.usage.push(structuredClone(duplicate.input.trusted.usage[0]!));
  const result = constructRunResult(duplicate.input, null as unknown as []);
  assert.equal(code(result), 'DUPLICATE_ID');
  if (!result.ok) assert.equal(result.errors[0]!.path, '/trusted/usage/1');
  const overflow = runFixture();
  Object.assign(overflow.input.trusted.usage[0]!, { inputTokens: { provenance: 'reported', value: Number.MAX_SAFE_INTEGER }, outputTokens: { provenance: 'reported', value: 1 } });
  assert.equal(code(constructRunResult(overflow.input, null as unknown as [])), 'USAGE_OVERFLOW');
});

test('review R1 invalid no-change method precedes another missing required check', () => {
  const task = contract(); task.spec.acceptance.checks.push({ id: 'scope', allowedEvidenceLevels: ['local_execution'] }); task.spec.acceptance.required.push('scope');
  const fixture = evaluationFixture(task);
  const input = { trusted: { ...fixture.input.trusted, usage: [], externalEffects: 'none',
    noChange: { checkId: 'tests', evidenceId: 'observation-1', reason: 'no_applicable_update' } },
  candidate: { status: 'no_change', checks: fixture.input.claims, memory: { status: 'not_requested', reason: null } } };
  assert.equal(code(constructRunResult(input, fixture.artifacts)), 'RUN_NO_CHANGE_REQUIRED');
  input.trusted.externalEffects = 'unknown';
  assert.equal(code(constructRunResult(input, fixture.artifacts)), 'RUN_RECONCILIATION_REQUIRED');
});

test('review R2 run diagnostics point into the actual construction input', () => {
  const contradiction = runFixture();
  Object.assign(contradiction.input.trusted.eligibleEvidence[0]!.spec, { observedStatus: 'failed', reason: 'trusted failure' });
  const rejected = constructRunResult(contradiction.input, contradiction.artifacts);
  assert.equal(code(rejected), 'EVIDENCE_CONTRADICTORY');
  if (!rejected.ok) assert.equal(rejected.errors[0]!.path, '/candidate/checks/0/status');
  const missing = runFixture(); missing.input.candidate.checks = []; missing.input.candidate.status = 'blocked';
  const result = value(constructRunResult(missing.input, missing.artifacts));
  assert.equal(result.spec.verification.spec.diagnostics[0]!.path, '/candidate/checks');
  const overflow = runFixture();
  Object.assign(overflow.input.trusted.usage[0]!, { inputTokens: { provenance: 'reported', value: Number.MAX_SAFE_INTEGER }, outputTokens: { provenance: 'reported', value: 1 } });
  const overflowResult = constructRunResult(overflow.input, overflow.artifacts);
  assert.equal(code(overflowResult), 'USAGE_OVERFLOW');
  if (!overflowResult.ok) assert.equal(overflowResult.errors[0]!.path, '/trusted/usage');
});

test('review R2 serialized usage diagnostics point to serialized request fields', () => {
  const fixture = runFixture(); const serialized = structuredClone(value(constructRunResult(fixture.input, fixture.artifacts)));
  Object.assign(serialized.spec.usage, { requests: [...serialized.spec.usage.requests, structuredClone(serialized.spec.usage.requests[0]!)] });
  const rejected = validateDocument(serialized, 'RunResult');
  assert.equal(code(rejected), 'DUPLICATE_ID');
  if (!rejected.ok) assert.equal(rejected.errors[0]!.path, '/spec/usage/requests/1');
});
