import { createHmac, timingSafeEqual } from 'node:crypto';
import { authorizeRepositoryActor, parseCommentCommand, validateCommentGuidance } from './taskpack.js';
import {
  DEFAULT_COMMENT_PREFIXES, GitHubAppError, MAX_WEBHOOK_BODY_BYTES, TASKPACK_COMMENT_COMMANDS, WEBHOOK_DELIVERY_ID_PATTERN,
  type ParsedCommentCommand, type TenantIdentity, type TaskpackCommentCommand, type WebhookDeliveryOutcome,
  type WebhookDeliveryRecord, type WebhookDeliveryState, type WebhookIntakeInput, type WebhookIntakeOutcome,
  type WebhookSignatureVerification,
} from './types.js';

/** Constant-time HMAC-SHA256 verification over the exact raw request bytes, before any JSON parsing. */
export function verifyWebhookSignature(
  rawBody: Uint8Array,
  signatureHeader: string | undefined,
  secret: string,
): WebhookSignatureVerification {
  if (rawBody.byteLength > MAX_WEBHOOK_BODY_BYTES) {
    return { ok: false, code: 'WEBHOOK_PAYLOAD_TOO_LARGE', detail: `webhook body exceeds ${MAX_WEBHOOK_BODY_BYTES} bytes` };
  }
  if (!secret || typeof signatureHeader !== 'string' || !/^sha256=[0-9a-f]{64}$/.test(signatureHeader)) {
    return { ok: false, code: 'WEBHOOK_SIGNATURE_INVALID', detail: 'missing or malformed X-Hub-Signature-256 header' };
  }
  const expectedHex = createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(`sha256=${expectedHex}`, 'utf8');
  const actualBuf = Buffer.from(signatureHeader, 'utf8');
  if (expectedBuf.byteLength !== actualBuf.byteLength || !timingSafeEqual(expectedBuf, actualBuf)) {
    return { ok: false, code: 'WEBHOOK_SIGNATURE_INVALID', detail: 'webhook HMAC-SHA256 signature mismatch' };
  }
  return { ok: true, payloadDigest: expectedHex };
}

interface DeliveryInput {
  readonly deliveryId: string;
  readonly eventName: string;
  readonly payloadDigest: string;
  readonly installationId: number;
  readonly repositoryFullName: string | null;
  readonly receivedAtMs: number;
}

/**
 * Delivery deduplication store keyed by `X-GitHub-Delivery`. Replays of in-flight or succeeded deliveries are
 * idempotent duplicates; payload mismatches fail closed; failed deliveries are re-admitted for GitHub redelivery.
 */
export class WebhookDeliveryStore {
  readonly #entries = new Map<string, WebhookDeliveryRecord>();

  recordDelivery(input: DeliveryInput): WebhookDeliveryOutcome {
    if (!WEBHOOK_DELIVERY_ID_PATTERN.test(input.deliveryId)) {
      throw new GitHubAppError('WEBHOOK_DELIVERY_INVALID', `delivery id "${input.deliveryId}" must match ^[A-Za-z0-9-]{8,128}$`);
    }
    const existing = this.#entries.get(input.deliveryId);
    if (existing !== undefined) {
      if (existing.payloadDigest !== input.payloadDigest) {
        throw new GitHubAppError('WEBHOOK_DELIVERY_CONFLICT', `delivery ${input.deliveryId} already exists with a different payload digest`, '/payloadDigest');
      }
      if (existing.state === 'failed') {
        existing.state = 'accepted';
        existing.failureReason = null;
        existing.attemptCount += 1;
        existing.updatedAtMs = input.receivedAtMs;
        return { kind: 'retry_failed', entry: { ...existing } };
      }
      return { kind: 'duplicate', state: existing.state, entry: { ...existing } };
    }
    const entry: WebhookDeliveryRecord = {
      deliveryId: input.deliveryId, eventName: input.eventName, payloadDigest: input.payloadDigest,
      installationId: input.installationId, repositoryFullName: input.repositoryFullName,
      receivedAtMs: input.receivedAtMs, updatedAtMs: input.receivedAtMs, state: 'accepted',
      failureReason: null, attemptCount: 1,
    };
    this.#entries.set(input.deliveryId, entry);
    return { kind: 'accepted', entry: { ...entry } };
  }

  markDeliveryState(deliveryId: string, state: Exclude<WebhookDeliveryState, 'accepted'>, failureReason: string | null = null, nowMs: number = Date.now()): WebhookDeliveryRecord {
    const entry = this.#entries.get(deliveryId);
    if (entry === undefined) throw new GitHubAppError('WEBHOOK_DELIVERY_INVALID', `delivery ${deliveryId} is not recorded`);
    entry.state = state;
    entry.failureReason = state === 'failed' ? failureReason : null;
    entry.updatedAtMs = nowMs;
    return { ...entry };
  }

