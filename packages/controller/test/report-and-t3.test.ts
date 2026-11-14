import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SecretScrubber,
  bindSubject,
  digestArtifact,
  identifyManifest,
  type TaskContract,
  type UsageSummary,
} from '@loopwright/core';
import type { PiAdapterV2, PiErrorV2, PiHostV2, PiOpenInputV2, PiOutcomeV2 } from '@loopwright/agent-pi';
import {
  REPORT_OUTPUT_FORMATS,
  formatCostUsd,
  formatRunReport,
  inspectRun,
  parseReportOutputFormats,
  runCycleWithPorts,
  sanitizeReportText,
  type ReportOutputFormat,
} from '../src/index.js';
import { ControllerFailure } from '../src/errors.js';
import { GIT_ENVIRONMENT } from '../src/git-reader.js';
import { signPayload, verifySignedPayload } from '../src/gate.js';
import { installedHandlerDigests } from '../src/handlers.js';
import { canonical, hash } from '../src/schema.js';
import { freezeSource } from '../src/source.js';
import { stateValue } from '../src/storage.js';
import { configurationFixture } from './config-fixtures.js';
import { retainedFixture, setFixture } from './progress-fixtures.js';

const GATE_SECRET = 'T3_GATE_SECRET_CANARY_Aa11Bb22Cc33';
const PUBLISHER_SECRET = 'T3_PUB_SECRET_CANARY_Dd44Ee55Ff66';
const PUBLISHER_TOKEN = 'T3_PUB_TOKEN_CANARY_Gg77Hh88Ii99';

async function gitRepoFixture(f: Awaited<ReturnType<typeof retainedFixture>>) {
  const intent = join(f.directory, 'git-fixture-commands.ndjson');
  const repository = f.taskDirectory;
  const git = async (args: string[], input?: Uint8Array): Promise<Buffer> => {
    await appendFile(intent, canonical({ type: 'intent', args, inputDigest: input ? hash(input) : null }) + '\n', { mode: 0o600 });
    const output = execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', repository, ...args], {
      env: {
        ...GIT_ENVIRONMENT,
        GIT_AUTHOR_NAME: 'Controller Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@invalid',
        GIT_COMMITTER_NAME: 'Controller Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@invalid',
        GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
      },
      input,
      timeout: 10000,
      maxBuffer: 1048576,
    });
    await appendFile(intent, canonical({ type: 'exit', args, code: 0, outputDigest: hash(output) }) + '\n');
    return output;
  };
  await git(['init', '--template=', '--initial-branch=main']);
  const blob = async (bytes: Uint8Array) => (await git(['hash-object', '-w', '--stdin'], bytes)).toString().trim();
  const tree = async (entries: { mode: string; type: string; oid: string; name: string }[]) =>
    (await git(['mktree', '-z', '--missing'], Buffer.from(entries.map(row => `${row.mode} ${row.type} ${row.oid}\t${row.name}\0`).join('')))).toString().trim();
  const commit = async (treeOid: string, ref = 'refs/heads/source') => {
    const oid = (await git(['commit-tree', treeOid], Buffer.from('trusted inert fixture\n'))).toString().trim();
    await git(['update-ref', ref, oid]);
    return oid;
  };
  const task = (oid: string, protectedScope: readonly string[]): TaskContract => ({
    ...f.plan.task,
    spec: {
      ...f.plan.task.spec,
      scope: { ...f.plan.task.spec.scope, protected: [...protectedScope] },
      target: { ...f.plan.task.spec.target, baseRevision: oid, sourceRevision: 'refs/heads/source' },
    },
  });
  return { blob, tree, commit, task };
}

test('freezeSource skips protected 120000 symlinks and excludes them from the 256 regular-file cap', async () => {
  const f = await retainedFixture();
  try {
    const r = await gitRepoFixture(f);
    const linkTarget = await r.blob(Buffer.from('../../shared/skill'));
    const fileBlob = await r.blob(Buffer.from('export const ok = true;\n'));
    const subTree = await r.tree([
      { mode: '120000', type: 'blob', oid: linkTarget, name: 'link' },
    ]);
    const claudeTree = await r.tree([
      { mode: '040000', type: 'tree', oid: subTree, name: 'skills' },
    ]);
    const loopwrightTree = await r.tree([
      { mode: '120000', type: 'blob', oid: linkTarget, name: 'link' },
    ]);
    const rootTree = await r.tree([
      { mode: '040000', type: 'tree', oid: claudeTree, name: '.claude' },
      { mode: '040000', type: 'tree', oid: loopwrightTree, name: '.loopwright' },
      { mode: '100644', type: 'blob', oid: fileBlob, name: 'src.ts' },
    ]);
    const oid = await r.commit(rootTree);
    const frozen = await freezeSource(
      f.taskDirectory,
      r.task(oid, ['.claude/**', '.loopwright/**']),
      f.owner,
      f.artifacts,
    );
    assert.deepEqual(frozen.artifacts.map(item => item.name), ['src.ts']);
    assert.deepEqual(frozen.manifest.spec.entries.map(item => item.name), ['src.ts']);

    // 200 regular files + 60 protected symlinks = 260 raw tree rows (> 256 cap unless protected symlinks are skipped)
    const crowdedEntries = Array.from({ length: 200 }, (_, index) => ({
      mode: '100644',
      type: 'blob',
      oid: fileBlob,
      name: 'f' + String(index).padStart(3, '0'),
    }));
    const protectedSymlinks = await r.tree(
      Array.from({ length: 60 }, (_, index) => ({
        mode: '120000',
        type: 'blob',
        oid: linkTarget,
        name: 's' + String(index).padStart(2, '0'),
      })),
    );
    const crowdedRoot = await r.tree([
      { mode: '040000', type: 'tree', oid: protectedSymlinks, name: '.claude' },
      ...crowdedEntries,
    ]);
    const crowdedOid = await r.commit(crowdedRoot);
    const crowdedFrozen = await freezeSource(
      f.taskDirectory,
      r.task(crowdedOid, ['.claude/**']),
      f.owner,
      f.artifacts,
    );
    assert.equal(crowdedFrozen.artifacts.length, 200);
    assert.equal(crowdedFrozen.manifest.spec.entries.some(item => item.name.startsWith('.claude/')), false);
  } finally {
    await f.close();
  }
});

test('freezeSource still refuses unprotected 120000 symlinks with CAPABILITY_UNSUPPORTED after 4 git intents', async () => {
  const f = await retainedFixture();
  try {
    const r = await gitRepoFixture(f);
    const blob = await r.blob(Buffer.from('inert'));
    const base = await r.commit(await r.tree([{ mode: '100644', type: 'blob', oid: blob, name: 'base.ts' }]));
    await r.commit(await r.tree([
      { mode: '100644', type: 'blob', oid: blob, name: 'base.ts' },
      { mode: '120000', type: 'blob', oid: blob, name: 'unprotected-link' },
    ]));
    const before = (await readFile(f.owner.path, 'utf8')).split('\n').length;
    await assert.rejects(
      freezeSource(f.taskDirectory, r.task(base, ['.claude/**']), f.owner, f.artifacts),
      (error: unknown) =>
        error instanceof ControllerFailure &&
        error.diagnostic.code === 'CAPABILITY_UNSUPPORTED' &&
        error.diagnostic.phase === 'admission',
    );
    const rows = (await readFile(f.owner.path, 'utf8'))
      .trim()
      .split('\n')
      .slice(before - 1)
      .map(line => JSON.parse(line) as { type: string });
    assert.equal(rows.filter(row => row.type === 'intent').length, 4);
  } finally {
    await f.close();
  }
});

