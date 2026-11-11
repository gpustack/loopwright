import { join } from 'node:path';
import {
  GitHubAppError, REPOSITORY_FULL_NAME_PATTERN,
  type ActiveLease, type ClockSample, type EnqueueInput, type EnqueueOutcome, type ExpiredLeaseEffect,
  type LeaseGrant, type QueueCounts, type QueueItem, type QueueItemKind, type QueueSettleOutcome,
  type TenantAdmissionQueueOptions, type TenantIdentity, type TenantRunPaths, type TaskpackReviseCommand,
} from './types.js';

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MONOTONIC_PATTERN = /^[0-9]{1,20}$/;
const DEFAULT_MAX_PENDING_PER_GROUP = 100;
const DEFAULT_LEASE_DURATION_MS = 600_000;
const DRIFT_LIMIT_MS = 1_000n;

function queueError(code: 'TENANT_IDENTITY_INVALID' | 'TENANT_BOUNDARY_VIOLATION' | 'QUEUE_CAPACITY_EXCEEDED' | 'QUEUE_LEASE_FENCED' | 'QUEUE_STATE_INVALID' | 'TENANT_INSTALLATION_REVOKED', message: string): never {
  throw new GitHubAppError(code, message);
}

function validateTenantIdentity(tenant: TenantIdentity): TenantIdentity {
  const { installationId, repositoryId, repositoryFullName, taskpackId } = tenant;
  if (typeof installationId !== 'number' || !Number.isSafeInteger(installationId) || installationId <= 0) {
    queueError('TENANT_IDENTITY_INVALID', 'installationId must be a positive integer');
  }
  if (typeof repositoryId !== 'number' || !Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    queueError('TENANT_IDENTITY_INVALID', 'repositoryId must be a positive integer');
  }
  if (typeof repositoryFullName !== 'string' || !REPOSITORY_FULL_NAME_PATTERN.test(repositoryFullName)) {
    queueError('TENANT_IDENTITY_INVALID', `repositoryFullName "${repositoryFullName}" must match ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`);
  }
  if (typeof taskpackId !== 'string' || !IDENTIFIER_PATTERN.test(taskpackId)) {
    queueError('TENANT_IDENTITY_INVALID', `taskpackId "${taskpackId}" must be a lowercase identifier`);
  }
  return tenant;
}

function validateRevision(value: string, what: string): string {
  if (typeof value !== 'string' || !REVISION_PATTERN.test(value)) {
    queueError('QUEUE_STATE_INVALID', `${what} must be a revision identifier`);
  }
  return value;
}

function validateSample(sample: ClockSample, what: string): ClockSample {
  const wall = sample?.wallMs, monotonic = sample?.monotonicMs;
  if (typeof wall !== 'number' || !Number.isSafeInteger(wall) || typeof monotonic !== 'string' || !MONOTONIC_PATTERN.test(monotonic)) {
    queueError('QUEUE_LEASE_FENCED', `${what} must carry a valid wall and monotonic sample`);
  }
  return { wallMs: wall, monotonicMs: monotonic };
}

function monotonic(value: string): bigint {
  return BigInt(value);
}

function addMonotonic(value: string, deltaMs: number): string {
  return (monotonic(value) + BigInt(deltaMs)).toString();
}

/**
 * Local mirror of the `@loopwright/state` `clockValid` contract (monotonic non-decrease plus adjacent and
 * cumulative drift within 1000ms); that helper is not exported from `@loopwright/state` and this package must
 * not change its public exports.
 */
function clockValid(created: ClockSample, last: ClockSample, now: ClockSample): boolean {
  const monoNow = monotonic(now.monotonicMs), monoLast = monotonic(last.monotonicMs), monoCreated = monotonic(created.monotonicMs);
  if (monoNow < monoLast || now.wallMs < last.wallMs) return false;
  const adjacent = BigInt(now.wallMs - last.wallMs) - (monoNow - monoLast);
  const cumulative = BigInt(now.wallMs - created.wallMs) - (monoNow - monoCreated);
  const limit = DRIFT_LIMIT_MS;
  return adjacent >= -limit && adjacent <= limit && cumulative >= -limit && cumulative <= limit;
}