  getDelivery(deliveryId: string): WebhookDeliveryRecord | undefined {
    const entry = this.#entries.get(deliveryId);
    return entry === undefined ? undefined : { ...entry };
  }

  counts(): { accepted: number; processing: number; succeeded: number; failed: number } {
    const counts = { accepted: 0, processing: 0, succeeded: 0, failed: 0 };
    for (const entry of this.#entries.values()) counts[entry.state] += 1;
    return counts;
  }
}

const SUPPORTED_EVENTS = new Set([
  'issue_comment', 'pull_request_review', 'release', 'schedule', 'workflow_dispatch',
  'repository_dispatch', 'installation', 'installation_repositories',
]);

function readObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readInstallationId(payload: Record<string, unknown>): number | null {
  const installation = readObject(payload['installation']);
  const id = installation?.['id'];
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
}

function readRepository(payload: Record<string, unknown>): { readonly id: number; readonly fullName: string } | null {
  const repository = readObject(payload['repository']);
  const id = repository?.['id'];
  const fullName = repository?.['full_name'];
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || typeof fullName !== 'string' || fullName.length === 0) return null;
  return { id, fullName };
}

interface CommentAttribution {
  readonly body: string;
  readonly login: string;
  readonly authorAssociation: string;
  readonly botAuthored: boolean;
}

function readCommentAttribution(container: unknown): CommentAttribution | null {
  const record = readObject(container);
  if (record === null) return null;
  const user = readObject(record['user']);
  const body = record['body'];
  const login = user?.['login'];
  const type = user?.['type'];
  const association = record['author_association'];
  if (typeof body !== 'string' || typeof login !== 'string' || typeof association !== 'string') return null;
  return { body, login, authorAssociation: association, botAuthored: type === 'Bot' || login.toLowerCase().endsWith('[bot]') };
}

function commandAction(command: TaskpackCommentCommand): 'discover' | 'revise' | 'status' {
  return command === 'retry' ? 'discover' : command === 'revise' ? 'revise' : 'status';
}

/**
 * Verify a webhook delivery end-to-end: constant-time signature verification first, delivery deduplication
 * second, then structured event intake with authorized comment-command parsing. Plain issues, bot authors,
 * edited comments, and unprefixed text are ignored without error or queue admission.
 */
