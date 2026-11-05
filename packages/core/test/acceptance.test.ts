import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constructRunResult, evaluateAcceptance, validateDocument, LIMITS } from '../src/index.js';
import { contract, evaluationFixture, value, code } from './fixtures.js';

test('acceptance every required check needs an eligible receipt and exact artifacts', () => {
  const fixture = evaluationFixture();
  const result = value(evaluateAcceptance(fixture.input, fixture.artifacts));
  assert.equal(result.spec.satisfied, true);
  assert.equal(validateDocument(result, 'VerificationResult').ok, true);
  fixture.input.trusted.eligibleEvidence = [];
  const fake = value(evaluateAcceptance(fixture.input, fixture.artifacts));
  assert.equal(fake.spec.satisfied, false);
  assert.equal(fake.spec.required[0]!.status, 'blocked');
  assert.equal(fake.spec.diagnostics[0]!.code, 'EVIDENCE_MISSING');
});
test('acceptance missing required check stays not_run even with optional pass or unclaimed evidence', () => {
  const task = contract(); task.spec.acceptance.checks.push({ id: 'optional', allowedEvidenceLevels: ['local_execution'] });
  const fixture = evaluationFixture(task, 'optional');
  const result = value(evaluateAcceptance(fixture.input, fixture.artifacts));
  assert.equal(result.spec.satisfied, false);
  assert.equal(result.spec.required[0]!.status, 'not_run');
  assert.equal(result.spec.optional[0]!.status, 'passed');
  const empty = evaluationFixture(); empty.input.claims = [];
  const missing = value(evaluateAcceptance(empty.input, empty.artifacts));
  assert.equal(missing.spec.satisfied, false);
  assert.equal(missing.spec.required[0]!.reason, 'missing_submission');
});
test('acceptance preserves failed, blocked and not_run observations without defaults', () => {
  for (const status of ['failed', 'blocked', 'not_run']) {
    const fixture = evaluationFixture(); fixture.input.trusted.eligibleEvidence = [];
    Object.assign(fixture.input.claims[0]!, { status, reason: 'honest failure', evidenceId: null });
    const result = value(evaluateAcceptance(fixture.input, fixture.artifacts));
    assert.equal(result.spec.required[0]!.status, status);
    assert.equal(result.spec.required[0]!.detail, 'honest failure');
    assert.equal(result.spec.satisfied, false);
  }
});
test('acceptance rejects duplicate claims and actor-injected verdict fields', () => {
  const fixture = evaluationFixture(); fixture.input.claims.push(structuredClone(fixture.input.claims[0]!));
  assert.equal(code(evaluateAcceptance(fixture.input, fixture.artifacts)), 'DUPLICATE_ID');
  const fake = evaluationFixture(); Object.assign(fake.input, { satisfied: true });
  assert.equal(code(evaluateAcceptance(fake.input, fake.artifacts)), 'FIELD_UNKNOWN');
});
test('acceptance exact-byte resolution reports missing, wrong length and stale digest', () => {
  for (const kind of ['missing', 'length', 'digest']) {
    const fixture = evaluationFixture();
    if (kind === 'missing') fixture.artifacts.pop();
    else if (kind === 'length') fixture.artifacts[1]!.bytes = Buffer.from('short');
    else fixture.artifacts[1]!.bytes = Buffer.alloc(fixture.artifacts[1]!.bytes.length, 120);
    const result = value(evaluateAcceptance(fixture.input, fixture.artifacts));
    assert.equal(result.spec.required[0]!.status, 'blocked');
    assert.equal(result.spec.satisfied, false);
    assert.equal(result.spec.diagnostics[0]!.code, { missing: 'ARTIFACT_MISSING', length: 'ARTIFACT_LENGTH_MISMATCH', digest: 'ARTIFACT_DIGEST_MISMATCH' }[kind]);
  }
  const candidate = evaluationFixture(); candidate.artifacts.shift();
  assert.equal(value(evaluateAcceptance(candidate.input, candidate.artifacts)).spec.diagnostics[0]!.code, 'ARTIFACT_MISSING');
});
test('acceptance validates inventory descriptors without calling getters', () => {
  const fixture = evaluationFixture(); let calls = 0;
  Object.defineProperty(fixture.artifacts[0], 'bytes', { enumerable: true, get() { calls++; return Buffer.from('bad'); } });
  assert.equal(code(evaluateAcceptance(fixture.input, fixture.artifacts)), 'INPUT_UNSUPPORTED');
  assert.equal(calls, 0);
});
test('acceptance artifact limits are checked before hashing the inventory', () => {
  const fixture = evaluationFixture();
  const inventory = Array.from({ length: 3 }, (_, index) => ({ name: 'blob-' + index, bytes: new Uint8Array(LIMITS.artifactBytes) }));
  assert.equal(code(evaluateAcceptance(fixture.input, inventory)), 'LIMIT_RESOLVED_BYTES');
  assert.equal(code(evaluateAcceptance(fixture.input, [{ name: 'big', bytes: new Uint8Array(LIMITS.artifactBytes + 1) }])), 'LIMIT_ARTIFACT_BYTES');
  const duplicate = [...fixture.artifacts, { ...fixture.artifacts[0]! }];
  assert.equal(code(evaluateAcceptance(fixture.input, duplicate)), 'ARTIFACT_DUPLICATE');
});

