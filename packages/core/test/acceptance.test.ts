import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  admitTask, bindSubject, constructRunResult, digestArtifact, digestArtifactFromMetadata, evaluateAcceptance,
  identifyManifest, validateDocument, LIMITS, OVERLAY_LIMITS, type Digest, type ResolvedArtifactInput,
} from '../src/index.js';
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

test('acceptance propagates trusted metrics, findings, and detail on passed checks and round-trips through RunResult', () => {
  const fixture = evaluationFixture();
  Object.assign(fixture.input.trusted.eligibleEvidence[0]!.spec, {
    detail: 'bench ok',
    metrics: { latency_us: 42.5, speedup: 1.18, delta: -0 },
    findings: [{ title: 'Advisory note', severity: 'low', path: 'packages/core/src/acceptance.ts', line: 10, evidence: 'ok' }],
  });
  // Untrusted claim metadata on passed must not override trusted evidence
  Object.assign(fixture.input.claims[0]!, {
    detail: 'forged claim detail',
    metrics: { latency_us: 0.1 },
    findings: [{ title: 'Forged finding', severity: 'critical', evidence: 'fake' }],
  });

  const evaluated = value(evaluateAcceptance(fixture.input, fixture.artifacts));
  const row = evaluated.spec.required[0]!;
  assert.equal(row.status, 'passed');
  assert.equal(row.reason, 'observed_pass');
  assert.equal(row.detail, 'bench ok');
  assert.equal(row.metrics?.latency_us, 42.5);
  assert.equal(row.metrics?.speedup, 1.18);
  assert.equal(Object.is(row.metrics?.delta, 0), true);
  assert.equal(row.findings?.length, 1);
  assert.equal(row.findings?.[0]?.title, 'Advisory note');
  assert.equal(validateDocument(evaluated, 'VerificationResult').ok, true);

  const run = value(constructRunResult({
    trusted: { ...fixture.input.trusted, usage: [], externalEffects: 'none', noChange: null },
    candidate: { status: 'completed', checks: fixture.input.claims, memory: { status: 'not_requested', reason: null } },
  }, fixture.artifacts));
  assert.equal(run.spec.verification.spec.required[0]!.detail, 'bench ok');
  assert.equal(run.spec.verification.spec.required[0]!.metrics?.latency_us, 42.5);
  assert.equal(run.spec.verification.spec.required[0]!.findings?.[0]?.title, 'Advisory note');
  assert.equal(validateDocument(run, 'RunResult').ok, true);

  // If trusted evidence has no detail/metrics/findings, untrusted claim cannot inject them on passed
  const plain = evaluationFixture();
  Object.assign(plain.input.claims[0]!, {
    detail: 'forged',
    metrics: { speedup: 999 },
    findings: [{ title: 'Forged', severity: 'high', evidence: 'fake' }],
  });
  const plainEval = value(evaluateAcceptance(plain.input, plain.artifacts));
  assert.equal(plainEval.spec.required[0]!.detail, null);
  assert.equal(Object.hasOwn(plainEval.spec.required[0]!, 'metrics'), false);
  assert.equal(Object.hasOwn(plainEval.spec.required[0]!, 'findings'), false);
});