test('freezeSource refuses a 160000 submodule under a protected path with CAPABILITY_UNSUPPORTED', async () => {
  const f = await retainedFixture();
  try {
    const r = await gitRepoFixture(f);
    const fileBlob = await r.blob(Buffer.from('export const ok = true;\n'));
    const subCommit = await r.commit(
      await r.tree([{ mode: '100644', type: 'blob', oid: fileBlob, name: 'nested.ts' }]),
      'refs/heads/submodule',
    );
    const protectedTree = await r.tree([
      { mode: '160000', type: 'commit', oid: subCommit, name: 'sub' },
    ]);
    const rootTree = await r.tree([
      { mode: '040000', type: 'tree', oid: protectedTree, name: '.claude' },
      { mode: '100644', type: 'blob', oid: fileBlob, name: 'src.ts' },
    ]);
    const oid = await r.commit(rootTree);
    await assert.rejects(
      freezeSource(f.taskDirectory, r.task(oid, ['.claude/**']), f.owner, f.artifacts),
      (error: unknown) =>
        error instanceof ControllerFailure &&
        error.diagnostic.code === 'CAPABILITY_UNSUPPORTED' &&
        error.diagnostic.phase === 'admission',
    );
  } finally {
    await f.close();
  }
});

test('freezeSource refuses > 4 MiB regular files alongside protected symlinks with CONFIG_LIMIT', async () => {
  const f = await retainedFixture();
  try {
    const r = await gitRepoFixture(f);
    const linkTarget = await r.blob(Buffer.from('../../shared/skill'));
    const largeBlob = await r.blob(Buffer.alloc(2 * 1024 * 1024 + 10, 0x61));
    const protectedTree = await r.tree([
      { mode: '120000', type: 'blob', oid: linkTarget, name: 'link' },
    ]);
    const rootTree = await r.tree([
      { mode: '040000', type: 'tree', oid: protectedTree, name: '.claude' },
      { mode: '100644', type: 'blob', oid: largeBlob, name: 'big-a.bin' },
      { mode: '100644', type: 'blob', oid: largeBlob, name: 'big-b.bin' },
    ]);
    const oid = await r.commit(rootTree);
    await assert.rejects(
      freezeSource(f.taskDirectory, r.task(oid, ['.claude/**']), f.owner, f.artifacts),
      (error: unknown) =>
        error instanceof ControllerFailure &&
        error.diagnostic.code === 'CONFIG_LIMIT' &&
        error.diagnostic.phase === 'admission',
    );
  } finally {
    await f.close();
  }
});

function createMockRolePort(options: {
  readonly onExecute: (callIndex: number, text: string, repair: 'none' | 'format' | 'implementation') => {
    readonly resultJson: Record<string, unknown>;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly costMicrousd?: { readonly provenance: 'reported' | 'estimated'; readonly value: number } | { readonly provenance: 'unknown' };
  };
}) {
  let callIndex = 0;
  const cancelledError: PiErrorV2 = {
    code: 'CANCELLED',
    phase: 'session',
    path: '',
    retryable: false,
    effect: 'none',
    requestId: null,
    operationId: null,
    stateErrorCode: null,
  };
  const cancelledOutcome: PiOutcomeV2 = {
    status: 'cancelled',
    requestIds: [],
    operationIds: [],
    providerTermination: 'none',
    usage: 'none',
    localCleanup: 'complete',
    error: cancelledError,
    cleanupError: null,
  };

  return async (host: PiHostV2, input: PiOpenInputV2) => {
    let lastCommandText = '';
    let lastPlanResult: ReturnType<typeof options.onExecute> | null = null;
    let lastRequestId = '';
    let lastOperationId = '';

    const adapter: PiAdapterV2 = {
      capabilities: () => {
        throw new Error('not needed in mock adapter');
      },
      execute: async command => {
        callIndex++;
        lastCommandText = command.text;
        lastPlanResult = options.onExecute(callIndex, command.text, command.repair);
        lastRequestId = 'mock-req-' + callIndex;
        lastOperationId = 'mock-op-' + callIndex;
        const inputTokens = lastPlanResult.inputTokens ?? 120;
        const outputTokens = lastPlanResult.outputTokens ?? 30;
        const costMicrousd = lastPlanResult.costMicrousd ?? { provenance: 'estimated', value: 12500 };

        stateValue(
          host.store.reserveRequest(host.authority, {
            requestId: lastRequestId,
            roleId: input.roleId,
            nodeId: input.stepId,
            attemptId: command.commandId,
            purpose: command.purpose,
            repair: command.repair,
            transportRetryOf: null,
            requestDigest: hash(command.text),
            inputUpperBound: inputTokens + 100,
            outputUpperBound: outputTokens + 100,
            totalUpperBound: inputTokens + outputTokens + 200,
            capability: {
              adapterId: 'pi',
              adapterVersion: '0.0.0',
              provider: input.policy.selection.provider,
              model: input.policy.selection.model,
              kind: 'soft_only',
              coversAllBillableTokens: false,
              enforcesOutputBound: false,
            },
            operationId: lastOperationId,
            targetIdentity: 'fixture:mock-provider',
          }),
        );
        stateValue(host.store.authorizeRequestDispatch(host.authority, lastRequestId));
        const op = stateValue(host.store.getOperation(lastOperationId));
        const view = stateValue(host.store.inspect());
        const usageArtifactBytes = Buffer.from(canonical({ inputTokens, outputTokens }));
        const usageArtifactName = `mock-usage-${callIndex}.bin`;
        const usageArtifactRef = digestArtifact(usageArtifactName, usageArtifactBytes);
        if (!usageArtifactRef.ok) throw new Error('usage artifact ref failed');
        await writeFile(join(host.artifactsDirectory, usageArtifactName), usageArtifactBytes, { mode: 0o600 });

        stateValue(
          host.store.observeRequest(host.authority, lastRequestId, {
            receiptId: 'mock-receipt-' + callIndex,
            termination: 'confirmed',
            outcome: 'succeeded',
            evidence: {
              evidenceId: 'mock-evidence-' + callIndex,
              producerId: 'mock-pi',
              method: 'mock-sse',
              artifact: usageArtifactRef.value,
              subject: {
                storeId: view.storeId,
                runId: view.runId,
                lockHash: view.lockHash,
                operationId: lastOperationId,
                requestId: lastRequestId,
                intentDigest: op.intentDigest,
                dispatchGeneration: op.dispatch!.generation,
                dispatchId: op.dispatch!.dispatchId,
              },
            },
            usage: {
              requestId: lastRequestId,
              inputTokens: { provenance: 'reported', value: inputTokens },
              outputTokens: { provenance: 'reported', value: outputTokens },
              costMicrousd,
            },
          }),
        );

        return {
          ok: true,
          value: {
            status: 'execution_settled',
            requestIds: [lastRequestId],
            operationIds: [],
            providerTermination: 'confirmed',
            usage: 'complete',
            localCleanup: 'complete',
            error: null,
            cleanupError: null,
          },
        };
      },
      compact: async () => ({
        ok: false,
        error: cancelledError,
      }),
      events: () => ({
        async *[Symbol.asyncIterator]() {
          yield* [];
        },
      }),
      cancel: async () => ({ ok: true, value: cancelledOutcome }),
      capture: async ({ checkpointId }) => {
        const fileBytes = Buffer.from(JSON.stringify(lastPlanResult!.resultJson));
        const fileRef = digestArtifact('result.json', fileBytes);
        if (!fileRef.ok) throw new Error('fileRef failed');
        const identified = identifyManifest({
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'ArtifactManifest',
          metadata: { id: 'candidate' },
          spec: { entries: [fileRef.value] },
        });
        if (!identified.ok) throw new Error('manifest failed');
        const candidateManifest = identified.value.manifest;
        const subject = bindSubject(input.lock, candidateManifest);
        if (!subject.ok) throw new Error('subject failed');

        const current = stateValue(host.store.inspect());
        const sourceDigest = hash('loopwright.dev/pi-policy/v2\0' + canonical(input.policy));
        const nativePolicy = { ...input.policy, version: 1, policyId: 'v2.' + BigInt('0x' + sourceDigest.hex).toString(36) };
        const binding = {
          version: 1,
          checkpointId,
          storeId: current.storeId,
          runId: current.runId,
          lockHash: current.lockHash,
          sessionId: input.sessionId,
          roleId: input.roleId,
          stepId: input.stepId,
          runtime: input.policy.runtime,
          policyDigest: hash(canonical(nativePolicy)),
          resourcesDigest: hash(canonical(input.policy.resources)),
          candidateDigest: subject.value.candidateDigest,
          clockBasis: current.clock.basis,
          accountingDigest: hash(
            canonical({
              ledger: current.ledger,
              requests: current.counts.requests,
              operations: current.counts.operations,
            }),
          ),
          sequence: 1,
        };
        const line = (value: unknown) => JSON.stringify(value) + '\n';
        const workspaceBytes = Buffer.from(
          line({ type: 'workspace_snapshot', version: 1, binding, manifest: candidateManifest }) +
            line({ type: 'file', ref: fileRef.value }) +
            line({ type: 'chunk', index: 0, data: fileBytes.toString('base64') }) +
            line({ type: 'file_end', byteLength: fileBytes.byteLength, digest: hash(fileBytes).hex }) +
            line({ type: 'end', files: 1 }),
        );
        const workspaceName = `mock-ws-${callIndex}.bin`;
        const workspaceRef = digestArtifact(workspaceName, workspaceBytes);
        if (!workspaceRef.ok) throw new Error('workspaceRef failed');
        await writeFile(join(host.artifactsDirectory, workspaceName), workspaceBytes, { mode: 0o600 });

        const timestamp = '2026-11-13T00:00:00.000Z';
        const submissionText = JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null });
        const sessionBytes = Buffer.from(
          line({ type: 'session_snapshot', version: 1, binding }) +
            [
              { type: 'session', version: 3, id: 'mock_native_' + callIndex, cwd: '/workspace/candidate', timestamp },
              { type: 'message', id: 'u1', parentId: null, timestamp, message: { role: 'user', content: lastCommandText } },
              {
                type: 'message',
                id: 'a1',
                parentId: 'u1',
                timestamp,
                message: {
                  role: 'assistant',
                  ...input.policy.selection,
                  content: [{ type: 'text', text: submissionText }],
                  stopReason: 'stop',
                },
              },
            ]
              .map(line)
              .join(''),
        );
        const sessionName = `mock-sess-${callIndex}.bin`;
        const sessionRef = digestArtifact(sessionName, sessionBytes);
        if (!sessionRef.ok) throw new Error('sessionRef failed');
        await writeFile(join(host.artifactsDirectory, sessionName), sessionBytes, { mode: 0o600 });

        stateValue(host.store.renew(host.authority));
        const now = stateValue(host.store.inspect());
        stateValue(
          host.store.writeCheckpoint(host.authority, {
            checkpointId,
            expectedRevision: now.revision,
            candidateManifest,
            workspace: workspaceRef.value,
            privateSession: sessionRef.value,
            additionalArtifacts: [],
          }),
        );

        return {
          ok: true,
          value: {
            checkpointId,
            candidate: candidateManifest,
            workspace: workspaceRef.value,
            session: sessionRef.value,
          },
        };
      },
      close: async () => ({ ok: true, value: { closed: true } }),
    };
    return { ok: true as const, value: adapter };
  };
}

