import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import {
  canonical,
  computeCodeFingerprint,
  emptyMemoryStoreIndex,
  entryFileBytes,
  hashDomain,
  loadMemoryStore,
  projectMemoryStore,
  type MemoryEntry,
  type MemoryOperation,
} from '@loopwright/memory';
import {
  loadTrustedConfiguration,
  stepNext,
  stepSubmit,
} from '@loopwright/controller';
import {
  DEFAULT_HOST_BUDGETS,
  compileDeclarativeTaskpack,
  finalizeAndPublishTurnkeyMemory,
  loadDeclarativeTaskpack,
  openStagedTaskpackStepGate,
  runGitHubActionEntrypoint,
  SecretScrubber,
  stageTaskpackForStep,
} from '../src/index.js';
import { createFastTurnkeyAdapter } from './fast-turnkey-adapter.js';

const fastAdapter = createFastTurnkeyAdapter();

const execFileAsync = promisify(execFile);

const GIT_TEST_ENV: Record<string, string> = {
  PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
  HOME: process.env['HOME'] ?? '/tmp',
  LANG: 'C',
  LC_ALL: 'C',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
};

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    '/usr/bin/git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test Bot', '-c', 'user.email=test@example.com', '-C', cwd, ...args],
    { env: GIT_TEST_ENV, encoding: 'utf8', timeout: 15_000 },
  );
  return stdout.trim();
}

function sseToolCall(model: string, id: string, name: string, args: Record<string, unknown>): string {
  return [
    `data: ${JSON.stringify({
      id: `chatcmpl-${id}`,
      model,
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: null,
      }],
    })}`,
    '',
    `data: ${JSON.stringify({
      id: `chatcmpl-${id}`,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 80, completion_tokens: 20 },
    })}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
}

function sseStop(model: string, text: string): string {
  return [
    `data: ${JSON.stringify({
      id: 'chatcmpl-final',
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 80, completion_tokens: 20 },
    })}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text.trim().length > 0 ? JSON.parse(text) as Record<string, unknown> : {};
}

async function startHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(err => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: String(err) }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to bind mock HTTP server');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => await new Promise<void>(resolve => server.close(() => resolve())),
  };
}

function makeTaskpackYaml(openAiBaseUrl: string): string {
  return `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: auto-sync
spec:
  goal:
    candidate: Sync upstream engine release into docs/status.md and pack/proposal.json.
    noChange: Confirm no upstream update is pending.
  scope:
    writable:
      - docs
      - pack
    protected:
      - pack/frozen.json
  instructions:
    - .auto-sync/prompts/instructions.md
  upstreams:
    - id: engine
      kind: github-release
      source: acme/engine
      watchedPaths:
        - docs
  proposal:
    path: pack/proposal.json
    requiredFields:
      - schema_version
      - version
    schemaVersion: 1
  verification:
    localChecks:
      - id: proposal-json
        implementation: json-artifact.v1
      - id: verify-status
        implementation: command.v1
        parameters:
          script: .auto-sync/checks/verify.sh
          timeoutSeconds: 20
    externalGates: []
  publication:
    mode: pull_request
    targetBranch: main
    headBranchPrefix: loopwright/
    titleTemplate: "chore(sync): update engine metadata"
  memory:
    directory: .auto-sync/memory
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
  models:
    - provider: openai
      id: gpt-4.1-mini
      api: openai-completions
      apiKeyEnv: LLM_TOKEN
      baseUrl: ${openAiBaseUrl}/v1
      cost:
        input: 1
        output: 2
  limits:
    maxAttempts: 1
    maxImplementationRepairs: 0
    maxFormatRepairs: 0
  output:
    formats:
      - json
      - github-step-summary
`;
}