test('acceptance propagates metrics and findings on failed submitted checks', () => {
  const fixture = evaluationFixture();
  fixture.input.trusted.eligibleEvidence = [];
  Object.assign(fixture.input.claims[0]!, {
    status: 'failed',
    evidenceId: null,
    reason: 'regression detected',
    metrics: { latency_us: 99.25 },
    findings: [{ title: 'Latency spike', severity: 'high', evidence: '99.25us > 50us' }],
  });
  const evaluated = value(evaluateAcceptance(fixture.input, fixture.artifacts));
  assert.equal(evaluated.spec.required[0]!.status, 'failed');
  assert.equal(evaluated.spec.required[0]!.detail, 'regression detected');
  assert.equal(evaluated.spec.required[0]!.metrics?.latency_us, 99.25);
  assert.equal(evaluated.spec.required[0]!.findings?.[0]?.title, 'Latency spike');
  assert.equal(validateDocument(evaluated, 'VerificationResult').ok, true);

  // When trusted failed evidence is also present, trusted evidence metrics/findings take precedence
  const withTrustedFail = evaluationFixture();
  Object.assign(withTrustedFail.input.trusted.eligibleEvidence[0]!.spec, {
    observedStatus: 'failed',
    reason: 'trusted fail',
    metrics: { latency_us: 120.5 },
    findings: [{ title: 'Trusted finding', severity: 'critical', evidence: 'verified' }],
  });
  Object.assign(withTrustedFail.input.claims[0]!, {
    status: 'failed',
    evidenceId: 'observation-1',
    reason: 'trusted fail',
    metrics: { latency_us: 1.0 },
    findings: [{ title: 'Claim finding', severity: 'low', evidence: 'untrusted' }],
  });
  const trustedEval = value(evaluateAcceptance(withTrustedFail.input, withTrustedFail.artifacts));
  assert.equal(trustedEval.spec.required[0]!.metrics?.latency_us, 120.5);
  assert.equal(trustedEval.spec.required[0]!.findings?.[0]?.title, 'Trusted finding');
  assert.equal(validateDocument(trustedEval, 'VerificationResult').ok, true);

  // VerificationResult still rejects non-null detail on missing_submission/missing_evidence
  const missing = evaluationFixture();
  missing.input.claims = [];
  const missingResult = structuredClone(value(evaluateAcceptance(missing.input, missing.artifacts)));
  Object.assign(missingResult.spec.required[0]!, { detail: 'should not be allowed on missing_submission' });
  assert.equal(code(validateDocument(missingResult, 'VerificationResult')), 'VALUE_RANGE');

  // SubmittedCheck on passed still enforces reason === null even with detail/metrics present
  const badClaim = evaluationFixture();
  Object.assign(badClaim.input.claims[0]!, { reason: 'not allowed on pass', detail: 'extra' });
  assert.equal(code(evaluateAcceptance(badClaim.input, badClaim.artifacts)), 'VALUE_RANGE');
});

test('acceptance and constructRunResult support 512-file overlay manifests via contract budgets.overlay or options, failing at 513 and default 129', () => {
  const buildOverlayScenario = (fileCount: number, withContractOverlay: boolean) => {
    const task = contract();
    if (withContractOverlay) {
      Object.assign(task.spec.budgets, { overlay: { maxFiles: 512, maxBytes: 16_777_216 } });
    }
    const expectedLock = value(admitTask(task, { admissionId: 'admission-1', runId: 'run-1' }));
    const fileNames = Array.from({ length: fileCount }, (_, i) => `packages/file-${String(i).padStart(4, '0')}.ts`).sort();
    const candidateArtifacts = fileNames.map(name => ({ name, bytes: Buffer.from(`export const x = '${name}';\n`) }));
    const candidateManifest = {
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'ArtifactManifest',
      metadata: { id: 'candidate' },
      spec: {
        baseTree: { objectFormat: 'sha256' as const, commitOid: 'a'.repeat(64), treeOid: 'b'.repeat(64) },
        entries: candidateArtifacts.map(({ name, bytes }) => value(digestArtifact(name, bytes))),
        deleted: [] as string[],
      },
    };
    const logBytes = Buffer.from('512-file overlay tests passed\n');
    const opts = fileCount > LIMITS.overlayEntries ? { overlay: { maxFiles: Math.max(512, fileCount), maxBytes: 16_777_216 } } : undefined;
    const subject = value(bindSubject(expectedLock, candidateManifest, opts));
    const evidence = {
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'Evidence',
      metadata: { id: 'observation-1' },
      spec: {
        checkId: 'tests',
        observedStatus: 'passed',
        producerId: 'host-verifier',
        method: 'node-test',
        level: 'local_execution',
        subject: structuredClone(subject),
        artifacts: [value(digestArtifact('test.log', logBytes))],
        reason: null as string | null,
      },
    };
    const claims = [{ checkId: 'tests', status: 'passed', evidenceId: 'observation-1', reason: null }];
    return {
      evalInput: { trusted: { expectedLock, candidateManifest, eligibleEvidence: [evidence] }, claims },
      runInput: {
        trusted: { expectedLock, candidateManifest, eligibleEvidence: [evidence], usage: [], externalEffects: 'none', noChange: null },
        candidate: { status: 'completed', checks: claims, memory: { status: 'not_requested', reason: null } },
      },
      artifacts: [...candidateArtifacts, { name: 'test.log', bytes: logBytes }],
    };
  };

  // 1) Derived automatically from TaskContract.spec.budgets.overlay (no options arg needed)
  const viaContract512 = buildOverlayScenario(512, true);
  assert.equal(value(evaluateAcceptance(viaContract512.evalInput, viaContract512.artifacts)).spec.satisfied, true);
  assert.equal(value(constructRunResult(viaContract512.runInput, viaContract512.artifacts)).spec.status, 'completed');

  // 2) Fails closed at 513 entries under { maxFiles: 512, maxBytes: 16_777_216 }
  const viaContract513 = buildOverlayScenario(513, true);
  assert.equal(code(evaluateAcceptance(viaContract513.evalInput, viaContract513.artifacts)), 'VALUE_RANGE');
  assert.equal(code(constructRunResult(viaContract513.runInput, viaContract513.artifacts)), 'VALUE_RANGE');

  // 3) Explicit options.overlay works even when contract.spec.budgets.overlay is omitted
  const viaOpts512 = buildOverlayScenario(512, false);
  const opts512 = { overlay: { maxFiles: 512, maxBytes: 16_777_216 } } as const;
  assert.equal(value(evaluateAcceptance(viaOpts512.evalInput, viaOpts512.artifacts, opts512)).spec.satisfied, true);
  assert.equal(value(constructRunResult(viaOpts512.runInput, viaOpts512.artifacts, opts512)).spec.status, 'completed');

  // 4) Default limits still fail closed at 129 entries when neither budgets.overlay nor options.overlay is set
  const default129 = buildOverlayScenario(129, false);
  assert.equal(code(evaluateAcceptance(default129.evalInput, default129.artifacts)), 'VALUE_RANGE');
  assert.equal(code(constructRunResult(default129.runInput, default129.artifacts)), 'VALUE_RANGE');
});