function startMockGateServer(script: (attempt: number) => { readonly status: 'approved' | 'denied'; readonly reason: string | null }) {
  return new Promise<{ readonly url: string; readonly hits: () => number; readonly close: () => Promise<void> }>(resolve => {
    let hits = 0;
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks);
        const signature = request.headers['x-loopwright-signature'];
        if (typeof signature !== 'string' || !verifySignedPayload(GATE_SECRET, body, signature)) {
          response.writeHead(403).end();
          return;
        }
        const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
        const verdictInput = script(++hits);
        const verdict = {
          version: 1,
          kind: 'gate_verdict',
          storeId: parsed.storeId,
          runId: parsed.runId,
          lockHash: parsed.lockHash,
          operationId: parsed.operationId,
          dispatchId: parsed.dispatchId,
          dispatchGeneration: parsed.dispatchGeneration,
          gateId: parsed.gateId,
          checkId: parsed.checkId,
          candidateDigest: parsed.candidateDigest,
          status: verdictInput.status,
          reason: verdictInput.reason,
          expiresAtMs: String(Date.now() + 600000),
        };
        const bytes = Buffer.from(JSON.stringify(verdict));
        response.writeHead(200, {
          'content-type': 'application/json',
          connection: 'close',
          'x-loopwright-signature': signPayload(GATE_SECRET, bytes),
        });
        response.end(bytes);
      })().catch(() => {
        try {
          response.writeHead(500).end();
        } catch {
          /* socket closed */
        }
      });
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({
        hits: () => hits,
        url: 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/gate',
        close: () =>
          new Promise((done, fail) => {
            server.closeAllConnections();
            server.close(error => (error ? fail(error) : done()));
          }),
      }),
    );
  });
}

function startMockPublicationServer(externalUrl: string | null) {
  return new Promise<{ readonly url: string; readonly close: () => Promise<void> }>(resolve => {
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks);
        const signature = request.headers['x-loopwright-signature'];
        if (typeof signature !== 'string' || !verifySignedPayload(PUBLISHER_SECRET, body, signature)) {
          response.writeHead(403).end();
          return;
        }
        const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
        const receipt = {
          version: 1,
          kind: 'publication_receipt',
          storeId: parsed.storeId,
          runId: parsed.runId,
          lockHash: parsed.lockHash,
          operationId: parsed.operationId,
          dispatchId: parsed.dispatchId,
          dispatchGeneration: parsed.dispatchGeneration,
          idempotencyKey: parsed.idempotencyKey,
          outcome: 'succeeded',
          externalUrl,
          reason: null,
        };
        const bytes = Buffer.from(JSON.stringify(receipt));
        response.writeHead(200, {
          'content-type': 'application/json',
          connection: 'close',
          'x-loopwright-signature': signPayload(PUBLISHER_SECRET, bytes),
        });
        response.end(bytes);
      })().catch(() => {
        try {
          response.writeHead(500).end();
        } catch {
          /* socket closed */
        }
      });
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/publish',
        close: () =>
          new Promise((done, fail) => {
            server.closeAllConnections();
            server.close(error => (error ? fail(error) : done()));
          }),
      }),
    );
  });
}

