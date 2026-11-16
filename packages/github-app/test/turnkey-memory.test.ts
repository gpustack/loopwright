import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import type { ControllerIncident } from '@loopwright/controller';
import { admitTask, digestArtifact } from '@loopwright/core';
import { loadMemoryStore } from '@loopwright/memory';
import {
  DEFAULT_HOST_BUDGETS,
  SecretScrubber,
  compileDeclarativeTaskpack,
  finalizeAndPublishTurnkeyMemory,
  findOpenManagedPullRequest,
  findOpenMemoryPullRequest,
  loadDeclarativeTaskpack,
  runActionCli,
  runGitHubActionEntrypoint,
  stageTaskpackForStep,
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

  it('isolates symlink escape, secret leaks, onNoModelBudget: skip, uncertain non-replay receipts, completed receipt bindings, publication.mode: disabled, and force-with-lease race rejection', async () => {
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
      let pullsRequestsCount = 0;
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
          pullsRequestsCount += 1;
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
          pullsRequestsCount += 1;
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

      // --- Case 3: GitHub PR API HTTP 500 after push records `uncertain` per-run receipt without failing primary candidate run ---
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
      assert.equal(resultJson500.memory?.branchName, 'loopwright/memory/auto-sync/main');
      assert.match(resultJson500.memory?.reason ?? '', /500/);

      const receipt500 = JSON.parse(await readFile(join(runRoot, 'run-neg-500', 'memory-publication.json'), 'utf8')) as {
        state?: string;
        status?: string;
      };
      assert.equal(receipt500.state, 'uncertain');
      assert.equal(receipt500.status, 'reconcile_required');

      const loadedManifest = await loadDeclarativeTaskpack({ manifestPath: '.auto-sync/taskpack.yaml', repositoryRoot: repo });
      const replayScrubber = new SecretScrubber();
      replayScrubber.register('ghp_neg_token_123456');
      replayScrubber.register('sk-neg-llm-token-123456');

      // Same-run replay must NOT silently re-POST while `memory-publication.json` is `uncertain`!
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
      assert.equal(memoryPrPostAttempts, 1, 'same-run replay must never silently retry uncertain POST /pulls');

      // Subsequent distinct run also stops cleanly (`reconcile_required`) via remote unmerged-branch guard without needing local lockfiles!
      const nextRunOnUnmergedBranch = await finalizeAndPublishTurnkeyMemory({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest: loadedManifest,
        repositoryFullName: 'acme/repo',
        baseRevision: headSha,
        runRoot,
        runId: 'run-neg-symlink',
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        scrubber: replayScrubber,
        githubToken: 'ghp_neg_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: bareRemote,
      });
      assert.equal(nextRunOnUnmergedBranch.status, 'reconcile_required');
      assert.match(nextRunOnUnmergedBranch.reason ?? '', /exists without an open pull request and is not merged/);

      // Corrupt `"null\n"` receipt fails closed as `reconcile_required`!
      await writeFile(join(runRoot, 'run-neg-500', 'memory-publication.json'), 'null\n', { mode: 0o600 });
      const corruptReceiptRes = await finalizeAndPublishTurnkeyMemory({
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
      assert.equal(corruptReceiptRes.status, 'reconcile_required');
      assert.match(corruptReceiptRes.reason ?? '', /corrupt memory publication receipt/);

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

      // --- Case 6: Atomic `O_CREAT | O_EXCL` per-run claim prevents duplicate same-run publication, completed receipt replays idempotently, and altered targetBranch refuses ---
      memoryPrMode = 'ok';
      memoryPrPostAttempts = 0;
      memoryPrPayloads.length = 0;
      await git(bareRemote, ['update-ref', '-d', 'refs/heads/loopwright/memory/auto-sync/main']).catch(() => undefined);
      await unlink(join(runRoot, 'run-neg-html-200', 'memory-publication.json')).catch(() => undefined);

      const claimArgs = {
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest: loadedManifest,
        repositoryFullName: 'acme/repo',
        baseRevision: headSha,
        runRoot,
        runId: 'run-neg-html-200',
        upstreamRecords: [{ upstreamId: 'engine' as const, status: 'available' as const, version: 'v2.0.0' }],
        scrubber: replayScrubber,
        githubToken: 'ghp_neg_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: bareRemote,
      };
      const [concurrentA, concurrentB] = await Promise.all([
        finalizeAndPublishTurnkeyMemory(claimArgs),
        finalizeAndPublishTurnkeyMemory(claimArgs),
      ]);
      assert.equal(memoryPrPostAttempts, 1, 'atomic O_EXCL receipt claim must dispatch POST /pulls once');
      assert.equal(
        (concurrentA.status === 'published' && concurrentB.status === 'reconcile_required')
          || (concurrentB.status === 'published' && concurrentA.status === 'reconcile_required'),
        true,
      );

      // Completed receipt replays idempotently without re-POSTing
      const idempotentReplay = await finalizeAndPublishTurnkeyMemory(claimArgs);
      assert.equal(idempotentReplay.status, 'published');
      assert.equal(idempotentReplay.pullRequestNumber, 51);
      assert.equal(memoryPrPostAttempts, 1);

      // Replay of completed receipt against altered `targetBranch` (`main` -> `release`) is refused (`MEMORY_SCOPE_VIOLATION`)
      const releaseManifest = {
        ...loadedManifest,
        spec: {
          ...loadedManifest.spec,
          publication: { ...loadedManifest.spec.publication, targetBranch: 'release' },
        },
      };
      const targetMismatchRes = await finalizeAndPublishTurnkeyMemory({
        ...claimArgs,
        manifest: releaseManifest,
      });
      assert.equal(targetMismatchRes.status, 'refused');
      assert.match(targetMismatchRes.reason ?? '', /MEMORY_SCOPE_VIOLATION/);

      // Named pipe (FIFO) at `run.json` or `memory-publication.json` fails closed immediately via `O_NONBLOCK` without hanging
      const runDirForFifo = join(runRoot, 'run-neg-html-200');
      const runJsonPath = join(runDirForFifo, 'run.json');
      const savedRunJson = await readFile(runJsonPath);
      await unlink(runJsonPath);
      await execFileAsync('mkfifo', [runJsonPath]);
      try {
        const fifoRunJsonRes = await finalizeAndPublishTurnkeyMemory(claimArgs);
        assert.equal(fifoRunJsonRes.status, 'refused');
        assert.match(fifoRunJsonRes.reason ?? '', /not a regular file/);
      } finally {
        await unlink(runJsonPath).catch(() => undefined);
        await writeFile(runJsonPath, savedRunJson);
      }

      const receiptPathForFifo = join(runDirForFifo, 'memory-publication.json');
      const savedReceipt = await readFile(receiptPathForFifo);
      await unlink(receiptPathForFifo);
      await execFileAsync('mkfifo', [receiptPathForFifo]);
      try {
        const fifoReceiptRes = await finalizeAndPublishTurnkeyMemory(claimArgs);
        assert.equal(fifoReceiptRes.status, 'reconcile_required');
        assert.match(fifoReceiptRes.reason ?? '', /not a regular file/);
      } finally {
        await unlink(receiptPathForFifo).catch(() => undefined);
        await writeFile(receiptPathForFifo, savedReceipt);
      }

      // --- Case 7: Concurrent publisher creating remote memory branch after upfront `ls-remote` is rejected by `--force-with-lease` ---
      memoryPrMode = 'ok';
      await git(bareRemote, ['update-ref', '-d', 'refs/heads/loopwright/main']).catch(() => undefined);
      await git(bareRemote, ['update-ref', '-d', 'refs/heads/loopwright/memory/auto-sync/main']).catch(() => undefined);
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

      // --- Case 8: `publication.mode: 'disabled'` performs zero remote pushes or `/pulls` calls ---
      await git(bareRemote, ['update-ref', '-d', 'refs/heads/loopwright/main']).catch(() => undefined);
      await git(bareRemote, ['update-ref', '-d', 'refs/heads/loopwright/memory/auto-sync/main']).catch(() => undefined);
      const disabledYaml = makeTaskpackYaml(openAiServer.url).replace('mode: pull_request', 'mode: disabled');
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), disabledYaml, 'utf8');
      await git(repo, ['add', '.auto-sync/taskpack.yaml']);
      await git(repo, ['commit', '-m', 'chore: disable publication mode']);
      headSha = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['push', 'origin', 'HEAD:refs/heads/main']);

      pullsRequestsCount = 0;
      turn = 0;
      const disabledFreshRes = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 601,
        baseRevision: headSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-neg-disabled-fresh',
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

  it('publishes a failure_observation memory PR from an incident-only run directory and refuses mismatched incident bindings', async () => {
    const rawWork = await mkdtemp(join(tmpdir(), 'lw-turnkey-incident-mem-'));
    const work = await realpath(rawWork);
    const bareRemote = join(work, 'remote.git');
    const repo = join(work, 'repo');
    const runRoot = join(work, 'runs');

    const memoryPrPayloads: Record<string, unknown>[] = [];
    const githubServer = await startHttpServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/repos/acme/repo/pulls') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([]));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/repos/acme/repo/pulls') {
        const body = await readJsonBody(req);
        memoryPrPayloads.push(body);
        const headRef = String(body['head'] ?? '');
        const lsOut = await git(repo, ['ls-remote', bareRemote, `refs/heads/${headRef}`]);
        const remoteSha = lsOut.split(/\s+/)[0] ?? '';
        const baseSha = await git(repo, ['rev-parse', 'HEAD']);
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          number: 71,
          html_url: 'https://github.invalid/acme/repo/pull/71',
          state: 'open',
          head: { ref: headRef, sha: remoteSha, repo: { full_name: 'acme/repo', fork: false } },
          base: { ref: 'main', sha: baseSha, repo: { full_name: 'acme/repo', fork: false } },
        }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected route' }));
    });

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
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), makeTaskpackYaml('http://127.0.0.1:1'), 'utf8');
      await writeFile(join(repo, '.auto-sync', 'prompts', 'instructions.md'), '# Incident test\n', 'utf8');
      await writeFile(join(repo, '.auto-sync', 'checks', 'verify.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await writeFile(join(repo, 'docs', 'status.md'), '# Status\n', 'utf8');
      await writeFile(join(repo, 'pack', 'proposal.json'), '{"schema_version":1,"version":"1.0.0"}\n', 'utf8');
      await writeFile(join(repo, 'pack', 'frozen.json'), '{"locked":true}\n', 'utf8');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'chore: bootstrap incident test repo']);
      const headSha = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['push', 'origin', 'HEAD:refs/heads/main']);

      const manifest = await loadDeclarativeTaskpack({ manifestPath: '.auto-sync/taskpack.yaml', repositoryRoot: repo });
      const compiled = await compileDeclarativeTaskpack(manifest, {
        mode: 'candidate',
        executionMode: 'delegated',
        repository: 'acme/repo',
        baseRevision: headSha,
        sourceRevision: headSha,
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        budgets: DEFAULT_HOST_BUDGETS,
      });

      const runId = 'run-incident-only-1';
      const locked = admitTask(compiled.config.spec.task, { admissionId: 'admission-inc-1', runId });
      assert.equal(locked.ok, true);
      if (!locked.ok) throw new Error('admitTask failed');

      const runDir = join(runRoot, runId);
      const artifactsDir = join(runDir, 'artifacts');
      await mkdir(artifactsDir, { recursive: true });
      await writeFile(join(runDir, 'run.json'), JSON.stringify({ version: 1, identity: { lock: locked.value } }), 'utf8');

      const planBytes = Buffer.from(JSON.stringify({ stage: 'execution', note: 'timed out' }), 'utf8');
      const planRefRes = digestArtifact('plan-incident.bin', planBytes);
      assert.equal(planRefRes.ok, true);
      if (!planRefRes.ok) throw new Error('digestArtifact failed');
      await writeFile(join(artifactsDir, planRefRes.value.name), planBytes);

      const incident: ControllerIncident = {
        version: 1,
        code: 'DEADLINE',
        runId,
        lockHash: locked.value.spec.lockHash,
        stage: 'execution',
        knownReferences: [planRefRes.value],
        unavailable: ['candidate'],
        cleanup: 'complete',
      };
      const incidentBytes = Buffer.from(JSON.stringify(incident), 'utf8');
      await writeFile(join(artifactsDir, `incident-${runId}.bin`), incidentBytes);

      const scrubber = new SecretScrubber();
      scrubber.register('ghp_incident_token_123456');

      const published = await finalizeAndPublishTurnkeyMemory({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest,
        repositoryFullName: 'acme/repo',
        baseRevision: headSha,
        runRoot,
        runId,
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        scrubber,
        githubToken: 'ghp_incident_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: bareRemote,
      });

      assert.equal(published.status, 'published', JSON.stringify(published));
      assert.equal(published.entryCount, 1);
      assert.equal(published.pullRequestNumber, 71);
      assert.equal(memoryPrPayloads.length, 1);

      const memClone = join(work, 'mem-clone');
      await git(work, ['clone', '--branch', 'loopwright/memory/auto-sync/main', bareRemote, memClone]);
      const loadedStore = await loadMemoryStore(memClone, 'auto-sync', 'acme/repo', '.auto-sync/memory');
      assert.equal(loadedStore.index.entries.length, 1);
      assert.equal(loadedStore.index.entries[0]?.kind, 'failure_observation');
      assert.match(loadedStore.index.entries[0]?.claim ?? '', /DEADLINE/);

      // Negative check: tampered incident lockHash is refused fail-closed
      const badRunId = 'run-incident-tampered';
      const badRunDir = join(runRoot, badRunId);
      const badArtifactsDir = join(badRunDir, 'artifacts');
      await mkdir(badArtifactsDir, { recursive: true });
      const badLocked = admitTask(compiled.config.spec.task, { admissionId: 'admission-inc-bad', runId: badRunId });
      assert.equal(badLocked.ok, true);
      if (!badLocked.ok) throw new Error('admitTask failed');
      await writeFile(join(badRunDir, 'run.json'), JSON.stringify({ version: 1, identity: { lock: badLocked.value } }), 'utf8');
      const tamperedIncident: ControllerIncident = {
        ...incident,
        runId: badRunId,
        lockHash: { algorithm: 'sha256', hex: 'f'.repeat(64) },
      };
      await writeFile(join(badArtifactsDir, `incident-${badRunId}.bin`), JSON.stringify(tamperedIncident), 'utf8');

      const refused = await finalizeAndPublishTurnkeyMemory({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest,
        repositoryFullName: 'acme/repo',
        baseRevision: headSha,
        runRoot,
        runId: badRunId,
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        scrubber,
        githubToken: 'ghp_incident_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: bareRemote,
      });
      assert.equal(refused.status, 'refused');
      assert.match(refused.reason ?? '', /MEMORY_SCHEMA_INVALID/);
    } finally {
      await githubServer.close();
      await rm(work, { recursive: true, force: true });
    }
  });
});
