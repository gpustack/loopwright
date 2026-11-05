import type { Digest, TaskLock, Subject, ArtifactRef, RequestUsage, Diagnostic } from '@loopwright/core';
import type { StateErrorCode } from './errors.js';
export type ExactTotal = { readonly decimal: string; readonly safeValue: number | null };
export type StatePolicy = {
  readonly version: 1;
  readonly leaseMs: number; // integer 1000..60000
  readonly cost: 'observe_only';
};
export type CompatibilityBinding = {
  readonly coreApiVersion: 'loopwright.dev/v1alpha1';
  readonly hostVersion: string;
  readonly adapters: readonly { readonly id: string; readonly version: string }[];
  readonly resourceVersion: string;
  readonly clockEpoch: string; // trusted host identity for this boot/clock domain
};
export type Authority = {
  readonly storeId: string; readonly runId: string; readonly lockHash: Digest;
  readonly ownerId: string; readonly generation: number; readonly nonce: string;
};
export type OwnerView = {
  readonly authority: Authority; readonly revision: number;
  readonly leaseUntilMs: number; // display-only projection
  readonly leaseGrantedMonotonicMs: MonotonicMs;
  readonly leaseUntilMonotonicMs: MonotonicMs; readonly clockEpoch: string;
  readonly mode: 'active' | 'recovery';
};
export type MonotonicMs = string; // canonical nonnegative decimal, 1..20 digits
export type ClockSample = { readonly wallMs: number; readonly monotonicMs: MonotonicMs };
export type ClockBasis = {
  readonly clockEpoch: string; readonly created: ClockSample;
  readonly taskDeadlineMonotonicMs: MonotonicMs;
};
export type ClockView = {
  readonly basis: ClockBasis; readonly lastCommittedSample: ClockSample;
  readonly sampledNow: ClockSample; readonly elapsedTaskMs: ExactTotal;
  readonly remainingTaskMs: ExactTotal;
};
export type LocalRunIdentity = {
  readonly directory: string; readonly storeId: string;
  readonly lock: TaskLock; readonly policy: StatePolicy;
  readonly binding: CompatibilityBinding;
};
export type StateResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: StateError };
export type StateError = {
  readonly code: StateErrorCode; readonly path: string;
  readonly retryable: boolean; readonly commit: 'not_committed' | 'unknown';
  readonly diagnostics: readonly Diagnostic[];
};
export type Mutation<T> = {
  readonly kind: 'created' | 'applied' | 'existing';
  readonly revision: number; readonly record: T;
};
export type Purpose = 'task' | 'judge' | 'reviewer' | 'compaction' | 'child';
export type Capability = {
  readonly adapterId: string; readonly adapterVersion: string;
  readonly provider: string; readonly model: string;
  readonly kind: 'hard_bound' | 'soft_only' | 'unknown';
  readonly coversAllBillableTokens: boolean;
  readonly enforcesOutputBound: boolean;
};
export type RequestAdmission = {
  readonly requestId: string; readonly roleId: string;
  readonly nodeId: string; readonly attemptId: string;
  readonly purpose: Purpose;
  readonly repair: 'none' | 'format' | 'implementation';
  readonly transportRetryOf: string | null;
  readonly requestDigest: Digest;
  readonly inputUpperBound: number; readonly outputUpperBound: number;
  readonly totalUpperBound: number;
  readonly capability: Capability;
  readonly operationId: string; readonly targetIdentity: string;
};
export type OperationIntent = {
  readonly operationId: string; readonly nodeId: string; readonly attemptId: string;
  readonly effect: 'read_only' | 'local_write' | 'external_write';
  readonly requestDigest: Digest; readonly targetIdentity: string;
};
export type ReceiptSubject = {
  readonly storeId: string; readonly runId: string; readonly lockHash: Digest;
  readonly operationId: string; readonly requestId: string | null;
  readonly intentDigest: Digest; readonly dispatchGeneration: number;
  readonly dispatchId: string;
};
export type TrustedEvidence = {
  readonly evidenceId: string; readonly producerId: string; readonly method: string;
  readonly subject: ReceiptSubject; readonly artifact: ArtifactRef;
};
export type RequestObservation = {
  readonly receiptId: string; readonly evidence: TrustedEvidence;
  readonly termination: 'confirmed' | 'unknown';
  readonly outcome: 'succeeded' | 'failed' | null;
  readonly usage: RequestUsage;
};
export type RequestResolution =
  | { readonly kind: 'terminal_usage'; readonly observation: RequestObservation }
  | { readonly kind: 'not_executed'; readonly receiptId: string;
      readonly evidence: TrustedEvidence };
export type OperationReceipt = {
  readonly receiptId: string; readonly evidence: TrustedEvidence;
  readonly outcome: 'succeeded' | 'failed' | 'not_executed';
};
export type UnresolvedReason = 'timeout' | 'cancellation' | 'connection_lost' | 'owner_lost';
export type DispatchPermit = {
  readonly storeId: string; readonly runId: string; readonly lockHash: Digest;
  readonly operationId: string; readonly requestId: string | null;
  readonly generation: number; readonly dispatchId: string;
  readonly authorizedRevision: number;
  readonly clockEpoch: string; readonly notAfterMonotonicMs: MonotonicMs;
  readonly notAfterMs: number; // display-only projection, never an authorization clock
};
export type DispatchResult<T> =
  | { readonly kind: 'new_dispatch'; readonly revision: number;
      readonly permit: DispatchPermit; readonly record: T }
  | { readonly kind: 'existing'; readonly revision: number; readonly record: T };
