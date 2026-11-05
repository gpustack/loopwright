import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { constructRunResult, evaluateAcceptance, validateDocument, type DocumentKind, type RunResult } from '../src/index.js';
import { contract, evaluationFixture, value, code } from './fixtures.js';

for (const kind of ['VerificationResult', 'RunResult'] as const) {
  for (const duplicate of ['required/required', 'required/optional', 'optional/optional'] as const) {
    test(`coordinator C1 ${kind} duplicate ${duplicate} points to its containing array`, () => {
      const run = JSON.parse(readFileSync('examples/satisfied.json', 'utf8')) as RunResult;
      const verification = run.spec.verification;
      const input = kind === 'RunResult' ? run : verification;
      const required = structuredClone(verification.spec.required[0]!);
      const optional = { ...structuredClone(required), checkId: 'optional-check' };
      Object.assign(verification.spec, { optional: [optional] });
      assert.equal(validateDocument(input, kind).ok, true);
      if (duplicate === 'required/required') {
        Object.assign(verification.spec, { required: [required, structuredClone(required)] });
      } else if (duplicate === 'required/optional') {
        Object.assign(verification.spec, { optional: [structuredClone(required)] });
      } else {
        Object.assign(verification.spec, { optional: [optional, structuredClone(optional)] });
      }
      const location = duplicate === 'required/required' ? 'required/1'
        : duplicate === 'required/optional' ? 'optional/0' : 'optional/1';
      const prefix = kind === 'RunResult' ? '/spec/verification' : '';
      assert.deepEqual(validateDocument(input, kind), { ok: false,
        errors: [{ code: 'DUPLICATE_ID', path: `${prefix}/spec/${location}`, checkId: null }] });
    });
  }
}

test('integration public author-to-result flow exactly reproduces committed examples', () => {
  const task = JSON.parse(readFileSync('examples/task.json', 'utf8')) as ReturnType<typeof contract>;
  assert.equal(validateDocument(task, 'TaskContract').ok, true);
  for (const scenario of ['satisfied', 'failed', 'missing', 'unknown-usage']) {
    const fixture = evaluationFixture(task);
    fixture.input.trusted.eligibleEvidence[0]!.spec.level = 'synthetic_fixture';
    fixture.input.trusted.eligibleEvidence[0]!.spec.producerId = 'example-host';
    fixture.input.trusted.eligibleEvidence[0]!.spec.method = 'library-fixture';
    const usage = scenario === 'unknown-usage'
      ? [{ requestId: 'request-1', inputTokens: { provenance: 'unknown' }, outputTokens: { provenance: 'unknown' }, costMicrousd: { provenance: 'unknown' } }]
      : [{ requestId: 'request-1', inputTokens: { provenance: 'reported', value: 11 }, outputTokens: { provenance: 'reported', value: 3 }, costMicrousd: { provenance: 'reported', value: 10 } }];
    const candidate = { status: 'completed', checks: fixture.input.claims, memory: { status: 'not_requested', reason: null } };
    if (scenario === 'failed') {
      candidate.status = 'failed'; fixture.input.trusted.eligibleEvidence = [];
      Object.assign(candidate.checks[0]!, { status: 'failed', evidenceId: null, reason: 'fixture check failed' });
    }
    if (scenario === 'missing') { candidate.status = 'blocked'; candidate.checks = []; }
    const result = value(constructRunResult({ trusted: { ...fixture.input.trusted, usage, externalEffects: 'none', noChange: null }, candidate }, fixture.artifacts));
    const committed: unknown = JSON.parse(readFileSync('examples/' + scenario + '.json', 'utf8'));
    assert.deepEqual(JSON.parse(JSON.stringify(result)) as unknown, committed);
    assert.equal(validateDocument(committed, 'RunResult').ok, true);
  }
});

test('integration every public persisted kind rejects unknown policy and unsupported versions', () => {
  const task = contract(), fixture = evaluationFixture(task);
  const documents: [DocumentKind, unknown][] = [
    ['TaskContract', task], ['TaskLock', fixture.input.trusted.expectedLock],
    ['ArtifactManifest', fixture.input.trusted.candidateManifest], ['Evidence', fixture.input.trusted.eligibleEvidence[0]],
    ['VerificationResult', value(evaluateAcceptance(fixture.input, fixture.artifacts))],
    ['RunResult', JSON.parse(readFileSync('examples/satisfied.json', 'utf8')) as unknown],
  ];
  for (const [kind, document] of documents) {
    const invalid = { ...document as object, apiVersion: 'loopwright.dev/v999', secretCanary: 'private-canary' };
    const rejected = validateDocument(invalid, kind);
    assert.equal(code(rejected), 'VERSION_UNSUPPORTED');
    assert.equal(JSON.stringify(rejected).includes('private-canary'), false);
    assert.equal(code(validateDocument({ ...document as object, unknownPolicy: true }, kind)), 'FIELD_UNKNOWN');
  }
});

test('integration current trusted inputs reject fake, missing, stale and wrong-level acceptance', () => {
  for (const variant of ['fake-pass', 'missing-check', 'stale-bytes', 'changed-source', 'wrong-level', 'unknown-usage']) {
    const fixture = evaluationFixture();
    if (variant === 'fake-pass') fixture.input.trusted.eligibleEvidence = [];
    if (variant === 'missing-check') fixture.input.claims = [];
    if (variant === 'stale-bytes') fixture.artifacts[0]!.bytes.fill(120);
    if (variant === 'changed-source') Object.assign(fixture.input.trusted.eligibleEvidence[0]!.spec.subject, { sourceRevision: 'source-2' });
    if (variant === 'wrong-level') fixture.input.trusted.eligibleEvidence[0]!.spec.level = 'synthetic_fixture';
    const usage = variant === 'unknown-usage' ? [{ requestId: 'lost-call', inputTokens: { provenance: 'unknown' }, outputTokens: { provenance: 'unknown' }, costMicrousd: { provenance: 'unknown' } }] : [];
    const result = constructRunResult({ trusted: { ...fixture.input.trusted, usage, externalEffects: 'none', noChange: null },
      candidate: { status: 'completed', checks: fixture.input.claims, memory: { status: 'not_requested', reason: null } } }, fixture.artifacts);
    if (variant === 'unknown-usage') {
      const accepted = value(result);
      assert.equal(accepted.spec.verification.spec.satisfied, true);
      assert.equal(accepted.spec.usage.totalTokens.completeness, 'partial');
    } else assert.equal(code(result), variant === 'changed-source' ? 'IDENTITY_MISMATCH' : 'RUN_ACCEPTANCE_REQUIRED', variant);
  }
});
