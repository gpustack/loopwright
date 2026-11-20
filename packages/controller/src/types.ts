import type { ArtifactRef, Digest, FindingSeverity, OverlayLimits, ReworkPolicy, RunResult, StructuredFinding, TaskContract, Subject } from '@loopwright/core';
import type { AdapterPolicyV2, AdapterPolicy, RuntimeIdentity } from '@loopwright/agent-pi';
import type { ControllerDiagnostic } from './errors.js';
import type { ControllerIncident } from './finalize.js';
import type { Json, Scalar } from './schema.js';
export type { FindingSeverity, OverlayLimits, ReworkPolicy, StructuredFinding };
export const CONTROLLER_API_VERSION = 'loopwright.dev/v1alpha1' as const;
export type Implementation =
  | 'pi.agent.v1'
  | 'pi.compact.v1'
  | 'scope.v1'
  | 'json-artifact.v1'
  | 'json-keys-guard.v1'
  | 'line-section-guard.v1'
  | 'no-change.v1'
  | 'gate.v1';
export type RoleAdapterKind = 'pi' | 'delegated';
export type StepVerdictDisposition = 'pass' | 'rework' | 'fail' | 'human';
export interface StepVerdict {
  readonly verdict: StepVerdictDisposition;
  readonly summary: string;
  readonly findings: readonly StructuredFinding[];
}
export interface RecordedStepVerdict {
  readonly attemptId: string | null;
  readonly stepId: string;
  readonly roleId: string | null;
  readonly reworkEpoch: number;
  readonly generation: number;
  readonly raw: ArtifactRef;
  readonly verdict: StepVerdict;
}
export interface StoredStepVerdict {
  readonly attemptId: string | null;
  readonly stepId: string;
  readonly roleId: string | null;
  readonly reworkEpoch: number;
  readonly generation: number;
  readonly raw: ArtifactRef;
  readonly verdict: StepVerdictDisposition;
  readonly summaryPreview: string;
  readonly findingCount: number;
}
export interface StepReworkContext {
  readonly epoch: number;
  readonly count: number;
  readonly maxReworks: number;
  readonly fromStepId: string;
  readonly summary: string;
  readonly findings: readonly StructuredFinding[];
}
export interface StepMcpServerMetadata {
  readonly id: string;
  readonly transport: 'stdio' | 'http';
  readonly toolNames: readonly string[];
}
export type AdvisoryDecisionSource = 'jev' | 'deterministic_fallback' | 'deterministic_heuristic' | 'user_override';
export type AdvisoryDecisionZone = 'high' | 'medium' | 'low';
export type AdvisoryCapabilityTier = 'fast' | 'balanced' | 'strongest';
export interface CapabilityRoutingDecisionInput {
  readonly runId: string;
  readonly stepId: string;
  readonly roleId: string;
  readonly taskKind: string;
  readonly estimatedFilesCount: number;
  readonly hasFailingTests: boolean;
  readonly requiresArchitectureChange: boolean;
  readonly candidateSkills: readonly string[];
  readonly pinnedModel: { readonly provider: string; readonly model: string; readonly thinking: string };
}
export interface CapabilityRoutingDecisionOutput {
  readonly tier: AdvisoryCapabilityTier;
  readonly skills?: readonly string[];
  readonly source: AdvisoryDecisionSource;
  readonly zone?: AdvisoryDecisionZone | null;
}
export type CycleAlignmentRoute = 'continue' | 'revise' | 'needs_review' | 'blocked';
export interface CycleAlignmentDecisionInput {
  readonly runId: string;
  readonly trigger: 'implementation_repair' | 'rework';
  readonly targetStepId: string;
  readonly contractHash: Digest;
  readonly baseRevision: string;
  readonly candidateDigest: Digest;
  readonly reworkEpoch: number;
  readonly remainingAttempts: number;
  readonly contextUtilization: number;
  readonly failedVerificationLoops: number;
}
export interface CycleAlignmentDecisionOutput {
  readonly route: CycleAlignmentRoute;
  readonly precheckPassed: boolean;
  readonly source: AdvisoryDecisionSource;
  readonly zone?: AdvisoryDecisionZone | null;
}
export interface SoftCompactionDecisionInput {
  readonly runId: string;
  readonly stepId: string;
  readonly roleId: string;
  readonly contextUtilization: number;
  readonly failedVerificationLoops: number;
}
export interface SoftCompactionDecisionOutput {
  readonly advisoryDecision: 'compact' | 'defer' | null;
  readonly hardTriggerActive?: boolean;
  readonly hardTriggerVetoRefused?: boolean;
  readonly source: AdvisoryDecisionSource;
  readonly zone?: AdvisoryDecisionZone | null;
}
export type CandidateDiffTriageSeverity = 'blocking' | 'important' | 'nit';
export interface CandidateDiffSummary {
  readonly changedFiles: readonly string[];
  readonly addedLines: number;
  readonly deletedLines: number;
  readonly touchedPackages: readonly string[];
  readonly redactedHunkSummaries: readonly string[];
}
export interface CandidateDiffTriageEscalation {
  readonly ruleId: string;
  readonly severity: CandidateDiffTriageSeverity;
  readonly source: AdvisoryDecisionSource;
  readonly zone?: AdvisoryDecisionZone | null;
  readonly advisoryOnly: true;
}
export interface CandidateDiffTriageInput {
  readonly runId: string;
  readonly stepId: string;
  readonly attemptId: string;
  readonly candidateDigest: Digest;
  readonly summary: CandidateDiffSummary;
}
export interface CandidateDiffTriageOutput {
  readonly escalated: readonly CandidateDiffTriageEscalation[];
  readonly verificationCertified: false;
  readonly source: AdvisoryDecisionSource;
  readonly zone?: AdvisoryDecisionZone | null;
}
/** Zero-dependency advisory decision port matching the four non-authoritative intents in `@loopwright/decisions`. */
export interface AdvisoryDecisionPort {
  readonly routeCapabilityTier?: (input: CapabilityRoutingDecisionInput) => Promise<CapabilityRoutingDecisionOutput | null>;
  readonly evaluateCycleAlignment?: (input: CycleAlignmentDecisionInput) => Promise<CycleAlignmentDecisionOutput | null>;
  readonly adviseSoftCompaction?: (input: SoftCompactionDecisionInput) => Promise<SoftCompactionDecisionOutput | null>;
  readonly triageCandidateDiff?: (input: CandidateDiffTriageInput) => Promise<CandidateDiffTriageOutput | null>;
}
export type CycleExecution =
  | {
      readonly kind: 'result';
      readonly version: 1;
      readonly runId: string;
      readonly result: RunResult;
      readonly observations: ArtifactRef | null;
      readonly secondary: readonly ControllerDiagnostic['code'][];
      readonly findings?: readonly StructuredFinding[];
      readonly stepVerdicts?: readonly RecordedStepVerdict[];
    }
  | { readonly kind: 'incident'; readonly version: 1; readonly incident: ControllerIncident };
