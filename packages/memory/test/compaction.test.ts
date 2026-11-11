import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Digest, TaskContract, TaskLock } from '@loopwright/core';
import { buildCompactionSummary, evaluateCompactionPolicy, restoreFromCompactionLedger } from '../src/compaction.js';
import { storeDigestOf } from '../src/schema.js';
import type { CompactionCheckpointSummary, CompactionLedgerState, CompactionPolicyInput, MemoryEntry, MemoryStoreIndex } from '../src/types.js';

function hex(seed: string): Digest { return { algorithm: 'sha256', hex: createHash('sha256').update(seed).digest('hex') }; }
function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return Object.freeze({ version: 1, id: 'entry.alpha', claimKey: 'claim.alpha', claim: 'Stable claim text.', kind: 'fact',
    scope: { taskpack: 'demo', repository: 'org/repo', paths: ['docs/**'], targetMatrix: null },
    sourceRef: { runId: 'run.one', lockHash: hex('lock'), candidateDigest: hex('candidate') },
    sourceDigest: hex('source'), verifiedAtMs: 1000,
    validFor: { baseRevision: 'b'.repeat(40), sourceRevision: 'c'.repeat(40), codeFingerprint: hex('fingerprint'), upstreamVersions: { npm: '1.0.0' } },
    expiresAtMs: 2000, supersedes: [],
    evidenceRefs: [{ evidenceId: 'ev.one', checkId: 'check.one', level: 'local_execution', observedStatus: 'passed',
      artifact: { name: 'artifacts/evidence.json', digest: hex('artifact'), byteLength: 10 } }] , ...overrides }) as MemoryEntry;
}
function store(entries: readonly MemoryEntry[]): MemoryStoreIndex {
  const base = { version: 1 as const, taskpack: 'demo', repository: 'org/repo', updatedAtMs: 1500, entries, retired: [] };
  return { ...base, storeDigest: storeDigestOf(base) };
}
const contract = {
  apiVersion: 'loopwright.dev/v1alpha1', kind: 'TaskContract', metadata: { id: 'contract.demo' },
  spec: { goal: 'demo goal', taskpack: 'demo',
    target: { repository: 'org/repo', baseRevision: 'b'.repeat(40), sourceRevision: 'c'.repeat(40), matrix: null },
    scope: { writable: ['src/**'], protected: [] }, roles: [], trustedContext: { revision: 'rev', discovery: 'disabled', resources: [] },
    budgets: {}, steps: [], acceptance: { required: [], checks: [] } },
} as unknown as TaskContract;
const lock = {
  apiVersion: 'loopwright.dev/v1alpha1', kind: 'TaskLock', metadata: { id: 'admission.demo' },
  spec: { runId: 'run.one', contract, contractHash: hex('contract-hash'), lockHash: hex('lock-hash') },
} as unknown as TaskLock;
function policyInput(overrides: Partial<CompactionPolicyInput> = {}): CompactionPolicyInput {
  return { contextWindowTokens: 1000, nextRequestInputTokens: 400, toolResultReserveTokens: 200, maxOutputTokens: 100,
    postCompactionEstimatedTokens: 300, currentContextTokens: 500, softUtilizationThreshold: 0.8,
    recentRepeatFailureCount: 0, repeatFailureThreshold: 2, upcomingExternalWaitMs: 0, externalWaitThresholdMs: 5000,
    externalReceiptsPersisted: false, expectedReplaySavingsTokens: 900, summaryCostTokens: 100, cacheRebuildCostTokens: 100,
    unpairedToolCallIds: [], sessionMemorySnapshotDigest: hex('fingerprint'), activeMemorySnapshotDigest: hex('fingerprint'),
    checkpointId: 'checkpoint.one', pendingOperationIds: ['op.one'], advisoryDecision: null, ...overrides };
}
function ledgerState(overrides: Partial<CompactionLedgerState> = {}): CompactionLedgerState {
  return { lockHash: hex('lock-hash'), writableScope: ['src/**'], remainingTokens: 1000, remainingModelCalls: 5, remainingWallMs: 60000,
    nodes: [{ id: 'check.one', state: 'passed' }, { id: 'check.two', state: 'not_run' }],
    pendingExternalOperations: [{ operationId: 'op.one', kind: 'gate', state: 'dispatched' }],
    activeMemorySnapshot: { snapshotDigest: hex('fingerprint'), activeEntryIds: ['entry.alpha'], excludedEntryIds: [] },
    ...overrides };
}
function summaryInput(storeIndex: MemoryStoreIndex, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { lock, nonGoals: ['no scope growth'], currentNodeId: 'work',
    checks: { passed: ['check.one'], failed: [], blocked: [], notRun: ['check.two'] },
    evidenceRefs: [{ name: 'artifacts/evidence.json', digest: hex('artifact'), byteLength: 10 }],
    modifiedFiles: [{ path: 'src/a.txt', digest: hex('source') }], openIssues: [], forbiddenActions: ['force push'],
    pendingExternalOperations: [{ operationId: 'op.one', kind: 'gate', state: 'dispatched' }],
    ledger: { revision: 7, remainingTokens: 1000, remainingModelCalls: 5, remainingWallMs: 60000 },
    nextAllowedActions: ['run check.two'],
    memory: { store: storeIndex, contract, nowMs: 1500, currentCodeFingerprint: hex('fingerprint'), currentUpstreamVersions: { npm: '1.0.0' }, targetCell: null },
    ...overrides };
}

