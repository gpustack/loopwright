import type { ArtifactRef, CheckStatus, Digest, Evidence, EvidenceLevel, RunResult, TaskContract, TaskLock, VerificationResult } from '@loopwright/core';
import type { ControllerIncident } from '@loopwright/controller';

export type MemoryEntryKind = 'fact' | 'failure_observation' | 'invariant';

export interface MemoryEvidenceRef {
  readonly evidenceId: string;
  readonly checkId: string;
  readonly level: EvidenceLevel;
  readonly observedStatus: CheckStatus;
  readonly artifact: ArtifactRef;
}

export interface MemoryEntryScope {
  readonly taskpack: string;
  readonly repository: string;
  readonly paths: readonly string[];
  readonly targetMatrix: null | { readonly id: string; readonly platform: string; readonly variant: string };
}

export interface MemoryEntrySourceRef {
  readonly runId: string;
  readonly lockHash: Digest;
  readonly candidateDigest: Digest;
}

export interface MemoryEntryValidity {
  readonly baseRevision: string;
  readonly sourceRevision: string;
  readonly codeFingerprint: Digest;
  readonly upstreamVersions: Readonly<Record<string, string>>;
}

export interface MemoryEntry {
  readonly version: 1;
  readonly id: string;
  readonly claimKey: string;
  readonly claim: string;
  readonly kind: MemoryEntryKind;
  readonly scope: MemoryEntryScope;
  readonly sourceRef: MemoryEntrySourceRef;
  readonly sourceDigest: Digest;
  readonly verifiedAtMs: number;
  readonly validFor: MemoryEntryValidity;
  readonly expiresAtMs: number;
  readonly supersedes: readonly string[];
  readonly evidenceRefs: readonly MemoryEvidenceRef[];
}

export interface RetiredMemoryEntry {
  readonly entry: MemoryEntry;
  readonly retiredAtMs: number;
  readonly retiredByProposalId: string;
  readonly supersededByEntryId: string | null;
}

export interface MemoryStoreIndex {
  readonly version: 1;
  readonly taskpack: string;
  readonly repository: string;
  readonly updatedAtMs: number;
  readonly entries: readonly MemoryEntry[];
  readonly retired: readonly RetiredMemoryEntry[];
  readonly storeDigest: Digest;
}

export type MemoryOperation =
  | { readonly kind: 'upsert'; readonly entry: MemoryEntry }
  | { readonly kind: 'retire'; readonly entryId: string; readonly reason: string };

export interface MemoryProposal {
  readonly version: 1;
  readonly proposalId: string;
  readonly taskpack: string;
  readonly repository: string;
  readonly baseRevision: string;
  readonly baseStoreDigest: Digest;
  readonly createdAtMs: number;
  readonly runId: string;
  readonly lockHash: Digest;
  readonly operations: readonly MemoryOperation[];
}

export type MemoryGateName = 'memory-schema' | 'provenance' | 'scope' | 'redaction' | 'memory-review';
export type MemoryGateStatus = 'passed' | 'failed';

export type MemoryErrorCode =
  | 'MEMORY_SCHEMA_INVALID'
  | 'MEMORY_PROVENANCE_INVALID'
  | 'MEMORY_SCOPE_VIOLATION'
  | 'MEMORY_SECRET_LEAK'
  | 'MEMORY_INJECTION_DETECTED'
  | 'MEMORY_CONFLICT_UNRESOLVED'
  | 'MEMORY_VERIFICATION_FAILED'
  | 'MEMORY_CAS_CONFLICT'
  | 'COMPACTION_UNSAFE_BOUNDARY'
  | 'CONTEXT_OVERFLOW_BLOCKED'
  | 'COMPACTION_AUTHORITY_VIOLATION';

export interface MemoryDiagnostic {
  readonly code: MemoryErrorCode;
  readonly path: string;
  readonly detail: string;
}

export interface MemoryGateResult {
  readonly gate: MemoryGateName;
  readonly status: MemoryGateStatus;
  readonly diagnostics: readonly MemoryDiagnostic[];
}

