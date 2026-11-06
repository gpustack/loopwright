import type { ArtifactManifest, ArtifactRef, Digest, TaskLock } from '@loopwright/core';
import type { Authority, LocalRunStore, Purpose, StateErrorCode } from '@loopwright/state';
import type { ContextAssessment } from './context.js';
export type PiContextAssessment = ContextAssessment;
export interface PiContextRecord {
  readonly version: 1; readonly assessmentId: string; readonly requestId: string | null;
  readonly decision: 'admitted' | 'refused'; readonly code: 'CONTEXT_UNSAFE' | null;
  readonly policyDigest: Digest; readonly catalogDigest: Digest; readonly catalogWindow: number;
  readonly model: AdapterPolicy['selection']; readonly assessment: PiContextAssessment | null;
}
export type PiErrorCode = 'INPUT_INVALID' | 'BINDING_MISMATCH' | 'RUNTIME_UNSUPPORTED' | 'RUNTIME_MISMATCH' | 'RESOURCE_MISMATCH'
  | 'MODEL_UNAVAILABLE' | 'THINKING_UNSUPPORTED' | 'CAPABILITY_UNSUPPORTED' | 'EXTENSION_UNSUPPORTED'
  | 'CONTAINMENT_UNAVAILABLE' | 'CONTAINMENT_MISMATCH' | 'SESSION_BUSY' | 'AUTHORITY_REFUSED' | 'STATE_REFUSED'
  | 'REQUEST_REFUSED' | 'SEND_PATH_UNSUPPORTED' | 'PAYLOAD_MISMATCH' | 'CONTEXT_UNSAFE' | 'CONTEXT_LIMIT'
  | 'PROVIDER_RESPONSE_INVALID' | 'RESPONSE_INCOMPLETE' | 'TOOL_DENIED' | 'MCP_FAILED' | 'OUTPUT_LIMIT'
  | 'EVENT_OVERFLOW' | 'DEADLINE' | 'CANCELLED' | 'RECOVERY_REQUIRED' | 'CLEANUP_FAILED';