test('Cycle.implementationRepair includes bounded gate.v1 verdict detail and caps repair prompt at 16 KiB', async () => {
  const expectedReason = 'lint_failed: src/app.ts:12 unexpected token';
  const gate = await startMockGateServer(attempt =>
    attempt === 1 ? { status: 'denied', reason: expectedReason } : { status: 'approved', reason: null },
  );
  const f = await configurationFixture();
  try {
    f.environment.GATE_SECRET = GATE_SECRET;
    setFixture(f.registry, ['spec', 'credentialBindings'], [
      ...f.registry.spec.credentialBindings,
      { id: 'gate-signer', consumer: 'gate', destinationRef: 'gate-service', environmentNames: ['GATE_SECRET'], template: '${GATE_SECRET}' },
    ]);
    setFixture(f.registry, ['spec', 'environmentBindings'], [
      { name: 'PROVIDER_TOKEN', classification: 'credential', paths: ['/spec/credentials/0/template'] },
      { name: 'GATE_SECRET', classification: 'credential', paths: ['/spec/credentials/1/template'] },
    ]);
    setFixture(f.config, ['spec', 'credentials'], [
      { ref: 'copilot', template: '${PROVIDER_TOKEN}' },
      { ref: 'gate-signer', template: '${GATE_SECRET}' },
    ]);
    setFixture(f.registry, ['spec', 'gateEndpoints'], [
      { id: 'ci-gate', url: gate.url, signingCredentialRef: 'gate-signer', authCredentialRef: null, timeoutMs: 1500, maxPollMs: 5000, pollInitialMs: 100, pollMaxMs: 100, jitter: 0 },
    ]);
    const installed = await installedHandlerDigests();
    setFixture(f.registry, ['spec', 'handlers'], [
      ...f.registry.spec.handlers,
      { id: 'approval', kind: 'check', implementation: 'gate.v1', version: 1, digest: installed['gate.v1'], parameters: { checkId: 'approval', endpointRef: 'ci-gate', gateId: 'merge-gate' }, capabilities: ['external_service', 'read_only'] },
    ]);
    setFixture(f.registry, ['spec', 'roleProfiles', 0, 'tools'], ['read', 'write']);
    setFixture(f.config, ['spec', 'task', 'spec', 'scope', 'writable'], ['result.json']);
    setFixture(f.config, ['spec', 'task', 'spec', 'roles', 0, 'tools'], ['read', 'write']);
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxImplementationRepairs'], 1);
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxModelCalls'], 4);
    setFixture(f.config, ['spec', 'controls', 'maxAttempts'], 3);
    setFixture(f.config, ['spec', 'task', 'spec', 'scope', 'writable'], ['result.json']);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'build', kind: 'agent', uses: 'package.patch', roleId: 'builder', dependsOn: [] },
      { id: 'approval', kind: 'check', uses: 'approval', roleId: null, dependsOn: ['build'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'build', handlerRef: 'package.patch' },
      { stepId: 'approval', handlerRef: 'approval' },
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'acceptance'], {
      required: ['approval'],
      checks: [{ id: 'approval', allowedEvidenceLevels: ['external_service'] }],
    });

    const repository = join(f.root, 'repository');
    const runRoot = join(f.root, 'runs');
    await mkdir(repository, { mode: 0o700 });
    const git = (args: string[]) =>
      execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: repository,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: '/nonexistent', GIT_TERMINAL_PROMPT: '0' },
        timeout: 5000,
        encoding: 'utf8',
      });
    git(['init', '-q']);
    await writeFile(join(repository, 'result.json'), JSON.stringify({ ok: false }), { mode: 0o600 });
    git(['add', 'result.json']);
    git(['-c', 'user.name=Controller Fixture', '-c', 'user.email=fixture@localhost.invalid', 'commit', '-qm', 'init']);
    const revision = git(['rev-parse', 'HEAD']).trim();
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], revision);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], revision);
    await f.save();
    const loaded = await f.load();
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;

    const commands: { readonly text: string; readonly repair: string }[] = [];
    const execution = await runCycleWithPorts(
      { configuration: loaded.value, repository, runRoot, runId: 'run-gate-repair-detail' },
      {
        openAdapter: createMockRolePort({
          onExecute: (attempt, text, repair) => {
            commands.push({ text, repair });
            return { resultJson: { ok: true, attempt } };
          },
        }),
      },
    );
    assert.equal(execution.ok, true, JSON.stringify(execution));
    if (!execution.ok) return;
    assert.equal(execution.value.kind, 'result');
    if (execution.value.kind !== 'result') return;
    assert.equal(execution.value.result.spec.status, 'completed');
    assert.equal(commands.length, 2);
    assert.equal(commands[1]!.repair, 'implementation');
    assert.ok(commands[1]!.text.includes(`"detail":"${expectedReason}"`));
    assert.ok(Buffer.byteLength(commands[1]!.text, 'utf8') <= 16384);
  } finally {
    await gate.close();
    await f.cleanup();
  }
});