function buildSyntheticMemoryEntry(params: {
  readonly id: string;
  readonly claimKey: string;
  readonly claim: string;
  readonly baseRevision: string;
  readonly codeFingerprint: { readonly algorithm: 'sha256'; readonly hex: string };
  readonly verifiedAtMs: number;
  readonly taskpack?: string;
}): MemoryEntry {
  const evidenceDigest = hashDomain('test-evidence', { id: params.id, claim: params.claim });
  return {
    version: 1,
    id: params.id,
    claimKey: params.claimKey,
    claim: params.claim,
    kind: 'fact',
    scope: {
      taskpack: params.taskpack ?? 'auto-sync',
      repository: 'acme/repo',
      paths: ['docs/**', 'pack/**'],
      targetMatrix: null,
    },
    sourceRef: {
      runId: 'seed-run-1',
      lockHash: hashDomain('test-lock', params.id),
      candidateDigest: hashDomain('test-cand', params.id),
    },
    sourceDigest: hashDomain('test-source', { id: params.id, claim: params.claim }),
    verifiedAtMs: params.verifiedAtMs,
    validFor: {
      baseRevision: params.baseRevision,
      sourceRevision: params.baseRevision,
      codeFingerprint: params.codeFingerprint,
      upstreamVersions: { engine: 'v2.0.0' },
    },
    expiresAtMs: params.verifiedAtMs + 86_400_000 * 365,
    supersedes: [],
    evidenceRefs: [{
      evidenceId: 'ev.verify-status',
      checkId: 'verify-status',
      level: 'local_execution',
      observedStatus: 'passed',
      artifact: {
        name: 'checks/verify-status.json',
        digest: evidenceDigest,
        byteLength: 128,
      },
    }],
  };
}

async function writeProjectedStoreToDisk(
  targetRepo: string,
  projection: ReturnType<typeof projectMemoryStore>,
  taskpackName = 'auto-sync',
): Promise<void> {
  const memDir = join(targetRepo, '.auto-sync', 'memory', taskpackName);
  const entriesDir = join(memDir, 'entries');
  await rm(memDir, { recursive: true, force: true });
  await mkdir(entriesDir, { recursive: true });
  const writes: Promise<void>[] = [];
  for (const [entryId, bytes] of projection.entryFiles.entries()) {
    writes.push(writeFile(join(entriesDir, `${entryId}.md`), bytes));
  }
  for (const row of projection.index.retired) {
    if (!projection.entryFiles.has(row.entry.id)) {
      writes.push(writeFile(join(entriesDir, `${row.entry.id}.md`), entryFileBytes(row.entry)));
    }
  }
  writes.push(writeFile(join(memDir, 'index.json'), canonical(projection.index), 'utf8'));
  await Promise.all(writes);
}

function buildActiveOpsBatch(params: {
  readonly count: number;
  readonly idPrefix: string;
  readonly claimPrefix: string;
  readonly paddingChar: string;
  readonly paddingLen: number;
  readonly baseRevision: string;
  readonly codeFingerprint: { readonly algorithm: 'sha256'; readonly hex: string };
  readonly verifiedAtMs: number;
}): MemoryOperation[] {
  const pad = params.paddingChar.repeat(params.paddingLen);
  const ops: MemoryOperation[] = [];
  for (let i = 0; i < params.count; i += 1) {
    const padded = String(i).padStart(3, '0');
    ops.push({
      kind: 'upsert',
      entry: buildSyntheticMemoryEntry({
        id: `entry.${params.idPrefix}-${padded}`,
        claimKey: `claim.${params.idPrefix}-${padded}`,
        claim: `${params.claimPrefix} ${padded}: ${pad}`,
        baseRevision: params.baseRevision,
        codeFingerprint: params.codeFingerprint,
        verifiedAtMs: params.verifiedAtMs,
      }),
    });
  }
  return ops;
}

