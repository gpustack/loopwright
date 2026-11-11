import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TenantAdmissionQueue } from '../src/tenant-queue.js';
import { GitHubAppError, type ClockSample, type QueueSettleOutcome, type TenantIdentity } from '../src/types.js';

const TENANT: TenantIdentity = { installationId: 1, repositoryId: 2, repositoryFullName: 'octocat/target', taskpackId: 'docs-sync' };
const TENANT_B: TenantIdentity = { installationId: 1, repositoryId: 2, repositoryFullName: 'octocat/target', taskpackId: 'other-pack' };
const OTHER_INSTALL: TenantIdentity = { installationId: 9, repositoryId: 2, repositoryFullName: 'octocat/target', taskpackId: 'docs-sync' };
const OTHER_REPO_ID: TenantIdentity = { installationId: 1, repositoryId: 3, repositoryFullName: 'octocat/target', taskpackId: 'docs-sync' };
const OTHER_FULL_NAME: TenantIdentity = { installationId: 1, repositoryId: 2, repositoryFullName: 'octocat/elsewhere', taskpackId: 'docs-sync' };

let clock = 0n;
function tick(): ClockSample {
  clock += 50n;
  return { wallMs: 1_700_000_000_000 + Number(clock), monotonicMs: clock.toString() };
}

function codeOf(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    if (error instanceof GitHubAppError) return error.code;
    throw error;
  }
  return '';
}

describe('tenant identity and boundary (AC-3)', () => {
  it('refuses malformed tenant identities', () => {
    const queue = new TenantAdmissionQueue();
    assert.equal(codeOf(() => queue.enqueue({ ...TENANT, repositoryFullName: 'no-slash' }, { kind: 'discover', baseRevision: 'b' })), 'TENANT_IDENTITY_INVALID');
    assert.equal(codeOf(() => queue.enqueue({ ...TENANT, taskpackId: 'Docs-Sync' }, { kind: 'discover', baseRevision: 'b' })), 'TENANT_IDENTITY_INVALID');
    assert.equal(codeOf(() => queue.enqueue({ ...TENANT, installationId: 0 }, { kind: 'discover', baseRevision: 'b' })), 'TENANT_IDENTITY_INVALID');
  });

  it('fails closed with TENANT_BOUNDARY_VIOLATION on cross-tenant operations', () => {
    const queue = new TenantAdmissionQueue({ leaseDurationMs: 60_000 });
    const enqueued = queue.enqueue(TENANT, { kind: 'discover', baseRevision: 'b'.repeat(40) });
    const grant = queue.leaseNext(TENANT, 'worker-1', tick());
    assert.notEqual(grant, null);
    for (const tenant of [TENANT_B, OTHER_INSTALL, OTHER_REPO_ID, OTHER_FULL_NAME]) {
      assert.equal(codeOf(() => queue.renewLease(tenant, grant!.queueItemId, grant!.leaseEpoch, 'worker-1', tick())), 'TENANT_BOUNDARY_VIOLATION', tenant.taskpackId);
      assert.equal(codeOf(() => queue.settleLease(tenant, grant!.queueItemId, grant!.leaseEpoch, 'worker-1', 'completed', tick())), 'TENANT_BOUNDARY_VIOLATION');
      assert.equal(codeOf(() => queue.resolveTenantRunPaths(tenant, grant!.queueItemId)), 'TENANT_BOUNDARY_VIOLATION');
      assert.equal(queue.inspectTenantQueue(tenant).items.length, 0, 'cross-tenant inspection must not leak items');
    }
    assert.equal(queue.inspectTenantQueue(TENANT).items.length, 1);
    assert.equal(codeOf(() => queue.resolveTenantRunPaths(TENANT, 'q999999')), 'TENANT_BOUNDARY_VIOLATION');
    assert.equal(codeOf(() => queue.settleLease(TENANT, enqueued.item.runId, grant!.leaseEpoch, 'worker-1', 'completed', tick())), 'TENANT_BOUNDARY_VIOLATION');
  });
});

