import type {
  Digest,
  OverlayLimits,
  ResourceActivationPhase,
  ResourceActivationRule,
  ReworkPolicy,
  StepHandoffSelect,
  StepHandoffSelector,
  StepHandoffSource,
  TaskContract,
} from '@loopwright/core';
import type { ClockBasis, ClockSample } from '@loopwright/state';
import type {
  PiCustomModelCompat, PiCustomProviderConfig, PiModelCost, PiModelSelection, PiSamplingParams, PiThinkingLevel, PiWireApi,
} from '@loopwright/agent-pi';
import type { openPiHostSessionAdapterV2 } from '@loopwright/agent-pi/host-session';
import type { ControllerConfiguration, RunEvalReport, TrustedRegistry } from '@loopwright/controller';

export type {
  ClockBasis,
  ClockSample,
  PiCustomModelCompat,
  PiCustomProviderConfig,
  PiModelCost,
  PiModelSelection,
  PiSamplingParams,
  PiThinkingLevel,
  PiWireApi,
  ResourceActivationPhase,
  ResourceActivationRule,
  RunEvalReport,
  StepHandoffSelect,
  StepHandoffSelector,
  StepHandoffSource,
};

/** Closed set of matchable failure codes for @loopwright/taskpack (and drop-in superset for @loopwright/github-app). */
export const TASKPACK_ERROR_CODES = Object.freeze([
  'TASKPACK_MANIFEST_INVALID', 'TASKPACK_UNTRUSTED_INTERPOLATION', 'TASKPACK_SCOPE_VIOLATION',
  'TASKPACK_HOST_BINDING_INVALID', 'TASKPACK_TRIGGER_UNSUPPORTED', 'PROVIDER_OAUTH_UNSUPPORTED',
  'WEBHOOK_SIGNATURE_INVALID', 'WEBHOOK_PAYLOAD_TOO_LARGE', 'WEBHOOK_DELIVERY_CONFLICT', 'WEBHOOK_DELIVERY_INVALID',
  'WEBHOOK_ACTOR_UNAUTHORIZED', 'WEBHOOK_GUIDANCE_INVALID',
  'TENANT_IDENTITY_INVALID', 'TENANT_BOUNDARY_VIOLATION',
  'QUEUE_CAPACITY_EXCEEDED', 'QUEUE_LEASE_FENCED', 'QUEUE_STATE_INVALID', 'TENANT_INSTALLATION_REVOKED',
  'TOKEN_BROKER_CONFIG_INVALID', 'TOKEN_SCOPE_VIOLATION', 'TOKEN_SECRET_LEAK_DETECTED', 'TOKEN_TTL_EXCEEDED',
  'HOST_PROFILE_UNQUALIFIED', 'HOST_CLOCK_UNTRUSTED', 'STORAGE_PROFILE_INSUFFICIENT',
  'MCP_OAUTH_UNSUPPORTED', 'MCP_AUTHENTICATION_REQUIRED',
  'SANDBOX_POLICY_INVALID', 'SANDBOX_BACKEND_UNAVAILABLE',
  'SANDBOX_CAPABILITY_INSUFFICIENT', 'SANDBOX_EXECUTION_FAILED',
  'GITHUB_APP_CONFIG_INVALID',
  'ACTION_INPUT_INVALID', 'SERVICE_FAULT',
] as const);
export type TaskpackErrorCode = typeof TASKPACK_ERROR_CODES[number];

export interface TaskpackErrorOptions {
  readonly reason?: string | undefined;
  readonly cause?: unknown;
}

/** Explicit, matchable failure carrying the offending manifest or request path (and optional machine reason) when known. */
export class TaskpackError extends Error {
  readonly code: TaskpackErrorCode;
  readonly path: string | null;
  readonly reason: string | null;
  constructor(
    code: TaskpackErrorCode,
    message: string,
    path: string | null = null,
    options?: TaskpackErrorOptions,
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'TaskpackError';
    this.code = code;
    this.path = path;
    this.reason = options?.reason ?? null;
  }
}

// ---------------------------------------------------------------------------
// Policy profiles & declarative taskpack manifests (<controlRoot>/taskpack.yaml)
// ---------------------------------------------------------------------------

/** Explicit execution policy profile scoping GitHub-specific rules to GitHub entrypoints. */
export type PolicyProfile = 'local' | 'github';

export const TASKPACK_MANIFEST_API_VERSION = 'loopwright.dev/v1alpha1' as const;
export const TASKPACK_MANIFEST_BYTES = 65_536;

/** Built-in mandatory protected root paths under `'local'` profile (controlRoot and manifest assets are added dynamically). */
export const LOCAL_PROTECTED_AUTOMATION_PATHS: readonly string[] = Object.freeze(['.git']);
/** Built-in mandatory protected root paths under `'github'` profile (`.github/workflows/**` requires dual-key `allowWorkflowWrites`). */
export const GITHUB_PROTECTED_AUTOMATION_PATHS: readonly string[] = Object.freeze(['.github', '.git']);
/** Default built-in mandatory protected root paths for generic `@loopwright/taskpack` (`'local'` profile). */
export const PROTECTED_AUTOMATION_PATHS: readonly string[] = LOCAL_PROTECTED_AUTOMATION_PATHS;

export type TaskpackExecutionMode = 'strict' | 'privileged';

export interface TaskpackExecutionCapabilitiesDeclaration {
  readonly allowHostEnv?: boolean | undefined;
  readonly allowHostPath?: boolean | undefined;
  readonly mountReadOnlyGit?: boolean | undefined;
  readonly allowCheckNetwork?: boolean | undefined;
  readonly allowWorkflowWrites?: boolean | undefined;
  readonly allowAgentNetwork?: boolean | undefined;
  readonly allowDockerSocket?: boolean | undefined;
}

export interface ResolvedTaskpackExecutionCapabilities {
  readonly allowHostEnv: boolean;
  readonly allowHostPath: boolean;
  readonly mountReadOnlyGit: boolean;
  readonly allowCheckNetwork: boolean;
  readonly allowWorkflowWrites: boolean;
  readonly allowAgentNetwork: boolean;
  readonly allowDockerSocket: boolean;
}

export interface TaskpackExecutionDigestsDeclaration {
  readonly pinDigests: boolean;
  readonly lockfile?: string | undefined;
}

export interface TaskpackExecutionDeclaration {
  readonly mode: TaskpackExecutionMode;
  readonly capabilities: ResolvedTaskpackExecutionCapabilities;
  readonly digests: TaskpackExecutionDigestsDeclaration;
}

/** Operator-controlled host flags required to authorize manifest-declared privileged capabilities and profile rules. */
export interface ExecutionHostPolicy {
  readonly policyProfile?: PolicyProfile | undefined;
  readonly allowPrivileged?: boolean | undefined;
  readonly allowWorkflowWrites?: boolean | undefined;
  readonly allowDockerSocket?: boolean | undefined;
}

/** Strict host policy for multi-tenant GitHub App control planes: refuses all self-granted privileged capabilities. */
export const MULTI_TENANT_HOST_POLICY: ExecutionHostPolicy = Object.freeze({
  policyProfile: 'github',
  allowPrivileged: false,
  allowWorkflowWrites: false,
  allowDockerSocket: false,
});

export interface TaskpackPreflightDeclaration {
  readonly script: string;
  readonly timeoutSeconds?: number | undefined;
  readonly env?: readonly string[] | undefined;
}

export type TaskpackUpstreamGroupPolicy = 'lockstep' | 'independent';

