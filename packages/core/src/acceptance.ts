import { overlaySnapshotBounds, snapshotWithDeferredManifest, type Json, type SnapshotBounds } from './boundary.js';
import {
  arrayOf, boolean, checkStatus, document, enumeration, findingsSchema, identifier,
  metricsSchema, nullable, object, optional, record, resolveOverlayOptions, text,
  type Infer, type MetricsMap, type MetricValue, type StructuredFinding,
} from './contracts.js';
import { DIAGNOSTIC_CODES, attempt, fail, type Diagnostic, type Result } from './diagnostics.js';
import { artifactIssue, manifestSchema, resolveInventory, type ArtifactIssue, type ArtifactManifest, type ResolvedArtifactInput } from './artifacts.js';
import { claimSchema, evidenceSchema, type Evidence, type SubmittedCheck } from './evidence.js';
import { unique } from './graph.js';
import { deriveSubject, lockSchema, matchSubject, subjectSchema, type TaskLock } from './identity.js';
import { LIMITS, type OverlayLimitOptions, type OverlayLimits } from './limits.js';

export interface EvaluationInput {
  readonly trusted: {
    readonly expectedLock: TaskLock;
    readonly candidateManifest: ArtifactManifest;
    readonly eligibleEvidence: readonly Evidence[];
  };
  readonly claims: readonly SubmittedCheck[];
}

function parseEvaluationTrusted(
  value: Json,
  path: string,
  resolveManifest: (bounds?: SnapshotBounds) => Json,
  explicitOverlay?: OverlayLimits,
): EvaluationInput['trusted'] {
  const input = object(value, path);
  for (const key of ['expectedLock', 'candidateManifest', 'eligibleEvidence'] as const) {
    if (!Object.hasOwn(input, key)) fail('FIELD_REQUIRED', `${path}/${key}`);
  }
  for (const key of Object.keys(input).sort()) {
    if (key !== 'expectedLock' && key !== 'candidateManifest' && key !== 'eligibleEvidence') fail('FIELD_UNKNOWN', path);
  }
  const expectedLock = lockSchema(input.expectedLock!, `${path}/expectedLock`);
  const effectiveOverlay = explicitOverlay ?? expectedLock.spec.contract.spec.budgets.overlay;
  const manifestJson = resolveManifest(overlaySnapshotBounds(effectiveOverlay?.maxFiles));
  const candidateManifest = manifestSchema(manifestJson, `${path}/candidateManifest`, effectiveOverlay?.maxFiles);
  const eligibleEvidence = arrayOf(evidenceSchema, 0, LIMITS.evidence)(input.eligibleEvidence!, `${path}/eligibleEvidence`);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  output.expectedLock = expectedLock;
  output.candidateManifest = candidateManifest;
  output.eligibleEvidence = eligibleEvidence;
  return output as unknown as EvaluationInput['trusted'];
}

function parseEvaluationInput(
  value: Json,
  path: string,
  resolveManifest: (bounds?: SnapshotBounds) => Json,
  explicitOverlay?: OverlayLimits,
): EvaluationInput {
  return record({
    trusted: (trustedValue: Json, trustedPath: string) => parseEvaluationTrusted(trustedValue, trustedPath, resolveManifest, explicitOverlay),
    claims: arrayOf(claimSchema, 0, LIMITS.checks),
  })(value, path);
}
export const diagnosticSchema = record({ code: enumeration(...DIAGNOSTIC_CODES), path: text(0, LIMITS.path), checkId: nullable(identifier) });
const reasonSchema = enumeration('observed_pass', 'submitted_failed', 'submitted_blocked', 'submitted_not_run',
  'missing_submission', 'missing_evidence', 'evidence_level_disallowed', 'artifact_missing', 'artifact_length_mismatch', 'artifact_digest_mismatch');
