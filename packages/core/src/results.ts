import { snapshot, type Json } from './boundary.js';
import { arrayOf, document, enumeration, identifier, nullable, record, text, type Infer } from './contracts.js';
import { attempt, fail, type Result } from './diagnostics.js';
import { manifestSchema, type ResolvedArtifact } from './artifacts.js';
import { evaluateValidated, verificationSchema } from './acceptance.js';
import { claimSchema, evidenceSchema, type Evidence } from './evidence.js';
import { lockSchema, matchSubject, subjectSchema } from './identity.js';
import { LIMITS } from './limits.js';
import { requestsSchema, summarizeRequests, usageSummarySchema } from './usage.js';

const runStatusSchema = enumeration('completed', 'no_change', 'blocked', 'exhausted', 'expired', 'cancelled', 'failed', 'reconcile_required');
export type RunStatus = Infer<typeof runStatusSchema>;
const effectsSchema = enumeration('none', 'confirmed', 'unknown');
const noChangeSchema = record({ checkId: identifier, evidenceId: identifier, reason: enumeration('candidate_equals_source', 'no_applicable_update') });
export type NoChangeVerification = Infer<typeof noChangeSchema>;
const memoryShape = record({ status: enumeration('not_requested', 'pending', 'proposed', 'unavailable'), reason: nullable(text()) });
export type MemoryObservation = Infer<typeof memoryShape>;
function memorySchema(value: Json, path: string): MemoryObservation {
  const memory = memoryShape(value, path);
  if ((memory.status === 'pending' || memory.status === 'unavailable') && memory.reason === null) fail('VALUE_RANGE', `${path}/reason`);
  return memory;
}
const draftSchema = record({
  trusted: record({ expectedLock: lockSchema, candidateManifest: manifestSchema,
    eligibleEvidence: arrayOf(evidenceSchema, 0, LIMITS.evidence), usage: requestsSchema,
    externalEffects: effectsSchema, noChange: nullable(noChangeSchema) }),
  candidate: record({ status: runStatusSchema, checks: arrayOf(claimSchema, 0, LIMITS.checks), memory: memorySchema }),
});
const runShape = document('RunResult', record({ status: runStatusSchema, subject: subjectSchema,
  verification: verificationSchema, usage: usageSummarySchema, externalEffects: effectsSchema,
  noChange: nullable(noChangeSchema), memory: memorySchema }));
export type RunResult = Infer<typeof runShape>;

function consistentStatus(status: RunStatus, effects: RunResult['spec']['externalEffects'],
  noChange: NoChangeVerification | null, verification: RunResult['spec']['verification'], path: string,
  eligibleEvidence: readonly Evidence[] | null): void {
  if (effects === 'unknown' && status !== 'reconcile_required') fail('RUN_RECONCILIATION_REQUIRED', path);
  if (status === 'no_change') {
    const row = noChange === null ? undefined : verification.spec.required.find(row => row.checkId === noChange.checkId);
    if (noChange === null || !row || row.status !== 'passed' || row.evidenceId !== noChange.evidenceId) fail('RUN_NO_CHANGE_REQUIRED', path);
    // Serialized shape validation has no eligible-observation authority. Trusted
    // construction always supplies this inventory and checks the method here.
    if (eligibleEvidence !== null) {
      const proof = eligibleEvidence.find(evidence => evidence.metadata.id === noChange.evidenceId);
      if (!proof || proof.spec.checkId !== noChange.checkId || proof.spec.method !== 'verify_no_change') fail('RUN_NO_CHANGE_REQUIRED', '/trusted/noChange');
    }
  } else if (noChange !== null) fail('RUN_NO_CHANGE_REQUIRED', path);
  if ((status === 'completed' || status === 'no_change') && !verification.spec.satisfied) fail('RUN_ACCEPTANCE_REQUIRED', path);
}
export function runSchema(input: Json, path = ''): RunResult {
  const run = runShape(input, path), spec = run.spec;
  matchSubject(spec.subject, spec.verification.spec.subject, `${path}/spec/verification/spec/subject`);
  consistentStatus(spec.status, spec.externalEffects, spec.noChange, spec.verification, `${path}/spec/status`, null);
  return run;
}
export function constructRunResult(input: unknown, artifacts: readonly ResolvedArtifact[]): Result<RunResult> {
  return attempt(() => {
    const draft = draftSchema(snapshot(input), '');
    const usage = summarizeRequests(draft.trusted.usage, '/trusted/usage');
    // Evaluate current trusted inputs, never a serialized matrix or type brand.
    const verification = evaluateValidated({ trusted: draft.trusted, claims: draft.candidate.checks }, artifacts, '/candidate/checks');
    const { status, memory } = draft.candidate;
    const { externalEffects, noChange } = draft.trusted;
    consistentStatus(status, externalEffects, noChange, verification, '/candidate/status', draft.trusted.eligibleEvidence);
    return { apiVersion: 'loopwright.dev/v1alpha1', kind: 'RunResult', metadata: { id: draft.trusted.expectedLock.spec.runId },
      spec: { status, subject: structuredClone(verification.spec.subject), verification, usage, externalEffects, noChange, memory } };
  });
}