export interface DelegatedSelection { readonly provider: string; readonly model: string; readonly thinking: string; readonly api?: AdapterPolicy['selection']['api']; readonly customProvider?: AdapterPolicy['selection']['customProvider'] }
export interface RoleSelectionOverride { readonly provider: string; readonly model: string; readonly thinking?: string }
export interface RoleModelOverride extends RoleSelectionOverride { readonly roleId: string }
export interface Handler {
  readonly id: string; readonly version: 1; readonly digest: Digest; readonly kind: 'agent' | 'check'; readonly implementation: Implementation;
  readonly parameters: Readonly<Record<string, Json>>; readonly capabilities: readonly string[];
}
export interface RoleProfile {
  readonly id: string; readonly adapter?: RoleAdapterKind; readonly selection: AdapterPolicy['selection'] | DelegatedSelection; readonly tools: readonly string[]; readonly context: AdapterPolicy['context'];
  readonly runtimeRef: string | null; readonly providerCredentialRef: string | null; readonly mcp: AdapterPolicyV2['mcp'] | null;
  readonly limits?: Partial<AdapterPolicy['limits']> | undefined;
}
export interface RegistryResource { readonly id: string; readonly kind: 'instruction' | 'skill' | 'document'; readonly path: string; readonly digest: Digest }
export interface RuntimeProfile { readonly id: string; readonly identity: RuntimeIdentity; readonly dockerExecutable: string; readonly dockerSocket: string }
export interface CredentialBinding { readonly id: string; readonly consumer: 'provider' | 'mcp' | 'gate' | 'publisher'; readonly destinationRef: string; readonly environmentNames: readonly string[]; readonly template: string }
export interface EnvironmentBinding { readonly name: string; readonly classification: 'nonsecret' | 'credential'; readonly paths: readonly string[] }
export interface GateEndpoint {
  readonly id: string; readonly url: string; readonly signingCredentialRef: string; readonly authCredentialRef: string | null;
  readonly timeoutMs: number; readonly maxPollMs: number; readonly pollInitialMs: number; readonly pollMaxMs: number; readonly jitter: number;
}
export interface PublicationEndpoint {
  readonly id: string; readonly url: string; readonly signingCredentialRef: string; readonly authCredentialRef: string | null; readonly timeoutMs: number;
}
export type PublicationConfig = { readonly mode: 'disabled' }
  | { readonly mode: 'pull_request'; readonly endpointRef: string; readonly targetBranch: string; readonly headBranchPrefix: string; readonly titleTemplate: string };