test('non-passing checks enforce trusted Evidence authority, propagate SubmittedCheck.detail, and verificationSchema rejects unverified metadata', () => {
  // 1) evidenceId: null bypass cannot drop trusted Evidence id/detail/metrics/findings or artifact diagnostics
  const bypass = evaluationFixture();
  Object.assign(bypass.input.trusted.eligibleEvidence[0]!.spec, {
    observedStatus: 'failed',
    reason: 'trusted reason',
    detail: 'trusted failure detail',
    metrics: { latency_us: 120.5 },
    findings: [{ title: 'Trusted SLA failure', severity: 'critical', evidence: '120.5us' }],
  });
  Object.assign(bypass.input.claims[0]!, {
    status: 'failed',
    evidenceId: null,
    reason: 'untrusted spin',
    detail: 'forged detail',
    metrics: { latency_us: 0.1 },
    findings: [{ title: 'Harmless nit', severity: 'low', evidence: 'forged' }],
  });
  // Drop evidence artifact so trusted artifact diagnostic must still be emitted
  const bypassResult = value(evaluateAcceptance(bypass.input, [bypass.artifacts[0]!]));
  const bypassRow = bypassResult.spec.required[0]!;
  assert.equal(bypassRow.evidenceId, 'observation-1');
  assert.equal(bypassRow.detail, 'trusted failure detail');
  assert.equal(bypassRow.metrics?.latency_us, 120.5);
  assert.equal(bypassRow.findings?.[0]?.title, 'Trusted SLA failure');
  assert.equal(bypassResult.spec.diagnostics.some(d => d.code === 'ARTIFACT_MISSING'), true);
  assert.equal(validateDocument(bypassResult, 'VerificationResult').ok, true);

  // 2) Trusted Evidence without metrics/findings/detail must NOT fall back to untrusted claim.*
  const noMeta = evaluationFixture();
  Object.assign(noMeta.input.trusted.eligibleEvidence[0]!.spec, {
    observedStatus: 'failed',
    reason: 'trusted fail reason',
  });
  Object.assign(noMeta.input.claims[0]!, {
    status: 'failed',
    evidenceId: 'observation-1',
    reason: 'claim reason',
    detail: 'forged claim detail',
    metrics: { speedup: 999 },
    findings: [{ title: 'Forged finding', severity: 'low', evidence: 'fake' }],
  });
  const noMetaRow = value(evaluateAcceptance(noMeta.input, noMeta.artifacts)).spec.required[0]!;
  assert.equal(noMetaRow.evidenceId, 'observation-1');
  assert.equal(noMetaRow.detail, 'trusted fail reason');
  assert.equal(Object.hasOwn(noMetaRow, 'metrics'), false);
  assert.equal(Object.hasOwn(noMetaRow, 'findings'), false);

  // 3) not_run with trusted Evidence preserves evidenceId: null for VerificationResult round-trip while using trusted metadata
  const trustedNotRun = evaluationFixture();
  Object.assign(trustedNotRun.input.trusted.eligibleEvidence[0]!.spec, {
    observedStatus: 'not_run',
    reason: 'trusted skip',
    detail: 'trusted skip detail',
    metrics: { skipped: true },
  });
  Object.assign(trustedNotRun.input.claims[0]!, {
    status: 'not_run',
    evidenceId: null,
    reason: 'claim skip',
    detail: 'forged skip',
    metrics: { skipped: false },
  });
  const notRunEval = value(evaluateAcceptance(trustedNotRun.input, trustedNotRun.artifacts));
  assert.equal(notRunEval.spec.required[0]!.evidenceId, null);
  assert.equal(notRunEval.spec.required[0]!.detail, 'trusted skip detail');
  assert.equal(notRunEval.spec.required[0]!.metrics?.skipped, true);
  assert.equal(validateDocument(notRunEval, 'VerificationResult').ok, true);

  // 4) SubmittedCheck.detail propagates on non-passing rows without trustedEvidence, falling back to claim.reason when null/absent
  const claimOnlyDetail = evaluationFixture();
  claimOnlyDetail.input.trusted.eligibleEvidence = [];
  Object.assign(claimOnlyDetail.input.claims[0]!, {
    status: 'failed',
    evidenceId: null,
    reason: 'short reason',
    detail: 'richer submitted check detail',
  });
  assert.equal(value(evaluateAcceptance(claimOnlyDetail.input, claimOnlyDetail.artifacts)).spec.required[0]!.detail, 'richer submitted check detail');

  Object.assign(claimOnlyDetail.input.claims[0]!, { detail: null });
  assert.equal(value(evaluateAcceptance(claimOnlyDetail.input, claimOnlyDetail.artifacts)).spec.required[0]!.detail, 'short reason');

  // 5) verificationSchema rejects metrics and findings on missing_submission / missing_evidence / artifact_* rows
  const missing = evaluationFixture();
  missing.input.claims = [];
  const missingDoc = structuredClone(value(evaluateAcceptance(missing.input, missing.artifacts)));
  const withMetrics = structuredClone(missingDoc);
  Object.assign(withMetrics.spec.required[0]!, { metrics: { speedup: 99 } });
  assert.equal(code(validateDocument(withMetrics, 'VerificationResult')), 'VALUE_RANGE');
  const withFindings = structuredClone(missingDoc);
  Object.assign(withFindings.spec.required[0]!, { findings: [{ title: 'Fake', severity: 'low', evidence: 'x' }] });
  assert.equal(code(validateDocument(withFindings, 'VerificationResult')), 'VALUE_RANGE');
});

