import { createHash, randomBytes } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { LIMITS } from '@loopwright/core';
import {
  assertManifestScopeInvariants,
  assertMultiTenantManifestAuthority,
  COMMIT_SHA_PATTERN,
  DEFAULT_COMMENT_PREFIXES,
  fetchBoundedText,
  GITHUB_PROTECTED_AUTOMATION_PATHS,
  headBranchPrefixesCollide,
  isGitHubTriggerDeclared,
  isPlainRecord,
  loadTaskpackSuite,
  LOCAL_PROTECTED_AUTOMATION_PATHS,
  MULTI_TENANT_HOST_POLICY,
  REPOSITORY_FULL_NAME_PATTERN,
  resolveGitCommitSha,
  resolveManifestControlRoot,
  resolveTaskpackSuite,
  validateTaskpackV2Manifest,
  type LoadedTaskpackSuite,
  type LoadedTaskpackSuiteDomain,
} from '@loopwright/taskpack';
import {
  DEFAULT_GITHUB_API_BASE_URL,
  validateGitHubApiBaseUrl,
  verifySuiteCommentPullRequest,
} from './suite-pr-lookup.js';
import { InstallationTokenBroker, SecretScrubber } from './token-broker.js';
import { intakeWebhookDelivery, verifyWebhookSignature, WebhookDeliveryStore } from './webhook.js';
import { TenantAdmissionQueue } from './tenant-queue.js';
import {
  GitHubAppError,
  WEBHOOK_DELIVERY_ID_PATTERN,
  type ClockSample,
  type GitHubAppErrorCode,
  type QueueItem,
  type TaskpackManifest,
  type TaskpackReviseCommand,
  type TaskpackV2Manifest,
  type TenantIdentity,
  type WebhookDeliveryOutcome,
  type WebhookIntakeOutcome,
} from './types.js';

export { assertMultiTenantManifestAuthority, MULTI_TENANT_HOST_POLICY };

export interface ControlPlaneHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly webhookPath: string;
  readonly queue: TenantAdmissionQueue;
  readonly deliveryStore: WebhookDeliveryStore;
  close(): Promise<void>;
}

export interface ControlPlaneOptions {
  readonly port?: number | undefined;
  readonly host?: string | undefined;
  readonly webhookPath?: string | undefined;
  readonly maxPayloadBytes?: number | undefined;
  readonly webhookSecret: string;
  readonly deliveryStore?: WebhookDeliveryStore | undefined;
  readonly queue?: TenantAdmissionQueue | undefined;
  readonly tokenBroker?: InstallationTokenBroker | undefined;
  readonly scrubber?: SecretScrubber | undefined;
  readonly commentPrefixes?: readonly string[] | undefined;
  readonly commentCommands?: readonly ('retry' | 'revise' | 'status')[] | undefined;
  readonly operatorAllowlist?: readonly string[] | undefined;
  readonly leaseDurationMs?: number | undefined;
  readonly maxPendingPerGroup?: number | undefined;
  /** Taskpack attribution pinned on every accepted webhook of this single-taskpack control plane. */
  readonly taskpackId?: string | undefined;
  /** Base revision bound to webhook-triggered queue items when the operator pins one. */
  readonly baseRevision?: string | undefined;
  /** Optional validated manifest bound to this multi-tenant control plane (enforced under MULTI_TENANT_HOST_POLICY). */
  readonly manifest?: TaskpackManifest | TaskpackV2Manifest | undefined;
  /** Optional validated multi-domain TaskpackSuite bound to this control plane (mutually exclusive with manifest). */
  readonly suite?: LoadedTaskpackSuite | undefined;
  /** Optional suite manifest path loaded under repositoryRoot when suite is omitted (mutually exclusive with manifest). */
  readonly suitePath?: string | undefined;
  /** Optional repository root used when loading suitePath. */
  readonly repositoryRoot?: string | undefined;
  /** Optional GitHub REST API base URL for PR branch ownership lookups on issue_comment webhooks. */
  readonly apiBaseUrl?: string | undefined;
  /** Optional fetch implementation for loopback/mock GitHub API lookups. */
  readonly fetchImpl?: typeof globalThis.fetch | undefined;
}

function systemSample(): ClockSample {
  return { wallMs: Date.now(), monotonicMs: (process.hrtime.bigint() / 1_000_000n).toString() };
}

const STATUS_BY_CODE: Readonly<Partial<Record<GitHubAppErrorCode, number>>> = Object.freeze({
  WEBHOOK_SIGNATURE_INVALID: 401,
  WEBHOOK_PAYLOAD_TOO_LARGE: 413,
  WEBHOOK_DELIVERY_CONFLICT: 409,
  WEBHOOK_DELIVERY_INVALID: 400,
  WEBHOOK_ACTOR_UNAUTHORIZED: 403,
  WEBHOOK_GUIDANCE_INVALID: 403,
  TASKPACK_MANIFEST_INVALID: 400,
  TASKPACK_UNTRUSTED_INTERPOLATION: 400,
  TASKPACK_SCOPE_VIOLATION: 400,
  TASKPACK_HOST_BINDING_INVALID: 400,
  TASKPACK_TRIGGER_UNSUPPORTED: 400,
  TENANT_IDENTITY_INVALID: 400,
  TENANT_BOUNDARY_VIOLATION: 403,
  QUEUE_CAPACITY_EXCEEDED: 429,
  QUEUE_LEASE_FENCED: 409,
  QUEUE_STATE_INVALID: 409,
  TENANT_INSTALLATION_REVOKED: 410,
  TOKEN_BROKER_CONFIG_INVALID: 503,
  TOKEN_SCOPE_VIOLATION: 403,
  TOKEN_SECRET_LEAK_DETECTED: 500,
  TOKEN_TTL_EXCEEDED: 403,
  ACTION_INPUT_INVALID: 400,
  SERVICE_FAULT: 500,
  HOST_PROFILE_UNQUALIFIED: 422,
  HOST_CLOCK_UNTRUSTED: 422,
  STORAGE_PROFILE_INSUFFICIENT: 422,
  MCP_OAUTH_UNSUPPORTED: 422,
  MCP_AUTHENTICATION_REQUIRED: 422,
  PROVIDER_OAUTH_UNSUPPORTED: 422,
});

function statusForError(code: GitHubAppErrorCode): number {
  return STATUS_BY_CODE[code] ?? 500;
}

const TENANT_PATH_PATTERN = /^\/tenants\/([0-9]+)\/([0-9]+)\/([a-z][a-z0-9]*(?:[._-][a-z0-9]+)*)\/(lease|settle)$/;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const SUPPORTED_WEBHOOK_EVENTS = new Set([
  'issue_comment', 'pull_request_review', 'release', 'schedule', 'workflow_dispatch',
  'repository_dispatch', 'installation', 'installation_repositories',
]);

function isClockSample(value: unknown): value is ClockSample {
  if (!isPlainRecord(value)) return false;
  return typeof value['wallMs'] === 'number' && typeof value['monotonicMs'] === 'string';
}

