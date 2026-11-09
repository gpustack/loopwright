import type { ArtifactRef, Digest, TaskContract, Subject } from '@loopwright/core';
import type { AdapterPolicyV2, AdapterPolicy, RuntimeIdentity } from '@loopwright/agent-pi';
import type { Json, Scalar } from './schema.js';
export const CONTROLLER_API_VERSION = 'loopwright.dev/controller/v1alpha1' as const;
export type Implementation = 'pi.agent.v1' | 'pi.compact.v1' | 'scope.v1' | 'json-artifact.v1' | 'no-change.v1';
export interface Handler {
  readonly id: string; readonly version: 1; readonly digest: Digest; readonly kind: 'agent' | 'check'; readonly implementation: Implementation;
  readonly parameters: Readonly<Record<string, Json>>; readonly capabilities: readonly string[];
}
export interface RoleProfile {
  readonly id: string; readonly selection: AdapterPolicy['selection']; readonly tools: readonly string[]; readonly context: AdapterPolicy['context'];
  readonly runtimeRef: string; readonly providerCredentialRef: string | null; readonly mcp: AdapterPolicyV2['mcp'];
}
export interface RegistryResource { readonly id: string; readonly kind: 'instruction' | 'skill' | 'document'; readonly path: string; readonly digest: Digest }
export interface RuntimeProfile { readonly id: string; readonly identity: RuntimeIdentity; readonly dockerExecutable: string; readonly dockerSocket: string }
export interface CredentialBinding { readonly id: string; readonly consumer: 'provider' | 'mcp'; readonly destinationRef: string; readonly environmentNames: readonly string[]; readonly template: string }
export interface EnvironmentBinding { readonly name: string; readonly classification: 'nonsecret' | 'credential'; readonly paths: readonly string[] }
export interface TrustedRegistry {
  readonly apiVersion: typeof CONTROLLER_API_VERSION; readonly kind: 'TrustedRegistry'; readonly metadata: { readonly id: string };
  readonly spec: { readonly version: 1; readonly resourceVersion: string; readonly handlers: readonly Handler[]; readonly roleProfiles: readonly RoleProfile[];
    readonly resources: readonly RegistryResource[]; readonly runtimeProfiles: readonly RuntimeProfile[];
    readonly credentialBindings: readonly CredentialBinding[]; readonly environmentBindings: readonly EnvironmentBinding[] };
}
export interface Controls {
  readonly drainReserveMs: number; readonly maxAttempts: number; readonly repeatFailureLimit: 2;
  readonly submission: { readonly mode: 'artifact_or_assistant'; readonly path: string | null };
}
export interface ControllerConfiguration {
  readonly apiVersion: typeof CONTROLLER_API_VERSION; readonly kind: 'ControllerConfig'; readonly metadata: { readonly id: string };
  readonly spec: { readonly task: TaskContract; readonly registry: { readonly id: string; readonly digest: Digest };
    readonly profiles: { readonly roles: readonly { readonly roleId: string; readonly profileRef: string }[]; readonly steps: readonly { readonly stepId: string; readonly handlerRef: string }[] };
    /** Original approved templates, never their expansions. */
    readonly credentials: readonly { readonly ref: string; readonly template: string }[]; readonly controls: Controls };
}
export interface LoadConfigurationInput {
  readonly configPath: string; readonly registryPath: string; readonly registrySha256: string;
  /** Additional repository/candidate/task-writable roots, beyond cwd and the configuration directory. */
  readonly untrustedRoots: readonly string[];
}
/** Only loader-owned instances are accepted by compile/run. This view contains no resolved credential. */
export interface LoadedConfiguration {
  readonly version: 1; readonly configuration: ControllerConfiguration; readonly registry: TrustedRegistry;
  readonly sourceDigest: Digest; readonly registryDigest: Digest;
}
export interface CheckpointCapacity { readonly A: number; readonly N: number; readonly I: number; readonly C: number; readonly V: number; readonly J: number; readonly D: number;
  readonly additionalRefs: 4; readonly requiredRefs: 6; readonly checkpointBytes: 40960 }