describe('two-layer compaction policy', () => {
  it('fires the hard window trigger as non-vetoable and ignores advisory deferral', () => {
    const decision = evaluateCompactionPolicy(policyInput({ nextRequestInputTokens: 900, advisoryDecision: 'defer' }));
    assert.deepEqual(decision, { disposition: 'compact_now', layer: 'hard', vetoable: false, triggers: ['hard_context_window'],
      checkpoint: { checkpointId: 'checkpoint.one', pendingOperationIds: ['op.one'] } });
  });

  it('fires the memory snapshot drift trigger', () => {
    const decision = evaluateCompactionPolicy(policyInput({ activeMemorySnapshotDigest: hex('drifted') }));
    assert.equal(decision.disposition, 'compact_now');
    assert.equal(decision.layer, 'hard');
    assert.deepEqual(decision.triggers, ['memory_snapshot_drift']);
  });

  it('blocks on unpaired tool calls before any truncation', () => {
    const decision = evaluateCompactionPolicy(policyInput({ nextRequestInputTokens: 900, unpairedToolCallIds: ['call.one', 'call.two'] }));
    assert.deepEqual(decision, { disposition: 'blocked', layer: 'hard', vetoable: false, code: 'COMPACTION_UNSAFE_BOUNDARY',
      detail: '2 unpaired tool call(s) refuse truncation: call.one, call.two' });
    const paired = evaluateCompactionPolicy(policyInput({ currentContextTokens: 100 }));
    assert.notEqual(paired.disposition, 'blocked');
  });

  it('blocks when the post-compaction estimate would still overflow the window', () => {
    const decision = evaluateCompactionPolicy(policyInput({ nextRequestInputTokens: 900, postCompactionEstimatedTokens: 900 }));
    assert.deepEqual(decision, { disposition: 'blocked', layer: 'hard', vetoable: false, code: 'CONTEXT_OVERFLOW_BLOCKED',
      detail: 'post-compaction estimate 900 plus reserves exceeds the 1000-token window' });
  });

  it('compacts on utilization or a persisted long external wait with positive net savings', () => {
    const utilized = evaluateCompactionPolicy(policyInput({ currentContextTokens: 900 }));
    assert.equal(utilized.disposition, 'compact_now');
    assert.equal(utilized.layer, 'soft');
    assert.equal(utilized.vetoable, true);
    assert.deepEqual(utilized.triggers, ['soft_utilization']);
    const waiting = evaluateCompactionPolicy(policyInput({ upcomingExternalWaitMs: 8000, externalReceiptsPersisted: true }));
    assert.equal(waiting.disposition, 'compact_now');
    assert.deepEqual(waiting.triggers, ['external_wait']);
    const unpersisted = evaluateCompactionPolicy(policyInput({ upcomingExternalWaitMs: 8000, externalReceiptsPersisted: false }));
    assert.equal(unpersisted.disposition, 'defer');
    assert.ok(unpersisted.detail.includes('at or below threshold'));
  });

  it('defers soft triggers on negative savings or an advisory veto', () => {
    const losing = evaluateCompactionPolicy(policyInput({ currentContextTokens: 900, expectedReplaySavingsTokens: 150 }));
    assert.equal(losing.disposition, 'defer');
    assert.ok(losing.detail.includes('not positive'));
    const below = evaluateCompactionPolicy(policyInput({}));
    assert.equal(below.disposition, 'defer');
    const vetoed = evaluateCompactionPolicy(policyInput({ currentContextTokens: 900, advisoryDecision: 'defer' }));
    assert.equal(vetoed.disposition, 'defer');
    assert.ok(vetoed.detail.includes('vetoes the soft trigger'));
    const hardVetoAttempt = evaluateCompactionPolicy(policyInput({ nextRequestInputTokens: 900, advisoryDecision: 'defer' }));
    assert.equal(hardVetoAttempt.disposition, 'compact_now');
    const approved = evaluateCompactionPolicy(policyInput({ currentContextTokens: 900, advisoryDecision: 'compact' }));
    assert.equal(approved.disposition, 'compact_now');
  });
  it('blocks soft compaction on unsafe boundaries before truncating', () => {
    const unpaired = evaluateCompactionPolicy(policyInput({ currentContextTokens: 900, unpairedToolCallIds: ['call.1'] }));
    assert.deepEqual(unpaired, { disposition: 'blocked', layer: 'soft', vetoable: false, code: 'COMPACTION_UNSAFE_BOUNDARY',
      detail: '1 unpaired tool call(s) refuse truncation: call.1' });
    const overflow = evaluateCompactionPolicy(policyInput({ currentContextTokens: 900, postCompactionEstimatedTokens: 900 }));
    assert.deepEqual(overflow, { disposition: 'blocked', layer: 'soft', vetoable: false, code: 'CONTEXT_OVERFLOW_BLOCKED',
      detail: 'post-compaction estimate 900 plus reserves exceeds the 1000-token window' });
    const missingCheckpoint = evaluateCompactionPolicy(policyInput({ currentContextTokens: 900, checkpointId: '' }));
    assert.deepEqual(missingCheckpoint, { disposition: 'blocked', layer: 'soft', vetoable: false, code: 'COMPACTION_UNSAFE_BOUNDARY',
      detail: 'persisted checkpoint reference is missing or invalid' });
  });

  it('treats repeated check failures as a vetoable soft trigger', () => {
    const repeated = evaluateCompactionPolicy(policyInput({ recentRepeatFailureCount: 2 }));
    assert.equal(repeated.disposition, 'compact_now');
    assert.equal(repeated.layer, 'soft');
    assert.equal(repeated.vetoable, true);
    assert.deepEqual(repeated.triggers, ['repeat_failure']);
    const vetoed = evaluateCompactionPolicy(policyInput({ recentRepeatFailureCount: 2, advisoryDecision: 'defer' }));
    assert.equal(vetoed.disposition, 'defer');
    const below = evaluateCompactionPolicy(policyInput({ recentRepeatFailureCount: 1 }));
    assert.equal(below.disposition, 'defer');
  });
});