function sameTenant(a: TenantIdentity, b: TenantIdentity): boolean {
  return a.installationId === b.installationId && a.repositoryId === b.repositoryId
    && a.repositoryFullName === b.repositoryFullName && a.taskpackId === b.taskpackId;
}

function groupKey(tenant: TenantIdentity): string {
  return `${tenant.repositoryFullName}/${tenant.taskpackId}`;
}

function copyItem(item: QueueItem): QueueItem {
  return { ...item, command: item.command === null ? null : { ...item.command }, tenant: { ...item.tenant }, lease: item.lease === null ? null : { ...item.lease } };
}

/**
 * Tenant-isolated admission queue: every operation validates the full TenantIdentity, enforces
 * per-(repositoryFullName, taskpackId) concurrency 1 with a bounded pending queue, coalesces redundant
 * discovery triggers, fences leases with a store-wide monotonic leaseEpoch, and fences revoked scopes.
 */
export class TenantAdmissionQueue {
  readonly #items = new Map<string, QueueItem>();
  readonly #order: string[] = [];
  readonly #maxPendingPerGroup: number;
  readonly #leaseDurationMs: number;
  readonly #runRoot: string;
  #leaseEpoch = 0;
  #counter = 0;

  constructor(options: TenantAdmissionQueueOptions = {}) {
    const maxPending = options.maxPendingPerGroup ?? DEFAULT_MAX_PENDING_PER_GROUP;
    if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 100) {
      queueError('QUEUE_STATE_INVALID', 'maxPendingPerGroup must be an integer within 1..100');
    }
    const leaseDuration = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    if (!Number.isSafeInteger(leaseDuration) || leaseDuration < 1) {
      queueError('QUEUE_STATE_INVALID', 'leaseDurationMs must be a positive integer');
    }
    this.#maxPendingPerGroup = maxPending;
    this.#leaseDurationMs = leaseDuration;
    this.#runRoot = options.runRoot ?? '';
  }

  #requireItem(tenant: TenantIdentity, queueItemId: string): QueueItem {
    validateTenantIdentity(tenant);
    const item = this.#items.get(queueItemId);
    if (item === undefined || !sameTenant(item.tenant, tenant)) {
      queueError('TENANT_BOUNDARY_VIOLATION', `queue item ${queueItemId} does not belong to the authenticated tenant`);
    }
    return item;
  }

  #pendingCount(group: string): number {
    let count = 0;
    for (const item of this.#items.values()) {
      if (groupKey(item.tenant) === group && item.state === 'pending') count += 1;
    }
    return count;
  }

  #leasedCount(group: string): number {
    let count = 0;
    for (const item of this.#items.values()) {
      if (groupKey(item.tenant) === group && item.state === 'leased') count += 1;
    }
    return count;
  }

  /** Transition leases whose monotonic expiry passed; expired items enter reconcile_required. */
  #sweepExpired(now: ClockSample): void {
    const nowMono = monotonic(now.monotonicMs);
    for (const item of this.#items.values()) {
      if (item.state === 'leased' && item.lease !== null && nowMono >= monotonic(item.lease.notAfterMonotonicMs)) {
        item.state = 'reconcile_required';
      }
    }
  }

  enqueue(tenant: TenantIdentity, input: EnqueueInput, nowMs: number = Date.now()): EnqueueOutcome {
    validateTenantIdentity(tenant);
    validateRevision(input.baseRevision, 'baseRevision');
    if (!(_instanceOfKind(input.kind))) queueError('QUEUE_STATE_INVALID', `unsupported queue item kind`);
    let command: TaskpackReviseCommand | null = null;
    if (input.kind === 'revise') {
      const candidate = input.command;
      if (candidate === undefined
        || typeof candidate.commandId !== 'number' || !Number.isSafeInteger(candidate.commandId) || candidate.commandId < 0
        || typeof candidate.headSha !== 'string' || candidate.headSha.length === 0 || candidate.headSha.length > 128
        || typeof candidate.commandDigest !== 'string' || !/^[0-9a-f]{64}$/.test(candidate.commandDigest)) {
        queueError('QUEUE_STATE_INVALID', 'revise items require a bound (commandId, headSha, commandDigest) command');
      }
      command = { ...candidate };
    }
    const group = groupKey(tenant);
    if (input.kind === 'discover' || input.kind === 'schedule') {
      for (const item of this.#items.values()) {
        if (item.state === 'pending' && sameTenant(item.tenant, tenant) && item.baseRevision === input.baseRevision
          && (item.kind === 'discover' || item.kind === 'schedule')) {
          return { kind: 'coalesced', item: copyItem(item) };
        }
      }
    }
    if (this.#pendingCount(group) >= this.#maxPendingPerGroup) {
      queueError('QUEUE_CAPACITY_EXCEEDED', `pending queue for ${group} exceeds ${this.#maxPendingPerGroup} items`);
    }
    this.#counter += 1;
    const queueItemId = `q${String(this.#counter).padStart(6, '0')}`;
    const item: QueueItem = {
      queueItemId, runId: `run-${queueItemId}`, tenant: { ...tenant }, kind: input.kind,
      baseRevision: input.baseRevision, command, payloadDigest: input.payloadDigest ?? null,
      deliveryId: input.deliveryId ?? null, enqueuedAtMs: nowMs,
      state: 'pending', cancelReason: null, reconcileEffect: null, lease: null,
    };
    this.#items.set(queueItemId, item);
    this.#order.push(queueItemId);
    return { kind: 'enqueued', item: copyItem(item) };
  }

  leaseNext(tenant: TenantIdentity, workerId: string, nowSample: ClockSample): LeaseGrant | null {
    validateTenantIdentity(tenant);
    if (typeof workerId !== 'string' || workerId.length === 0 || workerId.length > 128) {
      queueError('QUEUE_STATE_INVALID', 'workerId must be a non-empty string');
    }
    const now = validateSample(nowSample, 'leaseNext clock sample');
    this.#sweepExpired(now);
    const seenGroups = new Set<string>();
    for (const queueItemId of this.#order) {
      const item = this.#items.get(queueItemId)!;
      if (!sameTenant(item.tenant, tenant) || item.state !== 'pending') continue;
      const group = groupKey(item.tenant);
      if (this.#leasedCount(group) > 0) { seenGroups.add(group); continue; }
      this.#leaseEpoch += 1;
      const lease: ActiveLease = {
        leaseEpoch: this.#leaseEpoch, workerId, grantedMonotonicMs: now.monotonicMs,
        notAfterMonotonicMs: addMonotonic(now.monotonicMs, this.#leaseDurationMs),
        createdSample: { ...now }, lastClockSample: { ...now }, revoked: false,
      };
      item.lease = lease;
      item.state = 'leased';
      return {
        leaseEpoch: lease.leaseEpoch, workerId, queueItemId: item.queueItemId, runId: item.runId,
        notAfterMonotonicMs: lease.notAfterMonotonicMs,
      };
    }
    void seenGroups;
    return null;
  }

  #requireActiveLease(tenant: TenantIdentity, queueItemId: string, leaseEpoch: number, workerId: string, nowSample: ClockSample): QueueItem {
    const item = this.#requireItem(tenant, queueItemId);
    if (typeof leaseEpoch !== 'number' || !Number.isSafeInteger(leaseEpoch) || typeof workerId !== 'string' || workerId.length === 0) {
      queueError('QUEUE_LEASE_FENCED', 'lease operations require the exact leaseEpoch and workerId');
    }
    const now = validateSample(nowSample, 'lease operation clock sample');
    if (item.state !== 'leased' || item.lease === null) queueError('QUEUE_STATE_INVALID', `queue item ${queueItemId} is not leased`);
    const lease = item.lease;
    if (lease.revoked) queueError('TENANT_INSTALLATION_REVOKED', `lease on ${queueItemId} was fenced by an installation revocation`);
    if (lease.leaseEpoch !== leaseEpoch || lease.workerId !== workerId) {
      queueError('QUEUE_LEASE_FENCED', `lease on ${queueItemId} does not match epoch ${leaseEpoch} and worker ${workerId}`);
    }
    this.#sweepExpired(now);
    if (item.state !== 'leased' || item.lease === null) {
      queueError('QUEUE_LEASE_FENCED', `lease on ${queueItemId} expired before the operation`);
    }
    if (!clockValid(lease.createdSample, lease.lastClockSample, now)) {
      queueError('QUEUE_LEASE_FENCED', `clock sample for ${queueItemId} drifted beyond the 1000ms budget`);
    }
    return item;
  }

  renewLease(tenant: TenantIdentity, queueItemId: string, leaseEpoch: number, workerId: string, nowSample: ClockSample): LeaseGrant {
    const item = this.#requireActiveLease(tenant, queueItemId, leaseEpoch, workerId, nowSample);
    const lease = item.lease!;
    lease.notAfterMonotonicMs = addMonotonic(nowSample.monotonicMs, this.#leaseDurationMs);
    lease.lastClockSample = { ...nowSample };
    return {
      leaseEpoch: lease.leaseEpoch, workerId, queueItemId: item.queueItemId, runId: item.runId,
      notAfterMonotonicMs: lease.notAfterMonotonicMs,
    };
  }

  settleLease(tenant: TenantIdentity, queueItemId: string, leaseEpoch: number, workerId: string, outcome: QueueSettleOutcome, nowSample: ClockSample): QueueItem {
    const item = this.#requireActiveLease(tenant, queueItemId, leaseEpoch, workerId, nowSample);
    if (outcome !== 'completed' && outcome !== 'failed' && outcome !== 'blocked' && outcome !== 'reconcile_required') {
      queueError('QUEUE_STATE_INVALID', `unsupported settle outcome ${String(outcome)}`);
    }
    item.state = outcome;
    if (outcome === 'reconcile_required') item.reconcileEffect = 'reconcile_required';
    item.lease = null;
    return copyItem(item);
  }

  reconcileExpiredLease(tenant: TenantIdentity, queueItemId: string, effect: ExpiredLeaseEffect, nowSample: ClockSample): QueueItem {
    const item = this.#requireItem(tenant, queueItemId);
    const now = validateSample(nowSample, 'reconcile clock sample');
    if (effect !== 'not_executed' && effect !== 'reconcile_required') {
      queueError('QUEUE_STATE_INVALID', `unsupported reconcile effect ${String(effect)}`);
    }
    const expired = item.lease !== null && monotonic(now.monotonicMs) >= monotonic(item.lease.notAfterMonotonicMs);
    if (item.state === 'reconcile_required' || (item.state === 'leased' && expired)) {
      item.state = effect === 'not_executed' ? 'pending' : 'reconcile_required';
      item.reconcileEffect = effect;
      item.lease = null;
      return copyItem(item);
    }
    queueError('QUEUE_STATE_INVALID', `queue item ${queueItemId} has no expired lease to reconcile`);
  }

  inspectTenantQueue(tenant: TenantIdentity): { readonly counts: QueueCounts; readonly items: readonly QueueItem[] } {
    validateTenantIdentity(tenant);
    const items = [...this.#items.values()].filter(item => sameTenant(item.tenant, tenant)).map(copyItem);
    const counts: { pending: number; leased: number; settled: number; reconcileRequired: number; cancelled: number } = { pending: 0, leased: 0, settled: 0, reconcileRequired: 0, cancelled: 0 };
    for (const item of items) {
      if (item.state === 'pending') counts.pending += 1;
      else if (item.state === 'leased') counts.leased += 1;
      else if (item.state === 'reconcile_required') counts.reconcileRequired += 1;
      else if (item.state === 'cancelled') counts.cancelled += 1;
      else counts.settled += 1;
    }
    return { counts, items };
  }

  resolveTenantRunPaths(tenant: TenantIdentity, queueItemId: string): TenantRunPaths {
    const item = this.#requireItem(tenant, queueItemId);
    if (this.#runRoot.length === 0) queueError('QUEUE_STATE_INVALID', 'resolveTenantRunPaths requires a configured runRoot');
    const safeFullName = tenant.repositoryFullName.replaceAll('/', '__');
    const runDirectory = join(this.#runRoot, String(tenant.installationId), String(tenant.repositoryId), safeFullName, tenant.taskpackId);
    return { runRoot: this.#runRoot, runDirectory, receiptPath: join(runDirectory, item.runId, 'receipt.json') };
  }

  revokeTenantScope(tenant: TenantIdentity): { readonly cancelled: number; readonly fenced: boolean } {
    validateTenantIdentity(tenant);
    let cancelled = 0, fenced = false;
    for (const item of this.#items.values()) {
      if (!sameTenant(item.tenant, tenant)) continue;
      if (item.state === 'pending') {
        item.state = 'cancelled';
        item.cancelReason = 'installation_revoked';
        cancelled += 1;
      } else if (item.state === 'leased' && item.lease !== null) {
        item.lease.revoked = true;
        fenced = true;
      }
    }
    return { cancelled, fenced };
  }

  revokeInstallationScope(installationId: number): { readonly cancelled: number; readonly fenced: number } {
    if (typeof installationId !== 'number' || !Number.isSafeInteger(installationId) || installationId <= 0) {
      queueError('TENANT_IDENTITY_INVALID', 'installationId must be a positive integer');
    }
    let cancelled = 0, fenced = 0;
    for (const item of this.#items.values()) {
      if (item.tenant.installationId !== installationId) continue;
      if (item.state === 'pending') {
        item.state = 'cancelled';
        item.cancelReason = 'installation_revoked';
        cancelled += 1;
      } else if (item.state === 'leased' && item.lease !== null) {
        item.lease.revoked = true;
        fenced += 1;
      }
    }
    return { cancelled, fenced };
  }

  /** Revoke only the tenants of `installationId` whose repositoryId is listed (installation_repositories.removed). */
  revokeRepositoryScope(installationId: number, repositoryIds: readonly number[]): { readonly cancelled: number; readonly fenced: number } {
    if (typeof installationId !== 'number' || !Number.isSafeInteger(installationId) || installationId <= 0
      || !Array.isArray(repositoryIds) || repositoryIds.some(id => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)) {
      queueError('TENANT_IDENTITY_INVALID', 'revokeRepositoryScope requires a positive installationId and positive repositoryIds');
    }
    const removed = new Set(repositoryIds);
    let cancelled = 0, fenced = 0;
    for (const item of this.#items.values()) {
      if (item.tenant.installationId !== installationId || !removed.has(item.tenant.repositoryId)) continue;
      if (item.state === 'pending') {
        item.state = 'cancelled';
        item.cancelReason = 'installation_revoked';
        cancelled += 1;
      } else if (item.state === 'leased' && item.lease !== null) {
        item.lease.revoked = true;
        fenced += 1;
      }
    }
    return { cancelled, fenced };
  }
}

function _instanceOfKind(kind: QueueItemKind): boolean {
  return kind === 'discover' || kind === 'schedule' || kind === 'revise' || kind === 'status';
}