const rowSchema = record({
  checkId: identifier, status: checkStatus, evidenceId: nullable(identifier), reason: reasonSchema, detail: nullable(text()),
  metrics: optional(metricsSchema),
  findings: optional(findingsSchema),
});
export type EvaluatedCheck = Infer<typeof rowSchema>;
const verificationShape = document('VerificationResult', record({ subject: subjectSchema,
  required: arrayOf(rowSchema, 1, LIMITS.checks), optional: arrayOf(rowSchema, 0, LIMITS.checks),
  satisfied: boolean, diagnostics: arrayOf(diagnosticSchema),
}));
export type VerificationResult = Infer<typeof verificationShape>;

function cloneMetrics(metrics: MetricsMap): MetricsMap {
  const copy: Record<string, MetricValue> = Object.create(null) as Record<string, MetricValue>;
  for (const key of Object.keys(metrics).sort()) copy[key] = metrics[key]!;
  return copy;
}

function cloneFindings(findings: readonly StructuredFinding[]): readonly StructuredFinding[] {
  return findings.map(finding => {
    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    copy.title = finding.title;
    copy.severity = finding.severity;
    if (Object.hasOwn(finding, 'path')) copy.path = finding.path;
    if (Object.hasOwn(finding, 'line')) copy.line = finding.line;
    copy.evidence = finding.evidence;
    return copy as StructuredFinding;
  });
}

function withMetadata(
  base: {
    readonly checkId: string;
    readonly status: EvaluatedCheck['status'];
    readonly evidenceId: string | null;
    readonly reason: EvaluatedCheck['reason'];
    readonly detail: string | null;
  },
  metrics: MetricsMap | undefined,
  findings: readonly StructuredFinding[] | undefined,
): EvaluatedCheck {
  if (metrics === undefined && findings === undefined) return base;
  return {
    ...base,
    ...(metrics !== undefined ? { metrics: cloneMetrics(metrics) } : {}),
    ...(findings !== undefined ? { findings: cloneFindings(findings) } : {}),
  };
}