test('Cycle.implementationRepair enforces the 16 KiB repair prompt byte ceiling when findings are large', async () => {
  const longReason = 'R'.repeat(256);
  const gate = await startMockGateServer(() => ({ status: 'denied', reason: longReason }));
  const f = await configurationFixture();
  try {
    f.environment.GATE_SECRET = GATE_SECRET;
    setFixture(f.registry, ['spec', 'credentialBindings'], [
      ...f.registry.spec.credentialBindings,
      { id: 'gate-signer', consumer: 'gate', destinationRef: 'gate-service', environmentNames: ['GATE_SECRET'], template: '${GATE_SECRET}' },
    ]);
    setFixture(f.registry, ['spec', 'environmentBindings'], [
      { name: 'PROVIDER_TOKEN', classification: 'credential', paths: ['/spec/credentials/0/template'] },
      { name: 'GATE_SECRET', classification: 'credential', paths: ['/spec/credentials/1/template'] },
    ]);
    setFixture(f.config, ['spec', 'credentials'], [
      { ref: 'copilot', template: '${PROVIDER_TOKEN}' },
      { ref: 'gate-signer', template: '${GATE_SECRET}' },
    ]);
    setFixture(f.registry, ['spec', 'gateEndpoints'], [
      { id: 'ci-gate', url: gate.url, signingCredentialRef: 'gate-signer', authCredentialRef: null, timeoutMs: 1500, maxPollMs: 5000, pollInitialMs: 100, pollMaxMs: 100, jitter: 0 },
    ]);
    const installed = await installedHandlerDigests();
    const oversizedKeys1 = Array.from({ length: 64 }, (_, idx) => `k1_${String(idx).padStart(2, '0')}_${'a'.repeat(110)}`);
    const oversizedKeys2 = Array.from({ length: 64 }, (_, idx) => `k2_${String(idx).padStart(2, '0')}_${'b'.repeat(110)}`);
    const oversizedKeys3 = Array.from({ length: 64 }, (_, idx) => `k3_${String(idx).padStart(2, '0')}_${'c'.repeat(110)}`);
    setFixture(f.registry, ['spec', 'handlers'], [
      ...f.registry.spec.handlers,
      { id: 'big-a', kind: 'check', implementation: 'json-artifact.v1', version: 1, digest: installed['json-artifact.v1'], parameters: { checkId: 'big-a', path: 'result.json', required: oversizedKeys1, equals: {} }, capabilities: ['inert_bytes', 'read_only'] },
      { id: 'big-b', kind: 'check', implementation: 'json-artifact.v1', version: 1, digest: installed['json-artifact.v1'], parameters: { checkId: 'big-b', path: 'result.json', required: oversizedKeys2, equals: {} }, capabilities: ['inert_bytes', 'read_only'] },
      { id: 'big-c', kind: 'check', implementation: 'json-artifact.v1', version: 1, digest: installed['json-artifact.v1'], parameters: { checkId: 'big-c', path: 'result.json', required: oversizedKeys3, equals: {} }, capabilities: ['inert_bytes', 'read_only'] },
      { id: 'approval', kind: 'check', implementation: 'gate.v1', version: 1, digest: installed['gate.v1'], parameters: { checkId: 'approval', endpointRef: 'ci-gate', gateId: 'merge-gate' }, capabilities: ['external_service', 'read_only'] },
    ]);
    setFixture(f.registry, ['spec', 'roleProfiles', 0, 'tools'], ['read', 'write']);
    setFixture(f.config, ['spec', 'task', 'spec', 'scope', 'writable'], ['result.json']);
    setFixture(f.config, ['spec', 'task', 'spec', 'roles', 0, 'tools'], ['read', 'write']);
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxImplementationRepairs'], 1);
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxModelCalls'], 4);
    setFixture(f.config, ['spec', 'controls', 'maxAttempts'], 3);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'build', kind: 'agent', uses: 'package.patch', roleId: 'builder', dependsOn: [] },
      { id: 'big-a', kind: 'check', uses: 'big-a', roleId: null, dependsOn: ['build'] },
      { id: 'big-b', kind: 'check', uses: 'big-b', roleId: null, dependsOn: ['build'] },
      { id: 'big-c', kind: 'check', uses: 'big-c', roleId: null, dependsOn: ['build'] },
      { id: 'approval', kind: 'check', uses: 'approval', roleId: null, dependsOn: ['build'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'build', handlerRef: 'package.patch' },
      { stepId: 'big-a', handlerRef: 'big-a' },
      { stepId: 'big-b', handlerRef: 'big-b' },
      { stepId: 'big-c', handlerRef: 'big-c' },
      { stepId: 'approval', handlerRef: 'approval' },
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'acceptance'], {
      required: ['big-a', 'big-b', 'big-c', 'approval'],
      checks: [
        { id: 'big-a', allowedEvidenceLevels: ['local_execution'] },
        { id: 'big-b', allowedEvidenceLevels: ['local_execution'] },
        { id: 'big-c', allowedEvidenceLevels: ['local_execution'] },
        { id: 'approval', allowedEvidenceLevels: ['external_service'] },
      ],
    });

    const repository = join(f.root, 'repository');
    const runRoot = join(f.root, 'runs');
    await mkdir(repository, { mode: 0o700 });
    const git = (args: string[]) =>
      execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: repository,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: '/nonexistent', GIT_TERMINAL_PROMPT: '0' },
        timeout: 5000,
        encoding: 'utf8',
      });
    git(['init', '-q']);
    await writeFile(join(repository, 'result.json'), JSON.stringify({ ok: false }), { mode: 0o600 });
    git(['add', 'result.json']);
    git(['-c', 'user.name=Controller Fixture', '-c', 'user.email=fixture@localhost.invalid', 'commit', '-qm', 'init']);
    const revision = git(['rev-parse', 'HEAD']).trim();
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], revision);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], revision);
    await f.save();
    const loaded = await f.load();
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;

    const commands: { readonly text: string; readonly repair: string }[] = [];
    const execution = await runCycleWithPorts(
      { configuration: loaded.value, repository, runRoot, runId: 'run-gate-repair-cap' },
      {
        openAdapter: createMockRolePort({
          onExecute: (attempt, text, repair) => {
            commands.push({ text, repair });
            return { resultJson: { ok: true, attempt } };
          },
        }),
      },
    );
    assert.equal(execution.ok, true, JSON.stringify(execution));
    if (!execution.ok) return;
    assert.equal(execution.value.kind, 'result', JSON.stringify(execution.value));
    assert.equal(commands.length, 2);
    assert.equal(commands[1]!.repair, 'implementation');
    assert.ok(Buffer.byteLength(commands[1]!.text, 'utf8') <= 16384);
    const findingsJson = commands[1]!.text.split('Findings:\n')[1]!;
    const parsedFindings = JSON.parse(findingsJson) as readonly { readonly checkId: string; readonly detail?: string }[];
    assert.ok(Array.isArray(parsedFindings));
    assert.ok(parsedFindings.length >= 1 && parsedFindings.length < 4);
    assert.deepEqual(
      parsedFindings.map(item => item.checkId),
      ['approval', 'big-a', 'big-b', 'big-c'].slice(0, parsedFindings.length),
    );
    assert.equal(parsedFindings.every(item => item.detail === undefined), true);
  } finally {
    await gate.close();
    await f.cleanup();
  }
});

