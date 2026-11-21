import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admitTask, evaluateAcceptance, validateDocument, LIMITS } from '../src/index.js';
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
  const task = contract();
  Object.assign(task.spec.target, {
    matrix: [{
      id: 'gpu-sm90',
      platform: 'linux',
      variant: 'cuda',
      hardware: { accelerator: 'sm_90a', isolationMode: 'whole_device' },
    }],
  });
  Object.assign(task.spec.acceptance.checks[0]!, {
    allowedEvidenceLevels: ['hardware_execution'],
    targetCellId: 'gpu-sm90',
  });
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

test('evidence accepts optional metrics, findings, and detail on passed while preserving reason === null', () => {
  const baseline = evaluationFixture();
  const baseParsed = value(validateDocument(baseline.input.trusted.eligibleEvidence[0], 'Evidence'));
  assert.equal(Object.hasOwn(baseParsed.spec, 'metrics'), false);
  assert.equal(Object.hasOwn(baseParsed.spec, 'findings'), false);
  assert.equal(Object.hasOwn(baseParsed.spec, 'detail'), false);

  const fixture = evaluationFixture();
  const evidence = fixture.input.trusted.eligibleEvidence[0]!;
  Object.assign(evidence.spec, {
    detail: 'kernel benchmark passed within SLA',
    metrics: Object.assign(Object.create(null), {
      latency_us: 42.5,
      speedup: 1.18,
      delta: -0,
      profile: 'fp16',
      cached: true,
    }),
    findings: [
      { title: 'Minor register pressure', severity: 'low', path: 'packages/core/src/boundary.ts', line: 99, evidence: '32 regs/thread' },
      { title: 'General note', severity: 'medium', evidence: 'all checks green' },
    ],
  });
  const parsed = value(validateDocument(evidence, 'Evidence'));
  assert.equal(parsed.spec.reason, null);
  assert.equal(parsed.spec.detail, 'kernel benchmark passed within SLA');
  assert.equal(parsed.spec.metrics?.latency_us, 42.5);
  assert.equal(parsed.spec.metrics?.speedup, 1.18);
  assert.equal(Object.is(parsed.spec.metrics?.delta, 0), true);
  assert.equal(Object.is(parsed.spec.metrics?.delta, -0), false);
  assert.equal(parsed.spec.metrics?.profile, 'fp16');
  assert.equal(parsed.spec.metrics?.cached, true);
  assert.equal(Object.getPrototypeOf(parsed.spec.metrics), null);
  assert.equal(parsed.spec.findings?.length, 2);
  assert.equal(Object.hasOwn(parsed.spec.findings![1]!, 'path'), false);
  assert.equal(Object.hasOwn(parsed.spec.findings![1]!, 'line'), false);

  // reason !== null on passed MUST still fail
  const badReason = evaluationFixture();
  badReason.input.trusted.eligibleEvidence[0]!.spec.reason = 'must be null on passed';
  assert.equal(code(validateDocument(badReason.input.trusted.eligibleEvidence[0], 'Evidence')), 'VALUE_RANGE');
});

test('evidence validates metrics and findings bounds and types strictly', () => {
  const withMetrics = (metrics: unknown) => {
    const fixture = evaluationFixture();
    Object.assign(fixture.input.trusted.eligibleEvidence[0]!.spec, { metrics });
    return validateDocument(fixture.input.trusted.eligibleEvidence[0], 'Evidence');
  };
  assert.equal(code(withMetrics({ latency_us: NaN })), 'VALUE_RANGE');
  assert.equal(code(withMetrics({ latency_us: Infinity })), 'VALUE_RANGE');
  assert.equal(code(withMetrics({ latency_us: -Infinity })), 'VALUE_RANGE');
  assert.equal(code(withMetrics({ note: 'x'.repeat(LIMITS.metricStringValue + 1) })), 'VALUE_RANGE');
  assert.equal(code(withMetrics({ bad: null })), 'VALUE_TYPE');
  assert.equal(code(withMetrics({ bad: [1] })), 'VALUE_TYPE');
  assert.equal(code(withMetrics({ 'bad/key': 1 })), 'IDENTIFIER_INVALID');
  assert.equal(code(withMetrics({ ['k'.repeat(LIMITS.metricKey + 1)]: 1 })), 'IDENTIFIER_INVALID');
  for (const forbidden of ['__proto__', 'constructor', 'prototype']) {
    const nullProtoMetrics: Record<string, number> = Object.create(null) as Record<string, number>;
    nullProtoMetrics[forbidden] = 1;
    assert.equal(code(withMetrics(nullProtoMetrics)), 'IDENTIFIER_INVALID', forbidden);
    const fixture = evaluationFixture();
    const jsonWithForbidden = JSON.stringify(fixture.input.trusted.eligibleEvidence[0]).replace(
      '"reason":null',
      `"reason":null,"metrics":{"${forbidden}":1}`,
    );
    assert.equal(code(validateDocument(jsonWithForbidden, 'Evidence')), 'IDENTIFIER_INVALID', forbidden);
  }
  const tooManyMetrics = Object.fromEntries(Array.from({ length: LIMITS.metricEntries + 1 }, (_, i) => [`m_${i}`, i]));
  assert.equal(code(withMetrics(tooManyMetrics)), 'VALUE_RANGE');

  const withFindings = (findings: unknown) => {
    const fixture = evaluationFixture();
    Object.assign(fixture.input.trusted.eligibleEvidence[0]!.spec, { findings });
    return validateDocument(fixture.input.trusted.eligibleEvidence[0], 'Evidence');
  };
  assert.equal(code(withFindings([{ title: 'Bad sev', severity: 'info', evidence: 'x' }])), 'VALUE_ENUM');
  assert.equal(code(withFindings([{ title: 'Float line', severity: 'high', line: 1.5, evidence: 'x' }])), 'VALUE_RANGE');
  assert.equal(code(withFindings([{ title: 'Zero line', severity: 'high', line: 0, evidence: 'x' }])), 'VALUE_RANGE');
  assert.equal(code(withFindings([{ title: 'Traversal', severity: 'critical', path: '../secret', evidence: 'x' }])), 'PATH_INVALID');
  const tooManyFindings = Array.from({ length: LIMITS.findings + 1 }, (_, i) => ({
    title: `f-${i}`, severity: 'low', evidence: 'e',
  }));
  assert.equal(code(withFindings(tooManyFindings)), 'VALUE_RANGE');
});