test('acceptance exact resolved inventory count and byte caps', () => {
  const fixture = evaluationFixture();
  const inventory = [...fixture.artifacts, ...Array.from({ length: LIMITS.resolvedArtifacts - 2 }, (_, i) => ({ name: 'extra-' + i, bytes: Buffer.alloc(0) }))];
  assert.equal(value(evaluateAcceptance(fixture.input, inventory)).spec.satisfied, true);
  inventory.push({ name: 'one-too-many', bytes: Buffer.alloc(0) });
  assert.equal(code(evaluateAcceptance(fixture.input, inventory)), 'LIMIT_COLLECTION');
  const bytes = new Uint8Array(LIMITS.artifactBytes);
  const exact = [{ name: 'candidate.patch', bytes }, { name: 'test.log', bytes }];
  assert.equal(value(evaluateAcceptance(fixture.input, exact)).spec.diagnostics[0]!.code, 'ARTIFACT_LENGTH_MISMATCH');
  assert.equal(code(evaluateAcceptance(fixture.input, [...exact, { name: 'extra', bytes: new Uint8Array(1) }])), 'LIMIT_RESOLVED_BYTES');
});

test('acceptance evaluates the full maximum required evidence and claim sets', () => {
  const task = contract();
  task.spec.acceptance.checks = Array.from({ length: LIMITS.checks }, (_, i) => ({ id: i ? 'check-' + i : 'tests', allowedEvidenceLevels: ['local_execution'] }));
  task.spec.acceptance.required = task.spec.acceptance.checks.map(check => check.id);
  const fixture = evaluationFixture(task), originalEvidence = fixture.input.trusted.eligibleEvidence[0]!;
  fixture.input.trusted.eligibleEvidence = task.spec.acceptance.required.map((checkId, i) => {
    const evidence = structuredClone(originalEvidence); evidence.metadata.id = 'observation-' + i; evidence.spec.checkId = checkId; return evidence;
  });
  fixture.input.claims = task.spec.acceptance.required.map((checkId, i) => ({ checkId, status: 'passed', evidenceId: 'observation-' + i, reason: null }));
  assert.equal(value(evaluateAcceptance(fixture.input, fixture.artifacts)).spec.required.length, LIMITS.checks);
  assert.equal(value(evaluateAcceptance(fixture.input, fixture.artifacts)).spec.satisfied, true);
  fixture.input.trusted.eligibleEvidence.push(structuredClone(originalEvidence));
  assert.equal(code(evaluateAcceptance(fixture.input, fixture.artifacts)), 'VALUE_RANGE');
  fixture.input.trusted.eligibleEvidence.pop();
  fixture.input.claims.push({ checkId: 'extra', status: 'passed', evidenceId: null, reason: null });
  assert.equal(code(evaluateAcceptance(fixture.input, fixture.artifacts)), 'VALUE_RANGE');
});