export function verificationSchema(input: Json, path = ''): VerificationResult {
  const result = verificationShape(input, path), spec = result.spec;
  const rows = [...spec.required, ...spec.optional];
  if (rows.length > LIMITS.checks) fail('VALUE_RANGE', `${path}/spec/required`);
  const ids = new Set<string>();
  rows.forEach((row, index) => {
    if (ids.has(row.checkId)) {
      const collection = index < spec.required.length ? 'required' : 'optional';
      const localIndex = index < spec.required.length ? index : index - spec.required.length;
      fail('DUPLICATE_ID', `${path}/spec/${collection}/${localIndex}`);
    }
    ids.add(row.checkId);
  });
  if (spec.satisfied !== spec.required.every(row => row.status === 'passed')) fail('VALUE_ENUM', `${path}/spec/satisfied`);
  for (const [index, row] of rows.entries()) {
    const location = `${path}/spec/${index < spec.required.length ? 'required' : 'optional'}/${index < spec.required.length ? index : index - spec.required.length}`;
    if (row.status === 'passed' && (row.reason !== 'observed_pass' || row.evidenceId === null)) fail('VALUE_ENUM', location);
    if (row.status === 'failed' && row.reason !== 'submitted_failed') fail('VALUE_ENUM', location);
    if (row.status === 'not_run' && (row.evidenceId !== null || !['missing_submission', 'submitted_not_run'].includes(row.reason))) fail('VALUE_ENUM', location);
    if (row.status === 'blocked' && !['submitted_blocked', 'missing_evidence', 'evidence_level_disallowed', 'artifact_missing', 'artifact_length_mismatch', 'artifact_digest_mismatch'].includes(row.reason)) fail('VALUE_ENUM', location);
    if (row.reason.startsWith('submitted_') && row.detail === null) fail('VALUE_RANGE', `${location}/detail`);
    if (!row.reason.startsWith('submitted_') && row.reason !== 'observed_pass') {
      if (row.detail !== null) fail('VALUE_RANGE', `${location}/detail`);
      if (row.metrics !== undefined) fail('VALUE_RANGE', `${location}/metrics`);
      if (row.findings !== undefined) fail('VALUE_RANGE', `${location}/findings`);
    }
  }
  spec.diagnostics.forEach((diagnostic, index) => {
    if (diagnostic.checkId !== null && !ids.has(diagnostic.checkId)) fail('REFERENCE_UNKNOWN', `${path}/spec/diagnostics/${index}/checkId`);
  });
  return result;
}
export function evaluateValidated(
  input: EvaluationInput,
  artifacts: readonly ResolvedArtifactInput[],
  claimsPath: string,
  options?: OverlayLimitOptions,
): VerificationResult {
  const { expectedLock: lock, candidateManifest: manifest, eligibleEvidence } = input.trusted;
  const effectiveOverlay = resolveOverlayOptions(options) ?? lock.spec.contract.spec.budgets.overlay;
  const subject = deriveSubject(lock, manifest), acceptance = lock.spec.contract.spec.acceptance;
  const requirements = new Map(acceptance.checks.map(check => [check.id, check]));
  unique(input.claims.map(claim => claim.checkId), claimsPath);
  const claims = new Map(input.claims.map(claim => [claim.checkId, claim]));
  const evidenceById = new Map<string, typeof eligibleEvidence[number]>();
  const evidenceByCheck = new Map<string, typeof eligibleEvidence[number]>();
  eligibleEvidence.forEach((evidence, index) => {
    const path = `/trusted/eligibleEvidence/${index}`, observation = evidence.spec;
    const checkId = requirements.has(observation.checkId) ? observation.checkId : null;
    if (evidenceById.has(evidence.metadata.id)) fail('EVIDENCE_DUPLICATE', `${path}/metadata/id`, checkId);
    const previous = evidenceByCheck.get(observation.checkId);
    if (previous) fail(previous.spec.observedStatus === observation.observedStatus ? 'EVIDENCE_DUPLICATE' : 'EVIDENCE_CONTRADICTORY', `${path}/spec/checkId`, checkId);
    evidenceById.set(evidence.metadata.id, evidence); evidenceByCheck.set(observation.checkId, evidence);
  });
  // Complete each validation phase before advancing to the next observation phase.
  input.claims.forEach((claim, index) => {
    if (!requirements.has(claim.checkId)) fail('REFERENCE_UNKNOWN', `${claimsPath}/${index}/checkId`);
  });
  eligibleEvidence.forEach((evidence, index) => {
    if (!requirements.has(evidence.spec.checkId)) fail('REFERENCE_UNKNOWN', `/trusted/eligibleEvidence/${index}/spec/checkId`);
  });
  eligibleEvidence.forEach((evidence, index) => {
    matchSubject(subject, evidence.spec.subject, `/trusted/eligibleEvidence/${index}/spec/subject`, evidence.spec.checkId);
  });
  input.claims.forEach((claim, index) => {
    const sameCheck = evidenceByCheck.get(claim.checkId);
    if (sameCheck && sameCheck.spec.observedStatus !== claim.status) fail('EVIDENCE_CONTRADICTORY', `${claimsPath}/${index}/status`, claim.checkId);
    const evidence = claim.evidenceId === null ? undefined : evidenceById.get(claim.evidenceId);
    if (claim.evidenceId !== null && !evidence && claim.status !== 'passed') fail('REFERENCE_UNKNOWN', `${claimsPath}/${index}/evidenceId`, claim.checkId);
    if (evidence && (evidence.spec.checkId !== claim.checkId || evidence.spec.observedStatus !== claim.status)) fail('EVIDENCE_CONTRADICTORY', `${claimsPath}/${index}/evidenceId`, claim.checkId);
  });
  const inventory = resolveInventory(artifacts, effectiveOverlay ? { overlay: effectiveOverlay } : undefined);
  const candidateIssue = artifactIssue(manifest.spec.entries, inventory, '/trusted/candidateManifest/spec/entries');
  const issues = new Map(eligibleEvidence.map((evidence, index) => [evidence.metadata.id,
    artifactIssue(evidence.spec.artifacts, inventory, `/trusted/eligibleEvidence/${index}/spec/artifacts`)]));
  const diagnostics: Diagnostic[] = [];
  const row = (checkId: string): EvaluatedCheck => {
    const claim = claims.get(checkId);
    if (!claim) {
      diagnostics.push({ code: 'CHECK_MISSING', path: claimsPath, checkId });
      return { checkId, status: 'not_run', evidenceId: null, reason: 'missing_submission', detail: null };
    }
    const evidence = claim.evidenceId === null ? undefined : evidenceById.get(claim.evidenceId);
    const trustedEvidence = evidence ?? evidenceByCheck.get(checkId);
    if (claim.status !== 'passed') {
      const reasons = { failed: 'submitted_failed', blocked: 'submitted_blocked', not_run: 'submitted_not_run' } as const;
      if (trustedEvidence) {
        const trustedIssue = issues.get(trustedEvidence.metadata.id) ?? null;
        if (trustedIssue) diagnostics.push({ ...trustedIssue, checkId });
        return withMetadata(
          {
            checkId,
            status: claim.status,
            evidenceId: claim.status === 'not_run' ? null : trustedEvidence.metadata.id,
            reason: reasons[claim.status],
            detail: trustedEvidence.spec.detail ?? trustedEvidence.spec.reason,
          },
          trustedEvidence.spec.metrics,
          trustedEvidence.spec.findings,
        );
      }
      return withMetadata(
        {
          checkId,
          status: claim.status,
          evidenceId: claim.evidenceId,
          reason: reasons[claim.status],
          detail: claim.detail ?? claim.reason,
        },
        claim.metrics,
        claim.findings,
      );
    }
    const issue = evidence ? issues.get(evidence.metadata.id) ?? null : null;
    const blocked = (code: Diagnostic['code'], reason: EvaluatedCheck['reason'], path: string): EvaluatedCheck => {
      diagnostics.push({ code, path, checkId });
      return { checkId, status: 'blocked', evidenceId: claim.evidenceId, reason, detail: null };
    };
    if (!evidence) return blocked('EVIDENCE_MISSING', 'missing_evidence', claimsPath);
    if (!requirements.get(checkId)!.allowedEvidenceLevels.includes(evidence.spec.level)) return blocked('EVIDENCE_LEVEL_DISALLOWED', 'evidence_level_disallowed', claimsPath);
    const invalidArtifact: ArtifactIssue | null = candidateIssue ?? issue;
    if (invalidArtifact) {
      const reasons = { ARTIFACT_MISSING: 'artifact_missing', ARTIFACT_LENGTH_MISMATCH: 'artifact_length_mismatch', ARTIFACT_DIGEST_MISMATCH: 'artifact_digest_mismatch' } as const;
      return blocked(invalidArtifact.code, reasons[invalidArtifact.code], invalidArtifact.path);
    }
    return withMetadata(
      { checkId, status: 'passed', evidenceId: evidence.metadata.id, reason: 'observed_pass', detail: evidence.spec.detail ?? null },
      evidence.spec.metrics,
      evidence.spec.findings,
    );
  };
  const requiredSet = new Set(acceptance.required);
  const required = acceptance.required.map(row);
  const optional = acceptance.checks.filter(check => !requiredSet.has(check.id) && claims.has(check.id)).map(check => row(check.id));
  return { apiVersion: 'loopwright.dev/v1alpha1', kind: 'VerificationResult', metadata: { id: lock.metadata.id },
    spec: { subject, required, optional, satisfied: required.every(check => check.status === 'passed'), diagnostics } };
}
export function evaluateAcceptance(
  input: unknown,
  artifacts: readonly ResolvedArtifactInput[],
  options?: OverlayLimitOptions,
): Result<VerificationResult> {
  return attempt(() => {
    const explicitOverlay = resolveOverlayOptions(options);
    const deferred = snapshotWithDeferredManifest(input);
    const parsed = parseEvaluationInput(deferred.root, '', deferred.resolveManifest, explicitOverlay);
    return evaluateValidated(parsed, artifacts, '/claims', explicitOverlay ? { overlay: explicitOverlay } : undefined);
  });
}
