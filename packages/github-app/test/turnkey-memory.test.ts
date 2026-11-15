import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
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
  DEFAULT_HOST_BUDGETS,
  SecretScrubber,
  compileDeclarativeTaskpack,
  finalizeAndPublishTurnkeyMemory,
  findOpenManagedPullRequest,
  findOpenMemoryPullRequest,
  loadDeclarativeTaskpack,
  readMemoryPublicationJournal,
  reconcileTurnkeyMemoryPublication,
  runActionCli,
  runGitHubActionEntrypoint,
  stageTaskpackForStep,
  writeActionOutputSinks,
} from '../src/index.js';

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

function parseGithubOutputs(raw: string): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const sep = line.indexOf('<<LOOPWRIGHT_EOF');
    if (sep > 0) {
      const name = line.slice(0, sep);
      const value = lines[i + 1] ?? '';
      result[name] = value;
      i += 2;
    }
  }
  return result;
}

function makeTaskpackYaml(
  openAiBaseUrl: string,
  onNoModelBudget: 'deterministic-observations-only' | 'skip' = 'deterministic-observations-only',
): string {
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
    onNoModelBudget: ${onNoModelBudget}
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

describe('turnkey @loopwright/memory integration (pre-run selection and separate memory PR publication)', () => {
  it('publishes a separate memory PR on Run 1, updates it via PATCH on Run 2a without PR spam, and injects 0o400 active memory into Run 2b after merge', async () => {
    const rawWork = await mkdtemp(join(tmpdir(), 'lw-turnkey-mem-e2e-'));
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
      await writeFile(join(repo, '.auto-sync', 'prompts', 'instructions.md'), '# Auto-Sync Guide\nKeep status concise.\n', 'utf8');
      await writeFile(
        join(repo, '.auto-sync', 'checks', 'verify.sh'),
        '#!/bin/sh\nset -eu\ngrep -q "verified-v2" "$LOOPWRIGHT_CANDIDATE_DIR/docs/status.md"\n',
        { mode: 0o755 },
      );
      await chmod(join(repo, '.auto-sync', 'checks', 'verify.sh'), 0o755);
      await writeFile(join(repo, 'docs', 'status.md'), 'initial-v1\n', 'utf8');
      await writeFile(join(repo, 'pack', 'proposal.json'), '{"schema_version":1,"version":"1.0.0"}\n', 'utf8');
      await writeFile(join(repo, 'pack', 'frozen.json'), '{"locked":true}\n', 'utf8');

      let runMode: 'pass_v2' | 'fail_check' = 'pass_v2';
      let turn = 0;
      const observedUserPrompts: string[] = [];

      openAiServer = await startHttpServer(async (req, res) => {
        const body = await readJsonBody(req);
        const messages = Array.isArray(body['messages']) ? body['messages'] : [];
        for (const msg of messages) {
          if (msg !== null && typeof msg === 'object' && (msg as Record<string, unknown>)['role'] === 'user') {
            const content = (msg as Record<string, unknown>)['content'];
            observedUserPrompts.push(typeof content === 'string' ? content : JSON.stringify(content ?? ''));
          }
        }
        const currentTurn = turn++;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (currentTurn === 0) {
          res.end(sseToolCall('gpt-4.1-mini', 'call-1', 'write', {
            path: 'docs/status.md',
            content: runMode === 'pass_v2' ? 'verified-v2\n' : 'broken-draft\n',
          }));
          return;
        }
        if (currentTurn === 1) {
          res.end(sseToolCall('gpt-4.1-mini', 'call-2', 'write', {
            path: 'pack/proposal.json',
            content: '{"schema_version":1,"version":"2.0.0"}\n',
          }));
          return;
        }
        res.end(sseStop('gpt-4.1-mini', JSON.stringify({
          version: 1,
          status: 'completed',
          checks: [],
          reason: null,
        })));
      });

      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), makeTaskpackYaml(openAiServer.url), 'utf8');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'chore: bootstrap repo']);
      let mainSha = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['push', 'origin', 'HEAD:refs/heads/main']);

      let openCandidatePr: { number: number; headRef: string; headSha: string; title: string; body: string } | null = null;
      let openMemoryPr: { number: number; headRef: string; headSha: string; title: string; body: string } | null = null;
      let candidatePostCount = 0;
      let memoryPostCount = 0;
      let memoryPatchCount = 0;

      githubServer = await startHttpServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/repos/acme/engine/releases/latest' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v2.0.0', html_url: 'https://github.invalid/acme/engine/releases/tag/v2.0.0' }));
          return;
        }
        if (url.pathname === '/repos/acme/repo' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 501 }));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'GET') {
          const headFilter = url.searchParams.get('head');
          const list: Record<string, unknown>[] = [];
          if (openCandidatePr !== null && (!headFilter || headFilter === `acme:${openCandidatePr.headRef}`)) {
            list.push({
              number: openCandidatePr.number,
              html_url: `https://github.invalid/acme/repo/pull/${openCandidatePr.number}`,
              title: openCandidatePr.title,
              body: openCandidatePr.body,
              state: 'open',
              base: { ref: 'main', sha: mainSha },
              head: { ref: openCandidatePr.headRef, sha: openCandidatePr.headSha, repo: { full_name: 'acme/repo', fork: false } },
            });
          }
          if (openMemoryPr !== null && (!headFilter || headFilter === `acme:${openMemoryPr.headRef}`)) {
            list.push({
              number: openMemoryPr.number,
              html_url: `https://github.invalid/acme/repo/pull/${openMemoryPr.number}`,
              title: openMemoryPr.title,
              body: openMemoryPr.body,
              state: 'open',
              base: { ref: 'main', sha: mainSha },
              head: { ref: openMemoryPr.headRef, sha: openMemoryPr.headSha, repo: { full_name: 'acme/repo', fork: false } },
            });
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(list));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'POST') {
          const payload = await readJsonBody(req);
          const headRef = String(payload['head'] ?? '');
          const lsOut = await git(repo, ['ls-remote', bareRemote, `refs/heads/${headRef}`]);
          const remoteSha = lsOut.split(/\s+/)[0] ?? '';
          if (headRef.startsWith('loopwright/memory/')) {
            memoryPostCount += 1;
            openMemoryPr = {
              number: 11,
              headRef,
              headSha: remoteSha,
              title: String(payload['title'] ?? ''),
              body: String(payload['body'] ?? ''),
            };
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              number: 11,
              html_url: 'https://github.invalid/acme/repo/pull/11',
              state: 'open',
              head: { ref: headRef, sha: remoteSha, repo: { full_name: 'acme/repo', fork: false } },
              base: { ref: 'main', sha: mainSha, repo: { full_name: 'acme/repo', fork: false } },
            }));
            return;
          }
          candidatePostCount += 1;
          openCandidatePr = {
            number: 10,
            headRef,
            headSha: remoteSha,
            title: String(payload['title'] ?? ''),
            body: String(payload['body'] ?? ''),
          };
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            number: 10,
            html_url: 'https://github.invalid/acme/repo/pull/10',
            state: 'open',
            head: { ref: headRef, sha: remoteSha, repo: { full_name: 'acme/repo', fork: false } },
            base: { ref: 'main', sha: mainSha, repo: { full_name: 'acme/repo', fork: false } },
          }));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls/11' && req.method === 'PATCH') {
          const payload = await readJsonBody(req);
          memoryPatchCount += 1;
          const lsOut = await git(repo, ['ls-remote', bareRemote, 'refs/heads/loopwright/memory/auto-sync/main']);
          const remoteSha = lsOut.split(/\s+/)[0] ?? '';
          openMemoryPr = {
            number: 11,
            headRef: 'loopwright/memory/auto-sync/main',
            headSha: remoteSha,
            title: String(payload['title'] ?? openMemoryPr?.title ?? ''),
            body: String(payload['body'] ?? openMemoryPr?.body ?? ''),
          };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            number: 11,
            html_url: 'https://github.invalid/acme/repo/pull/11',
            state: 'open',
            head: { ref: 'loopwright/memory/auto-sync/main', sha: remoteSha, repo: { full_name: 'acme/repo', fork: false } },
            base: { ref: 'main', sha: mainSha, repo: { full_name: 'acme/repo', fork: false } },
          }));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
      });

      // --- Phase 1: Run 1 (`completed`) publishes candidate PR #10 and separate memory PR #11 ---
      const summaryFile1 = join(work, 'summary-1.md');
      const outputFile1 = join(work, 'output-1.txt');
      const exitCode1 = await runActionCli({
        PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
        GITHUB_ACTIONS: 'true',
        GITHUB_WORKSPACE: repo,
        LOOPWRIGHT_REPOSITORY: 'acme/repo',
        GITHUB_SHA: mainSha,
        GITHUB_API_URL: githubServer.url,
        GITHUB_STEP_SUMMARY: summaryFile1,
        GITHUB_OUTPUT: outputFile1,
        'INPUT_TASKPACK-PATH': '.auto-sync/taskpack.yaml',
        'INPUT_EVENT-NAME': 'workflow_dispatch',
        'INPUT_RUN-ROOT': runRoot,
        'INPUT_RUN-ID': 'run-mem-phase1',
        'INPUT_ALLOW-CUSTOM-BASE-URL': 'true',
        'INPUT_GITHUB-TOKEN': 'ghp_turnkey_mem_token_123456',
        'INPUT_REMOTE-URL': bareRemote,
        'INPUT_GIT-AUTHOR-NAME': 'Memory Sync Bot',
        'INPUT_GIT-AUTHOR-EMAIL': '777+memory-bot[bot]@users.noreply.github.com',
        LLM_TOKEN: 'sk-turnkey-mem-llm-123456',
      });
      assert.equal(exitCode1, 0);
      assert.equal(candidatePostCount, 1);
      assert.equal(memoryPostCount, 1);
      assert.equal(memoryPatchCount, 0);

      // Run 1 had zero prior memory, so `<active_memory>` must be absent from Phase 1 prompts (zero-noise).
      assert.equal(observedUserPrompts.some(p => p.includes('<active_memory>')), false);

      const outputs1 = parseGithubOutputs(await readFile(outputFile1, 'utf8'));
      assert.equal(outputs1['pr-url'], 'https://github.invalid/acme/repo/pull/10');
      assert.equal(outputs1['memory-pr-url'], 'https://github.invalid/acme/repo/pull/11');
      const parsedResult1 = JSON.parse(outputs1['result'] ?? '{}') as {
        memory?: { status: string; branchName: string; pullRequestUrl: string; entryCount: number };
      };
      assert.equal(parsedResult1.memory?.status, 'published');
      assert.equal(parsedResult1.memory?.branchName, 'loopwright/memory/auto-sync/main');
      assert.equal(parsedResult1.memory?.pullRequestUrl, 'https://github.invalid/acme/repo/pull/11');
      assert.equal((parsedResult1.memory?.entryCount ?? 0) >= 2, true);
      const stepSummary1 = await readFile(summaryFile1, 'utf8');
      assert.match(stepSummary1, /Memory: `published`/);
      assert.match(stepSummary1, /https:\/\/github\.invalid\/acme\/repo\/pull\/11/);

      // Candidate branch must NOT contain `.auto-sync/memory/**`; memory branch must ONLY change `.auto-sync/memory/auto-sync/**`!
      const candidateClone = join(work, 'clone-candidate');
      await git(work, ['clone', '--branch', 'loopwright/main', bareRemote, candidateClone]);
      const candidateDiffPaths = (await git(candidateClone, ['diff', '--name-only', mainSha, 'HEAD'])).split('\n').filter(Boolean);
      assert.deepEqual(candidateDiffPaths.sort(), ['docs/status.md', 'pack/proposal.json']);

      const memoryClone1 = join(work, 'clone-mem-1');
      await git(work, ['clone', '--branch', 'loopwright/memory/auto-sync/main', bareRemote, memoryClone1]);
      const memDiffPaths1 = (await git(memoryClone1, ['diff', '--name-only', mainSha, 'HEAD'])).split('\n').filter(Boolean);
      assert.equal(memDiffPaths1.length >= 3, true);
      assert.equal(memDiffPaths1.every(p => p.startsWith('.auto-sync/memory/auto-sync/')), true);
      const memCommitMsg1 = await git(memoryClone1, ['log', '-1', '--format=%B']);
      assert.match(memCommitMsg1, /Signed-off-by: Memory Sync Bot <777\+memory-bot\[bot\]@users\.noreply\.github\.com>/);

      // Verify `findOpenManagedPullRequest` ignores `loopwright/memory/*` even though `headBranchPrefix` is `loopwright/`!
      openCandidatePr = null;
      await git(bareRemote, ['update-ref', '-d', 'refs/heads/loopwright/main']);
      const managedLookup = await findOpenManagedPullRequest({
        apiBaseUrl: githubServer.url,
        repositoryFullName: 'acme/repo',
        targetBranch: 'main',
        headBranchPrefix: 'loopwright/',
        githubToken: 'ghp_turnkey_mem_token_123456',
      });
      assert.equal(managedLookup, null, 'managed candidate PR lookup must never match loopwright/memory/*');
      const memLookup = await findOpenMemoryPullRequest({
        apiBaseUrl: githubServer.url,
        repositoryFullName: 'acme/repo',
        targetBranch: 'main',
        memoryBranch: 'loopwright/memory/auto-sync/main',
        githubToken: 'ghp_turnkey_mem_token_123456',
      });
      assert.equal(memLookup?.number, 11);

      // --- Phase 2: Advance `origin/main` by an unrelated commit while memory PR #11 is STILL OPEN, then run Run 2a (`exhausted`) ---
      const phase1BaseSha = mainSha;
      await writeFile(join(repo, 'README.md'), '# Unrelated target branch commit\n', 'utf8');
      await git(repo, ['add', 'README.md']);
      await git(repo, ['commit', '-m', 'docs: unrelated main advance while memory PR #11 is open']);
      mainSha = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['push', 'origin', 'HEAD:refs/heads/main']);

      runMode = 'fail_check';
      turn = 0;
      const phase2Res = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 501,
        baseRevision: phase1BaseSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-mem-phase2a',
        turnkey: true,
        allowManifestCustomBaseUrl: true,
        githubApiBaseUrl: githubServer.url,
        githubToken: 'ghp_turnkey_mem_token_123456',
        gitRemoteUrl: bareRemote,
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-turnkey-mem-llm-123456',
        },
      });
      assert.equal(phase2Res.kind, 'compiled');
      if (phase2Res.kind === 'compiled') {
        assert.equal(phase2Res.delegateOutcome?.ok, false);
        assert.equal(phase2Res.memory?.status, 'updated');
        assert.equal(phase2Res.memory?.rebased, true, 'must rebase open memory PR onto advanced targetBranch tip');
        assert.equal(phase2Res.memory?.pullRequestNumber, 11);
      }
      assert.equal(memoryPostCount, 1, 'must reuse open memory PR #11 without opening duplicate PRs');
      assert.equal(memoryPatchCount, 1, 'must update open memory PR #11 via PATCH');

      // Inspect updated memory branch: must sit on advanced `mainSha`, preserve Phase 1's passed fact,
      // add Phase 2's failure_observation, and record Phase 1's superseded verify-status fact in `retired`!
      const memoryClone2 = join(work, 'clone-mem-2');
      await git(work, ['clone', '--branch', 'loopwright/memory/auto-sync/main', bareRemote, memoryClone2]);
      assert.equal(await git(memoryClone2, ['rev-parse', 'HEAD^']), mainSha);
      const loadedOnBranch = await loadMemoryStore(memoryClone2, 'auto-sync', 'acme/repo', '.auto-sync/memory');
      assert.equal(loadedOnBranch.index.entries.some(e => e.kind === 'fact' && e.claimKey === 'claim.check.proposal-json'), true);
      assert.equal(loadedOnBranch.index.entries.some(e => e.kind === 'failure_observation' && e.claimKey === 'claim.check.verify-status'), true);
      assert.equal(loadedOnBranch.index.retired.some(r => r.entry.kind === 'fact' && r.entry.claimKey === 'claim.check.verify-status'), true);

      // --- Phase 3: Squash-merge memory PR #11 into `main` (leaving remote memory branch intact!), then verify Run 2b ---
      await git(repo, ['fetch', 'origin', 'refs/heads/loopwright/memory/auto-sync/main']);
      await git(repo, ['merge', '--squash', 'FETCH_HEAD']);
      await git(repo, ['commit', '-m', 'chore(memory): squash merge memory PR #11']);
      mainSha = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['push', 'origin', 'HEAD:refs/heads/main']);
      openMemoryPr = null;

      // Verify `stageTaskpackForStep` stages `.auto-sync/memory/auto-sync/active-snapshot.md` as 0o400!
      const stagedStep = await stageTaskpackForStep({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        runRoot,
        runId: 'run-step-mem-check',
        discoverUpstreams: false,
        upstreamRecordsJson: JSON.stringify([{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }]),
        runtimeEnv: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          LOOPWRIGHT_REPOSITORY: 'acme/repo',
          GITHUB_SHA: mainSha,
        },
      });
      const stepSnapshotPath = join(dirname(stagedStep.registryPath), '.auto-sync', 'memory', 'auto-sync', 'active-snapshot.md');
      const stepSnapshotStat = await stat(stepSnapshotPath);
      assert.equal(stepSnapshotStat.mode & 0o777, 0o400);
      assert.match(await readFile(stagedStep.registryPath, 'utf8'), /<active_memory>/);

      // Run 2b: full turnkey run loads active memory into author prompt and stages 0o400 resource!
      runMode = 'pass_v2';
      turn = 0;
      observedUserPrompts.length = 0;
      const phase3Res = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 501,
        baseRevision: mainSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-mem-phase2b',
        turnkey: true,
        allowManifestCustomBaseUrl: true,
        githubApiBaseUrl: githubServer.url,
        githubToken: 'ghp_turnkey_mem_token_123456',
        gitRemoteUrl: bareRemote,
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-turnkey-mem-llm-123456',
        },
      });
      assert.equal(phase3Res.kind, 'compiled');
      if (phase3Res.kind === 'compiled') {
        assert.equal(phase3Res.delegateOutcome?.ok, true);
        assert.equal((phase3Res.taskpack.activeMemory?.activeEntryCount ?? 0) >= 2, true);
        assert.equal(
          phase3Res.memory?.status,
          'published',
          `squash-merged memory branch must not block subsequent publication (got ${phase3Res.memory?.status}: ${phase3Res.memory?.reason ?? ''})`,
        );
        const actionSnapshotPath = join(
          phase3Res.taskpack.trustedDirectory,
          'registry',
          '.auto-sync',
          'memory',
          'auto-sync',
          'active-snapshot.md',
        );
        const actionSnapStat = await stat(actionSnapshotPath);
        assert.equal(actionSnapStat.mode & 0o777, 0o400);
      }
      assert.equal(observedUserPrompts.some(p => p.includes('<active_memory>')), true);
      assert.equal(observedUserPrompts.some(p => p.includes('claim.check.verify-status')), true);
    } finally {
      await openAiServer?.close();
      await githubServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('isolates symlink escape, secret leaks, onNoModelBudget: skip, and GitHub 500 memory PR errors without failing primary settlement', async () => {
    const rawWork = await mkdtemp(join(tmpdir(), 'lw-turnkey-mem-neg-'));
    const work = await realpath(rawWork);
    const bareRemote = join(work, 'remote.git');
    const repo = join(work, 'repo');
    const runRoot = join(work, 'runs');
    const outsideTarget = join(work, 'outside-secret-dir');
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let githubServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;

    try {
      await mkdir(bareRemote, { recursive: true });
      await mkdir(repo, { recursive: true });
      await mkdir(runRoot, { recursive: true });
      await mkdir(outsideTarget, { recursive: true });
      await writeFile(join(outsideTarget, 'index.json'), '{"tampered":true}\n', 'utf8');

      await git(bareRemote, ['init', '--bare', '--initial-branch=main']);
      await git(repo, ['init', '--initial-branch=main']);
      await git(repo, ['remote', 'add', 'origin', bareRemote]);

      await mkdir(join(repo, '.auto-sync', 'prompts'), { recursive: true });
      await mkdir(join(repo, '.auto-sync', 'checks'), { recursive: true });
      await mkdir(join(repo, 'docs'), { recursive: true });
      await mkdir(join(repo, 'pack'), { recursive: true });
      await writeFile(join(repo, '.auto-sync', 'prompts', 'instructions.md'), '# Guide\n', 'utf8');

      const leakedToken = 'ghp_SuperSecretCheckToken9876543210AbCdEf';
      await writeFile(
        join(repo, '.auto-sync', 'checks', 'verify.sh'),
        `#!/bin/sh\nset -eu\nif grep -q "leak-now" "$LOOPWRIGHT_CANDIDATE_DIR/docs/status.md"; then\n  echo "auth failed with token ${leakedToken}" >&2\n  exit 1\nfi\ngrep -q "verified-v2" "$LOOPWRIGHT_CANDIDATE_DIR/docs/status.md"\n`,
        { mode: 0o755 },
      );
      await chmod(join(repo, '.auto-sync', 'checks', 'verify.sh'), 0o755);
      await writeFile(join(repo, 'docs', 'status.md'), 'v1\n', 'utf8');
      await writeFile(join(repo, 'pack', 'proposal.json'), '{"schema_version":1,"version":"1.0.0"}\n', 'utf8');
      await writeFile(join(repo, 'pack', 'frozen.json'), '{"locked":true}\n', 'utf8');

      let draftContent = 'verified-v2\n';
      let turn = 0;
      openAiServer = await startHttpServer(async (_req, res) => {
        const currentTurn = turn++;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (currentTurn === 0) {
          res.end(sseToolCall('gpt-4.1-mini', 'c1', 'write', { path: 'docs/status.md', content: draftContent }));
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

      let memoryPrMode: 'ok' | 'http_500' | 'html_200' = 'ok';
      let afterCandidatePostMemoryPullsHook: (() => Promise<void>) | null = null;
      let candidatePostedInCurrentRun = false;
      let memoryPrPostAttempts = 0;
      const memoryPrPayloads: Record<string, unknown>[] = [];
      let candidatePrCount = 0;

      githubServer = await startHttpServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/repos/acme/engine/releases/latest' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v2.0.0' }));
          return;
        }
        if (url.pathname === '/repos/acme/repo' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 601 }));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'GET') {
          if (candidatePostedInCurrentRun && afterCandidatePostMemoryPullsHook !== null) {
            const hook = afterCandidatePostMemoryPullsHook;
            afterCandidatePostMemoryPullsHook = null;
            await hook();
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([]));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'POST') {
          const payload = await readJsonBody(req);
          const headRef = String(payload['head'] ?? '');
          if (headRef.startsWith('loopwright/memory/')) {
            memoryPrPostAttempts += 1;
            if (memoryPrMode === 'http_500') {
              res.writeHead(500, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ message: 'simulated memory PR outage' }));
              return;
            }
            if (memoryPrMode === 'html_200') {
              res.writeHead(200, { 'content-type': 'text/html' });
              res.end('<html><body>gateway cache page</body></html>');
              return;
            }
            memoryPrPayloads.push(payload);
            const lsOut = await git(repo, ['ls-remote', bareRemote, `refs/heads/${headRef}`]);
            const remoteSha = lsOut.split(/\s+/)[0] ?? '';
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              number: 51,
              html_url: 'https://github.invalid/acme/repo/pull/51',
              state: 'open',
              head: { ref: headRef, sha: remoteSha, repo: { full_name: 'acme/repo', fork: false } },
              base: { ref: String(payload['base'] ?? 'main'), repo: { full_name: 'acme/repo', fork: false } },
            }));
            return;
          }
          candidatePrCount += 1;
          candidatePostedInCurrentRun = true;
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ number: 50, html_url: 'https://github.invalid/acme/repo/pull/50' }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      // --- Case 1: `onNoModelBudget: 'skip'` skips deterministic-only memory while candidate PR succeeds ---
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), makeTaskpackYaml(openAiServer.url, 'skip'), 'utf8');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'init with skip']);
      let headSha = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['push', 'origin', 'HEAD:refs/heads/main']);

      turn = 0;
      const skipRes = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 601,
        baseRevision: headSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-neg-skip',
        turnkey: true,
        allowManifestCustomBaseUrl: true,
        githubApiBaseUrl: githubServer.url,
        githubToken: 'ghp_neg_token_123456',
        gitRemoteUrl: bareRemote,
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-neg-llm-token-123456',
        },
      });
      assert.equal(skipRes.kind, 'compiled');
      if (skipRes.kind === 'compiled') {
        assert.equal(skipRes.delegateOutcome?.ok, true);
        assert.equal(skipRes.memory?.status, 'skipped');
        assert.equal(skipRes.memory?.reason, 'no_model_budget_skipped');
      }
      assert.equal(candidatePrCount, 1);
      assert.equal(memoryPrPayloads.length, 0);

      // Switch manifest back to `deterministic-observations-only` for Cases 2-4.
      await git(bareRemote, ['update-ref', '-d', 'refs/heads/loopwright/main']);
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), makeTaskpackYaml(openAiServer.url, 'deterministic-observations-only'), 'utf8');
      await git(repo, ['add', '.auto-sync/taskpack.yaml']);
      await git(repo, ['commit', '-m', 'enable deterministic memory']);
      headSha = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['push', 'origin', 'HEAD:refs/heads/main']);

      // --- Case 2: Symlink escape at `.auto-sync/memory` in working tree is refused without breaking primary run ---
      await symlink(outsideTarget, join(repo, '.auto-sync', 'memory'));
      try {
        turn = 0;
        const progressLines: string[] = [];
        const symlinkRes = await runGitHubActionEntrypoint({
          repositoryRoot: repo,
          taskpackPath: '.auto-sync/taskpack.yaml',
          repositoryFullName: 'acme/repo',
          repositoryId: 601,
          baseRevision: headSha,
          mode: 'candidate',
          eventName: 'workflow_dispatch',
          runRoot,
          runId: 'run-neg-symlink',
          turnkey: true,
          allowManifestCustomBaseUrl: true,
          githubApiBaseUrl: githubServer.url,
          githubToken: 'ghp_neg_token_123456',
          gitRemoteUrl: bareRemote,
          progressSink: line => progressLines.push(line),
          env: {
            PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
            GITHUB_ACTIONS: 'true',
            LLM_TOKEN: 'sk-neg-llm-token-123456',
          },
        });
        assert.equal(symlinkRes.kind, 'compiled');
        if (symlinkRes.kind === 'compiled') {
          assert.equal(symlinkRes.delegateOutcome?.ok, true, 'primary candidate run must succeed despite symlinked memory dir');
          assert.equal(symlinkRes.memory?.status, 'refused');
          assert.match(symlinkRes.memory?.reason ?? '', /symbolic link/);
        }
        assert.equal((await lstat(join(repo, '.auto-sync', 'memory'))).isSymbolicLink(), true);
        assert.equal(memoryPrPayloads.length, 0);
      } finally {
        await rm(join(repo, '.auto-sync', 'memory'), { force: true });
      }

      // --- Case 3: GitHub PR API HTTP 500 after push records `reconcile_required` journal without failing primary candidate run ---
      await git(bareRemote, ['update-ref', '-d', 'refs/heads/loopwright/main']);
      memoryPrMode = 'http_500';
      memoryPrPostAttempts = 0;
      turn = 0;
      const out500 = join(work, 'out-500.txt');
      const exit500 = await runActionCli({
        PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
        GITHUB_ACTIONS: 'true',
        GITHUB_WORKSPACE: repo,
        LOOPWRIGHT_REPOSITORY: 'acme/repo',
        GITHUB_SHA: headSha,
        GITHUB_API_URL: githubServer.url,
        GITHUB_OUTPUT: out500,
        'INPUT_TASKPACK-PATH': '.auto-sync/taskpack.yaml',
        'INPUT_EVENT-NAME': 'workflow_dispatch',
        'INPUT_RUN-ROOT': runRoot,
        'INPUT_RUN-ID': 'run-neg-500',
        'INPUT_ALLOW-CUSTOM-BASE-URL': 'true',
        'INPUT_GITHUB-TOKEN': 'ghp_neg_token_123456',
        'INPUT_REMOTE-URL': bareRemote,
        LLM_TOKEN: 'sk-neg-llm-token-123456',
      });
      assert.equal(exit500, 0, 'memory PR HTTP 500 must NEVER fail primary candidate sync');
      assert.equal(memoryPrPostAttempts, 1);
      const parsedOut500 = parseGithubOutputs(await readFile(out500, 'utf8'));
      assert.equal(parsedOut500['pr-url'], 'https://github.invalid/acme/repo/pull/50');
      assert.equal(parsedOut500['memory-pr-url'], '');
      const resultJson500 = JSON.parse(parsedOut500['result'] ?? '{}') as {
        memory?: { status: string; proposalId: string | null; branchName: string | null; reason: string };
      };
      assert.equal(resultJson500.memory?.status, 'reconcile_required');
      assert.equal(typeof resultJson500.memory?.proposalId === 'string' && resultJson500.memory.proposalId.length > 0, true);
      assert.equal(resultJson500.memory?.branchName, 'loopwright/memory/auto-sync/main');
      assert.match(resultJson500.memory?.reason ?? '', /500/);

      const journal500 = await readMemoryPublicationJournal(runRoot, 'run-neg-500');
      assert.equal(journal500?.state, 'uncertain');
      assert.equal(journal500?.stage, 'pull_request');
      assert.equal(journal500?.pushState, 'committed');
      assert.equal(journal500?.pullRequestState, 'in_flight');

      // Replay (same runId) AND overlapping runs (different runId) must be fenced while journal is uncertain!
      const loadedManifest = await loadDeclarativeTaskpack({ manifestPath: '.auto-sync/taskpack.yaml', repositoryRoot: repo });
      const replayScrubber = new SecretScrubber();
      replayScrubber.register('ghp_neg_token_123456');
      replayScrubber.register('sk-neg-llm-token-123456');
      const replay500 = await finalizeAndPublishTurnkeyMemory({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest: loadedManifest,
        repositoryFullName: 'acme/repo',
        baseRevision: headSha,
        runRoot,
        runId: 'run-neg-500',
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        scrubber: replayScrubber,
        githubToken: 'ghp_neg_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: bareRemote,
      });
      assert.equal(replay500.status, 'reconcile_required');
      assert.equal(memoryPrPostAttempts, 1, 'replay must not re-POST while journal is uncertain');

      const otherRunFenced = await finalizeAndPublishTurnkeyMemory({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest: loadedManifest,
        repositoryFullName: 'acme/repo',
        baseRevision: headSha,
        runRoot,
        runId: 'run-neg-500-other-run',
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        scrubber: replayScrubber,
        githubToken: 'ghp_neg_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: bareRemote,
      });
      assert.equal(otherRunFenced.status, 'reconcile_required');
      assert.match(otherRunFenced.reason ?? '', /unresolved memory publication from run "run-neg-500"/);
      assert.equal(memoryPrPostAttempts, 1, 'cross-run fence must block other runs while uncertain');

      // Reconciling PR `not_executed` after push succeeded retains `push_only` journal idempotently and allows staged PR recovery!
      const cleared500First = await reconcileTurnkeyMemoryPublication({
        runRoot,
        runId: 'run-neg-500',
        outcome: 'not_executed',
      });
      assert.equal(cleared500First.status, 'skipped');
      const cleared500Second = await reconcileTurnkeyMemoryPublication({
        runRoot,
        runId: 'run-neg-500',
        outcome: 'not_executed',
      });
      assert.equal(cleared500Second.status, 'skipped');
      const pushOnlyJournal = await readMemoryPublicationJournal(runRoot, 'run-neg-500');
      assert.equal(pushOnlyJournal?.state, 'push_only');
      assert.equal(pushOnlyJournal?.pushState, 'committed');
      assert.equal(pushOnlyJournal?.pullRequestState, 'not_executed');

      memoryPrMode = 'ok';
      const stagedRecovery500 = await finalizeAndPublishTurnkeyMemory({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest: loadedManifest,
        repositoryFullName: 'acme/repo',
        baseRevision: headSha,
        runRoot,
        runId: 'run-neg-500',
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        scrubber: replayScrubber,
        githubToken: 'ghp_neg_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: bareRemote,
      });
      assert.equal(stagedRecovery500.status, 'published');
      assert.equal(stagedRecovery500.pullRequestNumber, 51);
      assert.equal(memoryPrPostAttempts, 2, 'staged recovery must complete PR creation without orphan-branch deadlock');
      memoryPrPayloads.length = 0;

      // --- Case 4: Credential leak in failed check output is refused by redaction gate (`MEMORY_SECRET_LEAK`) and never pushed ---
      memoryPrMode = 'ok';
      await git(bareRemote, ['update-ref', '-d', 'refs/heads/loopwright/memory/auto-sync/main']);
      draftContent = 'leak-now\n';
      turn = 0;
      const leakRes = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 601,
        baseRevision: headSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-neg-secret-leak',
        turnkey: true,
        allowManifestCustomBaseUrl: true,
        githubApiBaseUrl: githubServer.url,
        githubToken: 'ghp_neg_token_123456',
        gitRemoteUrl: bareRemote,
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-neg-llm-token-123456',
        },
      });
      assert.equal(leakRes.kind, 'compiled');
      if (leakRes.kind === 'compiled') {
        assert.equal(leakRes.delegateOutcome?.ok, false);
        assert.equal(leakRes.memory?.status, 'refused');
        assert.match(leakRes.memory?.reason ?? '', /MEMORY_SECRET_LEAK/);
      }
      assert.equal(memoryPrPayloads.length, 0, 'secret-tainted observation must never be pushed or published');

      // --- Case 5: HTTP 200 HTML response on `POST /pulls` is treated as `reconcile_required` (never false `published`) ---
      draftContent = 'verified-v2\n';
      memoryPrMode = 'html_200';
      memoryPrPostAttempts = 0;
      await git(bareRemote, ['update-ref', '-d', 'refs/heads/loopwright/main']).catch(() => undefined);
      turn = 0;
      const htmlRes = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 601,
        baseRevision: headSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-neg-html-200',
        turnkey: true,
        allowManifestCustomBaseUrl: true,
        githubApiBaseUrl: githubServer.url,
        githubToken: 'ghp_neg_token_123456',
        gitRemoteUrl: bareRemote,
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-neg-llm-token-123456',
        },
      });
      assert.equal(htmlRes.kind, 'compiled');
      if (htmlRes.kind === 'compiled') {
        assert.equal(htmlRes.delegateOutcome?.ok, true);
        assert.equal(htmlRes.memory?.status, 'reconcile_required');
        assert.equal(htmlRes.memory?.pullRequestUrl, null);
      }
      assert.equal(memoryPrPostAttempts, 1);
      const confirmedHtml = await reconcileTurnkeyMemoryPublication({
        runRoot,
        runId: 'run-neg-html-200',
        outcome: 'confirmed',
        pullRequestNumber: 52,
        pullRequestUrl: 'https://github.invalid/acme/repo/pull/52',
      });
      assert.equal(confirmedHtml.status, 'published');
      const replayConfirmed = await finalizeAndPublishTurnkeyMemory({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest: loadedManifest,
        repositoryFullName: 'acme/repo',
        baseRevision: headSha,
        runRoot,
        runId: 'run-neg-html-200',
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        scrubber: replayScrubber,
        githubToken: 'ghp_neg_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: bareRemote,
      });
      assert.equal(replayConfirmed.status, 'published');
      assert.equal(replayConfirmed.pullRequestNumber, 52);
      assert.equal(memoryPrPostAttempts, 1, 'confirmed journal replay must be idempotent without re-POSTing');

      // --- Case 6: Concurrent publisher creating remote memory branch after upfront `ls-remote` is rejected by `--force-with-lease` ---
      memoryPrMode = 'ok';
      await git(bareRemote, ['update-ref', '-d', 'refs/heads/loopwright/main']).catch(() => undefined);
      await git(bareRemote, ['update-ref', '-d', 'refs/heads/loopwright/memory/auto-sync/main']);
      const racerClone = join(work, 'racer-clone');
      await git(work, ['clone', bareRemote, racerClone]);
      await mkdir(join(racerClone, '.auto-sync', 'memory', 'auto-sync'), { recursive: true });
      await writeFile(join(racerClone, '.auto-sync', 'memory', 'auto-sync', 'racer.txt'), 'concurrent-win\n', 'utf8');
      await git(racerClone, ['add', '.']);
      await git(racerClone, ['commit', '-m', 'chore: concurrent memory publisher']);
      const concurrentRemoteSha = await git(racerClone, ['rev-parse', 'HEAD']);

      candidatePostedInCurrentRun = false;
      afterCandidatePostMemoryPullsHook = async () => {
        await git(racerClone, ['push', 'origin', `${concurrentRemoteSha}:refs/heads/loopwright/memory/auto-sync/main`]);
      };

      turn = 0;
      const raceRes = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 601,
        baseRevision: headSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-neg-race-lease',
        turnkey: true,
        allowManifestCustomBaseUrl: true,
        githubApiBaseUrl: githubServer.url,
        githubToken: 'ghp_neg_token_123456',
        gitRemoteUrl: bareRemote,
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-neg-llm-token-123456',
        },
      });
      assert.equal(raceRes.kind, 'compiled');
      if (raceRes.kind === 'compiled') {
        assert.equal(raceRes.delegateOutcome?.ok, true);
        assert.equal(raceRes.memory?.status, 'refused');
        assert.match(raceRes.memory?.reason ?? '', /force-with-lease rejected/);
      }
      const postRaceLs = await git(repo, ['ls-remote', bareRemote, 'refs/heads/loopwright/memory/auto-sync/main']);
      assert.equal(postRaceLs.split(/\s+/)[0], concurrentRemoteSha, 'concurrent publisher commit must remain intact');
    } finally {
      await openAiServer?.close();
      await githubServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('enforces atomic fence locks, single-flight same-run push_only recovery, target-branch replay binding, and publication.mode: disabled', async () => {
    const rawWork = await mkdtemp(join(tmpdir(), 'lw-turnkey-mem-p3a-'));
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

      let turn = 0;
      openAiServer = await startHttpServer(async (_req, res) => {
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

      let memoryPrMode: 'ok' | 'http_500' = 'http_500';
      let memoryPrPostAttempts = 0;
      let memoryPr422Count = 0;
      let createdMemoryHeads = new Set<string>();
      let pullsRequestsCount = 0;

      githubServer = await startHttpServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/repos/acme/engine/releases/latest' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v2.0.0' }));
          return;
        }
        if (url.pathname === '/repos/acme/repo' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 701 }));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'GET') {
          pullsRequestsCount += 1;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([]));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'POST') {
          pullsRequestsCount += 1;
          const payload = await readJsonBody(req);
          const headRef = String(payload['head'] ?? '');
          if (headRef.startsWith('loopwright/memory/')) {
            memoryPrPostAttempts += 1;
            if (memoryPrMode === 'http_500') {
              res.writeHead(500, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ message: 'simulated outage' }));
              return;
            }
            // Simulate realistic network latency and GitHub duplicate-PR 422 rejection!
            await new Promise<void>(resolve => setTimeout(resolve, 40));
            if (createdMemoryHeads.has(headRef)) {
              memoryPr422Count += 1;
              res.writeHead(422, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ message: 'Validation Failed: A pull request already exists' }));
              return;
            }
            createdMemoryHeads.add(headRef);
            const lsOut = await git(repo, ['ls-remote', bareRemote, `refs/heads/${headRef}`]);
            const remoteSha = lsOut.split(/\s+/)[0] ?? '';
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              number: 71,
              html_url: 'https://github.invalid/acme/repo/pull/71',
              state: 'open',
              head: { ref: headRef, sha: remoteSha, repo: { full_name: 'acme/repo', fork: false } },
              base: { ref: String(payload['base'] ?? 'main'), repo: { full_name: 'acme/repo', fork: false } },
            }));
            return;
          }
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ number: 70, html_url: 'https://github.invalid/acme/repo/pull/70' }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), makeTaskpackYaml(openAiServer.url), 'utf8');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'base commit shared with release']);
      await git(repo, ['push', 'origin', 'HEAD:refs/heads/release']);

      // Advance `main` with a non-memory file (`README.md`) so `main` diverges from `release`.
      await writeFile(join(repo, 'README.md'), '# Main-only content\n', 'utf8');
      await git(repo, ['add', 'README.md']);
      await git(repo, ['commit', '-m', 'docs: add README on main']);
      let mainHeadSha = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['push', 'origin', 'HEAD:refs/heads/main']);

      // Run initial candidate run with HTTP 500 on memory PR creation, then reconcile to `push_only`.
      turn = 0;
      const initial500 = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 701,
        baseRevision: mainHeadSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-p3-recovery',
        turnkey: true,
        allowManifestCustomBaseUrl: true,
        githubApiBaseUrl: githubServer.url,
        githubToken: 'ghp_p3_token_123456',
        gitRemoteUrl: bareRemote,
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-p3-llm-token-123456',
        },
      });
      assert.equal(initial500.kind, 'compiled');
      if (initial500.kind === 'compiled') {
        assert.equal(initial500.memory?.status, 'reconcile_required');
      }
      await reconcileTurnkeyMemoryPublication({
        runRoot,
        runId: 'run-p3-recovery',
        outcome: 'not_executed',
      });
      assert.equal((await readMemoryPublicationJournal(runRoot, 'run-p3-recovery'))?.state, 'push_only');

      const loadedManifest = await loadDeclarativeTaskpack({ manifestPath: '.auto-sync/taskpack.yaml', repositoryRoot: repo });
      const scrubber = new SecretScrubber();
      scrubber.register('ghp_p3_token_123456');
      scrubber.register('sk-p3-llm-token-123456');

      // --- Case A: 0-byte incomplete `.lock` file fails closed (`reconcile_required`) without deleting `.lock` ---
      memoryPrMode = 'ok';
      memoryPrPostAttempts = 0;
      const fenceKey = createHash('sha256')
        .update('acme/repo\0loopwright/memory/auto-sync/main')
        .digest('hex');
      const lockPath = join(runRoot, '.memory-publications', `${fenceKey}.lock`);
      await writeFile(lockPath, '', { mode: 0o600 });
      try {
        const lockFailRes = await finalizeAndPublishTurnkeyMemory({
          repositoryRoot: repo,
          taskpackPath: '.auto-sync/taskpack.yaml',
          manifest: loadedManifest,
          repositoryFullName: 'acme/repo',
          baseRevision: mainHeadSha,
          runRoot,
          runId: 'run-p3-recovery',
          upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
          scrubber,
          githubToken: 'ghp_p3_token_123456',
          apiBaseUrl: githubServer.url,
          remoteUrl: bareRemote,
        });
        assert.equal(lockFailRes.status, 'reconcile_required');
        assert.match(lockFailRes.reason ?? '', /corrupt(?: or incomplete)? memory branch fence lock/);
        assert.equal(memoryPrPostAttempts, 0, 'incomplete lock must block publication before any GitHub API call');
        const lockStatsAfter = await stat(lockPath);
        assert.equal(lockStatsAfter.size, 0, 'fail-closed lock check must never unlink an empty/corrupt lock');
      } finally {
        await unlink(lockPath);
      }

      // --- Case B1: Replay against altered `targetBranch` (`main` -> `release`) is refused by immutable journal binding ---
      const releaseManifest = {
        ...loadedManifest,
        spec: {
          ...loadedManifest.spec,
          publication: { ...loadedManifest.spec.publication, targetBranch: 'release' },
        },
      };
      const targetMismatchRes = await finalizeAndPublishTurnkeyMemory({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest: releaseManifest,
        repositoryFullName: 'acme/repo',
        baseRevision: mainHeadSha,
        runRoot,
        runId: 'run-p3-recovery',
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        scrubber,
        githubToken: 'ghp_p3_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: bareRemote,
      });
      assert.equal(targetMismatchRes.status, 'refused');
      assert.match(targetMismatchRes.reason ?? '', /MEMORY_SCOPE_VIOLATION/);
      assert.equal(memoryPrPostAttempts, 0);

      // --- Case B2: Even if journal + branch metadata claim `release`, scratch-clone diff rejects non-memory `README.md` ---
      const savedJournalBytes = await readFile(join(runRoot, 'run-p3-recovery', 'memory-publication.json'));
      const parsedJournal = JSON.parse(savedJournalBytes.toString('utf8')) as Record<string, unknown>;
      await git(bareRemote, ['update-ref', 'refs/heads/loopwright/memory/auto-sync/release', String(parsedJournal['headOid'])]);
      const releaseFenceKey = createHash('sha256')
        .update('acme/repo\0loopwright/memory/auto-sync/release')
        .digest('hex');
      const releaseFencePath = join(runRoot, '.memory-publications', `${releaseFenceKey}.json`);
      await writeFile(
        releaseFencePath,
        `${JSON.stringify({
          version: 1,
          repository: 'acme/repo',
          branchName: 'loopwright/memory/auto-sync/release',
          runId: 'run-p3-recovery',
          state: 'push_only',
          stage: 'reconciled',
          headOid: parsedJournal['headOid'],
          previousConfirmedHeadOid: null,
          updatedAtMs: Date.now(),
        })}\n`,
        { mode: 0o600 },
      );
      await writeFile(
        join(runRoot, 'run-p3-recovery', 'memory-publication.json'),
        `${JSON.stringify({
          ...parsedJournal,
          targetBranch: 'release',
          branchName: 'loopwright/memory/auto-sync/release',
        })}\n`,
        { mode: 0o600 },
      );
      try {
        const diffScopeRefused = await finalizeAndPublishTurnkeyMemory({
          repositoryRoot: repo,
          taskpackPath: '.auto-sync/taskpack.yaml',
          manifest: releaseManifest,
          repositoryFullName: 'acme/repo',
          baseRevision: mainHeadSha,
          runRoot,
          runId: 'run-p3-recovery',
          upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
          scrubber,
          githubToken: 'ghp_p3_token_123456',
          apiBaseUrl: githubServer.url,
          remoteUrl: bareRemote,
        });
        assert.equal(diffScopeRefused.status, 'refused');
        assert.match(
          diffScopeRefused.reason ?? '',
          /MEMORY_SCOPE_VIOLATION: staged memory branch diff against "release" touches paths outside/,
        );
        assert.equal(memoryPrPostAttempts, 0);
      } finally {
        await writeFile(join(runRoot, 'run-p3-recovery', 'memory-publication.json'), savedJournalBytes, { mode: 0o600 });
        await unlink(releaseFencePath).catch(() => undefined);
        await git(bareRemote, ['update-ref', '-d', 'refs/heads/loopwright/memory/auto-sync/release']).catch(() => undefined);
      }

      // --- Case D1: `publication.mode: 'disabled'` on `push_only` recovery returns `local_only` with zero PR calls ---
      pullsRequestsCount = 0;
      const disabledManifest = {
        ...loadedManifest,
        spec: {
          ...loadedManifest.spec,
          publication: { ...loadedManifest.spec.publication, mode: 'disabled' as const },
        },
      };
      const disabledReplayRes = await finalizeAndPublishTurnkeyMemory({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest: disabledManifest,
        repositoryFullName: 'acme/repo',
        baseRevision: mainHeadSha,
        runRoot,
        runId: 'run-p3-recovery',
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        scrubber,
        githubToken: 'ghp_p3_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: bareRemote,
      });
      assert.equal(disabledReplayRes.status, 'local_only');
      assert.equal(pullsRequestsCount, 0);
      assert.equal((await readMemoryPublicationJournal(runRoot, 'run-p3-recovery'))?.state, 'push_only');

      // --- Case C: Concurrent same-run `push_only` recovery replays dispatch `POST /pulls` once and settle cleanly ---
      createdMemoryHeads = new Set<string>();
      memoryPrPostAttempts = 0;
      memoryPr422Count = 0;
      const replayArgs = {
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest: loadedManifest,
        repositoryFullName: 'acme/repo',
        baseRevision: mainHeadSha,
        runRoot,
        runId: 'run-p3-recovery',
        upstreamRecords: [{ upstreamId: 'engine' as const, status: 'available' as const, version: 'v2.0.0' }],
        scrubber,
        githubToken: 'ghp_p3_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: bareRemote,
      };
      const [concurrentA, concurrentB] = await Promise.all([
        finalizeAndPublishTurnkeyMemory(replayArgs),
        finalizeAndPublishTurnkeyMemory(replayArgs),
      ]);
      assert.equal(memoryPrPostAttempts, 1, 'concurrent same-run push_only replays must issue POST /pulls once');
      assert.equal(memoryPr422Count, 0, 'must never trigger duplicate-PR HTTP 422');
      assert.equal(
        concurrentA.status === 'published' || concurrentB.status === 'published',
        true,
        'winner must report published',
      );
      const settledJournal = await readMemoryPublicationJournal(runRoot, 'run-p3-recovery');
      assert.equal(settledJournal?.state, 'completed');
      assert.equal(settledJournal?.pullRequestNumber, 71);

      // --- Case D2: Fresh turnkey run with `publication.mode: 'disabled'` performs zero remote pushes or `/pulls` calls ---
      await git(bareRemote, ['update-ref', '-d', 'refs/heads/loopwright/main']).catch(() => undefined);
      await git(bareRemote, ['update-ref', '-d', 'refs/heads/loopwright/memory/auto-sync/main']).catch(() => undefined);
      const disabledYaml = makeTaskpackYaml(openAiServer.url).replace('mode: pull_request', 'mode: disabled');
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), disabledYaml, 'utf8');
      await git(repo, ['add', '.auto-sync/taskpack.yaml']);
      await git(repo, ['commit', '-m', 'chore: disable publication mode']);
      mainHeadSha = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['push', 'origin', 'HEAD:refs/heads/main']);

      pullsRequestsCount = 0;
      turn = 0;
      const disabledFreshRes = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 701,
        baseRevision: mainHeadSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-p3-disabled-fresh',
        turnkey: true,
        allowManifestCustomBaseUrl: true,
        githubApiBaseUrl: githubServer.url,
        githubToken: 'ghp_p3_token_123456',
        gitRemoteUrl: bareRemote,
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-p3-llm-token-123456',
        },
      });
      assert.equal(disabledFreshRes.kind, 'compiled');
      if (disabledFreshRes.kind === 'compiled') {
        assert.equal(disabledFreshRes.delegateOutcome?.ok, true);
        assert.equal(disabledFreshRes.memory?.status, 'local_only');
        assert.equal(disabledFreshRes.memory?.pullRequestUrl, null);
      }
      assert.equal(pullsRequestsCount, 0, 'publication.mode: disabled must never call /pulls');
      const remoteMemoryAfterDisabled = await git(repo, ['ls-remote', bareRemote, 'refs/heads/loopwright/memory/auto-sync/main']);
      assert.equal(remoteMemoryAfterDisabled, '', 'publication.mode: disabled must never push remote memory branch');
    } finally {
      await openAiServer?.close();
      await githubServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('bounds 100-entry active memory within tight request/window limits and imports/merges 220-entry stores with retired same-id replacements', async () => {
    const rawWork = await mkdtemp(join(tmpdir(), 'lw-turnkey-mem-p3b-'));
    const work = await realpath(rawWork);
    const bareRemote = join(work, 'remote.git');
    const repo = join(work, 'repo');
    const runRoot = join(work, 'runs');
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let githubServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;

    function buildSyntheticMemoryEntry(params: {
      readonly id: string;
      readonly claimKey: string;
      readonly claim: string;
      readonly baseRevision: string;
      readonly codeFingerprint: { readonly algorithm: 'sha256'; readonly hex: string };
      readonly verifiedAtMs: number;
    }): MemoryEntry {
      const evidenceDigest = hashDomain('test-evidence', { id: params.id, claim: params.claim });
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

      let openMemoryPr: { number: number; html_url: string; head: { ref: string; sha: string }; base: { ref: string } } | null = null;
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
          res.end(JSON.stringify(openMemoryPr !== null ? [openMemoryPr] : []));
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

      const tightLimitsYaml = `${makeTaskpackYaml(openAiServer.url)}    workingWindowBytes: 131072\n    maxRequestBytes: 131072\n`;
      // Note: `makeTaskpackYaml` ends with `output:\n    formats: ...`; insert under `limits:` cleanly!
      const yaml131k = makeTaskpackYaml(openAiServer.url).replace(
        '    maxFormatRepairs: 0\n',
        '    maxFormatRepairs: 0\n    workingWindowBytes: 131072\n    maxRequestBytes: 131072\n',
      );
      void tightLimitsYaml;
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), yaml131k, 'utf8');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'init repo']);
      const baseSha0 = await git(repo, ['rev-parse', 'HEAD']);

      // --- Case E1: Seed 130 active entries (~185+ KB rendered snapshot) and verify tight 131,072-byte ceiling succeeds ---
      const docsFp = await computeCodeFingerprint(repo, ['docs/**', 'pack/**'], '.auto-sync/memory');
      const nowMs = Date.now();
      const ops130: MemoryOperation[] = [];
      for (let i = 0; i < 130; i += 1) {
        const padded = String(i).padStart(3, '0');
        ops130.push({
          kind: 'upsert',
          entry: buildSyntheticMemoryEntry({
            id: `entry.item-${padded}`,
            claimKey: `claim.item-${padded}`,
            claim: `Verified invariant ${padded}: ${'x'.repeat(1_250)}`,
            baseRevision: baseSha0,
            codeFingerprint: docsFp,
            verifiedAtMs: nowMs - 1_000,
          }),
        });
      }
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
        assert.equal(
          tight130Res.delegateOutcome?.ok,
          true,
          `130-entry active memory must not fail with CONTEXT_UNSAFE (detail: ${tight130Res.delegateOutcome?.detail ?? ''}, observedBytes=${JSON.stringify(observedRequestBytes)})`,
        );
      }
      assert.equal(observedRequestBytes.length >= 3, true);
      for (const reqBytes of observedRequestBytes) {
        assert.equal(reqBytes <= 131_072, true, `wire request (${reqBytes}B) must respect maxRequestBytes (131072B)`);
      }

      // --- Case E2: When `maxRequestBytes: 65_536` is already filled by required instructions, optional memory is cleanly omitted ---
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
      assert.equal(compiledOmitted.activeMemory?.resourcePath, null, 'optional active memory must omit cleanly when headroom is exhausted');
      assert.equal(memoryWarnings.some(w => w.includes('active memory omitted')), true);
      // Restore short instructions.md and lift tight limits for Case F.
      await writeFile(join(repo, '.auto-sync', 'prompts', 'instructions.md'), '# Guide\n', 'utf8');
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), makeTaskpackYaml(openAiServer.url), 'utf8');
      await git(repo, ['add', '.auto-sync/prompts/instructions.md', '.auto-sync/taskpack.yaml']);
      await git(repo, ['commit', '-m', 'chore: restore default limits']);
      mainSha = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['push', 'origin', 'HEAD:refs/heads/main']);
      await git(bareRemote, ['update-ref', '-d', 'refs/heads/loopwright/main']).catch(() => undefined);
      await git(bareRemote, ['update-ref', '-d', 'refs/heads/loopwright/memory/auto-sync/main']).catch(() => undefined);

      // --- Case F: 220-entry store (> 450 KiB `index.json`) + retired/active same-id replacement + squash-merge + disjoint target addition ---
      const ops220: MemoryOperation[] = [];
      for (let i = 0; i < 220; i += 1) {
        const padded = String(i).padStart(3, '0');
        ops220.push({
          kind: 'upsert',
          entry: buildSyntheticMemoryEntry({
            id: `entry.item-${padded}`,
            claimKey: `claim.item-${padded}`,
            claim: `Large store entry ${padded} v1: ${'y'.repeat(1_450)}`,
            baseRevision: mainSha,
            codeFingerprint: docsFp,
            verifiedAtMs: nowMs + 1_000,
          }),
        });
      }
      const proj220V1 = projectMemoryStore(
        emptyMemoryStoreIndex('auto-sync', 'acme/repo', nowMs),
        ops220,
        nowMs + 2_000,
        'prop.seed-220-v1',
      );
      // Replace `entry.item-000` with v2 using the SAME `entry.id` so `entry.item-000` appears in BOTH `retired` and `entries`!
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
      assert.equal(index220Bytes > 450_000, true, `expected index.json > 450KB, got ${index220Bytes}`);
      assert.equal(proj220V2.index.entries.some(e => e.id === 'entry.item-000' && e.claim.includes('v2 replacement')), true);
      assert.equal(proj220V2.index.retired.some(r => r.entry.id === 'entry.item-000' && r.entry.claim.includes('v1:')), true);

      // Push 220-entry store onto `refs/heads/loopwright/memory/auto-sync/main`, squash-merge into `main`
      // (leaving the remote memory branch intact!), then add disjoint `entry.item-220` onto `main`!
      const memSeedClone = join(work, 'mem-seed-clone');
      await git(work, ['clone', bareRemote, memSeedClone]);
      await writeProjectedStoreToDisk(memSeedClone, proj220V2);
      await git(memSeedClone, ['add', '.auto-sync/memory']);
      await git(memSeedClone, ['commit', '-m', 'memory(auto-sync): 220 entries with same-id replacement']);
      await git(memSeedClone, ['push', 'origin', 'HEAD:refs/heads/loopwright/memory/auto-sync/main']);

      await git(repo, ['fetch', 'origin', 'refs/heads/loopwright/memory/auto-sync/main']);
      await git(repo, ['merge', '--squash', 'FETCH_HEAD']);
      await git(repo, ['commit', '-m', 'chore(memory): squash merge 220-entry memory PR']);

      // Add disjoint entry `entry.item-220` directly on `main` so `targetTipStore` has a superset of the squash-merged branch!
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
      openMemoryPr = null;

      turn = 0;
      const run220Res = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 801,
        baseRevision: mainSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-p3-220-squash',
        turnkey: true,
        allowManifestCustomBaseUrl: true,
        githubApiBaseUrl: githubServer.url,
        githubToken: 'ghp_p3b_token_123456',
        gitRemoteUrl: bareRemote,
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-p3b-llm-token-123456',
        },
      });
      assert.equal(run220Res.kind, 'compiled');
      if (run220Res.kind === 'compiled') {
        assert.equal(run220Res.delegateOutcome?.ok, true);
        assert.equal(
          run220Res.memory?.status,
          'published',
          `220-entry squash-merged store with same-id retired replacement must publish cleanly (got ${run220Res.memory?.status}: ${run220Res.memory?.reason ?? ''})`,
        );
      }

      const verify220Clone = join(work, 'verify-220-clone');
      await git(work, ['clone', '--branch', 'loopwright/memory/auto-sync/main', bareRemote, verify220Clone]);
      const finalStore = await loadMemoryStore(verify220Clone, 'auto-sync', 'acme/repo', '.auto-sync/memory');
      assert.equal(finalStore.index.entries.some(e => e.id === 'entry.item-220'), true, 'disjoint main entry 220 must be preserved');
      assert.equal(
        finalStore.index.entries.some(e => e.id === 'entry.item-000' && e.claim.includes('v2 replacement')),
        true,
        'active v2 replacement must be preserved',
      );
      assert.equal(finalStore.index.entries.length >= 223, true);
    } finally {
      await openAiServer?.close();
      await githubServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('hardens porcelain push parsing, 42KB MCP schema window budgeting, stale recovery fencing, JSON-null corruption, PR repo/base binding, and canonical merge detection (Pass-4)', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'lw-mem-pass4-')));
    const staleNamedRemote = join(work, 'remote (stale info).git');
    const repo = join(work, 'repo');
    const runRoot = join(work, 'runs');
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let githubServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let mcpServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;

    function buildMemEntry(params: {
      readonly id: string;
      readonly claimKey: string;
      readonly claim: string;
      readonly baseRevision: string;
      readonly codeFingerprint: { readonly algorithm: 'sha256'; readonly hex: string };
      readonly verifiedAtMs: number;
      readonly upstreamVersion?: string;
    }): MemoryEntry {
      const evidenceDigest = hashDomain('p4-ev', { id: params.id, claim: params.claim });
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
          runId: 'seed-p4',
          lockHash: hashDomain('p4-lock', params.id),
          candidateDigest: hashDomain('p4-cand', params.id),
        },
        sourceDigest: hashDomain('p4-src', { id: params.id, claim: params.claim }),
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

    try {
      const scrubber = new SecretScrubber();

      // --- 1. `findOpenMemoryPullRequest` rejects missing/null `head.repo`, fork repo, or missing/mismatched `base.ref` ---
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
        githubToken: 'ghp_test_tok_123',
        scrubber,
        fetchImpl: async () => new Response(JSON.stringify(badItems), { status: 200 }),
      });
      assert.equal(rejectedPrLookup, null, 'must reject PR items with missing/fork head.repo or missing/mismatched base.ref');

      // --- 2. `writeActionOutputSinks` emits `memory-pr-url` ONLY for `published` / `updated` (never `refused`) ---
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
      const refusedOutputText = await readFile(refusedOutPath, 'utf8');
      assert.equal(
        refusedOutputText.includes('https://github.invalid/acme/repo/pull/99'),
        false,
        `refused memory status must not emit memory-pr-url:\n${refusedOutputText}`,
      );

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
      const publishedOutputText = await readFile(publishedOutPath, 'utf8');
      assert.equal(publishedOutputText.includes('https://github.invalid/acme/repo/pull/99'), true);

      // --- 3. Setup repository + remote named `remote (stale info).git` + 42KB MCP schema server ---
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
      await writeFile(join(repo, 'docs', 'sync.md'), '# Sync\n', 'utf8');
      await writeFile(join(repo, 'pack', 'proposal.json'), '{"schema_version":1,"version":"1.0.0"}\n', 'utf8');
      await writeFile(
        join(repo, '.auto-sync', 'checks', 'verify.sh'),
        '#!/bin/sh\ngrep -q \'"2.0.0"\' "$LOOPWRIGHT_CANDIDATE_DIR/pack/proposal.json"\n',
        { mode: 0o755 },
      );

      mcpServer = await startHttpServer(async (req, res) => {
        const rpc = await readJsonBody(req);
        const method = rpc['method'];
        const id = rpc['id'];
        if (method === 'initialize') {
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'p4-mcp-1' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'p4-large-schema-mcp', version: '1.0.0' },
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
                inputSchema: {
                  type: 'object',
                  properties: largeProperties,
                },
              }],
            },
          }));
          return;
        }
        res.writeHead(400);
        res.end();
      });

      let turn = 0;
      let schemaVersionToWrite = 1;
      openAiServer = await startHttpServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== '/v1/chat/completions' || req.method !== 'POST') {
          res.writeHead(404);
          res.end();
          return;
        }
        await readJsonBody(req);
        const cur = turn;
        turn += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (cur === 0) {
          res.end(sseToolCall('gpt-4.1-mini', 'c1', 'write', {
            path: 'pack/proposal.json',
            content: `{"schema_version":${schemaVersionToWrite},"version":"2.0.0"}\n`,
          }));
          return;
        }
        res.end(sseStop('gpt-4.1-mini', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null })));
      });

      let openMemoryPr: {
        number: number;
        html_url: string;
        state: string;
        title: string;
        body: string;
        head: { ref: string; sha: string; repo: { full_name: string; fork: boolean } };
        base: { ref: string; repo: { full_name: string; fork: boolean } };
      } | null = null;
      let memoryPatchCalls = 0;
      let memoryPostCalls = 0;
      let interceptNextMemoryGetPulls: (() => Promise<unknown[] | null>) | null = null;

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
          const headFilter = url.searchParams.get('head') ?? '';
          if (interceptNextMemoryGetPulls !== null) {
            const hook = interceptNextMemoryGetPulls;
            interceptNextMemoryGetPulls = null;
            const custom = await hook();
            if (custom !== null) {
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify(custom));
              return;
            }
          }
          const items = openMemoryPr !== null && (!headFilter || headFilter === `acme:${openMemoryPr.head.ref}`)
            ? [openMemoryPr]
            : [];
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(items));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'POST') {
          const payload = await readJsonBody(req);
          const headRef = String(payload['head'] ?? '');
          const lsOut = await git(repo, ['ls-remote', staleNamedRemote, `refs/heads/${headRef}`]);
          const remoteSha = lsOut.split(/\s+/)[0] ?? '';
          if (headRef.startsWith('loopwright/memory/')) {
            memoryPostCalls += 1;
            openMemoryPr = {
              number: 91,
              html_url: 'https://github.invalid/acme/repo/pull/91',
              state: 'open',
              title: String(payload['title'] ?? ''),
              body: String(payload['body'] ?? ''),
              head: { ref: headRef, sha: remoteSha, repo: { full_name: 'acme/repo', fork: false } },
              base: { ref: String(payload['base'] ?? 'main'), repo: { full_name: 'acme/repo', fork: false } },
            };
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(JSON.stringify(openMemoryPr));
            return;
          }
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ number: 90, html_url: 'https://github.invalid/acme/repo/pull/90' }));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls/91' && req.method === 'PATCH') {
          memoryPatchCalls += 1;
          const payload = await readJsonBody(req);
          const lsOut = await git(repo, ['ls-remote', staleNamedRemote, 'refs/heads/loopwright/memory/auto-sync/main']);
          const remoteSha = lsOut.split(/\s+/)[0] ?? '';
          openMemoryPr = {
            number: 91,
            html_url: 'https://github.invalid/acme/repo/pull/91',
            state: 'open',
            title: String(payload['title'] ?? openMemoryPr?.title ?? ''),
            body: String(payload['body'] ?? openMemoryPr?.body ?? ''),
            head: { ref: 'loopwright/memory/auto-sync/main', sha: remoteSha, repo: { full_name: 'acme/repo', fork: false } },
            base: { ref: 'main', repo: { full_name: 'acme/repo', fork: false } },
          };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(openMemoryPr));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      const yamlMcp131k = makeTaskpackYaml(openAiServer.url).replace(
        '    maxFormatRepairs: 0\n',
        '    maxFormatRepairs: 0\n    workingWindowBytes: 131072\n    maxRequestBytes: 131072\n',
      );
      const mcpServersJson = JSON.stringify([
        {
          id: 'extdocs',
          transport: 'http',
          url: `${mcpServer.url}/mcp`,
          bearerTokenEnv: 'MCP_BEARER_TOKEN',
          timeoutSeconds: 30,
        },
      ]);
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), yamlMcp131k, 'utf8');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'init p4 repo']);
      const baseSha0 = await git(repo, ['rev-parse', 'HEAD']);
      const docsFp = await computeCodeFingerprint(repo, ['docs/**', 'pack/**'], '.auto-sync/memory');
      const nowMs = Date.now();

      // Seed 130 active memory entries (> 128 tracked files -> baseTree mode!)
      const ops130: MemoryOperation[] = [];
      for (let i = 0; i < 130; i += 1) {
        const padded = String(i).padStart(3, '0');
        ops130.push({
          kind: 'upsert',
          entry: buildMemEntry({
            id: `entry.mcp-${padded}`,
            claimKey: `claim.mcp-${padded}`,
            claim: `Active memory entry ${padded}: ${'m'.repeat(320)}`,
            baseRevision: baseSha0,
            codeFingerprint: docsFp,
            verifiedAtMs: nowMs,
          }),
        });
      }
      const proj130 = projectMemoryStore(
        emptyMemoryStoreIndex('auto-sync', 'acme/repo', nowMs),
        ops130,
        nowMs + 100,
        'prop.p4-seed-130',
      );
      await writeProjectedStore(repo, proj130);
      await git(repo, ['add', '.auto-sync/memory']);
      await git(repo, ['commit', '-m', 'chore(memory): seed 130 active entries']);
      const mainSha = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['push', 'origin', 'HEAD:refs/heads/main']);

      // --- 4. 131,072-byte window + ~42KB MCP schema + 130 active memory entries succeeds without CONTEXT_UNSAFE ---
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
        runId: 'run-p4-mcp-window',
        turnkey: true,
        allowManifestCustomBaseUrl: true,
        mcpServersJson,
        githubApiBaseUrl: githubServer.url,
        githubToken: 'ghp_p4_token_123456',
        gitRemoteUrl: staleNamedRemote,
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-p4-llm-token-123456',
          MCP_BEARER_TOKEN: 'mcp-secret-bearer-789',
        },
      });
      assert.equal(mcpWindowRes.kind, 'compiled');
      if (mcpWindowRes.kind === 'compiled') {
        assert.equal(mcpWindowRes.delegateOutcome?.ok, true, 'must not fail admission with CONTEXT_UNSAFE');
        assert.equal(mcpWindowRes.memory?.status, 'published');
      }

      // Clean remote branches and fence so subsequent sub-cases start cleanly from `run-p4-mcp-window`'s retained artifacts
      const loadedManifest = await loadDeclarativeTaskpack({
        repositoryRoot: repo,
        manifestPath: join(repo, '.auto-sync', 'taskpack.yaml'),
      });
      const memBranch = 'loopwright/memory/auto-sync/main';
      const fenceKey = createHash('sha256').update(`acme/repo\0${memBranch}`).digest('hex');
      const fencePath = join(runRoot, '.memory-publications', `${fenceKey}.json`);
      const lockPath = join(runRoot, '.memory-publications', `${fenceKey}.lock`);

      await unlink(join(runRoot, 'run-p4-mcp-window', 'memory-publication.json')).catch(() => undefined);
      await unlink(fencePath).catch(() => undefined);
      openMemoryPr = null;
      await git(staleNamedRemote, ['update-ref', '-d', `refs/heads/${memBranch}`]).catch(() => undefined);

      // --- 5. `"null\n"` JSON in journal, fence, or lockfile is rejected as corrupt (`reconcile_required`) ---
      await writeFile(join(runRoot, 'run-p4-mcp-window', 'memory-publication.json'), 'null\n', { mode: 0o600 });
      await assert.rejects(
        () => readMemoryPublicationJournal(runRoot, 'run-p4-mcp-window'),
        /malformed memory-publication\.json; manual reconciliation required/,
      );
      const nullJournalRes = await finalizeAndPublishTurnkeyMemory({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest: loadedManifest,
        repositoryFullName: 'acme/repo',
        baseRevision: mainSha,
        runRoot,
        runId: 'run-p4-mcp-window',
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        scrubber,
        githubToken: 'ghp_p4_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: staleNamedRemote,
      });
      assert.equal(nullJournalRes.status, 'reconcile_required');
      await unlink(join(runRoot, 'run-p4-mcp-window', 'memory-publication.json'));

      await writeFile(fencePath, 'null\n', { mode: 0o600 });
      const nullFenceRes = await finalizeAndPublishTurnkeyMemory({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest: loadedManifest,
        repositoryFullName: 'acme/repo',
        baseRevision: mainSha,
        runRoot,
        runId: 'run-p4-mcp-window',
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        scrubber,
        githubToken: 'ghp_p4_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: staleNamedRemote,
      });
      assert.equal(nullFenceRes.status, 'reconcile_required');
      assert.match(nullFenceRes.reason ?? '', /malformed memory branch fence/);
      await unlink(fencePath);

      await writeFile(lockPath, 'null\n', { mode: 0o600 });
      const nullLockRes = await finalizeAndPublishTurnkeyMemory({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest: loadedManifest,
        repositoryFullName: 'acme/repo',
        baseRevision: mainSha,
        runRoot,
        runId: 'run-p4-mcp-window',
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        scrubber,
        githubToken: 'ghp_p4_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: staleNamedRemote,
      });
      assert.equal(nullLockRes.status, 'reconcile_required');
      assert.match(nullLockRes.reason ?? '', /corrupt or incomplete memory branch fence lock/);
      await unlink(lockPath);

      // --- 6. Remote directory named `remote (stale info).git` failing via pre-receive hook preserves `uncertain` journal ---
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
          runId: 'run-p4-mcp-window',
          upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
          scrubber,
          githubToken: 'ghp_p4_token_123456',
          apiBaseUrl: githubServer.url,
          remoteUrl: staleNamedRemote,
        });
        assert.equal(
          hookFailRes.status,
          'reconcile_required',
          `non-lease push failure to "(stale info).git" must preserve journal as reconcile_required (got ${hookFailRes.status}: ${hookFailRes.reason ?? ''})`,
        );
        const preservedJournal = await readMemoryPublicationJournal(runRoot, 'run-p4-mcp-window');
        assert.equal(preservedJournal?.state, 'uncertain');
      } finally {
        await unlink(preReceiveHookPath).catch(() => undefined);
      }
      await reconcileTurnkeyMemoryPublication({
        runRoot,
        runId: 'run-p4-mcp-window',
        outcome: 'not_executed',
        scrubber,
      });

      // --- 7. Unmerged remote memory branch differing ONLY in `validFor.upstreamVersions` OR unmerged retirement is NOT misclassified as merged ---
      const unmergedClone = join(work, 'unmerged-mem-clone');
      await git(work, ['clone', staleNamedRemote, unmergedClone]);
      // 7a: Unmerged `validFor.upstreamVersions` update (`v2.1.0` vs `main`'s `v2.0.0`) on closed-PR remote branch
      const updated000 = {
        ...proj130.index.entries.find(e => e.id === 'entry.mcp-000')!,
        validFor: {
          ...proj130.index.entries.find(e => e.id === 'entry.mcp-000')!.validFor,
          upstreamVersions: { engine: 'v2.1.0' },
        },
      };
      const projUnmergedUpstream = projectMemoryStore(
        proj130.index,
        [
          { kind: 'retire', entryId: 'entry.mcp-000', reason: 'bump upstream validity' },
          { kind: 'upsert', entry: updated000 },
        ],
        nowMs + 500,
        'prop.p4-unmerged-upstream',
      );
      await writeProjectedStore(unmergedClone, projUnmergedUpstream);
      await git(unmergedClone, ['add', '.auto-sync/memory']);
      await git(unmergedClone, ['commit', '-m', 'memory(auto-sync): unmerged upstream bump']);
      await git(unmergedClone, ['push', 'origin', `HEAD:refs/heads/${memBranch}`]);
      openMemoryPr = null;

      const preserveUpstreamRes = await finalizeAndPublishTurnkeyMemory({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest: loadedManifest,
        repositoryFullName: 'acme/repo',
        baseRevision: mainSha,
        runRoot,
        runId: 'run-p4-mcp-window',
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        scrubber,
        githubToken: 'ghp_p4_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: staleNamedRemote,
      });
      assert.equal(
        preserveUpstreamRes.status,
        'reconcile_required',
        'unmerged upstreamVersions update without open PR must fail closed as reconcile_required instead of overwriting as merged',
      );
      const verifyUpstreamClone = join(work, 'verify-unmerged-upstream');
      await git(work, ['clone', '--branch', memBranch, staleNamedRemote, verifyUpstreamClone]);
      const verifyUpstreamStore = await loadMemoryStore(verifyUpstreamClone, 'auto-sync', 'acme/repo', '.auto-sync/memory');
      assert.equal(
        verifyUpstreamStore.index.entries.find(e => e.id === 'entry.mcp-000')?.validFor.upstreamVersions['engine'],
        'v2.1.0',
        'unmerged upstreamVersions update on remote memory branch must remain untouched',
      );

      // 7b: Unmerged pure retirement (`entry.mcp-001` retired on remote branch while still active on `main`)
      await git(unmergedClone, ['reset', '--hard', mainSha]);
      const projUnmergedRetire = projectMemoryStore(
        proj130.index,
        [{ kind: 'retire', entryId: 'entry.mcp-001', reason: 'obsolete entry retired on memory branch' }],
        nowMs + 600,
        'prop.p4-unmerged-retire',
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
        runId: 'run-p4-mcp-window',
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        scrubber,
        githubToken: 'ghp_p4_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: staleNamedRemote,
      });
      assert.equal(
        preserveRetireRes.status,
        'reconcile_required',
        'unmerged pure retirement without open PR must fail closed as reconcile_required instead of overwriting as merged',
      );
      const verifyRetireClone = join(work, 'verify-unmerged-retire');
      await git(work, ['clone', '--branch', memBranch, staleNamedRemote, verifyRetireClone]);
      const verifyRetireStore = await loadMemoryStore(verifyRetireClone, 'auto-sync', 'acme/repo', '.auto-sync/memory');
      assert.equal(
        verifyRetireStore.index.entries.some(e => e.id === 'entry.mcp-001'),
        false,
        'unmerged pure retirement on remote memory branch must remain retired, never overwritten from main',
      );

      // --- 8. Stale `push_only` recovery Run A interleaved with newer completed Run B never overwrites Run B's PR or fence ---
      // Execute a second primary run `run-p4-fresh-b` so we have two distinct run directories (`run-p4-mcp-window` = Run A, `run-p4-fresh-b` = Run B).
      await unlink(join(runRoot, 'run-p4-mcp-window', 'memory-publication.json')).catch(() => undefined);
      await unlink(fencePath).catch(() => undefined);
      openMemoryPr = null;
      await git(staleNamedRemote, ['update-ref', '-d', `refs/heads/${memBranch}`]).catch(() => undefined);
      await git(staleNamedRemote, ['update-ref', '-d', 'refs/heads/loopwright/main']).catch(() => undefined);

      // Put Run A (`run-p4-mcp-window`) into `push_only` state (`headOid = H_A`) on remote.
      interceptNextMemoryGetPulls = null;
      const origPost = githubServer;
      void origPost;
      // Trigger PR 500 for Run A by pointing `apiBaseUrl` at an endpoint returning 500 on POST /pulls:
      const failPrServer = await startHttpServer(async (req, res) => {
        const u = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (u.pathname === '/repos/acme/repo/pulls' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('[]');
          return;
        }
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"message":"temp outage"}');
      });
      try {
        const runAFail = await finalizeAndPublishTurnkeyMemory({
          repositoryRoot: repo,
          taskpackPath: '.auto-sync/taskpack.yaml',
          manifest: loadedManifest,
          repositoryFullName: 'acme/repo',
          baseRevision: mainSha,
          runRoot,
          runId: 'run-p4-mcp-window',
          upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
          scrubber,
          githubToken: 'ghp_p4_token_123456',
          apiBaseUrl: failPrServer.url,
          remoteUrl: staleNamedRemote,
        });
        assert.equal(runAFail.status, 'reconcile_required');
      } finally {
        await failPrServer.close();
      }
      await reconcileTurnkeyMemoryPublication({
        runRoot,
        runId: 'run-p4-mcp-window',
        outcome: 'push_only',
        scrubber,
      });
      const journalA = await readMemoryPublicationJournal(runRoot, 'run-p4-mcp-window');
      assert.equal(journalA?.state, 'push_only');
      const headA = journalA!.headOid;

      // Create a second settled run directory `run-p4-fresh-b` with a distinct check outcome (`failed` via schema_version 2) so Run B produces a new failure_observation commit `H_B` on top of `H_A`!
      turn = 0;
      schemaVersionToWrite = 2;
      const primaryB = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 901,
        baseRevision: mainSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-p4-fresh-b',
        turnkey: true,
        dryRun: false,
        allowManifestCustomBaseUrl: true,
        mcpServersJson,
        githubApiBaseUrl: githubServer.url,
        githubToken: '',
        gitRemoteUrl: '',
        upstreamRecordsJson: JSON.stringify([{ upstreamId: 'engine', status: 'available', version: 'v2.5.0' }]),
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-p4-llm-token-123456',
          MCP_BEARER_TOKEN: 'mcp-secret-bearer-789',
        },
      });
      assert.equal(primaryB.kind, 'compiled');

      // Now start Run A's `push_only` recovery; inside Run A's `GET /pulls`, run Run B to completion!
      memoryPostCalls = 0;
      memoryPatchCalls = 0;
      const observed: { resB: Awaited<ReturnType<typeof finalizeAndPublishTurnkeyMemory>> | null } = { resB: null };
      interceptNextMemoryGetPulls = async () => {
        observed.resB = await finalizeAndPublishTurnkeyMemory({
          repositoryRoot: repo,
          taskpackPath: '.auto-sync/taskpack.yaml',
          manifest: loadedManifest,
          repositoryFullName: 'acme/repo',
          baseRevision: mainSha,
          runRoot,
          runId: 'run-p4-fresh-b',
          upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.5.0' }],
          scrubber,
          githubToken: 'ghp_p4_token_123456',
          apiBaseUrl: githubServer!.url,
          remoteUrl: staleNamedRemote,
          nowMs: Date.now() + 20_000,
        });
        // Return a stale pre-Run-B PR snapshot with `head.sha === headA` to Run A!
        return [{
          number: 91,
          html_url: 'https://github.invalid/acme/repo/pull/91',
          head: { ref: memBranch, sha: headA, repo: { full_name: 'acme/repo', fork: false } },
          base: { ref: 'main' },
        }];
      };

      const staleReplayARes = await finalizeAndPublishTurnkeyMemory({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest: loadedManifest,
        repositoryFullName: 'acme/repo',
        baseRevision: mainSha,
        runRoot,
        runId: 'run-p4-mcp-window',
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        scrubber,
        githubToken: 'ghp_p4_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: staleNamedRemote,
      });
      assert.equal(
        observed.resB?.status,
        'published',
        `Run B should publish cleanly onto H_A (got ${observed.resB?.status ?? 'null'}: ${observed.resB?.reason ?? ''})`,
      );
      assert.equal(
        staleReplayARes.status,
        'refused',
        `stale Run A recovery must refuse after Run B advanced the branch (got ${staleReplayARes.status}: ${staleReplayARes.reason ?? ''})`,
      );
      assert.match(staleReplayARes.reason ?? '', /MEMORY_CAS_CONFLICT/);
      assert.equal(memoryPostCalls, 1, 'only Run B may POST /pulls');
      assert.equal(memoryPatchCalls, 0, 'stale Run A must never PATCH /pulls/91');

      const journalB = await readMemoryPublicationJournal(runRoot, 'run-p4-fresh-b');
      assert.equal(journalB?.state, 'completed');
      const finalFence = JSON.parse(await readFile(fencePath, 'utf8')) as Record<string, unknown>;
      assert.equal(finalFence['runId'], 'run-p4-fresh-b', 'branch fence must remain owned by newer Run B');
      assert.equal(finalFence['headOid'], journalB!.headOid);

      // Reconciling older Run A must ALSO never clobber Run B's fence!
      await reconcileTurnkeyMemoryPublication({
        runRoot,
        runId: 'run-p4-mcp-window',
        outcome: 'confirmed',
        pullRequestNumber: 91,
        pullRequestUrl: 'https://github.invalid/acme/repo/pull/91',
        isUpdate: true,
        scrubber,
      });
      const fenceAfterOldReconcile = JSON.parse(await readFile(fencePath, 'utf8')) as Record<string, unknown>;
      assert.equal(fenceAfterOldReconcile['runId'], 'run-p4-fresh-b', 'reconciling older run must not overwrite newer run fence');
      assert.equal(fenceAfterOldReconcile['headOid'], journalB!.headOid);
    } finally {
      await mcpServer?.close();
      await openAiServer?.close();
      await githubServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('enforces target-fetch CAS, PR response bindings, POSIX taskpack active-memory staging, fork-repo same-repo PRs, orphan fence recovery, and abandoned eviction claims (Pass-5)', async () => {
    const rawWork = await mkdtemp(join(tmpdir(), 'lw-turnkey-mem-p5-'));
    const work = await realpath(rawWork);
    const bareRemote = join(work, 'remote.git');
    const repo = join(work, 'repo');
    const runRoot = join(work, 'runs');
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let githubServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;

    try {
      await mkdir(bareRemote, { recursive: true });
      await git(bareRemote, ['init', '--bare', '--initial-branch=main']);

      // --- 1. Same-repository PR lookup succeeds when the repository itself is a fork (`fork: true`), while cross-repo forks are rejected ---
      let pullsListResponse: unknown[] = [];
      let patchResponseOverride: Record<string, unknown> | null = null;
      let postResponseOverride: Record<string, unknown> | null = null;
      let openMemoryPr: Record<string, unknown> | null = null;
      let patchCount = 0;

      let turn = 0;
      let writeSchemaVersion = 1;
      let writeVersionString = '2.0.0';
      openAiServer = await startHttpServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== '/v1/chat/completions' || req.method !== 'POST') {
          res.writeHead(404);
          res.end();
          return;
        }
        await readJsonBody(req);
        const cur = turn;
        turn += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (cur === 0) {
          res.end(sseToolCall('gpt-4.1-mini', 'c1', 'write', {
            path: 'pack/proposal.json',
            content: `{"schema_version":${writeSchemaVersion},"version":"${writeVersionString}"}\n`,
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
          res.end(JSON.stringify({ id: 951 }));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'GET') {
          if (pullsListResponse.length > 0) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(pullsListResponse));
            return;
          }
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
            if (postResponseOverride !== null) {
              const override = postResponseOverride;
              postResponseOverride = null;
              res.writeHead(201, { 'content-type': 'application/json' });
              res.end(JSON.stringify(override));
              return;
            }
            openMemoryPr = {
              number: 101,
              html_url: 'https://github.invalid/acme/repo/pull/101',
              state: 'open',
              title: String(payload['title'] ?? ''),
              body: String(payload['body'] ?? ''),
              // Simulate `acme/repo` itself being a GitHub fork (`fork: true`)!
              head: { ref: headRef, sha: remoteSha, repo: { id: 951, full_name: 'acme/repo', fork: true } },
              base: { ref: String(payload['base'] ?? 'main'), repo: { id: 951, full_name: 'acme/repo', fork: true } },
            };
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(JSON.stringify(openMemoryPr));
            return;
          }
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ number: 100, html_url: 'https://github.invalid/acme/repo/pull/100' }));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls/101' && req.method === 'PATCH') {
          patchCount += 1;
          const payload = await readJsonBody(req);
          const lsOut = await git(repo, ['ls-remote', bareRemote, 'refs/heads/loopwright/memory/auto-sync/main']);
          const remoteSha = lsOut.split(/\s+/)[0] ?? '';
          if (patchResponseOverride !== null) {
            const override = patchResponseOverride;
            patchResponseOverride = null;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(override));
            return;
          }
          openMemoryPr = {
            number: 101,
            html_url: 'https://github.invalid/acme/repo/pull/101',
            state: 'open',
            title: String(payload['title'] ?? ''),
            body: String(payload['body'] ?? ''),
            head: { ref: 'loopwright/memory/auto-sync/main', sha: remoteSha, repo: { id: 951, full_name: 'acme/repo', fork: true } },
            base: { ref: 'main', repo: { id: 951, full_name: 'acme/repo', fork: true } },
          };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(openMemoryPr));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      const scrubber = new SecretScrubber();
      scrubber.register('ghp_p5_token_123456');

      pullsListResponse = [
        // Cross-repository fork PR (`attacker/repo`) -> must be rejected
        {
          number: 400,
          html_url: 'https://github.invalid/acme/repo/pull/400',
          state: 'open',
          head: { ref: 'loopwright/memory/auto-sync/main', sha: 'a'.repeat(40), repo: { id: 999, full_name: 'attacker/repo', fork: true } },
          base: { ref: 'main', repo: { id: 951, full_name: 'acme/repo', fork: true } },
        },
        // Same-repository PR in a repository that is itself a fork (`acme/repo`, `fork: true`) -> must be accepted!
        {
          number: 101,
          html_url: 'https://github.invalid/acme/repo/pull/101',
          state: 'open',
          head: { ref: 'loopwright/memory/auto-sync/main', sha: 'b'.repeat(40), repo: { id: 951, full_name: 'acme/repo', fork: true } },
          base: { ref: 'main', repo: { id: 951, full_name: 'acme/repo', fork: true } },
        },
      ];
      const matchedForkSelfRepo = await findOpenMemoryPullRequest({
        apiBaseUrl: githubServer.url,
        repositoryFullName: 'acme/repo',
        targetBranch: 'main',
        memoryBranch: 'loopwright/memory/auto-sync/main',
        githubToken: 'ghp_p5_token_123456',
        scrubber,
      });
      assert.notEqual(matchedForkSelfRepo, null, 'same-repository PR on a forked repository must be accepted');
      assert.equal(matchedForkSelfRepo?.number, 101);
      pullsListResponse = [];

      async function initTurnkeyRepoP5(targetRepo: string, remotePath: string): Promise<void> {
        await mkdir(targetRepo, { recursive: true });
        await git(targetRepo, ['init', '--initial-branch=main']);
        await git(targetRepo, ['config', 'user.name', 'Test']);
        await git(targetRepo, ['config', 'user.email', 'test@example.com']);
        await git(targetRepo, ['remote', 'add', 'origin', remotePath]);
        await mkdir(join(targetRepo, '.auto-sync', 'prompts'), { recursive: true });
        await mkdir(join(targetRepo, '.auto-sync', 'checks'), { recursive: true });
        await mkdir(join(targetRepo, 'docs'), { recursive: true });
        await mkdir(join(targetRepo, 'pack'), { recursive: true });
        await writeFile(join(targetRepo, '.auto-sync', 'prompts', 'instructions.md'), '# Guide\n', 'utf8');
        await writeFile(join(targetRepo, 'docs', 'sync.md'), '# Sync\n', 'utf8');
        await writeFile(join(targetRepo, 'pack', 'proposal.json'), '{"schema_version":1,"version":"1.0.0"}\n', 'utf8');
        await writeFile(
          join(targetRepo, '.auto-sync', 'checks', 'verify.sh'),
          '#!/bin/sh\ngrep -q \'"2.0.0"\' "$LOOPWRIGHT_CANDIDATE_DIR/pack/proposal.json"\n',
          { mode: 0o755 },
        );
      }

      function buildMemEntryP5(params: {
        readonly id: string;
        readonly claimKey: string;
        readonly claim: string;
        readonly baseRevision: string;
        readonly codeFingerprint: { readonly algorithm: 'sha256'; readonly hex: string };
        readonly verifiedAtMs: number;
        readonly taskpack?: string;
      }): MemoryEntry {
        const evidenceDigest = hashDomain('p5-ev', { id: params.id, claim: params.claim });
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
            runId: 'seed-p5',
            lockHash: hashDomain('p5-lock', params.id),
            candidateDigest: hashDomain('p5-cand', params.id),
          },
          sourceDigest: hashDomain('p5-src', { id: params.id, claim: params.claim }),
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

      async function writeProjectedStoreP5(
        targetRepo: string,
        projection: ReturnType<typeof projectMemoryStore>,
        taskpackName = 'auto-sync',
      ): Promise<void> {
        const memDir = join(targetRepo, '.auto-sync', 'memory', taskpackName);
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

      // --- 2. POSIX taskpack identifiers `aux` and `con.examples` compile and stage 0o400 active memory cleanly ---
      for (const posixName of ['aux', 'con.examples'] as const) {
        const posixRepo = join(work, `repo-${posixName.replace('.', '_')}`);
        await initTurnkeyRepoP5(posixRepo, bareRemote);
        const posixYaml = makeTaskpackYaml(openAiServer.url).replace('  name: auto-sync\n', `  name: ${posixName}\n`);
        await writeFile(join(posixRepo, '.auto-sync', 'taskpack.yaml'), posixYaml, 'utf8');
        await git(posixRepo, ['add', '.']);
        await git(posixRepo, ['commit', '-m', `init ${posixName}`]);
        const posixHead = await git(posixRepo, ['rev-parse', 'HEAD']);
        const posixFp = await computeCodeFingerprint(posixRepo, ['docs/**', 'pack/**'], '.auto-sync/memory');
        const nowMs = Date.now();
        const posixProj = projectMemoryStore(
          emptyMemoryStoreIndex(posixName, 'acme/repo', nowMs),
          [{
            kind: 'upsert',
            entry: buildMemEntryP5({
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
        await writeProjectedStoreP5(posixRepo, posixProj, posixName);
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

      // --- 3. Initialize main repo and publish initial memory PR #101 on `fork: true` same-repo ---
      await mkdir(runRoot, { recursive: true });
      await initTurnkeyRepoP5(repo, bareRemote);
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), makeTaskpackYaml(openAiServer.url), 'utf8');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'init p5 main']);
      const baseSha = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['push', 'origin', 'HEAD:refs/heads/main']);

      turn = 0;
      writeSchemaVersion = 1;
      const run1 = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 951,
        baseRevision: baseSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-p5-1',
        turnkey: true,
        dryRun: false,
        allowManifestCustomBaseUrl: true,
        githubApiBaseUrl: githubServer.url,
        githubToken: 'ghp_p5_token_123456',
        gitRemoteUrl: bareRemote,
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-p5-llm-token-123456',
        },
      });
      assert.equal(run1.kind, 'compiled');
      if (run1.kind === 'compiled') {
        assert.equal(run1.memory?.status, 'published');
        assert.equal(run1.memory?.pullRequestNumber, 101);
      }

      const loadedMain = await loadDeclarativeTaskpack({
        repositoryRoot: repo,
        manifestPath: '.auto-sync/taskpack.yaml',
      });

      // Produce a second settled run (`run-p5-2`) with a distinct entry (`failure_observation` via schema_version 2)
      turn = 0;
      writeSchemaVersion = 2;
      const run2Primary = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 951,
        baseRevision: baseSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-p5-2',
        turnkey: true,
        dryRun: false,
        allowManifestCustomBaseUrl: true,
        githubApiBaseUrl: githubServer.url,
        githubToken: '',
        gitRemoteUrl: '',
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-p5-llm-token-123456',
        },
      });
      assert.equal(run2Primary.kind, 'compiled');

      // --- 4. Diverge remote `main` memory store, then simulate target-fetch failure (`refs/heads/main` temporarily missing on remote) -> MUST fail closed (`failed`), NEVER `updated`! ---
      const divergeClone = join(work, 'diverge-clone');
      await git(work, ['-c', 'protocol.file.allow=always', 'clone', bareRemote, divergeClone]);
      await git(divergeClone, ['config', 'user.name', 'Test']);
      await git(divergeClone, ['config', 'user.email', 'test@example.com']);
      const divergeFp = await computeCodeFingerprint(divergeClone, ['docs/**', 'pack/**'], '.auto-sync/memory');
      const nowDiv = Date.now();
      const divProj = projectMemoryStore(
        emptyMemoryStoreIndex('auto-sync', 'acme/repo', nowDiv),
        [{
          kind: 'upsert',
          entry: buildMemEntryP5({
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
      await writeProjectedStoreP5(divergeClone, divProj);
      await git(divergeClone, ['add', '.auto-sync/memory']);
      await git(divergeClone, ['commit', '-m', 'chore(memory): diverge main store']);
      const divergedMainSha = await git(divergeClone, ['rev-parse', 'HEAD']);
      await git(divergeClone, ['push', 'origin', 'HEAD:refs/heads/main']);

      // With `refs/heads/main` present on remote, diverged store returns `refused` (CAS conflict).
      const normalDivergedRes = await finalizeAndPublishTurnkeyMemory({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest: loadedMain,
        repositoryFullName: 'acme/repo',
        baseRevision: baseSha,
        runRoot,
        runId: 'run-p5-2',
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        scrubber,
        githubToken: 'ghp_p5_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: bareRemote,
      });
      assert.equal(normalDivergedRes.status, 'refused');

      // Now simulate target-branch fetch failure (delete `refs/heads/main` on bareRemote after moving HEAD to temp ref) -> MUST return `failed`, NEVER `updated`!
      await git(bareRemote, ['symbolic-ref', 'HEAD', 'refs/heads/temp-default']);
      await git(bareRemote, ['update-ref', 'refs/heads/temp-default', divergedMainSha]);
      await git(bareRemote, ['update-ref', '-d', 'refs/heads/main']);
      try {
        const failedFetchRes = await finalizeAndPublishTurnkeyMemory({
          repositoryRoot: repo,
          taskpackPath: '.auto-sync/taskpack.yaml',
          manifest: loadedMain,
          repositoryFullName: 'acme/repo',
          baseRevision: baseSha,
          runRoot,
          runId: 'run-p5-2',
          upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
          scrubber,
          githubToken: 'ghp_p5_token_123456',
          apiBaseUrl: githubServer.url,
          remoteUrl: bareRemote,
        });
        assert.equal(failedFetchRes.status, 'failed', 'target-fetch failure must abort publication instead of bypassing CAS');
        assert.match(failedFetchRes.reason ?? '', /failed to fetch remote target branch "main"/);
        assert.equal(patchCount, 0);
      } finally {
        // Restore remote `refs/heads/main` back to `baseSha` so subsequent update tests run cleanly!
        await git(bareRemote, ['update-ref', 'refs/heads/main', baseSha]);
        await git(bareRemote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
        await git(bareRemote, ['update-ref', '-d', 'refs/heads/temp-default']);
      }

      // --- 5. Dead lock owner + abandoned `.evict-<nonce>` (0-byte ownerless claim AND dead-PID JSON claim) are reclaimed cleanly ---
      const memBranch = 'loopwright/memory/auto-sync/main';
      const fenceKey = createHash('sha256').update(`acme/repo\0${memBranch}`).digest('hex');
      const fencesDir = join(runRoot, '.memory-publications');
      const lockPath = join(fencesDir, `${fenceKey}.lock`);
      const fencePath = join(fencesDir, `${fenceKey}.json`);
      const deadNonce = 'deadbeefcafebabe12345678';
      const evictClaimPath = `${lockPath}.evict-${deadNonce}`;

      // 5a: Dead lock + abandoned 0-byte `.evict-<nonce>` claim
      await writeFile(
        lockPath,
        `${JSON.stringify({ version: 1, pid: 999_999, nonce: deadNonce, runId: 'dead-run', acquiredAtMs: Date.now() - 5_000 })}\n`,
        { mode: 0o600 },
      );
      await writeFile(evictClaimPath, '', { mode: 0o600 });

      // Inject retargeted PATCH response (`base.ref: 'release'`) simultaneously to test Finding 3!
      patchResponseOverride = {
        number: 101,
        html_url: 'https://github.invalid/acme/repo/pull/101',
        state: 'open',
        head: { ref: memBranch, repo: { id: 951, full_name: 'acme/repo', fork: true } },
        base: { ref: 'release', repo: { id: 951, full_name: 'acme/repo', fork: true } },
      };

      const retargetedPatchRes = await finalizeAndPublishTurnkeyMemory({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest: loadedMain,
        repositoryFullName: 'acme/repo',
        baseRevision: baseSha,
        runRoot,
        runId: 'run-p5-2',
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        scrubber,
        githubToken: 'ghp_p5_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: bareRemote,
      });
      // Lock + abandoned 0-byte `.evict-<nonce>` succeeded, AND retargeted `base.ref: 'release'` on PATCH retained uncertainty!
      assert.equal(patchCount, 1, 'fork: true same-repo PR #101 should be dispatched via PATCH after reclaiming abandoned eviction claim');
      assert.equal(retargetedPatchRes.status, 'reconcile_required', 'retargeted PR response (base.ref: release) must retain uncertainty');
      assert.match(retargetedPatchRes.reason ?? '', /base binding did not match "acme\/repo:main"/);

      // 5b: Dead lock + dead-PID JSON `.evict-<nonce>` claim ALSO reclaims immediately during reconciliation!
      const deadNonce2 = 'abcdef0123456789abcdef01';
      await writeFile(
        lockPath,
        `${JSON.stringify({ version: 1, pid: 999_999, nonce: deadNonce2, runId: 'dead-run-2', acquiredAtMs: Date.now() - 5_000 })}\n`,
        { mode: 0o600 },
      );
      await writeFile(
        `${lockPath}.evict-${deadNonce2}`,
        `${JSON.stringify({ version: 1, pid: 999_999, nonce: '111111112222222233333333', targetNonce: deadNonce2, createdAtMs: Date.now() - 5_000 })}\n`,
        { mode: 0o600 },
      );
      const reconciledPushOnly = await reconcileTurnkeyMemoryPublication({
        runRoot,
        runId: 'run-p5-2',
        outcome: 'push_only',
        scrubber,
      });
      assert.equal(reconciledPushOnly.status, 'skipped');

      // Replay `run-p5-2` cleanly now that `patchResponseOverride` is cleared -> updates PR #101 (`fork: true` same-repo) to `updated`!
      const validReplayRes = await finalizeAndPublishTurnkeyMemory({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest: loadedMain,
        repositoryFullName: 'acme/repo',
        baseRevision: baseSha,
        runRoot,
        runId: 'run-p5-2',
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        scrubber,
        githubToken: 'ghp_p5_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: bareRemote,
      });
      assert.equal(validReplayRes.status, 'updated');
      assert.equal(validReplayRes.pullRequestNumber, 101);

      // --- 6. Pre-dispatch journal write failure leaves zero blocking fence, AND orphan fences reconcile cleanly ---
      turn = 0;
      writeSchemaVersion = 1;
      writeVersionString = '3.0.0';
      const run3Primary = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 951,
        baseRevision: baseSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-p5-3',
        turnkey: true,
        dryRun: false,
        allowManifestCustomBaseUrl: true,
        githubApiBaseUrl: githubServer.url,
        githubToken: '',
        gitRemoteUrl: '',
        upstreamRecordsJson: JSON.stringify([{ upstreamId: 'engine', status: 'available', version: 'v3.0.0' }]),
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-p5-llm-token-123456',
        },
      });
      assert.equal(run3Primary.kind, 'compiled');

      // Make `runs/run-p5-3` read-only (0o500) so `readMemoryPublicationJournal` + `finalizeRunMemory` succeed,
      // while `writeAtomicPrivateFile` on `memory-publication.json` fails (`EACCES`) right inside `writeFenceAndJournalUnlocked`!
      const run3Dir = join(runRoot, 'run-p5-3');
      await chmod(run3Dir, 0o500);
      try {
        const journalWriteFailRes = await finalizeAndPublishTurnkeyMemory({
          repositoryRoot: repo,
          taskpackPath: '.auto-sync/taskpack.yaml',
          manifest: loadedMain,
          repositoryFullName: 'acme/repo',
          baseRevision: baseSha,
          runRoot,
          runId: 'run-p5-3',
          upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v3.0.0' }],
          scrubber,
          githubToken: 'ghp_p5_token_123456',
          apiBaseUrl: githubServer.url,
          remoteUrl: bareRemote,
        });
        assert.equal(journalWriteFailRes.status, 'failed');
        const fenceAfterFailedJournalWrite = JSON.parse(await readFile(fencePath, 'utf8')) as Record<string, unknown>;
        assert.equal(fenceAfterFailedJournalWrite['runId'], 'run-p5-2', 'pre-dispatch journal write failure must never overwrite or poison branch fence');
        assert.equal(fenceAfterFailedJournalWrite['state'], 'completed');
      } finally {
        await chmod(run3Dir, 0o700);
      }

      // Simulate an orphan `uncertain` fence for `orphan-run-99` with NO `memory-publication.json` on disk!
      const savedGoodFence = await readFile(fencePath, 'utf8');
      await writeFile(
        fencePath,
        `${JSON.stringify({
          version: 1,
          repository: 'acme/repo',
          branchName: memBranch,
          runId: 'orphan-run-99',
          state: 'uncertain',
          stage: 'push',
          headOid: 'c'.repeat(40),
          previousConfirmedHeadOid: JSON.parse(savedGoodFence)['headOid'],
          updatedAtMs: Date.now(),
        }, null, 2)}\n`,
        { mode: 0o600 },
      );

      // Reconciling `orphan-run-99` (`not_executed`) succeeds even without `runs/orphan-run-99/memory-publication.json` and restores previousConfirmedHeadOid!
      const orphanReconciled = await reconcileTurnkeyMemoryPublication({
        runRoot,
        runId: 'orphan-run-99',
        outcome: 'not_executed',
        scrubber,
      });
      assert.equal(orphanReconciled.status, 'skipped');
      const restoredFenceAfterOrphan = JSON.parse(await readFile(fencePath, 'utf8')) as Record<string, unknown>;
      assert.equal(restoredFenceAfterOrphan['state'], 'push_only');
      assert.equal(restoredFenceAfterOrphan['headOid'], JSON.parse(savedGoodFence)['headOid']);
    } finally {
      await openAiServer?.close();
      await githubServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('binds retained runs to publication target, confirms pushed PR head SHA, preserves custom-root orphan fences, and paginates PR lookup safely (Pass-6)', async () => {
    const rawWork = await mkdtemp(join(tmpdir(), 'lw-turnkey-mem-p6-'));
    const work = await realpath(rawWork);
    const bareRemote = join(work, 'remote.git');
    const repo = join(work, 'repo');
    const runRoot = join(work, 'runs');
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | null = null;
    let githubServer: Awaited<ReturnType<typeof startHttpServer>> | null = null;

    try {
      await mkdir(bareRemote, { recursive: true });
      await git(bareRemote, ['init', '--bare', '--initial-branch=main']);

      let turn = 0;
      const writeVersionString = '2.0.0';
      let writeSchemaVersion = 1;
      openAiServer = await startHttpServer(async (_req, res) => {
        turn += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (turn === 1) {
          res.end(
            sseToolCall('gpt-4.1-mini', 'call_write_p6', 'write', {
              path: 'pack/proposal.json',
              content: `{"schema_version":${writeSchemaVersion},"version":"${writeVersionString}"}\n`,
            }),
          );
          return;
        }
        res.end(sseStop('gpt-4.1-mini', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null })));
      });

      let openMemoryPr: Record<string, unknown> | null = null;
      let patchMode: 'normal' | 'missing_sha_no_get' | 'stale_sha_concurrent_reset' | 'stale_sha_lagging_then_confirmed' = 'normal';
      let priorMemoryHeadSha = '';
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
          const headParam = url.searchParams.get('head') ?? '';
          const pageParam = Number(url.searchParams.get('page') ?? '1');
          if (url.searchParams.get('base') === 'exhaust-test') {
            // Simulate a server ignoring `head` and returning 100 non-matching open PRs on every page 1..5!
            const hundred = Array.from({ length: 100 }, (_, idx) => ({
              number: (pageParam - 1) * 100 + idx + 1,
              html_url: `https://github.invalid/acme/repo/pull/${(pageParam - 1) * 100 + idx + 1}`,
              state: 'open',
              title: `other pr ${idx}`,
              body: '',
              head: { ref: `feature/other-${pageParam}-${idx}`, sha: '1'.repeat(40), repo: { id: 961, full_name: 'acme/repo', fork: false } },
              base: { ref: 'exhaust-test', sha: '2'.repeat(40), repo: { id: 961, full_name: 'acme/repo', fork: false } },
            }));
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(hundred));
            return;
          }
          if (url.searchParams.get('base') === 'deep-page-test') {
            // Simulate 600 open PRs where ONLY exact `head=acme:loopwright/memory/auto-sync/deep-page-test` returns PR #601 on page 1!
            if (headParam === 'acme:loopwright/memory/auto-sync/deep-page-test') {
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify([{
                number: 601,
                html_url: 'https://github.invalid/acme/repo/pull/601',
                state: 'open',
                title: 'memory pr on page 6 without head filter',
                body: '',
                head: { ref: 'loopwright/memory/auto-sync/deep-page-test', sha: '3'.repeat(40), repo: { id: 961, full_name: 'acme/repo', fork: false } },
                base: { ref: 'deep-page-test', sha: '4'.repeat(40), repo: { id: 961, full_name: 'acme/repo', fork: false } },
              }]));
              return;
            }
            const hundred = Array.from({ length: 100 }, (_, idx) => ({
              number: (pageParam - 1) * 100 + idx + 1,
              html_url: `https://github.invalid/acme/repo/pull/${(pageParam - 1) * 100 + idx + 1}`,
              state: 'open',
              title: `other pr ${idx}`,
              body: '',
              head: { ref: `feature/other-${pageParam}-${idx}`, sha: '1'.repeat(40), repo: { id: 961, full_name: 'acme/repo', fork: false } },
              base: { ref: 'deep-page-test', sha: '4'.repeat(40), repo: { id: 961, full_name: 'acme/repo', fork: false } },
            }));
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(hundred));
            return;
          }
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
              head: { ref: headRef, sha: remoteSha, repo: { id: 961, full_name: 'acme/repo', fork: false } },
              base: { ref: String(payload['base'] ?? 'main'), repo: { id: 961, full_name: 'acme/repo', fork: false } },
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
          const payload = await readJsonBody(req);
          const lsOut = await git(repo, ['ls-remote', bareRemote, 'refs/heads/loopwright/memory/auto-sync/main']);
          const remoteSha = lsOut.split(/\s+/)[0] ?? '';
          if (patchMode === 'missing_sha_no_get') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              number: 201,
              html_url: 'https://github.invalid/acme/repo/pull/201',
              state: 'open',
              head: { ref: 'loopwright/memory/auto-sync/main', repo: { id: 961, full_name: 'acme/repo', fork: false } },
              base: { ref: 'main', repo: { id: 961, full_name: 'acme/repo', fork: false } },
            }));
            return;
          }
          if (patchMode === 'stale_sha_concurrent_reset') {
            // Simulate a concurrent reset on the remote back to `priorMemoryHeadSha`!
            await git(bareRemote, ['update-ref', 'refs/heads/loopwright/memory/auto-sync/main', priorMemoryHeadSha]);
            openMemoryPr = {
              number: 201,
              html_url: 'https://github.invalid/acme/repo/pull/201',
              state: 'open',
              title: String(payload['title'] ?? ''),
              body: String(payload['body'] ?? ''),
              head: { ref: 'loopwright/memory/auto-sync/main', sha: priorMemoryHeadSha, repo: { id: 961, full_name: 'acme/repo', fork: false } },
              base: { ref: 'main', repo: { id: 961, full_name: 'acme/repo', fork: false } },
            };
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(openMemoryPr));
            return;
          }
          if (patchMode === 'stale_sha_lagging_then_confirmed') {
            // PATCH response lags (`priorMemoryHeadSha`), while remote ref & GET /pulls/201 carry `remoteSha`!
            openMemoryPr = {
              number: 201,
              html_url: 'https://github.invalid/acme/repo/pull/201',
              state: 'open',
              title: String(payload['title'] ?? ''),
              body: String(payload['body'] ?? ''),
              head: { ref: 'loopwright/memory/auto-sync/main', sha: remoteSha, repo: { id: 961, full_name: 'acme/repo', fork: false } },
              base: { ref: 'main', repo: { id: 961, full_name: 'acme/repo', fork: false } },
            };
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              ...openMemoryPr,
              head: { ref: 'loopwright/memory/auto-sync/main', sha: priorMemoryHeadSha, repo: { id: 961, full_name: 'acme/repo', fork: false } },
            }));
            return;
          }
          openMemoryPr = {
            number: 201,
            html_url: 'https://github.invalid/acme/repo/pull/201',
            state: 'open',
            title: String(payload['title'] ?? ''),
            body: String(payload['body'] ?? ''),
            head: { ref: 'loopwright/memory/auto-sync/main', sha: remoteSha, repo: { id: 961, full_name: 'acme/repo', fork: false } },
            base: { ref: 'main', repo: { id: 961, full_name: 'acme/repo', fork: false } },
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

      // --- 1. `findOpenMemoryPullRequest` passes exact `head=owner:branch` AND throws on exhausted 500-PR pagination ---
      const foundDeepPr = await findOpenMemoryPullRequest({
        apiBaseUrl: githubServer.url,
        repositoryFullName: 'acme/repo',
        targetBranch: 'deep-page-test',
        memoryBranch: 'loopwright/memory/auto-sync/deep-page-test',
        githubToken: 'ghp_p6_token_123456',
        scrubber,
      });
      assert.equal(foundDeepPr?.number, 601, 'exact head filter must find PR #601 even when unfiltered open PRs exceed 500');

      await assert.rejects(
        () =>
          findOpenMemoryPullRequest({
            apiBaseUrl: githubServer!.url,
            repositoryFullName: 'acme/repo',
            targetBranch: 'exhaust-test',
            memoryBranch: 'loopwright/memory/auto-sync/exhaust-test',
            githubToken: 'ghp_p6_token_123456',
            scrubber,
          }),
        /exhausted pagination/,
        'incomplete 5-page pagination must throw rather than falsely returning null',
      );

      // --- 2. Initialize repo and run initial turnkey run (`run-p6-1`) ---
      await mkdir(repo, { recursive: true });
      await mkdir(runRoot, { recursive: true });
      await git(repo, ['init', '--initial-branch=main']);
      await git(repo, ['config', 'user.name', 'Test']);
      await git(repo, ['config', 'user.email', 'test@example.com']);
      await git(repo, ['remote', 'add', 'origin', bareRemote]);
      await mkdir(join(repo, '.auto-sync', 'prompts'), { recursive: true });
      await mkdir(join(repo, '.auto-sync', 'checks'), { recursive: true });
      await mkdir(join(repo, 'docs'), { recursive: true });
      await mkdir(join(repo, 'pack'), { recursive: true });
      await writeFile(join(repo, '.auto-sync', 'prompts', 'instructions.md'), '# Guide\n', 'utf8');
      await writeFile(join(repo, 'docs', 'sync.md'), '# Sync\n', 'utf8');
      await writeFile(join(repo, 'pack', 'proposal.json'), '{"schema_version":1,"version":"1.0.0"}\n', 'utf8');
      await writeFile(
        join(repo, '.auto-sync', 'checks', 'verify.sh'),
        '#!/bin/sh\ngrep -q \'"2.0.0"\' "$LOOPWRIGHT_CANDIDATE_DIR/pack/proposal.json"\n',
        { mode: 0o755 },
      );
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), makeTaskpackYaml(openAiServer.url), 'utf8');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'init p6']);
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
        runId: 'run-p6-1',
        turnkey: true,
        dryRun: false,
        allowManifestCustomBaseUrl: true,
        githubApiBaseUrl: githubServer.url,
        githubToken: 'ghp_p6_token_123456',
        gitRemoteUrl: bareRemote,
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-p6-llm-token-123456',
        },
      });
      assert.equal(run1.kind, 'compiled');
      if (run1.kind === 'compiled') {
        assert.equal(run1.memory?.status, 'published');
      }

      const loadedManifest = await loadDeclarativeTaskpack({
        repositoryRoot: repo,
        manifestPath: '.auto-sync/taskpack.yaml',
      });

      // Produce a second settled run (`run-p6-2`) on `acme/repo` without publishing yet
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
        runId: 'run-p6-2',
        turnkey: true,
        dryRun: false,
        allowManifestCustomBaseUrl: true,
        githubApiBaseUrl: githubServer.url,
        githubToken: '',
        gitRemoteUrl: '',
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-p6-llm-token-123456',
        },
      });
      assert.equal(run2Primary.kind, 'compiled');

      // --- 3. Publishing retained `acme/repo` run (`run-p6-2`) to `other/repo` MUST be refused! ---
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
        runId: 'run-p6-2',
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        scrubber,
        githubToken: 'ghp_p6_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: otherBareRemote,
      });
      assert.equal(crossRepoRefused.status, 'refused', 'retained acme/repo run must never publish to other/repo');
      assert.match(crossRepoRefused.reason ?? '', /MEMORY_SCOPE_VIOLATION: retained run repository "acme\/repo" does not match publication repository "other\/repo"/);
      const otherLsRemote = await git(repo, ['ls-remote', otherBareRemote, 'refs/heads/loopwright/memory/auto-sync/main']);
      assert.equal(otherLsRemote, '', 'other/repo remote must remain completely untouched');

      // --- 4a. PATCH response omitting `head.sha` (with unconfirmed GET) retains `reconcile_required` ---
      patchMode = 'missing_sha_no_get';
      const missingShaRes = await finalizeAndPublishTurnkeyMemory({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest: loadedManifest,
        repositoryFullName: 'acme/repo',
        baseRevision: baseSha,
        runRoot,
        runId: 'run-p6-2',
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        scrubber,
        githubToken: 'ghp_p6_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: bareRemote,
      });
      assert.equal(missingShaRes.status, 'reconcile_required', 'missing head.sha without GET confirmation must stay uncertain');

      // --- 4b. Delete `memory-publication.json` to simulate a custom-root (`.auto-sync/memory/auto-sync`) orphan fence, reconcile `push_only`, and replay! ---
      await unlink(join(runRoot, 'run-p6-2', 'memory-publication.json'));
      const orphanPushOnly = await reconcileTurnkeyMemoryPublication({
        runRoot,
        runId: 'run-p6-2',
        outcome: 'push_only',
        scrubber,
      });
      assert.equal(orphanPushOnly.status, 'skipped');
      assert.equal(orphanPushOnly.directory, '.auto-sync/memory/auto-sync', 'custom-root orphan fence must preserve .auto-sync/memory/auto-sync');

      // --- 4c. Replay `run-p6-2` while PATCH returns stale `priorMemoryHeadSha` due to concurrent reset -> MUST stay `reconcile_required`! ---
      patchMode = 'stale_sha_concurrent_reset';
      const concurrentResetRes = await finalizeAndPublishTurnkeyMemory({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest: loadedManifest,
        repositoryFullName: 'acme/repo',
        baseRevision: baseSha,
        runRoot,
        runId: 'run-p6-2',
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        scrubber,
        githubToken: 'ghp_p6_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: bareRemote,
      });
      assert.equal(concurrentResetRes.status, 'reconcile_required', 'concurrent reset returning old head.sha must never report updated');

      // Clear `run-p6-2` as `not_executed` (since remote was reset back to `priorMemoryHeadSha`), then re-run `run-p6-2` with lagging PATCH + confirmed read-only GET!
      await reconcileTurnkeyMemoryPublication({
        runRoot,
        runId: 'run-p6-2',
        outcome: 'not_executed',
        scrubber,
      });
      await unlink(join(runRoot, 'run-p6-2', 'memory-publication.json')).catch(() => undefined);
      const fenceKey = createHash('sha256')
        .update('acme/repo\0loopwright/memory/auto-sync/main')
        .digest('hex');
      const fencePath = join(runRoot, '.memory-publications', `${fenceKey}.json`);
      // Restore fence to `completed` at `priorMemoryHeadSha` so fresh `run-p6-2` pushes cleanly on top of PR #201
      await writeFile(
        fencePath,
        `${JSON.stringify({
          version: 1,
          repository: 'acme/repo',
          branchName: 'loopwright/memory/auto-sync/main',
          runId: 'run-p6-1',
          taskpack: 'auto-sync',
          targetBranch: 'main',
          directory: '.auto-sync/memory/auto-sync',
          state: 'completed',
          stage: 'pull_request',
          headOid: priorMemoryHeadSha,
          previousConfirmedHeadOid: null,
          updatedAtMs: Date.now(),
        }, null, 2)}\n`,
        { mode: 0o600 },
      );

      patchMode = 'stale_sha_lagging_then_confirmed';
      getSinglePrCalls = 0;
      const laggingConfirmedRes = await finalizeAndPublishTurnkeyMemory({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest: loadedManifest,
        repositoryFullName: 'acme/repo',
        baseRevision: baseSha,
        runRoot,
        runId: 'run-p6-2',
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        scrubber,
        githubToken: 'ghp_p6_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: bareRemote,
      });
      assert.equal(laggingConfirmedRes.status, 'updated', 'read-only GET + remote ref confirming pushed headOid should settle updated');
      assert.equal(getSinglePrCalls >= 1, true, 'must perform read-only GET /pulls/201 when PATCH head.sha lags');
    } finally {
      await openAiServer?.close();
      await githubServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });
});