test('overlay widening applies only to candidateManifest after TaskLock verification with JSON-string parity and RunResult round-trip', () => {
  // 1) Unverified forged budgets.overlay must NOT widen root snapshot (1025 claims -> LIMIT_COLLECTION, not HASH_MISMATCH)
  const forged = evaluationFixture();
  const forgedLock = structuredClone(forged.input.trusted.expectedLock);
  Object.assign(forgedLock.spec.contract.spec.budgets, { overlay: { maxFiles: 4_096, maxBytes: 67_108_864 } });
  const forgedInput = {
    trusted: { ...forged.input.trusted, expectedLock: forgedLock },
    claims: Array.from({ length: LIMITS.collection + 1 }, (_, i) => ({ checkId: `check-${i}`, status: 'failed', evidenceId: null, reason: 'x' })),
  };
  assert.equal(code(evaluateAcceptance(forgedInput, forged.artifacts)), 'LIMIT_COLLECTION');
  assert.equal(code(evaluateAcceptance(JSON.stringify(forgedInput), forged.artifacts)), 'LIMIT_COLLECTION');

  // 2) Cross-root cycle and alias detection remain enforced across candidateManifest and outer tree
  const cyclic = evaluationFixture();
  Object.assign(cyclic.input.trusted, { candidateManifest: cyclic.input.trusted });
  assert.equal(code(evaluateAcceptance(cyclic.input, cyclic.artifacts)), 'INPUT_CYCLE');

  const aliased = evaluationFixture();
  const sharedClaim = aliased.input.claims[0]!;
  Object.assign(aliased.input.trusted, { candidateManifest: sharedClaim });
  assert.equal(code(evaluateAcceptance(aliased.input, aliased.artifacts)), 'INPUT_ALIAS');

  // 3) JSON-string parity above 1,024 files (1,100 files) using contract budgets.overlay with NO explicit options
  const task1100 = contract();
  Object.assign(task1100.spec.budgets, { overlay: { maxFiles: 2_048, maxBytes: 67_108_864 } });
  const lock1100 = value(admitTask(task1100, { admissionId: 'admission-1', runId: 'run-1' }));
  const names1100 = Array.from({ length: 1_100 }, (_, i) => `packages/f-${String(i).padStart(4, '0')}.ts`).sort();
  const files1100 = names1100.map(name => ({ name, bytes: Buffer.from(`// ${name}\n`) }));
  const manifest1100 = {
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'ArtifactManifest',
    metadata: { id: 'candidate' },
    spec: {
      baseTree: { objectFormat: 'sha256' as const, commitOid: 'a'.repeat(64), treeOid: 'b'.repeat(64) },
      entries: files1100.map(({ name, bytes }) => value(digestArtifact(name, bytes))),
      deleted: [] as string[],
    },
  };
  const logBytes = Buffer.from('1100-file pass\n');
  const subject1100 = value(bindSubject(lock1100, manifest1100));
  const evidence1100 = {
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'Evidence',
    metadata: { id: 'observation-1' },
    spec: {
      checkId: 'tests',
      observedStatus: 'passed',
      producerId: 'host-verifier',
      method: 'node-test',
      level: 'local_execution',
      subject: structuredClone(subject1100),
      artifacts: [value(digestArtifact('test.log', logBytes))],
      reason: null as string | null,
    },
  };
  const claims1100 = [{ checkId: 'tests', status: 'passed', evidenceId: 'observation-1', reason: null }];
  const evalObj1100 = { trusted: { expectedLock: lock1100, candidateManifest: manifest1100, eligibleEvidence: [evidence1100] }, claims: claims1100 };
  const runObj1100 = {
    trusted: { expectedLock: lock1100, candidateManifest: manifest1100, eligibleEvidence: [evidence1100], usage: [], externalEffects: 'none', noChange: null },
    candidate: { status: 'completed', checks: claims1100, memory: { status: 'not_requested', reason: null } },
  };
  const allArtifacts1100 = [...files1100, { name: 'test.log', bytes: logBytes }];

  const evalFromObj = value(evaluateAcceptance(evalObj1100, allArtifacts1100));
  const evalFromStr = value(evaluateAcceptance(JSON.stringify(evalObj1100), allArtifacts1100));
  assert.deepEqual(evalFromStr, evalFromObj);
  assert.equal(validateDocument(evalFromStr, 'VerificationResult').ok, true);

  const runFromObj = value(constructRunResult(runObj1100, allArtifacts1100));
  const runFromStr = value(constructRunResult(JSON.stringify(runObj1100), allArtifacts1100));
  assert.deepEqual(runFromStr, runFromObj);
  assert.equal(validateDocument(runFromStr, 'RunResult').ok, true);

  // 4) Non-manifest eligibleEvidence exceeding default LIMITS.inputBytes is rejected (preventing non-round-trippable RunResult)
  const hugeTask = contract();
  Object.assign(hugeTask.spec.budgets, { overlay: { maxFiles: 2_048, maxBytes: 67_108_864 } });
  hugeTask.spec.acceptance.checks = Array.from({ length: 12 }, (_, i) => ({ id: i === 0 ? 'tests' : `check-${i}`, allowedEvidenceLevels: ['local_execution'] }));
  hugeTask.spec.acceptance.required = hugeTask.spec.acceptance.checks.map(c => c.id);
  const hugeLock = value(admitTask(hugeTask, { admissionId: 'admission-1', runId: 'run-1' }));
  const smallManifest = { apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { entries: [] } };
  const hugeSubject = value(bindSubject(hugeLock, smallManifest));
  const bigFindings = Array.from({ length: LIMITS.findings }, (_, i) => ({
    title: `finding-${i}`, severity: 'low', evidence: 'e'.repeat(LIMITS.findingEvidence),
  }));
  const hugeEvidence = hugeTask.spec.acceptance.required.map((checkId, i) => ({
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'Evidence',
    metadata: { id: `observation-${i}` },
    spec: {
      checkId, observedStatus: 'passed', producerId: 'host-verifier', method: 'node-test', level: 'local_execution',
      subject: structuredClone(hugeSubject), artifacts: [value(digestArtifact('test.log', logBytes))], reason: null,
      findings: structuredClone(bigFindings),
    },
  }));
  const hugeClaims = hugeTask.spec.acceptance.required.map((checkId, i) => ({ checkId, status: 'passed', evidenceId: `observation-${i}`, reason: null }));
  const hugeRunInput = {
    trusted: { expectedLock: hugeLock, candidateManifest: smallManifest, eligibleEvidence: hugeEvidence, usage: [], externalEffects: 'none', noChange: null },
    candidate: { status: 'completed', checks: hugeClaims, memory: { status: 'not_requested', reason: null } },
  };
  assert.equal(code(constructRunResult(hugeRunInput, [{ name: 'test.log', bytes: logBytes }])), 'LIMIT_BYTES');
});