export interface MemoryVerificationReport {
  readonly gates: readonly MemoryGateResult[];
  readonly satisfied: boolean;
}

export interface MemoryVerificationInput {
  readonly proposal: MemoryProposal;
  readonly store: MemoryStoreIndex;
  readonly lock: TaskLock;
  readonly result: RunResult | null;
  readonly incident: ControllerIncident | null;
  readonly evidence: readonly Evidence[];
  readonly artifacts: ReadonlyMap<string, { readonly byteLength: number; readonly digest: Digest }>;
  readonly candidateDigest: Digest | null;
  readonly patch: string;
  readonly secretValues: readonly string[];
  readonly memoryWritable: readonly string[];
  readonly protectedPaths: readonly string[];
}

export type MemoryExclusionReason =
  | 'expired'
  | 'superseded'
  | 'fingerprint_mismatch'
  | 'upstream_version_changed'
  | 'scope_mismatch'
  | 'unverified_claim'
  | 'hardware_or_gate_unproven';

export interface ExcludedMemoryEntry {
  readonly entryId: string;
  readonly claimKey: string;
  readonly reason: MemoryExclusionReason;
  readonly detail: string;
}

export interface ActiveMemorySnapshot {
  readonly version: 1;
  readonly taskpack: string;
  readonly repository: string;
  readonly evaluatedAtMs: number;
  readonly activeEntries: readonly MemoryEntry[];
  readonly excludedEntries: readonly ExcludedMemoryEntry[];
  readonly renderedMarkdown: string;
  readonly snapshotDigest: Digest;
}

export interface MemorySelectorInput {
  readonly store: MemoryStoreIndex;
  readonly contract: TaskContract;
  readonly nowMs: number;
  readonly currentCodeFingerprint: Digest;
  readonly currentUpstreamVersions: Readonly<Record<string, string>>;
  readonly targetCell: null | { readonly id: string; readonly platform: string; readonly variant: string };
}

export interface MemoryBudgetLedger {
  readonly revision: number;
  readonly remainingTokens: number;
  readonly remainingModelCalls: number;
  readonly remainingWallMs: number;
}

export interface SettledRunSummary {
  readonly lock: TaskLock;
  readonly result: RunResult | null;
  readonly incident: ControllerIncident | null;
  readonly observations: readonly ArtifactRef[];
  readonly evidence: readonly Evidence[];
  readonly ledger: MemoryBudgetLedger;
  readonly candidateManifest: readonly ArtifactRef[];
  readonly artifacts: readonly ArtifactRef[];
}

export interface MemoryCuratorRequest {
  readonly lock: TaskLock;
  readonly result: RunResult | null;
  readonly incident: ControllerIncident | null;
  readonly verification: VerificationResult | null;
  readonly candidateManifest: readonly ArtifactRef[];
  readonly store: MemoryStoreIndex;
  readonly deterministicEntries: readonly MemoryEntry[];
  readonly nowMs: number;
  readonly ttlMs: number;
  readonly upstreamVersions: Readonly<Record<string, string>>;
}

export interface MemoryCuratorPort {
  curate(request: MemoryCuratorRequest): Promise<readonly MemoryOperation[]>;
}

export interface MemoryFinalizerConfig {
  readonly taskpack: string;
  readonly memoryWritable: readonly string[];
  readonly onNoModelBudget: 'deterministic-observations-only';
  readonly curator?: MemoryCuratorPort | null;
  readonly curatorTimeoutMs?: number;
  readonly requireCuratorReview?: boolean;
  readonly nowMs: number;
  readonly ttlMs: number;
  readonly upstreamVersions: Readonly<Record<string, string>>;
}

export type SettledCycleContext =
  | { readonly kind: 'run_directory'; readonly runRoot: string; readonly runId: string; readonly repository: string;
      readonly ledger?: MemoryBudgetLedger }
  | { readonly kind: 'summary'; readonly repository: string; readonly summary: SettledRunSummary };