export interface TrustedRegistry {
  readonly apiVersion: typeof CONTROLLER_API_VERSION; readonly kind: 'TrustedRegistry'; readonly metadata: { readonly name: string };
  readonly spec: { readonly version: 1; readonly resourceVersion: string; readonly handlers: readonly Handler[]; readonly roleProfiles: readonly RoleProfile[];
    readonly resources: readonly RegistryResource[]; readonly runtimeProfiles: readonly RuntimeProfile[];
    readonly credentialBindings: readonly CredentialBinding[]; readonly environmentBindings: readonly EnvironmentBinding[];
    readonly gateEndpoints: readonly GateEndpoint[]; readonly publicationEndpoints: readonly PublicationEndpoint[] };
}
export interface Controls {
  readonly drainReserveMs: number; readonly maxAttempts: number; readonly repeatFailureLimit: 2;
  readonly submission: { readonly mode: 'artifact_or_assistant'; readonly path: string | null };
}
export interface ControllerConfiguration {
  readonly apiVersion: typeof CONTROLLER_API_VERSION; readonly kind: 'ControllerConfig';
  readonly spec: { readonly task: TaskContract; readonly registry: { readonly name: string; readonly digest: Digest };
    readonly profiles: { readonly roles: readonly { readonly roleId: string; readonly profileRef: string; readonly selection?: RoleSelectionOverride }[]; readonly steps: readonly { readonly stepId: string; readonly handlerRef: string }[] };
    /** Original approved templates, never their expansions. */
    readonly credentials: readonly { readonly ref: string; readonly template: string }[]; readonly controls: Controls; readonly publication: PublicationConfig };
}
export interface LoadConfigurationInput {
  readonly configPath: string; readonly registryPath: string; readonly registrySha256: string;
  /** Additional repository/candidate/task-writable roots, beyond cwd and the configuration directory. */
  readonly untrustedRoots: readonly string[];
  readonly roleModelOverrides?: readonly RoleModelOverride[];
}
/** Only loader-owned instances are accepted by compile/run. This view contains no resolved credential. */
export interface LoadedConfiguration {
  readonly version: 1; readonly configuration: ControllerConfiguration; readonly registry: TrustedRegistry;
  readonly sourceDigest: Digest; readonly registryDigest: Digest;
}
export interface CheckpointCapacity { readonly A: number; readonly N: number; readonly I: number; readonly C: number; readonly V: number; readonly J: number; readonly D: number;
  readonly publication: boolean; readonly additionalRefs: 4; readonly requiredRefs: 6; readonly checkpointBytes: 40960 }
