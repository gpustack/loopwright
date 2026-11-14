import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { evaluateCommentPayload, runActionCli, runGitHubActionEntrypoint } from '../src/action.js';
import { startGitHubAppControlPlane, type ControlPlaneOptions } from '../src/service.js';
import { compilePlan, loadTrustedConfiguration } from '@loopwright/controller';
import { dirname } from 'node:path';
import { stat } from 'node:fs/promises';
import { InstallationTokenBroker } from '../src/token-broker.js';
import { TenantAdmissionQueue } from '../src/tenant-queue.js';
import type { InstallationTokenRequest, TenantIdentity } from '../src/types.js';
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
      - docs
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
  const options: ControlPlaneOptions = {
    port: 0, webhookSecret: SECRET, tokenBroker: broker, taskpackId: TASKPACK_ID, baseRevision: BASE_REVISION,
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
    assert.match(actionYml, /value: \$\{\{ steps\.loopwright-entrypoint\.outputs\.total-tokens \}\}/);
    assert.match(actionYml, /value: \$\{\{ steps\.loopwright-entrypoint\.outputs\.cost-usd \}\}/);
    assert.match(actionYml, /INPUT_OUTPUT: \$\{\{ inputs\.output \}\}/);
    assert.match(actionYml, /INPUT_GITHUB-TOKEN: \$\{\{ inputs\.github-token \}\}/);
    assert.match(actionYml, /INPUT_UPSTREAM-RECORDS: \$\{\{ inputs\.upstream-records \}\}/);

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
});