describe('per-group concurrency and capacity (AC-3)', () => {
  it('leases at most one item per (repositoryFullName, taskpackId) group', () => {
    const queue = new TenantAdmissionQueue();
    queue.enqueue(TENANT, { kind: 'discover', baseRevision: 'b'.repeat(40) });
    queue.enqueue(TENANT, { kind: 'discover', baseRevision: 'c'.repeat(40) });
    const first = queue.leaseNext(TENANT, 'worker-1', tick());
    assert.notEqual(first, null);
    assert.equal(queue.leaseNext(TENANT, 'worker-2', tick()), null, 'second concurrent lease in the same group must wait');
    queue.settleLease(TENANT, first!.queueItemId, first!.leaseEpoch, 'worker-1', 'completed', tick());
    const second = queue.leaseNext(TENANT, 'worker-2', tick());
    assert.notEqual(second, null);
    assert.notEqual(second!.queueItemId, first!.queueItemId);
  });

  it('leases independent groups concurrently', () => {
    const queue = new TenantAdmissionQueue();
    queue.enqueue(TENANT, { kind: 'discover', baseRevision: 'b'.repeat(40) });
    queue.enqueue(TENANT_B, { kind: 'discover', baseRevision: 'b'.repeat(40) });
    assert.notEqual(queue.leaseNext(TENANT, 'worker-1', tick()), null);
    assert.notEqual(queue.leaseNext(TENANT_B, 'worker-2', tick()), null);
  });

  it('enforces the default pending cap of 100 with QUEUE_CAPACITY_EXCEEDED', () => {
    const queue = new TenantAdmissionQueue();
    for (let index = 0; index < 100; index++) {
      queue.enqueue(TENANT, { kind: 'revise', baseRevision: 'b'.repeat(40), command: { commandId: index, headSha: 'c'.repeat(40), commandDigest: 'd'.repeat(64) } });
    }
    assert.equal(codeOf(() => queue.enqueue(TENANT, { kind: 'revise', baseRevision: 'b'.repeat(40), command: { commandId: 100, headSha: 'c'.repeat(40), commandDigest: 'd'.repeat(64) } })), 'QUEUE_CAPACITY_EXCEEDED');
  });

  it('accepts only configurable caps within 1..100', () => {
    assert.equal(codeOf(() => new TenantAdmissionQueue({ maxPendingPerGroup: 0 })), 'QUEUE_STATE_INVALID');
    assert.equal(codeOf(() => new TenantAdmissionQueue({ maxPendingPerGroup: 101 })), 'QUEUE_STATE_INVALID');
    const small = new TenantAdmissionQueue({ maxPendingPerGroup: 1 });
    small.enqueue(TENANT, { kind: 'status', baseRevision: 'b'.repeat(40) });
    assert.equal(codeOf(() => small.enqueue(TENANT, { kind: 'status', baseRevision: 'c'.repeat(40) })), 'QUEUE_CAPACITY_EXCEEDED');
  });

  it('coalesces discover and schedule items but keeps revise and status items separate', () => {
    const queue = new TenantAdmissionQueue();
    const first = queue.enqueue(TENANT, { kind: 'discover', baseRevision: 'b'.repeat(40) });
    const coalesced = queue.enqueue(TENANT, { kind: 'discover', baseRevision: 'b'.repeat(40) });
    assert.equal(coalesced.kind, 'coalesced');
    assert.equal(coalesced.item.queueItemId, first.item.queueItemId);
    const otherBase = queue.enqueue(TENANT, { kind: 'schedule', baseRevision: 'c'.repeat(40) });
    assert.equal(otherBase.kind, 'enqueued');
    const sameSchedule = queue.enqueue(TENANT, { kind: 'schedule', baseRevision: 'c'.repeat(40) });
    assert.equal(sameSchedule.kind, 'coalesced');
    const reviseA = queue.enqueue(TENANT, { kind: 'revise', baseRevision: 'b'.repeat(40), command: { commandId: 1, headSha: 'h1', commandDigest: 'a'.repeat(64) } });
    const reviseB = queue.enqueue(TENANT, { kind: 'revise', baseRevision: 'b'.repeat(40), command: { commandId: 2, headSha: 'h2', commandDigest: 'b'.repeat(64) } });
    assert.equal(reviseA.kind, 'enqueued');
    assert.equal(reviseB.kind, 'enqueued');
    assert.notEqual(reviseA.item.queueItemId, reviseB.item.queueItemId);
    assert.equal(codeOf(() => queue.enqueue(TENANT, { kind: 'revise', baseRevision: 'b'.repeat(40) })), 'QUEUE_STATE_INVALID');
  });
});