export interface TaskpackUpstreamGroupDeclaration {
  readonly id: string;
  readonly members: readonly string[];
  readonly policy: TaskpackUpstreamGroupPolicy;
}

export type TaskpackStepKind = 'agent' | 'check' | 'compact';
export const MAX_TASKPACK_STEPS = 16;
export const MAX_STEP_REWORKS = 8;

export interface TaskpackStepDeclaration {
  readonly id: string;
  readonly kind: TaskpackStepKind;
  readonly role?: string | undefined;
  readonly check?: string | undefined;
  readonly dependsOn: readonly string[];
  readonly onRework?: ReworkPolicy | undefined;
  readonly handoffs?: readonly StepHandoffSelector[] | undefined;
}

export interface TaskpackConditionalResourceEntry {
  readonly path: string;
  readonly when?: ResourceActivationRule | undefined;
}

export type TaskpackResourceEntry = string | TaskpackConditionalResourceEntry;

export interface TaskpackProposalDeclaration {
  readonly path: string;
  readonly requiredFields: readonly string[];
  readonly schemaVersion: number;
}

export interface TaskpackSubmissionDeclaration {
  readonly path: string;
  readonly required: boolean;
}

export interface TaskpackTargetDeclaration {
  readonly matrix?: readonly TargetMatrixCell[] | null | undefined;
}

export interface TaskpackDigestTarget {
  readonly path: string;
  readonly kind: 'file' | 'directory';
}

export interface TaskpackDigestLockfileEntry {
  readonly path: string;
  readonly kind: 'file' | 'directory';
  readonly sha256: string;
}

export interface TaskpackDigestLockfile {
  readonly version: 1;
  readonly taskpack: string;
  readonly entries: readonly TaskpackDigestLockfileEntry[];
}

export interface TaskpackDigestDrift {
  readonly path: string;
  readonly kind: 'file' | 'directory';
  readonly status: 'drifted' | 'missing' | 'extra';
  readonly expectedSha256: string | null;
  readonly actualSha256: string | null;
}

export type TaskpackDigestVerificationResult =
  | {
    readonly ok: true;
    readonly lockfilePath: string;
    readonly computed: TaskpackDigestLockfile;
    readonly expected: TaskpackDigestLockfile;
  }
  | {
    readonly ok: false;
    readonly lockfilePath: string;
    readonly reason: string;
    readonly drifts: readonly TaskpackDigestDrift[];
    readonly computed: TaskpackDigestLockfile | null;
    readonly expected: TaskpackDigestLockfile | null;
  };

export type TaskpackUpstreamKind = 'github-release' | 'git-tag' | 'git-commit' | 'http-json' | 'custom-table';
export type TaskpackCommentCommand = 'retry' | 'revise' | 'status';
export const TASKPACK_COMMENT_COMMANDS: readonly TaskpackCommentCommand[] = Object.freeze(['retry', 'revise', 'status']);
export const DEFAULT_COMMENT_PREFIXES: readonly string[] = Object.freeze(['/loopwright']);

export type TaskpackOutputFormat = 'json' | 'github-step-summary' | 'markdown' | 'text';
export const TASKPACK_OUTPUT_FORMATS: readonly TaskpackOutputFormat[] = Object.freeze([
  'json',
  'github-step-summary',
  'markdown',
  'text',
]);

export interface TaskpackOutputDeclaration {
  readonly formats: readonly TaskpackOutputFormat[];
}

export interface TaskpackStdioMcpServerDeclaration {
  readonly id: string;
  readonly transport: 'stdio';
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly envFrom?: Readonly<Record<string, string>> | undefined;
  readonly timeoutSeconds?: number | undefined;
  readonly includeTools?: readonly string[] | undefined;
  readonly readOnly?: boolean | undefined;
  readonly required?: boolean | undefined;
}

export interface TaskpackHttpMcpServerDeclaration {
  readonly id: string;
  readonly transport: 'http';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly headersFrom?: Readonly<Record<string, string>> | undefined;
  readonly bearerTokenEnv?: string | undefined;
  readonly timeoutSeconds?: number | undefined;
  readonly includeTools?: readonly string[] | undefined;
  readonly readOnly?: boolean | undefined;
  readonly required?: boolean | undefined;
}

export type TaskpackMcpServerDeclaration =
  | TaskpackStdioMcpServerDeclaration
  | TaskpackHttpMcpServerDeclaration;

export interface TaskpackMcpDeclaration {
  readonly servers: readonly TaskpackMcpServerDeclaration[];
}

export interface TaskpackLimitsDeclaration {
  readonly wallTimeSeconds?: number | undefined;
  readonly totalTokens?: number | undefined;
  readonly contextWindow?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly maxModelCalls?: number | undefined;
  readonly maxTurns?: number | undefined;
  readonly maxRepairTurns?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly maxFormatRepairs?: number | undefined;
  readonly maxImplementationRepairs?: number | undefined;
  readonly maxTransportRetries?: number | undefined;
  readonly toolTimeoutSeconds?: number | undefined;
  readonly commandTimeoutSeconds?: number | undefined;
  readonly responseBytes?: number | undefined;
  readonly toolResultBytes?: number | undefined;
  readonly toolArgsBytes?: number | undefined;
  readonly promptBytes?: number | undefined;
  readonly maxRequestBytes?: number | undefined;
  readonly workingWindowBytes?: number | undefined;
  readonly fileBytes?: number | undefined;
  readonly sessionBytes?: number | undefined;
  readonly candidateEntries?: number | undefined;
  readonly overlay?: OverlayLimits | undefined;
}

export interface EffectiveTaskpackLimits {
  readonly budgets: TaskContract['spec']['budgets'];
  readonly maxAttempts?: number | undefined;
  readonly commandTimeoutSeconds?: number | undefined;
  readonly workingWindowCeiling?: number | undefined;
  readonly maxRequestBytes?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly roleLimits?: {
    readonly promptBytes?: number;
    readonly responseBytes?: number;
    readonly toolArgsBytes?: number;
    readonly toolResultBytes?: number;
    readonly sessionBytes?: number;
    readonly artifactBytes?: number;
    readonly candidateEntries?: number;
    readonly fileBytes?: number;
    readonly toolWallMs?: number;
    readonly requests?: number;
    readonly operations?: number;
  } | undefined;
}

export interface TaskpackUpstreamDescriptor {
  readonly id: string;
  readonly kind: TaskpackUpstreamKind;
  readonly source: string;
  readonly watchedPaths: readonly string[];
  readonly allowPrerelease?: boolean | undefined;
  readonly versionPath?: string | undefined;
  readonly monotonicSemver?: boolean | undefined;
}

export type TaskpackCheckParameterValue =
  | string
  | number
  | boolean
  | null
  | readonly string[]
  | Readonly<Record<string, string>>;

export type LegacyTaskpackCheckImplementation = 'json-artifact.v1' | 'scope.v1' | 'no-change.v1' | 'command.v1';
export type TaskpackV2CheckImplementation =
  | LegacyTaskpackCheckImplementation
  | 'json-keys-guard.v1'
  | 'line-section-guard.v1';

export interface TaskpackCheckDeclaration {
  readonly id: string;
  readonly implementation: LegacyTaskpackCheckImplementation;
  readonly parameters?: Readonly<Record<string, TaskpackCheckParameterValue>> | undefined;
}

export interface TaskpackV2CheckDeclaration {
  readonly id: string;
  readonly implementation: TaskpackV2CheckImplementation;
  readonly parameters?: Readonly<Record<string, TaskpackCheckParameterValue>> | undefined;
}

