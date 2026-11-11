import type { Digest } from '@loopwright/core';
import { digestEqual, hashDomain, hasControlCharacter } from './schema.js';
import { selectActiveMemory } from './selector.js';
import type { CompactionCheckpointSummary, CompactionDecision, CompactionPolicyInput, CompactionRestoreInput, CompactionRestoreResult, CompactionSummaryInput, CompactionTrigger } from './types.js';

function checkpointReferenceIsValid(input: CompactionPolicyInput): boolean {
  if (typeof input.checkpointId !== 'string' || input.checkpointId.trim().length === 0 || hasControlCharacter(input.checkpointId)) return false;
  if (!Array.isArray(input.pendingOperationIds)) return false;
  return input.pendingOperationIds.every(id => typeof id === 'string' && id.trim().length > 0 && !hasControlCharacter(id));
}
/**
 * Two-layer compaction policy. Hard triggers are non-vetoable and ignore advisory decisions; every
 * `compact_now` outcome (hard or soft) must first pass the persisted-checkpoint precondition, the
 * unpaired-tool-call guard, and the post-compaction overflow guard.
 */
export function evaluateCompactionPolicy(input: CompactionPolicyInput): CompactionDecision {
  const hardTriggers: CompactionTrigger[] = [];
  if (input.nextRequestInputTokens + input.toolResultReserveTokens + input.maxOutputTokens > input.contextWindowTokens) hardTriggers.push('hard_context_window');
  if (input.sessionMemorySnapshotDigest.hex !== input.activeMemorySnapshotDigest.hex) hardTriggers.push('memory_snapshot_drift');
  const utilizationRatio = input.currentContextTokens / input.contextWindowTokens;
  const netTokenSavings = input.expectedReplaySavingsTokens - input.summaryCostTokens - input.cacheRebuildCostTokens;
  const softTriggers: CompactionTrigger[] = [];
  if (utilizationRatio > input.softUtilizationThreshold) softTriggers.push('soft_utilization');
  if (input.recentRepeatFailureCount >= input.repeatFailureThreshold) softTriggers.push('repeat_failure');
  if (input.upcomingExternalWaitMs >= input.externalWaitThresholdMs && input.externalReceiptsPersisted) softTriggers.push('external_wait');
  const softCompaction = softTriggers.length > 0 && netTokenSavings > 0 && input.advisoryDecision !== 'defer';
  const layer: 'hard' | 'soft' = hardTriggers.length > 0 ? 'hard' : 'soft';
  if (!(hardTriggers.length > 0 || softCompaction)) {
    const detail = softTriggers.length === 0 ? `utilization ${utilizationRatio.toFixed(4)} at or below threshold ${input.softUtilizationThreshold}`
      : netTokenSavings <= 0 ? `net token savings ${netTokenSavings} is not positive`
      : `advisory decision ${input.advisoryDecision} vetoes the soft trigger`;
    return { disposition: 'defer', layer: 'soft', vetoable: true, triggers: softTriggers, detail };
  }
  const checkpoint = { checkpointId: input.checkpointId, pendingOperationIds: [...input.pendingOperationIds] };
  if (!checkpointReferenceIsValid(input)) {
    return { disposition: 'blocked', layer, vetoable: false, code: 'COMPACTION_UNSAFE_BOUNDARY', detail: 'persisted checkpoint reference is missing or invalid' };
  }
  if (input.unpairedToolCallIds.length > 0) {
    return { disposition: 'blocked', layer, vetoable: false, code: 'COMPACTION_UNSAFE_BOUNDARY',
      detail: `${input.unpairedToolCallIds.length} unpaired tool call(s) refuse truncation: ${input.unpairedToolCallIds.slice(0, 4).join(', ')}` };
  }
  if (input.postCompactionEstimatedTokens + input.toolResultReserveTokens + input.maxOutputTokens > input.contextWindowTokens) {
    return { disposition: 'blocked', layer, vetoable: false, code: 'CONTEXT_OVERFLOW_BLOCKED',
      detail: `post-compaction estimate ${input.postCompactionEstimatedTokens} plus reserves exceeds the ${input.contextWindowTokens}-token window` };
  }
  if (hardTriggers.length > 0) {
    return { disposition: 'compact_now', layer: 'hard', vetoable: false, triggers: hardTriggers, checkpoint };
  }
  return { disposition: 'compact_now', layer: 'soft', vetoable: true, triggers: softTriggers, checkpoint };
}
/** Constructs the canonical 12-field summary and its digest, refreshing the active memory snapshot. */
export function buildCompactionSummary(input: CompactionSummaryInput): { readonly summary: CompactionCheckpointSummary; readonly digest: Digest } {
  const snapshot = selectActiveMemory({ store: input.memory.store, contract: input.memory.contract, nowMs: input.memory.nowMs,
    currentCodeFingerprint: input.memory.currentCodeFingerprint, currentUpstreamVersions: input.memory.currentUpstreamVersions,
    targetCell: input.memory.targetCell });
  const summary: CompactionCheckpointSummary = { version: 1,
    goal: { goal: input.lock.spec.contract.spec.goal, nonGoals: [...input.nonGoals] },
    contractHash: { ...input.lock.spec.lockHash }, currentNodeId: input.currentNodeId,
    checks: { passed: [...input.checks.passed], failed: [...input.checks.failed], blocked: [...input.checks.blocked], notRun: [...input.checks.notRun] },
    evidenceRefs: input.evidenceRefs.map(reference => ({ ...reference })),
    modifiedFiles: input.modifiedFiles.map(file => ({ ...file })),
    openIssues: [...input.openIssues], forbiddenActions: [...input.forbiddenActions],
    pendingExternalOperations: input.pendingExternalOperations.map(operation => ({ ...operation })),
    budgetLedgerRef: { ...input.ledger },
    activeMemorySnapshot: { snapshotDigest: { ...snapshot.snapshotDigest }, activeEntryIds: snapshot.activeEntries.map(entry => entry.id),
      excludedEntryIds: snapshot.excludedEntries.map(entry => entry.entryId) },
    nextAllowedActions: [...input.nextAllowedActions] };
  return { summary, digest: hashDomain('compaction-summary', summary) };
}
/**
 * Restores execution state strictly from the persisted ledger plus ActiveMemorySnapshot. Any summary text
 * that would grant more authority than the ledger carries is an authority violation, never an update.
 */