describe('lease epoch fencing (AC-3)', () => {
  it('assigns strictly increasing store-wide lease epochs', () => {
    const queue = new TenantAdmissionQueue();
    queue.enqueue(TENANT, { kind: 'discover', baseRevision: 'b'.repeat(40) });
    const grant = queue.leaseNext(TENANT, 'worker-1', tick());
    assert.equal(grant!.leaseEpoch, 1);
    queue.settleLease(TENANT, grant!.queueItemId, grant!.leaseEpoch, 'worker-1', 'completed', tick());
    queue.enqueue(TENANT_B, { kind: 'discover', baseRevision: 'b'.repeat(40) });
    const next = queue.leaseNext(TENANT_B, 'worker-1', tick());
    assert.equal(next!.leaseEpoch, 2, 'epochs increment across groups');
  });

  it('fences renewal and settlement with a stale epoch or wrong worker', () => {
    const queue = new TenantAdmissionQueue({ leaseDurationMs: 60_000 });
    queue.enqueue(TENANT, { kind: 'discover', baseRevision: 'b'.repeat(40) });
    const grant = queue.leaseNext(TENANT, 'worker-1', tick());
    assert.equal(codeOf(() => queue.renewLease(TENANT, grant!.queueItemId, grant!.leaseEpoch + 1, 'worker-1', tick())), 'QUEUE_LEASE_FENCED');
    assert.equal(codeOf(() => queue.renewLease(TENANT, grant!.queueItemId, grant!.leaseEpoch, 'worker-2', tick())), 'QUEUE_LEASE_FENCED');
    assert.equal(codeOf(() => queue.settleLease(TENANT, grant!.queueItemId, grant!.leaseEpoch - 1, 'worker-1', 'completed', tick())), 'QUEUE_LEASE_FENCED');
    const renewed = queue.renewLease(TENANT, grant!.queueItemId, grant!.leaseEpoch, 'worker-1', tick());
    assert.equal(renewed.leaseEpoch, grant!.leaseEpoch);
    assert.notEqual(renewed.notAfterMonotonicMs, grant!.notAfterMonotonicMs);
    assert.equal(queue.settleLease(TENANT, grant!.queueItemId, grant!.leaseEpoch, 'worker-1', 'completed', tick()).state, 'completed');
    assert.equal(codeOf(() => queue.settleLease(TENANT, grant!.queueItemId, grant!.leaseEpoch, 'worker-1', 'completed', tick())), 'QUEUE_STATE_INVALID');
  });

  it('fences operations whose clock samples drift or move backward', () => {
    const queue = new TenantAdmissionQueue({ leaseDurationMs: 60_000 });
    queue.enqueue(TENANT, { kind: 'discover', baseRevision: 'b'.repeat(40) });
    const grant = queue.leaseNext(TENANT, 'worker-1', { wallMs: 1_000_000, monotonicMs: '1000' });
    const drifted: ClockSample = { wallMs: 1_000_000 + 5_000, monotonicMs: '1050' };
    assert.equal(codeOf(() => queue.renewLease(TENANT, grant!.queueItemId, grant!.leaseEpoch, 'worker-1', drifted)), 'QUEUE_LEASE_FENCED');
    const backward: ClockSample = { wallMs: 999_000, monotonicMs: '900' };
    assert.equal(codeOf(() => queue.settleLease(TENANT, grant!.queueItemId, grant!.leaseEpoch, 'worker-1', 'completed', backward)), 'QUEUE_LEASE_FENCED');
    const aligned: ClockSample = { wallMs: 1_000_000 + 1_000, monotonicMs: '1050' };
    assert.equal(queue.settleLease(TENANT, grant!.queueItemId, grant!.leaseEpoch, 'worker-1', 'completed', aligned).state, 'completed');
  });

  it('transitions expired leases to reconcile_required and gates re-leasing on reconcileExpiredLease', () => {
    const queue = new TenantAdmissionQueue({ leaseDurationMs: 1_000 });
    queue.enqueue(TENANT, { kind: 'revise', baseRevision: 'b'.repeat(40), command: { commandId: 1, headSha: 'h', commandDigest: 'd'.padEnd(64, '0').replace(/[^0-9a-f]/g, '0') } });
    const grant = queue.leaseNext(TENANT, 'worker-1', { wallMs: 1_000_000, monotonicMs: '1000' });
    const afterExpiry: ClockSample = { wallMs: 1_000_000 + 2_000, monotonicMs: '2200' };
    assert.equal(codeOf(() => queue.renewLease(TENANT, grant!.queueItemId, grant!.leaseEpoch, 'worker-1', afterExpiry)), 'QUEUE_LEASE_FENCED');
    assert.equal(queue.inspectTenantQueue(TENANT).items[0]!.state, 'reconcile_required');
    assert.equal(queue.leaseNext(TENANT, 'worker-2', afterExpiry), null, 'expired items are not re-leasable before reconciliation');
    queue.reconcileExpiredLease(TENANT, grant!.queueItemId, 'not_executed', afterExpiry);
    const reQueued = queue.inspectTenantQueue(TENANT).items[0]!;
    assert.equal(reQueued.state, 'pending');
    assert.equal(reQueued.reconcileEffect, 'not_executed');
    assert.notEqual(queue.leaseNext(TENANT, 'worker-2', afterExpiry), null);
    assert.equal(queue.leaseNext(TENANT, 'worker-3', afterExpiry), null, 'item is leased again by worker-2, so worker-3 waits');
    assert.notEqual(queue.inspectTenantQueue(TENANT).items[0]!.lease, null);
    const afterSecondExpiry: ClockSample = { wallMs: 1_000_000 + 4_000, monotonicMs: '3500' };
    queue.reconcileExpiredLease(TENANT, grant!.queueItemId, 'reconcile_required', afterSecondExpiry);
    assert.equal(queue.inspectTenantQueue(TENANT).items[0]!.state, 'reconcile_required');
    assert.equal(queue.inspectTenantQueue(TENANT).items[0]!.reconcileEffect, 'reconcile_required');
    assert.equal(queue.leaseNext(TENANT, 'worker-4', afterSecondExpiry), null);
  });

  it('records settlement outcomes for leased items', () => {
    const queue = new TenantAdmissionQueue();
    for (const outcome of ['failed', 'blocked', 'reconcile_required'] as QueueSettleOutcome[]) {
      queue.enqueue(TENANT, { kind: 'status', baseRevision: `b${outcome}`.padEnd(40, '0') });
      const grant = queue.leaseNext(TENANT, 'worker-1', tick());
      assert.equal(queue.settleLease(TENANT, grant!.queueItemId, grant!.leaseEpoch, 'worker-1', outcome, tick()).state, outcome);
    }
  });
});