export interface TaskpackExternalGateDeclaration {
  readonly id: string;
  readonly gateId: string;
  readonly endpointId: string;
  readonly required: boolean;
  readonly signingCredentialRef?: string | undefined;
  readonly authCredentialRef?: string | undefined;
  readonly url?: string | undefined;
}

export type TaskpackRolePurpose = 'task' | 'review';
export type TaskpackToolName = 'read' | 'write' | 'edit' | 'bash' | 'delete';
export const TASKPACK_TOOL_NAMES: readonly TaskpackToolName[] = Object.freeze(['read', 'write', 'edit', 'bash', 'delete']);
export const MAX_TASKPACK_ROLES = 16;

export interface TaskpackRoleDeclaration {
  readonly id: string;
  readonly purpose?: TaskpackRolePurpose | undefined;
  readonly provider: string;
  readonly model: string;
  readonly thinking?: string | undefined;
  readonly tools?: readonly TaskpackToolName[] | undefined;
  readonly dependsOn?: readonly string[] | undefined;
  readonly instructions?: readonly TaskpackResourceEntry[] | undefined;
  readonly skills?: readonly TaskpackResourceEntry[] | undefined;
  readonly prompt?: string | undefined;
  readonly mcpServers?: readonly string[] | undefined;
  readonly models?: readonly string[] | undefined;
  readonly handoffs?: readonly StepHandoffSelector[] | undefined;
}

export type TaskpackMemoryApplyMode = 'separate-pull-request' | 'local-only' | 'disabled';
export type TaskpackMemoryNoBudgetMode = 'deterministic-observations-only' | 'skip';

export interface TaskpackMemoryDeclaration {
  readonly directory: string;
  readonly apply: TaskpackMemoryApplyMode;
  readonly onNoModelBudget: TaskpackMemoryNoBudgetMode;
  readonly ttlDays?: number | undefined;
  readonly maxEntries?: number | undefined;
  readonly maxPromptEntries?: number | undefined;
  readonly checkCodeFingerprint?: boolean | undefined;
  readonly checkUpstreamVersions?: boolean | undefined;
  readonly publishOnFailure?: boolean | undefined;
  readonly skipCi?: boolean | undefined;
}

export interface TaskpackPullRequestPublicationDeclaration {
  readonly mode: 'pull_request';
  readonly targetBranch: string;
  readonly headBranchPrefix: string;
  readonly titleTemplate: string;
  readonly bodyTemplate?: string | undefined;
}

export interface TaskpackDisabledPublicationDeclaration {
  readonly mode: 'disabled';
  readonly targetBranch?: string | undefined;
  readonly headBranchPrefix?: string | undefined;
  readonly titleTemplate?: string | undefined;
  readonly bodyTemplate?: string | undefined;
}

export type TaskpackPublicationDeclaration =
  | TaskpackPullRequestPublicationDeclaration
  | TaskpackDisabledPublicationDeclaration;

export interface TaskpackTriggersDeclaration {
  readonly schedule: boolean;
  readonly workflowDispatch: boolean;
  readonly releasePublished: boolean;
  readonly commentCommands: readonly TaskpackCommentCommand[];
  readonly commentPrefixes: readonly string[];
}

export interface TaskpackManifestSpecBase<TCheck> {
  readonly goal: { readonly candidate: string; readonly noChange: string };
  readonly scope: { readonly writable: readonly string[]; readonly protected: readonly string[] };
  readonly instructions?: readonly TaskpackResourceEntry[] | undefined;
  readonly skills?: readonly TaskpackResourceEntry[] | undefined;
  readonly execution?: TaskpackExecutionDeclaration | undefined;
  readonly preflight?: TaskpackPreflightDeclaration | undefined;
  readonly vars?: Readonly<Record<string, string>> | undefined;
  readonly target?: TaskpackTargetDeclaration | undefined;
  readonly upstreams: readonly TaskpackUpstreamDescriptor[];
  readonly upstreamGroups?: readonly TaskpackUpstreamGroupDeclaration[] | undefined;
  readonly submission?: TaskpackSubmissionDeclaration | undefined;
  readonly verification: { readonly localChecks: readonly TCheck[]; readonly externalGates: readonly TaskpackExternalGateDeclaration[] };
  readonly publication: TaskpackPublicationDeclaration;
  readonly memory: TaskpackMemoryDeclaration;
  readonly triggers: TaskpackTriggersDeclaration;
  readonly baselineAlignment?: BaselineAlignmentConfig | undefined;
  readonly sandbox?: TaskpackSandboxDeclaration | undefined;
  readonly decisions?: TaskpackDecisionsDeclaration | undefined;
  readonly models?: readonly TaskpackModelDeclaration[] | undefined;
  readonly mcp?: TaskpackMcpDeclaration | undefined;
  readonly limits?: TaskpackLimitsDeclaration | undefined;
  readonly roles?: readonly TaskpackRoleDeclaration[] | undefined;
  readonly steps?: readonly TaskpackStepDeclaration[] | undefined;
  readonly output?: TaskpackOutputDeclaration | undefined;
}

/** Taskpack 2.0 manifest with optional `spec.proposal` and built-in structural guard checks. */
export interface TaskpackV2Manifest {
  readonly apiVersion: typeof TASKPACK_MANIFEST_API_VERSION;
  readonly kind: 'Taskpack';
  readonly metadata: { readonly name: string };
  readonly controlRoot?: string | undefined;
  readonly manifestPath?: string | undefined;
  readonly spec: TaskpackManifestSpecBase<TaskpackV2CheckDeclaration> & {
    readonly proposal?: TaskpackProposalDeclaration | undefined;
  };
}

/**
 * Legacy manifest view narrowing `spec.proposal` to required for callers of `validateTaskpackManifest`.
 */
export interface TaskpackManifestWithProposal {
  readonly apiVersion: typeof TASKPACK_MANIFEST_API_VERSION;
  readonly kind: 'Taskpack';
  readonly metadata: { readonly name: string };
  readonly controlRoot?: string | undefined;
  readonly manifestPath?: string | undefined;
  readonly spec: TaskpackManifestSpecBase<TaskpackV2CheckDeclaration> & {
    readonly proposal: TaskpackProposalDeclaration;
  };
}

/** Canonical Taskpack 2.0 manifest type across `@loopwright/taskpack`. */
export type TaskpackManifest = TaskpackV2Manifest;

export const MAX_TASKPACK_MODEL_CANDIDATES = 8;
export const MAX_EXPANDED_MODEL_CANDIDATES = 16;

export interface TaskpackModelDeclaration {
  readonly provider: string;
  readonly id: string;
  readonly thinking?: PiThinkingLevel | undefined;
  readonly api?: PiWireApi | undefined;
  readonly apiKeyEnv?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly authHeader?: boolean | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly contextWindow?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly reasoning?: boolean | undefined;
  readonly thinkingLevelMap?: Readonly<Record<string, string | null>> | undefined;
  readonly samplingParams?: PiSamplingParams | undefined;
  readonly samplingParamsByThinkingLevel?: Readonly<Record<string, PiSamplingParams>> | undefined;
  readonly compat?: PiCustomModelCompat | undefined;
  readonly cost?: PiModelCost | undefined;
}

export type TaskpackDecisionProviderKind =
  | 'typesafe-jev'
  | 'openai-decisions'
  | 'startlux-decision'
  | 'microsoft-decision'
  | 'perplexity-decider'
  | 'cloudflare-clef'
  | 'liquid-d1';

export type TaskpackDecisionDisclosurePolicy =
  | 'disabled'
  | 'repo-approved-redacted-evidence'
  | 'public-metadata-only';

