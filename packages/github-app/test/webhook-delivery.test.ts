import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { intakeWebhookDelivery, verifyWebhookSignature, WebhookDeliveryStore } from '../src/webhook.js';
import { DEFAULT_COMMENT_PREFIXES } from '../src/types.js';
import { GitHubAppError } from '../src/types.js';

const SECRET = 'webhook-secret-value';

function signed(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex')}`;
}

function commentPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'created',
    installation: { id: 101 },
    repository: { id: 202, full_name: 'octocat/target' },
    issue: { number: 5, pull_request: { number: 5 }, user: { login: 'maintainer', type: 'User' } },
    comment: {
      id: 7, body: '/loopwright status', author_association: 'MEMBER',
      user: { login: 'maintainer', type: 'User' },
    },
    ...overrides,
  };
}

function intake(payload: unknown, eventName: string, overrides: Record<string, unknown> = {}, body = JSON.stringify(payload)) {
  return intakeWebhookDelivery({
    rawBody: Buffer.from(body, 'utf8'),
    signatureHeader: signed(body),
    secret: SECRET,
    eventName,
    deliveryId: 'delivery-12345678',
    receivedAtMs: 1_000,
    commentPrefixes: DEFAULT_COMMENT_PREFIXES,
    commentCommands: ['retry', 'revise', 'status'],
    ...overrides,
  }, new WebhookDeliveryStore());
}

describe('verifyWebhookSignature (AC-2)', () => {
  const body = Buffer.from('{"hello":"world"}', 'utf8');

  it('accepts a valid sha256 signature and returns the payload digest', () => {
    const result = verifyWebhookSignature(body, signed(body.toString('utf8')), SECRET);
    assert.deepEqual(result, { ok: true, payloadDigest: createHmac('sha256', SECRET).update(body).digest('hex') });
  });

  it('rejects malformed headers, wrong digests, and missing secrets', () => {
    for (const header of [undefined, '', 'sha256=short', 'md5=abc', 'sha256=zzzz', `sha256=${'0'.repeat(63)}f`, signed('other body')]) {
      const result = verifyWebhookSignature(body, header, SECRET);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, 'WEBHOOK_SIGNATURE_INVALID');
        assert.equal(typeof result.detail, 'string');
      }
    }
    const emptySecret = verifyWebhookSignature(body, signed(body.toString('utf8')), '');
    assert.equal(emptySecret.ok ? '' : emptySecret.code, 'WEBHOOK_SIGNATURE_INVALID');
  });

  it('rejects bodies over 1048576 bytes with WEBHOOK_PAYLOAD_TOO_LARGE', () => {
    const oversized = Buffer.alloc(1_048_577, 0x61);
    const result = verifyWebhookSignature(oversized, signed('irrelevant'), SECRET);
    assert.deepEqual(result, { ok: false, code: 'WEBHOOK_PAYLOAD_TOO_LARGE', detail: 'webhook body exceeds 1048576 bytes' });
  });
});

