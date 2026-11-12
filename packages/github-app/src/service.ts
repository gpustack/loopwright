import { createHash, randomBytes } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { InstallationTokenBroker, SecretScrubber } from './token-broker.js';
import { intakeWebhookDelivery, WebhookDeliveryStore } from './webhook.js';
import { TenantAdmissionQueue } from './tenant-queue.js';
import type {
  ClockSample, GitHubAppErrorCode, QueueItem, TaskpackReviseCommand, WebhookIntakeOutcome,
} from './types.js';

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
});

function statusForError(code: GitHubAppErrorCode): number {
  return STATUS_BY_CODE[code] ?? 500;
}

const TENANT_PATH_PATTERN = /^\/tenants\/([0-9]+)\/([0-9]+)\/([a-z][a-z0-9]*(?:[._-][a-z0-9]+)*)\/(lease|settle)$/;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

function isClockSample(value: unknown): value is ClockSample {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record['wallMs'] === 'number' && typeof record['monotonicMs'] === 'string';
}

/** Re-read the revise command binding (comment id, head sha, body digest) from the raw webhook payload. */
function readReviseBinding(rawBody: Buffer): TaskpackReviseCommand | null {
  try {
    const payload: unknown = JSON.parse(rawBody.toString('utf8'));
    if (payload === null || typeof payload !== 'object') return null;
    const record = payload as Record<string, unknown>;
    const container = record['comment'] ?? record['review'];
    if (container === null || typeof container !== 'object') return null;
    const id = (container as Record<string, unknown>)['id'];
    const issue = record['issue'];
    const pullRequest = issue !== null && typeof issue === 'object' ? (issue as Record<string, unknown>)['pull_request'] : null;
    const head = pullRequest !== null && typeof pullRequest === 'object' ? (pullRequest as Record<string, unknown>)['head'] : null;
    const headSha = head !== null && typeof head === 'object' && typeof (head as Record<string, unknown>)['sha'] === 'string'
      ? (head as Record<string, unknown>)['sha'] as string
      : null;
    return {
      commandId: typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : 0,
      headSha: headSha ?? 'unknown',
      commandDigest: createHash('sha256').update(rawBody).digest('hex'),
    };
  } catch {
    return null;
  }
}

function summarizeItem(item: QueueItem | undefined): { readonly queueItemId: string; readonly runId: string; readonly kind: string; readonly baseRevision: string } | null {
  return item === undefined ? null : { queueItemId: item.queueItemId, runId: item.runId, kind: item.kind, baseRevision: item.baseRevision };
}

/**
 * Bounded loopback HTTP control plane: constant-time webhook admission, tenant-scoped lease/settle
 * dispatch with scoped installation tokens, and scrubbed structured JSON on every response.
 */
export async function startGitHubAppControlPlane(options: ControlPlaneOptions): Promise<ControlPlaneHandle> {
  const deliveryStore = options.deliveryStore ?? new WebhookDeliveryStore();
  const queue = options.queue ?? new TenantAdmissionQueue({
    maxPendingPerGroup: options.maxPendingPerGroup,
    leaseDurationMs: options.leaseDurationMs,
  });
  const scrubber = options.scrubber ?? options.tokenBroker?.scrubber ?? new SecretScrubber();
  scrubber.register(options.webhookSecret);
  const queueSummary = { enqueued: 0, coalesced: 0, leased: 0, settled: 0, revoked: 0 };
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const webhookPath = options.webhookPath ?? '/webhooks/github';
  const maxPayloadBytes = options.maxPayloadBytes ?? 1_048_576;

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
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, status: 400, detail: 'request body must be a JSON object' };
      }
      return { ok: true, body: parsed as Record<string, unknown> };
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
      const outcome: WebhookIntakeOutcome = intakeWebhookDelivery({
        rawBody: raw.bytes,
        signatureHeader: request.headers['x-hub-signature-256'] as string | undefined,
        secret: options.webhookSecret,
        eventName: String(request.headers['x-github-event'] ?? ''),
        deliveryId: headerDeliveryId,
        receivedAtMs: Date.now(),
        taskpackId: options.taskpackId,
        commentPrefixes: options.commentPrefixes,
        commentCommands: options.commentCommands,
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
      // Accepted (including failed-redelivery retries): enqueue the actionable trigger for the tenant.
      const tenant = outcome.tenant;
      if (tenant === null) return respond(response, 400, { error: { code: 'TENANT_IDENTITY_INVALID', message: 'accepted webhook without tenant attribution' } });
      const kind = outcome.action === 'revise' ? 'revise' : outcome.action === 'status' ? 'status' : 'discover';
      const entry = outcome.entry;
      if (WEBHOOK_DELIVERY_ID_TEST.test(entry.deliveryId)) deliveryStore.markDeliveryState(entry.deliveryId, 'processing');
      try {
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
          if (options.tokenBroker === undefined) {
            return respond(response, 503, { error: { code: 'TOKEN_BROKER_CONFIG_INVALID', message: 'this control plane has no installation token broker configured' } });
          }
          const grant = queue.leaseNext(tenant, workerId, nowSample);
          if (grant === null) return respond(response, 200, { item: null });
          queueSummary.leased += 1;
          const token = await options.tokenBroker.mint(tenant, 'read_only');
          const item = queue.inspectTenantQueue(tenant).items.find(candidate => candidate.queueItemId === grant.queueItemId);
          if (item !== undefined && item.deliveryId !== null) deliveryStore.markDeliveryState(item.deliveryId, 'processing');
          const tokenMarker = `lw-token-${randomBytes(8).toString('hex')}`;
          return respond(response, 200, {
            lease: { ...grant }, item: summarizeItem(item),
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
        if (settled.deliveryId !== null) {
          deliveryStore.markDeliveryState(settled.deliveryId, settleOutcome === 'completed' ? 'succeeded' : 'failed', settleOutcome === 'completed' ? null : settleOutcome);
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