test('evaluateAcceptance and constructRunResult accept VerifiedArtifactDescriptor > 64 MiB, > 128 MiB aggregate, and > 4 GiB while enforcing raw caps and failure codes', () => {
  const eightyMiB = 80 * 1024 * 1024;
  const ninetyMiB = 90 * 1024 * 1024;
  const fiveGiB = 5 * 1024 * 1024 * 1024;
  const makeDigest = (ch: string): Digest => ({ algorithm: 'sha256', hex: ch.repeat(64) });
  const logBytes = Buffer.from('streaming verification pass\n');

  const buildLargeScenario = (descriptors: readonly { readonly name: string; readonly byteLength: number; readonly digest: Digest }[]) => {
    const task = contract();
    Object.assign(task.spec.budgets, { overlay: { maxFiles: 128, maxBytes: OVERLAY_LIMITS.maxMaxBytes } });
    const expectedLock = value(admitTask(task, { admissionId: 'admission-1', runId: 'run-1' }));
    const entries = descriptors.map(d => value(digestArtifactFromMetadata(d.name, { digest: d.digest, byteLength: d.byteLength })));
    const candidateManifest = {
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'ArtifactManifest',
      metadata: { id: 'candidate' },
      spec: {
        baseTree: { objectFormat: 'sha256' as const, commitOid: 'a'.repeat(64), treeOid: 'b'.repeat(64) },
        entries,
        deleted: [] as string[],
      },
    };
    const subject = value(bindSubject(expectedLock, candidateManifest));
    const evidence = {
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'Evidence',
      metadata: { id: 'observation-1' },
      spec: {
        checkId: 'tests',
        observedStatus: 'passed',
        producerId: 'host-verifier',
        method: 'node-test',
        level: 'local_execution',
        subject: structuredClone(subject),
        artifacts: [value(digestArtifact('test.log', logBytes))],
        reason: null as string | null,
      },
    };
    const claims = [{ checkId: 'tests', status: 'passed', evidenceId: 'observation-1', reason: null }];
    return {
      expectedDigest: value(identifyManifest(candidateManifest)).digest.hex,
      evalInput: { trusted: { expectedLock, candidateManifest, eligibleEvidence: [evidence] }, claims },
      runInput: {
        trusted: { expectedLock, candidateManifest, eligibleEvidence: [evidence], usage: [], externalEffects: 'none', noChange: null },
        candidate: { status: 'completed', checks: claims, memory: { status: 'not_requested', reason: null } },
      },
      artifacts: [...descriptors, { name: 'test.log', bytes: logBytes }] satisfies readonly ResolvedArtifactInput[],
    };
  };

  for (const descriptors of [
    [{ name: 'packages/large-80m.bin', byteLength: eightyMiB, digest: makeDigest('1') }],
    [
      { name: 'packages/part-a.bin', byteLength: ninetyMiB, digest: makeDigest('2') },
      { name: 'packages/part-b.bin', byteLength: ninetyMiB, digest: makeDigest('3') },
    ],
    [{ name: 'packages/model-5g.bin', byteLength: fiveGiB, digest: makeDigest('4') }],
  ]) {
    const scenario = buildLargeScenario(descriptors);
    const evaluated = value(evaluateAcceptance(scenario.evalInput, scenario.artifacts));
    assert.equal(evaluated.spec.satisfied, true);
    assert.equal(evaluated.spec.subject.candidateDigest.hex, scenario.expectedDigest);
    assert.equal(validateDocument(evaluated, 'VerificationResult').ok, true);

    const run = value(constructRunResult(scenario.runInput, scenario.artifacts));
    assert.equal(run.spec.status, 'completed');
    assert.equal(run.spec.subject.candidateDigest.hex, scenario.expectedDigest);
    assert.equal(validateDocument(run, 'RunResult').ok, true);
  }

  // Mismatch, duplicate, ambiguous descriptor, and raw buffer cap refusals
  const base = buildLargeScenario([{ name: 'packages/model-5g.bin', byteLength: fiveGiB, digest: makeDigest('5') }]);
  const badDigest = value(evaluateAcceptance(base.evalInput, [
    { name: 'packages/model-5g.bin', byteLength: fiveGiB, digest: makeDigest('6') },
    { name: 'test.log', bytes: logBytes },
  ]));
  assert.equal(badDigest.spec.satisfied, false);
  assert.equal(badDigest.spec.diagnostics[0]!.code, 'ARTIFACT_DIGEST_MISMATCH');

  const badLength = value(evaluateAcceptance(base.evalInput, [
    { name: 'packages/model-5g.bin', byteLength: fiveGiB - 1, digest: makeDigest('5') },
    { name: 'test.log', bytes: logBytes },
  ]));
  assert.equal(badLength.spec.satisfied, false);
  assert.equal(badLength.spec.diagnostics[0]!.code, 'ARTIFACT_LENGTH_MISMATCH');

  assert.equal(code(evaluateAcceptance(base.evalInput, [
    { name: 'packages/model-5g.bin', byteLength: fiveGiB, digest: makeDigest('5') },
    { name: 'packages/model-5g.bin', byteLength: fiveGiB, digest: makeDigest('5') },
    { name: 'test.log', bytes: logBytes },
  ])), 'ARTIFACT_DUPLICATE');

  assert.equal(code(evaluateAcceptance(base.evalInput, [
    { name: 'packages/model-5g.bin', bytes: new Uint8Array(1), byteLength: fiveGiB, digest: makeDigest('5') } as unknown as ResolvedArtifactInput,
    { name: 'test.log', bytes: logBytes },
  ])), 'INPUT_UNSUPPORTED');

  // Raw Uint8Array still fails closed above 64 MiB single file and 128 MiB aggregate
  assert.equal(code(evaluateAcceptance(base.evalInput, [{ name: 'raw-big.bin', bytes: new Uint8Array(LIMITS.artifactBytes + 1) }])), 'LIMIT_ARTIFACT_BYTES');
  const raw64 = new Uint8Array(LIMITS.artifactBytes);
  assert.equal(code(constructRunResult(base.runInput, [
    { name: 'r1.bin', bytes: raw64 },
    { name: 'r2.bin', bytes: raw64 },
    { name: 'r3.bin', bytes: new Uint8Array(1) },
  ])), 'LIMIT_RESOLVED_BYTES');
});