export type TaskpackDecisionTriageSeverity = 'blocking' | 'important' | 'nit';
export type TaskpackDecisionTriageRuleKind = 'noul' | 'score';

export interface TaskpackDecisionTriageRule {
  readonly id: string;
  readonly description: string;
  readonly severity: TaskpackDecisionTriageSeverity;
  readonly kind: TaskpackDecisionTriageRuleKind;
  readonly threshold?: number | undefined;
}

export interface TaskpackDecisionsDeclaration {
  readonly enabled: boolean;
  readonly provider?: TaskpackDecisionProviderKind | undefined;
  readonly disclosurePolicy?: TaskpackDecisionDisclosurePolicy | undefined;
  readonly minConfidence?: number | undefined;
  readonly confirmThreshold?: number | undefined;
  readonly hardDeadlineMs?: number | undefined;
  readonly maxAttempts?: 1 | 2 | undefined;
  readonly allowImages?: boolean | undefined;
  readonly triageRules?: readonly TaskpackDecisionTriageRule[] | undefined;
}

// ---------------------------------------------------------------------------
// Native OS sandbox execution backends (Seatbelt, Bubblewrap, Landlock, Docker)
// ---------------------------------------------------------------------------

export type SandboxBackendId = 'macos-seatbelt' | 'linux-bwrap' | 'linux-landlock' | 'docker' | 'direct-dedicated';
export type SandboxNetworkMode = 'none' | 'loopback-only' | 'allow-outbound';
export type SandboxCapability =
  | 'filesystemReadContainment'
  | 'filesystemWriteContainment'
  | 'protectedPathReadOnlyMask'
  | 'networkIsolation'
  | 'processTreeCleanup'
  | 'syscallFiltering';

export interface TaskpackSandboxDeclaration {
  readonly preferredBackends?: readonly SandboxBackendId[] | undefined;
  readonly networkMode?: SandboxNetworkMode | undefined;
  readonly requiredCapabilities?: readonly SandboxCapability[] | undefined;
  readonly deniedReadPaths?: readonly string[] | undefined;
}

export interface SandboxReadOnlyBindMount {
  readonly sourcePath: string;
  readonly targetPath: string;
}

export interface SandboxPolicyInput {
  readonly workspaceRoot: string;
  readonly writablePaths: readonly string[];
  readonly protectedPaths?: readonly string[] | undefined;
  readonly controlRoot?: string | undefined;
  readonly proposalPath?: string | undefined;
  readonly policyProfile?: PolicyProfile | undefined;
  readonly protectGitHubDir?: boolean | undefined;
  readonly allowWorkflowWrites?: boolean | undefined;
  readonly strictExactFiles?: boolean | undefined;
  readonly deniedReadPaths?: readonly string[] | undefined;
  readonly allowedReadOnlyPaths?: readonly string[] | undefined;
  readonly readOnlyBindMounts?: readonly SandboxReadOnlyBindMount[] | undefined;
  readonly scratchDirectory?: string | undefined;
  readonly networkMode?: SandboxNetworkMode | undefined;
  readonly requiredCapabilities?: readonly SandboxCapability[] | undefined;
  readonly preferredBackends?: readonly SandboxBackendId[] | undefined;
  readonly allowDedicatedDirectOverride?: boolean | undefined;
}

export interface SandboxHostEnvironment {
  readonly platform: 'darwin' | 'linux' | string;
  readonly arch: 'arm64' | 'x64' | string;
  readonly homeDirectory?: string | undefined;
  readonly seatbeltExecutable?: string | undefined;
  readonly bwrapExecutable?: string | undefined;
  readonly pythonExecutable?: string | undefined;
  readonly dockerExecutable?: string | undefined;
  readonly dockerSocket?: string | undefined;
  readonly probeExecutables?: boolean | undefined;
}

export interface NegotiatedSandboxBackend {
  readonly backendId: SandboxBackendId;
  readonly executablePath: string | null;
  readonly capabilities: readonly SandboxCapability[];
  readonly networkMode: SandboxNetworkMode;
  readonly profileDigest: Digest;
}

export interface CompiledMacosSeatbeltProfile {
  readonly backendId: 'macos-seatbelt';
  readonly executablePath: string;
  readonly profileText: string;
  readonly profileDigest: Digest;
  readonly canonicalWorkspaceRoot: string;
  readonly canonicalWritablePaths: readonly string[];
  readonly canonicalProtectedPaths: readonly string[];
  readonly canonicalDeniedReadPaths: readonly string[];
  readonly networkMode: SandboxNetworkMode;
}

export interface CompiledLinuxBwrapCommand {
  readonly backendId: 'linux-bwrap';
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly seccompProfileJson: string;
  readonly seccompDigest: Digest;
  readonly profileDigest: Digest;
  readonly canonicalWorkspaceRoot: string;
  readonly canonicalWritablePaths: readonly string[];
  readonly canonicalProtectedPaths: readonly string[];
  readonly canonicalDeniedReadPaths: readonly string[];
  readonly canonicalReadOnlyBindMounts: readonly SandboxReadOnlyBindMount[];
  readonly networkMode: SandboxNetworkMode;
}

export interface SandboxedCommandInput {
  readonly policy: SandboxPolicyInput;
  readonly host?: SandboxHostEnvironment | undefined;
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly stdin?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
  readonly secretsToScrub?: readonly string[] | undefined;
}