describe('WebhookDeliveryStore (AC-2)', () => {
  const base = {
    deliveryId: 'delivery-12345678', eventName: 'schedule', payloadDigest: 'a'.repeat(64),
    installationId: 1, repositoryFullName: 'octocat/target', receivedAtMs: 1_000,
  };

  it('records a new delivery as accepted with attemptCount 1', () => {
    const store = new WebhookDeliveryStore();
    const outcome = store.recordDelivery(base);
    assert.equal(outcome.kind, 'accepted');
    assert.equal(outcome.entry.state, 'accepted');
    assert.equal(outcome.entry.attemptCount, 1);
  });

  it('treats replays of accepted, processing, and succeeded deliveries as duplicates', () => {
    const store = new WebhookDeliveryStore();
    store.recordDelivery(base);
    assert.equal(store.recordDelivery(base).kind, 'duplicate');
    store.markDeliveryState(base.deliveryId, 'processing');
    assert.equal(store.recordDelivery(base).kind, 'duplicate');
    store.markDeliveryState(base.deliveryId, 'succeeded');
    const replay = store.recordDelivery(base);
    assert.equal(replay.kind, 'duplicate');
    assert.equal(replay.kind === 'duplicate' ? replay.state : '', 'succeeded');
  });

  it('fails closed with WEBHOOK_DELIVERY_CONFLICT on payload mismatch', () => {
    const store = new WebhookDeliveryStore();
    store.recordDelivery(base);
    assert.throws(() => store.recordDelivery({ ...base, payloadDigest: 'b'.repeat(64) }),
      (error: GitHubAppError) => error.code === 'WEBHOOK_DELIVERY_CONFLICT');
  });

  it('re-admits failed redeliveries with identical digest as retry_failed', () => {
    const store = new WebhookDeliveryStore();
    store.recordDelivery(base);
    store.markDeliveryState(base.deliveryId, 'failed', 'queue unavailable');
    const retry = store.recordDelivery(base);
    assert.equal(retry.kind, 'retry_failed');
    assert.equal(retry.entry.state, 'accepted');
    assert.equal(retry.entry.attemptCount, 2);
  });

  it('refuses delivery ids outside ^[A-Za-z0-9-]{8,128}$', () => {
    const store = new WebhookDeliveryStore();
    assert.throws(() => store.recordDelivery({ ...base, deliveryId: 'short' }),
      (error: GitHubAppError) => error.code === 'WEBHOOK_DELIVERY_INVALID');
    assert.throws(() => store.recordDelivery({ ...base, deliveryId: 'bad_id!' }),
      (error: GitHubAppError) => error.code === 'WEBHOOK_DELIVERY_INVALID');
  });

  it('updates state and failure reasons through markDeliveryState', () => {
    const store = new WebhookDeliveryStore();
    store.recordDelivery(base);
    const updated = store.markDeliveryState(base.deliveryId, 'failed', 'worker crashed');
    assert.equal(updated.state, 'failed');
    assert.equal(updated.failureReason, 'worker crashed');
    assert.equal(store.getDelivery(base.deliveryId)?.payloadDigest, base.payloadDigest);
    assert.equal(store.getDelivery('delivery-99999999'), undefined);
    assert.deepEqual(store.counts(), { accepted: 0, processing: 0, succeeded: 0, failed: 1 });
  });
});