describe('turnkey @loopwright/memory window budgeting and large store merges', () => {
  it('bounds 130-entry active memory within tight request/window limits, omits cleanly when headroom is exhausted, and merges 220-entry squash-merged stores', async () => {
    const rawWork = await mkdtemp(join(tmpdir(), 'lw-turnkey-mem-budget-'));
    const work = await realpath(rawWork);
    const bareRemote = join(work, 'remote.git');
    const repo = join(work, 'repo');
    const runRoot = join(work, 'runs');
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let githubServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;

    try {
      await mkdir(bareRemote, { recursive: true });
      await mkdir(repo, { recursive: true });
      await mkdir(runRoot, { recursive: true });

      await git(bareRemote, ['init', '--bare', '--initial-branch=main']);
      await git(repo, ['init', '--initial-branch=main']);
      await git(repo, ['remote', 'add', 'origin', bareRemote]);

      await mkdir(join(repo, '.auto-sync', 'prompts'), { recursive: true });
      await mkdir(join(repo, '.auto-sync', 'checks'), { recursive: true });
      await mkdir(join(repo, 'docs'), { recursive: true });
      await mkdir(join(repo, 'pack'), { recursive: true });
      await writeFile(join(repo, '.auto-sync', 'prompts', 'instructions.md'), '# Guide\n', 'utf8');
      await writeFile(
        join(repo, '.auto-sync', 'checks', 'verify.sh'),
        '#!/bin/sh\nset -eu\ngrep -q "verified-v2" "$LOOPWRIGHT_CANDIDATE_DIR/docs/status.md"\n',
        { mode: 0o755 },
      );
      await chmod(join(repo, '.auto-sync', 'checks', 'verify.sh'), 0o755);
      await writeFile(join(repo, 'docs', 'status.md'), 'v1\n', 'utf8');
      await writeFile(join(repo, 'pack', 'proposal.json'), '{"schema_version":1,"version":"1.0.0"}\n', 'utf8');
      await writeFile(join(repo, 'pack', 'frozen.json'), '{"locked":true}\n', 'utf8');

      const observedRequestBytes: number[] = [];
      let turn = 0;
      openAiServer = await startHttpServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        observedRequestBytes.push(Buffer.concat(chunks).byteLength);

        const currentTurn = turn++;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (currentTurn === 0) {
          res.end(sseToolCall('gpt-4.1-mini', 'c1', 'write', { path: 'docs/status.md', content: 'verified-v2\n' }));
          return;
        }
        if (currentTurn === 1) {
          res.end(sseToolCall('gpt-4.1-mini', 'c2', 'write', {
            path: 'pack/proposal.json',
            content: '{"schema_version":1,"version":"2.0.0"}\n',
          }));
          return;
        }
        res.end(sseStop('gpt-4.1-mini', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null })));
      });

      githubServer = await startHttpServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/repos/acme/engine/releases/latest' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v2.0.0' }));
          return;
        }
        if (url.pathname === '/repos/acme/repo' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 801 }));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('[]');
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'POST') {
          const payload = await readJsonBody(req);
          const headRef = String(payload['head'] ?? '');
          if (headRef.startsWith('loopwright/memory/')) {
            const lsOut = await git(repo, ['ls-remote', bareRemote, `refs/heads/${headRef}`]);
            const remoteSha = lsOut.split(/\s+/)[0] ?? '';
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              number: 81,
              html_url: 'https://github.invalid/acme/repo/pull/81',
              state: 'open',
              head: { ref: headRef, sha: remoteSha, repo: { full_name: 'acme/repo', fork: false } },
              base: { ref: String(payload['base'] ?? 'main'), repo: { full_name: 'acme/repo', fork: false } },
            }));
            return;
          }
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ number: 80, html_url: 'https://github.invalid/acme/repo/pull/80' }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      const yaml131k = makeTaskpackYaml(openAiServer.url).replace(
        '    maxFormatRepairs: 0\n',
        '    maxFormatRepairs: 0\n    workingWindowBytes: 131072\n    maxRequestBytes: 131072\n',
      );
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), yaml131k, 'utf8');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'init repo']);
      const baseSha0 = await git(repo, ['rev-parse', 'HEAD']);

      const docsFp = await computeCodeFingerprint(repo, ['docs/**', 'pack/**'], '.auto-sync/memory');
      const nowMs = Date.now();
      const ops130 = buildActiveOpsBatch({
        count: 130,
        idPrefix: 'item',
        claimPrefix: 'Verified invariant',
        paddingChar: 'x',
        paddingLen: 1_250,
        baseRevision: baseSha0,
        codeFingerprint: docsFp,
        verifiedAtMs: nowMs - 1_000,
      });
      const proj130 = projectMemoryStore(emptyMemoryStoreIndex('auto-sync', 'acme/repo', nowMs - 2_000), ops130, nowMs, 'prop.seed-130');
      await writeProjectedStoreToDisk(repo, proj130);
      await git(repo, ['add', '.auto-sync/memory']);
      await git(repo, ['commit', '-m', 'chore(memory): seed 130 active entries']);
      let mainSha = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['push', 'origin', 'HEAD:refs/heads/main']);

      turn = 0;
      observedRequestBytes.length = 0;
      const tight130Res = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 801,
        baseRevision: mainSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-p3-130-tight',
        turnkey: true,
        allowManifestCustomBaseUrl: true,
        githubApiBaseUrl: githubServer.url,
        githubToken: 'ghp_p3b_token_123456',
        gitRemoteUrl: bareRemote,
        openHostSessionAdapter: fastAdapter,
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-p3b-llm-token-123456',
        },
      });
      assert.equal(tight130Res.kind, 'compiled');
      if (tight130Res.kind === 'compiled') {
        assert.equal(tight130Res.taskpack.activeMemory?.activeEntryCount, 130);
        assert.equal(tight130Res.taskpack.activeMemory?.resourcePath, '.auto-sync/memory/auto-sync/active-snapshot.md');
        assert.equal(tight130Res.delegateOutcome?.ok, true);
      }
      assert.equal(observedRequestBytes.length >= 3, true);
      for (const reqBytes of observedRequestBytes) {
        assert.equal(reqBytes <= 131_072, true, `wire request (${reqBytes}B) must respect maxRequestBytes (131072B)`);
      }

      // Exhaust request headroom with required instructions -> optional memory omits cleanly
      await writeFile(join(repo, '.auto-sync', 'prompts', 'instructions.md'), `# Guide\n${'Required rule line.\n'.repeat(2_400)}`, 'utf8');
      const manifest130 = await loadDeclarativeTaskpack({ manifestPath: '.auto-sync/taskpack.yaml', repositoryRoot: repo });
      const memoryWarnings: string[] = [];
      const compiledOmitted = await compileDeclarativeTaskpack(manifest130, {
        mode: 'no-change',
        repository: 'acme/repo',
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        baseRevision: mainSha,
        sourceRevision: mainSha,
        allowManifestCustomBaseUrl: true,
        budgets: DEFAULT_HOST_BUDGETS,
        limits: { workingWindowBytes: 131_072, maxRequestBytes: 65_536 },
        credentialEnvMap: { provider: 'LLM_TOKEN' },
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        onMemoryWarning: msg => memoryWarnings.push(msg),
      });
      assert.equal(compiledOmitted.activeMemory?.activeEntryCount, 130);
      assert.equal(compiledOmitted.activeMemory?.resourcePath, null);
      assert.equal(memoryWarnings.some(w => w.includes('active memory omitted')), true);

      await writeFile(join(repo, '.auto-sync', 'prompts', 'instructions.md'), '# Guide\n', 'utf8');
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), makeTaskpackYaml(openAiServer.url), 'utf8');
      await git(repo, ['add', '.auto-sync/prompts/instructions.md', '.auto-sync/taskpack.yaml']);
      await git(repo, ['commit', '-m', 'chore: restore default limits']);
      mainSha = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['push', 'origin', 'HEAD:refs/heads/main']);
      await git(bareRemote, ['update-ref', '-d', 'refs/heads/loopwright/main']).catch(() => undefined);
      await git(bareRemote, ['update-ref', '-d', 'refs/heads/loopwright/memory/auto-sync/main']).catch(() => undefined);

      // 220-entry store (> 450 KiB `index.json`) + retired/active same-id replacement + squash-merge + disjoint target addition
      const ops220 = buildActiveOpsBatch({
        count: 220,
        idPrefix: 'item',
        claimPrefix: 'Large store entry',
        paddingChar: 'y',
        paddingLen: 1_450,
        baseRevision: mainSha,
        codeFingerprint: docsFp,
        verifiedAtMs: nowMs + 1_000,
      });
      const proj220V1 = projectMemoryStore(
        emptyMemoryStoreIndex('auto-sync', 'acme/repo', nowMs),
        ops220,
        nowMs + 2_000,
        'prop.seed-220-v1',
      );
      const item000V2 = buildSyntheticMemoryEntry({
        id: 'entry.item-000',
        claimKey: 'claim.item-000',
        claim: `Large store entry 000 v2 replacement: ${'z'.repeat(1_450)}`,
        baseRevision: mainSha,
        codeFingerprint: docsFp,
        verifiedAtMs: nowMs + 3_000,
      });
      const proj220V2 = projectMemoryStore(
        proj220V1.index,
        [
          { kind: 'retire', entryId: 'entry.item-000', reason: 'superseded by v2' },
          { kind: 'upsert', entry: item000V2 },
        ],
        nowMs + 4_000,
        'prop.seed-220-v2',
      );
      const index220Bytes = Buffer.byteLength(canonical(proj220V2.index), 'utf8');
      assert.equal(index220Bytes > 450_000, true);

      const memSeedClone = join(work, 'mem-seed-clone');
      await git(work, ['clone', bareRemote, memSeedClone]);
      await writeProjectedStoreToDisk(memSeedClone, proj220V2);
      await git(memSeedClone, ['add', '.auto-sync/memory']);
      await git(memSeedClone, ['commit', '-m', 'memory(auto-sync): 220 entries with same-id replacement']);
      await git(memSeedClone, ['push', 'origin', 'HEAD:refs/heads/loopwright/memory/auto-sync/main']);

      await git(repo, ['fetch', 'origin', 'refs/heads/loopwright/memory/auto-sync/main']);
      await git(repo, ['merge', '--squash', 'FETCH_HEAD']);
      await git(repo, ['commit', '-m', 'chore(memory): squash merge 220-entry memory PR']);

      const proj221OnMain = projectMemoryStore(
        proj220V2.index,
        [{
          kind: 'upsert',
          entry: buildSyntheticMemoryEntry({
            id: 'entry.item-220',
            claimKey: 'claim.item-220',
            claim: 'Disjoint entry added on main after squash merge',
            baseRevision: mainSha,
            codeFingerprint: docsFp,
            verifiedAtMs: nowMs + 5_000,
          }),
        }],
        nowMs + 6_000,
        'prop.main-221',
      );
      await writeProjectedStoreToDisk(repo, proj221OnMain);
      await git(repo, ['add', '.auto-sync/memory']);
      await git(repo, ['commit', '-m', 'chore(memory): add disjoint entry 220 on main']);
      mainSha = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['push', 'origin', 'HEAD:refs/heads/main']);

      // Seed a settled run via stepNext + stepSubmit (avoiding a redundant HostSession boot) and exercise finalizeAndPublishTurnkeyMemory directly.
      const manifest220 = await loadDeclarativeTaskpack({ manifestPath: '.auto-sync/taskpack.yaml', repositoryRoot: repo });
      const staged220 = await stageTaskpackForStep({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        runRoot,
        runId: 'run-p3-220-squash',
        mode: 'candidate',
        discoverUpstreams: false,
        upstreamRecordsJson: JSON.stringify([{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }]),
        runtimeEnv: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          LOOPWRIGHT_REPOSITORY: 'acme/repo',
          GITHUB_SHA: mainSha,
        },
      });
      const gate220 = await openStagedTaskpackStepGate({ runRoot, runId: 'run-p3-220-squash' });
      let sub220: Awaited<ReturnType<typeof stepSubmit>>;
      try {
        const prevGateSecret = process.env[staged220.signingEnvName];
        process.env[staged220.signingEnvName] = staged220.signingSecret;
        let loaded220: Awaited<ReturnType<typeof loadTrustedConfiguration>>;
        try {
          loaded220 = await loadTrustedConfiguration({
            configPath: staged220.configPath,
            registryPath: staged220.registryPath,
            registrySha256: staged220.registrySha256,
            untrustedRoots: [repo],
          });
        } finally {
          if (prevGateSecret === undefined) {
            delete process.env[staged220.signingEnvName];
          } else {
            process.env[staged220.signingEnvName] = prevGateSecret;
          }
        }
        assert.equal(loaded220.ok, true, loaded220.ok ? '' : JSON.stringify(loaded220.error));
        if (!loaded220.ok) return;
        const next220 = await stepNext(
          {
            configuration: loaded220.value,
            repository: repo,
            runRoot,
            runId: 'run-p3-220-squash',
            mode: 'candidate',
            ...(gate220 ? { environment: gate220.environment } : {}),
          },
          gate220 ? { gateUrlOverrides: gate220.gateUrlOverrides } : {},
        );
        assert.equal(next220.ok, true);
        if (!next220.ok || next220.value.kind !== 'step') return;
        await writeFile(join(next220.value.candidateDir, 'docs', 'status.md'), 'verified-v2\n', { mode: 0o600 });
        await writeFile(join(next220.value.candidateDir, 'pack', 'proposal.json'), '{"schema_version":1,"version":"2.0.0"}\n', { mode: 0o600 });
        sub220 = await stepSubmit(
          {
            runRoot,
            runId: 'run-p3-220-squash',
            leaseToken: next220.value.leaseToken,
            status: 'completed',
            ...(gate220 ? { environment: gate220.environment } : {}),
          },
          gate220 ? { gateUrlOverrides: gate220.gateUrlOverrides } : {},
        );
      } finally {
        await gate220?.close();
      }
      assert.equal(sub220.ok, true, sub220.ok ? '' : JSON.stringify(sub220.error));

      const memSummary220 = await finalizeAndPublishTurnkeyMemory({
        manifest: manifest220,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryRoot: repo,
        repositoryFullName: 'acme/repo',
        runRoot,
        runId: 'run-p3-220-squash',
        baseRevision: mainSha,
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        remoteUrl: bareRemote,
        apiBaseUrl: githubServer.url,
        githubToken: 'ghp_p3b_token_123456',
        scrubber: new SecretScrubber(),
        nowMs: nowMs + 7_000,
      });
      assert.equal(memSummary220.status, 'published', memSummary220.reason ?? '');

      const verify220Clone = join(work, 'verify-220-clone');
      await git(work, ['clone', '--branch', 'loopwright/memory/auto-sync/main', bareRemote, verify220Clone]);
      const finalStore = await loadMemoryStore(verify220Clone, 'auto-sync', 'acme/repo', '.auto-sync/memory');
      assert.equal(finalStore.index.entries.some(e => e.id === 'entry.item-220'), true);
      assert.equal(finalStore.index.entries.some(e => e.id === 'entry.item-000' && e.claim.includes('v2 replacement')), true);
      assert.equal(finalStore.index.entries.length >= 223, true);
    } finally {
      await openAiServer?.close();
      await githubServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('budgets 42KB MCP schemas alongside 130 active memory entries and stages 0o400 active memory for POSIX taskpack names', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'lw-mem-mcp-posix-')));
    const bareRemote = join(work, 'remote.git');
    const repo = join(work, 'repo');
    const runRoot = join(work, 'runs');
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let githubServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let mcpServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;

    async function initMinimalRepo(targetRepo: string, remotePath: string): Promise<void> {
      await mkdir(targetRepo, { recursive: true });
      await git(targetRepo, ['init', '--initial-branch=main']);
      await git(targetRepo, ['remote', 'add', 'origin', remotePath]);
      await mkdir(join(targetRepo, '.auto-sync', 'prompts'), { recursive: true });
      await mkdir(join(targetRepo, '.auto-sync', 'checks'), { recursive: true });
      await mkdir(join(targetRepo, 'docs'), { recursive: true });
      await mkdir(join(targetRepo, 'pack'), { recursive: true });
      await writeFile(join(targetRepo, '.auto-sync', 'prompts', 'instructions.md'), '# Guide\n', 'utf8');
      await writeFile(join(targetRepo, 'docs', 'status.md'), 'verified-v2\n', 'utf8');
      await writeFile(join(targetRepo, 'pack', 'proposal.json'), '{"schema_version":1,"version":"1.0.0"}\n', 'utf8');
      await writeFile(join(targetRepo, 'pack', 'frozen.json'), '{"locked":true}\n', 'utf8');
      await writeFile(
        join(targetRepo, '.auto-sync', 'checks', 'verify.sh'),
        '#!/bin/sh\ngrep -q \'"2.0.0"\' "$LOOPWRIGHT_CANDIDATE_DIR/pack/proposal.json"\n',
        { mode: 0o755 },
      );
      await chmod(join(targetRepo, '.auto-sync', 'checks', 'verify.sh'), 0o755);
    }

    try {
      await mkdir(bareRemote, { recursive: true });
      await mkdir(runRoot, { recursive: true });
      await git(bareRemote, ['init', '--bare', '--initial-branch=main']);

      mcpServer = await startHttpServer(async (req, res) => {
        const rpc = await readJsonBody(req);
        const method = rpc['method'];
        const id = rpc['id'];
        if (method === 'initialize') {
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'mcp-1' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'large-schema-mcp', version: '1.0.0' },
            },
          }));
          return;
        }
        if (method === 'notifications/initialized') {
          res.writeHead(202);
          res.end();
          return;
        }
        if (method === 'tools/list') {
          const largeProperties: Record<string, unknown> = {};
          for (let i = 0; i < 120; i += 1) {
            largeProperties[`field_${String(i).padStart(3, '0')}`] = {
              type: 'string',
              description: `Detailed upstream schema attribute ${i}: ${'s'.repeat(290)}`,
            };
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              tools: [{
                name: 'ext_lookup',
                description: 'Large 42KB external MCP lookup schema',
                inputSchema: { type: 'object', properties: largeProperties },
              }],
            },
          }));
          return;
        }
        res.writeHead(400);
        res.end();
      });

      let turn = 0;
      openAiServer = await startHttpServer(async (req, res) => {
        await readJsonBody(req);
        const cur = turn++;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (cur === 0) {
          res.end(sseToolCall('gpt-4.1-mini', 'c1', 'write', {
            path: 'pack/proposal.json',
            content: '{"schema_version":1,"version":"2.0.0"}\n',
          }));
          return;
        }
        res.end(sseStop('gpt-4.1-mini', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null })));
      });

      githubServer = await startHttpServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/repos/acme/engine/releases/latest' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v2.0.0' }));
          return;
        }
        if (url.pathname === '/repos/acme/repo' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 901 }));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('[]');
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'POST') {
          const payload = await readJsonBody(req);
          const headRef = String(payload['head'] ?? '');
          const lsOut = await git(repo, ['ls-remote', bareRemote, `refs/heads/${headRef}`]);
          const remoteSha = lsOut.split(/\s+/)[0] ?? '';
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            number: headRef.startsWith('loopwright/memory/') ? 91 : 90,
            html_url: `https://github.invalid/acme/repo/pull/${headRef.startsWith('loopwright/memory/') ? 91 : 90}`,
            state: 'open',
            head: { ref: headRef, sha: remoteSha, repo: { full_name: 'acme/repo', fork: false } },
            base: { ref: 'main', repo: { full_name: 'acme/repo', fork: false } },
          }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await initMinimalRepo(repo, bareRemote);
      const yamlMcp131k = makeTaskpackYaml(openAiServer.url).replace(
        '    maxFormatRepairs: 0\n',
        '    maxFormatRepairs: 0\n    workingWindowBytes: 131072\n    maxRequestBytes: 131072\n',
      );
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), yamlMcp131k, 'utf8');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'init mcp repo']);
      const baseSha0 = await git(repo, ['rev-parse', 'HEAD']);
      const docsFp = await computeCodeFingerprint(repo, ['docs/**', 'pack/**'], '.auto-sync/memory');
      const nowMs = Date.now();

      const ops130 = buildActiveOpsBatch({
        count: 130,
        idPrefix: 'mcp',
        claimPrefix: 'Active memory entry',
        paddingChar: 'm',
        paddingLen: 320,
        baseRevision: baseSha0,
        codeFingerprint: docsFp,
        verifiedAtMs: nowMs,
      });
      const proj130 = projectMemoryStore(
        emptyMemoryStoreIndex('auto-sync', 'acme/repo', nowMs),
        ops130,
        nowMs + 100,
        'prop.mcp-seed-130',
      );
      await writeProjectedStoreToDisk(repo, proj130);
      await git(repo, ['add', '.auto-sync/memory']);
      await git(repo, ['commit', '-m', 'chore(memory): seed 130 active entries']);
      const mainSha = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['push', 'origin', 'HEAD:refs/heads/main']);

      const mcpServersJson = JSON.stringify([{
        id: 'extdocs',
        transport: 'http',
        url: `${mcpServer.url}/mcp`,
        bearerTokenEnv: 'MCP_BEARER_TOKEN',
        timeoutSeconds: 30,
      }]);
      turn = 0;
      const mcpWindowRes = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 901,
        baseRevision: mainSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-mcp-window',
        turnkey: true,
        allowManifestCustomBaseUrl: true,
        mcpServersJson,
        githubApiBaseUrl: githubServer.url,
        githubToken: 'ghp_mcp_token_123456',
        gitRemoteUrl: bareRemote,
        openHostSessionAdapter: fastAdapter,
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-mcp-llm-token-123456',
          MCP_BEARER_TOKEN: 'mcp-secret-bearer-789',
        },
      });
      assert.equal(mcpWindowRes.kind, 'compiled');
      if (mcpWindowRes.kind === 'compiled') {
        assert.equal(
          mcpWindowRes.delegateOutcome?.ok,
          true,
          `must not fail admission with CONTEXT_UNSAFE (detail=${mcpWindowRes.delegateOutcome?.detail ?? ''})`,
        );
        assert.equal(mcpWindowRes.memory?.status, 'published');
      }

      // POSIX taskpack identifiers `aux` and `con.examples` compile and stage 0o400 active memory cleanly
      for (const posixName of ['aux', 'con.examples'] as const) {
        const posixRepo = join(work, `repo-${posixName.replace('.', '_')}`);
        await initMinimalRepo(posixRepo, bareRemote);
        const posixYaml = makeTaskpackYaml(openAiServer.url).replace('  name: auto-sync\n', `  name: ${posixName}\n`);
        await writeFile(join(posixRepo, '.auto-sync', 'taskpack.yaml'), posixYaml, 'utf8');
        await git(posixRepo, ['add', '.']);
        await git(posixRepo, ['commit', '-m', `init ${posixName}`]);
        const posixHead = await git(posixRepo, ['rev-parse', 'HEAD']);
        const posixFp = await computeCodeFingerprint(posixRepo, ['docs/**', 'pack/**'], '.auto-sync/memory');
        const posixProj = projectMemoryStore(
          emptyMemoryStoreIndex(posixName, 'acme/repo', nowMs),
          [{
            kind: 'upsert',
            entry: buildSyntheticMemoryEntry({
              id: 'entry.posix-1',
              claimKey: 'claim.posix-1',
              claim: `Verified fact for POSIX taskpack ${posixName}`,
              baseRevision: posixHead,
              codeFingerprint: posixFp,
              verifiedAtMs: nowMs,
              taskpack: posixName,
            }),
          }],
          nowMs + 10,
          'prop.posix-seed',
        );
        await writeProjectedStoreToDisk(posixRepo, posixProj, posixName);
        await git(posixRepo, ['add', '.auto-sync/memory']);
        await git(posixRepo, ['commit', '-m', `seed active memory for ${posixName}`]);
        const posixSeedSha = await git(posixRepo, ['rev-parse', 'HEAD']);

        const loadedPosix = await loadDeclarativeTaskpack({
          repositoryRoot: posixRepo,
          manifestPath: '.auto-sync/taskpack.yaml',
        });
        const compiledPosix = await compileDeclarativeTaskpack(loadedPosix, {
          repository: 'acme/repo',
          repositoryRoot: posixRepo,
          taskpackPath: '.auto-sync/taskpack.yaml',
          baseRevision: posixSeedSha,
          sourceRevision: posixSeedSha,
          mode: 'candidate',
          allowManifestCustomBaseUrl: true,
          budgets: DEFAULT_HOST_BUDGETS,
          publicationEndpoint: {
            id: 'pub-1',
            url: 'http://127.0.0.1:9/publish',
            signingCredentialRef: 'pub-sign',
            authCredentialRef: null,
          },
          credentialEnvMap: { provider: 'LLM_TOKEN', publication: 'PUB_SIGN_ENV' },
          upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
          nowMs: nowMs + 100,
        });
        assert.equal(compiledPosix.activeMemory?.activeEntryCount, 1);
        assert.match(compiledPosix.activeMemory?.resourcePath ?? '', /^\.loopwright-taskpack\/memory-/);

        const stepRootPosix = join(work, `step-${posixName.replace('.', '_')}`);
        await mkdir(stepRootPosix, { recursive: true });
        const stagedPosix = await stageTaskpackForStep({
          repositoryRoot: posixRepo,
          taskpackPath: '.auto-sync/taskpack.yaml',
          runRoot: stepRootPosix,
          runId: 'step-posix-1',
          mode: 'candidate',
          discoverUpstreams: false,
          upstreamRecordsJson: JSON.stringify([{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }]),
          runtimeEnv: {
            PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
            LOOPWRIGHT_REPOSITORY: 'acme/repo',
            GITHUB_SHA: posixSeedSha,
          },
        });
        const snapAbs = join(dirname(stagedPosix.registryPath), ...compiledPosix.activeMemory!.resourcePath!.split('/'));
        const snapStat = await stat(snapAbs);
        assert.equal(snapStat.mode & 0o777, 0o400);
      }
    } finally {
      await mcpServer?.close();
      await openAiServer?.close();
      await githubServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });
});