export function intakeWebhookDelivery(input: WebhookIntakeInput, deliveryStore: WebhookDeliveryStore): WebhookIntakeOutcome {
  const verification = verifyWebhookSignature(input.rawBody, input.signatureHeader, input.secret);
  if (!verification.ok) return { kind: 'signature_rejected', code: verification.code, detail: verification.detail };
  if (!WEBHOOK_DELIVERY_ID_PATTERN.test(input.deliveryId)) {
    throw new GitHubAppError('WEBHOOK_DELIVERY_INVALID', `delivery id "${input.deliveryId}" must match ^[A-Za-z0-9-]{8,128}$`);
  }
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(input.rawBody).toString('utf8'));
    const object = readObject(parsed);
    if (object === null) return { kind: 'ignored', reason: 'payload is not a JSON object' };
    payload = object;
  } catch {
    return { kind: 'ignored', reason: 'payload is not valid JSON' };
  }
  if (!SUPPORTED_EVENTS.has(input.eventName)) return { kind: 'ignored', reason: `unsupported event ${input.eventName}` };
  const installationId = readInstallationId(payload);
  const repository = readRepository(payload);

  if (input.eventName === 'installation' || input.eventName === 'installation_repositories') {
    const action = typeof payload['action'] === 'string' ? payload['action'] : '';
    if (installationId === null) return { kind: 'ignored', reason: 'revocation event without installation attribution' };
    if (input.eventName === 'installation') {
      if (action !== 'suspend' && action !== 'deleted') return { kind: 'ignored', reason: `installation action ${action} is not a revocation` };
    } else if (action !== 'removed') {
      return { kind: 'ignored', reason: `installation_repositories action ${action} is not a revocation` };
    }
    // Revocation deliveries are recorded like any other admission so replays deduplicate and conflicts fail closed.
    let delivery: WebhookDeliveryOutcome;
    try {
      delivery = deliveryStore.recordDelivery({
        deliveryId: input.deliveryId, eventName: input.eventName, payloadDigest: verification.payloadDigest,
        installationId, repositoryFullName: repository?.fullName ?? null, receivedAtMs: input.receivedAtMs,
      });
    } catch (error) {
      if (error instanceof GitHubAppError && error.code === 'WEBHOOK_DELIVERY_CONFLICT') {
        return { kind: 'delivery_conflict', detail: error.message };
      }
      throw error;
    }
    if (delivery.kind === 'duplicate') return { kind: 'duplicate', state: delivery.state, entry: delivery.entry };
    if (input.eventName === 'installation') {
      return { kind: 'revoked', installationId, repositoryIds: [], reason: `installation ${action}` };
    }
    const removed = Array.isArray(payload['repositories_removed']) ? payload['repositories_removed'] : [];
    const repositoryIds = removed
      .map(entry => readObject(entry)?.['id'])
      .filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0);
    return { kind: 'revoked', installationId, repositoryIds, reason: 'repositories removed from the installation' };
  }

  if (installationId === null) return { kind: 'ignored', reason: 'missing installation attribution' };
  if (repository === null) return { kind: 'ignored', reason: 'missing repository attribution' };

  let delivery: WebhookDeliveryOutcome;
  try {
    delivery = deliveryStore.recordDelivery({
      deliveryId: input.deliveryId, eventName: input.eventName, payloadDigest: verification.payloadDigest,
      installationId, repositoryFullName: repository.fullName, receivedAtMs: input.receivedAtMs,
    });
  } catch (error) {
    if (error instanceof GitHubAppError && error.code === 'WEBHOOK_DELIVERY_CONFLICT') {
      return { kind: 'delivery_conflict', detail: error.message };
    }
    throw error;
  }
  if (delivery.kind === 'duplicate') return { kind: 'duplicate', state: delivery.state, entry: delivery.entry };

  const prefixes = input.commentPrefixes ?? DEFAULT_COMMENT_PREFIXES;
  const commands = input.commentCommands ?? TASKPACK_COMMENT_COMMANDS;
  const operatorAllowlist = input.operatorAllowlist;
  const handleComment = (container: unknown, action: string, actionLabel: string): WebhookIntakeOutcome => {
    if (action !== 'created' && action !== 'submitted') return { kind: 'ignored', reason: `${actionLabel} action ${action} is not ${input.eventName === 'issue_comment' ? 'created' : 'submitted'}` };
    const attribution = readCommentAttribution(container);
    if (attribution === null) return { kind: 'ignored', reason: `${actionLabel} payload is unreadable` };
    if (attribution.botAuthored) return { kind: 'ignored', reason: `${actionLabel} author is a bot` };
    const command = parseCommentCommand(attribution.body, prefixes, commands);
    if (command === null) return { kind: 'ignored', reason: `comment without a configured command prefix` };
    if (!authorizeRepositoryActor(attribution.authorAssociation, attribution.login, operatorAllowlist)) {
      return { kind: 'rejected', code: 'WEBHOOK_ACTOR_UNAUTHORIZED', detail: `actor ${attribution.login} lacks write access (${attribution.authorAssociation})` };
    }
    const guidance = validateCommentGuidance(command.guidance);
    if (!guidance.ok) return { kind: 'rejected', code: 'WEBHOOK_GUIDANCE_INVALID', detail: guidance.detail };
    const tenant: TenantIdentity = {
      installationId, repositoryId: repository.id, repositoryFullName: repository.fullName,
      taskpackId: input.taskpackId ?? 'default',
    };
    return {
      kind: 'accepted', eventName: input.eventName, action: commandAction(command.command),
      command: command satisfies ParsedCommentCommand, entry: delivery.entry, tenant,
    };
  };

  if (input.eventName === 'issue_comment') {
    const action = typeof payload['action'] === 'string' ? payload['action'] : '';
    const issue = readObject(payload['issue']);
    if (issue === null || readObject(issue['pull_request']) === null) return { kind: 'ignored', reason: 'comment is not on a pull request' };
    return handleComment(payload['comment'], action, 'comment');
  }
  if (input.eventName === 'pull_request_review') {
    const action = typeof payload['action'] === 'string' ? payload['action'] : '';
    return handleComment(payload['review'], action, 'review');
  }
  if (input.eventName === 'release') {
    const action = typeof payload['action'] === 'string' ? payload['action'] : '';
    if (action !== 'published') return { kind: 'ignored', reason: `release action ${action} is not published` };
  }
  const tenant: TenantIdentity = {
    installationId, repositoryId: repository.id, repositoryFullName: repository.fullName,
    taskpackId: input.taskpackId ?? 'default',
  };
  return { kind: 'accepted', eventName: input.eventName, action: 'discover', command: null, entry: delivery.entry, tenant };
}