export interface VerifierSlot { readonly id: string; readonly checkId: string; readonly implicit: 'scope' | 'no_change' | null; readonly handler: Handler }
export interface PlannedRole { readonly roleId: string; readonly profileRef: string; readonly providerCredentialRef: string | null; readonly runtime: RuntimeProfile; readonly policy: AdapterPolicyV2 }
export interface CompiledPlan {
  readonly version: 1; readonly runId: null; readonly lock: null; readonly admission: 'not_performed'; readonly effectfulReadiness: 'not_checked';
  readonly sourceDocumentDigest: Digest; readonly taskByteDigest: Digest; readonly registryDigest: Digest; readonly planDigest: Digest;
  readonly task: TaskContract; readonly orderedDAG: readonly { readonly id: string; readonly kind: 'agent' | 'check'; readonly dependsOn: readonly string[]; readonly roleId: string | null; readonly handler: Handler }[];
  readonly scope: TaskContract['spec']['scope']; readonly budgets: TaskContract['spec']['budgets']; readonly controls: Controls;
  readonly roles: readonly PlannedRole[]; readonly resources: readonly { readonly id: string; readonly kind: RegistryResource['kind']; readonly ref: ArtifactRef }[];
  readonly credentialReferences: readonly { readonly ref: string; readonly consumer: CredentialBinding['consumer']; readonly destinationRef: string }[];
  readonly verifierSlots: readonly VerifierSlot[]; readonly capacity: CheckpointCapacity;
  readonly noChangeEligibility: { readonly available: boolean; readonly checkId: string | null; readonly reason: 'original_required_no_change_check_missing' | null };
  readonly verificationLimits: { readonly headerBytes: 16384; readonly packetBytes: 1048576; readonly jsonFileBytes: 1032184;
    readonly jsonHeaderEligibility: 'complete_manifests_and_max_framing_must_fit' };
  readonly capabilities: readonly { readonly component: string; readonly disposition: 'supported'; readonly readiness: 'not_checked' }[];
  readonly evidenceNeeds: readonly { readonly checkId: string; readonly levels: readonly string[] }[];
}
export interface JsonExpectations { readonly checkId: string; readonly path: string; readonly required: readonly string[]; readonly equals: Readonly<Record<string, Scalar>> }
export type ProgressKind = 'bootstrap' | 'role_pre' | 'role_post' | 'verifier_pre' | 'verifier_post' | 'terminal_intent' | 'terminal_result' | 'terminal_observations';
export interface Watermarks { readonly requests: number; readonly operations: number }
export interface ControllerAttempt {
  readonly ordinal: number; readonly id: string; readonly nodeId: string; readonly nativeStepId: string; readonly sessionId: string; readonly purpose: 'task' | 'reviewer' | 'compaction';
  readonly repair: 'none' | 'format' | 'implementation'; readonly command: ArtifactRef; readonly before: Watermarks;
  readonly finished: null | { readonly after: Watermarks; readonly outcome: ArtifactRef; readonly nativeCheckpointId: string | null };
}
export interface VerifierRefusalRow { readonly slot: string; readonly generation: number; readonly prospectiveOperationId: string; readonly producerNonce: string; readonly subject: Subject; readonly record: ArtifactRef }
export interface ControllerProgress {
  readonly version: 2; readonly runId: string; readonly lockHash: Digest; readonly sequence: number; readonly previous: ArtifactRef | null;
  readonly stage: { readonly kind: ProgressKind; readonly phase: string; readonly capacity: CheckpointCapacity; readonly consumed: readonly string[]; readonly watermarks: Watermarks };
  readonly nodes: readonly { readonly id: string; readonly state: 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'not_run' }[];
  readonly attempts: readonly ControllerAttempt[];
  readonly nativeCheckpoints: readonly { readonly attemptId: string; readonly checkpointId: string; readonly outcome: ArtifactRef }[];
  readonly submission: ArtifactRef | null;
  readonly candidate: { readonly manifest: ArtifactRef; readonly digest: Digest; readonly generation: number; readonly workspace: ArtifactRef; readonly privateSession: ArtifactRef | null };
  readonly failures: readonly { readonly signature: Digest; readonly count: number; readonly generation: number; readonly evidence: ArtifactRef | null }[];
  readonly verifierReceipts: readonly { readonly slot: string; readonly generation: number; readonly operationId: string; readonly producerNonce: string; readonly output: ArtifactRef | null; readonly receipt: ArtifactRef | null }[];
  readonly verifierRefusals: readonly VerifierRefusalRow[];
  readonly eventSequence: number; readonly terminalIntent: null | { readonly primary: string; readonly result: ArtifactRef | null; readonly observations: ArtifactRef | null };
}
export interface ReceiptIndex {
  readonly version: 1; readonly runId: string;
  readonly entries: readonly { readonly id: string; readonly kind: 'plan' | 'source' | 'role' | 'verifier-output' | 'verifier-receipt' | 'preflight-refusal' | 'result' | 'observations'; readonly ref: ArtifactRef }[];
}