export interface SandboxedCommandResult {
  readonly backendId: SandboxBackendId;
  readonly profileDigest: Digest;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// Host-injected bindings and compiled output
// ---------------------------------------------------------------------------

export interface TargetMatrixCell { readonly id: string; readonly platform: string; readonly variant: string }

export interface HostRoleSelection {
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly thinking?: PiThinkingLevel | undefined;
  readonly api?: PiWireApi | undefined;
  readonly baseUrl?: string | undefined;
  readonly customProvider?: PiCustomProviderConfig | undefined;
}

export interface HostRuntimeOptions {
  readonly dockerExecutable?: string | undefined;
  readonly dockerSocket?: string | undefined;
  readonly imageDigest?: string | undefined;
  /** The frozen runtime profile supports only the linux/arm64 container platform. */
  readonly profile?: 'linux/arm64' | undefined;
}

export interface HostGateEndpointPlan {
  readonly id: string;
  readonly url: string;
  readonly signingCredentialRef: string;
  readonly authCredentialRef?: string | null | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxPollMs?: number | undefined;
  readonly pollInitialMs?: number | undefined;
  readonly pollMaxMs?: number | undefined;
  readonly jitter?: number | undefined;
}

export interface HostPublicationEndpointPlan {
  readonly id: string;
  readonly url: string;
  readonly signingCredentialRef: string;
  readonly authCredentialRef?: string | null | undefined;
  readonly timeoutMs?: number | undefined;
}

/** Environment variable names the host injects credentials through; templates stay `${NAME}`. */
export interface HostCredentialEnvMap {
  readonly provider?: string | undefined;
  readonly gate?: string | undefined;
  readonly localCommandGate?: string | undefined;
  readonly publication?: string | undefined;
  readonly publicationAuth?: string | undefined;
}

export const LOCAL_COMMAND_GATE_ENDPOINT_ID = 'loopwright-local-command' as const;
export const DEFAULT_LOCAL_COMMAND_GATE_ENV = 'LOOPWRIGHT_LOCAL_GATE_SECRET' as const;
export const CANONICAL_TASKPACK_STEP_GATE_URL = `http://127.0.0.1:65535/${LOCAL_COMMAND_GATE_ENDPOINT_ID}` as const;

export interface CompiledInstructionResource {
  readonly id: string;
  readonly kind: 'instruction' | 'skill' | 'document';
  readonly path: string;
  readonly bytes: Buffer;
  readonly digest: Digest;
  readonly mode?: number | undefined;
  readonly when?: ResourceActivationRule | undefined;
}

export interface CompiledLocalCommandGate {
  readonly checkId: string;
  readonly gateId: string;
  readonly endpointRef: typeof LOCAL_COMMAND_GATE_ENDPOINT_ID;
  readonly script: string;
  readonly scriptSha256: string;
  readonly scriptDir?: string | undefined;
  readonly scriptDirSha256?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly timeoutSeconds: number;
  readonly allowReadOnlyGitHubToken: boolean;
  readonly env: readonly string[];
  readonly envMap?: Readonly<Record<string, string>> | undefined;
  readonly toolchainPaths?: readonly string[] | undefined;
  readonly preserveRepoDirName?: boolean | undefined;
  readonly mountReadOnlyGit?: boolean | undefined;
  readonly allowHostEnv?: boolean | undefined;
  readonly allowHostPath?: boolean | undefined;
  readonly allowCheckNetwork?: boolean | undefined;
  readonly networkMode?: SandboxNetworkMode | undefined;
  readonly allowPrivileged?: boolean | undefined;
  readonly allowDockerSocket?: boolean | undefined;
  readonly baselineConflictGuardOnly?: boolean | undefined;
}

export interface HostTaskpackBindings {
  readonly mode: 'candidate' | 'no-change';
  readonly checkOnlyNoChange?: boolean | undefined;
  readonly hostPolicy?: ExecutionHostPolicy | undefined;
  readonly executionMode?: 'pi' | 'delegated' | undefined;
  readonly repository: string;
  readonly repositoryRoot?: string | undefined;
  readonly taskpackPath?: string | undefined;
  readonly baseRevision: string;
  readonly sourceRevision: string;
  readonly baselineAlignment?: BaselineAlignmentOverride | undefined;
  readonly baselineAlignmentResult?: BaselineAlignmentResult | undefined;
  readonly baselineConflictResource?: BaselineConflictContextResource | undefined;
  readonly enableBaselineConflictGate?: boolean | undefined;
  readonly targetMatrix?: readonly TargetMatrixCell[] | null | undefined;
  readonly roleSelection?: HostRoleSelection | undefined;
  readonly candidateIndex?: number | undefined;
  readonly allowManifestCustomBaseUrl?: boolean | undefined;
  readonly modelsJsonPath?: string | undefined;
  readonly runtimeOptions?: HostRuntimeOptions | undefined;
  readonly budgets: TaskContract['spec']['budgets'];
  readonly limits?: TaskpackLimitsDeclaration | undefined;
  readonly envLimits?: TaskpackLimitsDeclaration | undefined;
  readonly externalMcpTools?: readonly string[] | undefined;
  readonly externalMcpToolSchemas?: readonly {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Readonly<Record<string, unknown>>;
  }[] | undefined;
  readonly maxAttempts?: number | undefined;
  readonly gateEndpoints?: readonly HostGateEndpointPlan[] | undefined;
  readonly publicationEndpoint?: HostPublicationEndpointPlan | null | undefined;
  readonly credentialEnvMap?: HostCredentialEnvMap | undefined;
  readonly sourceTokenEnvNames?: readonly string[] | undefined;
  readonly resourceVersion?: string | undefined;
  readonly authorPrompt?: string | undefined;
  readonly upstreamRecords?: readonly TaskpackUpstreamRecord[] | undefined;
  readonly preflightPromptResources?: readonly {
    readonly id: string;
    readonly kind: 'instruction' | 'skill' | 'document';
    readonly path: string;
    readonly bytes: Buffer;
    readonly sha256: string;
  }[] | undefined;
  readonly preflightWorkspaceResources?: readonly {
    readonly id: string;
    readonly kind: 'instruction' | 'skill' | 'document';
    readonly relativePath: string;
    readonly stagedPath: string;
    readonly checkStagedPath: string | null;
    readonly sha256: string;
    readonly byteLength: number;
    readonly exposeToChecks: boolean;
  }[] | undefined;
  readonly nowMs?: number | undefined;
  readonly scrubber?: { scrub(text: string): string } | undefined;
  readonly onMemoryWarning?: ((message: string) => void) | undefined;
}

export interface CompiledActiveMemorySummary {
  readonly activeEntryCount: number;
  readonly excludedEntryCount: number;
  readonly snapshotDigest: Digest;
  readonly resourcePath: string | null;
}

export interface CompiledTaskpack {
  readonly registry: TrustedRegistry;
  readonly config: ControllerConfiguration;
  readonly registrySha256: string;
  readonly registryBytes: Buffer;
  readonly instructionResources?: readonly CompiledInstructionResource[] | undefined;
  readonly localCommandGates?: readonly CompiledLocalCommandGate[] | undefined;
  readonly activeMemory?: CompiledActiveMemorySummary | undefined;
  readonly digests?: Readonly<Record<string, string>> | undefined;
  readonly roleMcpServers?: Readonly<Record<string, readonly string[]>> | undefined;
  readonly allowWorkflowWrites?: boolean | undefined;
  readonly policyProfile?: PolicyProfile | undefined;
  readonly baselineAlignment?: ResolvedBaselineAlignmentConfig | undefined;
  readonly extractedConflictPaths?: readonly string[] | undefined;
  readonly watchedPaths?: readonly string[] | undefined;
  readonly circuitBreakerLimits?: {
    readonly maxTurns?: number | undefined;
    readonly maxRepairTurns?: number | undefined;
  } | undefined;
}

// ---------------------------------------------------------------------------
// Generic repository-agnostic intake & identity
// ---------------------------------------------------------------------------

export const REPOSITORY_FULL_NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const AUTHORIZED_ASSOCIATIONS: readonly string[] = Object.freeze(['OWNER', 'MEMBER', 'COLLABORATOR']);

export interface TenantIdentity {
  readonly installationId: number;
  readonly repositoryId: number;
  readonly repositoryFullName: string;
  readonly taskpackId: string;
}

export interface ParsedCommentCommand {
  readonly command: TaskpackCommentCommand;
  readonly guidance: string;
}

export type UpstreamAcquisitionStatus = 'available' | 'up_to_date' | 'held_back' | 'failed' | 'blocked';

export interface TaskpackUpstreamRecord {
  readonly upstreamId: string;
  readonly status: UpstreamAcquisitionStatus;
  readonly version?: string | undefined;
  readonly recentVersions?: readonly string[] | undefined;
  readonly reason?: string | undefined;
}

export interface TaskpackReviseCommand {
  readonly commandId: number;
  readonly headSha: string;
  readonly commandDigest: string;
}

export interface TaskpackRunDiagnostic {
  readonly url: string;
  readonly repository: string;
  readonly runId: string;
  readonly jobId: string | null;
  readonly jobLogText: string;
  readonly truncated: boolean;
}

export type TaskpackIntakeInput =
  | {
    readonly mode: 'discover';
    readonly tenant: TenantIdentity;
    readonly baseRevision: string;
    readonly records: readonly TaskpackUpstreamRecord[];
    readonly force?: boolean | undefined;
    readonly managedPrMatchesDiscoveredState?: boolean | undefined;
    readonly targetMatrix?: readonly TargetMatrixCell[] | null | undefined;
  }
  | {
    readonly mode: 'revise';
    readonly tenant: TenantIdentity;
    readonly command: TaskpackReviseCommand;
    readonly actorLogin: string;
    readonly authorAssociation: string;
    readonly operatorAllowlist?: readonly string[] | undefined;
    readonly guidance: string;
  }
  | { readonly mode: 'run-url'; readonly tenant: TenantIdentity; readonly identityRepository: string; readonly url: string; readonly jobLogText: string }
  | { readonly mode: 'status'; readonly tenant: TenantIdentity };

export type TaskpackIntakeOutcome =
  | { readonly kind: 'discover'; readonly disposition: 'ready'; readonly baseRevision: string; readonly updates: readonly TaskpackUpstreamRecord[]; readonly targetMatrix: readonly TargetMatrixCell[] | null }
  | { readonly kind: 'discover'; readonly disposition: 'no_change'; readonly reason: string }
  | { readonly kind: 'discover'; readonly disposition: 'blocked'; readonly reason: 'upstream_unavailable'; readonly failures: readonly { readonly upstreamId: string; readonly error: string }[] }
  | { readonly kind: 'revise'; readonly disposition: 'ready'; readonly command: TaskpackReviseCommand }
  | { readonly kind: 'revise'; readonly disposition: 'blocked'; readonly reason: 'unauthorized_actor' | 'invalid_guidance'; readonly detail: string }
  | { readonly kind: 'run-url'; readonly disposition: 'ready'; readonly diagnostic: TaskpackRunDiagnostic }
  | { readonly kind: 'run-url'; readonly disposition: 'blocked'; readonly reason: 'invalid_run_url' | 'unknown_repository_url'; readonly detail: string }
  | { readonly kind: 'status'; readonly disposition: 'ready'; readonly summary: string };

// ---------------------------------------------------------------------------
// Deployment host qualification and MCP OAuth refusal
// ---------------------------------------------------------------------------

export type DeploymentStorageProfile = 'actions-basic' | 'durable';

export interface DeploymentHostProfileInput {
  readonly platform: string;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly filesystemType: string;
  readonly storageProfile: DeploymentStorageProfile;
  readonly clockBasis: ClockBasis;
  readonly previousClockSample: ClockSample;
  readonly currentClockSample: ClockSample;
  readonly hasVerifiedCheckpointLedger: boolean;
  readonly autoResumeOnHostLossRequested: boolean;
  readonly probeDirectory?: string | undefined;
}

export type HostQualification =
  | { readonly ok: true }
  | {
    readonly ok: false;
    readonly code: 'HOST_PROFILE_UNQUALIFIED' | 'HOST_CLOCK_UNTRUSTED' | 'STORAGE_PROFILE_INSUFFICIENT';
    readonly reason: string;
    readonly recommendedRunStatus?: 'reconcile_required' | undefined;
  };

export interface McpServerAuthDeclaration {
  readonly serverId: string;
  readonly auth?: { readonly type: string } | null | undefined;
}

export interface McpTransportChallenge {
  readonly status: number;
  readonly wwwAuthenticate?: string | null | undefined;
}

export interface McpAuthConfigurationInput {
  readonly servers: readonly McpServerAuthDeclaration[];
  readonly transportChallenge?: McpTransportChallenge | null | undefined;
}

export type McpAuthValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'MCP_OAUTH_UNSUPPORTED' | 'MCP_AUTHENTICATION_REQUIRED'; readonly reason: string };