export function restoreFromCompactionLedger(input: CompactionRestoreInput): CompactionRestoreResult {
  const violation = (detail: string): CompactionRestoreResult => ({ ok: false, code: 'COMPACTION_AUTHORITY_VIOLATION', detail });
  const { ledger, summary, proposedWritableScope, proposedChecks, proposedBudget } = input;
  if (summary.contractHash.hex !== ledger.lockHash.hex) return violation('summary contract hash does not match the persisted ledger lock hash');
  if (!digestEqual(summary.activeMemorySnapshot.snapshotDigest, ledger.activeMemorySnapshot.snapshotDigest)) {
    return violation('summary active memory snapshot digest does not match the persisted ledger snapshot');
  }
  if (summary.budgetLedgerRef.remainingTokens > ledger.remainingTokens || summary.budgetLedgerRef.remainingModelCalls > ledger.remainingModelCalls
    || summary.budgetLedgerRef.remainingWallMs > ledger.remainingWallMs) return violation('summary budget ledger reference exceeds the persisted ledger budgets');
  const granted = proposedWritableScope.filter(pattern => !ledger.writableScope.includes(pattern));
  if (granted.length > 0) return violation(`summary grants writable paths outside the ledger scope: ${granted.slice(0, 4).join(', ')}`);
  for (const proposed of proposedChecks) {
    const persisted = ledger.nodes.find(node => node.id === proposed.id);
    if (persisted === undefined) return violation(`summary introduces unknown node ${proposed.id}`);
    if (proposed.state === 'completed' && persisted.state !== 'completed') return violation(`summary marks check ${proposed.id} passed without ledger evidence`);
  }
  const summaryOperationIds = new Set(summary.pendingExternalOperations.map(operation => operation.operationId));
  const dropped = ledger.pendingExternalOperations.filter(operation => !summaryOperationIds.has(operation.operationId));
  if (dropped.length > 0) return violation(`summary drops pending external operations: ${dropped.map(operation => operation.operationId).slice(0, 4).join(', ')}`);
  if (proposedBudget.remainingTokens > ledger.remainingTokens || proposedBudget.remainingModelCalls > ledger.remainingModelCalls
    || proposedBudget.remainingWallMs > ledger.remainingWallMs) return violation('summary increases remaining budgets beyond the persisted ledger');
  return { ok: true, state: { lockHash: { ...ledger.lockHash }, writableScope: [...ledger.writableScope],
    remainingTokens: ledger.remainingTokens, remainingModelCalls: ledger.remainingModelCalls, remainingWallMs: ledger.remainingWallMs,
    nodes: ledger.nodes.map(node => ({ ...node })), pendingExternalOperations: ledger.pendingExternalOperations.map(operation => ({ ...operation })),
    activeMemorySnapshot: { ...ledger.activeMemorySnapshot } } };
}
