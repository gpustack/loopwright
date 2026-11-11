export { MemoryDiagnosticError, diagnostic, fail, digestEqual, canonical, hashDomain, digestBytes, storeDigestOf,
  incidentReferenceDigest, syntheticIncidentArtifact, memoryIdentifierPattern, hasControlCharacter, memoryEntrySchema,
  memoryStoreIndexSchema, memoryProposalSchema, renderEntryMarkdown, parseEntryMarkdown, unifiedFileDiff,
  MEMORY_STORE_DIGEST_DOMAIN, MEMORY_ENTRY_HEADER_FENCE } from './schema.js';
export { MEMORY_ROOT, memoryDirectoryFor, forbiddenMemoryArtifactName, isMemoryManagedPath, emptyMemoryStoreIndex,
  loadMemoryStore, computeCodeFingerprint, compileScopePattern, matchScopePattern, entryFileBytes, projectMemoryStore,
  ensureMemoryDirectories } from './store.js';
export { selectActiveMemory, bindMemorySnapshotToResource, memorySnapshotBindingMatches, memorySnapshotResourceId } from './selector.js';
export { finalizeRunMemory } from './finalizer.js';
export { verifyMemoryProposal, verifyRebasedProposal } from './verifier.js';
export { applyMemoryProposalCAS } from './cas.js';
export { evaluateCompactionPolicy, buildCompactionSummary, restoreFromCompactionLedger } from './compaction.js';
export type { MemoryEntryKind, MemoryEvidenceRef, MemoryEntryScope, MemoryEntrySourceRef, MemoryEntryValidity, MemoryEntry,
  RetiredMemoryEntry, MemoryStoreIndex, MemoryOperation, MemoryProposal, MemoryGateName, MemoryGateStatus, MemoryErrorCode,
  MemoryDiagnostic, MemoryGateResult, MemoryVerificationReport, MemoryVerificationInput, MemoryExclusionReason,
  ExcludedMemoryEntry, ActiveMemorySnapshot, MemorySelectorInput, MemoryBudgetLedger, SettledRunSummary, MemoryCuratorRequest,
  MemoryCuratorPort, MemoryFinalizerConfig, SettledCycleContext, MemoryFinalizerInput, MemoryFinalizerOutcome,
  MemoryModifiedFile, SeparateMemoryPullRequestSpec, MemoryCASInput, MemoryCASRefusal, MemoryCASResult, CompactionTrigger,
  CompactionPolicyInput, CompactionDecision, CompactionSummaryInput, CompactionCheckpointSummary, CompactionLedgerState,
  CompactionRestoreInput, CompactionRestoreResult, MemoryTrustedResource } from './types.js';
