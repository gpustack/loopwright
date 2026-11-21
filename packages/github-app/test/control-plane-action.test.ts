import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { evaluateCommentPayload, runActionCli, runGitHubActionEntrypoint } from '../src/action.js';
import { MULTI_TENANT_HOST_POLICY, startGitHubAppControlPlane, type ControlPlaneOptions } from '../src/service.js';
import { compilePlan, loadTrustedConfiguration, resumeCycleWithPorts } from '@loopwright/controller';
import {
  parseTaskpackManifest,
  serializePrettyYaml as serializeTaskpackYaml,
  TASKPACK_ERROR_CODES,
  TaskpackError,
  validateTaskpackV2Manifest as validateTaskpackFromPkg,
} from '@loopwright/taskpack';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { InstallationTokenBroker } from '../src/token-broker.js';
import { TenantAdmissionQueue } from '../src/tenant-queue.js';
import { GITHUB_APP_ERROR_CODES, GitHubAppError, type InstallationTokenRequest, type TenantIdentity } from '../src/types.js';
import { WebhookDeliveryStore } from '../src/webhook.js';
import { createFastTurnkeyAdapter } from './fast-turnkey-adapter.js';
import { sseToolCalls, startHttpServer } from './mcp-test-fixtures.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const SECRET = 'control-plane-secret';
const TASKPACK_ID = 'docs-sync';
const TENANT: TenantIdentity = { installationId: 42, repositoryId: 7, repositoryFullName: 'octocat/target', taskpackId: TASKPACK_ID };
const BASE_REVISION = 'd'.repeat(40);

const MANIFEST = `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: docs-sync
spec:
  goal:
    candidate: Refresh documentation from upstream sources and pass every local check.
    noChange: Confirm the documentation needs no change and settle as no change.
  scope:
    writable:
      - 'docs/**'
    protected: []
  upstreams:
    - id: engine
      kind: github-release
      source: octocat/engine
      watchedPaths:
        - docs
  proposal:
    path: docs/proposal.json
    requiredFields:
      - schema_version
      - candidates
    schemaVersion: 1
  verification:
    localChecks:
      - id: docs-proposal-json
        implementation: json-artifact.v1
    externalGates: []
  publication:
    mode: pull_request
    targetBranch: main
    headBranchPrefix: loopwright-docs-
    titleTemplate: 'docs: sync upstream documentation'
  memory:
    directory: .loopwright/memory/docs-sync
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands:
      - retry
      - revise
      - status
`;