test('Cycle.implementationRepair strips verdict detail before dropping findings when that suffices under 16 KiB', async () => {
  const longReason = 'R'.repeat(256);
  const gate = await startMockGateServer(attempt =>
    attempt === 1 ? { status: 'denied', reason: longReason } : { status: 'approved', reason: null },
  );
  const f = await configurationFixture();
  try {
    f.environment.GATE_SECRET = GATE_SECRET;
    setFixture(f.registry, ['spec', 'credentialBindings'], [
      ...f.registry.spec.credentialBindings,
      { id: 'gate-signer', consumer: 'gate', destinationRef: 'gate-service', environmentNames: ['GATE_SECRET'], template: '${GATE_SECRET}' },
    ]);
    setFixture(f.registry, ['spec', 'environmentBindings'], [
      { name: 'PROVIDER_TOKEN', classification: 'credential', paths: ['/spec/credentials/0/template'] },
      { name: 'GATE_SECRET', classification: 'credential', paths: ['/spec/credentials/1/template'] },
    ]);
    setFixture(f.config, ['spec', 'credentials'], [
      { ref: 'copilot', template: '${PROVIDER_TOKEN}' },
      { ref: 'gate-signer', template: '${GATE_SECRET}' },
    ]);
    setFixture(f.registry, ['spec', 'gateEndpoints'], [
      { id: 'ci-gate', url: gate.url, signingCredentialRef: 'gate-signer', authCredentialRef: null, timeoutMs: 1500, maxPollMs: 5000, pollInitialMs: 100, pollMaxMs: 100, jitter: 0 },
    ]);
    const installed = await installedHandlerDigests();
    const sizedKeys1 = Array.from({ length: 64 }, (_, idx) => `k1_${String(idx).padStart(2, '0')}_${'a'.repeat(111)}`);
    const sizedKeys2 = Array.from({ length: 64 }, (_, idx) => `k2_${String(idx).padStart(2, '0')}_${'b'.repeat(111)}`);
    setFixture(f.registry, ['spec', 'handlers'], [
      ...f.registry.spec.handlers,
      { id: 'big-a', kind: 'check', implementation: 'json-artifact.v1', version: 1, digest: installed['json-artifact.v1'], parameters: { checkId: 'big-a', path: 'result.json', required: sizedKeys1, equals: {} }, capabilities: ['inert_bytes', 'read_only'] },
      { id: 'big-b', kind: 'check', implementation: 'json-artifact.v1', version: 1, digest: installed['json-artifact.v1'], parameters: { checkId: 'big-b', path: 'result.json', required: sizedKeys2, equals: {} }, capabilities: ['inert_bytes', 'read_only'] },
      { id: 'approval', kind: 'check', implementation: 'gate.v1', version: 1, digest: installed['gate.v1'], parameters: { checkId: 'approval', endpointRef: 'ci-gate', gateId: 'merge-gate' }, capabilities: ['external_service', 'read_only'] },
    ]);
    setFixture(f.registry, ['spec', 'roleProfiles', 0, 'tools'], ['read', 'write']);
    setFixture(f.config, ['spec', 'task', 'spec', 'scope', 'writable'], ['result.json']);
    setFixture(f.config, ['spec', 'task', 'spec', 'roles', 0, 'tools'], ['read', 'write']);
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxImplementationRepairs'], 1);
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxModelCalls'], 4);
    setFixture(f.config, ['spec', 'controls', 'maxAttempts'], 3);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'build', kind: 'agent', uses: 'package.patch', roleId: 'builder', dependsOn: [] },
      { id: 'big-a', kind: 'check', uses: 'big-a', roleId: null, dependsOn: ['build'] },
      { id: 'big-b', kind: 'check', uses: 'big-b', roleId: null, dependsOn: ['build'] },
      { id: 'approval', kind: 'check', uses: 'approval', roleId: null, dependsOn: ['build'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'build', handlerRef: 'package.patch' },
      { stepId: 'big-a', handlerRef: 'big-a' },
      { stepId: 'big-b', handlerRef: 'big-b' },
      { stepId: 'approval', handlerRef: 'approval' },
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'acceptance'], {
      required: ['big-a', 'big-b', 'approval'],
      checks: [
        { id: 'big-a', allowedEvidenceLevels: ['local_execution'] },
        { id: 'big-b', allowedEvidenceLevels: ['local_execution'] },
        { id: 'approval', allowedEvidenceLevels: ['external_service'] },
      ],
    });

    const repository = join(f.root, 'repository');
    const runRoot = join(f.root, 'runs');
    await mkdir(repository, { mode: 0o700 });
    const git = (args: string[]) =>
      execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: repository,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: '/nonexistent', GIT_TERMINAL_PROMPT: '0' },
        timeout: 5000,
        encoding: 'utf8',
      });
    git(['init', '-q']);
    await writeFile(join(repository, 'result.json'), JSON.stringify({ ok: false }), { mode: 0o600 });
    git(['add', 'result.json']);
    git(['-c', 'user.name=Controller Fixture', '-c', 'user.email=fixture@localhost.invalid', 'commit', '-qm', 'init']);
    const revision = git(['rev-parse', 'HEAD']).trim();
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], revision);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], revision);
    await f.save();
    const loaded = await f.load();
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;

    const commands: { readonly text: string; readonly repair: string }[] = [];
    const execution = await runCycleWithPorts(
      { configuration: loaded.value, repository, runRoot, runId: 'run-gate-repair-detail-strip' },
      {
        openAdapter: createMockRolePort({
          onExecute: (attempt, text, repair) => {
            commands.push({ text, repair });
            return { resultJson: { ok: true, attempt } };
          },
        }),
      },
    );
    assert.equal(execution.ok, true, JSON.stringify(execution));
    if (!execution.ok) return;
    assert.equal(execution.value.kind, 'result', JSON.stringify(execution.value));
    assert.equal(commands.length, 2);
    assert.equal(commands[1]!.repair, 'implementation');
    assert.ok(Buffer.byteLength(commands[1]!.text, 'utf8') <= 16384);
    const findingsJson = commands[1]!.text.split('Findings:\n')[1]!;
    const parsedFindings = JSON.parse(findingsJson) as readonly { readonly checkId: string; readonly detail?: string }[];
    assert.deepEqual(
      parsedFindings.map(item => item.checkId),
      ['approval', 'big-a', 'big-b'],
    );
    assert.equal(parsedFindings[0]!.detail, undefined);
  } finally {
    await gate.close();
    await f.cleanup();
  }
});

test('inspectRun exposes settled UsageSummary and publication externalUrl on confirmed runs', async () => {
  const expectedUrl = 'https://github.invalid/acme/repo/pull/9';
  const publisher = await startMockPublicationServer(expectedUrl);
  const f = await configurationFixture();
  try {
    f.environment.PUBLISHER_SECRET = PUBLISHER_SECRET;
    f.environment.PUBLISHER_TOKEN = PUBLISHER_TOKEN;
    setFixture(f.registry, ['spec', 'credentialBindings'], [
      ...f.registry.spec.credentialBindings,
      { id: 'publisher-signer', consumer: 'publisher', destinationRef: 'publisher-service', environmentNames: ['PUBLISHER_SECRET'], template: '${PUBLISHER_SECRET}' },
      { id: 'publisher-auth', consumer: 'publisher', destinationRef: 'publisher-service', environmentNames: ['PUBLISHER_TOKEN'], template: '${PUBLISHER_TOKEN}' },
    ]);
    setFixture(f.registry, ['spec', 'environmentBindings'], [
      { name: 'PROVIDER_TOKEN', classification: 'credential', paths: ['/spec/credentials/0/template'] },
      { name: 'PUBLISHER_SECRET', classification: 'credential', paths: ['/spec/credentials/1/template'] },
      { name: 'PUBLISHER_TOKEN', classification: 'credential', paths: ['/spec/credentials/2/template'] },
    ]);
    setFixture(f.config, ['spec', 'credentials'], [
      { ref: 'copilot', template: '${PROVIDER_TOKEN}' },
      { ref: 'publisher-signer', template: '${PUBLISHER_SECRET}' },
      { ref: 'publisher-auth', template: '${PUBLISHER_TOKEN}' },
    ]);
    setFixture(f.registry, ['spec', 'publicationEndpoints'], [
      { id: 'pr-publisher', url: publisher.url, signingCredentialRef: 'publisher-signer', authCredentialRef: 'publisher-auth', timeoutMs: 2000 },
    ]);
    setFixture(f.config, ['spec', 'publication'], {
      mode: 'pull_request',
      endpointRef: 'pr-publisher',
      targetBranch: 'main',
      headBranchPrefix: 'loopwright/',
      titleTemplate: 'Loopwright run publication',
    });
    setFixture(f.config, ['spec', 'task', 'spec', 'scope', 'writable'], ['result.json']);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'build', kind: 'agent', uses: 'package.patch', roleId: 'builder', dependsOn: [] },
      { id: 'verify', kind: 'check', uses: 'tests', roleId: null, dependsOn: ['build'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'build', handlerRef: 'package.patch' },
      { stepId: 'verify', handlerRef: 'tests' },
    ]);
    const repository = join(f.root, 'repository');
    const runRoot = join(f.root, 'runs');
    await mkdir(repository, { mode: 0o700 });
    const git = (args: string[]) =>
      execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: repository,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: '/nonexistent', GIT_TERMINAL_PROMPT: '0' },
        timeout: 5000,
        encoding: 'utf8',
      });
    git(['init', '-q']);
    await writeFile(join(repository, 'result.json'), JSON.stringify({ ok: false }), { mode: 0o600 });
    git(['add', 'result.json']);
    git(['-c', 'user.name=Controller Fixture', '-c', 'user.email=fixture@localhost.invalid', 'commit', '-qm', 'init']);
    const revision = git(['rev-parse', 'HEAD']).trim();
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], revision);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], revision);
    await f.save();
    const loaded = await f.load();
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;

    const runId = 'run-inspect-usage-url';
    const executed = await runCycleWithPorts(
      { configuration: loaded.value, repository, runRoot, runId },
      {
        openAdapter: createMockRolePort({
          onExecute: () => ({
            resultJson: { ok: true },
            inputTokens: 120,
            outputTokens: 30,
            costMicrousd: { provenance: 'estimated', value: 12500 },
          }),
        }),
      },
    );
    assert.equal(executed.ok, true, JSON.stringify(executed));
    if (!executed.ok) return;
    assert.equal(executed.value.kind, 'result');
    if (executed.value.kind !== 'result') return;
    assert.equal(executed.value.result.spec.status, 'completed');

    const outputDir = join(f.root, 'exported');
    const inspected = await inspectRun({ runRoot, runId, output: outputDir });
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    if (!inspected.ok) return;

    assert.equal(inspected.value.externalUrl, expectedUrl);
    assert.ok(inspected.value.usage !== null);
    assert.equal(inspected.value.usage!.inputTokens.knownSubtotal, 120);
    assert.equal(inspected.value.usage!.outputTokens.knownSubtotal, 30);
    assert.equal(inspected.value.usage!.totalTokens.knownSubtotal, 150);
    assert.equal(inspected.value.usage!.costMicrousd.knownSubtotal, 12500);
    assert.equal(inspected.value.usage!.costMicrousd.provenance, 'estimated');

    const pubDoc = JSON.parse(await readFile(join(outputDir, 'publication.json'), 'utf8')) as { externalUrl: string | null };
    assert.equal(pubDoc.externalUrl, expectedUrl);
    const usageDoc = JSON.parse(await readFile(join(outputDir, 'usage.json'), 'utf8')) as { summary: UsageSummary | null };
    assert.equal(usageDoc.summary?.totalTokens.knownSubtotal, 150);

    const missing = await inspectRun({ runRoot, runId: 'missing-run' });
    assert.equal(missing.ok, true);
    if (missing.ok) {
      assert.equal(missing.value.manifest, null);
      assert.equal(missing.value.usage, null);
      assert.equal(missing.value.externalUrl, null);
    }
  } finally {
    await publisher.close();
    await f.cleanup();
  }
});

