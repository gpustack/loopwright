import type { Digest, TaskContract } from '@loopwright/core';
import type { ClockBasis, ClockSample } from '@loopwright/state';
import type {
  PiCustomModelCompat, PiCustomProviderConfig, PiModelSelection, PiSamplingParams, PiThinkingLevel, PiWireApi,
} from '@loopwright/agent-pi';
import type { ControllerConfiguration, TrustedRegistry } from '@loopwright/controller';

export type { ClockBasis, ClockSample, PiCustomModelCompat, PiCustomProviderConfig, PiModelSelection, PiSamplingParams, PiThinkingLevel, PiWireApi };

/** Closed set of matchable failure codes for @loopwright/github-app diagnostics. */
export const GITHUB_APP_ERROR_CODES = Object.freeze([
  'TASKPACK_MANIFEST_INVALID', 'TASKPACK_UNTRUSTED_INTERPOLATION', 'TASKPACK_SCOPE_VIOLATION',
  'TASKPACK_HOST_BINDING_INVALID', 'PROVIDER_OAUTH_UNSUPPORTED',
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
export type GitHubAppErrorCode = typeof GITHUB_APP_ERROR_CODES[number];

/** Explicit, matchable failure carrying the offending manifest or request path when known. */
export class GitHubAppError extends Error {
  readonly code: GitHubAppErrorCode;
  readonly path: string | null;
  constructor(code: GitHubAppErrorCode, message: string, path: string | null = null) {
    super(message);
    this.name = 'GitHubAppError';
    this.code = code;
    this.path = path;
  }
}

// ---------------------------------------------------------------------------
// Declarative taskpack manifests (.loopwright/taskpack.yaml)
// ---------------------------------------------------------------------------

export const TASKPACK_MANIFEST_API_VERSION = 'loopwright.dev/v1alpha1' as const;
export const TASKPACK_MANIFEST_BYTES = 65_536;
/** Automation paths every target repository keeps protected, regardless of the manifest. */
export const PROTECTED_AUTOMATION_PATHS: readonly string[] = Object.freeze(['.github', '.loopwright/policies', 'AGENTS.md', 'CLAUDE.md']);

export type TaskpackUpstreamKind = 'github-release' | 'git-tag' | 'git-commit' | 'http-json' | 'custom-table';
export type TaskpackCommentCommand = 'retry' | 'revise' | 'status';
export const TASKPACK_COMMENT_COMMANDS: readonly TaskpackCommentCommand[] = Object.freeze(['retry', 'revise', 'status']);
export const DEFAULT_COMMENT_PREFIXES: readonly string[] = Object.freeze(['/loopwright']);

export interface TaskpackUpstreamDescriptor {
  readonly id: string;
  readonly kind: TaskpackUpstreamKind;
  readonly source: string;
  readonly watchedPaths: readonly string[];
  readonly allowPrerelease?: boolean | undefined;
}

export interface TaskpackCheckDeclaration {
  readonly id: string;
  readonly implementation: 'json-artifact.v1' | 'scope.v1' | 'no-change.v1';
  readonly parameters?: Readonly<Record<string, string | number | boolean | null>> | undefined;
}

export interface TaskpackExternalGateDeclaration {
  readonly id: string;
  readonly gateId: string;
  readonly endpointId: string;
  readonly required: boolean;
}

export interface TaskpackManifest {
  readonly apiVersion: typeof TASKPACK_MANIFEST_API_VERSION;
  readonly kind: 'Taskpack';
  readonly metadata: { readonly name: string };
  readonly spec: {
    readonly goal: { readonly candidate: string; readonly noChange: string };
    readonly scope: { readonly writable: readonly string[]; readonly protected: readonly string[] };
    readonly upstreams: readonly TaskpackUpstreamDescriptor[];
    readonly proposal: { readonly path: string; readonly requiredFields: readonly string[]; readonly schemaVersion: number };
    readonly verification: { readonly localChecks: readonly TaskpackCheckDeclaration[]; readonly externalGates: readonly TaskpackExternalGateDeclaration[] };
    readonly publication: { readonly mode: 'pull_request' | 'disabled'; readonly targetBranch: string; readonly headBranchPrefix: string; readonly titleTemplate: string };
    readonly memory: { readonly directory: string; readonly apply: 'separate-pull-request'; readonly onNoModelBudget: 'deterministic-observations-only' };
    readonly triggers: {
      readonly schedule: boolean;
      readonly workflowDispatch: boolean;
      readonly releasePublished: boolean;
      readonly commentCommands: readonly TaskpackCommentCommand[];
      readonly commentPrefixes: readonly string[];
    };
    readonly sandbox?: TaskpackSandboxDeclaration | undefined;
    readonly decisions?: TaskpackDecisionsDeclaration | undefined;
    readonly models?: readonly TaskpackModelDeclaration[] | undefined;
  };
}

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

export interface TaskpackDecisionsDeclaration {
  readonly enabled: boolean;
  readonly provider?: TaskpackDecisionProviderKind | undefined;
  readonly disclosurePolicy?: TaskpackDecisionDisclosurePolicy | undefined;
  readonly minConfidence?: number | undefined;
  readonly confirmThreshold?: number | undefined;
  readonly hardDeadlineMs?: number | undefined;
  readonly maxAttempts?: 1 | 2 | undefined;
  readonly allowImages?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Declarative GitHub App configuration (github-app.yaml)
// ---------------------------------------------------------------------------

export const GITHUB_APP_CONFIG_API_VERSION = 'loopwright.dev/v1alpha1' as const;
export const GITHUB_APP_CONFIG_BYTES = 65_536;

export interface GitHubAppListenConfig {
  readonly enabled?: boolean | undefined;
  readonly host: string;
  readonly port: number;
  readonly webhookPath?: string | undefined;
}

export interface GitHubAppConfigDocument {
  readonly apiVersion: typeof GITHUB_APP_CONFIG_API_VERSION;
  readonly kind: 'GitHubAppConfig';
  readonly spec: {
    readonly appId: string;
    readonly webhookSecretEnv: string;
    readonly privateKeyEnv: string;
    readonly apiBaseUrl?: string | undefined;
    readonly listen?: GitHubAppListenConfig | undefined;
    readonly tokenTtlSeconds?: number | undefined;
    readonly maxPayloadBytes?: number | undefined;
    readonly taskpackPath?: string | undefined;
    readonly operatorAllowlist?: readonly string[] | undefined;
  };
}

export interface LoadedGitHubAppConfig {
  readonly document: GitHubAppConfigDocument;
  readonly webhookSecret?: string | undefined;
  readonly privateKeyPem?: string | undefined;
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

export interface SandboxPolicyInput {
  readonly workspaceRoot: string;
  readonly writablePaths: readonly string[];
  readonly protectedPaths?: readonly string[] | undefined;
  readonly deniedReadPaths?: readonly string[] | undefined;
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
  readonly provider: string;
  readonly gate?: string | undefined;
  readonly publication?: string | undefined;
}

export interface HostTaskpackBindings {
  readonly mode: 'candidate' | 'no-change';
  readonly repository: string;
  readonly baseRevision: string;
  readonly sourceRevision: string;
  /**
   * Deployment/intake metadata only. The frozen controller compile capability accepts only a null task
   * matrix, so the emitted contract always carries `matrix: null`; this record rides on intake outcomes.
   */
  readonly targetMatrix?: readonly TargetMatrixCell[] | null | undefined;
  readonly roleSelection?: HostRoleSelection | undefined;
  readonly candidateIndex?: number | undefined;
  readonly allowManifestCustomBaseUrl?: boolean | undefined;
  readonly modelsJsonPath?: string | undefined;
  readonly runtimeOptions?: HostRuntimeOptions | undefined;
  readonly budgets: TaskContract['spec']['budgets'];
  readonly gateEndpoints?: readonly HostGateEndpointPlan[] | undefined;
  readonly publicationEndpoint?: HostPublicationEndpointPlan | null | undefined;
  readonly credentialEnvMap: HostCredentialEnvMap;
  readonly resourceVersion?: string | undefined;
  readonly authorPrompt?: string | undefined;
}

export interface CompiledTaskpack {
  readonly registry: TrustedRegistry;
  readonly config: ControllerConfiguration;
  readonly registrySha256: string;
  readonly registryBytes: Buffer;
}

// ---------------------------------------------------------------------------
// Generic repository-agnostic intake
// ---------------------------------------------------------------------------

export type UpstreamAcquisitionStatus = 'available' | 'up_to_date' | 'failed' | 'blocked';

export interface TaskpackUpstreamRecord {
  readonly upstreamId: string;
  readonly status: UpstreamAcquisitionStatus;
  readonly version?: string | undefined;
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
// Tenant identity
// ---------------------------------------------------------------------------

export const REPOSITORY_FULL_NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface TenantIdentity {
  readonly installationId: number;
  readonly repositoryId: number;
  readonly repositoryFullName: string;
  readonly taskpackId: string;
}

// ---------------------------------------------------------------------------
// Webhook verification, delivery deduplication, and intake
// ---------------------------------------------------------------------------

export const MAX_WEBHOOK_BODY_BYTES = 1_048_576;
export const WEBHOOK_DELIVERY_ID_PATTERN = /^[A-Za-z0-9-]{8,128}$/;
export const AUTHORIZED_ASSOCIATIONS: readonly string[] = Object.freeze(['OWNER', 'MEMBER', 'COLLABORATOR']);

export type WebhookSignatureVerification =
  | { readonly ok: true; readonly payloadDigest: string }
  | { readonly ok: false; readonly code: 'WEBHOOK_SIGNATURE_INVALID' | 'WEBHOOK_PAYLOAD_TOO_LARGE'; readonly detail: string };

export type WebhookDeliveryState = 'accepted' | 'processing' | 'succeeded' | 'failed';

export interface WebhookDeliveryRecord {
  readonly deliveryId: string;
  readonly eventName: string;
  readonly payloadDigest: string;
  readonly installationId: number;
  readonly repositoryFullName: string | null;
  readonly receivedAtMs: number;
  updatedAtMs: number;
  state: WebhookDeliveryState;
  failureReason: string | null;
  attemptCount: number;
}

export type WebhookDeliveryOutcome =
  | { readonly kind: 'accepted'; readonly entry: WebhookDeliveryRecord }
  | { readonly kind: 'duplicate'; readonly state: WebhookDeliveryState; readonly entry: WebhookDeliveryRecord }
  | { readonly kind: 'retry_failed'; readonly entry: WebhookDeliveryRecord };

export interface ParsedCommentCommand {
  readonly command: TaskpackCommentCommand;
  readonly guidance: string;
}

export interface WebhookIntakeInput {
  readonly rawBody: Uint8Array;
  readonly signatureHeader: string | undefined;
  readonly secret: string;
  readonly eventName: string;
  readonly deliveryId: string;
  readonly receivedAtMs: number;
  /** Taskpack attribution for the accepted tenant; single-taskpack control planes pin it here. */
  readonly taskpackId?: string | undefined;
  readonly commentPrefixes?: readonly string[] | undefined;
  readonly commentCommands?: readonly TaskpackCommentCommand[] | undefined;
  readonly operatorAllowlist?: readonly string[] | undefined;
}

export type WebhookIntakeOutcome =
  | { readonly kind: 'signature_rejected'; readonly code: 'WEBHOOK_SIGNATURE_INVALID' | 'WEBHOOK_PAYLOAD_TOO_LARGE'; readonly detail: string }
  | { readonly kind: 'delivery_conflict'; readonly detail: string }
  | { readonly kind: 'duplicate'; readonly state: WebhookDeliveryState; readonly entry: WebhookDeliveryRecord }
  | { readonly kind: 'retry_failed'; readonly entry: WebhookDeliveryRecord }
  | { readonly kind: 'ignored'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly code: 'WEBHOOK_ACTOR_UNAUTHORIZED' | 'WEBHOOK_GUIDANCE_INVALID'; readonly detail: string }
  | { readonly kind: 'revoked'; readonly installationId: number | null; readonly repositoryIds: readonly number[]; readonly reason: string }
  | {
    readonly kind: 'accepted';
    readonly eventName: string;
    readonly action: 'discover' | 'revise' | 'status';
    readonly command: ParsedCommentCommand | null;
    readonly entry: WebhookDeliveryRecord;
    readonly tenant: TenantIdentity | null;
  };

// ---------------------------------------------------------------------------
// Tenant admission queue
// ---------------------------------------------------------------------------

export type QueueItemKind = 'discover' | 'schedule' | 'revise' | 'status';
export type QueueItemState = 'pending' | 'leased' | 'completed' | 'failed' | 'blocked' | 'reconcile_required' | 'cancelled';
export type QueueSettleOutcome = 'completed' | 'failed' | 'blocked' | 'reconcile_required';
export type ExpiredLeaseEffect = 'not_executed' | 'reconcile_required';

export interface ActiveLease {
  readonly leaseEpoch: number;
  readonly workerId: string;
  readonly grantedMonotonicMs: string;
  notAfterMonotonicMs: string;
  readonly createdSample: ClockSample;
  lastClockSample: ClockSample;
  revoked: boolean;
}

export interface TenantAdmissionQueueOptions {
  /** Pending cap per (repositoryFullName, taskpackId) group; default 100, configurable 1..100. */
  readonly maxPendingPerGroup?: number | undefined;
  readonly leaseDurationMs?: number | undefined;
  readonly runRoot?: string | undefined;
}

export interface QueueItem {
  readonly queueItemId: string;
  readonly runId: string;
  readonly tenant: TenantIdentity;
  readonly kind: QueueItemKind;
  readonly baseRevision: string;
  readonly command: TaskpackReviseCommand | null;
  readonly payloadDigest: string | null;
  readonly deliveryId: string | null;
  readonly enqueuedAtMs: number;
  state: QueueItemState;
  cancelReason: string | null;
  /** Recorded by reconcileExpiredLease; gates re-leasing after an expired lease. */
  reconcileEffect: ExpiredLeaseEffect | null;
  lease: ActiveLease | null;
}

export type EnqueueInput = {
  readonly kind: QueueItemKind;
  readonly baseRevision: string;
  readonly command?: TaskpackReviseCommand | undefined;
  readonly payloadDigest?: string | undefined;
  readonly deliveryId?: string | undefined;
};

export type EnqueueOutcome =
  | { readonly kind: 'enqueued'; readonly item: QueueItem }
  | { readonly kind: 'coalesced'; readonly item: QueueItem };

export interface LeaseGrant {
  readonly leaseEpoch: number;
  readonly workerId: string;
  readonly queueItemId: string;
  readonly runId: string;
  readonly notAfterMonotonicMs: string;
}

export interface TenantRunPaths {
  readonly runRoot: string;
  readonly runDirectory: string;
  readonly receiptPath: string;
}

export interface QueueCounts {
  readonly pending: number;
  readonly leased: number;
  readonly settled: number;
  readonly reconcileRequired: number;
  readonly cancelled: number;
}

// ---------------------------------------------------------------------------
// Installation token broker
// ---------------------------------------------------------------------------

export type InstallationTokenProfile = 'read_only' | 'publish_pull_request';
export const INSTALLATION_TOKEN_TTL_LIMIT_MS = 3_600_000;
export const DEFAULT_TOKEN_REFRESH_MARGIN_MS = 300_000;

export type InstallationTokenPermissions = Readonly<{
  contents: 'read' | 'write';
  metadata: 'read' | 'write';
  pull_requests?: 'read' | 'write';
}>;

export interface InstallationTokenRequest {
  readonly installationId: number;
  readonly repositoryIds: readonly number[];
  readonly permissions: InstallationTokenPermissions;
}

export interface InstallationTokenResponse {
  readonly token: string;
  readonly expiresAtMs: number;
}

/** Port for minting installation tokens; offline tests bind deterministic mock or loopback transports. */
export interface InstallationTokenTransport {
  createInstallationToken(request: InstallationTokenRequest): Promise<InstallationTokenResponse>;
}

export interface InstallationTokenGrant {
  readonly token: string;
  readonly expiresAtMs: number;
  readonly profile: InstallationTokenProfile;
  readonly installationId: number;
  readonly repositoryId: number;
}

export interface CreateGitHubAppJwtInput {
  readonly appId: number;
  readonly privateKeyPem: string;
  readonly nowSeconds: number;
}

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
// Reusable Action entrypoint
// ---------------------------------------------------------------------------

export interface ResolvedModelCandidate {
  readonly index: number;
  readonly manifestIndex: number;
  readonly selection: PiModelSelection;
  readonly apiKeyEnv?: string | undefined;
  readonly providerEnvName: string;
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
  readonly mode: 'candidate' | 'no-change';
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
  readonly upstreamRecords?: readonly TaskpackUpstreamRecord[] | undefined;
  readonly targetMatrix?: readonly TargetMatrixCell[] | null | undefined;
  readonly budgets?: TaskContract['spec']['budgets'] | undefined;
  readonly gateEndpoints?: readonly HostGateEndpointPlan[] | undefined;
  readonly publicationEndpoint?: HostPublicationEndpointPlan | null | undefined;
  readonly credentialEnvMap?: HostCredentialEnvMap | undefined;
  readonly resourceVersion?: string | undefined;
  readonly authorPrompt?: string | undefined;
  readonly operatorAllowlist?: readonly string[] | undefined;
  readonly commentPrefixes?: readonly string[] | undefined;
  readonly mcpServers?: readonly McpServerAuthDeclaration[] | undefined;
  readonly mcpTransportChallenge?: McpTransportChallenge | null | undefined;
  readonly clockBasis?: ClockBasis | undefined;
  readonly previousClockSample?: ClockSample | undefined;
  readonly currentClockSample?: ClockSample | undefined;
  readonly probeDirectory?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly probeFetch?: typeof globalThis.fetch | undefined;
  readonly probeTimeoutMs?: number | undefined;
  readonly dryRun?: boolean | undefined;
  readonly delegate?: (compiled: WrittenCompiledTaskpack) => Promise<ActionDelegateOutcome>;
}

export interface WrittenCompiledTaskpack extends CompiledTaskpack {
  readonly configBytes: Buffer;
  readonly trustedDirectory: string;
  readonly registryPath: string;
  readonly configPath: string;
}

export type ActionEntrypointResult =
  | {
    readonly kind: 'refused';
    readonly code: 'HOST_PROFILE_UNQUALIFIED' | 'HOST_CLOCK_UNTRUSTED' | 'STORAGE_PROFILE_INSUFFICIENT' | 'MCP_OAUTH_UNSUPPORTED' | 'MCP_AUTHENTICATION_REQUIRED' | 'PROVIDER_OAUTH_UNSUPPORTED';
    readonly reason: string;
    readonly recommendedRunStatus?: 'reconcile_required' | undefined;
  }
  | { readonly kind: 'no_change'; readonly reason: string }
  | { readonly kind: 'blocked'; readonly reason: string; readonly detail?: string }
  | {
    readonly kind: 'compiled';
    readonly manifest: TaskpackManifest;
    readonly intake: TaskpackIntakeOutcome;
    readonly taskpack: WrittenCompiledTaskpack;
    readonly delegateOutcome: { readonly ok: boolean; readonly detail: string } | null;
  };

/** Re-exported utility type so consumers can name a digest without importing core directly. */
export type { Digest };
