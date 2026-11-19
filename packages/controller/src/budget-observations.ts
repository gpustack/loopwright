import { bindSubject, type ArtifactRef, type TaskLock } from '@loopwright/core';
import type { Authority, LocalRunStore, RunView } from '@loopwright/state';
import type { PiErrorV2 } from '@loopwright/agent-pi';
import { descriptor, fileHash, ownedBytes } from './verifier-protocol.js';
import { canonical, record, same } from './schema.js';
import { journal } from './progress.js';
import { refuse, type ControllerDiagnostic } from './errors.js';
import { parsePrivateJson } from './parser.js';
import type { ArtifactStore } from './storage.js';
import type { ByteInventory } from './verification.js';
import type { CompiledPlan, ControllerProgress } from './types.js';

export function countDelegatedBudgets(plan: CompiledPlan, attempts: ControllerProgress['attempts']): {
  readonly modelCalls: number;
  readonly formatRepairs: number;
  readonly implementationRepairs: number;
} {
  const isDelegated = (nodeId: string): boolean => {
    const node = plan.orderedDAG.find(item => item.id === nodeId);
    const role = node?.roleId ? plan.roles.find(item => item.roleId === node.roleId) : undefined;
    return role?.adapter === 'delegated';
  };
  let modelCalls = 0, formatRepairs = 0, implementationRepairs = 0;
  for (const attempt of attempts) {
    if (!isDelegated(attempt.nodeId)) continue;
    if (attempt.purpose !== 'compaction') modelCalls++;
    if (attempt.repair === 'format') formatRepairs++;
    if (attempt.repair === 'implementation') implementationRepairs++;
  }
  return { modelCalls, formatRepairs, implementationRepairs };
}