test('report: formatCostUsd and parseReportOutputFormats handle valid and invalid inputs deterministically', () => {
  assert.equal(formatCostUsd(0), '0.000000');
  assert.equal(formatCostUsd(12500), '0.012500');
  assert.equal(formatCostUsd(12345678), '12.345678');
  assert.throws(() => formatCostUsd(-1), RangeError);
  assert.throws(() => formatCostUsd(1.5), RangeError);
  assert.throws(() => formatCostUsd(Number.NaN), RangeError);

  assert.deepEqual(REPORT_OUTPUT_FORMATS, ['json', 'github-step-summary', 'markdown', 'text']);
  assert.deepEqual(parseReportOutputFormats(undefined), []);
  assert.deepEqual(parseReportOutputFormats(undefined, ['json']), ['json']);
  assert.deepEqual(parseReportOutputFormats('json'), ['json']);
  assert.deepEqual(parseReportOutputFormats('text, github-step-summary, text'), ['text', 'github-step-summary']);
  assert.deepEqual(parseReportOutputFormats(['markdown', 'json', 'markdown']), ['markdown', 'json']);
  assert.deepEqual(parseReportOutputFormats(['json,text', 'markdown']), ['json', 'text', 'markdown']);

  assert.throws(() => parseReportOutputFormats(''), /must not be empty/);
  assert.throws(() => parseReportOutputFormats([]), /must not be empty/);
  assert.throws(() => parseReportOutputFormats('json, '), /empty tokens/);
  assert.throws(() => parseReportOutputFormats('unknown-sink'), /Unsupported output format/);
  assert.throws(() => parseReportOutputFormats(['json', 'bad']), /Unsupported output format/);
  assert.throws(() => parseReportOutputFormats(['json', '']), /must not contain empty values/);
});