test('acceptance diagnostics never echo an unknown actor check identifier', () => {
  const fixture = evaluationFixture(); fixture.input.claims[0]!.checkId = 'secret-payload-canary';
  const rejected = evaluateAcceptance(fixture.input, fixture.artifacts);
  assert.equal(code(rejected), 'REFERENCE_UNKNOWN');
  assert.equal(JSON.stringify(rejected).includes('secret-payload-canary'), false);
  const duplicate = evaluationFixture(); duplicate.input.trusted.eligibleEvidence[0]!.spec.checkId = 'secret-payload-canary';
  const second = structuredClone(duplicate.input.trusted.eligibleEvidence[0]!); second.metadata.id = 'observation-2';
  duplicate.input.trusted.eligibleEvidence.push(second);
  const duplicateResult = evaluateAcceptance(duplicate.input, duplicate.artifacts);
  assert.equal(code(duplicateResult), 'EVIDENCE_DUPLICATE');
  assert.equal(JSON.stringify(duplicateResult).includes('secret-payload-canary'), false);
});

test('acceptance nested document invariants precede later control fields deterministically', () => {
  const fixture = evaluationFixture();
  fixture.input.trusted.expectedLock = structuredClone(fixture.input.trusted.expectedLock);
  Object.assign(fixture.input.trusted.expectedLock.spec, { lockHash: { algorithm: 'sha256', hex: '0'.repeat(64) } });
  Object.assign(fixture.input.claims[0]!, { unknownPolicy: true });
  assert.equal(code(evaluateAcceptance(fixture.input, fixture.artifacts)), 'HASH_MISMATCH');
});

test('review R1 same-check trusted contradictions and dangling failure references are rejected', () => {
  for (const evidenceId of [null, 'ghost']) {
    const fixture = evaluationFixture(); fixture.input.claims[0]!.evidenceId = evidenceId;
    Object.assign(fixture.input.trusted.eligibleEvidence[0]!.spec, { observedStatus: 'failed', reason: 'trusted command failed' });
    assert.equal(code(evaluateAcceptance(fixture.input, fixture.artifacts)), 'EVIDENCE_CONTRADICTORY');
  }
  for (const status of ['failed', 'blocked']) {
    const fixture = evaluationFixture(); fixture.input.trusted.eligibleEvidence = [];
    Object.assign(fixture.input.claims[0]!, { status, evidenceId: 'ghost', reason: 'not verified' });
    const rejected = evaluateAcceptance(fixture.input, fixture.artifacts);
    assert.equal(code(rejected), 'REFERENCE_UNKNOWN');
    if (!rejected.ok) assert.equal(rejected.errors[0]!.path, '/claims/0/evidenceId');
  }
});

test('review R1 missing submissions and pass evidence keep conservative outcomes', () => {
  const absent = evaluationFixture(); absent.input.claims = [];
  Object.assign(absent.input.trusted.eligibleEvidence[0]!.spec, { observedStatus: 'failed', reason: 'trusted command failed' });
  assert.equal(value(evaluateAcceptance(absent.input, absent.artifacts)).spec.required[0]!.status, 'not_run');
  for (const evidenceId of [null, 'ghost']) {
    const fixture = evaluationFixture(); fixture.input.claims[0]!.evidenceId = evidenceId; fixture.input.trusted.eligibleEvidence = [];
    const result = value(evaluateAcceptance(fixture.input, fixture.artifacts));
    assert.equal(result.spec.required[0]!.status, 'blocked');
    assert.equal(result.spec.diagnostics[0]!.code, 'EVIDENCE_MISSING');
  }
});