// ---------------------------------------------------------------------------
// Model selection & turnkey execution summaries
// ---------------------------------------------------------------------------

export interface ResolvedModelCandidate {
  readonly index: number;
  readonly manifestIndex: number;
  readonly selection: PiModelSelection;
  readonly apiKeyEnv?: string | undefined;
  readonly providerEnvName: string;
  readonly sourceTokenEnvName?: string | undefined;
  readonly token?: string | undefined;
  readonly usesActiveTokenEnv: boolean;
}

export interface ModelCandidateProbeAttempt {
  readonly index: number;
  readonly provider: string;
  readonly model: string;
  readonly api: PiWireApi;
  readonly ok: boolean;
  readonly status: number | null;
  readonly reason: string;
}

export interface ModelCandidateSelectionResult {
  readonly selected: ResolvedModelCandidate;
  readonly index: number;
  readonly probed: boolean;
  readonly attempts: readonly ModelCandidateProbeAttempt[];
}

export interface GitCommitIdentity {
  readonly name: string;
  readonly email: string;
}

export interface ActionDelegateOutcome {
  readonly ok: boolean;
  readonly detail: string;
  readonly retryableProviderFailure?: boolean | undefined;
}

export interface ActionEntrypointInput {
  readonly repositoryRoot: string;
  readonly taskpackPath?: string | undefined;
  readonly repositoryFullName: string;
  readonly baseRevision: string;
  readonly sourceRevision?: string | undefined;
  readonly baselineAlignment?: BaselineAlignmentOverride | undefined;
  readonly mode: 'candidate' | 'no-change' | 'auto';
  readonly allowPrivilegedExecution?: boolean | undefined;
  readonly allowWorkflowWrites?: boolean | undefined;
  readonly allowDockerSocket?: boolean | undefined;
  readonly hostPolicy?: ExecutionHostPolicy | undefined;
  readonly eventName: string;
  readonly eventPayload?: unknown | undefined;
  readonly runRoot: string;
  readonly runId: string;
  readonly storageProfile?: DeploymentStorageProfile | undefined;
  readonly filesystemType?: string | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly thinking?: PiThinkingLevel | undefined;
  readonly api?: PiWireApi | undefined;
  readonly baseUrl?: string | undefined;
  readonly providerTokenEnv?: string | undefined;
  readonly modelsJsonPath?: string | undefined;
  readonly allowManifestCustomBaseUrl?: boolean | undefined;
  readonly gitAuthorName?: string | undefined;
  readonly gitAuthorEmail?: string | undefined;
  readonly upstreamRecords?: readonly TaskpackUpstreamRecord[] | undefined;
  readonly targetMatrix?: readonly TargetMatrixCell[] | null | undefined;
  readonly budgets?: TaskContract['spec']['budgets'] | undefined;
  readonly limits?: TaskpackLimitsDeclaration | undefined;
  readonly gateEndpoints?: readonly HostGateEndpointPlan[] | undefined;
  readonly publicationEndpoint?: HostPublicationEndpointPlan | null | undefined;
  readonly credentialEnvMap?: HostCredentialEnvMap | undefined;
  readonly resourceVersion?: string | undefined;
  readonly authorPrompt?: string | undefined;
  readonly operatorAllowlist?: readonly string[] | undefined;
  readonly commentPrefixes?: readonly string[] | undefined;
  readonly mcpServers?: readonly McpServerAuthDeclaration[] | undefined;
  readonly mcpServerConfigs?: readonly TaskpackMcpServerDeclaration[] | undefined;
  readonly mcpTransportChallenge?: McpTransportChallenge | null | undefined;
  readonly clockBasis?: ClockBasis | undefined;
  readonly previousClockSample?: ClockSample | undefined;
  readonly currentClockSample?: ClockSample | undefined;
  readonly probeDirectory?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly probeFetch?: typeof globalThis.fetch | undefined;
  readonly probeTimeoutMs?: number | undefined;
  readonly dryRun?: boolean | undefined;
  readonly force?: boolean | undefined;
  readonly delegate?: (compiled: WrittenCompiledTaskpack) => Promise<ActionDelegateOutcome>;
  readonly openHostSessionAdapter?: typeof openPiHostSessionAdapterV2 | undefined;
}