describe('intakeWebhookDelivery (AC-2)', () => {
  it('accepts a signed pull-request comment command and maps it to an action', () => {
    const outcome = intake(commentPayload(), 'issue_comment', { taskpackId: 'docs-sync' });
    assert.equal(outcome.kind, 'accepted');
    if (outcome.kind === 'accepted') {
      assert.equal(outcome.action, 'status');
      assert.equal(outcome.tenant?.repositoryFullName, 'octocat/target');
      assert.equal(outcome.entry.state, 'accepted');
    }
  });

  it('ignores plain issue comments without a pull_request object', () => {
    const payload = commentPayload();
    delete (payload.issue as Record<string, unknown>).pull_request;
    assert.deepEqual(intake(payload, 'issue_comment'), { kind: 'ignored', reason: 'comment is not on a pull request' });
  });

  it('ignores edited or deleted comments', () => {
    assert.deepEqual(intake(commentPayload({ action: 'edited' }), 'issue_comment'), { kind: 'ignored', reason: 'comment action edited is not created' });
    assert.deepEqual(intake(commentPayload({ action: 'deleted' }), 'issue_comment'), { kind: 'ignored', reason: 'comment action deleted is not created' });
  });

  it('ignores bot-authored comments and comments without a configured prefix', () => {
    const bot = commentPayload();
    (bot.comment as Record<string, unknown>).user = { login: 'loopwright-bot', type: 'Bot' };
    assert.equal(intake(bot, 'issue_comment').kind, 'ignored');
    const plain = commentPayload();
    (plain.comment as Record<string, unknown>).body = 'I really like this pull request.';
    assert.equal(intake(plain, 'issue_comment').kind, 'ignored');
  });

  it('rejects prefixed commands from unauthorized actors', () => {
    for (const association of ['NONE', 'FIRST_TIME_CONTRIBUTOR', 'CONTRIBUTOR']) {
      const payload = commentPayload();
      (payload.comment as Record<string, unknown>).author_association = association;
      const outcome = intake(payload, 'issue_comment', { operatorAllowlist: ['operator'] });
      assert.deepEqual(outcome, { kind: 'rejected', code: 'WEBHOOK_ACTOR_UNAUTHORIZED', detail: outcome.kind === 'rejected' ? outcome.detail : '' });
    }
  });

  it('accepts allowlisted operators who are not collaborators', () => {
    const payload = commentPayload();
    (payload.comment as Record<string, unknown>).author_association = 'CONTRIBUTOR';
    (payload.comment as Record<string, unknown>).user = { login: 'operator', type: 'User' };
    const outcome = intake(payload, 'issue_comment', { operatorAllowlist: ['operator'] });
    assert.equal(outcome.kind, 'accepted');
  });

  it('rejects revise commands whose guidance breaks the bounds', () => {
    const payload = commentPayload();
    (payload.comment as Record<string, unknown>).body = '/loopwright revise\n=== sentinel ===';
    const outcome = intake(payload, 'issue_comment');
    assert.deepEqual(outcome, { kind: 'rejected', code: 'WEBHOOK_GUIDANCE_INVALID', detail: outcome.kind === 'rejected' ? outcome.detail : '' });
  });

  it('rejects invalid signatures before parsing the payload', () => {
    const outcome = intakeWebhookDelivery({
      rawBody: Buffer.from('{"action":"created"}', 'utf8'),
      signatureHeader: signed('tampered'),
      secret: SECRET, eventName: 'issue_comment', deliveryId: 'delivery-12345678', receivedAtMs: 1,
    }, new WebhookDeliveryStore());
    assert.equal(outcome.kind, 'signature_rejected');
  });

  it('deduplicates redeliveries: duplicate, conflict, and retry_failed', () => {
    const store = new WebhookDeliveryStore();
    const input = {
      rawBody: Buffer.from(JSON.stringify(commentPayload()), 'utf8'),
      signatureHeader: signed(JSON.stringify(commentPayload())),
      secret: SECRET, eventName: 'issue_comment', deliveryId: 'delivery-12345678',
      receivedAtMs: 1_000, commentPrefixes: DEFAULT_COMMENT_PREFIXES, commentCommands: ['retry', 'revise', 'status'] as const,
      taskpackId: 'docs-sync',
    };
    const first = intakeWebhookDelivery(input, store);
    assert.equal(first.kind, 'accepted');
    const duplicate = intakeWebhookDelivery(input, store);
    assert.equal(duplicate.kind, 'duplicate');
    const differentPayload = commentPayload({ comment: { id: 8, body: '/loopwright status', author_association: 'MEMBER', user: { login: 'maintainer', type: 'User' } } });
    const differentBody = JSON.stringify(differentPayload);
    const conflicting = intakeWebhookDelivery({
      ...input, rawBody: Buffer.from(differentBody, 'utf8'), signatureHeader: signed(differentBody),
    }, store);
    assert.equal(conflicting.kind, 'delivery_conflict');
    store.markDeliveryState(input.deliveryId, 'failed', 'worker crashed');
    const retried = intakeWebhookDelivery(input, store);
    assert.equal(retried.kind, 'accepted');
    assert.equal(retried.kind === 'accepted' ? retried.entry.attemptCount : 0, 2);
  });

  it('maps pull_request_review submissions to discover commands', () => {
    const payload = {
      action: 'submitted', installation: { id: 101 }, repository: { id: 202, full_name: 'octocat/target' },
      pull_request: { number: 5 },
      review: { id: 9, body: '/loopwright retry', author_association: 'OWNER', user: { login: 'maintainer', type: 'User' } },
    };
    const outcome = intake(payload, 'pull_request_review');
    assert.equal(outcome.kind, 'accepted');
    assert.equal(outcome.kind === 'accepted' ? outcome.action : '', 'discover');
  });

  it('maps schedule, workflow_dispatch, repository_dispatch, and release events to discover', () => {
    for (const [eventName, payload] of [
      ['schedule', { installation: { id: 101 }, repository: { id: 202, full_name: 'octocat/target' }, schedule: 'daily' }],
      ['workflow_dispatch', { installation: { id: 101 }, repository: { id: 202, full_name: 'octocat/target' } }],
      ['repository_dispatch', { installation: { id: 101 }, repository: { id: 202, full_name: 'octocat/target' }, action: 'probe' }],
      ['release', { action: 'published', installation: { id: 101 }, repository: { id: 202, full_name: 'octocat/target' }, release: { tag_name: 'v2.0.0' } }],
    ] as const) {
      const outcome = intake(payload, eventName);
      assert.equal(outcome.kind, 'accepted', `${eventName} should be accepted`);
      assert.equal(outcome.kind === 'accepted' ? outcome.action : '', 'discover');
    }
  });

  it('routes installation revocation events to the revoked outcome', () => {
    const suspended = intake({ action: 'suspend', installation: { id: 101 } }, 'installation');
    assert.equal(suspended.kind, 'revoked');
    const removed = intake({
      action: 'removed', installation: { id: 101 },
      repositories_removed: [{ id: 202, full_name: 'octocat/target' }, { id: 203, full_name: 'octocat/other' }],
    }, 'installation_repositories');
    assert.equal(removed.kind, 'revoked');
    assert.deepEqual(removed.kind === 'revoked' ? removed.repositoryIds : [], [202, 203]);
  });

  it('records revocation deliveries and replays them as duplicates', () => {
    const store = new WebhookDeliveryStore();
    const body = JSON.stringify({ action: 'suspend', installation: { id: 101 } });
    const outcome = intakeWebhookDelivery({
      rawBody: Buffer.from(body, 'utf8'), signatureHeader: signed(body), secret: SECRET,
      eventName: 'installation', deliveryId: 'delivery-revoke-01', receivedAtMs: 1_000,
    }, store);
    assert.equal(outcome.kind, 'revoked');
    const recorded = store.getDelivery('delivery-revoke-01');
    assert.notEqual(recorded, undefined);
    assert.equal(recorded?.eventName, 'installation');
    assert.equal(recorded?.repositoryFullName, null);
    const replay = intakeWebhookDelivery({
      rawBody: Buffer.from(body, 'utf8'), signatureHeader: signed(body), secret: SECRET,
      eventName: 'installation', deliveryId: 'delivery-revoke-01', receivedAtMs: 2_000,
    }, store);
    assert.equal(replay.kind, 'duplicate');
    const different = JSON.stringify({ action: 'deleted', installation: { id: 101 } });
    const conflict = intakeWebhookDelivery({
      rawBody: Buffer.from(different, 'utf8'), signatureHeader: signed(different), secret: SECRET,
      eventName: 'installation', deliveryId: 'delivery-revoke-01', receivedAtMs: 3_000,
    }, store);
    assert.equal(conflict.kind, 'delivery_conflict');
  });

  it('stamps updatedAtMs when a failed delivery is re-admitted', () => {
    const store = new WebhookDeliveryStore();
    store.recordDelivery({
      deliveryId: 'delivery-retry-001', eventName: 'schedule', payloadDigest: 'a'.repeat(64),
      installationId: 1, repositoryFullName: 'octocat/target', receivedAtMs: 1_000,
    });
    store.markDeliveryState('delivery-retry-001', 'failed', 'worker crashed');
    const retry = store.recordDelivery({
      deliveryId: 'delivery-retry-001', eventName: 'schedule', payloadDigest: 'a'.repeat(64),
      installationId: 1, repositoryFullName: 'octocat/target', receivedAtMs: 5_000,
    });
    assert.equal(retry.kind, 'retry_failed');
    assert.equal(retry.entry.updatedAtMs, 5_000);
  });

  it('ignores comments from authors whose login ends with [bot]', () => {
    const payload = commentPayload();
    (payload.comment as Record<string, unknown>).user = { login: 'dependabot[bot]', type: 'User' };
    const outcome = intake(payload, 'issue_comment');
    assert.deepEqual(outcome, { kind: 'ignored', reason: 'comment author is a bot' });
  });

  it('refuses delivery ids outside the pattern', () => {
    const payload = commentPayload();
    const body = JSON.stringify(payload);
    assert.throws(() => intakeWebhookDelivery({
      rawBody: Buffer.from(body, 'utf8'), signatureHeader: signed(body), secret: SECRET,
      eventName: 'issue_comment', deliveryId: 'short', receivedAtMs: 1,
    }, new WebhookDeliveryStore()), (error: GitHubAppError) => error.code === 'WEBHOOK_DELIVERY_INVALID');
  });

  it('ignores unsupported events and unreadable payloads without error', () => {
    assert.equal(intake({ deployment: {} }, 'deployment').kind, 'ignored');
    const outcome = intakeWebhookDelivery({
      rawBody: Buffer.from('not-json{', 'utf8'), signatureHeader: signed('not-json{'), secret: SECRET,
      eventName: 'issue_comment', deliveryId: 'delivery-12345678', receivedAtMs: 1,
    }, new WebhookDeliveryStore());
    assert.equal(outcome.kind, 'ignored');
  });
});