describe('12-field compaction summary', () => {
  it('constructs the canonical summary with a refreshed snapshot and deterministic digest', () => {
    const first = buildCompactionSummary(summaryInput(store([entry()])) as never);
    const second = buildCompactionSummary(summaryInput(store([entry()])) as never);
    const summary: CompactionCheckpointSummary = first.summary;
    assert.equal(summary.version, 1);
    assert.deepEqual(summary.goal, { goal: 'demo goal', nonGoals: ['no scope growth'] });
    assert.equal(summary.contractHash.hex, hex('lock-hash').hex);
    assert.equal(summary.currentNodeId, 'work');
    assert.deepEqual(summary.checks, { passed: ['check.one'], failed: [], blocked: [], notRun: ['check.two'] });
    assert.equal(summary.evidenceRefs.length, 1);
    assert.equal(summary.modifiedFiles[0]!.path, 'src/a.txt');
    assert.deepEqual(summary.openIssues, []);
    assert.deepEqual(summary.forbiddenActions, ['force push']);
    assert.deepEqual(summary.pendingExternalOperations, [{ operationId: 'op.one', kind: 'gate', state: 'dispatched' }]);
    assert.deepEqual(summary.budgetLedgerRef, { revision: 7, remainingTokens: 1000, remainingModelCalls: 5, remainingWallMs: 60000 });
    assert.deepEqual(summary.activeMemorySnapshot.activeEntryIds, ['entry.alpha']);
    assert.deepEqual(summary.activeMemorySnapshot.excludedEntryIds, []);
    assert.deepEqual(summary.nextAllowedActions, ['run check.two']);
    assert.equal(first.digest.hex, second.digest.hex);
  });

  it('purges a newly expired entry from the refreshed snapshot', () => {
    const { summary } = buildCompactionSummary(summaryInput(store([entry({ expiresAtMs: 1499 })])) as never);
    assert.deepEqual(summary.activeMemorySnapshot.activeEntryIds, []);
    assert.deepEqual(summary.activeMemorySnapshot.excludedEntryIds, ['entry.alpha']);
    const drifted = buildCompactionSummary(summaryInput(store([entry()]), { memory: { store: store([entry()]), contract, nowMs: 1500,
      currentCodeFingerprint: hex('drift'), currentUpstreamVersions: { npm: '1.0.0' }, targetCell: null } }) as never);
    assert.deepEqual(drifted.summary.activeMemorySnapshot.excludedEntryIds, ['entry.alpha']);
    assert.notEqual(drifted.digest.hex, hex('lock-hash').hex);
  });
});