export interface WrittenCompiledTaskpack extends CompiledTaskpack {
  readonly configBytes: Buffer;
  readonly trustedDirectory: string;
  readonly registryPath: string;
  readonly configPath: string;
}

export type TurnkeyMemoryOutcomeStatus =
  | 'published'
  | 'updated'
  | 'local_only'
  | 'no_entries'
  | 'skipped'
  | 'refused'
  | 'reconcile_required'
  | 'failed';

export interface TurnkeyMemorySummary {
  readonly status: TurnkeyMemoryOutcomeStatus;
  readonly directory: string;
  readonly proposalId: string | null;
  readonly entryCount: number;
  readonly rebased: boolean;
  readonly branchName: string | null;
  readonly pullRequestUrl: string | null;
  readonly pullRequestNumber: number | null;
  readonly reason: string | null;
}

export type ActionEntrypointResult =
  | {
    readonly kind: 'refused';
    readonly code:
      | 'HOST_PROFILE_UNQUALIFIED'
      | 'HOST_CLOCK_UNTRUSTED'
      | 'STORAGE_PROFILE_INSUFFICIENT'
      | 'MCP_OAUTH_UNSUPPORTED'
      | 'MCP_AUTHENTICATION_REQUIRED'
      | 'PROVIDER_OAUTH_UNSUPPORTED'
      | 'TASKPACK_HOST_BINDING_INVALID'
      | 'TASKPACK_SCOPE_VIOLATION'
      | 'TASKPACK_TRIGGER_UNSUPPORTED';
    readonly reason: string;
    readonly recommendedRunStatus?: 'reconcile_required' | undefined;
  }
  | {
    readonly kind: 'no_change';
    readonly reason: string;
    readonly taskpack?: WrittenCompiledTaskpack | undefined;
    readonly delegateOutcome?: { readonly ok: boolean; readonly detail: string } | null | undefined;
  }
  | { readonly kind: 'blocked'; readonly reason: string; readonly detail?: string }
  | {
    readonly kind: 'compiled';
    readonly manifest: TaskpackManifest;
    readonly intake: TaskpackIntakeOutcome;
    readonly taskpack: WrittenCompiledTaskpack;
    readonly delegateOutcome: { readonly ok: boolean; readonly detail: string } | null;
    readonly memory?: TurnkeyMemorySummary | undefined;
  };

// ---------------------------------------------------------------------------
// Multi-domain TaskpackSuite (.loopwright/suite.yaml) & staged promotion
// ---------------------------------------------------------------------------

export const DEFAULT_TASKPACK_SUITE_PATH = '.loopwright/suite.yaml' as const;
export const TASKPACK_SUITE_MANIFEST_BYTES = 65_536;
export const MAX_SUITE_DOMAINS = 32;
export const MAX_SUITE_STAGES = 16;
export const MAX_SUITE_STAGE_READINESS_PROBES = 16;
export const MAX_SUITE_STAGE_VERSION_BLOB_BYTES = 1_048_576;

export const SUITE_STAGE_READINESS_PROBE_KINDS = Object.freeze([
  'github-release',
  'http-json',
  'git-tag',
  'git-commit',
] as const);
export type SuiteStageReadinessProbeKind = typeof SUITE_STAGE_READINESS_PROBE_KINDS[number];

export interface SuiteVersionFromSelector {
  readonly domain: string;
  readonly path: string;
  readonly jsonPointer?: string | undefined;
}

export interface SuiteStageReadinessProbe {
  readonly id?: string | undefined;
  readonly kind: SuiteStageReadinessProbeKind;
  readonly source: string;
  readonly versionFrom?: SuiteVersionFromSelector | undefined;
  readonly expectedVersion?: string | undefined;
  readonly ref?: string | undefined;
  readonly tagPrefix?: string | undefined;
  readonly jsonPointer?: string | undefined;
  readonly versionPath?: string | undefined;
  readonly allowPrerelease?: boolean | undefined;
}

export interface TaskpackSuiteStageDeclaration {
  readonly id: string;
  readonly dependsOn: readonly string[];
  readonly readiness: readonly SuiteStageReadinessProbe[];
}

export type TaskpackSuiteDomainMatrix =
  | readonly TargetMatrixCell[]
  | Readonly<Record<string, string | number | boolean>>;

export interface TaskpackSuiteDomainDeclaration {
  readonly id: string;
  readonly taskpack: string;
  readonly enabled: boolean;
  readonly schedules?: readonly string[] | undefined;
  readonly stage?: string | undefined;
  readonly matrix?: TaskpackSuiteDomainMatrix | undefined;
}

export interface TaskpackSuiteManifest {
  readonly apiVersion: typeof TASKPACK_MANIFEST_API_VERSION;
  readonly kind: 'TaskpackSuite';
  readonly metadata: { readonly name: string };
  readonly suitePath?: string | undefined;
  readonly controlRoot?: string | undefined;
  readonly spec: {
    readonly domains: readonly TaskpackSuiteDomainDeclaration[];
    readonly stages: readonly TaskpackSuiteStageDeclaration[];
  };
}

export interface LoadedTaskpackSuiteDomain {
  readonly id: string;
  readonly taskpackPath: string;
  readonly taskpackName: string;
  readonly controlRoot: string;
  readonly manifestSha256: string;
  readonly enabled: boolean;
  readonly schedules?: readonly string[] | undefined;
  readonly stage?: string | undefined;
  readonly matrix?: TaskpackSuiteDomainMatrix | undefined;
  readonly manifest: TaskpackManifest;
  readonly protectedPaths: readonly string[];
}

export interface LoadedTaskpackSuite {
  readonly manifest: TaskpackSuiteManifest;
  readonly suitePath: string;
  readonly controlRoot: string;
  readonly suiteSha256: string;
  readonly suiteProtectedPaths: readonly string[];
  readonly stageOrder: readonly string[];
  readonly domains: readonly LoadedTaskpackSuiteDomain[];
}

export type SuiteDisposition = 'eligible' | 'deferred' | 'blocked' | 'ignored';

export interface SuiteStageProbeEvaluation {
  readonly stageId: string;
  readonly probeIndex: number;
  readonly probeId?: string | undefined;
  readonly kind: SuiteStageReadinessProbeKind;
  readonly source: string;
  readonly disposition: 'eligible' | 'deferred' | 'blocked';
  readonly expectedVersion?: string | undefined;
  readonly observedVersion?: string | undefined;
  readonly reason: string;
  readonly detail?: string | undefined;
}

export interface SuiteMatrixCell {
  readonly domainId: string;
  readonly taskpackPath: string;
  readonly taskpackName: string;
  readonly manifestSha256: string;
  readonly controlRoot: string;
  readonly baseRevision: string;
  readonly headSha?: string | undefined;
  readonly stage?: string | undefined;
  readonly matrix?: TaskpackSuiteDomainMatrix | undefined;
  readonly protectedPaths: readonly string[];
}

export interface SuiteDomainResolution extends SuiteMatrixCell {
  readonly disposition: 'eligible' | 'deferred' | 'blocked';
  readonly reason: string;
  readonly detail?: string | undefined;
  readonly code?: TaskpackErrorCode | undefined;
  readonly probes?: readonly SuiteStageProbeEvaluation[] | undefined;
}

export interface ParsedSuiteCommentCommand {
  readonly prefix: string;
  readonly domainId?: string | undefined;
  readonly command: TaskpackCommentCommand;
  readonly guidance: string;
}