/** Re-read the revise command binding (comment id, head sha, body digest) from the raw webhook payload. */
function readReviseBinding(rawBody: Buffer, overrideHeadSha?: string): TaskpackReviseCommand | null {
  try {
    const payload: unknown = JSON.parse(rawBody.toString('utf8'));
    if (!isPlainRecord(payload)) return null;
    const container = payload['comment'] ?? payload['review'];
    if (!isPlainRecord(container)) return null;
    const id = container['id'];
    const issue = isPlainRecord(payload['issue']) ? payload['issue'] : null;
    const pullRequest = isPlainRecord(payload['pull_request'])
      ? payload['pull_request']
      : (issue !== null && isPlainRecord(issue['pull_request']) ? issue['pull_request'] : null);
    const head = pullRequest !== null && isPlainRecord(pullRequest['head']) ? pullRequest['head'] : null;
    const headSha = overrideHeadSha
      ?? (head !== null && typeof head['sha'] === 'string' && head['sha'].length > 0 ? head['sha'] : null);
    return {
      commandId: typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : 0,
      headSha: headSha ?? 'unknown',
      commandDigest: createHash('sha256').update(rawBody).digest('hex'),
    };
  } catch {
    return null;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number') return JSON.stringify(Object.is(value, -0) ? 0 : value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter(key => record[key] !== undefined).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function summarizeItem(item: QueueItem | undefined): {
  readonly queueItemId: string;
  readonly runId: string;
  readonly kind: string;
  readonly baseRevision: string;
  readonly domainId?: string | undefined;
  readonly manifestDigest?: string | undefined;
} | null {
  if (item === undefined) return null;
  return {
    queueItemId: item.queueItemId,
    runId: item.runId,
    kind: item.kind,
    baseRevision: item.baseRevision,
    ...(item.domainId !== undefined ? { domainId: item.domainId } : {}),
    ...(item.manifestDigest !== undefined ? { manifestDigest: item.manifestDigest } : {}),
  };
}

const MAX_TRACKED_FANOUT_DELIVERIES = 4_096;

interface ValidatedSuiteDomainRecord {
  readonly domain: LoadedTaskpackSuiteDomain;
  readonly manifestDigest: string;
  readonly canonicalManifest: string;
}

function validateSuiteControlPlaneAuthority(suite: LoadedTaskpackSuite): {
  readonly byDomainId: ReadonlyMap<string, ValidatedSuiteDomainRecord>;
  readonly byTaskpackName: ReadonlyMap<string, ValidatedSuiteDomainRecord>;
} {
  if (
    !isPlainRecord(suite.manifest)
    || suite.manifest.kind !== 'TaskpackSuite'
    || !isPlainRecord(suite.manifest.metadata)
    || !IDENTIFIER_PATTERN.test(suite.manifest.metadata.name)
  ) {
    throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', 'invalid TaskpackSuite manifest bound to control plane', '/');
  }
  if (!Array.isArray(suite.domains) || suite.domains.length < 1) {
    throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', 'suite must contain at least one loaded domain', '/spec/domains');
  }
  if (!Array.isArray(suite.suiteProtectedPaths) || suite.suiteProtectedPaths.length > LIMITS.patterns) {
    throw new GitHubAppError(
      'TASKPACK_MANIFEST_INVALID',
      `suite-wide mandatory protected path union exceeds ${LIMITS.patterns} patterns`,
      '/spec/domains',
    );
  }

  const builtInProtectedSet = new Set<string>([
    ...LOCAL_PROTECTED_AUTOMATION_PATHS,
    ...GITHUB_PROTECTED_AUTOMATION_PATHS,
  ]);
  const byDomainId = new Map<string, ValidatedSuiteDomainRecord>();
  const byTaskpackName = new Map<string, ValidatedSuiteDomainRecord>();
  const prByTarget = new Map<string, LoadedTaskpackSuiteDomain[]>();

  for (const [idx, domain] of suite.domains.entries()) {
    if (byDomainId.has(domain.id)) {
      throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', `duplicate suite domain id "${domain.id}"`, `/spec/domains/${idx}/id`);
    }
    if (byTaskpackName.has(domain.manifest.metadata.name)) {
      throw new GitHubAppError(
        'TASKPACK_MANIFEST_INVALID',
        `duplicate taskpack metadata.name "${domain.manifest.metadata.name}" across suite`,
        `/spec/domains/${idx}`,
      );
    }
    assertMultiTenantManifestAuthority(domain.manifest);
    if (
      !Array.isArray(domain.protectedPaths)
      || domain.protectedPaths.length > LIMITS.patterns
      || !domain.protectedPaths.includes(suite.suitePath)
    ) {
      throw new GitHubAppError(
        'TASKPACK_MANIFEST_INVALID',
        `domain "${domain.id}" is missing suite-wide mandatory protected paths`,
        `/spec/domains/${idx}`,
      );
    }
    const manifestProtectedSet = new Set<string>(domain.manifest.spec.scope.protected);
    for (const requiredProtected of suite.suiteProtectedPaths) {
      if (!builtInProtectedSet.has(requiredProtected) && !manifestProtectedSet.has(requiredProtected)) {
        throw new GitHubAppError(
          'TASKPACK_HOST_BINDING_INVALID',
          `domain "${domain.id}" manifest is missing suite-augmented protected path "${requiredProtected}"`,
          `/spec/domains/${idx}/scope/protected`,
        );
      }
    }

    const resolvedControl = resolveManifestControlRoot(domain.manifest, domain.taskpackPath);
    assertManifestScopeInvariants(domain.manifest, {
      controlRoot: resolvedControl.controlRoot,
      manifestPath: resolvedControl.manifestPath,
      extraProtectedPaths: domain.protectedPaths,
      policyProfile: 'github',
      hostPolicy: MULTI_TENANT_HOST_POLICY,
      enforceHostAuthority: true,
    });

    if (domain.manifest.spec.publication.mode === 'pull_request') {
      const tb = domain.manifest.spec.publication.targetBranch;
      const list = prByTarget.get(tb) ?? [];
      for (const prev of list) {
        const prevPrefix = prev.manifest.spec.publication.mode === 'pull_request'
          ? prev.manifest.spec.publication.headBranchPrefix
          : '';
        if (headBranchPrefixesCollide(prevPrefix, domain.manifest.spec.publication.headBranchPrefix)) {
          throw new GitHubAppError(
            'TASKPACK_MANIFEST_INVALID',
            `domains "${prev.id}" and "${domain.id}" declare colliding headBranchPrefix values on targetBranch "${tb}"`,
            `/spec/domains/${idx}`,
          );
        }
      }
      list.push(domain);
      prByTarget.set(tb, list);
    }

    const canonicalManifest = canonicalJson(domain.manifest);
    const manifestDigest = createHash('sha256').update(canonicalManifest, 'utf8').digest('hex');

    const rec: ValidatedSuiteDomainRecord = Object.freeze({
      domain,
      manifestDigest,
      canonicalManifest,
    });
    byDomainId.set(domain.id, rec);
    byTaskpackName.set(domain.manifest.metadata.name, rec);
  }

  return { byDomainId, byTaskpackName };
}

function readWebhookInstallationId(payload: Record<string, unknown>): number | null {
  const installation = isPlainRecord(payload['installation']) ? payload['installation'] : null;
  const id = installation?.['id'];
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
}

function readWebhookRepository(payload: Record<string, unknown>): { readonly id: number; readonly fullName: string } | null {
  const repository = isPlainRecord(payload['repository']) ? payload['repository'] : null;
  const id = repository?.['id'];
  const fullName = repository?.['full_name'];
  if (
    typeof id !== 'number'
    || !Number.isSafeInteger(id)
    || id <= 0
    || typeof fullName !== 'string'
    || !REPOSITORY_FULL_NAME_PATTERN.test(fullName)
  ) {
    return null;
  }
  return { id, fullName };
}

/**
 * Bounded loopback HTTP control plane: constant-time webhook admission, tenant-scoped lease/settle
 * dispatch with scoped installation tokens, and scrubbed structured JSON on every response.
 */
export async function startGitHubAppControlPlane(options: ControlPlaneOptions): Promise<ControlPlaneHandle> {
  if (options.manifest !== undefined && (options.suite !== undefined || options.suitePath !== undefined)) {
    throw new GitHubAppError(
      'TASKPACK_HOST_BINDING_INVALID',
      'control plane cannot bind both single-taskpack manifest and multi-domain suite',
      '/suite',
    );
  }
  if (options.suite !== undefined && options.suitePath !== undefined) {
    throw new GitHubAppError(
      'TASKPACK_HOST_BINDING_INVALID',
      'control plane cannot specify both preloaded suite and suitePath',
      '/suitePath',
    );
  }

  let effectiveSuite: LoadedTaskpackSuite | undefined = options.suite;
  if (effectiveSuite === undefined && options.suitePath !== undefined) {
    if (options.repositoryRoot === undefined || options.repositoryRoot.trim().length === 0) {
      throw new GitHubAppError(
        'TASKPACK_HOST_BINDING_INVALID',
        'control plane suitePath requires repositoryRoot',
        '/repositoryRoot',
      );
    }
    effectiveSuite = await loadTaskpackSuite({
      repositoryRoot: options.repositoryRoot,
      suitePath: options.suitePath,
      policyProfile: 'github',
      hostPolicy: MULTI_TENANT_HOST_POLICY,
      enforceHostAuthority: true,
    });
  }

  const suiteRegistry = effectiveSuite !== undefined
    ? validateSuiteControlPlaneAuthority(effectiveSuite)
    : null;

  if (options.manifest !== undefined) {
    assertMultiTenantManifestAuthority(options.manifest);
    const resolvedControl = resolveManifestControlRoot(options.manifest, options.manifest.manifestPath);
    assertManifestScopeInvariants(options.manifest, {
      controlRoot: resolvedControl.controlRoot,
      manifestPath: resolvedControl.manifestPath,
      policyProfile: 'github',
      hostPolicy: MULTI_TENANT_HOST_POLICY,
      enforceHostAuthority: true,
    });
  }
  const pinnedManifestCanonical = options.manifest !== undefined
    ? canonicalJson(options.manifest)
    : null;
  const effectiveTaskpackId = options.taskpackId ?? options.manifest?.metadata.name;
  const effectiveCommentPrefixes = options.commentPrefixes ?? options.manifest?.spec.triggers.commentPrefixes;
  const effectiveCommentCommands = options.commentCommands ?? options.manifest?.spec.triggers.commentCommands;
  const deliveryStore = options.deliveryStore ?? new WebhookDeliveryStore();
  const queue = options.queue ?? new TenantAdmissionQueue({
    maxPendingPerGroup: options.maxPendingPerGroup,
    leaseDurationMs: options.leaseDurationMs,
  });
  const scrubber = options.scrubber ?? options.tokenBroker?.scrubber ?? new SecretScrubber();
  scrubber.register(options.webhookSecret);
  const queueSummary = { enqueued: 0, coalesced: 0, leased: 0, settled: 0, revoked: 0 };
  const effectiveApiBaseUrl = validateGitHubApiBaseUrl(
    options.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL,
    'ACTION_INPUT_INVALID',
    '/apiBaseUrl',
  );
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const webhookPath = options.webhookPath ?? '/webhooks/github';
  const maxPayloadBytes = options.maxPayloadBytes ?? 1_048_576;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  interface TrackedFanoutDomainEntry {
    readonly tenant: TenantIdentity;
    readonly domainId: string;
    readonly queueItemId: string;
  }

  interface TrackedFanoutDelivery {
    readonly expectedDomains: Set<string>;
    readonly entriesByDomain: Map<string, TrackedFanoutDomainEntry>;
  }

  interface EnqueuedDomainRecord {
    readonly item: QueueItem;
    readonly coalesced: boolean;
    reconcileRequired: boolean;
  }

  interface ActiveRevocationWatch {
    revoked: boolean;
  }

  const MAX_TOTAL_TRACKED_DELIVERY_LINKS = MAX_TRACKED_FANOUT_DELIVERIES * 4;
  const enqueuedByDeliveryDomain = new Map<string, EnqueuedDomainRecord>();
  const fanoutDeliveriesById = new Map<string, TrackedFanoutDelivery>();
  const deliveryIdsByQueueItemId = new Map<string, Set<string>>();
  const activeInstRevocationWatches = new Map<number, Set<ActiveRevocationWatch>>();
  const activeRepoRevocationWatches = new Map<string, Set<ActiveRevocationWatch>>();
  let totalTrackedDeliveryLinks = 0;

  const beginRevocationWatch = (
    installationId: number,
    repositoryId: number,
  ): { readonly watch: ActiveRevocationWatch; readonly release: () => void } => {
    const watch: ActiveRevocationWatch = { revoked: false };
    let instSet = activeInstRevocationWatches.get(installationId);
    if (instSet === undefined) {
      instSet = new Set<ActiveRevocationWatch>();
      activeInstRevocationWatches.set(installationId, instSet);
    }
    instSet.add(watch);
    const repoKey = `${installationId}:${repositoryId}`;
    let repoSet = activeRepoRevocationWatches.get(repoKey);
    if (repoSet === undefined) {
      repoSet = new Set<ActiveRevocationWatch>();
      activeRepoRevocationWatches.set(repoKey, repoSet);
    }
    repoSet.add(watch);
    let released = false;
    return {
      watch,
      release: () => {
        if (released) return;
        released = true;
        const curInst = activeInstRevocationWatches.get(installationId);
        if (curInst !== undefined) {
          curInst.delete(watch);
          if (curInst.size === 0) activeInstRevocationWatches.delete(installationId);
        }
        const curRepo = activeRepoRevocationWatches.get(repoKey);
        if (curRepo !== undefined) {
          curRepo.delete(watch);
          if (curRepo.size === 0) activeRepoRevocationWatches.delete(repoKey);
        }
      },
    };
  };

  const bumpRevocationGeneration = (installationId: number, repositoryIds: readonly number[]): void => {
    if (repositoryIds.length === 0) {
      const instWatches = activeInstRevocationWatches.get(installationId);
      if (instWatches !== undefined) {
        for (const watch of instWatches) watch.revoked = true;
      }
    } else {
      for (const repoId of repositoryIds) {
        const repoWatches = activeRepoRevocationWatches.get(`${installationId}:${repoId}`);
        if (repoWatches !== undefined) {
          for (const watch of repoWatches) watch.revoked = true;
        }
      }
    }
  };

  const unlinkQueueItemDelivery = (queueItemId: string, deliveryId: string): void => {
    const linked = deliveryIdsByQueueItemId.get(queueItemId);
    if (linked !== undefined && linked.delete(deliveryId)) {
      totalTrackedDeliveryLinks = Math.max(0, totalTrackedDeliveryLinks - 1);
      if (linked.size === 0) deliveryIdsByQueueItemId.delete(queueItemId);
    }
  };

  const clearQueueItemLinks = (queueItemId: string): readonly string[] => {
    const linked = deliveryIdsByQueueItemId.get(queueItemId);
    if (linked === undefined) return [];
    const ids = [...linked];
    deliveryIdsByQueueItemId.delete(queueItemId);
    totalTrackedDeliveryLinks = Math.max(0, totalTrackedDeliveryLinks - ids.length);
    return ids;
  };

  const evictDeliveryTracking = (deliveryId: string): void => {
    const state = deliveryStore.getDelivery(deliveryId)?.state;
    const isDeliverySettled = state === undefined || state === 'succeeded';
    const tracked = fanoutDeliveriesById.get(deliveryId);
    if (tracked !== undefined) {
      for (const domainId of tracked.expectedDomains) {
        const rec = enqueuedByDeliveryDomain.get(`${deliveryId}\0${domainId}`);
        if (rec !== undefined && (isDeliverySettled || !rec.reconcileRequired)) {
          enqueuedByDeliveryDomain.delete(`${deliveryId}\0${domainId}`);
        }
      }
      for (const entry of tracked.entriesByDomain.values()) {
        unlinkQueueItemDelivery(entry.queueItemId, deliveryId);
      }
      fanoutDeliveriesById.delete(deliveryId);
    }
  };

  const evictTerminalFanoutDelivery = (): boolean => {
    for (const candidateId of fanoutDeliveriesById.keys()) {
      const state = deliveryStore.getDelivery(candidateId)?.state;
      // Never evict retryable ('failed') deliveries: their completed-domain receipts must stay intact
      // so webhook redelivery does not re-enqueue already-completed domains.
      if (state === undefined || state === 'succeeded') {
        evictDeliveryTracking(candidateId);
        return true;
      }
    }
    return false;
  };

  const evictTerminalDeliveryLinks = (neededLinks: number): void => {
    if (
      totalTrackedDeliveryLinks + neededLinks <= MAX_TOTAL_TRACKED_DELIVERY_LINKS
      && deliveryIdsByQueueItemId.size < MAX_TOTAL_TRACKED_DELIVERY_LINKS
    ) {
      return;
    }
    for (const [candidateItemId, linkedIds] of deliveryIdsByQueueItemId.entries()) {
      for (const id of [...linkedIds]) {
        const state = deliveryStore.getDelivery(id)?.state;
        if (state === undefined || state === 'succeeded') {
          unlinkQueueItemDelivery(candidateItemId, id);
          if (
            totalTrackedDeliveryLinks + neededLinks <= MAX_TOTAL_TRACKED_DELIVERY_LINKS
            && deliveryIdsByQueueItemId.size < MAX_TOTAL_TRACKED_DELIVERY_LINKS
          ) {
            return;
          }
        }
      }
    }
  };

  const reserveDeliveryLinkCapacity = (neededLinks: number): void => {
    evictTerminalDeliveryLinks(neededLinks);
    if (totalTrackedDeliveryLinks + neededLinks > MAX_TOTAL_TRACKED_DELIVERY_LINKS) {
      throw new GitHubAppError(
        'QUEUE_CAPACITY_EXCEEDED',
        'active coalesced delivery tracking capacity exceeded',
        '/webhooks/github',
      );
    }
  };

  const trackQueueItemDelivery = (queueItemId: string, deliveryId: string): void => {
    let set = deliveryIdsByQueueItemId.get(queueItemId);
    if (set !== undefined && set.has(deliveryId)) return;
    evictTerminalDeliveryLinks(1);
    if (
      totalTrackedDeliveryLinks + 1 > MAX_TOTAL_TRACKED_DELIVERY_LINKS
      || (set === undefined && deliveryIdsByQueueItemId.size >= MAX_TOTAL_TRACKED_DELIVERY_LINKS)
    ) {
      throw new GitHubAppError(
        'QUEUE_CAPACITY_EXCEEDED',
        'active coalesced delivery tracking capacity exceeded',
        '/webhooks/github',
      );
    }
    if (set === undefined) {
      set = new Set<string>();
      deliveryIdsByQueueItemId.set(queueItemId, set);
    }
    set.add(deliveryId);
    totalTrackedDeliveryLinks += 1;
  };

  const settleRevokedQueueItems = (
    cancelledQueueItemIds: readonly string[],
    fencedQueueItemIds: readonly string[],
  ): void => {
    const affectedDeliveries = new Set<string>();
    const fencedItemSet = new Set<string>(fencedQueueItemIds);

    for (const queueItemId of cancelledQueueItemIds) {
      for (const deliveryId of clearQueueItemLinks(queueItemId)) {
        affectedDeliveries.add(deliveryId);
      }
    }
    for (const queueItemId of fencedQueueItemIds) {
      for (const deliveryId of clearQueueItemLinks(queueItemId)) {
        affectedDeliveries.add(deliveryId);
      }
    }

    for (const deliveryId of affectedDeliveries) {
      const tracked = fanoutDeliveriesById.get(deliveryId);
      if (tracked !== undefined && tracked.expectedDomains.size > 0) {
        let hasActive = false;
        let hasUnadmitted = false;
        let hasReconcileRequired = false;
        let firstRetryableFailure: string | null = null;
        for (const expectedDomainId of tracked.expectedDomains) {
          const fEntry = tracked.entriesByDomain.get(expectedDomainId);
          if (fEntry === undefined) {
            hasUnadmitted = true;
            continue;
          }
          if (fencedItemSet.has(fEntry.queueItemId)) {
            const rec = enqueuedByDeliveryDomain.get(`${deliveryId}\0${expectedDomainId}`);
            if (rec !== undefined) rec.reconcileRequired = true;
            hasReconcileRequired = true;
            continue;
          }
          const fState = queue.getItem(fEntry.tenant, fEntry.queueItemId)?.state;
          if (fState === undefined) {
            hasUnadmitted = true;
            continue;
          }
          if (fState === 'pending' || fState === 'leased') {
            hasActive = true;
          } else if (fState === 'reconcile_required') {
            hasReconcileRequired = true;
          } else if (fState !== 'completed' && fState !== 'cancelled' && firstRetryableFailure === null) {
            firstRetryableFailure = fState;
          }
        }
        if (!hasActive) {
          if (hasUnadmitted || firstRetryableFailure !== null) {
            deliveryStore.markDeliveryState(deliveryId, 'failed', firstRetryableFailure ?? 'partial_fanout');
          } else {
            // Terminal cancellation or fenced reconciliation-only state: settle delivery and release slots.
            void hasReconcileRequired;
            deliveryStore.markDeliveryState(deliveryId, 'succeeded');
            evictDeliveryTracking(deliveryId);
          }
        }
      } else {
        if (deliveryStore.getDelivery(deliveryId) !== undefined) {
          deliveryStore.markDeliveryState(deliveryId, 'succeeded');
        }
        evictDeliveryTracking(deliveryId);
      }
    }
  };

  const settleExpiredQueueItem = (expiredItem: QueueItem): void => {
    const affectedDeliveries = new Set<string>();
    if (expiredItem.deliveryId !== null) affectedDeliveries.add(expiredItem.deliveryId);
    for (const deliveryId of clearQueueItemLinks(expiredItem.queueItemId)) {
      affectedDeliveries.add(deliveryId);
    }
    for (const deliveryId of affectedDeliveries) {
      if (expiredItem.domainId !== undefined) {
        const rec = enqueuedByDeliveryDomain.get(`${deliveryId}\0${expiredItem.domainId}`);
        if (rec !== undefined) rec.reconcileRequired = true;
      }
      const tracked = fanoutDeliveriesById.get(deliveryId);
      if (tracked !== undefined && tracked.expectedDomains.size > 0) {
        let hasActive = false;
        let hasUnadmitted = false;
        let firstRetryableFailure: string | null = null;
        for (const expectedDomainId of tracked.expectedDomains) {
          const fEntry = tracked.entriesByDomain.get(expectedDomainId);
          if (fEntry === undefined) {
            hasUnadmitted = true;
            continue;
          }
          const fState = fEntry.queueItemId === expiredItem.queueItemId
            ? 'reconcile_required'
            : queue.getItem(fEntry.tenant, fEntry.queueItemId)?.state;
          if (fState === undefined) {
            hasUnadmitted = true;
            continue;
          }
          if (fState === 'pending' || fState === 'leased') {
            hasActive = true;
          } else if (
            fState !== 'completed'
            && fState !== 'cancelled'
            && fState !== 'reconcile_required'
            && firstRetryableFailure === null
          ) {
            firstRetryableFailure = fState;
          }
        }
        if (!hasActive) {
          if (hasUnadmitted || firstRetryableFailure !== null) {
            deliveryStore.markDeliveryState(deliveryId, 'failed', firstRetryableFailure ?? 'partial_fanout');
          } else {
            deliveryStore.markDeliveryState(deliveryId, 'succeeded');
            evictDeliveryTracking(deliveryId);
          }
        }
      } else {
        if (deliveryStore.getDelivery(deliveryId) !== undefined) {
          deliveryStore.markDeliveryState(deliveryId, 'succeeded');
        }
        evictDeliveryTracking(deliveryId);
      }
    }
  };
  queue.setOnLeaseExpiredListener(settleExpiredQueueItem);

  const ensureBoundedFanoutDelivery = (
    deliveryId: string,
    expectedDomainIds: readonly string[],
  ): TrackedFanoutDelivery => {
    let existing = fanoutDeliveriesById.get(deliveryId);
    if (existing === undefined) {
      if (fanoutDeliveriesById.size >= MAX_TRACKED_FANOUT_DELIVERIES && !evictTerminalFanoutDelivery()) {
        throw new GitHubAppError(
          'QUEUE_CAPACITY_EXCEEDED',
          'active fan-out delivery tracking capacity exceeded',
          '/webhooks/github',
        );
      }
      existing = {
        expectedDomains: new Set<string>(expectedDomainIds),
        entriesByDomain: new Map<string, TrackedFanoutDomainEntry>(),
      };
      fanoutDeliveriesById.set(deliveryId, existing);
    } else {
      for (const id of expectedDomainIds) existing.expectedDomains.add(id);
    }
    return existing;
  };

  const respond = (response: ServerResponse, status: number, payload: unknown, deliverRaw?: { readonly marker: string; readonly value: string }): void => {
    // Scrub before computing content-length: tracked secrets shrink the body. A deliberate raw field
    // (the lease-delivered installation token) is re-inserted after scrubbing as the sanctioned channel.
    const marker = deliverRaw?.marker ?? '';
    const scrubbed = scrubber.scrub(JSON.stringify(payload));
    const body = deliverRaw === undefined ? scrubbed : scrubbed.replace(`"${marker}"`, JSON.stringify(deliverRaw.value));
    response.writeHead(status, {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close',
    });
    response.end(body);
  };

  const readBody = async (request: IncomingMessage): Promise<{ readonly ok: true; readonly bytes: Buffer } | { readonly ok: false }> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).byteLength;
      if (size > maxPayloadBytes) return { ok: false };
      chunks.push(chunk as Buffer);
    }
    return { ok: true, bytes: Buffer.concat(chunks) };
  };

  const parseJsonBody = async (request: IncomingMessage): Promise<{ readonly ok: true; readonly body: Record<string, unknown> } | { readonly ok: false; readonly status: number; readonly detail: string }> => {
    const raw = await readBody(request);
    if (!raw.ok) return { ok: false, status: 413, detail: `request body exceeds ${maxPayloadBytes} bytes` };
    try {
      const parsed: unknown = JSON.parse(raw.bytes.toString('utf8'));
      if (!isPlainRecord(parsed)) {
        return { ok: false, status: 400, detail: 'request body must be a JSON object' };
      }
      return { ok: true, body: parsed };
    } catch {
      return { ok: false, status: 400, detail: 'request body is not valid JSON' };
    }
  };

  const respondError = (response: ServerResponse, error: unknown): void => {
    if (error !== null && typeof error === 'object' && 'code' in error) {
      const code = (error as { code: GitHubAppErrorCode }).code;
      const message = error instanceof Error ? error.message.slice(0, 200) : String(code);
      respond(response, statusForError(code), { error: { code, message } });
      return;
    }
    throw error;
  };

  const server: Server = createServer((request, response) => {
    request.on('error', () => undefined);
    response.on('error', () => undefined);
    void handle(request, response).catch((error: unknown) => {
      if (error !== null && typeof error === 'object' && 'code' in error) return respondError(response, error);
      const message = error instanceof Error ? error.message.slice(0, 200) : 'unknown control-plane failure';
      respond(response, 500, { error: { code: 'SERVICE_FAULT', message } });
    });
  });
  // Keep-alive socket resets are routine between cycles; they must never crash the control plane.
  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
    else socket.destroy();
    void error;
  });

  const handleSuiteWebhook = async (
    suite: LoadedTaskpackSuite,
    registry: NonNullable<typeof suiteRegistry>,
    request: IncomingMessage,
    response: ServerResponse,
    rawBytes: Buffer,
    headerDeliveryId: string,
  ): Promise<void> => {
    const eventName = String(request.headers['x-github-event'] ?? '');
    const signatureHeader = request.headers['x-hub-signature-256'] as string | undefined;

    if (eventName === 'installation' || eventName === 'installation_repositories') {
      const revOutcome = intakeWebhookDelivery({
        rawBody: rawBytes,
        signatureHeader,
        secret: options.webhookSecret,
        eventName,
        deliveryId: headerDeliveryId,
        receivedAtMs: Date.now(),
        operatorAllowlist: options.operatorAllowlist,
      }, deliveryStore);
      if (revOutcome.kind === 'signature_rejected') {
        return respond(response, revOutcome.code === 'WEBHOOK_PAYLOAD_TOO_LARGE' ? 413 : 401, { error: { code: revOutcome.code, message: revOutcome.detail } });
      }
      if (revOutcome.kind === 'delivery_conflict') {
        return respond(response, 409, { error: { code: 'WEBHOOK_DELIVERY_CONFLICT', message: revOutcome.detail } });
      }
      if (revOutcome.kind === 'duplicate') {
        return respond(response, 200, { kind: 'duplicate', state: revOutcome.state, deliveryId: revOutcome.entry.deliveryId, attemptCount: revOutcome.entry.attemptCount });
      }
      if (revOutcome.kind === 'ignored') {
        if (deliveryStore.getDelivery(headerDeliveryId) !== undefined) deliveryStore.markDeliveryState(headerDeliveryId, 'succeeded');
        return respond(response, 200, { kind: 'ignored', reason: revOutcome.reason });
      }
      if (revOutcome.kind === 'revoked') {
        const installationId = revOutcome.installationId ?? 0;
        const revoked = revOutcome.repositoryIds.length === 0
          ? queue.revokeInstallationScope(installationId)
          : queue.revokeRepositoryScope(installationId, revOutcome.repositoryIds);
        bumpRevocationGeneration(installationId, revOutcome.repositoryIds);
        settleRevokedQueueItems(revoked.cancelledQueueItemIds, revoked.fencedQueueItemIds);
        if (options.tokenBroker !== undefined) {
          if (revOutcome.repositoryIds.length === 0) options.tokenBroker.revokeInstallationTokens(installationId);
          else options.tokenBroker.revokeRepositoryTokens(installationId, revOutcome.repositoryIds);
        }
        queueSummary.revoked += 1;
        if (deliveryStore.getDelivery(headerDeliveryId) !== undefined) deliveryStore.markDeliveryState(headerDeliveryId, 'succeeded');
        return respond(response, 202, {
          kind: 'revoked',
          installationId: revOutcome.installationId,
          repositoryIds: revOutcome.repositoryIds,
          cancelled: revoked.cancelled,
          fenced: revoked.fenced,
        });
      }
      return respond(response, 200, { kind: 'ignored', reason: 'unhandled revocation state' });
    }

    const verification = verifyWebhookSignature(rawBytes, signatureHeader, options.webhookSecret);
    if (!verification.ok) {
      return respond(response, verification.code === 'WEBHOOK_PAYLOAD_TOO_LARGE' ? 413 : 401, {
        error: { code: verification.code, message: verification.detail },
      });
    }
    if (!WEBHOOK_DELIVERY_ID_PATTERN.test(headerDeliveryId)) {
      throw new GitHubAppError('WEBHOOK_DELIVERY_INVALID', `delivery id "${headerDeliveryId}" must match ^[A-Za-z0-9-]{8,128}$`);
    }

    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawBytes.toString('utf8'));
      if (!isPlainRecord(parsed)) {
        return respond(response, 200, { kind: 'ignored', reason: 'payload is not a JSON object' });
      }
      payload = parsed;
    } catch {
      return respond(response, 200, { kind: 'ignored', reason: 'payload is not valid JSON' });
    }

    if (!SUPPORTED_WEBHOOK_EVENTS.has(eventName)) {
      return respond(response, 200, { kind: 'ignored', reason: `unsupported event ${eventName}` });
    }
    const installationId = readWebhookInstallationId(payload);
    if (installationId === null) {
      return respond(response, 200, { kind: 'ignored', reason: 'missing installation attribution' });
    }
    const repository = readWebhookRepository(payload);
    if (repository === null) {
      return respond(response, 200, { kind: 'ignored', reason: 'missing repository attribution' });
    }

    let delivery: WebhookDeliveryOutcome;
    try {
      delivery = deliveryStore.recordDelivery({
        deliveryId: headerDeliveryId,
        eventName,
        payloadDigest: verification.payloadDigest,
        installationId,
        repositoryFullName: repository.fullName,
        receivedAtMs: Date.now(),
      });
    } catch (error) {
      if (error instanceof GitHubAppError && error.code === 'WEBHOOK_DELIVERY_CONFLICT') {
        return respond(response, 409, { error: { code: 'WEBHOOK_DELIVERY_CONFLICT', message: error.message } });
      }
      throw error;
    }
    if (delivery.kind === 'duplicate') {
      return respond(response, 200, {
        kind: 'duplicate',
        state: delivery.state,
        deliveryId: delivery.entry.deliveryId,
        attemptCount: delivery.entry.attemptCount,
      });
    }

    const entry = delivery.entry;
    const admissionWatch = beginRevocationWatch(installationId, repository.id);
    try {
      let matchedDomains: LoadedTaskpackSuiteDomain[];
    let action: 'discover' | 'revise' | 'status' = 'discover';
    let verifiedPrHeadSha: string | undefined;
    let verifiedPrBaseSha: string | undefined;
    let deferredCellsOut: readonly { readonly domainId: string; readonly reason: string; readonly detail?: string | undefined }[] = [];

    const mintReadOnlyToken = async (targetTaskpackId?: string): Promise<string | undefined> => {
      if (options.tokenBroker === undefined) return undefined;
      const lookupTenant: TenantIdentity = {
        installationId,
        repositoryId: repository.id,
        repositoryFullName: repository.fullName,
        taskpackId: targetTaskpackId ?? suite.domains[0]!.manifest.metadata.name,
      };
      const minted = await options.tokenBroker.mint(lookupTenant, 'read_only');
      scrubber.register(minted.token);
      return minted.token;
    };

    const resolvedBranchShas = new Map<string, string>();
    let cachedDefaultBranch: string | null | undefined;
    const resolveRepositoryDefaultBranch = async (targetTaskpackId?: string): Promise<
      | { readonly ok: true; readonly branch: string }
      | { readonly ok: false; readonly status: 400 | 502; readonly message: string }
    > => {
      if (typeof cachedDefaultBranch === 'string') return { ok: true, branch: cachedDefaultBranch };
      const repoObj = isPlainRecord(payload['repository']) ? payload['repository'] : null;
      const payloadDefault = typeof repoObj?.['default_branch'] === 'string' ? repoObj['default_branch'].trim() : '';
      if (payloadDefault.length > 0) {
        cachedDefaultBranch = payloadDefault;
        return { ok: true, branch: payloadDefault };
      }
      if (options.tokenBroker !== undefined) {
        try {
          const token = await mintReadOnlyToken(targetTaskpackId);
          const headers: Record<string, string> = {
            accept: 'application/vnd.github+json',
            'user-agent': 'loopwright-github-app',
            ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
          };
          const res = await fetchBoundedText(
            `${effectiveApiBaseUrl}/repos/${repository.fullName}`,
            fetchImpl,
            headers,
            15_000,
            scrubber,
          );
          if (!res.ok) {
            return {
              ok: false,
              status: 502,
              message: scrubber.scrub(`failed to query repository default branch (HTTP ${res.status})`),
            };
          }
          const parsedRepo = JSON.parse(res.text) as unknown;
          const defBranch = isPlainRecord(parsedRepo) && typeof parsedRepo['default_branch'] === 'string'
            ? parsedRepo['default_branch'].trim()
            : '';
          if (defBranch.length > 0) {
            cachedDefaultBranch = defBranch;
            return { ok: true, branch: defBranch };
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return {
            ok: false,
            status: 502,
            message: scrubber.scrub(`failed to query repository default branch: ${detail}`),
          };
        }
      }
      if (options.repositoryRoot !== undefined) {
        cachedDefaultBranch = 'HEAD';
        return { ok: true, branch: 'HEAD' };
      }
      return {
        ok: false,
        status: 400,
        message: scrubber.scrub('cannot determine repository default branch for publication-disabled domain'),
      };
    };

    const resolveRefToCommitSha = async (refName: string, targetTaskpackId?: string): Promise<
      | { readonly ok: true; readonly sha: string }
      | { readonly ok: false; readonly status: 400 | 502; readonly message: string }
    > => {
      const trimmedRef = refName.trim();
      if (COMMIT_SHA_PATTERN.test(trimmedRef)) {
        return { ok: true, sha: trimmedRef.toLowerCase() };
      }
      const cached = resolvedBranchShas.get(trimmedRef);
      if (cached !== undefined) return { ok: true, sha: cached };
      if (options.tokenBroker !== undefined && trimmedRef !== 'HEAD') {
        try {
          const token = await mintReadOnlyToken(targetTaskpackId);
          const headers: Record<string, string> = {
            accept: 'application/vnd.github+json',
            'user-agent': 'loopwright-github-app',
            ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
          };
          const normalizedBranch = trimmedRef.replace(/^refs\/heads\//, '');
          const refPath = normalizedBranch.split('/').map(seg => encodeURIComponent(seg)).join('/');
          const res = await fetchBoundedText(
            `${effectiveApiBaseUrl}/repos/${repository.fullName}/git/ref/heads/${refPath}`,
            fetchImpl,
            headers,
            15_000,
            scrubber,
          );
          if (!res.ok) {
            return {
              ok: false,
              status: 502,
              message: scrubber.scrub(`failed to resolve branch "${trimmedRef}" head SHA (HTTP ${res.status})`),
            };
          }
          const parsedRef = JSON.parse(res.text) as unknown;
          const obj = isPlainRecord(parsedRef) && isPlainRecord(parsedRef['object']) ? parsedRef['object'] : null;
          const sha = typeof obj?.['sha'] === 'string' ? obj['sha'].trim() : '';
          if (!COMMIT_SHA_PATTERN.test(sha)) {
            return {
              ok: false,
              status: 502,
              message: scrubber.scrub(`GitHub ref response for "${trimmedRef}" did not contain a valid 40-hex commit SHA`),
            };
          }
          const lower = sha.toLowerCase();
          resolvedBranchShas.set(trimmedRef, lower);
          return { ok: true, sha: lower };
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return {
            ok: false,
            status: 502,
            message: scrubber.scrub(`failed to resolve branch "${trimmedRef}" head SHA: ${detail}`),
          };
        }
      }
      if (options.repositoryRoot !== undefined) {
        try {
          const localSha = await resolveGitCommitSha(options.repositoryRoot, trimmedRef, 15_000);
          resolvedBranchShas.set(trimmedRef, localSha);
          return { ok: true, sha: localSha };
        } catch {
          // Fall through to fail-closed error below.
        }
      }
      return {
        ok: false,
        status: 400,
        message: scrubber.scrub(`cannot establish pinned baseRevision commit SHA for ref "${trimmedRef}"`),
      };
    };

    const resolveTargetBranchBaseSha = async (domain: LoadedTaskpackSuiteDomain): Promise<
      | { readonly ok: true; readonly sha: string }
      | { readonly ok: false; readonly status: 400 | 502; readonly message: string }
    > => {
      if (options.baseRevision !== undefined && options.baseRevision.trim().length > 0) {
        const overrideRes = await resolveRefToCommitSha(options.baseRevision, domain.manifest.metadata.name);
        if (!overrideRes.ok) return overrideRes;
        if (
          action !== 'status'
          && verifiedPrBaseSha !== undefined
          && COMMIT_SHA_PATTERN.test(verifiedPrBaseSha)
          && overrideRes.sha.toLowerCase() !== verifiedPrBaseSha.toLowerCase()
        ) {
          return {
            ok: false,
            status: 400,
            message: scrubber.scrub(
              `configured baseRevision "${overrideRes.sha}" disagrees with verified pull request base SHA "${verifiedPrBaseSha}"`,
            ),
          };
        }
        return overrideRes;
      }
      if (verifiedPrBaseSha !== undefined && COMMIT_SHA_PATTERN.test(verifiedPrBaseSha)) {
        return { ok: true, sha: verifiedPrBaseSha.toLowerCase() };
      }
      const payloadAfter = typeof payload['after'] === 'string' ? payload['after'].trim() : '';
      if (COMMIT_SHA_PATTERN.test(payloadAfter)) {
        return { ok: true, sha: payloadAfter.toLowerCase() };
      }
      if (domain.manifest.spec.publication.mode === 'pull_request') {
        return resolveRefToCommitSha(domain.manifest.spec.publication.targetBranch, domain.manifest.metadata.name);
      }
      const defBranchRes = await resolveRepositoryDefaultBranch(domain.manifest.metadata.name);
      if (!defBranchRes.ok) return defBranchRes;
      return resolveRefToCommitSha(defBranchRes.branch, domain.manifest.metadata.name);
    };

    let verifiedPrHeadRef: string | undefined;
    let verifiedPrBaseRef: string | undefined;
    let verifiedScheduleKey: string | undefined;

    if (eventName === 'issue_comment' || eventName === 'pull_request_review') {
      const prCheck = await verifySuiteCommentPullRequest({
        suite,
        eventName,
        eventPayload: payload,
        repositoryFullName: repository.fullName,
        apiBaseUrl: effectiveApiBaseUrl,
        commentPrefixes: options.commentPrefixes,
        commentCommands: options.commentCommands,
        operatorAllowlist: options.operatorAllowlist,
        fetchImpl,
        scrubber,
        resolveToken: options.tokenBroker !== undefined ? mintReadOnlyToken : undefined,
      });

      if (prCheck.kind === 'ignored' || prCheck.kind === 'missing_attribution') {
        deliveryStore.markDeliveryState(headerDeliveryId, 'succeeded');
        return respond(response, 200, {
          kind: 'ignored',
          reason: prCheck.kind === 'ignored' ? prCheck.reason : 'comment payload is unreadable',
        });
      }
      if (prCheck.kind === 'unauthorized' || prCheck.kind === 'invalid_guidance') {
        deliveryStore.markDeliveryState(headerDeliveryId, 'succeeded');
        return respond(response, 403, {
          kind: 'rejected',
          code: prCheck.code,
          detail: prCheck.detail,
        });
      }
      if (prCheck.kind === 'lookup_failed') {
        deliveryStore.markDeliveryState(headerDeliveryId, 'failed', 'ACTION_INPUT_INVALID');
        return respond(response, 502, {
          error: {
            code: 'ACTION_INPUT_INVALID',
            reason: prCheck.reason,
            message: prCheck.detail,
          },
        });
      }
      if (prCheck.kind === 'metadata_unavailable') {
        deliveryStore.markDeliveryState(headerDeliveryId, 'succeeded');
        return respond(response, 400, {
          error: {
            code: 'ACTION_INPUT_INVALID',
            reason: prCheck.reason,
            message: prCheck.detail,
          },
        });
      }
      if (prCheck.kind === 'cross_fork' || prCheck.kind === 'scope_violation') {
        deliveryStore.markDeliveryState(headerDeliveryId, 'succeeded');
        return respond(response, 400, {
          error: {
            code: 'TASKPACK_SCOPE_VIOLATION',
            reason: prCheck.reason,
            message: prCheck.detail,
          },
        });
      }

      const targetDomain = prCheck.value.domain;
      const parsedCmd = prCheck.value.comment;
      verifiedPrHeadSha = prCheck.value.prHeadSha;
      verifiedPrBaseSha = prCheck.value.prBaseSha;
      verifiedPrHeadRef = prCheck.value.prHeadRef;
      verifiedPrBaseRef = prCheck.value.prBaseRef;

      if (!targetDomain.enabled) {
        deliveryStore.markDeliveryState(headerDeliveryId, 'succeeded');
        return respond(response, 200, { kind: 'ignored', reason: `suite domain "${targetDomain.id}" is disabled` });
      }
      const domainPrefixes = targetDomain.manifest.spec.triggers.commentPrefixes.length > 0
        ? targetDomain.manifest.spec.triggers.commentPrefixes
        : DEFAULT_COMMENT_PREFIXES;
      if (options.commentPrefixes === undefined && !domainPrefixes.includes(parsedCmd.prefix)) {
        deliveryStore.markDeliveryState(headerDeliveryId, 'succeeded');
        return respond(response, 200, { kind: 'ignored', reason: `prefix "${parsedCmd.prefix}" is not configured on domain "${targetDomain.id}"` });
      }
      if (
        !isGitHubTriggerDeclared(targetDomain.manifest.spec.triggers, {
          eventName,
          commentCommand: parsedCmd.command,
        })
      ) {
        deliveryStore.markDeliveryState(headerDeliveryId, 'succeeded');
        return respond(response, 200, {
          kind: 'ignored',
          code: 'TASKPACK_TRIGGER_UNSUPPORTED',
          reason: `comment command "${parsedCmd.command}" is not enabled on domain "${targetDomain.id}"`,
        });
      }

      matchedDomains = [targetDomain];
      action = parsedCmd.command === 'retry' ? 'discover' : parsedCmd.command === 'revise' ? 'revise' : 'status';
    } else {
      if (eventName === 'release') {
        const releaseAction = typeof payload['action'] === 'string' ? payload['action'] : '';
        if (releaseAction !== 'published') {
          deliveryStore.markDeliveryState(headerDeliveryId, 'succeeded');
          return respond(response, 200, { kind: 'ignored', reason: `release action ${releaseAction} is not published` });
        }
      }
      verifiedScheduleKey = eventName === 'schedule' && typeof payload['schedule'] === 'string' && payload['schedule'].length > 0
        ? payload['schedule']
        : undefined;
      matchedDomains = suite.domains.filter(dom => {
        if (!dom.enabled) return false;
        if (!isGitHubTriggerDeclared(dom.manifest.spec.triggers, { eventName })) return false;
        if (eventName === 'schedule') {
          return verifiedScheduleKey !== undefined
            ? (dom.schedules !== undefined && dom.schedules.includes(verifiedScheduleKey))
            : (dom.schedules === undefined || dom.schedules.length > 0);
        }
        return true;
      });

      if (matchedDomains.length === 0) {
        deliveryStore.markDeliveryState(headerDeliveryId, 'succeeded');
        return respond(response, 200, {
          kind: 'ignored',
          code: 'TASKPACK_TRIGGER_UNSUPPORTED',
          reason: `trigger "${eventName}" matched zero enabled suite domains`,
        });
      }
    }

    const baseShaByDomain = new Map<string, string>();
    for (const domain of matchedDomains) {
      const baseRes = await resolveTargetBranchBaseSha(domain);
      if (!baseRes.ok) {
        if (baseRes.status === 502) {
          deliveryStore.markDeliveryState(headerDeliveryId, 'failed', 'ACTION_INPUT_INVALID');
        } else {
          deliveryStore.markDeliveryState(headerDeliveryId, 'succeeded');
        }
        return respond(response, baseRes.status, {
          error: { code: 'ACTION_INPUT_INVALID', message: baseRes.message },
        });
      }
      baseShaByDomain.set(domain.id, baseRes.sha);
    }

    // Evaluate stage readiness for every execution-triggering event with staged domains (including
    // single-stage readiness probes and comment-triggered retry/revise) against each domain's pinned SHA.
    const stagedMatchedDomains = action !== 'status'
      ? matchedDomains.filter(dom => dom.stage !== undefined)
      : [];
    if (stagedMatchedDomains.length > 0) {
      const parsedApiUrl = new URL(effectiveApiBaseUrl);
      const allowLoopbackForStage = parsedApiUrl.protocol === 'http:'
        && (
          parsedApiUrl.hostname === '127.0.0.1'
          || parsedApiUrl.hostname === 'localhost'
          || parsedApiUrl.hostname === '[::1]'
          || parsedApiUrl.hostname === '::1'
        );
      const eligibleIds = new Set<string>(matchedDomains.filter(dom => dom.stage === undefined).map(d => d.id));
      const deferredList: Array<{ readonly domainId: string; readonly reason: string; readonly detail?: string | undefined }> = [];
      let lastStageReason = 'stage_not_ready';
      let lastStageDetail: string | undefined;

      const stagedDomainsBySha = new Map<string, LoadedTaskpackSuiteDomain[]>();
      for (const stagedDom of stagedMatchedDomains) {
        const domainBaseSha = baseShaByDomain.get(stagedDom.id)!;
        const list = stagedDomainsBySha.get(domainBaseSha);
        if (list !== undefined) list.push(stagedDom);
        else stagedDomainsBySha.set(domainBaseSha, [stagedDom]);
      }

      for (const [domainBaseSha, shaGroup] of stagedDomainsBySha.entries()) {
        let stageResolution;
        try {
          stageResolution = await resolveTaskpackSuite({
            repositoryRoot: options.repositoryRoot ?? process.cwd(),
            loadedSuite: suite,
            policyProfile: 'github',
            hostPolicy: MULTI_TENANT_HOST_POLICY,
            allowLoopbackHttp: allowLoopbackForStage,
            baseRevision: domainBaseSha,
            remoteBaseRevision: true,
            eventName,
            eventPayload: payload,
            schedule: verifiedScheduleKey,
            ...(shaGroup.length === 1
              ? { domain: shaGroup[0]!.id }
              : { domains: shaGroup.map(d => d.id) }),
            ...(options.commentPrefixes !== undefined ? { commentPrefixes: options.commentPrefixes } : {}),
            ...(verifiedPrHeadRef !== undefined ? { prHeadRef: verifiedPrHeadRef } : {}),
            ...(verifiedPrBaseRef !== undefined ? { prBaseRef: verifiedPrBaseRef } : {}),
            ...(verifiedPrHeadSha !== undefined ? { prHeadSha: verifiedPrHeadSha } : {}),
            ...(verifiedPrHeadRef !== undefined ? { prHeadRepoFullName: repository.fullName, prHeadRepoFork: false } : {}),
            operatorAllowlist: options.operatorAllowlist,
            repositoryFullName: repository.fullName,
            apiBaseUrl: effectiveApiBaseUrl,
            githubToken: options.tokenBroker !== undefined
              ? () => mintReadOnlyToken(shaGroup[0]!.manifest.metadata.name)
              : undefined,
            fetchImpl,
            scrubber,
            discoverUpstreamUpdates: true,
          });
        } catch (error) {
          const detail = scrubber.scrub(error instanceof Error ? error.message : String(error));
          deliveryStore.markDeliveryState(headerDeliveryId, 'failed', 'ACTION_INPUT_INVALID');
          return respond(response, 502, {
            error: {
              code: 'ACTION_INPUT_INVALID',
              reason: 'stage_resolution_failed',
              message: detail,
            },
          });
        }
        if (stageResolution.disposition === 'blocked') {
          const isStaticError = stageResolution.code === 'TASKPACK_SCOPE_VIOLATION'
            || stageResolution.code === 'TASKPACK_MANIFEST_INVALID';
          if (isStaticError) {
            deliveryStore.markDeliveryState(headerDeliveryId, 'succeeded');
          } else {
            deliveryStore.markDeliveryState(headerDeliveryId, 'failed', stageResolution.code ?? 'ACTION_INPUT_INVALID');
          }
          return respond(response, isStaticError ? 400 : 502, {
            kind: 'blocked',
            code: stageResolution.code ?? 'ACTION_INPUT_INVALID',
            reason: stageResolution.reason,
            detail: stageResolution.detail,
            cells: stageResolution.cells,
          });
        }
        for (const stagedDom of shaGroup) {
          if (stageResolution.eligibleCells.some(c => c.domainId === stagedDom.id)) {
            eligibleIds.add(stagedDom.id);
          } else {
            lastStageReason = stageResolution.reason;
            lastStageDetail ??= stageResolution.detail;
            const cell = stageResolution.cells.find(c => c.domainId === stagedDom.id);
            deferredList.push({
              domainId: stagedDom.id,
              reason: cell?.reason ?? stageResolution.reason,
              ...(cell?.detail !== undefined
                ? { detail: cell.detail }
                : (stageResolution.detail !== undefined ? { detail: stageResolution.detail } : {})),
            });
          }
        }
      }
      deferredCellsOut = deferredList;
      matchedDomains = matchedDomains.filter(dom => eligibleIds.has(dom.id));
      if (matchedDomains.length === 0) {
        deliveryStore.markDeliveryState(headerDeliveryId, 'succeeded');
        return respond(response, 200, {
          kind: 'deferred',
          reason: lastStageReason,
          ...(lastStageDetail !== undefined ? { detail: lastStageDetail } : {}),
          deferredDomains: deferredCellsOut,
        });
      }
    }

      if (admissionWatch.watch.revoked) {
        deliveryStore.markDeliveryState(entry.deliveryId, 'succeeded');
        return respond(response, 200, {
          kind: 'ignored',
          reason: 'installation_revoked_during_admission',
        });
      }

      deliveryStore.markDeliveryState(entry.deliveryId, 'processing');
      try {
        const trackedDelivery = ensureBoundedFanoutDelivery(entry.deliveryId, matchedDomains.map(d => d.id));
        const kind = action === 'revise' ? 'revise' : action === 'status' ? 'status' : 'discover';
        const reviseBinding = kind === 'revise' ? readReviseBinding(rawBytes, verifiedPrHeadSha) : null;
        const admitted: Array<{
          readonly domainId: string;
          readonly taskpackId: string;
          readonly manifestDigest: string;
          readonly queueItemId: string;
          readonly runId: string;
          readonly coalesced: boolean;
        }> = [];

        for (const domain of matchedDomains) {
          const domainRec = registry.byDomainId.get(domain.id)!;
          const tenant: TenantIdentity = {
            installationId,
            repositoryId: repository.id,
            repositoryFullName: repository.fullName,
            taskpackId: domain.manifest.metadata.name,
          };
          const dedupKey = `${entry.deliveryId}\0${domain.id}`;
          let enqueuedRecord = enqueuedByDeliveryDomain.get(dedupKey);
          if (enqueuedRecord !== undefined && delivery.kind === 'retry_failed') {
            const liveItem = queue.getItem(tenant, enqueuedRecord.item.queueItemId);
            const isReconcileLocked = enqueuedRecord.reconcileRequired || liveItem?.state === 'reconcile_required';
            if (
              !isReconcileLocked
              && (
                liveItem === null
                || liveItem.state === 'failed'
                || liveItem.state === 'blocked'
                || liveItem.state === 'cancelled'
              )
            ) {
              enqueuedByDeliveryDomain.delete(dedupKey);
              enqueuedRecord = undefined;
            }
          }
          if (enqueuedRecord === undefined) {
            reserveDeliveryLinkCapacity(1);
            const outcome = queue.enqueue(tenant, {
              kind,
              baseRevision: baseShaByDomain.get(domain.id)!,
              deliveryId: entry.deliveryId,
              payloadDigest: entry.payloadDigest,
              domainId: domain.id,
              manifestDigest: domainRec.manifestDigest,
              ...(kind === 'revise'
                ? {
                  command: reviseBinding ?? {
                    commandId: 0,
                    headSha: verifiedPrHeadSha ?? tenant.repositoryFullName,
                    commandDigest: entry.payloadDigest,
                  },
                }
                : {}),
            });
            enqueuedRecord = { item: outcome.item, coalesced: outcome.kind === 'coalesced', reconcileRequired: false };
            enqueuedByDeliveryDomain.set(dedupKey, enqueuedRecord);
            queueSummary.enqueued += outcome.kind === 'coalesced' ? 0 : 1;
            queueSummary.coalesced += outcome.kind === 'coalesced' ? 1 : 0;
            trackedDelivery.entriesByDomain.set(domain.id, {
              tenant,
              domainId: domain.id,
              queueItemId: outcome.item.queueItemId,
            });
            trackQueueItemDelivery(outcome.item.queueItemId, entry.deliveryId);
          }
          admitted.push({
            domainId: domain.id,
            taskpackId: domain.manifest.metadata.name,
            manifestDigest: domainRec.manifestDigest,
            queueItemId: enqueuedRecord.item.queueItemId,
            runId: enqueuedRecord.item.runId,
            coalesced: enqueuedRecord.coalesced,
          });
        }

        // Recompute live delivery state after admission (critical on retry_failed when a previously
        // failed sibling domain is now deferred and only already-completed domains matched).
        let hasActiveWork = false;
        let hasUnadmittedOrFailed = deferredCellsOut.length > 0;
        let firstFailureReason: string | null = deferredCellsOut.length > 0 ? 'stage_not_ready' : null;
        for (const expectedDomainId of trackedDelivery.expectedDomains) {
          const fEntry = trackedDelivery.entriesByDomain.get(expectedDomainId);
          if (fEntry === undefined) {
            hasUnadmittedOrFailed = true;
            firstFailureReason ??= 'partial_fanout';
            continue;
          }
          const fState = queue.getItem(fEntry.tenant, fEntry.queueItemId)?.state;
          if (fState === undefined) {
            hasUnadmittedOrFailed = true;
            firstFailureReason ??= 'partial_fanout';
            continue;
          }
          if (fState === 'pending' || fState === 'leased') {
            hasActiveWork = true;
          } else if (fState !== 'completed' && fState !== 'cancelled' && fState !== 'reconcile_required') {
            hasUnadmittedOrFailed = true;
            firstFailureReason ??= fState;
          }
        }
        if (!hasActiveWork) {
          if (hasUnadmittedOrFailed) {
            // Preserve completed receipts while leaving delivery retryable for deferred/failed siblings.
            deliveryStore.markDeliveryState(entry.deliveryId, 'failed', firstFailureReason ?? 'partial_fanout');
            return respond(response, 200, {
              kind: 'deferred',
              reason: firstFailureReason ?? 'stage_not_ready',
              ...(deferredCellsOut.length > 0 ? { deferredDomains: deferredCellsOut } : {}),
              domains: admitted,
            });
          }
          deliveryStore.markDeliveryState(entry.deliveryId, 'succeeded');
          evictDeliveryTracking(entry.deliveryId);
        }

        return respond(response, 202, {
          kind: 'accepted',
          action,
          suiteName: suite.manifest.metadata.name,
          domains: admitted,
          ...(deferredCellsOut.length > 0 ? { deferredDomains: deferredCellsOut } : {}),
          queueItemId: admitted[0]!.queueItemId,
          runId: admitted[0]!.runId,
          coalesced: admitted.every(a => a.coalesced),
          attemptCount: entry.attemptCount,
        });
      } catch (error) {
        const failedTracker = fanoutDeliveriesById.get(entry.deliveryId);
        if (failedTracker !== undefined && failedTracker.entriesByDomain.size === 0) {
          fanoutDeliveriesById.delete(entry.deliveryId);
        }
        if (error !== null && typeof error === 'object' && 'code' in error) {
          if (WEBHOOK_DELIVERY_ID_TEST.test(entry.deliveryId)) {
            deliveryStore.markDeliveryState(entry.deliveryId, 'failed', String((error as { code: unknown }).code));
          }
          return respondError(response, error);
        }
        throw error;
      }
    } catch (outerError) {
      const currentState = deliveryStore.getDelivery(entry.deliveryId)?.state;
      if (currentState !== 'succeeded' && currentState !== 'failed') {
        const errCode = (outerError !== null && typeof outerError === 'object' && 'code' in outerError)
          ? String((outerError as { code: unknown }).code)
          : 'SERVICE_FAULT';
        deliveryStore.markDeliveryState(entry.deliveryId, 'failed', errCode);
      }
      throw outerError;
    } finally {
      admissionWatch.release();
    }
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const method = request.method ?? 'GET';
    const headerDeliveryId = String(request.headers['x-github-delivery'] ?? '');

    if (url.pathname === '/healthz') {
      if (method !== 'GET') return respond(response, 405, { error: { code: 'SERVICE_FAULT', message: 'method not allowed' } });
      return respond(response, 200, { ok: true, queue: { ...queueSummary }, deliveries: deliveryStore.counts() });
    }

    if (url.pathname === webhookPath) {
      if (method !== 'POST') return respond(response, 405, { error: { code: 'SERVICE_FAULT', message: 'method not allowed' } });
      const raw = await readBody(request);
      if (!raw.ok) return respond(response, 413, { error: { code: 'WEBHOOK_PAYLOAD_TOO_LARGE', message: `webhook body exceeds ${maxPayloadBytes} bytes` } });

      if (effectiveSuite !== undefined && suiteRegistry !== null) {
        return handleSuiteWebhook(effectiveSuite, suiteRegistry, request, response, raw.bytes, headerDeliveryId);
      }

      const outcome: WebhookIntakeOutcome = intakeWebhookDelivery({
        rawBody: raw.bytes,
        signatureHeader: request.headers['x-hub-signature-256'] as string | undefined,
        secret: options.webhookSecret,
        eventName: String(request.headers['x-github-event'] ?? ''),
        deliveryId: headerDeliveryId,
        receivedAtMs: Date.now(),
        taskpackId: effectiveTaskpackId,
        commentPrefixes: effectiveCommentPrefixes,
        commentCommands: effectiveCommentCommands,
        operatorAllowlist: options.operatorAllowlist,
      }, deliveryStore);
      if (outcome.kind === 'signature_rejected') {
        return respond(response, outcome.code === 'WEBHOOK_PAYLOAD_TOO_LARGE' ? 413 : 401, { error: { code: outcome.code, message: outcome.detail } });
      }
      if (outcome.kind === 'delivery_conflict') {
        return respond(response, 409, { error: { code: 'WEBHOOK_DELIVERY_CONFLICT', message: outcome.detail } });
      }
      if (outcome.kind === 'duplicate') {
        return respond(response, 200, { kind: 'duplicate', state: outcome.state, deliveryId: outcome.entry.deliveryId, attemptCount: outcome.entry.attemptCount });
      }
      if (outcome.kind === 'ignored') {
        if (deliveryStore.getDelivery(headerDeliveryId) !== undefined) deliveryStore.markDeliveryState(headerDeliveryId, 'succeeded');
        return respond(response, 200, { kind: 'ignored', reason: outcome.reason });
      }
      if (outcome.kind === 'rejected') {
        if (deliveryStore.getDelivery(headerDeliveryId) !== undefined) deliveryStore.markDeliveryState(headerDeliveryId, 'succeeded');
        return respond(response, 403, { kind: 'rejected', code: outcome.code, detail: outcome.detail });
      }
      if (outcome.kind === 'revoked') {
        const installationId = outcome.installationId ?? 0;
        // installation.deleted / suspend revoke the whole installation; installation_repositories.removed
        // revokes only the removed repositories and leaves sibling repositories untouched.
        const revoked = outcome.repositoryIds.length === 0
          ? queue.revokeInstallationScope(installationId)
          : queue.revokeRepositoryScope(installationId, outcome.repositoryIds);
        bumpRevocationGeneration(installationId, outcome.repositoryIds);
        settleRevokedQueueItems(revoked.cancelledQueueItemIds, revoked.fencedQueueItemIds);
        if (options.tokenBroker !== undefined) {
          if (outcome.repositoryIds.length === 0) options.tokenBroker.revokeInstallationTokens(installationId);
          else options.tokenBroker.revokeRepositoryTokens(installationId, outcome.repositoryIds);
        }
        queueSummary.revoked += 1;
        if (deliveryStore.getDelivery(headerDeliveryId) !== undefined) deliveryStore.markDeliveryState(headerDeliveryId, 'succeeded');
        return respond(response, 202, { kind: 'revoked', installationId: outcome.installationId, repositoryIds: outcome.repositoryIds, cancelled: revoked.cancelled, fenced: revoked.fenced });
      }
      if (outcome.kind === 'retry_failed') {
        // intakeWebhookDelivery re-dispatches redelivered failures internally; this shape never escapes it.
        return respond(response, 202, { kind: 'retry_failed', attemptCount: outcome.entry.attemptCount });
      }
      // Unconfigured control planes without a pinned manifest must not admit actionable triggers into tenant queues.
      if (options.manifest === undefined) {
        if (deliveryStore.getDelivery(headerDeliveryId) !== undefined) {
          deliveryStore.markDeliveryState(headerDeliveryId, 'succeeded');
        }
        return respond(response, 200, {
          kind: 'ignored',
          code: 'TASKPACK_TRIGGER_UNSUPPORTED',
          reason: 'control plane has no pinned taskpack manifest to authorize actionable triggers',
        });
      }
      // Enforce manifest spec.triggers eligibility strictly BEFORE admitting into the tenant queue.
      if (
        !isGitHubTriggerDeclared(options.manifest.spec.triggers, {
          eventName: outcome.eventName,
          commentCommand: outcome.command?.command,
        })
      ) {
        if (deliveryStore.getDelivery(headerDeliveryId) !== undefined) {
          deliveryStore.markDeliveryState(headerDeliveryId, 'succeeded');
        }
        return respond(response, 200, {
          kind: 'ignored',
          code: 'TASKPACK_TRIGGER_UNSUPPORTED',
          reason: `trigger "${outcome.eventName}" is not enabled in spec.triggers`,
        });
      }
      // Accepted (including failed-redelivery retries): enqueue the actionable trigger for the tenant.
      const tenant = outcome.tenant;
      if (tenant === null) return respond(response, 400, { error: { code: 'TENANT_IDENTITY_INVALID', message: 'accepted webhook without tenant attribution' } });
      const kind = outcome.action === 'revise' ? 'revise' : outcome.action === 'status' ? 'status' : 'discover';
      const entry = outcome.entry;
      if (WEBHOOK_DELIVERY_ID_TEST.test(entry.deliveryId)) deliveryStore.markDeliveryState(entry.deliveryId, 'processing');
      try {
        reserveDeliveryLinkCapacity(1);
        const reviseBinding = kind === 'revise' ? readReviseBinding(raw.bytes) : null;
        const enqueued = queue.enqueue(tenant, {
          kind,
          baseRevision: options.baseRevision ?? entry.payloadDigest.slice(0, 12),
          deliveryId: entry.deliveryId,
          payloadDigest: entry.payloadDigest,
          ...(kind === 'revise'
            ? { command: reviseBinding ?? { commandId: 0, headSha: tenant.repositoryFullName, commandDigest: entry.payloadDigest } }
            : {}),
        });
        queueSummary.enqueued += enqueued.kind === 'coalesced' ? 0 : 1;
        queueSummary.coalesced += enqueued.kind === 'coalesced' ? 1 : 0;
        trackQueueItemDelivery(enqueued.item.queueItemId, entry.deliveryId);
        return respond(response, 202, {
          kind: 'accepted', action: outcome.action, queueItemId: enqueued.item.queueItemId,
          runId: enqueued.item.runId, coalesced: enqueued.kind === 'coalesced', attemptCount: entry.attemptCount,
        });
      } catch (error) {
        if (error !== null && typeof error === 'object' && 'code' in error) {
          if (WEBHOOK_DELIVERY_ID_TEST.test(entry.deliveryId)) {
            deliveryStore.markDeliveryState(entry.deliveryId, 'failed', String((error as { code: unknown }).code));
          }
          return respondError(response, error);
        }
        throw error;
      }
    }

    const tenantMatch = TENANT_PATH_PATTERN.exec(url.pathname);
    if (tenantMatch !== null) {
      const [, installationIdRaw, repositoryIdRaw, taskpackId, action] = tenantMatch;
      if (!IDENTIFIER_PATTERN.test(taskpackId!)) return respond(response, 400, { error: { code: 'TENANT_IDENTITY_INVALID', message: 'taskpackId must be a lowercase identifier' } });
      const tenant = { installationId: Number(installationIdRaw!), repositoryId: Number(repositoryIdRaw!), repositoryFullName: '', taskpackId: taskpackId! };
      const parsed = await parseJsonBody(request);
      if (!parsed.ok) return respond(response, parsed.status, { error: { code: 'ACTION_INPUT_INVALID', message: parsed.detail } });
      tenant.repositoryFullName = typeof parsed.body['repositoryFullName'] === 'string' ? parsed.body['repositoryFullName'] : '';
      const nowSample = isClockSample(parsed.body['nowSample']) ? parsed.body['nowSample'] : systemSample();
      const workerId = typeof parsed.body['workerId'] === 'string' ? parsed.body['workerId'] : '';
      try {
        if (action === 'lease') {
          const suiteDomainRecord = suiteRegistry?.byTaskpackName.get(taskpackId!);
          if (suiteRegistry !== null && suiteDomainRecord === undefined) {
            throw new GitHubAppError(
              'TASKPACK_HOST_BINDING_INVALID',
              `taskpackId "${taskpackId!}" is not registered in control-plane suite`,
              '/taskpackId',
            );
          }
          const hasManifestDigest = Object.hasOwn(parsed.body, 'manifestDigest') && parsed.body['manifestDigest'] !== undefined;
          const hasManifest = Object.hasOwn(parsed.body, 'manifest') && parsed.body['manifest'] !== undefined;
          if (suiteDomainRecord !== undefined && !hasManifestDigest && !hasManifest) {
            throw new GitHubAppError(
              'TASKPACK_HOST_BINDING_INVALID',
              'suite control-plane lease requires manifestDigest or suite-augmented manifest',
              '/manifestDigest',
            );
          }
          if (hasManifestDigest) {
            const requestedDigest = parsed.body['manifestDigest'];
            if (
              typeof requestedDigest !== 'string'
              || !SHA256_HEX_PATTERN.test(requestedDigest)
              || (suiteDomainRecord !== undefined && requestedDigest !== suiteDomainRecord.manifestDigest)
            ) {
              throw new GitHubAppError(
                'TASKPACK_HOST_BINDING_INVALID',
                'leased manifestDigest does not match control-plane pinned domain manifest digest',
                '/manifestDigest',
              );
            }
          }
          if (hasManifest) {
            const tenantManifest = validateTaskpackV2Manifest(
              parsed.body['manifest'] as Parameters<typeof validateTaskpackV2Manifest>[0],
              {
                ...(suiteDomainRecord !== undefined
                  ? {
                    controlRoot: suiteDomainRecord.domain.controlRoot,
                    manifestPath: suiteDomainRecord.domain.taskpackPath,
                  }
                  : {}),
                policyProfile: 'github',
                hostPolicy: MULTI_TENANT_HOST_POLICY,
                enforceHostAuthority: true,
              },
            );
            assertMultiTenantManifestAuthority(tenantManifest);
            if (tenantManifest.metadata.name !== taskpackId) {
              throw new GitHubAppError(
                'TASKPACK_HOST_BINDING_INVALID',
                `leased manifest metadata.name "${tenantManifest.metadata.name}" does not match tenant taskpackId "${taskpackId}"`,
                '/metadata/name',
              );
            }
            const tenantCanonical = canonicalJson(tenantManifest);
            if (pinnedManifestCanonical !== null && tenantCanonical !== pinnedManifestCanonical) {
              throw new GitHubAppError(
                'TASKPACK_HOST_BINDING_INVALID',
                'leased manifest does not match control-plane pinned manifest',
                '/manifest',
              );
            }
            if (suiteDomainRecord !== undefined && tenantCanonical !== suiteDomainRecord.canonicalManifest) {
              throw new GitHubAppError(
                'TASKPACK_HOST_BINDING_INVALID',
                `leased manifest does not match suite-augmented control-plane domain "${suiteDomainRecord.domain.id}"`,
                '/manifest',
              );
            }
          }
          if (options.tokenBroker === undefined) {
            return respond(response, 503, { error: { code: 'TOKEN_BROKER_CONFIG_INVALID', message: 'this control plane has no installation token broker configured' } });
          }
          const grant = queue.leaseNext(tenant, workerId, nowSample);
          if (grant === null) return respond(response, 200, { item: null });
          const leaseWatch = beginRevocationWatch(tenant.installationId, tenant.repositoryId);
          const mintStartNs = process.hrtime.bigint();
          let token;
          try {
            token = await options.tokenBroker.mint(tenant, 'read_only');
            if (leaseWatch.watch.revoked) {
              options.tokenBroker.revokeRepositoryTokens(tenant.installationId, [tenant.repositoryId]);
              throw new GitHubAppError(
                'TENANT_INSTALLATION_REVOKED',
                `lease on ${grant.queueItemId} was revoked while minting installation credentials`,
              );
            }
          } finally {
            leaseWatch.release();
          }
          const mintElapsedMs = Math.max(0, Math.floor(Number(process.hrtime.bigint() - mintStartNs) / 1_000_000));
          const postMintSample: ClockSample = isClockSample(parsed.body['nowSample'])
            ? {
              wallMs: nowSample.wallMs + mintElapsedMs,
              monotonicMs: String(BigInt(nowSample.monotonicMs) + BigInt(mintElapsedMs)),
            }
            : systemSample();
          const item = queue.assertActiveLease(tenant, grant.queueItemId, grant.leaseEpoch, workerId, postMintSample);
          queueSummary.leased += 1;
          if (item.deliveryId !== null && deliveryStore.getDelivery(item.deliveryId)?.state !== 'succeeded') {
            deliveryStore.markDeliveryState(item.deliveryId, 'processing');
          }
          const tokenMarker = `lw-token-${randomBytes(8).toString('hex')}`;
          const leaseOut = suiteDomainRecord !== undefined
            ? {
              ...grant,
              domainId: grant.domainId ?? suiteDomainRecord.domain.id,
              manifestDigest: grant.manifestDigest ?? suiteDomainRecord.manifestDigest,
            }
            : { ...grant };
          return respond(response, 200, {
            lease: leaseOut, item: summarizeItem(item),
            installationToken: { token: tokenMarker, expiresAtMs: token.expiresAtMs, profile: token.profile },
          }, { marker: tokenMarker, value: token.token });
        }
        const queueItemId = typeof parsed.body['queueItemId'] === 'string' ? parsed.body['queueItemId'] : '';
        const leaseEpoch = typeof parsed.body['leaseEpoch'] === 'number' ? parsed.body['leaseEpoch'] : Number.NaN;
        const settleOutcome = parsed.body['outcome'];
        if (settleOutcome !== 'completed' && settleOutcome !== 'failed' && settleOutcome !== 'blocked' && settleOutcome !== 'reconcile_required') {
          return respond(response, 400, { error: { code: 'ACTION_INPUT_INVALID', message: 'outcome must be completed, failed, blocked, or reconcile_required' } });
        }
        const settled = queue.settleLease(tenant, queueItemId, leaseEpoch, workerId, settleOutcome, nowSample);
        queueSummary.settled += 1;
        const affectedDeliveryIds = new Set<string>();
        if (settled.deliveryId !== null) affectedDeliveryIds.add(settled.deliveryId);
        for (const linkedId of clearQueueItemLinks(settled.queueItemId)) {
          affectedDeliveryIds.add(linkedId);
        }
        for (const deliveryId of affectedDeliveryIds) {
          if (settled.domainId !== undefined) {
            const dedupKey = `${deliveryId}\0${settled.domainId}`;
            if (settleOutcome === 'reconcile_required') {
              const existingRec = enqueuedByDeliveryDomain.get(dedupKey);
              if (existingRec !== undefined) {
                existingRec.reconcileRequired = true;
              }
            } else if (settleOutcome === 'failed' || settleOutcome === 'blocked') {
              enqueuedByDeliveryDomain.delete(dedupKey);
            }
          }
          const tracked = fanoutDeliveriesById.get(deliveryId);
          if (tracked !== undefined && tracked.expectedDomains.size > 0) {
            let hasActive = false;
            let hasUnadmitted = false;
            let hasReconcileRequired = false;
            let firstRetryableFailure: string | null = null;
            for (const expectedDomainId of tracked.expectedDomains) {
              const fEntry = tracked.entriesByDomain.get(expectedDomainId);
              if (fEntry === undefined) {
                hasUnadmitted = true;
                continue;
              }
              const fState = fEntry.queueItemId === settled.queueItemId
                ? settled.state
                : queue.getItem(fEntry.tenant, fEntry.queueItemId)?.state;
              if (fState === undefined) {
                hasUnadmitted = true;
                continue;
              }
              if (fState === 'pending' || fState === 'leased') {
                hasActive = true;
              } else if (fState === 'reconcile_required') {
                hasReconcileRequired = true;
              } else if (fState !== 'completed' && firstRetryableFailure === null) {
                firstRetryableFailure = fState;
              }
            }
            if (!hasActive) {
              if (!hasUnadmitted && !hasReconcileRequired && firstRetryableFailure === null) {
                deliveryStore.markDeliveryState(deliveryId, 'succeeded');
                evictDeliveryTracking(deliveryId);
              } else if (hasUnadmitted || firstRetryableFailure !== null) {
                deliveryStore.markDeliveryState(deliveryId, 'failed', firstRetryableFailure ?? 'partial_fanout');
              } else {
                // Only reconcile_required remains: suppress redelivery until explicit reconciliation.
                deliveryStore.markDeliveryState(deliveryId, 'succeeded');
                evictDeliveryTracking(deliveryId);
              }
            }
          } else {
            const suppressRedelivery = settleOutcome === 'completed' || settleOutcome === 'reconcile_required';
            deliveryStore.markDeliveryState(
              deliveryId,
              suppressRedelivery ? 'succeeded' : 'failed',
              suppressRedelivery ? null : settleOutcome,
            );
            if (suppressRedelivery) {
              evictDeliveryTracking(deliveryId);
            }
          }
        }
        return respond(response, 200, { kind: 'settled', queueItemId: settled.queueItemId, state: settled.state });
      } catch (error) {
        if (error !== null && typeof error === 'object' && 'code' in error) return respondError(response, error);
        throw error;
      }
    }

    return respond(response, 404, { error: { code: 'SERVICE_FAULT', message: `no route for ${method} ${url.pathname}` } });
  };

  let listening = false;
  await new Promise<void>((resolveListen, rejectListen) => {
    server.on('error', error => {
      if (listening) return; // post-listen socket failures surface per-request, never as process crashes
      rejectListen(error);
    });
    server.listen(port, host, () => {
      listening = true;
      resolveListen();
    });
  });
  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;

  return {
    host, port: boundPort, url: `http://${host}:${boundPort}`, webhookPath, queue, deliveryStore,
    close: async () => new Promise<void>((resolveClose, rejectClose) => {
      server.close(error => (error === undefined ? resolveClose() : rejectClose(error)));
    }),
  };
}

const WEBHOOK_DELIVERY_ID_TEST = /^[A-Za-z0-9-]{8,128}$/;