describe('ledger-only restore guard', () => {
  const summary = (buildCompactionSummary(summaryInput(store([entry()])) as never).summary);
  const ledger = ledgerState({ activeMemorySnapshot: { ...summary.activeMemorySnapshot } });

  it('restores the authoritative ledger state unchanged', () => {
    const restored = restoreFromCompactionLedger({ ledger, summary, proposedWritableScope: ['src/**'],
      proposedChecks: ledger.nodes, proposedBudget: { remainingTokens: 1000, remainingModelCalls: 5, remainingWallMs: 60000 } });
    assert.equal(restored.ok, true);
    if (restored.ok) {
      assert.equal(restored.state.lockHash.hex, ledger.lockHash.hex);
      assert.deepEqual(restored.state.writableScope, ['src/**']);
      assert.deepEqual(restored.state.nodes, ledger.nodes);
      assert.deepEqual(restored.state.pendingExternalOperations, ledger.pendingExternalOperations);
    }
  });

  it('violates authority for granted paths, forged passes, dropped operations, raised budgets, and foreign contracts', () => {
    const granted = restoreFromCompactionLedger({ ledger, summary, proposedWritableScope: ['src/**', 'docs/**'],
      proposedChecks: ledger.nodes, proposedBudget: { remainingTokens: 1000, remainingModelCalls: 5, remainingWallMs: 60000 } });
    assert.deepEqual(granted, { ok: false, code: 'COMPACTION_AUTHORITY_VIOLATION', detail: 'summary grants writable paths outside the ledger scope: docs/**' });
    const forged = restoreFromCompactionLedger({ ledger, summary, proposedWritableScope: ['src/**'],
      proposedChecks: [ledger.nodes[0]!, { id: 'check.two', state: 'completed' }],
      proposedBudget: { remainingTokens: 1000, remainingModelCalls: 5, remainingWallMs: 60000 } });
    assert.ok(!forged.ok && forged.detail.includes('check.two'));
    const unknownNode = restoreFromCompactionLedger({ ledger, summary, proposedWritableScope: ['src/**'],
      proposedChecks: [...ledger.nodes, { id: 'check.three', state: 'pending' }],
      proposedBudget: { remainingTokens: 1000, remainingModelCalls: 5, remainingWallMs: 60000 } });
    assert.ok(!unknownNode.ok && unknownNode.detail.includes('check.three'));
    const dropped = restoreFromCompactionLedger({ ledger, summary: { ...summary, pendingExternalOperations: [] },
      proposedWritableScope: ['src/**'], proposedChecks: ledger.nodes, proposedBudget: { remainingTokens: 1000, remainingModelCalls: 5, remainingWallMs: 60000 } });
    assert.ok(!dropped.ok && dropped.detail.includes('op.one'));
    const raised = restoreFromCompactionLedger({ ledger, summary, proposedWritableScope: ['src/**'], proposedChecks: ledger.nodes,
      proposedBudget: { remainingTokens: 2000, remainingModelCalls: 5, remainingWallMs: 60000 } });
    assert.ok(!raised.ok && raised.detail.includes('budgets'));
    const foreign = restoreFromCompactionLedger({ ledger: ledgerState({ lockHash: hex('other-lock') }), summary,
      proposedWritableScope: ['src/**'], proposedChecks: ledger.nodes, proposedBudget: { remainingTokens: 1000, remainingModelCalls: 5, remainingWallMs: 60000 } });
    assert.ok(!foreign.ok && foreign.detail.includes('contract hash'));
    const snapshotDrift = restoreFromCompactionLedger({ ledger, summary: { ...summary,
      activeMemorySnapshot: { ...summary.activeMemorySnapshot, snapshotDigest: hex('drifted-snapshot') } },
      proposedWritableScope: ['src/**'], proposedChecks: ledger.nodes, proposedBudget: { remainingTokens: 1000, remainingModelCalls: 5, remainingWallMs: 60000 } });
    assert.ok(!snapshotDrift.ok && snapshotDrift.detail.includes('snapshot'));
    const raisedLedger = restoreFromCompactionLedger({ ledger, summary: { ...summary,
      budgetLedgerRef: { revision: 7, remainingTokens: 5000, remainingModelCalls: 5, remainingWallMs: 60000 } },
      proposedWritableScope: ['src/**'], proposedChecks: ledger.nodes, proposedBudget: { remainingTokens: 1000, remainingModelCalls: 5, remainingWallMs: 60000 } });
    assert.ok(!raisedLedger.ok && raisedLedger.detail.includes('budget ledger reference'));
  });
});