export type CheckpointInput = {
  readonly checkpointId: string; readonly expectedRevision: number;
  readonly candidateManifest: unknown; // validated through core bindSubject
  readonly workspace: ArtifactRef;
  readonly privateSession: ArtifactRef | null;
  readonly additionalArtifacts: readonly ArtifactRef[];
};
export type PageCursor = {
  readonly storeId: string; readonly runId: string;
  readonly collection: 'requests' | 'operations' | 'checkpoints';
  readonly revision: number; readonly afterSequence: number;
};
export type Page<T> = {
  readonly revision: number; readonly items: readonly T[];
  readonly next: PageCursor | null;
};
export type OwnerStatus = {
  readonly generation: number; readonly ownerId: string | null;
  readonly mode: 'active' | 'recovery' | null; readonly leaseUntilMs: number | null;
  readonly leaseGrantedMonotonicMs: MonotonicMs | null; readonly leaseUntilMonotonicMs: MonotonicMs | null;
};
export type Violation = 'reservation_exceeded' | 'budget_exceeded' | 'usage_overflow' | 'clock_untrusted';
export type LedgerView = {
  readonly admittedCalls: number; readonly formatRepairs: number; readonly implementationRepairs: number;
  readonly transportRetries: number; readonly heldSlots: number;
  readonly reportedTokens: ExactTotal; readonly estimatedTokens: ExactTotal;
  readonly unknownTokenRequests: number; readonly reservedCharge: ExactTotal;
  readonly chargedTokens: ExactTotal; readonly remainingTokens: ExactTotal;
  readonly reportedCostMicrousd: ExactTotal; readonly estimatedCostMicrousd: ExactTotal;
  readonly unknownCostRequests: number; readonly violations: readonly Violation[];
};
export type RecordCounts = {
  readonly requests: number; readonly operations: number; readonly checkpoints: number;
  readonly reservedRequests: number; readonly dispatchedRequests: number; readonly observedRequests: number;
  readonly unresolvedRequests: number; readonly releasedRequests: number; readonly unresolvedOperations: number;
};
export type RunView = {
  readonly storeId: string; readonly runId: string; readonly lockHash: Digest; readonly identityDigest: Digest;
  readonly startedAtMs: number; readonly deadlineMs: number; readonly revision: number;
  readonly owner: OwnerStatus; readonly policy: StatePolicy; readonly binding: CompatibilityBinding;
  readonly clockStatus: 'trusted' | 'blocked'; readonly clock: ClockView;
  readonly ledger: LedgerView; readonly counts: RecordCounts;
};
export type RequestRecord = {
  readonly sequence: number; readonly admission: RequestAdmission; readonly admissionDigest: Digest;
  readonly admissionGeneration: number;
  readonly state: 'reserved' | 'dispatch_authorized' | 'observed' | 'unresolved' | 'released';
  readonly dispatch: { readonly generation: number; readonly dispatchId: string; readonly revision: number } | null;
  readonly holdsSlot: boolean; readonly chargedTokens: ExactTotal;
  readonly initialObservation: RequestObservation | null; readonly resolution: RequestResolution | null;
  readonly unresolvedReason: UnresolvedReason | null; readonly violations: readonly Violation[];
};
export type ModelIntent = Omit<OperationIntent, 'effect'> & { readonly effect: 'model_call' };
export type OperationRecord = {
  readonly sequence: number; readonly intent: OperationIntent | ModelIntent; readonly intentDigest: Digest;
  readonly intentGeneration: number; readonly linkedRequestId: string | null;
  readonly state: 'intent' | 'dispatch_uncertain' | 'confirmed' | 'unresolved' | 'abandoned';
  readonly dispatch: { readonly generation: number; readonly dispatchId: string; readonly revision: number } | null;
  readonly initialReceipt: OperationReceipt | null; readonly reconciliation: OperationReceipt | null;
  readonly unresolvedReason: UnresolvedReason | null;
};
export type CheckpointRecord = {
  readonly sequence: number; readonly checkpointId: string; readonly inputDigest: Digest; readonly subject: Subject;
  readonly workspace: ArtifactRef; readonly privateSession: ArtifactRef | null; readonly additionalArtifacts: readonly ArtifactRef[];
  readonly storeId: string; readonly runId: string; readonly lockHash: Digest; readonly binding: CompatibilityBinding;
  readonly formatVersion: 1; readonly generation: number; readonly publishedRevision: number;
  readonly startedAtMs: number; readonly deadlineMs: number; readonly clockBasis: ClockBasis; readonly clockSample: ClockSample;
  readonly ledger: LedgerView; readonly ledgerRoot: Digest; readonly counts: RecordCounts;
};
export type RecoveryView = { readonly checkpoint: CheckpointRecord; readonly current: RunView; readonly ledgerAdvanced: boolean; readonly requiresReconciliation: boolean };