export interface SuiteResolutionResult {
  readonly suiteName: string;
  readonly suitePath: string;
  readonly suiteSha256: string;
  readonly eventName: string;
  readonly baseRevision: string;
  readonly disposition: SuiteDisposition;
  readonly reason: string;
  readonly detail?: string | undefined;
  readonly code?: TaskpackErrorCode | undefined;
  readonly validDomainIds: readonly string[];
  readonly suiteProtectedPaths: readonly string[];
  readonly comment?: ParsedSuiteCommentCommand | undefined;
  readonly cells: readonly SuiteDomainResolution[];
  readonly eligibleCells: readonly SuiteMatrixCell[];
  readonly matrix: { readonly include: readonly SuiteMatrixCell[] };
}

// ---------------------------------------------------------------------------
// Baseline 3-way conflict alignment, shared carry tree, and candidate inspection
// ---------------------------------------------------------------------------

export const BASELINE_ALIGNMENT_POLICIES = Object.freeze([
  'off',
  'fail-fast',
  'extract-context',
] as const);
export type BaselineAlignmentPolicy = typeof BASELINE_ALIGNMENT_POLICIES[number];

export const DEFAULT_BASELINE_ALIGNMENT_POLICY: BaselineAlignmentPolicy = 'off';
export const DEFAULT_BASELINE_MAX_CONFLICT_FILES = 16;
export const MIN_BASELINE_MAX_CONFLICT_FILES = 1;
export const MAX_BASELINE_MAX_CONFLICT_FILES = 64;
export const DEFAULT_BASELINE_MAX_CONFLICT_BYTES = 65_536;
export const MIN_BASELINE_MAX_CONFLICT_BYTES = 1_024;
export const MAX_BASELINE_MAX_CONFLICT_BYTES = 262_144;

export const BASELINE_CONFLICT_REASON = 'baseline_merge_conflict' as const;
export const BASELINE_CONFLICT_RESOURCE_ID = 'baseline-conflict-context' as const;
export const BASELINE_CONFLICT_RESOURCE_PATH = '.loopwright-baseline/conflicts.json' as const;

export interface BaselineAlignmentConfig {
  readonly policy: BaselineAlignmentPolicy;
  readonly maxConflictFiles?: number | undefined;
  readonly maxConflictBytes?: number | undefined;
}

export interface ResolvedBaselineAlignmentConfig {
  readonly policy: BaselineAlignmentPolicy;
  readonly maxConflictFiles: number;
  readonly maxConflictBytes: number;
}

export type BaselineAlignmentOverride = BaselineAlignmentPolicy | BaselineAlignmentConfig;

export interface BaselineConflictHunk {
  readonly index: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly block: string;
}

export type BaselineConflictKind = 'content' | 'add_add' | 'modify_delete' | 'delete_modify';

export interface ExtractedBaselineConflictFile {
  readonly path: string;
  readonly conflictKind: BaselineConflictKind;
  readonly baseSha256: string | null;
  readonly targetSha256: string | null;
  readonly sourceSha256: string | null;
  readonly byteLength: number;
  readonly hunks: readonly BaselineConflictHunk[];
}

export interface BaselineConflictContextDocument {
  readonly version: 1;
  readonly baseRevision: string;
  readonly sourceRevision: string;
  readonly mergeBase: string | null;
  readonly conflictCount: number;
  readonly totalHunkBytes: number;
  readonly conflicts: readonly ExtractedBaselineConflictFile[];
}

export interface BaselineConflictContextResource {
  readonly id: typeof BASELINE_CONFLICT_RESOURCE_ID;
  readonly kind: 'document';
  readonly path: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly byteLength: number;
  readonly document: BaselineConflictContextDocument;
  readonly extractedPaths: readonly string[];
}

export type BaselineAlignmentResult =
  | {
    readonly disposition: 'clean';
    readonly status: 'same_revision' | 'merged_clean';
    readonly policy: ResolvedBaselineAlignmentConfig;
    readonly baseRevision: string;
    readonly sourceRevision: string;
    readonly mergeBase: string | null;
    readonly mergedTreeOid: string | null;
    readonly carryRemovals: readonly string[];
    readonly carryUpdates: readonly CarryDeltaEntry[];
    readonly conflictPaths: readonly string[];
    readonly conflicts: readonly ExtractedBaselineConflictFile[];
    readonly conflictResource: null;
  }
  | {
    readonly disposition: 'extracted';
    readonly status: 'conflicts_extracted';
    readonly policy: ResolvedBaselineAlignmentConfig;
    readonly baseRevision: string;
    readonly sourceRevision: string;
    readonly mergeBase: string | null;
    readonly mergedTreeOid: string | null;
    readonly carryRemovals: readonly string[];
    readonly carryUpdates: readonly CarryDeltaEntry[];
    readonly conflictPaths: readonly string[];
    readonly conflicts: readonly ExtractedBaselineConflictFile[];
    readonly conflictResource: BaselineConflictContextResource;
  }
  | {
    readonly disposition: 'unmerged_off';
    readonly status: 'conflicts_unmerged';
    readonly policy: ResolvedBaselineAlignmentConfig;
    readonly baseRevision: string;
    readonly sourceRevision: string;
    readonly mergeBase: string | null;
    readonly mergedTreeOid: string | null;
    readonly carryRemovals: readonly string[];
    readonly carryUpdates: readonly CarryDeltaEntry[];
    readonly conflictPaths: readonly string[];
    readonly conflicts: readonly ExtractedBaselineConflictFile[];
    readonly conflictResource: null;
  }
  | {
    readonly disposition: 'blocked';
    readonly status: 'blocked';
    readonly reason: typeof BASELINE_CONFLICT_REASON;
    readonly detail: string;
    readonly policy: ResolvedBaselineAlignmentConfig;
    readonly baseRevision: string;
    readonly sourceRevision: string;
    readonly mergeBase: string | null;
    readonly mergedTreeOid: null;
    readonly carryRemovals: readonly string[];
    readonly carryUpdates: readonly CarryDeltaEntry[];
    readonly conflictPaths: readonly string[];
    readonly conflicts: readonly ExtractedBaselineConflictFile[];
    readonly conflictResource: null;
  };

/** Scope view accepted by candidate write checks — either a compiled `TaskContract` or compiled scope pattern arrays. */
export interface CandidateScopeSnapshot {
  readonly contract?: TaskContract | undefined;
  readonly writablePaths?: readonly string[] | undefined;
  readonly protectedPaths: readonly string[];
}

export interface GitTreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
}

export interface CarryDeltaEntry {
  readonly path: string;
  readonly mode: '100644' | '100755';
  readonly oid: string;
  readonly byteLength?: number | undefined;
  readonly sha256?: string | undefined;
  readonly bytes?: Uint8Array | undefined;
}

export type InspectedCandidateFile =
  | {
    readonly kind: 'cas';
    readonly name: string;
    readonly mode: '100644' | '100755';
    readonly sha256: string;
    readonly byteLength: number;
    readonly uri: string;
    readonly canonicalBlobPath: string;
  }
  | {
    readonly kind: 'inline';
    readonly name: string;
    readonly mode?: '100644' | '100755' | undefined;
    readonly bytes: Buffer;
  };

export interface InspectedCandidateSnapshot {
  readonly lock: Record<string, unknown>;
  readonly contract: import('@loopwright/core').TaskContract;
  readonly protectedPaths: readonly string[];
  readonly baseRevision: string;
  readonly sourceRevision: string;
  readonly manifest: import('@loopwright/core').ArtifactManifest;
  readonly files: readonly InspectedCandidateFile[];
}

/** Re-exported utility type so consumers can name a digest without importing core directly. */
export type { Digest };