describe('installation revocation (AC-3)', () => {
  it('cancels pending items and fences the active lease on revokeTenantScope', () => {
    const queue = new TenantAdmissionQueue({ leaseDurationMs: 60_000 });
    queue.enqueue(TENANT, { kind: 'discover', baseRevision: 'b'.repeat(40) });
    queue.enqueue(TENANT, { kind: 'schedule', baseRevision: 'c'.repeat(40) });
    const grant = queue.leaseNext(TENANT, 'worker-1', tick());
    const revoked = queue.revokeTenantScope(TENANT);
    assert.equal(revoked.cancelled, 1);
    assert.equal(revoked.fenced, true);
    const cancelled = queue.inspectTenantQueue(TENANT).items.find(item => item.state === 'cancelled');
    assert.equal(cancelled?.cancelReason, 'installation_revoked');
    assert.equal(codeOf(() => queue.renewLease(TENANT, grant!.queueItemId, grant!.leaseEpoch, 'worker-1', tick())), 'TENANT_INSTALLATION_REVOKED');
    assert.equal(codeOf(() => queue.settleLease(TENANT, grant!.queueItemId, grant!.leaseEpoch, 'worker-1', 'completed', tick())), 'TENANT_INSTALLATION_REVOKED');
    assert.equal(queue.leaseNext(TENANT, 'worker-2', tick()), null);
    assert.equal(queue.revokeTenantScope(TENANT_B).cancelled, 0, 'revocation must not touch other tenants');
  });

  it('revokes every tenant of an installation with revokeInstallationScope', () => {
    const queue = new TenantAdmissionQueue({ leaseDurationMs: 60_000 });
    queue.enqueue(TENANT, { kind: 'discover', baseRevision: 'b'.repeat(40) });
    queue.enqueue(TENANT_B, { kind: 'discover', baseRevision: 'b'.repeat(40) });
    queue.enqueue(OTHER_INSTALL, { kind: 'discover', baseRevision: 'b'.repeat(40) });
    const revoked = queue.revokeInstallationScope(1);
    assert.equal(revoked.cancelled, 2);
    assert.equal(queue.inspectTenantQueue(OTHER_INSTALL).items.every(item => item.state === 'pending'), true, 'revocation must not touch other installations');
    assert.equal(queue.inspectTenantQueue(TENANT).items.every(item => item.state === 'cancelled'), true);
  });
});

describe('tenant partitioning of run paths (AC-3)', () => {
  it('partitions run paths by every tenant identity component', () => {
    const queue = new TenantAdmissionQueue({ runRoot: '/var/lib/loopwright/runs' });
    const item = queue.enqueue(TENANT, { kind: 'discover', baseRevision: 'b'.repeat(40) }).item;
    const paths = queue.resolveTenantRunPaths(TENANT, item.queueItemId);
    const otherTaskpack = queue.enqueue(TENANT_B, { kind: 'discover', baseRevision: 'b'.repeat(40) }).item;
    const otherPaths = queue.resolveTenantRunPaths(TENANT_B, otherTaskpack.queueItemId);
    assert.notEqual(paths.runDirectory, otherPaths.runDirectory);
    assert.ok(paths.runDirectory.includes('/1/'));
    assert.ok(paths.runDirectory.includes('/2/'));
    assert.ok(paths.runDirectory.includes('octocat__target'));
    assert.ok(paths.runDirectory.endsWith('/docs-sync'));
    assert.ok(paths.receiptPath.startsWith(paths.runDirectory));
    assert.ok(paths.receiptPath.includes(item.runId));
    assert.ok(paths.runDirectory.startsWith('/var/lib/loopwright/runs/'));
  });
});
