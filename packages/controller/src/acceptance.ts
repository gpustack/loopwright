import { bindSubject, evaluateAcceptance, constructRunResult, type ArtifactManifest, type Evidence, type RequestUsage, type ResolvedArtifact, type RunResult, type RunStatus, type SubmittedCheck, type TaskLock, type VerificationResult } from '@loopwright/core';
import type { LocalRunStore } from '@loopwright/state';
import { authenticatedCheck, authenticatedRefusal, type PreflightRefusal, type VerifiedCheck } from './verification.js';
import { journal } from './progress.js';
import { canonical, freeze, hash, same } from './schema.js';
import { refuse } from './errors.js';
import type { ControllerDiagnostic } from './errors.js';
import type { CompiledPlan } from './types.js';
import type { Submission } from './submission.js';
export interface AcceptanceObservation {
  readonly result: RunResult; readonly verification: VerificationResult; readonly requestedStatus: Submission['status'] | null; readonly diagnostic: ControllerDiagnostic['code'] | null;
  readonly preflightRefusals: readonly { readonly origin: 'controller_preflight'; readonly slotId: string; readonly checkId: string; readonly generation: number; readonly code: 'OUTPUT_LIMIT'; readonly record: import('@loopwright/core').ArtifactRef; readonly limits: import('./refusal-record.js').SizingDescription }[];
  readonly selectedNoChangeCheck: string | null; readonly contradictions: readonly string[];
  readonly verifierMatrix: readonly { readonly slotId: string; readonly checkId: string; readonly status: 'passed' | 'failed' | 'blocked' | 'not_run'; readonly reason: string | null; readonly implicit: 'scope' | 'no_change' | null }[];
}
/** Core inputs are JSON-owned here so shared immutable source refs cannot create input aliases. */
const tree = (input: unknown): unknown => JSON.parse(canonical(input));
export function evaluateControllerAcceptance(plan: CompiledPlan, lock: TaskLock, candidate: ArtifactManifest, candidateFiles: readonly ResolvedArtifact[], generation: number,
  checks: readonly VerifiedCheck[], submission: Submission | null, store: LocalRunStore, forced: 'reconcile_required' | 'expired' | 'cancelled' | 'exhausted' | 'blocked' | 'failed' | null = null, graphComplete = true, refusals: readonly PreflightRefusal[] = [], forcedDiagnostic: ControllerDiagnostic['code'] | null = null): AcceptanceObservation {
  if (!same(plan.task, lock.spec.contract)) refuse('ARTIFACT_INVALID', '', 'verification');
  const bound = bindSubject(lock, candidate); if (!bound.ok) refuse('ARTIFACT_INVALID', '', 'verification'); const subject = bound.value, records = journal(store);
  const eligible: Evidence[] = [], artifacts: ResolvedArtifact[] = [...candidateFiles], bySlot = new Map<string, VerifiedCheck>();
  for (const checked of checks) {
    const original = authenticatedCheck(checked), slot = plan.verifierSlots.find(slot => slot.id === checked.slotId), operation = records.operations.find(item => item.intent.operationId === checked.operationId);
    if (!slot || bySlot.has(slot.id) || checked.generation !== generation || checked.checkId !== slot.checkId || !same(original.subject, subject) || !same(original.evidence.spec.subject, subject)
      || original.evidence.spec.observedStatus !== checked.status || original.evidence.spec.checkId !== slot.checkId || original.evidence.spec.producerId !== 'loopwright.byte-verifier.v1'
      || !same(original.planDigest, plan.planDigest) || !same(original.header.handlerDigest, slot.handler.digest) || original.header.handler !== slot.handler.implementation
      || !same(original.header.candidate.ref.digest, hash(canonical(candidate))) || original.header.candidate.ref.byteLength !== Buffer.byteLength(canonical(candidate))
      || !operation || operation.state !== 'confirmed' || !same(operation.intent.requestDigest, original.requestDigest) || !same(operation.reconciliation ?? operation.initialReceipt, original.receipt) || !same(original.receipt.evidence.artifact, checked.output)) refuse('EVIDENCE_UNAVAILABLE', '', 'verification');
    bySlot.set(slot.id, checked); artifacts.push({ name: checked.output.name, bytes: original.outputBytes }); if (slot.implicit === null) eligible.push(original.evidence);
  }
  const negativeBySlot = new Map<string, PreflightRefusal>();
  const negativeObservations: AcceptanceObservation['preflightRefusals'][number][] = [];
  for (const refusal of refusals) {
    const original = authenticatedRefusal(refusal), slot = plan.verifierSlots.find(slot => slot.id === refusal.slotId), operation = store.getOperation(refusal.prospectiveOperationId);
    if (!slot || bySlot.has(slot.id) || negativeBySlot.has(slot.id) || refusal.status !== 'blocked' || refusal.generation !== generation || refusal.checkId !== slot.checkId || original.storeId !== records.view.storeId
      || !same(original.clockBasis, records.view.clock.basis) || !same(original.value.subject, subject) || !same(original.value.planDigest, plan.planDigest) || !same(original.value.handlerDigest, slot.handler.digest)
      || original.value.generation !== generation || original.value.prospectiveOperationId !== refusal.prospectiveOperationId || original.value.producerNonce !== refusal.producerNonce || !same(original.row.record, refusal.record)
      || original.value.candidate.ref.byteLength !== Buffer.byteLength(canonical(candidate)) || !same(original.value.candidate.ref.digest, hash(canonical(candidate))) || operation.ok || operation.error.code !== 'RECORD_NOT_FOUND') refuse('EVIDENCE_UNAVAILABLE', '', 'verification');
    negativeBySlot.set(slot.id, refusal); negativeObservations.push({ origin: 'controller_preflight', slotId: slot.id, checkId: slot.checkId, generation, code: 'OUTPUT_LIMIT', record: refusal.record, limits: original.value.limits });
  }
  const matrix = plan.verifierSlots.map(slot => { const value = bySlot.get(slot.id) ?? negativeBySlot.get(slot.id); return { slotId: slot.id, checkId: slot.checkId, status: value?.status ?? 'not_run' as const, reason: value?.reason ?? (value ? null : 'verifier_not_run'), implicit: slot.implicit }; });
  const claims: SubmittedCheck[] = plan.task.spec.acceptance.checks.map(check => {
    const slot = plan.verifierSlots.find(slot => slot.implicit === null && slot.checkId === check.id)!, verified = bySlot.get(slot.id);
    const negative = negativeBySlot.get(slot.id); if (negative) return { checkId: check.id, status: 'blocked', evidenceId: null, reason: negative.reason };
    if (!verified) return { checkId: check.id, status: 'not_run', evidenceId: null, reason: 'verifier_not_run' };
    const evidence = authenticatedCheck(verified).evidence; return { checkId: check.id, status: verified.status, evidenceId: evidence.metadata.id, reason: verified.reason };
  });
  const contradictions = (submission?.checks ?? []).filter(claim => claim.status === 'passed' && claims.some(actual => actual.checkId === claim.checkId && actual.status === 'failed')).map(claim => claim.checkId);
  const input = { trusted: { expectedLock: lock, candidateManifest: candidate, eligibleEvidence: eligible }, claims }, evaluated = evaluateAcceptance(tree(input), artifacts);
  if (!evaluated.ok) refuse('RECOVERY_REQUIRED', '', 'verification');
  const selected = [...plan.task.spec.acceptance.required].sort().find(id => plan.task.spec.acceptance.checks.find(check => check.id === id)!.allowedEvidenceLevels.includes('local_execution')
    && plan.verifierSlots.some(slot => slot.implicit === null && slot.checkId === id && slot.handler.implementation === 'no-change.v1')) ?? null;
  if (selected !== plan.noChangeEligibility.checkId) refuse('RECOVERY_REQUIRED', '', 'verification');
  const selectedSlot = plan.verifierSlots.find(slot => slot.implicit === null && slot.checkId === selected), proof = selectedSlot ? bySlot.get(selectedSlot.id) : undefined;
  const scope = matrix.find(row => row.implicit === 'scope')!, equality = matrix.find(row => row.implicit === 'no_change')!;
  const noChangeProof = proof && proof.status === 'passed' && authenticatedCheck(proof).evidence.spec.method === 'verify_no_change' ? authenticatedCheck(proof).evidence : null;
  const missingNoChange = submission?.status === 'no_change' && (selected === null || noChangeProof === null || equality.status !== 'passed');
  const unknown = records.view.clockStatus !== 'trusted' || records.view.counts.dispatchedRequests || records.view.counts.unresolvedRequests || records.view.counts.unresolvedOperations || records.view.ledger.violations.length;
  let status: RunStatus;
  if (unknown) status = 'reconcile_required';
  else if (BigInt(records.view.clock.sampledNow.monotonicMs) >= BigInt(records.view.clock.basis.taskDeadlineMonotonicMs)) status = 'expired';
  else if (forced) status = forced;
  else if (evaluated.value.spec.required.some(row => row.status === 'failed') || scope.status === 'failed' || submission?.status === 'failed' || submission?.status === 'no_change' && equality.status === 'failed') status = 'failed';
  else if (!graphComplete || !evaluated.value.spec.satisfied || scope.status !== 'passed' || missingNoChange || submission?.status === 'blocked') status = 'blocked';
  else status = submission?.status ?? 'blocked';
  const usage: RequestUsage[] = [];
  for (const item of records.requests) {
    if (item.dispatch === null && (item.state === 'released' || item.state === 'reserved')) continue;
    const observed = item.resolution?.kind === 'terminal_usage' ? item.resolution.observation : item.initialObservation;
    usage.push(observed?.usage ?? { requestId: item.admission.requestId, inputTokens: { provenance: 'unknown' }, outputTokens: { provenance: 'unknown' }, costMicrousd: { provenance: 'unknown' } });
  }
  const external = records.operations.filter(item => item.intent.effect === 'external_write'), externalEffects = external.some(item => item.state === 'dispatch_uncertain' || item.state === 'unresolved' || (item.reconciliation ?? item.initialReceipt)?.outcome === 'failed') ? 'unknown'
    : external.some(item => item.state === 'confirmed' && (item.reconciliation ?? item.initialReceipt)?.outcome === 'succeeded') ? 'confirmed' : 'none';
  if (externalEffects === 'unknown') status = 'reconcile_required';
  const draft = { trusted: { ...input.trusted, usage, externalEffects, noChange: status === 'no_change' ? { checkId: selected!, evidenceId: noChangeProof!.metadata.id, reason: 'candidate_equals_source' } : null },
    candidate: { status, checks: claims, memory: { status: 'not_requested', reason: null } } };
  const result = constructRunResult(tree(draft), artifacts); if (!result.ok) refuse('RECOVERY_REQUIRED', '', 'verification');
  return freeze({ result: result.value, verification: evaluated.value, requestedStatus: submission?.status ?? null, diagnostic: forcedDiagnostic ?? (missingNoChange ? 'EVIDENCE_UNAVAILABLE' : null), selectedNoChangeCheck: selected, contradictions, verifierMatrix: matrix, preflightRefusals: negativeObservations });
}
