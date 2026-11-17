import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
} from '@loopwright/memory';
import {
  SecretScrubber,
  finalizeAndPublishTurnkeyMemory,
  findOpenMemoryPullRequest,
  loadDeclarativeTaskpack,
  runGitHubActionEntrypoint,
  writeActionOutputSinks,
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

function buildMemEntry(params: {
  readonly id: string;
  readonly claimKey: string;
  readonly claim: string;
  readonly baseRevision: string;
  readonly codeFingerprint: { readonly algorithm: 'sha256'; readonly hex: string };
  readonly verifiedAtMs: number;
  readonly upstreamVersion?: string;
}): MemoryEntry {
  const evidenceDigest = hashDomain('cas-ev', { id: params.id, claim: params.claim });
  return {
    version: 1,
    id: params.id,
    claimKey: params.claimKey,
    claim: params.claim,
    kind: 'fact',
    scope: {
      taskpack: 'auto-sync',
      repository: 'acme/repo',
      paths: ['docs/**', 'pack/**'],
      targetMatrix: null,
    },
    sourceRef: {
      runId: 'seed-cas',
      lockHash: hashDomain('cas-lock', params.id),
      candidateDigest: hashDomain('cas-cand', params.id),
    },
    sourceDigest: hashDomain('cas-src', { id: params.id, claim: params.claim }),
    verifiedAtMs: params.verifiedAtMs,
    validFor: {
      baseRevision: params.baseRevision,
      sourceRevision: params.baseRevision,
      codeFingerprint: params.codeFingerprint,
      upstreamVersions: { engine: params.upstreamVersion ?? 'v2.0.0' },
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

async function writeProjectedStore(
  targetRepo: string,
  projection: ReturnType<typeof projectMemoryStore>,
): Promise<void> {
  const memDir = join(targetRepo, '.auto-sync', 'memory', 'auto-sync');
  const entriesDir = join(memDir, 'entries');
  await rm(memDir, { recursive: true, force: true });
  await mkdir(entriesDir, { recursive: true });
  for (const [entryId, bytes] of projection.entryFiles.entries()) {
    await writeFile(join(entriesDir, `${entryId}.md`), bytes);
  }
  for (const row of projection.index.retired) {
    if (!projection.entryFiles.has(row.entry.id)) {
      await writeFile(join(entriesDir, `${row.entry.id}.md`), entryFileBytes(row.entry));
    }
  }
  await writeFile(join(memDir, 'index.json'), canonical(projection.index), 'utf8');
}

describe('turnkey @loopwright/memory CAS, PR binding, and remote merge guards', () => {
  it('enforces PR lookup repo/fork/base/pagination guards, output sink gating, porcelain push parsing on "(stale info).git", and unmerged branch detection', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'lw-mem-cas-1-')));
    const staleNamedRemote = join(work, 'remote (stale info).git');
    const repo = join(work, 'repo');
    const runRoot = join(work, 'runs');
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let githubServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;

    try {
      const scrubber = new SecretScrubber();
      scrubber.register('ghp_cas_token_123');

      // 1. Rejects missing/null head.repo, cross-repo fork, or missing/mismatched base.ref
      const badItems = [
        {
          number: 1,
          html_url: 'https://github.invalid/acme/repo/pull/1',
          head: { ref: 'loopwright/memory/auto-sync/main', sha: 'a'.repeat(40), repo: null },
          base: { ref: 'main' },
        },
        {
          number: 2,
          html_url: 'https://github.invalid/acme/repo/pull/2',
          head: { ref: 'loopwright/memory/auto-sync/main', sha: 'a'.repeat(40), repo: { full_name: 'attacker/repo', fork: true } },
          base: { ref: 'main' },
        },
        {
          number: 3,
          html_url: 'https://github.invalid/acme/repo/pull/3',
          head: { ref: 'loopwright/memory/auto-sync/main', sha: 'a'.repeat(40), repo: { full_name: 'acme/repo', fork: false } },
          base: {},
        },
        {
          number: 4,
          html_url: 'https://github.invalid/acme/repo/pull/4',
          head: { ref: 'loopwright/memory/auto-sync/main', sha: 'a'.repeat(40), repo: { full_name: 'acme/repo', fork: false } },
          base: { ref: 'release' },
        },
      ];
      const rejectedPrLookup = await findOpenMemoryPullRequest({
        apiBaseUrl: 'https://api.github.invalid',
        repositoryFullName: 'acme/repo',
        targetBranch: 'main',
        memoryBranch: 'loopwright/memory/auto-sync/main',
        githubToken: 'ghp_cas_token_123',
        scrubber,
        fetchImpl: async () => new Response(JSON.stringify(badItems), { status: 200 }),
      });
      assert.equal(rejectedPrLookup, null);

      // 2. `writeActionOutputSinks` emits `memory-pr-url` ONLY for `published` / `updated` (never `refused`)
      const refusedOutPath = join(work, 'gh-output-refused.txt');
      const publishedOutPath = join(work, 'gh-output-published.txt');
      const baseReport = {
        runId: 'run-out-check',
        status: 'completed' as const,
        summary: 'ok',
        checks: [],
        externalUrl: 'https://github.invalid/acme/repo/pull/10',
      };
      await writeActionOutputSinks({
        report: baseReport,
        formats: ['text'],
        actionResultJson: '{}',
        githubOutputPath: refusedOutPath,
        includeExtendedGithubOutputs: true,
        logSink: () => undefined,
        memory: {
          status: 'refused',
          directory: '.auto-sync/memory/auto-sync',
          proposalId: 'prop.1',
          entryCount: 0,
          rebased: false,
          branchName: 'loopwright/memory/auto-sync/main',
          pullRequestUrl: 'https://github.invalid/acme/repo/pull/99',
          pullRequestNumber: 99,
          reason: 'MEMORY_CAS_CONFLICT',
        },
      });
      assert.equal((await readFile(refusedOutPath, 'utf8')).includes('https://github.invalid/acme/repo/pull/99'), false);

      await writeActionOutputSinks({
        report: baseReport,
        formats: ['text'],
        actionResultJson: '{}',
        githubOutputPath: publishedOutPath,
        includeExtendedGithubOutputs: true,
        logSink: () => undefined,
        memory: {
          status: 'published',
          directory: '.auto-sync/memory/auto-sync',
          proposalId: 'prop.1',
          entryCount: 1,
          rebased: false,
          branchName: 'loopwright/memory/auto-sync/main',
          pullRequestUrl: 'https://github.invalid/acme/repo/pull/99',
          pullRequestNumber: 99,
          reason: null,
        },
      });
      assert.equal((await readFile(publishedOutPath, 'utf8')).includes('https://github.invalid/acme/repo/pull/99'), true);

      // 3. Setup mock GitHub API for fork-self-repo PR lookup, deep-page head filtering, and pagination exhaustion
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
          const base = url.searchParams.get('base') ?? '';
          const head = url.searchParams.get('head') ?? '';
          const page = Number(url.searchParams.get('page') ?? '1');
          if (base === 'fork-self-test') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify([
              {
                number: 400,
                html_url: 'https://github.invalid/acme/repo/pull/400',
                state: 'open',
                head: { ref: 'loopwright/memory/auto-sync/fork-self-test', sha: 'a'.repeat(40), repo: { id: 999, full_name: 'attacker/repo', fork: true } },
                base: { ref: 'fork-self-test', repo: { id: 901, full_name: 'acme/repo', fork: true } },
              },
              {
                number: 101,
                html_url: 'https://github.invalid/acme/repo/pull/101',
                state: 'open',
                head: { ref: 'loopwright/memory/auto-sync/fork-self-test', sha: 'b'.repeat(40), repo: { id: 901, full_name: 'acme/repo', fork: true } },
                base: { ref: 'fork-self-test', repo: { id: 901, full_name: 'acme/repo', fork: true } },
              },
            ]));
            return;
          }
          if (base === 'deep-page-test' && head === 'acme:loopwright/memory/auto-sync/deep-page-test') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify([{
              number: 601,
              html_url: 'https://github.invalid/acme/repo/pull/601',
              state: 'open',
              head: { ref: 'loopwright/memory/auto-sync/deep-page-test', sha: '3'.repeat(40), repo: { id: 901, full_name: 'acme/repo', fork: false } },
              base: { ref: 'deep-page-test', sha: '4'.repeat(40), repo: { id: 901, full_name: 'acme/repo', fork: false } },
            }]));
            return;
          }
          if (base === 'exhaust-test') {
            const hundred = Array.from({ length: 100 }, (_, idx) => ({
              number: (page - 1) * 100 + idx + 1,
              html_url: `https://github.invalid/acme/repo/pull/${(page - 1) * 100 + idx + 1}`,
              state: 'open',
              head: { ref: `feature/other-${page}-${idx}`, sha: '1'.repeat(40), repo: { id: 901, full_name: 'acme/repo', fork: false } },
              base: { ref: 'exhaust-test', sha: '2'.repeat(40), repo: { id: 901, full_name: 'acme/repo', fork: false } },
            }));
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(hundred));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('[]');
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'POST') {
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ number: 90, html_url: 'https://github.invalid/acme/repo/pull/90' }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      const matchedForkSelf = await findOpenMemoryPullRequest({
        apiBaseUrl: githubServer.url,
        repositoryFullName: 'acme/repo',
        targetBranch: 'fork-self-test',
        memoryBranch: 'loopwright/memory/auto-sync/fork-self-test',
        githubToken: 'ghp_cas_token_123',
        scrubber,
      });
      assert.equal(matchedForkSelf?.number, 101);

      const foundDeepPr = await findOpenMemoryPullRequest({
        apiBaseUrl: githubServer.url,
        repositoryFullName: 'acme/repo',
        targetBranch: 'deep-page-test',
        memoryBranch: 'loopwright/memory/auto-sync/deep-page-test',
        githubToken: 'ghp_cas_token_123',
        scrubber,
      });
      assert.equal(foundDeepPr?.number, 601);

      await assert.rejects(
        () => findOpenMemoryPullRequest({
          apiBaseUrl: githubServer!.url,
          repositoryFullName: 'acme/repo',
          targetBranch: 'exhaust-test',
          memoryBranch: 'loopwright/memory/auto-sync/exhaust-test',
          githubToken: 'ghp_cas_token_123',
          scrubber,
        }),
        /exhausted pagination/,
      );

      // 4. Remote directory named `remote (stale info).git` failing via pre-receive hook + unmerged upstreamVersions / retirement detection
      await mkdir(staleNamedRemote, { recursive: true });
      await mkdir(repo, { recursive: true });
      await mkdir(runRoot, { recursive: true });
      await git(staleNamedRemote, ['init', '--bare', '--initial-branch=main']);
      await git(repo, ['init', '--initial-branch=main']);
      await git(repo, ['remote', 'add', 'origin', staleNamedRemote]);
      await mkdir(join(repo, '.auto-sync', 'prompts'), { recursive: true });
      await mkdir(join(repo, '.auto-sync', 'checks'), { recursive: true });
      await mkdir(join(repo, 'docs'), { recursive: true });
      await mkdir(join(repo, 'pack'), { recursive: true });
      await writeFile(join(repo, '.auto-sync', 'prompts', 'instructions.md'), '# Guide\n', 'utf8');
      await writeFile(join(repo, 'docs', 'status.md'), 'verified-v2\n', 'utf8');
      await writeFile(join(repo, 'pack', 'proposal.json'), '{"schema_version":1,"version":"1.0.0"}\n', 'utf8');
      await writeFile(join(repo, 'pack', 'frozen.json'), '{"locked":true}\n', 'utf8');
      await writeFile(
        join(repo, '.auto-sync', 'checks', 'verify.sh'),
        '#!/bin/sh\ngrep -q \'"2.0.0"\' "$LOOPWRIGHT_CANDIDATE_DIR/pack/proposal.json"\n',
        { mode: 0o755 },
      );
      await chmod(join(repo, '.auto-sync', 'checks', 'verify.sh'), 0o755);

      let turn = 0;
      openAiServer = await startHttpServer(async (req, res) => {
        await readJsonBody(req);
        const cur = turn++;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (cur === 0) {
          res.end(sseToolCall('gpt-4.1-mini', 'c1', 'write', {
            path: 'pack/proposal.json',
            content: '{"schema_version":2,"version":"2.0.0"}\n',
          }));
          return;
        }
        res.end(sseStop('gpt-4.1-mini', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null })));
      });

      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), makeTaskpackYaml(openAiServer.url), 'utf8');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'init repo']);
      const baseSha0 = await git(repo, ['rev-parse', 'HEAD']);
      const docsFp = await computeCodeFingerprint(repo, ['docs/**', 'pack/**'], '.auto-sync/memory');
      const nowMs = Date.now();
      const seedProj = projectMemoryStore(
        emptyMemoryStoreIndex('auto-sync', 'acme/repo', nowMs),
        [
          {
            kind: 'upsert',
            entry: buildMemEntry({ id: 'entry.mcp-000', claimKey: 'claim.mcp-000', claim: 'Fact 0', baseRevision: baseSha0, codeFingerprint: docsFp, verifiedAtMs: nowMs }),
          },
          {
            kind: 'upsert',
            entry: buildMemEntry({ id: 'entry.mcp-001', claimKey: 'claim.mcp-001', claim: 'Fact 1', baseRevision: baseSha0, codeFingerprint: docsFp, verifiedAtMs: nowMs }),
          },
        ],
        nowMs + 10,
        'prop.seed',
      );
      await writeProjectedStore(repo, seedProj);
      await git(repo, ['add', '.auto-sync/memory']);
      await git(repo, ['commit', '-m', 'seed 2 memory entries']);
      const mainSha = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['push', 'origin', 'HEAD:refs/heads/main']);

      // Settle primary run locally without remote memory publication
      turn = 0;
      const primary = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 901,
        baseRevision: mainSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-cas-1',
        turnkey: true,
        allowManifestCustomBaseUrl: true,
        githubApiBaseUrl: githubServer.url,
        githubToken: '',
        gitRemoteUrl: '',
        openHostSessionAdapter: fastAdapter,
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-cas-llm-token-123456',
        },
      });
      assert.equal(primary.kind, 'compiled');

      const loadedManifest = await loadDeclarativeTaskpack({ manifestPath: '.auto-sync/taskpack.yaml', repositoryRoot: repo });
      const memBranch = 'loopwright/memory/auto-sync/main';

      // Pre-receive hook failure on `remote (stale info).git` MUST NOT be misclassified as stale lease rejection; preserves `uncertain` receipt!
      const preReceiveHookPath = join(staleNamedRemote, 'hooks', 'pre-receive');
      await writeFile(preReceiveHookPath, '#!/bin/sh\necho "storage backend timeout" >&2\nexit 1\n', { mode: 0o755 });
      await chmod(preReceiveHookPath, 0o755);
      try {
        const hookFailRes = await finalizeAndPublishTurnkeyMemory({
          repositoryRoot: repo,
          taskpackPath: '.auto-sync/taskpack.yaml',
          manifest: loadedManifest,
          repositoryFullName: 'acme/repo',
          baseRevision: mainSha,
          runRoot,
          runId: 'run-cas-1',
          upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
          scrubber,
          githubToken: 'ghp_cas_token_123',
          apiBaseUrl: githubServer.url,
          remoteUrl: staleNamedRemote,
        });
        assert.equal(hookFailRes.status, 'reconcile_required', `got ${hookFailRes.status}: ${hookFailRes.reason ?? ''}`);
        const preservedReceipt = JSON.parse(await readFile(join(runRoot, 'run-cas-1', 'memory-publication.json'), 'utf8')) as { state?: string };
        assert.equal(preservedReceipt.state, 'uncertain');
      } finally {
        await unlink(preReceiveHookPath).catch(() => undefined);
        await unlink(join(runRoot, 'run-cas-1', 'memory-publication.json')).catch(() => undefined);
      }

      // Unmerged `validFor.upstreamVersions` update on closed-PR remote branch -> `reconcile_required` (never overwritten as merged!)
      const unmergedClone = join(work, 'unmerged-mem-clone');
      await git(work, ['clone', staleNamedRemote, unmergedClone]);
      const base000 = seedProj.index.entries.find(e => e.id === 'entry.mcp-000')!;
      const updated000 = {
        ...base000,
        validFor: { ...base000.validFor, upstreamVersions: { engine: 'v2.1.0' } },
      };
      const projUnmergedUpstream = projectMemoryStore(
        seedProj.index,
        [
          { kind: 'retire', entryId: 'entry.mcp-000', reason: 'bump upstream validity' },
          { kind: 'upsert', entry: updated000 },
        ],
        nowMs + 500,
        'prop.unmerged-upstream',
      );
      await writeProjectedStore(unmergedClone, projUnmergedUpstream);
      await git(unmergedClone, ['add', '.auto-sync/memory']);
      await git(unmergedClone, ['commit', '-m', 'memory(auto-sync): unmerged upstream bump']);
      await git(unmergedClone, ['push', 'origin', `HEAD:refs/heads/${memBranch}`]);

      const preserveUpstreamRes = await finalizeAndPublishTurnkeyMemory({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest: loadedManifest,
        repositoryFullName: 'acme/repo',
        baseRevision: mainSha,
        runRoot,
        runId: 'run-cas-1',
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        scrubber,
        githubToken: 'ghp_cas_token_123',
        apiBaseUrl: githubServer.url,
        remoteUrl: staleNamedRemote,
      });
      assert.equal(preserveUpstreamRes.status, 'reconcile_required');

      // Unmerged pure retirement (`entry.mcp-001` retired on remote branch while still active on `main`) -> `reconcile_required`!
      await git(unmergedClone, ['reset', '--hard', mainSha]);
      const projUnmergedRetire = projectMemoryStore(
        seedProj.index,
        [{ kind: 'retire', entryId: 'entry.mcp-001', reason: 'obsolete entry retired on memory branch' }],
        nowMs + 600,
        'prop.unmerged-retire',
      );
      await writeProjectedStore(unmergedClone, projUnmergedRetire);
      await git(unmergedClone, ['add', '.auto-sync/memory']);
      await git(unmergedClone, ['commit', '-m', 'memory(auto-sync): unmerged retirement']);
      await git(unmergedClone, ['push', '--force', 'origin', `HEAD:refs/heads/${memBranch}`]);

      const preserveRetireRes = await finalizeAndPublishTurnkeyMemory({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest: loadedManifest,
        repositoryFullName: 'acme/repo',
        baseRevision: mainSha,
        runRoot,
        runId: 'run-cas-1',
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        scrubber,
        githubToken: 'ghp_cas_token_123',
        apiBaseUrl: githubServer.url,
        remoteUrl: staleNamedRemote,
      });
      assert.equal(preserveRetireRes.status, 'reconcile_required');
      const verifyRetireClone = join(work, 'verify-unmerged-retire');
      await git(work, ['clone', '--branch', memBranch, staleNamedRemote, verifyRetireClone]);
      const verifyRetireStore = await loadMemoryStore(verifyRetireClone, 'auto-sync', 'acme/repo', '.auto-sync/memory');
      assert.equal(verifyRetireStore.index.entries.some(e => e.id === 'entry.mcp-001'), false);
    } finally {
      await openAiServer?.close();
      await githubServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('enforces target-fetch fail-closed CAS, retained-run cross-repo binding refusal, PR response base/head bindings, and read-only GET head.sha confirmation', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'lw-mem-cas-2-')));
    const bareRemote = join(work, 'remote.git');
    const repo = join(work, 'repo');
    const runRoot = join(work, 'runs');
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let githubServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;

    try {
      await mkdir(bareRemote, { recursive: true });
      await git(bareRemote, ['init', '--bare', '--initial-branch=main']);

      let turn = 0;
      let writeSchemaVersion = 1;
      openAiServer = await startHttpServer(async (req, res) => {
        await readJsonBody(req);
        const cur = turn++;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (cur === 0) {
          res.end(sseToolCall('gpt-4.1-mini', 'c1', 'write', {
            path: 'pack/proposal.json',
            content: `{"schema_version":${writeSchemaVersion},"version":"2.0.0"}\n`,
          }));
          return;
        }
        res.end(sseStop('gpt-4.1-mini', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null })));
      });

      let openMemoryPr: Record<string, unknown> | null = null;
      let patchMode: 'normal' | 'retargeted_base' | 'missing_sha_no_get' | 'stale_sha_concurrent_reset' | 'stale_sha_lagging_then_confirmed' = 'normal';
      let priorMemoryHeadSha = '';
      let patchCount = 0;
      let getSinglePrCalls = 0;

      githubServer = await startHttpServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/repos/acme/engine/releases/latest' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v2.0.0' }));
          return;
        }
        if (url.pathname === '/repos/acme/repo' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 961 }));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'GET') {
          if (openMemoryPr !== null) {
            const lsOut = await git(repo, ['ls-remote', bareRemote, 'refs/heads/loopwright/memory/auto-sync/main']).catch(() => '');
            const curSha = lsOut.split(/\s+/)[0] ?? '';
            if (curSha.length > 0) {
              const prevHead = openMemoryPr['head'] as Record<string, unknown>;
              openMemoryPr = { ...openMemoryPr, head: { ...prevHead, sha: curSha } };
            }
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(openMemoryPr !== null ? [openMemoryPr] : []));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'POST') {
          const payload = await readJsonBody(req);
          const headRef = String(payload['head'] ?? '');
          const lsOut = await git(repo, ['ls-remote', bareRemote, `refs/heads/${headRef}`]);
          const remoteSha = lsOut.split(/\s+/)[0] ?? '';
          if (headRef.startsWith('loopwright/memory/')) {
            priorMemoryHeadSha = remoteSha;
            openMemoryPr = {
              number: 201,
              html_url: 'https://github.invalid/acme/repo/pull/201',
              state: 'open',
              title: String(payload['title'] ?? ''),
              body: String(payload['body'] ?? ''),
              head: { ref: headRef, sha: remoteSha, repo: { id: 961, full_name: 'acme/repo', fork: true } },
              base: { ref: String(payload['base'] ?? 'main'), repo: { id: 961, full_name: 'acme/repo', fork: true } },
            };
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(JSON.stringify(openMemoryPr));
            return;
          }
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ number: 200, html_url: 'https://github.invalid/acme/repo/pull/200' }));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls/201' && req.method === 'PATCH') {
          patchCount += 1;
          const payload = await readJsonBody(req);
          const lsOut = await git(repo, ['ls-remote', bareRemote, 'refs/heads/loopwright/memory/auto-sync/main']);
          const remoteSha = lsOut.split(/\s+/)[0] ?? '';
          if (patchMode === 'retargeted_base') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              number: 201,
              html_url: 'https://github.invalid/acme/repo/pull/201',
              state: 'open',
              head: { ref: 'loopwright/memory/auto-sync/main', sha: remoteSha, repo: { id: 961, full_name: 'acme/repo', fork: true } },
              base: { ref: 'release', repo: { id: 961, full_name: 'acme/repo', fork: true } },
            }));
            return;
          }
          if (patchMode === 'missing_sha_no_get') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              number: 201,
              html_url: 'https://github.invalid/acme/repo/pull/201',
              state: 'open',
              head: { ref: 'loopwright/memory/auto-sync/main', repo: { id: 961, full_name: 'acme/repo', fork: true } },
              base: { ref: 'main', repo: { id: 961, full_name: 'acme/repo', fork: true } },
            }));
            return;
          }
          if (patchMode === 'stale_sha_concurrent_reset') {
            await git(bareRemote, ['update-ref', 'refs/heads/loopwright/memory/auto-sync/main', priorMemoryHeadSha]);
            openMemoryPr = {
              number: 201,
              html_url: 'https://github.invalid/acme/repo/pull/201',
              state: 'open',
              title: String(payload['title'] ?? ''),
              body: String(payload['body'] ?? ''),
              head: { ref: 'loopwright/memory/auto-sync/main', sha: priorMemoryHeadSha, repo: { id: 961, full_name: 'acme/repo', fork: true } },
              base: { ref: 'main', repo: { id: 961, full_name: 'acme/repo', fork: true } },
            };
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(openMemoryPr));
            return;
          }
          if (patchMode === 'stale_sha_lagging_then_confirmed') {
            openMemoryPr = {
              number: 201,
              html_url: 'https://github.invalid/acme/repo/pull/201',
              state: 'open',
              title: String(payload['title'] ?? ''),
              body: String(payload['body'] ?? ''),
              head: { ref: 'loopwright/memory/auto-sync/main', sha: remoteSha, repo: { id: 961, full_name: 'acme/repo', fork: true } },
              base: { ref: 'main', repo: { id: 961, full_name: 'acme/repo', fork: true } },
            };
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              ...openMemoryPr,
              head: { ref: 'loopwright/memory/auto-sync/main', sha: priorMemoryHeadSha, repo: { id: 961, full_name: 'acme/repo', fork: true } },
            }));
            return;
          }
          openMemoryPr = {
            number: 201,
            html_url: 'https://github.invalid/acme/repo/pull/201',
            state: 'open',
            title: String(payload['title'] ?? ''),
            body: String(payload['body'] ?? ''),
            head: { ref: 'loopwright/memory/auto-sync/main', sha: remoteSha, repo: { id: 961, full_name: 'acme/repo', fork: true } },
            base: { ref: 'main', repo: { id: 961, full_name: 'acme/repo', fork: true } },
          };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(openMemoryPr));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls/201' && req.method === 'GET') {
          getSinglePrCalls += 1;
          if (patchMode === 'missing_sha_no_get') {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ message: 'not found' }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(openMemoryPr));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      const scrubber = new SecretScrubber();
      scrubber.register('ghp_p6_token_123456');

      await mkdir(repo, { recursive: true });
      await mkdir(runRoot, { recursive: true });
      await git(repo, ['init', '--initial-branch=main']);
      await git(repo, ['remote', 'add', 'origin', bareRemote]);
      await mkdir(join(repo, '.auto-sync', 'prompts'), { recursive: true });
      await mkdir(join(repo, '.auto-sync', 'checks'), { recursive: true });
      await mkdir(join(repo, 'docs'), { recursive: true });
      await mkdir(join(repo, 'pack'), { recursive: true });
      await writeFile(join(repo, '.auto-sync', 'prompts', 'instructions.md'), '# Guide\n', 'utf8');
      await writeFile(join(repo, 'docs', 'status.md'), 'verified-v2\n', 'utf8');
      await writeFile(join(repo, 'pack', 'proposal.json'), '{"schema_version":1,"version":"1.0.0"}\n', 'utf8');
      await writeFile(join(repo, 'pack', 'frozen.json'), '{"locked":true}\n', 'utf8');
      await writeFile(
        join(repo, '.auto-sync', 'checks', 'verify.sh'),
        '#!/bin/sh\ngrep -q \'"2.0.0"\' "$LOOPWRIGHT_CANDIDATE_DIR/pack/proposal.json"\n',
        { mode: 0o755 },
      );
      await chmod(join(repo, '.auto-sync', 'checks', 'verify.sh'), 0o755);
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), makeTaskpackYaml(openAiServer.url), 'utf8');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'init cas-2']);
      const baseSha = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['push', 'origin', 'HEAD:refs/heads/main']);

      turn = 0;
      const run1 = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 961,
        baseRevision: baseSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-cas2-1',
        turnkey: true,
        allowManifestCustomBaseUrl: true,
        githubApiBaseUrl: githubServer.url,
        githubToken: 'ghp_p6_token_123456',
        gitRemoteUrl: bareRemote,
        openHostSessionAdapter: fastAdapter,
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-p6-llm-token-123456',
        },
      });
      assert.equal(run1.kind, 'compiled');
      if (run1.kind === 'compiled') {
        assert.equal(run1.memory?.status, 'published');
        assert.equal(run1.memory?.pullRequestNumber, 201);
      }

      const loadedManifest = await loadDeclarativeTaskpack({ manifestPath: '.auto-sync/taskpack.yaml', repositoryRoot: repo });

      // Produce a second settled run (`run-cas2-2`) with `failure_observation` without publishing yet
      turn = 0;
      writeSchemaVersion = 2;
      const run2Primary = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 961,
        baseRevision: baseSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-cas2-2',
        turnkey: true,
        allowManifestCustomBaseUrl: true,
        githubApiBaseUrl: githubServer.url,
        githubToken: '',
        gitRemoteUrl: '',
        openHostSessionAdapter: fastAdapter,
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-p6-llm-token-123456',
        },
      });
      assert.equal(run2Primary.kind, 'compiled');

      // 1. Publishing retained `acme/repo` run (`run-cas2-2`) to `other/repo` MUST be refused!
      const otherBareRemote = join(work, 'other-remote.git');
      await mkdir(otherBareRemote, { recursive: true });
      await git(otherBareRemote, ['init', '--bare', '--initial-branch=main']);
      await git(repo, ['push', otherBareRemote, 'HEAD:refs/heads/main']);
      const crossRepoRefused = await finalizeAndPublishTurnkeyMemory({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest: loadedManifest,
        repositoryFullName: 'other/repo',
        baseRevision: baseSha,
        runRoot,
        runId: 'run-cas2-2',
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        scrubber,
        githubToken: 'ghp_p6_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: otherBareRemote,
      });
      assert.equal(crossRepoRefused.status, 'refused');
      assert.match(crossRepoRefused.reason ?? '', /MEMORY_SCOPE_VIOLATION: retained run repository "acme\/repo" does not match publication repository "other\/repo"/);

      // 2. Diverge remote `main` memory store -> `refused`, and target-fetch failure (`refs/heads/main` missing) -> `failed` (fail-closed!)
      const divergeClone = join(work, 'diverge-clone');
      await git(work, ['-c', 'protocol.file.allow=always', 'clone', bareRemote, divergeClone]);
      const divergeFp = await computeCodeFingerprint(divergeClone, ['docs/**', 'pack/**'], '.auto-sync/memory');
      const nowDiv = Date.now();
      const divProj = projectMemoryStore(
        emptyMemoryStoreIndex('auto-sync', 'acme/repo', nowDiv),
        [{
          kind: 'upsert',
          entry: buildMemEntry({
            id: 'entry.diverged-main',
            claimKey: 'claim.diverged-main',
            claim: 'Out-of-band diverged memory entry on main',
            baseRevision: baseSha,
            codeFingerprint: divergeFp,
            verifiedAtMs: nowDiv,
          }),
        }],
        nowDiv + 10,
        'prop.diverged-main',
      );
      await writeProjectedStore(divergeClone, divProj);
      await git(divergeClone, ['add', '.auto-sync/memory']);
      await git(divergeClone, ['commit', '-m', 'chore(memory): diverge main store']);
      const divergedMainSha = await git(divergeClone, ['rev-parse', 'HEAD']);
      await git(divergeClone, ['push', 'origin', 'HEAD:refs/heads/main']);

      const normalDivergedRes = await finalizeAndPublishTurnkeyMemory({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest: loadedManifest,
        repositoryFullName: 'acme/repo',
        baseRevision: baseSha,
        runRoot,
        runId: 'run-cas2-2',
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        scrubber,
        githubToken: 'ghp_p6_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: bareRemote,
      });
      assert.equal(normalDivergedRes.status, 'refused');

      await git(bareRemote, ['symbolic-ref', 'HEAD', 'refs/heads/temp-default']);
      await git(bareRemote, ['update-ref', 'refs/heads/temp-default', divergedMainSha]);
      await git(bareRemote, ['update-ref', '-d', 'refs/heads/main']);
      try {
        const failedFetchRes = await finalizeAndPublishTurnkeyMemory({
          repositoryRoot: repo,
          taskpackPath: '.auto-sync/taskpack.yaml',
          manifest: loadedManifest,
          repositoryFullName: 'acme/repo',
          baseRevision: baseSha,
          runRoot,
          runId: 'run-cas2-2',
          upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
          scrubber,
          githubToken: 'ghp_p6_token_123456',
          apiBaseUrl: githubServer.url,
          remoteUrl: bareRemote,
        });
        assert.equal(failedFetchRes.status, 'failed');
        assert.match(failedFetchRes.reason ?? '', /failed to fetch remote target branch "main"/);
        assert.equal(patchCount, 0);
      } finally {
        await git(bareRemote, ['update-ref', 'refs/heads/main', baseSha]);
        await git(bareRemote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
        await git(bareRemote, ['update-ref', '-d', 'refs/heads/temp-default']);
      }

      // 3. Pre-dispatch receipt write failure (`EACCES` on `0o500` run dir) fails cleanly before any remote push
      const run2Dir = join(runRoot, 'run-cas2-2');
      await chmod(run2Dir, 0o500);
      try {
        const receiptWriteFailRes = await finalizeAndPublishTurnkeyMemory({
          repositoryRoot: repo,
          taskpackPath: '.auto-sync/taskpack.yaml',
          manifest: loadedManifest,
          repositoryFullName: 'acme/repo',
          baseRevision: baseSha,
          runRoot,
          runId: 'run-cas2-2',
          upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
          scrubber,
          githubToken: 'ghp_p6_token_123456',
          apiBaseUrl: githubServer.url,
          remoteUrl: bareRemote,
        });
        assert.equal(receiptWriteFailRes.status, 'failed');
        assert.equal(patchCount, 0);
      } finally {
        await chmod(run2Dir, 0o700);
      }

      // 4. Retargeted PATCH response (`base.ref: 'release'`) retains `reconcile_required`
      patchMode = 'retargeted_base';
      const retargetedRes = await finalizeAndPublishTurnkeyMemory({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest: loadedManifest,
        repositoryFullName: 'acme/repo',
        baseRevision: baseSha,
        runRoot,
        runId: 'run-cas2-2',
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        scrubber,
        githubToken: 'ghp_p6_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: bareRemote,
      });
      assert.equal(retargetedRes.status, 'reconcile_required');
      assert.match(retargetedRes.reason ?? '', /base binding did not match "acme\/repo:main"/);

      // Reset remote memory branch back to `priorMemoryHeadSha` and clear receipt to test `missing_sha_no_get`
      await git(bareRemote, ['update-ref', 'refs/heads/loopwright/memory/auto-sync/main', priorMemoryHeadSha]);
      await unlink(join(run2Dir, 'memory-publication.json'));

      patchMode = 'missing_sha_no_get';
      const missingShaRes = await finalizeAndPublishTurnkeyMemory({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest: loadedManifest,
        repositoryFullName: 'acme/repo',
        baseRevision: baseSha,
        runRoot,
        runId: 'run-cas2-2',
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        scrubber,
        githubToken: 'ghp_p6_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: bareRemote,
      });
      assert.equal(missingShaRes.status, 'reconcile_required');

      // Reset remote memory branch back to `priorMemoryHeadSha` and clear receipt to test `stale_sha_concurrent_reset`
      await git(bareRemote, ['update-ref', 'refs/heads/loopwright/memory/auto-sync/main', priorMemoryHeadSha]);
      await unlink(join(run2Dir, 'memory-publication.json'));

      patchMode = 'stale_sha_concurrent_reset';
      const concurrentResetRes = await finalizeAndPublishTurnkeyMemory({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest: loadedManifest,
        repositoryFullName: 'acme/repo',
        baseRevision: baseSha,
        runRoot,
        runId: 'run-cas2-2',
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        scrubber,
        githubToken: 'ghp_p6_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: bareRemote,
      });
      assert.equal(concurrentResetRes.status, 'reconcile_required');

      // Remote was reset to `priorMemoryHeadSha`; clear receipt and test lagging PATCH + confirmed read-only GET!
      await unlink(join(run2Dir, 'memory-publication.json'));
      patchMode = 'stale_sha_lagging_then_confirmed';
      getSinglePrCalls = 0;
      const laggingConfirmedRes = await finalizeAndPublishTurnkeyMemory({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest: loadedManifest,
        repositoryFullName: 'acme/repo',
        baseRevision: baseSha,
        runRoot,
        runId: 'run-cas2-2',
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        scrubber,
        githubToken: 'ghp_p6_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: bareRemote,
      });
      assert.equal(laggingConfirmedRes.status, 'updated');
      assert.equal(getSinglePrCalls >= 1, true);
    } finally {
      await openAiServer?.close();
      await githubServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });
});