/** Returns true when store state has a trusted clock and zero unresolved work or violations. */
export function storeFactsCertain(view: RunView): boolean {
  return view.clockStatus === 'trusted'
    && !view.counts.dispatchedRequests
    && !view.counts.unresolvedRequests
    && !view.counts.unresolvedOperations
    && !view.ledger.violations.length;
}
/** Replay-safe refusal classification for a persisted role-refusal outcome artifact. */
export async function refuseFromRoleOutcome(
  artifacts: ArtifactStore,
  outcomeRef: ArtifactRef,
  expectedManifest: ArtifactRef,
  markCandidateUnknown: () => void,
): Promise<never> {
  const refusal = record(
    parsePrivateJson(await artifacts.read(outcomeRef, 65_536), 65_536),
    ['version', 'attemptId', 'command', 'diagnostic', 'nativeOutcome', 'currentCandidate', 'unavailable', 'localCleanup'],
  );
  if (refusal.localCleanup !== 'complete') refuse('RECOVERY_REQUIRED', '', 'recovery');
  const diagnostic = refusal.diagnostic as unknown as ControllerDiagnostic;
  if (refusal.currentCandidate === null && diagnostic.code === 'BUDGET_EXHAUSTED' && diagnostic.effect === 'confirmed') {
    markCandidateUnknown();
    refuse('BUDGET_EXHAUSTED', '', 'execution', { stateCode: diagnostic.stateCode, piCode: diagnostic.piCode, effect: 'confirmed' });
  }
  if (!same(refusal.currentCandidate, expectedManifest)) refuse('RECOVERY_REQUIRED', '', 'recovery');
  if (['BUDGET_EXHAUSTED', 'CAPABILITY_UNSUPPORTED', 'MCP_AUTHENTICATION_REQUIRED'].includes(diagnostic.code) && diagnostic.effect === 'none') {
    refuse(diagnostic.code, '', 'execution');
  }
  refuse('RECOVERY_REQUIRED', '', 'recovery');
}
/** Observation only: this may revoke scheduling, but never grants admission or a dispatch permit. */
export function observeParentExhaustion(view: RunView, lock: TaskLock, delegatedModelCalls = 0): void {
  if (view.runId !== lock.spec.runId || !same(view.lockHash, lock.spec.lockHash) || !storeFactsCertain(view)) refuse('RECOVERY_REQUIRED', '', 'execution');
  const limits = lock.spec.contract.spec.budgets;
  if (view.ledger.admittedCalls + delegatedModelCalls >= limits.maxModelCalls || BigInt(view.ledger.chargedTokens.decimal) >= BigInt(limits.totalTokens)) refuse('BUDGET_EXHAUSTED', '', 'execution');
}
export function isBudgetRefusal(error: PiErrorV2): boolean {
  return ['REQUEST_REFUSED', 'STATE_REFUSED'].includes(error.code)
    && error.phase === 'admission'
    && error.stateErrorCode === 'BUDGET_EXHAUSTED';
}
export function isNoEffectBudgetRefusal(error: PiErrorV2): boolean {
  return isBudgetRefusal(error)
    && error.effect === 'none'
    && error.requestId === null
    && error.operationId === null;
}
export interface SchedulingSnapshot { readonly records: string; readonly candidate: string }
/** Exact original facts, not record counts. Renewals/controller checkpoints grant no allowance and are excluded. */
export async function schedulingSnapshot(store: LocalRunStore, authority: Authority, lock: TaskLock, artifacts: ArtifactStore,
  candidate: ByteInventory, retained: ControllerProgress['candidate']): Promise<SchedulingSnapshot> {
  const facts = () => {
    const records = journal(store), view = records.view;
    if (view.storeId !== authority.storeId || view.runId !== lock.spec.runId || !same(view.lockHash, lock.spec.lockHash) || !storeFactsCertain(view)
      || view.owner.ownerId !== authority.ownerId || view.owner.generation !== authority.generation || view.owner.mode !== 'active'
      || view.owner.leaseUntilMonotonicMs === null || BigInt(view.clock.sampledNow.monotonicMs) >= BigInt(view.owner.leaseUntilMonotonicMs)) refuse('RECOVERY_REQUIRED', '', 'execution');
    return canonical({ storeId: view.storeId, runId: view.runId, lockHash: view.lockHash, basis: view.clock.basis,
      owner: { id: view.owner.ownerId, generation: view.owner.generation, mode: view.owner.mode }, ledger: view.ledger, requests: records.requests, operations: records.operations,
      nativeCheckpoints: records.checkpoints.filter(cp => cp.additionalArtifacts.length === 0) });
  };
  await artifacts.owner.assertCurrent(); const records = facts(), subject = bindSubject(lock, candidate.manifest);
  descriptor(candidate.manifest, candidate.ref);
  if (!subject.ok || !same(retained.manifest, candidate.ref) || !same(retained.digest, subject.value.candidateDigest)
    || candidate.files.length !== candidate.manifest.spec.entries.length || new Set(candidate.files.map(file => file.name)).size !== candidate.files.length
    || !Buffer.from(await artifacts.read(candidate.ref, 32768)).equals(Buffer.from(canonical(candidate.manifest)))) refuse('ARTIFACT_INVALID', '', 'execution');
  let total = 0;
  for (const entry of candidate.manifest.spec.entries) {
    const file = candidate.files.find(file => file.name === entry.name); if (!file || (total += entry.byteLength) > 268435456) refuse('ARTIFACT_INVALID', '', 'execution');
    const bytes = ownedBytes(file.bytes, 67108864); if (bytes.length !== entry.byteLength || !same(fileHash(bytes), entry.digest)) refuse('ARTIFACT_INVALID', '', 'execution');
  }
  await artifacts.read(retained.workspace); if (retained.privateSession) await artifacts.read(retained.privateSession, 67108864);
  await artifacts.owner.assertCurrent(); if (facts() !== records) refuse('RECOVERY_REQUIRED', '', 'execution');
  return Object.freeze({ records, candidate: canonical({ retained, manifest: candidate.manifest, subject: subject.value }) });
}