test('report: sanitizeReportText and formatRunReport scrub secrets, strip ANSI/control bytes, neutralize workflow commands, and enforce token/cost rules', () => {
  const rawSecret = 'sk-super-secret-token-value-12345';
  const scrubber = new SecretScrubber();
  scrubber.register(rawSecret);

  const hostile = `\x1b[31m::error::bad\x1b[0m \x1b]0;title\x07\x00\x1f::add-mask::${rawSecret}\r\n:::set-output name=a::b | pipe`;
  const sanitizedMulti = sanitizeReportText(hostile, { scrub: value => scrubber.scrub(value) });
  assert.equal(sanitizedMulti.includes('\x1b'), false);
  assert.equal(sanitizedMulti.includes('\x00'), false);
  assert.equal(sanitizedMulti.includes('\x1f'), false);
  assert.equal(sanitizedMulti.includes('::'), false);
  assert.equal(sanitizedMulti.includes(rawSecret), false);
  assert.ok(sanitizedMulti.includes('[scrubbed]'));
  assert.ok(sanitizedMulti.includes(': :error: :bad'));
  assert.ok(sanitizedMulti.includes(': :add-mask: :[scrubbed]'));

  const sanitizedSingle = sanitizeReportText(hostile, { scrub: value => scrubber.scrub(value), singleLine: true });
  assert.equal(sanitizedSingle.includes('\n'), false);
  assert.equal(sanitizedSingle.includes('\r'), false);
  assert.equal(sanitizedSingle.includes('::'), false);

  const splitNull = 'token sk-super-\x00secret-token-value-12345 end';
  const splitAnsi = 'token sk-super-\x1b[31msecret-token-value-12345\x1b[0m end';
  const scrubbedSplitNull = sanitizeReportText(splitNull, { scrub: value => scrubber.scrub(value) });
  const scrubbedSplitAnsi = sanitizeReportText(splitAnsi, { scrub: value => scrubber.scrub(value) });
  assert.equal(scrubbedSplitNull.includes(rawSecret), false);
  assert.equal(scrubbedSplitNull.includes('sk-super-'), false);
  assert.ok(scrubbedSplitNull.includes('[scrubbed]'));
  assert.equal(scrubbedSplitAnsi.includes(rawSecret), false);
  assert.equal(scrubbedSplitAnsi.includes('sk-super-'), false);
  assert.ok(scrubbedSplitAnsi.includes('[scrubbed]'));

  const hashCmd = '##[error]bad line\n##[set-output name=x;]y';
  const neutralizedHash = sanitizeReportText(hashCmd);
  assert.equal(neutralizedHash.includes('##['), false);
  assert.ok(neutralizedHash.includes('# #[error]bad line'));
  assert.ok(neutralizedHash.includes('# #[set-output name=x;]y'));
  const neutralizedHashSingle = sanitizeReportText(hashCmd, { singleLine: true });
  assert.equal(neutralizedHashSingle.includes('##['), false);
  assert.ok(neutralizedHashSingle.includes('# #[error]bad line # #[set-output name=x;]y'));

  const pricedUsage: UsageSummary = {
    requests: [
      {
        requestId: 'req-1',
        inputTokens: { provenance: 'reported', value: 1000 },
        outputTokens: { provenance: 'reported', value: 250 },
        costMicrousd: { provenance: 'estimated', value: 12500 },
      },
    ],
    inputTokens: { knownSubtotal: 1000, unknownCount: 0, completeness: 'complete', provenance: 'reported' },
    outputTokens: { knownSubtotal: 250, unknownCount: 0, completeness: 'complete', provenance: 'reported' },
    totalTokens: { knownSubtotal: 1250, unknownCount: 0, completeness: 'complete', provenance: 'reported' },
    costMicrousd: { knownSubtotal: 12500, unknownCount: 0, completeness: 'complete', provenance: 'estimated' },
  };

  const baseInput = {
    runId: 'run-report-1',
    status: 'completed',
    reasonCode: `::warning::${rawSecret}`,
    phase: 'publication',
    discovery: { disposition: 'updated', updatesCount: 2, summary: `::notice::found ${rawSecret} | item` },
    checks: [
      { checkId: 'scope', status: 'passed', code: null, detail: null },
      { checkId: 'gate', status: 'failed', code: 'gate_denied', detail: `\x1b[31m::error::${rawSecret} | fail\x1b[0m` },
    ],
    model: { provider: 'openai', model: 'gpt-5', thinking: 'medium', tokenRotations: 1 },
    usage: pricedUsage,
    elapsedMs: 420,
    externalUrl: 'https://github.invalid/acme/repo/pull/9',
    scrub: (value: string) => scrubber.scrub(value),
  };

  for (const format of ['json', 'github-step-summary', 'markdown', 'text'] as readonly ReportOutputFormat[]) {
    const rendered = formatRunReport(baseInput, format);
    assert.equal(rendered.includes(rawSecret), false, `${format} leaked secret`);
    assert.equal(rendered.includes('\x1b'), false, `${format} leaked ESC`);
    assert.equal(rendered.includes('::error'), false, `${format} leaked ::error`);
    assert.equal(rendered.includes('::warning'), false, `${format} leaked ::warning`);
    assert.equal(rendered.includes('::notice'), false, `${format} leaked ::notice`);
    assert.ok(rendered.includes('1250'), `${format} missing totalTokens`);
    assert.ok(rendered.includes('1000'), `${format} missing inputTokens`);
    assert.ok(rendered.includes('250'), `${format} missing outputTokens`);
    assert.ok(rendered.includes('0.012500'), `${format} missing formatted costUsd`);
    assert.ok(rendered.includes('estimated'), `${format} missing cost provenance`);
    assert.ok(rendered.includes('https://github.invalid/acme/repo/pull/9'), `${format} missing externalUrl`);
  }

  const jsonParsed = JSON.parse(formatRunReport(baseInput, 'json')) as Record<string, unknown>;
  assert.equal((jsonParsed.usage as Record<string, unknown>).costUsd, '0.012500');
  assert.equal((jsonParsed.usage as Record<string, unknown>).costMicrousd, 12500);
  assert.equal((jsonParsed.usage as Record<string, unknown>).totalTokens, 1250);
  assert.equal((jsonParsed.usage as Record<string, unknown>).tokenCompleteness, 'complete');
  assert.equal((jsonParsed.usage as Record<string, unknown>).tokenUnknownCount, 0);
  assert.equal((jsonParsed.usage as Record<string, unknown>).costCompleteness, 'complete');
  assert.equal((jsonParsed.usage as Record<string, unknown>).costUnknownCount, 0);

  const stepSummary = formatRunReport(baseInput, 'github-step-summary');
  assert.ok(stepSummary.includes('\\| fail'));
  assert.ok(stepSummary.includes('\\| item'));

  const unknownCostUsage: UsageSummary = {
    requests: [
      {
        requestId: 'req-1',
        inputTokens: { provenance: 'reported', value: 400 },
        outputTokens: { provenance: 'reported', value: 100 },
        costMicrousd: { provenance: 'unknown' },
      },
    ],
    inputTokens: { knownSubtotal: 400, unknownCount: 0, completeness: 'complete', provenance: 'reported' },
    outputTokens: { knownSubtotal: 100, unknownCount: 0, completeness: 'complete', provenance: 'reported' },
    totalTokens: { knownSubtotal: 500, unknownCount: 0, completeness: 'complete', provenance: 'reported' },
    costMicrousd: { knownSubtotal: 0, unknownCount: 1, completeness: 'partial', provenance: 'unknown' },
  };
  const unpricedInput = { ...baseInput, usage: unknownCostUsage };

  for (const format of ['github-step-summary', 'markdown', 'text'] as const) {
    const rendered = formatRunReport(unpricedInput, format);
    assert.ok(rendered.includes('500'), `${format} missing totalTokens for unpriced run`);
    assert.equal(rendered.includes('Cost'), false, `${format} should omit USD cost when provenance is unknown`);
    assert.equal(rendered.includes('$0.000000'), false, `${format} should not print $0.000000 when provenance is unknown`);
  }

  const unpricedJson = JSON.parse(formatRunReport(unpricedInput, 'json')) as { usage: Record<string, unknown> };
  assert.equal(unpricedJson.usage.totalTokens, 500);
  assert.equal(unpricedJson.usage.tokenCompleteness, 'complete');
  assert.equal(unpricedJson.usage.tokenUnknownCount, 0);
  assert.equal(unpricedJson.usage.costMicrousd, null);
  assert.equal(unpricedJson.usage.costUsd, null);
  assert.equal(unpricedJson.usage.costProvenance, 'unknown');
  assert.equal(unpricedJson.usage.costCompleteness, 'partial');
  assert.equal(unpricedJson.usage.costUnknownCount, 1);

  const partialUsage: UsageSummary = {
    requests: [
      {
        requestId: 'req-1',
        inputTokens: { provenance: 'reported', value: 400 },
        outputTokens: { provenance: 'reported', value: 100 },
        costMicrousd: { provenance: 'estimated', value: 12500 },
      },
      {
        requestId: 'req-2',
        inputTokens: { provenance: 'reported', value: 200 },
        outputTokens: { provenance: 'unknown' },
        costMicrousd: { provenance: 'unknown' },
      },
    ],
    inputTokens: { knownSubtotal: 600, unknownCount: 0, completeness: 'complete', provenance: 'reported' },
    outputTokens: { knownSubtotal: 100, unknownCount: 1, completeness: 'partial', provenance: 'reported' },
    totalTokens: { knownSubtotal: 700, unknownCount: 1, completeness: 'partial', provenance: 'reported' },
    costMicrousd: { knownSubtotal: 12500, unknownCount: 1, completeness: 'partial', provenance: 'estimated' },
  };
  const partialInput = { ...baseInput, usage: partialUsage };

  const partialJson = JSON.parse(formatRunReport(partialInput, 'json')) as { usage: Record<string, unknown> };
  assert.equal(partialJson.usage.totalTokens, 700);
  assert.equal(partialJson.usage.tokenCompleteness, 'partial');
  assert.equal(partialJson.usage.tokenUnknownCount, 1);
  assert.equal(partialJson.usage.costUsd, '0.012500');
  assert.equal(partialJson.usage.costCompleteness, 'partial');
  assert.equal(partialJson.usage.costUnknownCount, 1);

  for (const format of ['github-step-summary', 'markdown'] as const) {
    const rendered = formatRunReport(partialInput, format);
    assert.ok(rendered.includes('>= 700 total (600 in / 100 out, reported, partial: 1 unknown)'), `${format} missing partial tokens`);
    assert.ok(rendered.includes('>= $0.012500 (estimated, partial: 1 unknown)'), `${format} missing partial cost`);
  }
  const partialText = formatRunReport(partialInput, 'text');
  assert.ok(partialText.includes('Tokens: >= 700 total (600 in / 100 out, partial: 1 unknown)'));
  assert.ok(partialText.includes('Cost: >= $0.012500 USD (estimated, partial: 1 unknown)'));
});