export interface MemoryFinalizerInput {
  readonly context: SettledCycleContext;
  readonly config: MemoryFinalizerConfig;
}

export interface MemoryFinalizerOutcome {
  readonly status: 'pending' | 'proposed' | 'unavailable';
  readonly reason: string | null;
  readonly deterministicEntries: readonly MemoryEntry[];
  readonly proposal: MemoryProposal | null;
  readonly proposalDigest: Digest | null;
  readonly patch: string | null;
}

export interface MemoryModifiedFile {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
}

export interface SeparateMemoryPullRequestSpec {
  readonly mode: 'separate_pull_request';
  readonly branchName: string;
  readonly targetBranch: string;
  readonly baseRevision: string;
  readonly title: string;
  readonly body: string;
  readonly modifiedFiles: readonly MemoryModifiedFile[];
  readonly patch: string;
  readonly excludesCodeCandidatePaths: true;
}

export interface MemoryCASInput {
  readonly repository: string;
  readonly taskpack: string;
  readonly proposal: MemoryProposal;
  readonly lock: TaskLock;
  readonly result: RunResult | null;
  readonly incident: ControllerIncident | null;
  readonly evidence: readonly Evidence[];
  readonly artifacts: ReadonlyMap<string, { readonly byteLength: number; readonly digest: Digest }>;
  readonly candidateDigest: Digest | null;
  readonly secretValues: readonly string[];
  readonly memoryWritable: readonly string[];
  readonly protectedPaths: readonly string[];
  readonly targetBranch: string;
  /** Repository head revision observed by the caller right before applying. */
  readonly currentRevision: string;
  /** Store state the proposal was authored against, when the caller retained it; null fails closed on drift. */
  readonly baseStore: MemoryStoreIndex | null;
  readonly allowRebase: boolean;
  /** Test seam: invoked between entry-file renames and the index rename; a throw triggers rollback. */
  readonly faultInjectionHook?: () => Promise<void> | void;
  readonly nowMs: number;
}

export type MemoryCASRefusal = {
  readonly code: 'MEMORY_VERIFICATION_FAILED' | 'MEMORY_CAS_CONFLICT';
  readonly diagnostics: readonly MemoryDiagnostic[];
};

export interface MemoryCASResult {
  readonly applied: boolean;
  readonly rebased: boolean;
  readonly refusal: MemoryCASRefusal | null;
  readonly storeDigestBefore: Digest;
  readonly storeDigestAfter: Digest | null;
  readonly pullRequest: SeparateMemoryPullRequestSpec | null;
}

export type CompactionTrigger = 'hard_context_window' | 'memory_snapshot_drift' | 'soft_utilization' | 'repeat_failure' | 'external_wait';

export interface CompactionPolicyInput {
  readonly contextWindowTokens: number;
  readonly nextRequestInputTokens: number;
  readonly toolResultReserveTokens: number;
  readonly maxOutputTokens: number;
  readonly postCompactionEstimatedTokens: number;
  readonly currentContextTokens: number;
  readonly softUtilizationThreshold: number;
  readonly recentRepeatFailureCount: number;
  readonly repeatFailureThreshold: number;
  readonly upcomingExternalWaitMs: number;
  readonly externalWaitThresholdMs: number;
  readonly externalReceiptsPersisted: boolean;
  readonly expectedReplaySavingsTokens: number;
  readonly summaryCostTokens: number;
  readonly cacheRebuildCostTokens: number;
  readonly unpairedToolCallIds: readonly string[];
  readonly sessionMemorySnapshotDigest: Digest;
  readonly activeMemorySnapshotDigest: Digest;
  readonly checkpointId: string;
  readonly pendingOperationIds: readonly string[];
  readonly advisoryDecision: 'compact' | 'defer' | null;
}

