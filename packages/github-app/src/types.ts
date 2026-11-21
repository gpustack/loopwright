export * from '@loopwright/taskpack';
export {
  TaskpackError as GitHubAppError,
  TASKPACK_ERROR_CODES as GITHUB_APP_ERROR_CODES,
  type TaskpackErrorCode as GitHubAppErrorCode,
} from '@loopwright/taskpack';

import type {
  ClockSample,
  ParsedCommentCommand,
  TaskpackCommentCommand,
  TaskpackReviseCommand,
  TenantIdentity,
} from '@loopwright/taskpack';

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
    readonly suitePath?: string | undefined;
    readonly operatorAllowlist?: readonly string[] | undefined;
  };
}

export interface LoadedGitHubAppConfig {
  readonly document: GitHubAppConfigDocument;
  readonly webhookSecret?: string | undefined;
  readonly privateKeyPem?: string | undefined;
}

// ---------------------------------------------------------------------------
// Webhook verification, delivery deduplication, and intake
// ---------------------------------------------------------------------------

export const MAX_WEBHOOK_BODY_BYTES = 1_048_576;
export const WEBHOOK_DELIVERY_ID_PATTERN = /^[A-Za-z0-9-]{8,128}$/;

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
  readonly domainId?: string | undefined;
  readonly manifestDigest?: string | undefined;
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
  readonly domainId?: string | undefined;
  readonly manifestDigest?: string | undefined;
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
  readonly domainId?: string | undefined;
  readonly manifestDigest?: string | undefined;
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