const savedEnv: Record<string, string | undefined> = {};
after(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function withEnv(name: string, value: string): void {
  savedEnv[name] ??= process.env[name];
  process.env[name] = value;
}

function sign(body: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(Buffer.from(body, 'utf8')).digest('hex')}`;
}

function commentPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'created',
    installation: { id: TENANT.installationId },
    repository: { id: TENANT.repositoryId, full_name: TENANT.repositoryFullName },
    issue: { number: 5, pull_request: { number: 5, head: { sha: 'c'.repeat(40) } } },
    comment: {
      id: 7, body: '/loopwright retry', author_association: 'MEMBER',
      user: { login: 'maintainer', type: 'User' },
    },
    ...overrides,
  };
}

async function post(handle: { url: string }, path: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${handle.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) as Record<string, unknown> : {} };
}

describe('loopback control plane (AC-6)', () => {
  const requests: InstallationTokenRequest[] = [];
  const broker = new InstallationTokenBroker({
    appId: 1234, privateKeyPem: PRIVATE_KEY_PEM, nowSeconds: () => 1_700_000_000,
    transport: { createInstallationToken: async request => {
      requests.push(request);
      return { token: `ghs_${requests.length.toString().padStart(24, '0')}`, expiresAtMs: 1_700_003_600_000 };
    } },
  });
  const pinnedManifest = validateTaskpackFromPkg({
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'Taskpack',
    metadata: { name: TASKPACK_ID },
    spec: {
      goal: { candidate: 'Refresh docs.', noChange: 'Confirm no change.' },
      scope: { writable: ['docs/**'], protected: [] },
      upstreams: [],
      verification: { localChecks: [{ id: 'nc', implementation: 'no-change.v1' }], externalGates: [] },
      triggers: {
        schedule: false,
        workflowDispatch: false,
        releasePublished: false,
        commentCommands: ['retry', 'revise', 'status'],
        commentPrefixes: ['/loopwright'],
      },
    },
  }, { policyProfile: 'github', hostPolicy: MULTI_TENANT_HOST_POLICY, enforceHostAuthority: true });
  const options: ControlPlaneOptions = {
    port: 0, webhookSecret: SECRET, tokenBroker: broker, taskpackId: TASKPACK_ID, baseRevision: BASE_REVISION, manifest: pinnedManifest,
  };
  let handle: Awaited<ReturnType<typeof startGitHubAppControlPlane>>;
  let firstQueueItemId = '';
  let firstLeaseEpoch = 0;

  before(async () => {
    handle = await startGitHubAppControlPlane(options);
  });
  after(async () => {
    await handle.close();
  });

  it('admits a signed webhook and enqueues the trigger', async () => {
    const body = JSON.stringify(commentPayload());
    const response = await post(handle, '/webhooks/github', body, {
      'x-hub-signature-256': sign(body), 'x-github-event': 'issue_comment', 'x-github-delivery': 'delivery-e2e-0001',
    });
    assert.equal(response.status, 202);
    assert.equal(response.body['kind'], 'accepted');
    firstQueueItemId = String(response.body['queueItemId']);
    assert.match(firstQueueItemId, /^q\d+$/);
    const inspection = handle.queue.inspectTenantQueue(TENANT);
    assert.equal(inspection.counts.pending, 1);
    assert.equal(inspection.items[0]!.deliveryId, 'delivery-e2e-0001');
  });

  it('reports health with queue and delivery summary counts', async () => {
    const health = await (await fetch(`${handle.url}/healthz`)).json() as Record<string, unknown>;
    assert.equal(health['ok'], true);
    assert.equal((health['deliveries'] as Record<string, unknown>)['processing'], 1);
    assert.equal((health['queue'] as Record<string, unknown>)['enqueued'], 1);
  });

  it('acknowledges redeliveries idempotently with 2XX', async () => {
    const body = JSON.stringify(commentPayload());
    const response = await post(handle, '/webhooks/github', body, {
      'x-hub-signature-256': sign(body), 'x-github-event': 'issue_comment', 'x-github-delivery': 'delivery-e2e-0001',
    });
    assert.equal(response.status, 200);
    assert.equal(response.body['kind'], 'duplicate');
  });

  it('fails closed with 409 on a payload-mismatch redelivery', async () => {
    const different = JSON.stringify(commentPayload({ comment: { id: 8, body: '/loopwright retry', author_association: 'MEMBER', user: { login: 'maintainer', type: 'User' } } }));
    const response = await post(handle, '/webhooks/github', different, {
      'x-hub-signature-256': sign(different), 'x-github-event': 'issue_comment', 'x-github-delivery': 'delivery-e2e-0001',
    });
    assert.equal(response.status, 409);
    assert.equal((response.body['error'] as Record<string, unknown>)['code'], 'WEBHOOK_DELIVERY_CONFLICT');
  });

  it('rejects invalid signatures with 401', async () => {
    const body = JSON.stringify(commentPayload());
    const response = await post(handle, '/webhooks/github', body, {
      'x-hub-signature-256': sign('tampered'), 'x-github-event': 'issue_comment', 'x-github-delivery': 'delivery-e2e-9999',
    });
    assert.equal(response.status, 401);
    assert.equal((response.body['error'] as Record<string, unknown>)['code'], 'WEBHOOK_SIGNATURE_INVALID');
  });

  it('leases with a monotonic leaseEpoch and a single-repository read_only token', async () => {
    const response = await post(handle, `/tenants/${TENANT.installationId}/${TENANT.repositoryId}/${TASKPACK_ID}/lease`, JSON.stringify({ workerId: 'worker-1', repositoryFullName: TENANT.repositoryFullName }));
    assert.equal(response.status, 200);
    const lease = response.body['lease'] as Record<string, unknown>;
    assert.equal(lease['leaseEpoch'], 1);
    firstLeaseEpoch = Number(lease['leaseEpoch']);
    assert.equal(lease['queueItemId'], firstQueueItemId);
    const token = response.body['installationToken'] as Record<string, unknown>;
    const deliveredToken = String(token['token']);
    assert.equal(deliveredToken, `ghs_${'0'.repeat(23)}1`, 'the lease delivers the exact minted read_only token');
    assert.deepEqual(requests[0]!.repositoryIds, [TENANT.repositoryId]);
    assert.deepEqual(requests[0]!.permissions, { contents: 'read', metadata: 'read' });
    const scrubbed = JSON.stringify({ lease: response.body['lease'], item: response.body['item'] });
    assert.equal(scrubbed.includes(deliveredToken), false, 'non-token fields must be scrubbed');
  });

  it('blocks a second concurrent lease until settlement', async () => {
    const response = await post(handle, `/tenants/${TENANT.installationId}/${TENANT.repositoryId}/${TASKPACK_ID}/lease`, JSON.stringify({ workerId: 'worker-2', repositoryFullName: TENANT.repositoryFullName }));
    assert.equal(response.status, 200);
    assert.deepEqual(response.body['item'], null);
  });

  it('refuses settlement with a stale epoch', async () => {
    const response = await post(handle, `/tenants/${TENANT.installationId}/${TENANT.repositoryId}/${TASKPACK_ID}/settle`, JSON.stringify({
      workerId: 'worker-1', repositoryFullName: TENANT.repositoryFullName, queueItemId: firstQueueItemId, leaseEpoch: 99, outcome: 'completed',
    }));
    assert.equal(response.status, 409);
    assert.equal((response.body['error'] as Record<string, unknown>)['code'], 'QUEUE_LEASE_FENCED');
  });

  it('settles the leased item and marks the delivery succeeded', async () => {
    const settle = await post(handle, `/tenants/${TENANT.installationId}/${TENANT.repositoryId}/${TASKPACK_ID}/settle`, JSON.stringify({
      workerId: 'worker-1', repositoryFullName: TENANT.repositoryFullName,
      queueItemId: firstQueueItemId, leaseEpoch: firstLeaseEpoch, outcome: 'completed',
    }));
    assert.equal(settle.status, 200);
    assert.equal(settle.body['state'], 'completed');
    assert.equal(handle.deliveryStore.getDelivery('delivery-e2e-0001')?.state, 'succeeded');
    const released = await post(handle, `/tenants/${TENANT.installationId}/${TENANT.repositoryId}/${TASKPACK_ID}/lease`, JSON.stringify({ workerId: 'worker-3', repositoryFullName: TENANT.repositoryFullName }));
    assert.equal(released.status, 200);
    assert.deepEqual(released.body['item'], null, 'settlement releases the group and the queue is empty');
  });

  it('cancels pending work when an installation revocation webhook arrives', async () => {
    const body = JSON.stringify(commentPayload({ comment: { id: 9, body: '/loopwright retry', author_association: 'MEMBER', user: { login: 'maintainer', type: 'User' } } }));
    const accepted = await post(handle, '/webhooks/github', body, {
      'x-hub-signature-256': sign(body), 'x-github-event': 'issue_comment', 'x-github-delivery': 'delivery-e2e-0002',
    });
    assert.equal(accepted.status, 202);
    const revokeBody = JSON.stringify({ action: 'suspend', installation: { id: TENANT.installationId } });
    const revoked = await post(handle, '/webhooks/github', revokeBody, {
      'x-hub-signature-256': sign(revokeBody), 'x-github-event': 'installation', 'x-github-delivery': 'delivery-e2e-0003',
    });
    assert.equal(revoked.status, 202);
    assert.equal(revoked.body['kind'], 'revoked');
    assert.equal(revoked.body['cancelled'], 1);
    assert.equal(handle.queue.inspectTenantQueue(TENANT).counts.pending, 0);
  });
});

async function makeTargetRepository(): Promise<{ root: string; runRoot: string }> {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-target-'));
    await mkdir(join(root, '.loopwright'), { recursive: true });
    await writeFile(join(root, '.loopwright', 'taskpack.yaml'), MANIFEST);
    await chmod(join(root, '.loopwright'), 0o700);
    const runRoot = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-action-runs-'));
    return { root, runRoot };
  }

function findRepositoryRoot(): string {
  let current = process.cwd();
  for (let depth = 0; depth < 6; depth++) {
    if (existsSync(join(current, 'action.yml')) && existsSync(join(current, 'package.json'))) return current;
    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

describe('control-plane scrubber binding and scoped revocation (Finding 2)', () => {
  const transportCalls: number[][] = [];
  const broker = new InstallationTokenBroker({
    appId: 1234, privateKeyPem: PRIVATE_KEY_PEM, nowSeconds: () => 1_700_000_000,
    transport: { createInstallationToken: async request => {
      transportCalls.push([...request.repositoryIds]);
      return { token: 'ghs_tok en=plus+value', expiresAtMs: 1_700_003_600_000 };
    } },
  });
  let handle: Awaited<ReturnType<typeof startGitHubAppControlPlane>>;
  const tenantFor = (repositoryId: number): TenantIdentity => ({ ...TENANT, repositoryId });

  before(async () => {
    // options.scrubber is deliberately omitted: the default must bind to the broker's scrubber.
    handle = await startGitHubAppControlPlane({ port: 0, webhookSecret: SECRET, tokenBroker: broker, taskpackId: TASKPACK_ID, baseRevision: BASE_REVISION });
  });
  after(async () => {
    await handle.close();
  });

  it('scrubs raw, URL-encoded, and base64 token forms plus the webhook secret from responses', async () => {
    const grant = await broker.mint(tenantFor(7), 'read_only');
    const urlEncoded = encodeURIComponent(grant.token);
    const base64Form = Buffer.from(grant.token, 'utf8').toString('base64');
    for (const leak of [grant.token, urlEncoded, base64Form, SECRET]) {
      const response = await fetch(`${handle.url}/nope/${leak}`);
      const text = await response.text();
      assert.equal(text.includes(leak), false, `response must not leak: ${leak.slice(0, 12)}...`);
    }
  });

  it('installation.deleted evicts every cached token and revokes all installation tenants', async () => {
    const queue = new TenantAdmissionQueue();
    const scoped = await startGitHubAppControlPlane({ port: 0, webhookSecret: SECRET, tokenBroker: broker, taskpackId: TASKPACK_ID, baseRevision: BASE_REVISION, queue });
    try {
      await broker.mint(tenantFor(7), 'read_only');
      await broker.mint(tenantFor(8), 'read_only');
      const callsAfterMint = transportCalls.length;
      const body = JSON.stringify({ action: 'deleted', installation: { id: TENANT.installationId } });
      const revoked = await post(scoped, '/webhooks/github', body, {
        'x-hub-signature-256': sign(body), 'x-github-event': 'installation', 'x-github-delivery': 'delivery-findel-0001',
      });
      assert.equal(revoked.status, 202);
      assert.equal(revoked.body['cancelled'], 0);
      await broker.mint(tenantFor(7), 'read_only');
      await broker.mint(tenantFor(8), 'read_only');
      assert.equal(transportCalls.length, callsAfterMint + 2, 'installation revocation must evict every cached token');
    } finally {
      await scoped.close();
    }
  });

  it('installation_repositories.removed revokes only the removed repositories', async () => {
    const queue = new TenantAdmissionQueue();
    const scoped = await startGitHubAppControlPlane({ port: 0, webhookSecret: SECRET, tokenBroker: broker, taskpackId: TASKPACK_ID, baseRevision: BASE_REVISION, queue });
    try {
      await queue.enqueue(tenantFor(7), { kind: 'discover', baseRevision: BASE_REVISION });
      await queue.enqueue(tenantFor(8), { kind: 'discover', baseRevision: BASE_REVISION });
      await broker.mint(tenantFor(7), 'read_only');
      await broker.mint(tenantFor(8), 'read_only');
      const callsAfterMint = transportCalls.length;
      const body = JSON.stringify({
        action: 'removed', installation: { id: TENANT.installationId },
        repositories_removed: [{ id: 7, full_name: TENANT.repositoryFullName }],
      });
      const revoked = await post(scoped, '/webhooks/github', body, {
        'x-hub-signature-256': sign(body), 'x-github-event': 'installation_repositories', 'x-github-delivery': 'delivery-findel-0002',
      });
      assert.equal(revoked.status, 202);
      assert.equal(queue.inspectTenantQueue(tenantFor(7)).counts.pending, 0, 'removed repository tenants must be cancelled');
      assert.equal(queue.inspectTenantQueue(tenantFor(7)).items[0]?.cancelReason, 'installation_revoked');
      assert.equal(queue.inspectTenantQueue(tenantFor(8)).counts.pending, 1, 'sibling repository tenants must stay pending');
      await broker.mint(tenantFor(7), 'read_only');
      assert.equal(transportCalls.length, callsAfterMint + 1, 'removed repository tokens must be evicted');
      await broker.mint(tenantFor(8), 'read_only');
      assert.equal(transportCalls.length, callsAfterMint + 1, 'sibling repository tokens must stay cached');
    } finally {
      await scoped.close();
    }
  });
});

describe('entrypoint comment trigger guards (Finding 4)', () => {
  const basePayload = {
    action: 'created',
    installation: { id: 42 },
    repository: { id: 7, full_name: 'octocat/target' },
    issue: { number: 5, pull_request: { number: 5, head: { sha: 'c'.repeat(40) } } },
    comment: { id: 7, body: '/loopwright retry', author_association: 'MEMBER', user: { login: 'maintainer', type: 'User' } },
  };
  const evaluate = (payload: unknown, overrides: Partial<{ eventName: string; commentPrefixes: string[]; commentCommands: string[] }> = {}) =>
    evaluateCommentPayload(payload, {
      eventName: overrides.eventName ?? 'issue_comment',
      commentPrefixes: overrides.commentPrefixes ?? ['/loopwright'],
      commentCommands: (overrides.commentCommands ?? ['retry', 'revise', 'status']) as ('retry' | 'revise' | 'status')[],
    });

  it('ignores edited comments and comments outside pull requests', () => {
    const edited = evaluate({ ...basePayload, action: 'edited' });
    assert.equal('ignoredReason' in edited && edited.ignoredReason, 'comment action edited is not created');
    const plain = evaluate({ ...basePayload, issue: { number: 5, user: { login: 'maintainer', type: 'User' } } });
    assert.equal('ignoredReason' in plain && plain.ignoredReason, 'comment is not on a pull request');
  });

  it('ignores bot authors by type and by [bot] login suffix', () => {
    const byType = evaluate({ ...basePayload, comment: { id: 7, body: '/loopwright retry', author_association: 'MEMBER', user: { login: 'loopwright-bot', type: 'Bot' } } });
    assert.equal('ignoredReason' in byType && byType.ignoredReason, 'comment author is a bot');
    const bySuffix = evaluate({ ...basePayload, comment: { id: 7, body: '/loopwright retry', author_association: 'MEMBER', user: { login: 'maintainer[bot]', type: 'User' } } });
    assert.equal('ignoredReason' in bySuffix && bySuffix.ignoredReason, 'comment author is a bot');
  });

  it('ignores commands outside the manifest trigger configuration and unknown prefixes', () => {
    const unconfigured = evaluate({ ...basePayload, comment: { id: 7, body: '/loopwright destroy', author_association: 'MEMBER', user: { login: 'maintainer', type: 'User' } } });
    assert.equal('ignoredReason' in unconfigured && unconfigured.ignoredReason, 'comment without a configured command prefix or supported command');
    const unknownPrefix = evaluate({ ...basePayload, comment: { id: 7, body: '/autopr retry', author_association: 'MEMBER', user: { login: 'maintainer', type: 'User' } } });
    assert.equal('ignoredReason' in unknownPrefix && unknownPrefix.ignoredReason, 'comment without a configured command prefix or supported command');
    const configured = evaluate(basePayload, { commentCommands: ['retry'] });
    assert.equal('command' in configured && configured.command, 'retry');
  });

  it('ignores reviews whose action is not submitted', () => {
    const review = { action: 'edited', review: { id: 9, body: '/loopwright retry', author_association: 'OWNER', user: { login: 'maintainer', type: 'User' } } };
    const outcome = evaluate(review, { eventName: 'pull_request_review' });
    assert.equal('ignoredReason' in outcome && outcome.ignoredReason, 'review action edited is not submitted');
  });

  it('routes bot-authored comment events through the entrypoint as blocked runs', async () => {
    const { root, runRoot } = await makeTargetRepository();
    try {
      const result = await runGitHubActionEntrypoint({
        repositoryRoot: root, repositoryFullName: 'octocat/target', baseRevision: BASE_REVISION,
        mode: 'candidate', eventName: 'issue_comment', runRoot, runId: 'run-f4-1',
        eventPayload: { ...basePayload, comment: { id: 7, body: '/loopwright retry', author_association: 'MEMBER', user: { login: 'dependabot[bot]', type: 'User' } } },
      });
      assert.equal(result.kind, 'blocked');
      assert.equal(result.kind === 'blocked' ? result.reason : '', 'comment ignored: comment author is a bot');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(runRoot, { recursive: true, force: true });
    }
  });
});

describe('reusable Action entrypoint (AC-6)', () => {
  it('compiles offline and writes scrubbed artifacts outside the checkout with a dry-run delegate', async () => {
    withEnv('LOOPWRIGHT_PROVIDER_TOKEN', 'provider-token-value');
    withEnv('LOOPWRIGHT_PUBLICATION_SIGNING_SECRET', 'publication-signing-value');
    const { root, runRoot } = await makeTargetRepository();
    try {
      const result = await runGitHubActionEntrypoint({
        repositoryRoot: root, repositoryFullName: 'octocat/target', baseRevision: BASE_REVISION,
        mode: 'candidate', eventName: 'workflow_dispatch', runRoot, runId: 'run-e2e-1',
        dryRun: true,
        publicationEndpoint: { id: 'docs-publication', url: 'https://publisher.example.test/publish', signingCredentialRef: 'docs-publication-signing' },
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: '2.0.0' }],
      });
      assert.equal(result.kind, 'compiled');
      if (result.kind === 'compiled') {
        assert.equal(result.manifest.metadata.name, TASKPACK_ID);
        assert.equal(result.intake.disposition, 'ready');
        assert.equal(result.delegateOutcome, null, 'dry runs must not invoke a delegate');
        const outside = !result.taskpack.trustedDirectory.startsWith(await realpath(root));
        assert.equal(outside, true);
        assert.equal(result.taskpack.registryPath.endsWith('registry.yaml'), true);
        assert.equal(result.taskpack.configPath.endsWith('config.yaml'), true);
        const registryOnDisk = await readFile(result.taskpack.registryPath);
        assert.equal(registryOnDisk.equals(result.taskpack.registryBytes), true);
        const scrubbed = new TextDecoder().decode(registryOnDisk);
        assert.equal(scrubbed.includes('${LOOPWRIGHT_PROVIDER_TOKEN}'), true, 'secrets stay as templates on disk');
        assert.equal(scrubbed.includes('provider-token-value'), false, 'resolved secrets never reach disk');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(runRoot, { recursive: true, force: true });
    }
  });

  it('invokes the delegate hook, whose controller load passes end-to-end', async () => {
    withEnv('LOOPWRIGHT_PROVIDER_TOKEN', 'provider-token-value');
    withEnv('LOOPWRIGHT_PUBLICATION_SIGNING_SECRET', 'publication-signing-value');
    const { root, runRoot } = await makeTargetRepository();
    let delegateCalls = 0;
    try {
      const result = await runGitHubActionEntrypoint({
        repositoryRoot: root, repositoryFullName: 'octocat/target', baseRevision: BASE_REVISION,
        mode: 'candidate', eventName: 'schedule', runRoot, runId: 'run-e2e-2',
        publicationEndpoint: { id: 'docs-publication', url: 'https://publisher.example.test/publish', signingCredentialRef: 'docs-publication-signing' },
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: '2.0.0' }],
        delegate: async taskpack => {
          delegateCalls += 1;
          assert.equal(taskpack.config.spec.task.spec.taskpack, TASKPACK_ID);
          // The delegate is the controller: prove the written artifacts load without REGISTRY_UNTRUSTED.
          const loaded = await loadTrustedConfiguration({
            configPath: taskpack.configPath, registryPath: taskpack.registryPath,
            registrySha256: taskpack.registrySha256, untrustedRoots: [root],
          });
          assert.equal(loaded.ok, true, `loadTrustedConfiguration failed: ${loaded.ok ? '' : loaded.error.code}`);
          if (loaded.ok) {
            const plan = await compilePlan(loaded.value);
            assert.equal(plan.ok, true, `compilePlan failed: ${plan.ok ? '' : plan.error.code}`);
          }
          return { ok: true, detail: 'delegate executed' };
        },
      });
      assert.equal(result.kind, 'compiled');
      if (result.kind === 'compiled') {
        assert.equal(delegateCalls, 1);
        assert.deepEqual(result.delegateOutcome, { ok: true, detail: 'delegate executed' });
        const registryDirectory = await stat(dirname(result.taskpack.registryPath));
        const configDirectory = await stat(dirname(result.taskpack.configPath));
        assert.equal(registryDirectory.mode & 0o777, 0o700, 'registry directory must be 0o700');
        assert.equal(configDirectory.mode & 0o777, 0o700, 'config directory must be 0o700');
        assert.notEqual(dirname(result.taskpack.registryPath), dirname(result.taskpack.configPath), 'registry and config must live in separate directories');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(runRoot, { recursive: true, force: true });
    }
  });

  it('refuses an MCP OAuth configuration before compiling', async () => {
    const { root, runRoot } = await makeTargetRepository();
    try {
      const result = await runGitHubActionEntrypoint({
        repositoryRoot: root, repositoryFullName: 'octocat/target', baseRevision: BASE_REVISION,
        mode: 'candidate', eventName: 'workflow_dispatch', runRoot, runId: 'run-e2e-3',
        mcpServers: [{ serverId: 'docs', auth: { type: 'oauth' } }],
      });
      assert.deepEqual(result, { kind: 'refused', code: 'MCP_OAUTH_UNSUPPORTED', reason: result.kind === 'refused' ? result.reason : '' });
      assert.equal(result.kind, 'refused');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(runRoot, { recursive: true, force: true });
    }
  });

  it('refuses a drifting host clock with HOST_CLOCK_UNTRUSTED', async () => {
    const { root, runRoot } = await makeTargetRepository();
    try {
      const result = await runGitHubActionEntrypoint({
        repositoryRoot: root, repositoryFullName: 'octocat/target', baseRevision: BASE_REVISION,
        mode: 'candidate', eventName: 'workflow_dispatch', runRoot, runId: 'run-e2e-4',
        clockBasis: { clockEpoch: 'run-e2e-4', created: { wallMs: 1_000_000, monotonicMs: '1000' }, taskDeadlineMonotonicMs: '101000' },
        previousClockSample: { wallMs: 1_000_000, monotonicMs: '1000' },
        currentClockSample: { wallMs: 1_006_000, monotonicMs: '1050' },
      });
      assert.equal(result.kind, 'refused');
      assert.equal(result.kind === 'refused' ? result.code : '', 'HOST_CLOCK_UNTRUSTED');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(runRoot, { recursive: true, force: true });
    }
  });

  it('returns no_change when discovery finds no available updates', async () => {
    const { root, runRoot } = await makeTargetRepository();
    try {
      const result = await runGitHubActionEntrypoint({
        repositoryRoot: root, repositoryFullName: 'octocat/target', baseRevision: BASE_REVISION,
        mode: 'candidate', eventName: 'schedule', runRoot, runId: 'run-e2e-5',
        upstreamRecords: [{ upstreamId: 'engine', status: 'up_to_date', version: '1.0.0' }],
      });
      assert.equal(result.kind, 'no_change');
      assert.equal(result.kind === 'no_change' ? result.reason : '', 'no subscription reports an available update');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(runRoot, { recursive: true, force: true });
    }
  });

  it('ships the 5 gpustack-aligned .github/workflows files alongside root action.yml', () => {
    const repoRoot = findRepositoryRoot();
    for (const wf of ['ci.yml', 'test.yml', 'docs.yml', 'code-review.yml', 'site.yml']) {
      assert.equal(existsSync(join(repoRoot, '.github', 'workflows', wf)), true, `.github/workflows/${wf} must exist`);
    }
  });

  it('keeps the root action.yml outside .github/workflows as a composite Node 26 Action and writes GITHUB_OUTPUT in runActionCli', async () => {
    const actionYml = await readFile(join(findRepositoryRoot(), 'action.yml'), 'utf8');
    const parsedAction = parseYaml(actionYml, { uniqueKeys: true }) as Record<string, unknown>;
    assert.equal(parsedAction['name'], 'Loopwright Taskpack Action');
    assert.equal(typeof parsedAction['description'], 'string');
    assert.ok((parsedAction['description'] as string).includes('Run the Loopwright declarative taskpack cycle'));
    assert.match(actionYml, /name: 'Loopwright Taskpack Action'/);
    assert.match(actionYml, /using: 'composite'/);
    assert.match(actionYml, /node-version: '26'/);
    assert.match(actionYml, /value: \$\{\{ steps\.loopwright-entrypoint\.outputs\.result \}\}/);
    assert.match(actionYml, /value: \$\{\{ steps\.loopwright-entrypoint\.outputs\.pr-url \}\}/);
    assert.match(actionYml, /value: \$\{\{ steps\.loopwright-entrypoint\.outputs\.memory-pr-url \}\}/);
    assert.match(actionYml, /value: \$\{\{ steps\.loopwright-entrypoint\.outputs\.total-tokens \}\}/);
    assert.match(actionYml, /value: \$\{\{ steps\.loopwright-entrypoint\.outputs\.cost-usd \}\}/);
    assert.match(actionYml, /INPUT_OUTPUT: \$\{\{ inputs\.output \}\}/);
    assert.match(actionYml, /INPUT_GITHUB-TOKEN: \$\{\{ inputs\.github-token \}\}/);
    assert.match(actionYml, /INPUT_GIT-AUTHOR-NAME: \$\{\{ inputs\.git-author-name \}\}/);
    assert.match(actionYml, /INPUT_GIT-AUTHOR-EMAIL: \$\{\{ inputs\.git-author-email \}\}/);
    assert.match(actionYml, /INPUT_UPSTREAM-RECORDS: \$\{\{ inputs\.upstream-records \}\}/);
    assert.match(actionYml, /INPUT_FORCE: \$\{\{ inputs\.force \}\}/);
    const actionInputs = parsedAction['inputs'] as Record<string, { default?: unknown }>;
    assert.equal(actionInputs['force']?.default, 'false');

    withEnv('LOOPWRIGHT_PROVIDER_TOKEN', 'provider-token-value');
    withEnv('LOOPWRIGHT_PUBLICATION_SIGNING_SECRET', 'publication-signing-value');
    const { root, runRoot } = await makeTargetRepository();
    const outputFile = join(runRoot, 'github-output.txt');
    try {
      const code = await runActionCli({
        GITHUB_WORKSPACE: root,
        LOOPWRIGHT_REPOSITORY: 'octocat/target',
        GITHUB_SHA: BASE_REVISION,
        'INPUT_MODE': 'no-change',
        'INPUT_EVENT-NAME': 'workflow_dispatch',
        'INPUT_RUN-ROOT': runRoot,
        'INPUT_RUN-ID': 'run-cli-out-1',
        'INPUT_DRY-RUN': 'true',
        GITHUB_OUTPUT: outputFile,
      });
      assert.equal(code, 0);
      const outputText = await readFile(outputFile, 'utf8');
      assert.match(outputText, /^result<<LOOPWRIGHT_EOF\n.+\nLOOPWRIGHT_EOF\n$/);
      const jsonLine = outputText.split('\n')[1]!;
      const parsed = JSON.parse(jsonLine) as { kind: string; reason?: string };
      assert.equal(parsed.kind, 'no_change');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(runRoot, { recursive: true, force: true });
    }
  });

  it('refuses OAuth Pi providers with PROVIDER_OAUTH_UNSUPPORTED in runGitHubActionEntrypoint', async () => {
    const { root, runRoot } = await makeTargetRepository();
    try {
      for (const provider of ['github-copilot', 'gemini', 'claude-code', 'openai-codex']) {
        const result = await runGitHubActionEntrypoint({
          repositoryRoot: root,
          repositoryFullName: 'octocat/target',
          baseRevision: BASE_REVISION,
          mode: 'candidate',
          eventName: 'workflow_dispatch',
          runRoot,
          runId: `run-oauth-${provider}`,
          provider,
          model: 'glm-5.3',
          dryRun: true,
        });
        assert.equal(result.kind, 'refused');
        if (result.kind === 'refused') {
          assert.equal(result.code, 'PROVIDER_OAUTH_UNSUPPORTED');
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(runRoot, { recursive: true, force: true });
    }
  });

  it('probes multi-token / multi-provider spec.models candidates and rotates to a fresh session on mid-run quota exhaustion', async () => {
    withEnv('ZAI_API_KEY', 'zai_exhausted_tok_0001,zai_midrun_tok_0002');
    withEnv('ZAI_CODING_CN_API_KEY', 'zai_cn_backup_tok_0003');
    withEnv('LOOPWRIGHT_PUBLICATION_SIGNING_SECRET', 'publication-signing-value');
    const { root, runRoot } = await makeTargetRepository();
    await writeFile(join(root, '.loopwright', 'taskpack.yaml'), `${MANIFEST}  models:
    - provider: zai
      id: glm-5.3
      thinking: high
      apiKeyEnv: ZAI_API_KEY
    - provider: zai-coding-cn
      id: glm-5.3
      thinking: high
      apiKeyEnv: ZAI_CODING_CN_API_KEY
`);

    const seenDelegateProviders: string[] = [];
    const seenTrustedDirs: string[] = [];
    try {
      const result = await runGitHubActionEntrypoint({
        repositoryRoot: root,
        repositoryFullName: 'octocat/target',
        baseRevision: BASE_REVISION,
        mode: 'candidate',
        eventName: 'schedule',
        runRoot,
        runId: 'run-multi-fallback-1',
        publicationEndpoint: { id: 'docs-publication', url: 'https://publisher.example.test/publish', signingCredentialRef: 'docs-publication-signing' },
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: '2.0.0' }],
        probeFetch: async (_url, init) => {
          const headers = init?.headers as Record<string, string>;
          const auth = headers['authorization'] ?? '';
          if (auth.includes('zai_exhausted_tok_0001')) {
            return new Response(JSON.stringify({ error: { code: '1113', message: 'quota exhausted' } }), {
              status: 400,
              headers: { 'content-type': 'application/json' },
            });
          }
          return new Response(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
        delegate: async taskpack => {
          const activeProvider = taskpack.registry.spec.roleProfiles[0]!.selection.provider;
          seenDelegateProviders.push(activeProvider);
          seenTrustedDirs.push(taskpack.trustedDirectory);
          const loaded = await loadTrustedConfiguration({
            configPath: taskpack.configPath,
            registryPath: taskpack.registryPath,
            registrySha256: taskpack.registrySha256,
            untrustedRoots: [root],
          });
          assert.equal(loaded.ok, true, `loadTrustedConfiguration failed: ${loaded.ok ? '' : loaded.error.code}`);
          if (loaded.ok) {
            const plan = await compilePlan(loaded.value);
            assert.equal(plan.ok, true);
          }
          if (activeProvider === 'zai') {
            // Simulate mid-run quota exhaustion after initial probe succeeded on token #2
            return { ok: false, detail: 'PROVIDER_RESPONSE_INVALID: http_402 insufficient_quota', retryableProviderFailure: true };
          }
          return { ok: true, detail: `completed with ${activeProvider}` };
        },
      });

      assert.equal(result.kind, 'compiled');
      if (result.kind === 'compiled') {
        assert.deepEqual(seenDelegateProviders, ['zai', 'zai-coding-cn']);
        assert.equal(seenTrustedDirs.length, 2);
        assert.notEqual(seenTrustedDirs[0], seenTrustedDirs[1], 'fallback attempt must compile into a fresh isolated directory');
        assert.deepEqual(result.delegateOutcome, { ok: true, detail: 'completed with zai-coding-cn' });
        assert.equal(result.taskpack.registry.spec.roleProfiles[0]?.selection.provider, 'zai-coding-cn');
        const registryText = (await readFile(result.taskpack.registryPath)).toString('utf8');
        for (const secret of ['zai_exhausted_tok_0001', 'zai_midrun_tok_0002', 'zai_cn_backup_tok_0003']) {
          assert.equal(registryText.includes(secret), false, 'raw tokens must never be written to disk');
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(runRoot, { recursive: true, force: true });
    }
  });

  it('supports force=true (INPUT_FORCE) in candidate discovery to preserve real discovered upstream records while bypassing no_change and open-PR dedup', async () => {
    withEnv('ZAI_API_KEY', 'zai_force_test_token_0001');
    withEnv('LOOPWRIGHT_PUBLICATION_SIGNING_SECRET', 'publication-signing-value');
    const { root, runRoot } = await makeTargetRepository();
    try {
      const manifestWithReleaseUpstream = `${MANIFEST}  models:
    - provider: zai
      id: glm-5.3
      thinking: high
      apiKeyEnv: ZAI_API_KEY
`;
      await writeFile(join(root, '.loopwright', 'taskpack.yaml'), manifestWithReleaseUpstream);
      await mkdir(join(root, 'docs'), { recursive: true });
      await writeFile(join(root, 'docs', 'proposal.json'), JSON.stringify({
        schema_version: 1,
        candidates: { engine: { version: 'v1.2.3' } },
      }));

      let fetchCalls = 0;
      const probeFetch: typeof globalThis.fetch = async url => {
        fetchCalls += 1;
        const target = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (target.endsWith('/repos/octocat/engine/releases/latest')) {
          return new Response(JSON.stringify({ tag_name: 'v1.2.3', prerelease: false, draft: false }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (target.endsWith('/repos/octocat/engine/releases?per_page=30')) {
          return new Response(JSON.stringify([
            { tag_name: 'v1.2.3', prerelease: false, draft: false },
            { tag_name: 'v1.2.2', prerelease: false, draft: false },
          ]), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ message: `unexpected ${target}` }), { status: 404, headers: { 'content-type': 'application/json' } });
      };

      // 1) Without force, all-up-to-date upstreams settle as no_change
      const nonForced = await runGitHubActionEntrypoint({
        repositoryRoot: root,
        repositoryFullName: 'octocat/target',
        baseRevision: BASE_REVISION,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-force-off-1',
        publicationEndpoint: { id: 'docs-publication', url: 'https://publisher.example.test/publish', signingCredentialRef: 'docs-publication-signing' },
        upstreamRecords: [{ upstreamId: 'engine', status: 'up_to_date', version: 'v1.2.3', recentVersions: ['v1.2.3', 'v1.2.2'] }],
      });
      assert.equal(nonForced.kind, 'no_change');

      // 2) With force=true and dryRun=false (real discoverTaskpackUpstreams via probeFetch + managedPrMatchesDiscoveredState=true),
      //    no_change and open-PR dedup are bypassed while real discovered version + recentVersions reach the author prompt!
      let seenPrompt = '';
      const forcedDiscover = await runGitHubActionEntrypoint({
        turnkey: true,
        repositoryRoot: root,
        repositoryFullName: 'octocat/target',
        repositoryId: 42,
        baseRevision: BASE_REVISION,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-force-on-1',
        force: true,
        managedPrMatchesDiscoveredState: true,
        githubApiBaseUrl: 'https://api.github.invalid',
        githubToken: 'ghp_force_test_token_1234',
        publicationEndpoint: { id: 'docs-publication', url: 'https://publisher.example.test/publish', signingCredentialRef: 'docs-publication-signing' },
        probeFetch: async (url, init) => {
          const target = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
          if (target.includes('/repos/octocat/target')) {
            if (target.endsWith('/repos/octocat/target')) {
              return new Response(JSON.stringify({ id: 42, full_name: 'octocat/target', default_branch: 'main' }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            if (target.includes('/pulls')) {
              return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
            }
          }
          if (target.endsWith('/chat/completions')) {
            return new Response(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return probeFetch(url, init);
        },
        delegate: async taskpack => {
          const agentHandler = taskpack.registry.spec.handlers.find(h => h.kind === 'agent');
          seenPrompt = String(agentHandler?.parameters['prompt'] ?? '');
          return { ok: true, detail: 'forced run completed' };
        },
      });
      assert.ok(fetchCalls >= 1, 'expected discoverTaskpackUpstreams to fetch real upstream releases');
      assert.equal(forcedDiscover.kind, 'compiled');
      if (forcedDiscover.kind === 'compiled') {
        assert.equal(forcedDiscover.intake.kind, 'discover');
        if (forcedDiscover.intake.kind === 'discover') {
          assert.equal(forcedDiscover.intake.disposition, 'ready');
        }
        assert.deepEqual(forcedDiscover.delegateOutcome, { ok: true, detail: 'forced run completed' });
      }
      assert.match(seenPrompt, /v1\.2\.3/);
      assert.match(seenPrompt, /v1\.2\.2/);

      // 3) runActionCli maps INPUT_FORCE='true' and bypasses no_change even when all upstream records are up_to_date
      const outputFile = join(runRoot, 'force-cli-output.txt');
      const cliCode = await runActionCli({
        GITHUB_WORKSPACE: root,
        LOOPWRIGHT_REPOSITORY: 'octocat/target',
        GITHUB_SHA: BASE_REVISION,
        'INPUT_MODE': 'candidate',
        'INPUT_EVENT-NAME': 'workflow_dispatch',
        'INPUT_RUN-ROOT': runRoot,
        'INPUT_RUN-ID': 'run-force-cli-1',
        'INPUT_DRY-RUN': 'true',
        'INPUT_FORCE': 'true',
        'INPUT_PUBLICATION-ENDPOINT-URL': 'https://publisher.example.test/publish',
        'INPUT_UPSTREAM-RECORDS': JSON.stringify([
          { upstreamId: 'engine', status: 'up_to_date', version: 'v1.2.3', recentVersions: ['v1.2.3', 'v1.2.2'] },
        ]),
        GITHUB_OUTPUT: outputFile,
      });
      assert.equal(cliCode, 0);
      const outputText = await readFile(outputFile, 'utf8');
      const jsonLine = outputText.split('\n')[1]!;
      const parsed = JSON.parse(jsonLine) as { kind: string; intake?: { disposition?: string } };
      assert.equal(parsed.kind, 'compiled');
      assert.equal(parsed.intake?.disposition, 'ready');

      // 4) PR comment commands follow comment-command dispatch semantics even when force=true
      const commentDiscover = await runGitHubActionEntrypoint({
        repositoryRoot: root,
        repositoryFullName: 'octocat/target',
        baseRevision: BASE_REVISION,
        mode: 'candidate',
        eventName: 'issue_comment',
        eventPayload: {
          action: 'created',
          issue: { number: 7, pull_request: {} },
          comment: { id: 902, body: '/loopwright retry', author_association: 'COLLABORATOR', user: { login: 'octocat', type: 'User' } },
        },
        runRoot,
        runId: 'run-force-comment-1',
        force: true,
        managedPrMatchesDiscoveredState: true,
        publicationEndpoint: { id: 'docs-publication', url: 'https://publisher.example.test/publish', signingCredentialRef: 'docs-publication-signing' },
        upstreamRecords: [{ upstreamId: 'engine', status: 'up_to_date', version: 'v1.2.3', recentVersions: ['v1.2.3', 'v1.2.2'] }],
      });
      assert.equal(commentDiscover.kind, 'no_change');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(runRoot, { recursive: true, force: true });
    }
  });

  it('bypasses open-PR deduplication on authorized /loopwright retry comments while honoring up_to_date no_change and optional guidance', async () => {
    withEnv('LOOPWRIGHT_PROVIDER_TOKEN', 'provider-token-value');
    withEnv('LOOPWRIGHT_PUBLICATION_SIGNING_SECRET', 'publication-signing-value');
    const { root, runRoot } = await makeTargetRepository();
    try {
      const availableRecord = [{ upstreamId: 'engine', status: 'available' as const, version: 'v1.2.4', recentVersions: ['v1.2.4', 'v1.2.3'] }];

      // 1) /loopwright retry with multi-line operator guidance and managedPrMatchesDiscoveredState=true proceeds to compiled/ready
      let seenPromptWithGuidance = '';
      const retryWithGuidance = await runGitHubActionEntrypoint({
        repositoryRoot: root,
        repositoryFullName: 'octocat/target',
        baseRevision: BASE_REVISION,
        mode: 'candidate',
        eventName: 'issue_comment',
        eventPayload: {
          action: 'created',
          issue: { number: 855, pull_request: { head: { sha: 'c'.repeat(40) } } },
          comment: {
            id: 910,
            body: '/loopwright retry\nRebase onto main and preserve the existing release notes.',
            author_association: 'COLLABORATOR',
            user: { login: 'octocat', type: 'User' },
          },
        },
        runRoot,
        runId: 'run-comment-retry-guidance-1',
        managedPrMatchesDiscoveredState: true,
        publicationEndpoint: { id: 'docs-publication', url: 'https://publisher.example.test/publish', signingCredentialRef: 'docs-publication-signing' },
        upstreamRecords: availableRecord,
        delegate: async taskpack => {
          const agentHandler = taskpack.registry.spec.handlers.find(h => h.kind === 'agent');
          seenPromptWithGuidance = String(agentHandler?.parameters['prompt'] ?? '');
          return { ok: true, detail: 'retried with guidance' };
        },
      });
      assert.equal(retryWithGuidance.kind, 'compiled');
      if (retryWithGuidance.kind === 'compiled') {
        assert.equal(retryWithGuidance.intake.kind, 'discover');
        if (retryWithGuidance.intake.kind === 'discover') {
          assert.equal(retryWithGuidance.intake.disposition, 'ready');
        }
        assert.deepEqual(retryWithGuidance.delegateOutcome, { ok: true, detail: 'retried with guidance' });
      }
      assert.match(seenPromptWithGuidance, /<operator_guidance>/);
      assert.match(seenPromptWithGuidance, /Rebase onto main and preserve the existing release notes\./);

      // 2) Bare /loopwright retry with managedPrMatchesDiscoveredState=true also bypasses open-PR dedup without injecting operator_guidance
      let seenPromptBare = '';
      const retryBare = await runGitHubActionEntrypoint({
        repositoryRoot: root,
        repositoryFullName: 'octocat/target',
        baseRevision: BASE_REVISION,
        mode: 'candidate',
        eventName: 'issue_comment',
        eventPayload: {
          action: 'created',
          issue: { number: 855, pull_request: { head: { sha: 'c'.repeat(40) } } },
          comment: {
            id: 911,
            body: '/loopwright retry',
            author_association: 'MEMBER',
            user: { login: 'maintainer', type: 'User' },
          },
        },
        runRoot,
        runId: 'run-comment-retry-bare-1',
        managedPrMatchesDiscoveredState: true,
        publicationEndpoint: { id: 'docs-publication', url: 'https://publisher.example.test/publish', signingCredentialRef: 'docs-publication-signing' },
        upstreamRecords: availableRecord,
        delegate: async taskpack => {
          const agentHandler = taskpack.registry.spec.handlers.find(h => h.kind === 'agent');
          seenPromptBare = String(agentHandler?.parameters['prompt'] ?? '');
          return { ok: true, detail: 'retried bare' };
        },
      });
      assert.equal(retryBare.kind, 'compiled');
      if (retryBare.kind === 'compiled') {
        assert.equal(retryBare.intake.kind, 'discover');
        if (retryBare.intake.kind === 'discover') {
          assert.equal(retryBare.intake.disposition, 'ready');
        }
      }
      assert.equal(seenPromptBare.includes('<operator_guidance>'), false);

      // 3) /loopwright retry when upstreams are all up_to_date still settles as no_change
      const retryUpToDate = await runGitHubActionEntrypoint({
        repositoryRoot: root,
        repositoryFullName: 'octocat/target',
        baseRevision: BASE_REVISION,
        mode: 'candidate',
        eventName: 'issue_comment',
        eventPayload: {
          action: 'created',
          issue: { number: 855, pull_request: { head: { sha: 'c'.repeat(40) } } },
          comment: {
            id: 912,
            body: '/loopwright retry',
            author_association: 'MEMBER',
            user: { login: 'maintainer', type: 'User' },
          },
        },
        runRoot,
        runId: 'run-comment-retry-up-to-date-1',
        managedPrMatchesDiscoveredState: true,
        publicationEndpoint: { id: 'docs-publication', url: 'https://publisher.example.test/publish', signingCredentialRef: 'docs-publication-signing' },
        upstreamRecords: [{ upstreamId: 'engine', status: 'up_to_date', version: 'v1.2.4', recentVersions: ['v1.2.4', 'v1.2.3'] }],
      });
      assert.equal(retryUpToDate.kind, 'no_change');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(runRoot, { recursive: true, force: true });
    }
  });
});

describe('decoupled @loopwright/taskpack parity, GitHubAppError identity, and policyProfile: github trigger gates', () => {
  it('shares identical constructor identity between GitHubAppError and TaskpackError across both packages', () => {
    assert.equal(GitHubAppError, TaskpackError);
    assert.equal(GITHUB_APP_ERROR_CODES, TASKPACK_ERROR_CODES);

    let thrownFromTaskpack: unknown;
    try {
      parseTaskpackManifest(Buffer.from('apiVersion: invalid\n', 'utf8'));
    } catch (err) {
      thrownFromTaskpack = err;
    }
    assert.equal(thrownFromTaskpack instanceof TaskpackError, true);
    assert.equal(thrownFromTaskpack instanceof GitHubAppError, true);

    let thrownFromGitHubApp: unknown;
    try {
      new WebhookDeliveryStore().markDeliveryState('missing-delivery', 'succeeded');
    } catch (err) {
      thrownFromGitHubApp = err;
    }
    assert.equal(thrownFromGitHubApp instanceof GitHubAppError, true);
    assert.equal(thrownFromGitHubApp instanceof TaskpackError, true);
  });

  it('refuses omitted and disabled spec.triggers in runGitHubActionEntrypoint BEFORE preflight executes, and persists hostPolicy: { policyProfile: "github" } across recovery', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'lw-gh-triggers-repo-'));
    const runRoot = await mkdtemp(join(await realpath(tmpdir()), 'lw-gh-triggers-runs-'));
    try {
      await mkdir(join(root, '.loopwright', 'scripts'), { recursive: true });
      await mkdir(join(root, '.github', 'workflows'), { recursive: true });
      await mkdir(join(root, 'docs'), { recursive: true });
      await writeFile(join(root, '.github', 'workflows', 'ci.yml'), 'name: ci\n', 'utf8');
      await writeFile(join(root, 'docs', 'guide.md'), '# Guide v1\n', 'utf8');
      await writeFile(
        join(root, '.loopwright', 'scripts', 'preflight.sh'),
        '#!/bin/sh\nprintf \'{"disposition":"blocked","reason":"PREFLIGHT_EXECUTED_SENTINEL"}\' > "$LOOPWRIGHT_PREFLIGHT_OUT"\n',
        { mode: 0o755 },
      );

      // 1) Manifest omitting spec.triggers, publication, and memory (valid minimal Taskpack)
      const omittedTriggersYaml = serializeTaskpackYaml({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'Taskpack',
        metadata: { name: 'omitted-triggers' },
        spec: {
          goal: { candidate: 'Update docs.', noChange: 'Confirm no change.' },
          preflight: { script: '.loopwright/scripts/preflight.sh', timeoutSeconds: 10 },
          scope: { writable: ['docs/**'], protected: [] },
          upstreams: [],
          verification: { localChecks: [{ id: 'nc', implementation: 'no-change.v1' }], externalGates: [] },
        },
      });
      await writeFile(join(root, '.loopwright', 'taskpack.yaml'), omittedTriggersYaml, 'utf8');
      execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' });
      const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

      for (const [idx, eventName] of ['schedule', 'workflow_dispatch', 'release', 'repository_dispatch', 'issue_comment'].entries()) {
        const res = await runGitHubActionEntrypoint({
          repositoryRoot: root,
          repositoryFullName: 'octocat/target',
          baseRevision: headSha,
          mode: 'candidate',
          eventName,
          ...(eventName === 'issue_comment'
            ? {
              eventPayload: {
                action: 'created',
                issue: { number: 1, pull_request: { number: 1, head: { sha: headSha } } },
                comment: { id: 10, body: '/loopwright retry', author_association: 'OWNER', user: { login: 'octocat', type: 'User' } },
              },
            }
            : {}),
          runRoot,
          runId: `omit-trig-${idx}`,
        });
        assert.equal(res.kind, 'refused', `expected refused for ${eventName}, got ${JSON.stringify(res)}`);
        if (res.kind === 'refused') {
          assert.equal(res.code, 'TASKPACK_TRIGGER_UNSUPPORTED');
        }
      }

      // 2) Manifest enabling only workflowDispatch + commentCommands: ['status'] refuses schedule, release, and /loopwright retry before preflight,
      //    while enabled workflow_dispatch reaches preflight (returning PREFLIGHT_EXECUTED_SENTINEL)!
      const selectiveTriggersYaml = serializeTaskpackYaml({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'Taskpack',
        metadata: { name: 'selective-triggers' },
        spec: {
          goal: { candidate: 'Update docs.', noChange: 'Confirm no change.' },
          preflight: { script: '.loopwright/scripts/preflight.sh', timeoutSeconds: 10 },
          scope: { writable: ['docs/**'], protected: [] },
          upstreams: [],
          verification: { localChecks: [{ id: 'nc', implementation: 'no-change.v1' }], externalGates: [] },
          triggers: {
            schedule: false,
            workflowDispatch: true,
            releasePublished: false,
            commentCommands: ['status'],
          },
          models: [{ provider: 'openai', id: 'gpt-4.1-mini', apiKeyEnv: 'OPENAI_API_KEY' }],
        },
      });
      await writeFile(join(root, '.loopwright', 'taskpack.yaml'), selectiveTriggersYaml, 'utf8');
      execFileSync('git', ['add', '.loopwright/taskpack.yaml'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'selective triggers'], { cwd: root, stdio: 'ignore' });
      const selectiveSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

      for (const [idx, badEvent] of [
        { eventName: 'schedule' },
        { eventName: 'release', eventPayload: { action: 'published' } },
        {
          eventName: 'issue_comment',
          eventPayload: {
            action: 'created',
            issue: { number: 2, pull_request: { number: 2, head: { sha: selectiveSha } } },
            comment: { id: 11, body: '/loopwright retry', author_association: 'OWNER', user: { login: 'octocat', type: 'User' } },
          },
        },
      ].entries()) {
        const res = await runGitHubActionEntrypoint({
          repositoryRoot: root,
          repositoryFullName: 'octocat/target',
          baseRevision: selectiveSha,
          mode: 'candidate',
          eventName: badEvent.eventName,
          eventPayload: badEvent.eventPayload,
          runRoot,
          runId: `disabled-trig-${idx}`,
        });
        assert.equal(res.kind, 'refused');
        if (res.kind === 'refused') {
          assert.equal(res.code, 'TASKPACK_TRIGGER_UNSUPPORTED');
        }
      }

      const enabledPreflightRes = await runGitHubActionEntrypoint({
        repositoryRoot: root,
        repositoryFullName: 'octocat/target',
        baseRevision: selectiveSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'enabled-trig-sentinel',
      });
      assert.equal(enabledPreflightRes.kind, 'blocked');
      if (enabledPreflightRes.kind === 'blocked') {
        assert.equal(enabledPreflightRes.detail, 'PREFLIGHT_EXECUTED_SENTINEL');
      }

      // 3) Enabled workflow_dispatch executes turnkey cycle and persists hostPolicy: { policyProfile: 'github', allowWorkflowWrites: false }
      //    across interrupted recovery (resumeCycleWithPorts with mismatched policyProfile: 'local' fails closed with RECOVERY_REQUIRED)
      const fastAdapter = createFastTurnkeyAdapter();
      let llmCalls = 0;
      const mockLlm = await startHttpServer((_req, res) => {
        llmCalls += 1;
        if (llmCalls === 1) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(sseToolCalls('gpt-4.1-mini', 't1', [{
            id: 'call-wf',
            name: 'write',
            args: { path: 'docs/guide.md', content: '# Guide v2\n' },
          }]));
          return;
        }
        res.destroy();
      });
      try {
        await writeFile(
          join(root, '.loopwright', 'scripts', 'preflight.sh'),
          '#!/bin/sh\nprintf \'{"disposition":"candidate"}\' > "$LOOPWRIGHT_PREFLIGHT_OUT"\n',
          { mode: 0o755 },
        );
        const persistedYaml = serializeTaskpackYaml({
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'Taskpack',
          metadata: { name: 'selective-triggers' },
          spec: {
            goal: { candidate: 'Update docs.', noChange: 'Confirm no change.' },
            preflight: { script: '.loopwright/scripts/preflight.sh', timeoutSeconds: 10 },
            scope: { writable: ['docs/**'], protected: [] },
            proposal: { path: 'docs/status.json', requiredFields: ['ok'], schemaVersion: 1 },
            upstreams: [],
            verification: {
              localChecks: [
                { id: 'doc-json', implementation: 'json-artifact.v1' },
              ],
              externalGates: [],
            },
            triggers: {
              schedule: false,
              workflowDispatch: true,
              releasePublished: false,
              commentCommands: ['status'],
            },
            models: [{
              provider: 'openai',
              id: 'gpt-4.1-mini',
              api: 'openai-completions',
              apiKeyEnv: 'OPENAI_API_KEY',
              baseUrl: `${mockLlm.url}/v1`,
              cost: { input: 1, output: 2 },
            }],
          },
        });
        await writeFile(join(root, '.loopwright', 'taskpack.yaml'), persistedYaml, 'utf8');
        execFileSync('git', ['add', '.loopwright/taskpack.yaml', '.loopwright/scripts/preflight.sh'], { cwd: root, stdio: 'ignore' });
        execFileSync('git', ['commit', '-m', 'persisted github policy'], { cwd: root, stdio: 'ignore' });
        const persistedSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

        const runId = 'github-persisted-policy';
        let interruptedOnce = false;
        const crashingAdapter: typeof fastAdapter = async (host, adapterInput, extra) => {
          const opened = await fastAdapter(host, adapterInput, extra);
          if (!opened.ok) return opened;
          return {
            ok: true,
            value: {
              ...opened.value,
              execute: async execInput => {
                if (!interruptedOnce) {
                  interruptedOnce = true;
                  throw new Error('simulated crash mid-turn');
                }
                return opened.value.execute(execInput);
              },
            },
          };
        };

        const crashRes = await runGitHubActionEntrypoint({
          turnkey: true,
          allowManifestCustomBaseUrl: true,
          repositoryRoot: root,
          repositoryId: 77,
          repositoryFullName: 'octocat/target',
          baseRevision: persistedSha,
          mode: 'candidate',
          eventName: 'workflow_dispatch',
          runRoot,
          runId,
          env: { OPENAI_API_KEY: 'sk-test-github-policy-key' },
          openHostSessionAdapter: crashingAdapter,
        });
        assert.equal(crashRes.kind, 'compiled', JSON.stringify(crashRes));
        if (crashRes.kind === 'compiled') {
          assert.equal(crashRes.delegateOutcome?.ok, false, JSON.stringify(crashRes.delegateOutcome));
        }

        const runRootEntries = await readdir(runRoot);
        assert.equal(runRootEntries.includes(runId), true, `expected ${runId} in [${runRootEntries.join(',')}], detail=${crashRes.kind === 'compiled' ? crashRes.delegateOutcome?.detail : ''}`);

        const runJson = JSON.parse(await readFile(join(runRoot, runId, 'run.json'), 'utf8')) as {
          hostPolicy?: { policyProfile?: string; allowWorkflowWrites?: boolean };
        };
        assert.deepEqual(runJson.hostPolicy, { policyProfile: 'github', allowWorkflowWrites: false });

        const entries = await readdir(runRoot);
        const actionDirName = entries.find(name => name.startsWith('lw-action-'))!;
        const configPath = join(runRoot, actionDirName, 'config', 'config.yaml');
        const registryPath = join(runRoot, actionDirName, 'registry', 'registry.yaml');
        const registryBytes = await readFile(registryPath);
        const { createHash } = await import('node:crypto');
        const registrySha256 = createHash('sha256').update(registryBytes).digest('hex');

        const prevKey = process.env['OPENAI_API_KEY'];
        process.env['OPENAI_API_KEY'] = 'sk-test-github-policy-key';
        try {
          const loaded = await loadTrustedConfiguration({
            configPath,
            registryPath,
            registrySha256,
            untrustedRoots: [root],
          });
          assert.equal(loaded.ok, true);
          if (loaded.ok) {
            const mismatchedResume = await resumeCycleWithPorts(
              { configuration: loaded.value, repository: root, runRoot, runId },
              { policyProfile: 'local' },
            );
            assert.equal(mismatchedResume.ok, false);
            if (!mismatchedResume.ok) {
              assert.equal(mismatchedResume.error.code, 'RECOVERY_REQUIRED');
            }
          }
        } finally {
          if (prevKey === undefined) delete process.env['OPENAI_API_KEY'];
          else process.env['OPENAI_API_KEY'] = prevKey;
        }
      } finally {
        await mockLlm.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(runRoot, { recursive: true, force: true });
    }
  });

  it('enforces policyProfile: github and pre-enqueue spec.triggers on startGitHubAppControlPlane while keeping installation revocations unconditional', async () => {
    const broker = new InstallationTokenBroker({
      appId: 1234,
      privateKeyPem: PRIVATE_KEY_PEM,
      nowSeconds: () => 1_700_000_000,
      transport: {
        createInstallationToken: async () => ({
          token: 'ghs_trig_gate_tok_0000000000000001',
          expiresAtMs: 1_700_003_600_000,
        }),
      },
    });

    // Rejects manifest with .github/CODEOWNERS in writable when passed to startGitHubAppControlPlane
    const unvalidatedGithubWriteManifest = validateTaskpackFromPkg({
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'Taskpack',
      metadata: { name: 'bad-gh-scope' },
      spec: {
        goal: { candidate: 'Sync', noChange: 'None' },
        scope: { writable: ['.github/CODEOWNERS'], protected: [] },
        upstreams: [],
        verification: { localChecks: [{ id: 'nc', implementation: 'no-change.v1' }], externalGates: [] },
      },
    }, { policyProfile: 'local' });

    await assert.rejects(
      () => startGitHubAppControlPlane({
        port: 0,
        webhookSecret: SECRET,
        tokenBroker: broker,
        manifest: unvalidatedGithubWriteManifest,
      }),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_SCOPE_VIOLATION',
    );

    // Manifest with omitted spec.triggers ignores schedule, workflow_dispatch, release, and issue_comment BEFORE queue.enqueue,
    // while installation / installation_repositories revocation webhooks still execute unconditionally!
    const omittedTriggersManifest = validateTaskpackFromPkg({
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'Taskpack',
      metadata: { name: TASKPACK_ID },
      spec: {
        goal: { candidate: 'Sync', noChange: 'None' },
        scope: { writable: ['docs/**'], protected: [] },
        upstreams: [],
        verification: { localChecks: [{ id: 'nc', implementation: 'no-change.v1' }], externalGates: [] },
      },
    }, { policyProfile: 'github' });

    const queue = new TenantAdmissionQueue();
    const handle = await startGitHubAppControlPlane({
      port: 0,
      webhookSecret: SECRET,
      tokenBroker: broker,
      queue,
      manifest: omittedTriggersManifest,
      baseRevision: BASE_REVISION,
    });
    try {
      for (const [idx, delivery] of [
        { event: 'schedule', payload: { installation: { id: TENANT.installationId }, repository: { id: TENANT.repositoryId, full_name: TENANT.repositoryFullName } } },
        { event: 'workflow_dispatch', payload: { installation: { id: TENANT.installationId }, repository: { id: TENANT.repositoryId, full_name: TENANT.repositoryFullName } } },
        { event: 'release', payload: { action: 'published', installation: { id: TENANT.installationId }, repository: { id: TENANT.repositoryId, full_name: TENANT.repositoryFullName } } },
        { event: 'repository_dispatch', payload: { installation: { id: TENANT.installationId }, repository: { id: TENANT.repositoryId, full_name: TENANT.repositoryFullName } } },
        { event: 'issue_comment', payload: commentPayload() },
      ].entries()) {
        const raw = JSON.stringify(delivery.payload);
        const res = await post(handle, '/webhooks/github', raw, {
          'x-hub-signature-256': sign(raw),
          'x-github-event': delivery.event,
          'x-github-delivery': `delivery-trig-omit-000${idx}`,
        });
        assert.equal(res.status, 200, `expected 200 ignored for ${delivery.event}, got ${res.status}: ${JSON.stringify(res.body)}`);
        assert.equal(res.body['kind'], 'ignored');
        assert.equal(queue.inspectTenantQueue(TENANT).counts.pending, 0, `${delivery.event} must NOT enqueue when spec.triggers omits it`);
      }

      // Lifecycle revocation webhooks remain unconditional even when all triggers are disabled
      queue.enqueue(TENANT, { kind: 'discover', baseRevision: BASE_REVISION });
      assert.equal(queue.inspectTenantQueue(TENANT).counts.pending, 1);
      const revokeRaw = JSON.stringify({ action: 'suspend', installation: { id: TENANT.installationId } });
      const revokeRes = await post(handle, '/webhooks/github', revokeRaw, {
        'x-hub-signature-256': sign(revokeRaw),
        'x-github-event': 'installation',
        'x-github-delivery': 'delivery-trig-revoke-0001',
      });
      assert.equal(revokeRes.status, 202);
      assert.equal(revokeRes.body['kind'], 'revoked');
      assert.equal(revokeRes.body['cancelled'], 1);
      assert.equal(queue.inspectTenantQueue(TENANT).counts.pending, 0);
    } finally {
      await handle.close();
    }
  });

  it('ignores actionable triggers without enqueueing when startGitHubAppControlPlane omits options.manifest', async () => {
    const queue = new TenantAdmissionQueue();
    const unconfigured = await startGitHubAppControlPlane({
      port: 0,
      webhookSecret: SECRET,
      taskpackId: TASKPACK_ID,
      baseRevision: BASE_REVISION,
      queue,
    });
    try {
      const body = JSON.stringify(commentPayload());
      const res = await post(unconfigured, '/webhooks/github', body, {
        'x-hub-signature-256': sign(body),
        'x-github-event': 'issue_comment',
        'x-github-delivery': 'delivery-unconf-0001',
      });
      assert.equal(res.status, 200);
      assert.equal(res.body['kind'], 'ignored');
      assert.equal(res.body['code'], 'TASKPACK_TRIGGER_UNSUPPORTED');
      assert.equal(queue.inspectTenantQueue(TENANT).counts.pending, 0);
    } finally {
      await unconfigured.close();
    }
  });
});