export type CompactionDecision =
  | { readonly disposition: 'compact_now'; readonly layer: 'hard' | 'soft'; readonly vetoable: boolean; readonly triggers: readonly CompactionTrigger[]; readonly checkpoint: { readonly checkpointId: string; readonly pendingOperationIds: readonly string[] } }
  | { readonly disposition: 'defer'; readonly layer: 'soft'; readonly vetoable: true; readonly triggers: readonly CompactionTrigger[]; readonly detail: string }
  | { readonly disposition: 'blocked'; readonly layer: 'hard' | 'soft'; readonly vetoable: false; readonly code: 'COMPACTION_UNSAFE_BOUNDARY' | 'CONTEXT_OVERFLOW_BLOCKED'; readonly detail: string };

export interface CompactionSummaryInput {
  readonly lock: TaskLock;
  readonly nonGoals: readonly string[];
  readonly currentNodeId: string;
  readonly checks: { readonly passed: readonly string[]; readonly failed: readonly string[]; readonly blocked: readonly string[]; readonly notRun: readonly string[] };
  readonly evidenceRefs: readonly ArtifactRef[];
  readonly modifiedFiles: readonly { readonly path: string; readonly digest: Digest }[];
  readonly openIssues: readonly string[];
  readonly forbiddenActions: readonly string[];
  readonly pendingExternalOperations: readonly { readonly operationId: string; readonly kind: 'gate' | 'publication' | 'mcp'; readonly state: string }[];
  readonly ledger: MemoryBudgetLedger;
  readonly nextAllowedActions: readonly string[];
  readonly memory: {
    readonly store: MemoryStoreIndex;
    readonly contract: TaskContract;
    readonly nowMs: number;
    readonly currentCodeFingerprint: Digest;
    readonly currentUpstreamVersions: Readonly<Record<string, string>>;
    readonly targetCell: null | { readonly id: string; readonly platform: string; readonly variant: string };
  };
}

export interface CompactionCheckpointSummary {
  readonly version: 1;
  readonly goal: { readonly goal: string; readonly nonGoals: readonly string[] };
  readonly contractHash: Digest;
  readonly currentNodeId: string;
  readonly checks: { readonly passed: readonly string[]; readonly failed: readonly string[]; readonly blocked: readonly string[]; readonly notRun: readonly string[] };
  readonly evidenceRefs: readonly ArtifactRef[];
  readonly modifiedFiles: readonly { readonly path: string; readonly digest: Digest }[];
  readonly openIssues: readonly string[];
  readonly forbiddenActions: readonly string[];
  readonly pendingExternalOperations: readonly { readonly operationId: string; readonly kind: 'gate' | 'publication' | 'mcp'; readonly state: string }[];
  readonly budgetLedgerRef: MemoryBudgetLedger;
  readonly activeMemorySnapshot: { readonly snapshotDigest: Digest; readonly activeEntryIds: readonly string[]; readonly excludedEntryIds: readonly string[] };
  readonly nextAllowedActions: readonly string[];
}

export interface CompactionLedgerState {
  readonly lockHash: Digest;
  readonly writableScope: readonly string[];
  readonly remainingTokens: number;
  readonly remainingModelCalls: number;
  readonly remainingWallMs: number;
  readonly nodes: readonly { readonly id: string; readonly state: string }[];
  readonly pendingExternalOperations: readonly { readonly operationId: string; readonly kind: string; readonly state: string }[];
  readonly activeMemorySnapshot: { readonly snapshotDigest: Digest; readonly activeEntryIds: readonly string[]; readonly excludedEntryIds: readonly string[] };
}

export interface CompactionRestoreInput {
  readonly ledger: CompactionLedgerState;
  readonly summary: CompactionCheckpointSummary;
  readonly proposedWritableScope: readonly string[];
  readonly proposedChecks: CompactionLedgerState['nodes'];
  readonly proposedBudget: { readonly remainingTokens: number; readonly remainingModelCalls: number; readonly remainingWallMs: number };
}

export type CompactionRestoreResult =
  | { readonly ok: true; readonly state: CompactionLedgerState }
  | { readonly ok: false; readonly code: 'COMPACTION_AUTHORITY_VIOLATION'; readonly detail: string };

export type MemoryTrustedResource = TaskContract['spec']['trustedContext']['resources'][number];