function evaluateForReview(fixture: ReturnType<typeof evaluationFixture>, construction: boolean) {
  if (!construction) return evaluateAcceptance(fixture.input, fixture.artifacts);
  return constructRunResult({ trusted: { ...fixture.input.trusted, usage: [], externalEffects: 'none', noChange: null },
    candidate: { status: 'completed', checks: fixture.input.claims, memory: { status: 'not_requested', reason: null } } }, fixture.artifacts);
}
test('review R2 all duplicate evidence checks precede unknown claim checks', () => {
  for (const construction of [false, true]) {
    const fixture = evaluationFixture(); fixture.input.claims[0]!.checkId = 'unknown';
    fixture.input.trusted.eligibleEvidence.push(structuredClone(fixture.input.trusted.eligibleEvidence[0]!));
    const rejected = evaluateForReview(fixture, construction);
    assert.equal(code(rejected), 'EVIDENCE_DUPLICATE');
    if (!rejected.ok) assert.equal(rejected.errors[0]!.path, '/trusted/eligibleEvidence/1/metadata/id');
  }
});
test('review R2 all unknown evidence checks precede every subject comparison', () => {
  for (const construction of [false, true]) {
    const fixture = evaluationFixture();
    Object.assign(fixture.input.trusted.eligibleEvidence[0]!.spec.subject, { sourceRevision: 'stale' });
    const unknown = structuredClone(fixture.input.trusted.eligibleEvidence[0]!);
    unknown.metadata.id = 'observation-2'; unknown.spec.checkId = 'unknown'; fixture.input.trusted.eligibleEvidence.push(unknown);
    const rejected = evaluateForReview(fixture, construction);
    assert.equal(code(rejected), 'REFERENCE_UNKNOWN');
    if (!rejected.ok) assert.equal(rejected.errors[0]!.path, '/trusted/eligibleEvidence/1/spec/checkId');
  }
});

for (const construction of [false, true]) {
  const entrypoint = construction ? 'construction' : 'direct';
  const claimsPath = construction ? '/candidate/checks' : '/claims';
  test(`review R3 unknown claim precedes unknown observation (${entrypoint})`, () => {
    const fixture = evaluationFixture(); fixture.input.claims[0]!.checkId = 'unknown-claim';
    fixture.input.trusted.eligibleEvidence[0]!.spec.checkId = 'unknown-observation';
    const rejected = evaluateForReview(fixture, construction);
    assert.equal(code(rejected), 'REFERENCE_UNKNOWN');
    if (!rejected.ok) assert.equal(rejected.errors[0]!.path, `${claimsPath}/0/checkId`);
  });
  test(`review R3 unknown claim precedes stale subject (${entrypoint})`, () => {
    const fixture = evaluationFixture(); fixture.input.claims[0]!.checkId = 'unknown-claim';
    Object.assign(fixture.input.trusted.eligibleEvidence[0]!.spec.subject, { sourceRevision: 'stale' });
    const rejected = evaluateForReview(fixture, construction);
    assert.equal(code(rejected), 'REFERENCE_UNKNOWN');
    if (!rejected.ok) assert.equal(rejected.errors[0]!.path, `${claimsPath}/0/checkId`);
  });
  test(`review R3 stale subject precedes claim contradiction (${entrypoint})`, () => {
    const fixture = evaluationFixture();
    Object.assign(fixture.input.trusted.eligibleEvidence[0]!.spec.subject, { sourceRevision: 'stale' });
    Object.assign(fixture.input.trusted.eligibleEvidence[0]!.spec, { observedStatus: 'failed', reason: 'trusted failure' });
    const rejected = evaluateForReview(fixture, construction);
    assert.equal(code(rejected), 'IDENTITY_MISMATCH');
    if (!rejected.ok) assert.equal(rejected.errors[0]!.path, '/trusted/eligibleEvidence/0/spec/subject/sourceRevision');
  });
}