export interface VerifierSlot { readonly id: string; readonly checkId: string; readonly implicit: 'scope' | 'no_change' | null; readonly handler: Handler }
export interface PlannedRole { readonly roleId: string; readonly adapter: RoleAdapterKind; readonly profileRef: string; readonly providerCredentialRef: string | null; readonly runtime: RuntimeProfile; readonly policy: AdapterPolicyV2 }
export interface CompiledPlan {
  readonly version: 1; readonly runId: null; readonly lock: null; readonly admission: 'not_performed'; readonly effectfulReadiness: 'not_checked';
  readonly sourceDocumentDigest: Digest; readonly taskByteDigest: Digest; readonly registryDigest: Digest; readonly planDigest: Digest;
  readonly task: TaskContract; readonly orderedDAG: readonly { readonly id: string; readonly kind: 'agent' | 'check'; readonly dependsOn: readonly string[]; readonly roleId: string | null; readonly handler: Handler; readonly onRework?: ReworkPolicy }[];
  readonly scope: TaskContract['spec']['scope']; readonly budgets: TaskContract['spec']['budgets']; readonly controls: Controls;
  readonly roles: readonly PlannedRole[]; readonly resources: readonly { readonly id: string; readonly kind: RegistryResource['kind']; readonly ref: ArtifactRef }[];
  readonly credentialReferences: readonly { readonly ref: string; readonly consumer: CredentialBinding['consumer']; readonly destinationRef: string }[];
  readonly publication: PublicationConfig;
  readonly verifierSlots: readonly VerifierSlot[]; readonly capacity: CheckpointCapacity;
  readonly noChangeEligibility: { readonly available: boolean; readonly checkId: string | null; readonly reason: 'original_required_no_change_check_missing' | null };
  readonly verificationLimits: { readonly headerBytes: 16384; readonly packetBytes: 1048576; readonly jsonFileBytes: 1032184;
    readonly jsonHeaderEligibility: 'complete_manifests_and_max_framing_must_fit' };
  readonly capabilities: readonly { readonly component: string; readonly disposition: 'supported'; readonly readiness: 'not_checked' }[];
  readonly evidenceNeeds: readonly { readonly checkId: string; readonly levels: readonly string[] }[];
}
export interface JsonExpectations { readonly checkId: string; readonly path: string; readonly required: readonly string[]; readonly equals: Readonly<Record<string, Scalar>> }
export type ProgressKind = 'bootstrap' | 'role_pre' | 'role_post' | 'verifier_pre' | 'verifier_post' | 'publication_pre' | 'publication_post' | 'terminal_intent' | 'terminal_result' | 'terminal_observations' | 'reconcile_result';
export interface Watermarks { readonly requests: number; readonly operations: number }
export interface ControllerAttempt {
  readonly ordinal: number; readonly id: string; readonly nodeId: string; readonly nativeStepId: string; readonly sessionId: string; readonly purpose: 'task' | 'reviewer' | 'compaction';
  readonly repair: 'none' | 'format' | 'implementation'; readonly command: ArtifactRef; readonly before: Watermarks;
  readonly finished: null | { readonly after: Watermarks; readonly outcome: ArtifactRef; readonly nativeCheckpointId: string | null };
  readonly reworkEpoch?: number;
}
export interface VerifierRefusalRow { readonly slot: string; readonly generation: number; readonly prospectiveOperationId: string; readonly producerNonce: string; readonly subject: Subject; readonly record: ArtifactRef }
export interface ControllerProgress {
  readonly version: 2; readonly runId: string; readonly lockHash: Digest; readonly sequence: number; readonly previous: ArtifactRef | null;
  readonly stage: { readonly kind: ProgressKind; readonly phase: string; readonly capacity: CheckpointCapacity; readonly consumed: readonly string[]; readonly watermarks: Watermarks };
  readonly nodes: readonly { readonly id: string; readonly state: 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'not_run' }[];
  readonly attempts: readonly ControllerAttempt[];
  readonly nativeCheckpoints: readonly { readonly attemptId: string; readonly checkpointId: string; readonly outcome: ArtifactRef }[];
  readonly submission: ArtifactRef | null;
  readonly publication: { readonly status: 'idle' | 'pending' | 'confirmed' | 'failed' | 'unresolved'; readonly operationId: string | null; readonly receipt: ArtifactRef | null };
  readonly candidate: { readonly manifest: ArtifactRef; readonly digest: Digest; readonly generation: number; readonly workspace: ArtifactRef; readonly privateSession: ArtifactRef | null };
  readonly failures: readonly { readonly signature: Digest; readonly count: number; readonly generation: number; readonly evidence: ArtifactRef | null }[];
  readonly verifierReceipts: readonly { readonly slot: string; readonly generation: number; readonly operationId: string; readonly producerNonce: string; readonly output: ArtifactRef | null; readonly receipt: ArtifactRef | null; readonly reworkEpoch?: number }[];
  readonly verifierRefusals: readonly VerifierRefusalRow[];
  readonly eventSequence: number; readonly terminalIntent: null | { readonly primary: string; readonly result: ArtifactRef | null; readonly observations: ArtifactRef | null };
  readonly reworkEpoch?: number;
  readonly reworkCounts?: Readonly<Record<string, number>>;
  readonly nodeSubmissions?: Readonly<Record<string, ArtifactRef>>;
  readonly stepVerdicts?: readonly StoredStepVerdict[];
}
export interface ReceiptIndex {
  readonly version: 1; readonly runId: string;
  readonly entries: readonly { readonly id: string; readonly kind: 'plan' | 'source' | 'role' | 'verifier-output' | 'verifier-receipt' | 'preflight-refusal' | 'publication-receipt' | 'result' | 'observations'; readonly ref: ArtifactRef }[];
}
export interface StepYield {
  readonly kind: 'step';
  readonly status: 'awaiting_role';
  readonly runId: string;
  readonly attemptId: string;
  readonly stepId: string;
  readonly roleId: string;
  readonly purpose: 'task' | 'reviewer';
  readonly repair: 'none' | 'format' | 'implementation';
  readonly selection: DelegatedSelection;
  readonly allowedTools: readonly string[];
  readonly allowedMcpServers: readonly string[];
  readonly mcpServers: readonly StepMcpServerMetadata[];
  readonly scope: TaskContract['spec']['scope'];
  readonly allowWorkflowWrites: boolean;
  readonly candidateDir: string;
  readonly contextFiles: readonly string[];
  readonly prompt: string;
  readonly reworkEpoch: number;
  readonly rework: StepReworkContext | null;
  readonly submissionMode: 'artifact_or_assistant';
  readonly submissionPath: string | null;
  readonly leaseToken: string;
}