export interface PiError {
  readonly code: PiErrorCode; readonly path: string;
  readonly phase: 'preflight' | 'admission' | 'dispatch' | 'tool' | 'session' | 'restore' | 'cleanup';
  readonly retryable: boolean; readonly effect: 'none' | 'possible' | 'confirmed';
  readonly requestId: string | null; readonly operationId: string | null; readonly stateErrorCode: StateErrorCode | null;
}
export type PiResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: PiError };
export interface RuntimeIdentity {
  readonly sdkIntegrity: string; readonly graphDigest: Digest; readonly imageDigest: string;
  readonly configDigest: Digest; readonly profile: 'linux/arm64';
}
/** Trusted construction only: these functions and paths are never accepted from model policy JSON. */
export interface PiHost {
  readonly store: LocalRunStore; readonly authority: Authority;
  readonly directory: string; readonly artifactsDirectory: string;
  readonly dockerExecutable: string; readonly dockerSocket: string;
  readonly runtime: RuntimeIdentity;
  readonly resolveCredential: (binding: { readonly provider: string; readonly model: string; readonly destination: string; readonly purpose: Purpose; readonly runId: string; readonly roleId: string; readonly stepId: string; readonly notAfterMonotonicMs: string; readonly signal: AbortSignal }) => Promise<{ readonly bearerToken: string }>;
}
export interface ResourceIdentity {
  readonly id: string; readonly kind: 'instruction' | 'skill' | 'document'; readonly path: string; readonly digest: Digest;
}
export interface PiLimits {
  readonly promptBytes: number; readonly diagnosticBytes: number; readonly responseBytes: number; readonly frameBytes: number;
  readonly eventBytes: number; readonly pendingResponseBytes: number; readonly eventQueue: number; readonly eventQueueBytes: number;
  readonly toolArgsBytes: number; readonly toolResultBytes: number; readonly sessionBytes: number; readonly artifactBytes: number;
  readonly candidateEntries: number; readonly fileBytes: number; readonly toolWallMs: number;
  readonly requests: number; readonly operations: number; readonly checkpoints: number;
}
export interface AdapterPolicy {
  readonly version: 1; readonly policyId: string; readonly resourceVersion: string; readonly adapterId: 'pi'; readonly adapterVersion: '0.0.0';
  readonly runtime: RuntimeIdentity;
  readonly selection: { readonly provider: string; readonly model: string; readonly thinking: string; readonly api: 'anthropic-messages' };
  readonly resources: readonly ResourceIdentity[]; readonly tools: readonly string[];
  readonly mcp: { readonly serverId: 'workspace'; readonly scriptDigest: Digest; readonly names: readonly string[];
    readonly effects: readonly 'read_only'[]; readonly idleTimeoutSeconds: number; readonly absoluteTimeoutSeconds: number };
  readonly context: { readonly mode?: 'proven_bound' | 'estimated_guard'; readonly estimator: 'lw-pi-final-json-bytes-v1';
    readonly proofId: null; readonly version: 1; readonly evidence: 'estimated'; readonly workingWindowCeiling: number;
    readonly maxRequestBytes: number; readonly serviceMargin: number; readonly toolReserve: number; readonly maxOutputTokens: number };
  readonly accounting: 'soft_only'; readonly retry: 'sender_only'; readonly extensions: readonly [];
  readonly privateArtifacts: boolean; readonly limits: PiLimits;
}
export interface PiOpenInput {
  readonly version: 1; readonly lock: TaskLock; readonly roleId: string; readonly stepId: string; readonly sessionId: string;
  readonly policy: AdapterPolicy;
  readonly candidate: { readonly manifest: ArtifactManifest; readonly baseRevision: string; readonly sourceRevision: string;
    readonly artifacts: readonly { readonly name: string; readonly bytes: Uint8Array }[] };
  readonly resources: readonly { readonly id: string; readonly kind: ResourceIdentity['kind']; readonly ref: ArtifactRef; readonly bytes: Uint8Array }[];
  readonly restore: null | { readonly checkpointId: string; readonly workspace: { readonly ref: ArtifactRef; readonly bytes: Uint8Array };
    readonly session: { readonly ref: ArtifactRef; readonly bytes: Uint8Array } };
}
export interface PiCapabilities {
  readonly version: 1; readonly policyDigest: Digest; readonly runtime: RuntimeIdentity;
  readonly requested: AdapterPolicy['selection']; readonly catalogSupported: AdapterPolicy['selection'];
  readonly sessionEffective: AdapterPolicy['selection']; readonly outboundObserved: AdapterPolicy['selection'] | null;
  readonly resources: readonly ResourceIdentity[]; readonly accounting: 'soft_only'; readonly contextFit: 'unproven';
  readonly defaultMode: 'proven_bound'; readonly liveProvenBoundAvailable: false; readonly optInMode: 'estimated_guard';
  readonly toolExecution: { readonly candidate: 'read_only'; readonly candidateWrites: 'mediated'; readonly scratch: 'per_call' };
  readonly contextEstimator: { readonly id: 'lw-pi-final-json-bytes-v1'; readonly version: 1; readonly provenance: 'estimated' };
}
export interface PiCommand {
  readonly commandId: string; readonly text: string; readonly purpose: Purpose; readonly repair: 'none' | 'format' | 'implementation';
}
export interface PiOutcome {
  readonly status: 'execution_settled' | 'failed' | 'cancelled' | 'blocked' | 'recovery_required';
  readonly requestIds: readonly string[]; readonly operationIds: readonly string[];
  readonly providerTermination: 'confirmed' | 'unknown' | 'none'; readonly usage: 'complete' | 'incomplete' | 'none';
  readonly localCleanup: 'complete' | 'pending' | 'failed';
  /** Execution failures are values after a valid command starts; API/preflight refusals remain PiResult errors. */
  readonly error: PiError | null; readonly cleanupError: PiError | null;
}
export interface PiEvent {
  readonly version: 1; readonly sessionId: string; readonly runId: string; readonly roleId: string; readonly stepId: string;
  readonly lockHash: Digest; readonly requestId: string | null; readonly operationId: string | null;
  readonly attemptId: string | null; readonly sequence: number;
  readonly kind: 'resource_identity' | 'context_assessment' | 'request_start' | 'request_receipt' | 'request_uncertain' | 'tool_start' | 'tool_end' | 'retry_wait' | 'cancellation' | 'process_exit' | 'settled';
  readonly code: PiErrorCode | null; readonly count: number | null; readonly digest: Digest | null;
  readonly context: PiContextRecord | null;
}
export interface PiCapture { readonly checkpointId: string; readonly candidate: ArtifactManifest; readonly workspace: ArtifactRef; readonly session: ArtifactRef }
export interface PiAdapter {
  capabilities(): PiCapabilities;
  execute(input: PiCommand): Promise<PiResult<PiOutcome>>;
  compact(input: { readonly commandId: string }): Promise<PiResult<PiOutcome>>;
  events(): AsyncIterable<PiEvent>;
  cancel(input: { readonly reason: 'operator' | 'deadline' | 'consumer_disconnected' }): Promise<PiResult<PiOutcome>>;
  capture(input: { readonly checkpointId: string }): Promise<PiResult<PiCapture>>;
  close(): Promise<PiResult<{ readonly closed: true }>>;
}
