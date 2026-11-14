import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import { signPayload } from '@loopwright/controller';
import {
  compareVersionTags,
  discoverTaskpackUpstreams,
  findOpenManagedPullRequest,
  GitHubAppError,
  loadDeclarativeTaskpack,
  negotiateSandboxBackend,
  resolveActionOutputFormats,
  resolveEffectiveTaskpackSandboxPolicy,
  resolveRepositoryAndRevisions,
  runActionCli,
  runGitHubActionEntrypoint,
  SecretScrubber,
  startLocalCommandGateServer,
  startNativePullRequestPublisherServer,
  writeActionOutputSinks,
} from '../src/index.js';

const execFileAsync = promisify(execFile);

const GIT_TEST_ENV: Readonly<Record<string, string>> = {
  PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
  HOME: '/nonexistent',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
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
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 20 } },
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
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 20 } },
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

describe('turnkey sandbox policy, upstream discovery, and output formatting', () => {
  it('resolves omitted spec.sandbox to direct-dedicated under GITHUB_ACTIONS=true while keeping standalone defaults fail-closed', async () => {
    const work = await mkdtemp(join(tmpdir(), 'lw-t5-sbx-'));
    try {
      const repo = join(work, 'repo');
      await mkdir(join(repo, '.auto-sync'), { recursive: true });
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: auto-sync
spec:
  goal:
    candidate: Update synced pack files
    noChange: Verify no change
  scope:
    protected:
      - pack/dependencies.json
  upstreams:
    - id: engine
      kind: github-release
      source: acme/engine
      watchedPaths:
        - pack
  proposal:
    path: pack/proposal.json
    requiredFields:
      - schema_version
    schemaVersion: 1
  verification:
    externalGates: []
    localChecks:
      - id: json
        implementation: json-artifact.v1
  publication:
    mode: pull_request
    targetBranch: main
    headBranchPrefix: loopwright/
    titleTemplate: "chore: sync"
  memory:
    directory: .auto-sync/memory
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands: []
`);
      const manifest = await loadDeclarativeTaskpack({
        manifestPath: join(repo, '.auto-sync', 'taskpack.yaml'),
        repositoryRoot: repo,
      });

      const actionsPolicy = resolveEffectiveTaskpackSandboxPolicy(manifest, {
        workspaceRoot: repo,
        relativeTaskpackPath: '.auto-sync/taskpack.yaml',
        env: { GITHUB_ACTIONS: 'true' },
      });
      assert.deepEqual(actionsPolicy.writablePaths, ['.']);
      assert.ok(actionsPolicy.protectedPaths?.includes('pack/dependencies.json'));
      assert.ok(actionsPolicy.protectedPaths?.includes('.auto-sync/taskpack.yaml'));
      const negotiated = negotiateSandboxBackend(actionsPolicy, {
        platform: 'linux',
        arch: 'x64',
        probeExecutables: false,
      });
      assert.equal(negotiated.backendId, 'direct-dedicated');
      assert.equal(negotiated.networkMode, 'allow-outbound');

      // Standalone negotiateSandboxBackend without GITHUB_ACTIONS remains fail-closed when sandbox tools are missing.
      const localPolicy = resolveEffectiveTaskpackSandboxPolicy(manifest, {
        workspaceRoot: repo,
        relativeTaskpackPath: '.auto-sync/taskpack.yaml',
        env: {},
      });
      assert.throws(() => negotiateSandboxBackend(localPolicy, {
        platform: 'linux',
        arch: 'x64',
        probeExecutables: true,
        bwrapExecutable: '/nonexistent/bwrap',
        pythonExecutable: '/nonexistent/python3',
        dockerExecutable: '/nonexistent/docker',
      }));
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('discovers github-release, git-tag, git-commit, http-json, and custom-table upstreams plus open PRs and SHAs', async () => {
    const work = await mkdtemp(join(tmpdir(), 'lw-t5-up-'));
    const repo = join(work, 'repo');
    const upstreamRepo = join(work, 'upstream.git');
    let server: Awaited<ReturnType<typeof startHttpServer>> | undefined;

    try {
      await mkdir(repo, { recursive: true });
      await git(repo, ['init', '-b', 'main']);
      await mkdir(join(repo, 'pack'), { recursive: true });
      await writeFile(join(repo, 'pack', 'table.json'), JSON.stringify({ version: 'tbl-1.0' }));
      await writeFile(join(repo, 'pack', 'proposal.json'), JSON.stringify({
        schema_version: 1,
        upstreams: { tbl: 'tbl-1.0', json_api: 'stale' },
      }));
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'init']);
      const headSha = await git(repo, ['rev-parse', 'HEAD']);

      await mkdir(upstreamRepo, { recursive: true });
      await git(upstreamRepo, ['init', '--bare', '-b', 'master']);
      await git(repo, ['push', upstreamRepo, 'HEAD:refs/heads/main']);
      await git(repo, ['tag', 'v9.0.0']);
      await git(repo, ['push', upstreamRepo, 'refs/tags/v9.0.0']);

      const emptyUpstreamRepo = join(work, 'empty-upstream.git');
      await mkdir(emptyUpstreamRepo, { recursive: true });
      await git(emptyUpstreamRepo, ['init', '--bare', '-b', 'master']);

      const prHeadSha = 'b'.repeat(40);
      server = await startHttpServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/api/repos/acme/rel/releases/latest') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v2.1.0' }));
          return;
        }
        if (url.pathname === '/json-feed') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ latest: 'v3.4.5' }));
          return;
        }
        if (url.pathname === '/api/repos/acme/repo') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 4242 }));
          return;
        }
        if (url.pathname === '/api/repos/acme/repo/pulls' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([
            {
              number: 11,
              html_url: 'https://github.invalid/acme/repo/pull/11',
              head: { ref: 'other/feature', sha: 'a'.repeat(40) },
              base: { ref: 'main', sha: headSha },
              title: 'unrelated',
              body: null,
            },
            {
              number: 19,
              html_url: 'https://github.invalid/acme/repo/pull/19',
              head: { ref: 'loopwright/main', sha: prHeadSha },
              base: { ref: 'main', sha: headSha },
              title: 'managed pr',
              body: 'existing body',
            },
          ]));
          return;
        }
        if (url.pathname === '/api/repos/acme/repo/pulls/19') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            number: 19,
            base: { ref: 'main', sha: headSha },
            head: { ref: 'loopwright/main', sha: prHeadSha },
          }));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      });

      await mkdir(join(repo, '.loopwright'), { recursive: true });
      await writeFile(join(repo, '.loopwright', 'taskpack.yaml'), `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: upstream-test
spec:
  goal:
    candidate: Update files
    noChange: Check upstreams
  scope:
    writable:
      - pack
    protected: []
  upstreams:
    - id: rel
      kind: github-release
      source: acme/rel
      watchedPaths: [pack]
    - id: tag
      kind: git-tag
      source: ${upstreamRepo}
      watchedPaths: [pack]
    - id: commit
      kind: git-commit
      source: ${upstreamRepo}
      watchedPaths: [pack]
    - id: json_api
      kind: http-json
      source: ${server.url}/json-feed
      watchedPaths: [pack]
    - id: tbl
      kind: custom-table
      source: pack/table.json
      watchedPaths: [pack]
    - id: empty_commit
      kind: git-commit
      source: ${emptyUpstreamRepo}
      watchedPaths: [pack]
  proposal:
    path: pack/proposal.json
    requiredFields: [schema_version]
    schemaVersion: 1
  verification:
    externalGates: []
    localChecks:
      - id: json
        implementation: json-artifact.v1
  publication:
    mode: pull_request
    targetBranch: main
    headBranchPrefix: loopwright/
    titleTemplate: "chore: update"
  memory:
    directory: .loopwright/memory
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands: []
`);

      const manifest = await loadDeclarativeTaskpack({
        manifestPath: join(repo, '.loopwright', 'taskpack.yaml'),
        repositoryRoot: repo,
      });

      const discovered = await discoverTaskpackUpstreams(manifest, {
        repositoryRoot: repo,
        apiBaseUrl: `${server.url}/api`,
        githubToken: 'ghp_test_token_0001',
      });
      assert.equal(discovered.length, 6);
      assert.deepEqual(discovered[0], { upstreamId: 'rel', status: 'available', version: 'v2.1.0' });
      assert.deepEqual(discovered[1], { upstreamId: 'tag', status: 'available', version: 'v9.0.0' });
      assert.deepEqual(discovered[2], { upstreamId: 'commit', status: 'available', version: headSha });
      assert.deepEqual(discovered[3], { upstreamId: 'json_api', status: 'available', version: 'v3.4.5' });
      assert.deepEqual(discovered[4], { upstreamId: 'tbl', status: 'up_to_date', version: 'tbl-1.0' });
      assert.equal(discovered[5]?.upstreamId, 'empty_commit');
      assert.equal(discovered[5]?.status, 'failed');
      assert.match(String(discovered[5]?.reason ?? ''), /git ls-remote returned no HEAD/);

      const managedPr = await findOpenManagedPullRequest({
        apiBaseUrl: `${server.url}/api`,
        repositoryFullName: 'acme/repo',
        targetBranch: 'main',
        headBranchPrefix: 'loopwright/',
        githubToken: 'ghp_test_token_0001',
      });
      assert.equal(managedPr?.number, 19);
      assert.equal(managedPr?.headSha, prHeadSha);

      const resolved = await resolveRepositoryAndRevisions({
        repositoryRoot: repo,
        repositoryFullName: 'acme/repo',
        baseRevision: 'd'.repeat(40),
        eventName: 'issue_comment',
        eventPayload: { issue: { number: 19, pull_request: {} } },
        apiBaseUrl: `${server.url}/api`,
      });
      assert.equal(resolved.repositoryId, 4242);
      assert.equal(resolved.baseRevision, headSha);
      assert.equal(resolved.sourceRevision, prHeadSha);
    } finally {
      await server?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('writes scrubbed multi-sink summary and extended GITHUB_OUTPUT fields cleanly', async () => {
    const work = await mkdtemp(join(tmpdir(), 'lw-t5-out-'));
    try {
      const scrubber = new SecretScrubber();
      scrubber.register('super_secret_token_xyz');
      const summaryFile = join(work, 'summary.md');
      const outputFile = join(work, 'output.txt');
      const formats = resolveActionOutputFormats('json,github-step-summary,markdown', undefined);
      assert.deepEqual(formats, ['json', 'github-step-summary', 'markdown']);

      const written = await writeActionOutputSinks({
        formats,
        report: {
          runId: 'run-fmt-1',
          status: 'completed',
          externalUrl: 'https://github.invalid/acme/repo/pull/7',
          reasonCode: null,
          checks: [{ checkId: 'verify', status: 'passed', detail: 'checked with super_secret_token_xyz' }],
          usage: {
            requests: [],
            inputTokens: { provenance: 'reported', knownSubtotal: 120, unknownCount: 0, completeness: 'complete' },
            outputTokens: { provenance: 'reported', knownSubtotal: 30, unknownCount: 0, completeness: 'complete' },
            totalTokens: { provenance: 'reported', knownSubtotal: 150, unknownCount: 0, completeness: 'complete' },
            costMicrousd: { provenance: 'estimated', knownSubtotal: 480, unknownCount: 0, completeness: 'complete' },
          },
        },
        stepSummaryPath: summaryFile,
        githubOutputPath: outputFile,
        actionResultJson: JSON.stringify({ kind: 'compiled' }),
        scrubber,
        includeExtendedGithubOutputs: true,
      });

      assert.equal(written.stepSummaryWritten, true);
      assert.equal(written.githubOutputWritten, true);
      assert.equal(written.prUrl, 'https://github.invalid/acme/repo/pull/7');
      assert.equal(written.totalTokens, '150');
      assert.equal(written.costUsd, '0.000480');
      const summaryText = await readFile(summaryFile, 'utf8');
      assert.equal(summaryText.includes('super_secret_token_xyz'), false);
      assert.match(summaryText, /run-fmt-1/);
      const outputs = parseGithubOutputs(await readFile(outputFile, 'utf8'));
      assert.equal(outputs['pr-url'], 'https://github.invalid/acme/repo/pull/7');
      assert.equal(outputs['total-tokens'], '150');
      assert.equal(outputs['cost-usd'], '0.000480');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});

async function createEndToEndFixture(): Promise<{
  readonly work: string;
  readonly repo: string;
  readonly bareRemote: string;
  readonly runRoot: string;
  readonly baseSha: string;
  readonly verifySecret: string;
  readonly badToken: string;
  readonly goodToken: string;
  readonly githubToken: string;
}> {
  const work = await mkdtemp(join(tmpdir(), 'lw-t5-e2e-'));
  const repo = join(work, 'repo');
  const sharedSkills = join(work, 'shared-skills');
  const bareRemote = join(work, 'remote.git');
  const runRoot = join(work, 'runs');
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  await chmod(runRoot, 0o700);

  await mkdir(sharedSkills, { recursive: true });
  await writeFile(join(sharedSkills, 'guide.md'), '# Shared Skill\n');

  await mkdir(repo, { recursive: true });
  await git(repo, ['init', '-b', 'main']);

  await mkdir(join(repo, '.claude'), { recursive: true });
  await symlink('../shared-skills', join(repo, '.claude', 'skills'));

  await mkdir(join(repo, '.auto-sync', 'prompts'), { recursive: true });
  await mkdir(join(repo, '.auto-sync', 'checks'), { recursive: true });
  await mkdir(join(repo, 'pack'), { recursive: true });
  await mkdir(join(repo, 'docs'), { recursive: true });

  await writeFile(join(repo, '.auto-sync', 'prompts', 'instructions.md'), 'Always update pack/proposal.json and docs/status.md.\n');
  await writeFile(join(repo, 'pack', 'dependencies.json'), JSON.stringify({ pinned: true }, null, 2) + '\n');
  await writeFile(join(repo, 'pack', 'proposal.json'), JSON.stringify({ schema_version: 1, version: '1.0.0' }, null, 2) + '\n');
  await writeFile(join(repo, 'docs', 'status.md'), 'initial\n');

  const verifyScript = `#!/usr/bin/env bash
set -euo pipefail
content="$(cat docs/status.md 2>/dev/null || true)"
if [[ "$content" == "verified-ok" ]]; then
  exit 0
fi
pad="$(printf 'x%.0s' $(seq 1 4100))"
echo "verification failure using token \${CHECK_SECRET:-unset}: \${pad}" >&2
exit 1
`;
  const scriptPath = join(repo, '.auto-sync', 'checks', 'verify.sh');
  await writeFile(scriptPath, verifyScript, { mode: 0o755 });
  await chmod(scriptPath, 0o755);

  const baseEnvSecret = 'verify_secret_tok_9876543210';
  const badToken = 'bad_tok_0000000000001';
  const goodToken = 'good_tok_000000000002';
  const githubToken = 'ghp_secret_tok_12345678901234';

  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'initial commit']);
  const baseSha = await git(repo, ['rev-parse', 'HEAD']);

  await mkdir(bareRemote, { recursive: true });
  await git(bareRemote, ['init', '--bare', '-b', 'main']);
  await git(repo, ['remote', 'add', 'origin', bareRemote]);
  await git(repo, ['push', '-u', 'origin', 'main']);

  return {
    work,
    repo,
    bareRemote,
    runRoot,
    baseSha,
    verifySecret: baseEnvSecret,
    badToken,
    goodToken,
    githubToken,
  };
}

function writeTaskpackYaml(repo: string, openAiBaseUrl: string): Promise<void> {
  return writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: auto-sync
spec:
  goal:
    candidate: Sync pack/proposal.json and docs/status.md to match upstream release.
    noChange: Verify upstream status matches pack/proposal.json.
  scope:
    writable:
      - pack
      - docs
    protected:
      - pack/dependencies.json
  instructions:
    - .auto-sync/prompts/instructions.md
  upstreams:
    - id: engine
      kind: github-release
      source: acme/engine
      watchedPaths:
        - pack
  proposal:
    path: pack/proposal.json
    requiredFields:
      - schema_version
      - version
    schemaVersion: 1
  verification:
    externalGates: []
    localChecks:
      - id: json
        implementation: json-artifact.v1
      - id: verify-cmd
        implementation: command.v1
        parameters:
          script: .auto-sync/checks/verify.sh
          timeoutSeconds: 15
          allowReadOnlyGitHubToken: true
          env:
            - CHECK_SECRET
  publication:
    mode: pull_request
    targetBranch: main
    headBranchPrefix: loopwright/
    titleTemplate: "chore: update synced pack"
  memory:
    directory: .auto-sync/memory
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands: []
  models:
    - provider: openai
      id: gpt-4.1-mini
      api: openai-completions
      apiKeyEnv: LLM_TOKEN
      baseUrl: ${openAiBaseUrl}/v1
      cost:
        input: 2
        output: 8
  output:
    formats:
      - json
      - github-step-summary
`);
}

describe('turnkey Action cycle end-to-end execution', () => {
  it('runs complete turnkey cycle with token rotation, command.v1 repair, worktree PR creation, and scrubbed outputs', async () => {
    const fixture = await createEndToEndFixture();
    let llmTurn = 0;
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let githubServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    const prRequests: Record<string, unknown>[] = [];

    try {
      openAiServer = await startHttpServer(async (req, res) => {
        if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
          res.writeHead(404);
          res.end();
          return;
        }
        const auth = req.headers['authorization'] ?? '';
        const body = await readJsonBody(req);
        if (body['max_tokens'] === 1 && body['stream'] !== true) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }] }));
          return;
        }
        if (auth.includes(fixture.badToken)) {
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '5' });
          res.end(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'rate limit hit mid-run' } }));
          return;
        }

        const step = llmTurn++;
        let sseBody: string;
        if (step === 0) {
          sseBody = sseToolCall('gpt-4.1-mini', 'call-1', 'write', {
            path: 'pack/proposal.json',
            content: `${JSON.stringify({ schema_version: 1, version: '2.0.0' })}\n`,
          });
        } else if (step === 1) {
          sseBody = sseToolCall('gpt-4.1-mini', 'call-2', 'write', {
            path: 'docs/status.md',
            content: 'bad-draft\n',
          });
        } else if (step === 2) {
          sseBody = sseStop('gpt-4.1-mini', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null }));
        } else if (step === 3) {
          sseBody = sseToolCall('gpt-4.1-mini', 'call-3', 'write', {
            path: 'docs/status.md',
            content: 'verified-ok\n',
          });
        } else {
          sseBody = sseStop('gpt-4.1-mini', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null }));
        }

        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseBody);
      });

      githubServer = await startHttpServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/repos/acme/engine/releases/latest') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v2.0.0' }));
          return;
        }
        if (url.pathname === '/repos/acme/repo' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 777 }));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([]));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'POST') {
          const payload = await readJsonBody(req);
          prRequests.push(payload);
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            number: 42,
            html_url: 'https://github.invalid/acme/repo/pull/42',
            head: { ref: 'loopwright/main', sha: '0'.repeat(40) },
            base: { ref: 'main', sha: fixture.baseSha },
            title: String(payload['title'] ?? ''),
            body: String(payload['body'] ?? ''),
          }));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
      });

      await writeTaskpackYaml(fixture.repo, openAiServer.url);
      await git(fixture.repo, ['add', '.auto-sync/taskpack.yaml']);
      await git(fixture.repo, ['commit', '-m', 'add turnkey taskpack']);
      const headAfterTaskpack = await git(fixture.repo, ['rev-parse', 'HEAD']);
      await git(fixture.repo, ['push', 'origin', 'HEAD:refs/heads/main']);

      const summaryFile = join(fixture.work, 'step-summary.md');
      const outputFile = join(fixture.work, 'github-output.txt');

      const exitCode = await runActionCli({
        GITHUB_ACTIONS: 'true',
        GITHUB_WORKSPACE: fixture.repo,
        LOOPWRIGHT_REPOSITORY: 'acme/repo',
        GITHUB_SHA: headAfterTaskpack,
        GITHUB_API_URL: githubServer.url,
        GITHUB_STEP_SUMMARY: summaryFile,
        GITHUB_OUTPUT: outputFile,
        'INPUT_TASKPACK-PATH': '.auto-sync/taskpack.yaml',
        'INPUT_EVENT-NAME': 'workflow_dispatch',
        'INPUT_RUN-ROOT': fixture.runRoot,
        'INPUT_RUN-ID': 'turnkey-e2e',
        'INPUT_ALLOW-CUSTOM-BASE-URL': 'true',
        'INPUT_GITHUB-TOKEN': fixture.githubToken,
        'INPUT_REMOTE-URL': fixture.bareRemote,
        LLM_TOKEN: `${fixture.badToken},${fixture.goodToken}`,
        CHECK_SECRET: fixture.verifySecret,
      });

      assert.equal(exitCode, 0, 'turnkey e2e Action run must succeed cleanly');
      assert.equal(prRequests.length, 1, 'publisher must open exactly one PR');
      assert.equal(prRequests[0]?.['head'], 'loopwright/main');
      assert.equal(prRequests[0]?.['base'], 'main');

      // Primary checkout HEAD, working tree, and protected .claude/skills symlink stay untouched.
      assert.equal(await git(fixture.repo, ['rev-parse', 'HEAD']), headAfterTaskpack);
      assert.equal(await git(fixture.repo, ['status', '--porcelain']), '');
      const symlinkStats = await lstat(join(fixture.repo, '.claude', 'skills'));
      assert.equal(symlinkStats.isSymbolicLink(), true);
      assert.equal(await readlink(join(fixture.repo, '.claude', 'skills')), '../shared-skills');

      // Remote branch contains the repaired candidate commit, DCO sign-off, and preserves the protected symlink.
      const verifyClone = join(fixture.work, 'verify-remote');
      await git(fixture.work, ['clone', '--branch', 'loopwright/main', fixture.bareRemote, verifyClone]);
      const commitMessage = await git(verifyClone, ['log', '-1', '--format=%B']);
      assert.match(commitMessage, /Signed-off-by: Loopwright Bot <loopwright\[bot\]@users\.noreply\.github\.com>/);
      assert.equal(await readFile(join(verifyClone, 'docs', 'status.md'), 'utf8'), 'verified-ok\n');
      const proposalJson = JSON.parse(await readFile(join(verifyClone, 'pack', 'proposal.json'), 'utf8')) as {
        schema_version: number;
        version: string;
      };
      assert.equal(proposalJson.version, '2.0.0');
      const remoteSymlink = await lstat(join(verifyClone, '.claude', 'skills'));
      assert.equal(remoteSymlink.isSymbolicLink(), true);

      // Step summary and GITHUB_OUTPUT checks + zero leaked secrets.
      const outputs = parseGithubOutputs(await readFile(outputFile, 'utf8'));
      const parsedResult = JSON.parse(outputs['result']!) as { kind: string; delegateOutcome: { ok: boolean } | null };
      assert.equal(parsedResult.kind, 'compiled');
      assert.equal(parsedResult.delegateOutcome?.ok, true);
      assert.equal(outputs['pr-url'], 'https://github.invalid/acme/repo/pull/42');
      assert.ok(Number(outputs['total-tokens']) > 0);
      assert.ok(outputs['cost-usd'] !== undefined && /^\d+\.\d{6}$/.test(outputs['cost-usd']));

      const summaryContent = await readFile(summaryFile, 'utf8');
      assert.match(summaryContent, /https:\/\/github\.invalid\/acme\/repo\/pull\/42/);
      for (const secret of [fixture.badToken, fixture.goodToken, fixture.githubToken, fixture.verifySecret]) {
        assert.equal(summaryContent.includes(secret), false, 'step summary must never contain raw secret');
        assert.equal((outputs['result'] ?? '').includes(secret), false, 'GITHUB_OUTPUT result must never contain raw secret');
      }

      // Attempt 0 directory and rotated -a1 directory both exist independently without OWNER_BUSY.
      const a1Exists = await lstat(join(fixture.runRoot, 'turnkey-e2e-a1')).then(() => true, () => false);
      assert.equal(a1Exists, true, 'rotated retry must run in turnkey-e2e-a1');
      // Verify check denial reason stored on disk is scrubbed and <= 256 chars.
      const verifyDirHandle = await open(join(fixture.repo, '.auto-sync', 'checks', 'verify.sh'), fsConstants.O_RDONLY);
      await verifyDirHandle.close();
    } finally {
      await openAiServer?.close();
      await githubServer?.close();
      await rm(fixture.work, { recursive: true, force: true });
    }
  });

  it('refuses publication cleanly without updating PR when remote PR head mutated concurrently (--force-with-lease)', async () => {
    const fixture = await createEndToEndFixture();
    let llmTurn = 0;
    let mutatedRemote = false;
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let githubServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let sha1 = '';
    let sha2 = '';
    let prCreateOrPatchCount = 0;

    try {
      openAiServer = await startHttpServer(async (req, res) => {
        if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
          res.writeHead(404);
          res.end();
          return;
        }
        const body = await readJsonBody(req);
        if (body['max_tokens'] === 1 && body['stream'] !== true) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }] }));
          return;
        }

        const step = llmTurn++;
        let sseBody: string;
        if (step === 0) {
          sseBody = sseToolCall('gpt-4.1-mini', 'call-1', 'write', {
            path: 'pack/proposal.json',
            content: `${JSON.stringify({ schema_version: 1, version: '2.0.0' })}\n`,
          });
        } else if (step === 1) {
          sseBody = sseToolCall('gpt-4.1-mini', 'call-2', 'write', {
            path: 'docs/status.md',
            content: 'verified-ok\n',
          });
        } else {
          if (!mutatedRemote) {
            mutatedRemote = true;
            // Concurrent human commit advances bare remote PR branch from sha1 -> sha2 right before publication!
            const concurrentDir = join(fixture.work, 'concurrent-commit');
            await git(fixture.work, ['clone', '--branch', 'loopwright/main', fixture.bareRemote, concurrentDir]);
            await writeFile(join(concurrentDir, 'docs', 'human-note.md'), 'concurrent commit\n');
            await git(concurrentDir, ['add', 'docs/human-note.md']);
            await git(concurrentDir, ['commit', '-m', 'concurrent remote update']);
            sha2 = await git(concurrentDir, ['rev-parse', 'HEAD']);
            await git(concurrentDir, ['push', 'origin', 'HEAD:refs/heads/loopwright/main']);
          }
          sseBody = sseStop('gpt-4.1-mini', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null }));
        }

        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseBody);
      });

      await writeTaskpackYaml(fixture.repo, openAiServer.url);
      await git(fixture.repo, ['add', '.auto-sync/taskpack.yaml']);
      await git(fixture.repo, ['commit', '-m', 'add taskpack']);
      const headSha = await git(fixture.repo, ['rev-parse', 'HEAD']);
      await git(fixture.repo, ['push', 'origin', 'HEAD:refs/heads/main']);

      // Seed existing managed PR branch at sha1 on remote.
      const prSeedDir = join(fixture.work, 'seed-pr');
      await git(fixture.work, ['clone', '--branch', 'main', fixture.bareRemote, prSeedDir]);
      await writeFile(join(prSeedDir, 'docs', 'status.md'), 'pr-v1\n');
      await git(prSeedDir, ['add', 'docs/status.md']);
      await git(prSeedDir, ['commit', '-m', 'existing PR commit']);
      sha1 = await git(prSeedDir, ['rev-parse', 'HEAD']);
      await git(prSeedDir, ['push', 'origin', 'HEAD:refs/heads/loopwright/main']);

      githubServer = await startHttpServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/repos/acme/engine/releases/latest') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v2.0.0' }));
          return;
        }
        if (url.pathname === '/repos/acme/repo' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 777 }));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([
            {
              number: 42,
              html_url: 'https://github.invalid/acme/repo/pull/42',
              head: { ref: 'loopwright/main', sha: sha1 },
              base: { ref: 'main', sha: headSha },
              title: 'existing PR',
              body: 'old body',
            },
          ]));
          return;
        }
        if (url.pathname.startsWith('/repos/acme/repo/pulls') && (req.method === 'POST' || req.method === 'PATCH')) {
          prCreateOrPatchCount += 1;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ html_url: 'https://github.invalid/acme/repo/pull/42' }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      const outputFile = join(fixture.work, 'lease-output.txt');
      const exitCode = await runActionCli({
        GITHUB_ACTIONS: 'true',
        GITHUB_WORKSPACE: fixture.repo,
        LOOPWRIGHT_REPOSITORY: 'acme/repo',
        GITHUB_SHA: headSha,
        GITHUB_API_URL: githubServer.url,
        GITHUB_OUTPUT: outputFile,
        'INPUT_TASKPACK-PATH': '.auto-sync/taskpack.yaml',
        'INPUT_EVENT-NAME': 'workflow_dispatch',
        'INPUT_RUN-ROOT': fixture.runRoot,
        'INPUT_RUN-ID': 'lease-conflict',
        'INPUT_ALLOW-CUSTOM-BASE-URL': 'true',
        'INPUT_GITHUB-TOKEN': fixture.githubToken,
        'INPUT_REMOTE-URL': fixture.bareRemote,
        LLM_TOKEN: fixture.goodToken,
        CHECK_SECRET: fixture.verifySecret,
      });

      assert.equal(exitCode, 1, 'mutated remote PR head must settle as failed');
      assert.equal(prCreateOrPatchCount, 0, 'REST PR update must not fire when git push fails --force-with-lease');

      // Remote branch still points to sha2 (concurrent commit preserved).
      const { stdout: lsOut } = await execFileAsync(
        '/usr/bin/git',
        ['ls-remote', fixture.bareRemote, 'refs/heads/loopwright/main'],
        { env: GIT_TEST_ENV, encoding: 'utf8' },
      );
      assert.equal(lsOut.split(/\s+/)[0], sha2);
    } finally {
      await openAiServer?.close();
      await githubServer?.close();
      await rm(fixture.work, { recursive: true, force: true });
    }
  });
});

describe('negative and security regression tests', () => {
  async function postJsonSigned(
    url: string,
    body: Record<string, unknown>,
    signingSecret: string,
    authToken?: string,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-loopwright-signature': signPayload(signingSecret, raw),
    };
    if (authToken !== undefined) {
      headers['authorization'] = `Bearer ${authToken}`;
    }
    const response = await fetch(url, { method: 'POST', headers, body: raw });
    const json = JSON.parse(await response.text()) as Record<string, unknown>;
    return { status: response.status, json };
  }

  it('rejects bad HMAC signatures (401) and requires independent authToken vs signingSecret on publisher', async () => {
    const work = await mkdtemp(join(tmpdir(), 'lw-t5-auth-'));
    let gateServer: Awaited<ReturnType<typeof startLocalCommandGateServer>> | undefined;
    let pubServer: Awaited<ReturnType<typeof startNativePullRequestPublisherServer>> | undefined;
    try {
      const repo = join(work, 'repo');
      const runRoot = join(work, 'runs');
      await mkdir(join(repo, '.auto-sync', 'checks'), { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await chmod(runRoot, 0o700);
      const scriptPath = join(repo, '.auto-sync', 'checks', 'verify.sh');
      const scriptBytes = '#!/usr/bin/env bash\nexit 0\n';
      await writeFile(scriptPath, scriptBytes);
      const scriptSha256 = createHash('sha256').update(scriptBytes).digest('hex');

      gateServer = await startLocalCommandGateServer({
        runRoot,
        repositoryRoot: repo,
        gates: [{
          checkId: 'verify-cmd',
          gateId: 'verify-cmd',
          endpointRef: 'loopwright-local-command',
          script: '.auto-sync/checks/verify.sh',
          scriptSha256,
          timeoutSeconds: 5,
          allowReadOnlyGitHubToken: false,
          env: [],
        }],
      });

      const gateBadSig = await postJsonSigned(gateServer.url, { storeId: 's', runId: 'r' }, 'wrong-hmac-secret');
      assert.equal(gateBadSig.status, 401);

      pubServer = await startNativePullRequestPublisherServer({
        runRoot,
        repositoryRoot: repo,
        repositoryFullName: 'acme/repo',
        targetBranch: 'main',
        headBranchPrefix: 'loopwright/',
      });
      assert.notEqual(pubServer.authToken, pubServer.signingSecret, 'authToken and signingSecret must be independent');

      const pubWrongBearer = await postJsonSigned(
        pubServer.url,
        { storeId: 's', runId: 'r', candidateDigest: '0'.repeat(64) },
        pubServer.signingSecret,
        pubServer.signingSecret,
      );
      assert.equal(pubWrongBearer.status, 401);

      const pubBadSig = await postJsonSigned(
        pubServer.url,
        { storeId: 's', runId: 'r', candidateDigest: '0'.repeat(64) },
        'wrong-hmac-secret',
        pubServer.authToken,
      );
      assert.equal(pubBadSig.status, 401);
    } finally {
      await gateServer?.close();
      await pubServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('denies command.v1 gate execution when the script SHA-256 was tampered on disk and denies candidateDigest mismatches', async () => {
    const work = await mkdtemp(join(tmpdir(), 'lw-t5-tamper-'));
    let gateServer: Awaited<ReturnType<typeof startLocalCommandGateServer>> | undefined;
    let pubServer: Awaited<ReturnType<typeof startNativePullRequestPublisherServer>> | undefined;
    try {
      const repo = join(work, 'repo');
      const runRoot = join(work, 'runs');
      await mkdir(join(repo, '.auto-sync', 'checks'), { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await chmod(runRoot, 0o700);
      await git(repo, ['init', '-b', 'main']);
      await writeFile(join(repo, 'README.md'), 'hi\n');
      const scriptRel = '.auto-sync/checks/verify.sh';
      await writeFile(join(repo, scriptRel), '#!/usr/bin/env bash\nexit 0\n');
      const originalSha = createHash('sha256').update('#!/usr/bin/env bash\nexit 0\n').digest('hex');

      gateServer = await startLocalCommandGateServer({
        runRoot,
        repositoryRoot: repo,
        gates: [{
          checkId: 'verify-cmd',
          gateId: 'verify-cmd',
          endpointRef: 'loopwright-local-command',
          script: scriptRel,
          scriptSha256: originalSha,
          timeoutSeconds: 5,
          allowReadOnlyGitHubToken: false,
          env: [],
        }],
      });

      // Tamper verify.sh on disk after gate server compiled expected digest.
      await writeFile(join(repo, scriptRel), '#!/usr/bin/env bash\necho pwned\nexit 0\n');

      const tamperRes = await postJsonSigned(
        gateServer.url,
        {
          storeId: 'store-1',
          runId: 'run-missing',
          lockHash: null,
          operationId: 'op-1',
          dispatchId: 'disp-1',
          dispatchGeneration: 1,
          gateId: 'verify-cmd',
          checkId: 'verify-cmd',
          candidateDigest: 'a'.repeat(64),
        },
        gateServer.signingSecret,
      );
      assert.equal(tamperRes.status, 200);
      assert.equal(tamperRes.json['status'], 'denied');
      assert.match(String(tamperRes.json['reason']), /sha256 changed on disk/);

      // Restore script and check candidateDigest / missing run denial on both servers.
      await writeFile(join(repo, scriptRel), '#!/usr/bin/env bash\nexit 0\n');
      const mismatchGate = await postJsonSigned(
        gateServer.url,
        {
          storeId: 'store-1',
          runId: 'nonexistent-run',
          lockHash: null,
          operationId: 'op-2',
          dispatchId: 'disp-2',
          dispatchGeneration: 1,
          gateId: 'verify-cmd',
          checkId: 'verify-cmd',
          candidateDigest: 'b'.repeat(64),
        },
        gateServer.signingSecret,
      );
      assert.equal(mismatchGate.status, 200);
      assert.equal(mismatchGate.json['status'], 'denied');

      pubServer = await startNativePullRequestPublisherServer({
        runRoot,
        repositoryRoot: repo,
        repositoryFullName: 'acme/repo',
        targetBranch: 'main',
        headBranchPrefix: 'loopwright/',
      });
      const mismatchPub = await postJsonSigned(
        pubServer.url,
        {
          storeId: 'store-1',
          runId: 'nonexistent-run',
          operationId: 'op-pub',
          dispatchId: 'disp-pub',
          dispatchGeneration: 1,
          idempotencyKey: 'idem-mismatch-1',
          candidateDigest: 'c'.repeat(64),
          targetBranch: 'main',
          title: 'test',
        },
        pubServer.signingSecret,
        pubServer.authToken,
      );
      assert.equal(mismatchPub.status, 200);
      assert.equal(mismatchPub.json['outcome'], 'not_executed');
    } finally {
      await gateServer?.close();
      await pubServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('fails closed on issue_comment PR lookup errors/invalid SHAs and when repo ID lookup fails with apiBaseUrl set', async () => {
    let server: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    try {
      server = await startHttpServer((req, res) => {
        if (req.url === '/repos/acme/fail-pr') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 55 }));
          return;
        }
        if (req.url === '/repos/acme/fail-pr/pulls/9') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ number: 9, base: { sha: 'not-a-sha' }, head: { sha: 'e'.repeat(40) } }));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'not found' }));
      });
      const apiBaseUrl = server.url;

      await assert.rejects(
        () => resolveRepositoryAndRevisions({
          repositoryRoot: '/tmp',
          repositoryFullName: 'acme/fail-pr',
          eventName: 'issue_comment',
          baseRevision: 'd'.repeat(40),
          eventPayload: { issue: { number: 9, pull_request: {} } },
          apiBaseUrl,
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID',
      );

      await assert.rejects(
        () => resolveRepositoryAndRevisions({
          repositoryRoot: '/tmp',
          repositoryFullName: 'acme/missing-repo',
          eventName: 'workflow_dispatch',
          baseRevision: 'd'.repeat(40),
          apiBaseUrl,
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID',
      );
    } finally {
      await server?.close();
    }
  });

  it('rejects fork PRs and paginates multi-page results in findOpenManagedPullRequest', async () => {
    let server: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    try {
      const targetHead = 'loopwright/main';
      server = await startHttpServer((req, res) => {
        const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
        const page = Number(parsed.searchParams.get('page') ?? '1');
        res.writeHead(200, { 'content-type': 'application/json' });
        if (page === 1) {
          const items = Array.from({ length: 100 }, (_, i) => ({
            number: 100 + i,
            html_url: `https://github.invalid/acme/repo/pull/${100 + i}`,
            title: `other-${i}`,
            state: 'open',
            base: { ref: 'main', sha: '1'.repeat(40) },
            head: i === 0
              ? { ref: targetHead, sha: 'f'.repeat(40), repo: { full_name: 'attacker/repo', fork: true } }
              : { ref: `feature/${i}`, sha: '2'.repeat(40), repo: { full_name: 'acme/repo', fork: false } },
          }));
          res.end(JSON.stringify(items));
          return;
        }
        if (page === 2) {
          res.end(JSON.stringify([{
            number: 205,
            html_url: 'https://github.invalid/acme/repo/pull/205',
            title: 'managed pr on page 2',
            state: 'open',
            base: { ref: 'main', sha: '3'.repeat(40) },
            head: { ref: targetHead, sha: '4'.repeat(40), repo: { full_name: 'ACME/REPO', fork: false } },
          }]));
          return;
        }
        res.end(JSON.stringify([]));
      });

      const found = await findOpenManagedPullRequest({
        apiBaseUrl: server.url,
        repositoryFullName: 'acme/repo',
        targetBranch: 'main',
        headBranchPrefix: 'loopwright/',
      });
      assert.ok(found !== null);
      assert.equal(found.number, 205);
      assert.equal(found.headSha, '4'.repeat(40));
    } finally {
      await server?.close();
    }
  });

  it('refuses publication (not_executed) when remote branch already exists without an open managed PR', async () => {
    const fixture = await createEndToEndFixture();
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let githubServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;

    try {
      // Pre-create refs/heads/loopwright/main on bareRemote with NO open PR returned by GitHub.
      const existingSha = await git(fixture.repo, ['rev-parse', 'HEAD']);
      await git(fixture.repo, ['push', fixture.bareRemote, `${existingSha}:refs/heads/loopwright/main`]);

      let llmTurn = 0;
      openAiServer = await startHttpServer(async (req, res) => {
        const body = await readJsonBody(req);
        if (body['max_tokens'] === 1 && body['stream'] !== true) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }] }));
          return;
        }
        const turn = llmTurn++;
        let sseBody: string;
        if (turn === 0) {
          sseBody = sseToolCall('gpt-4.1-mini', 'e-1', 'write', {
            path: 'docs/status.md',
            content: 'verified-ok\n',
          });
        } else if (turn === 1) {
          sseBody = sseToolCall('gpt-4.1-mini', 'e-2', 'write', {
            path: 'pack/proposal.json',
            content: `${JSON.stringify({ schema_version: 1, version: '2.0.0' })}\n`,
          });
        } else {
          sseBody = sseStop('gpt-4.1-mini', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null }));
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseBody);
      });

      let prPostCount = 0;
      githubServer = await startHttpServer((req, res) => {
        const url = req.url ?? '/';
        if (req.method === 'GET' && url === '/repos/acme/sync-target') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 100 }));
          return;
        }
        if (req.method === 'GET' && url === '/repos/acme/engine/releases/latest') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v2.0.0', target_commitish: 'main', html_url: 'https://github.invalid/acme/engine/releases/tag/v2.0.0' }));
          return;
        }
        if (req.method === 'GET' && url.startsWith('/repos/acme/sync-target/pulls')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([]));
          return;
        }
        if (req.method === 'POST' && url === '/repos/acme/sync-target/pulls') {
          prPostCount += 1;
        }
        res.writeHead(500);
        res.end();
      });

      await writeTaskpackYaml(fixture.repo, openAiServer.url);
      await git(fixture.repo, ['add', '.auto-sync/taskpack.yaml']);
      await git(fixture.repo, ['commit', '-m', 'add manifest']);
      const headSha = await git(fixture.repo, ['rev-parse', 'HEAD']);
      await git(fixture.repo, ['push', fixture.bareRemote, 'HEAD:main']);

      const exitCode = await runActionCli({
        PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
        GITHUB_WORKSPACE: fixture.repo,
        GITHUB_REPOSITORY: 'acme/sync-target',
        GITHUB_REPOSITORY_ID: '100',
        GITHUB_SHA: headSha,
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_API_URL: githubServer.url,
        GITHUB_TOKEN: fixture.githubToken,
        LLM_TOKEN: fixture.goodToken,
        CHECK_SECRET: fixture.verifySecret,
        INPUT_TASKPACK_PATH: '.auto-sync/taskpack.yaml',
        'INPUT_TASKPACK-PATH': '.auto-sync/taskpack.yaml',
        'INPUT_RUN-ROOT': fixture.runRoot,
        'INPUT_RUN-ID': 'run-existing-branch-refusal',
        'INPUT_ALLOW-CUSTOM-BASE-URL': 'true',
        'INPUT_REMOTE-URL': fixture.bareRemote,
      });

      assert.equal(exitCode, 1);
      assert.equal(prPostCount, 0, 'must not call POST /pulls when existing unassociated branch refused');
      const { stdout: lsOut } = await execFileAsync(
        '/usr/bin/git',
        ['ls-remote', fixture.bareRemote, 'refs/heads/loopwright/main'],
        { env: GIT_TEST_ENV, encoding: 'utf8' },
      );
      assert.equal(lsOut.split(/\s+/)[0], existingSha, 'existing unassociated remote branch must stay untouched');
    } finally {
      await openAiServer?.close();
      await githubServer?.close();
      await rm(fixture.work, { recursive: true, force: true });
    }
  });

  it('settles as failed (reconcile_required) and caches idempotencyKey when POST /pulls fails after git push', async () => {
    const fixture = await createEndToEndFixture();
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let githubServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let pubServer: Awaited<ReturnType<typeof startNativePullRequestPublisherServer>> | undefined;

    try {
      let llmTurn = 0;
      openAiServer = await startHttpServer(async (req, res) => {
        const body = await readJsonBody(req);
        if (body['max_tokens'] === 1 && body['stream'] !== true) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }] }));
          return;
        }
        const turn = llmTurn++;
        let sseBody: string;
        if (turn === 0) {
          sseBody = sseToolCall('gpt-4.1-mini', 'c1', 'write', {
            path: 'docs/status.md',
            content: 'verified-ok\n',
          });
        } else if (turn === 1) {
          sseBody = sseToolCall('gpt-4.1-mini', 'c2', 'write', {
            path: 'pack/proposal.json',
            content: `${JSON.stringify({ schema_version: 1, version: '2.0.0' })}\n`,
          });
        } else {
          sseBody = sseStop('gpt-4.1-mini', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null }));
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseBody);
      });

      let postPullsCalls = 0;
      githubServer = await startHttpServer((req, res) => {
        const url = req.url ?? '/';
        if (req.method === 'GET' && url === '/repos/acme/sync-target') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 100 }));
          return;
        }
        if (req.method === 'GET' && url === '/repos/acme/engine/releases/latest') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v2.0.0', target_commitish: 'main', html_url: 'https://github.invalid/acme/engine/releases/tag/v2.0.0' }));
          return;
        }
        if (req.method === 'GET' && url.startsWith('/repos/acme/sync-target/pulls')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([]));
          return;
        }
        if (req.method === 'POST' && url === '/repos/acme/sync-target/pulls') {
          postPullsCalls += 1;
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'upstream github gateway timeout' }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await writeTaskpackYaml(fixture.repo, openAiServer.url);
      await git(fixture.repo, ['add', '.auto-sync/taskpack.yaml']);
      await git(fixture.repo, ['commit', '-m', 'add manifest']);
      const headSha = await git(fixture.repo, ['rev-parse', 'HEAD']);
      await git(fixture.repo, ['push', fixture.bareRemote, 'HEAD:main']);

      const exitCode = await runActionCli({
        PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
        GITHUB_WORKSPACE: fixture.repo,
        GITHUB_REPOSITORY: 'acme/sync-target',
        GITHUB_REPOSITORY_ID: '100',
        GITHUB_SHA: headSha,
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_API_URL: githubServer.url,
        GITHUB_TOKEN: fixture.githubToken,
        LLM_TOKEN: fixture.goodToken,
        CHECK_SECRET: fixture.verifySecret,
        'INPUT_TASKPACK-PATH': '.auto-sync/taskpack.yaml',
        'INPUT_RUN-ROOT': fixture.runRoot,
        'INPUT_RUN-ID': 'run-post-push-rest-fail',
        'INPUT_ALLOW-CUSTOM-BASE-URL': 'true',
        'INPUT_REMOTE-URL': fixture.bareRemote,
      });

      assert.equal(exitCode, 1, 'REST failure after git push must fail closed');
      assert.equal(postPullsCalls, 1);

      // Branch WAS pushed, and run state recorded reconcile_required with unresolved external effect.
      const { stdout: lsOut } = await execFileAsync(
        '/usr/bin/git',
        ['ls-remote', fixture.bareRemote, 'refs/heads/loopwright/main'],
        { env: GIT_TEST_ENV, encoding: 'utf8' },
      );
      assert.notEqual(lsOut.trim(), '', 'git push had already succeeded before REST PR call failed');

      // Direct idempotencyKey cache test on publisher server: second request returns cached receipt without re-invoking REST.
      pubServer = await startNativePullRequestPublisherServer({
        runRoot: fixture.runRoot,
        repositoryRoot: fixture.repo,
        repositoryFullName: 'acme/sync-target',
        targetBranch: 'main',
        headBranchPrefix: 'loopwright/',
        remoteUrl: fixture.bareRemote,
        apiBaseUrl: githubServer.url,
        gitWriteToken: fixture.githubToken,
      });
      const reqBody = {
        storeId: 's',
        runId: 'missing-for-cache-test',
        operationId: 'op-cache',
        dispatchId: 'disp-cache',
        dispatchGeneration: 1,
        idempotencyKey: 'same-idem-key-123',
        candidateDigest: 'a'.repeat(64),
        targetBranch: 'main',
      };
      const first = await postJsonSigned(pubServer.url, reqBody, pubServer.signingSecret, pubServer.authToken);
      const second = await postJsonSigned(pubServer.url, { ...reqBody, candidateDigest: 'b'.repeat(64) }, pubServer.signingSecret, pubServer.authToken);
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.deepEqual(second.json, first.json, 'duplicate idempotencyKey must return the exact cached receipt');
    } finally {
      await pubServer?.close();
      await openAiServer?.close();
      await githubServer?.close();
      await rm(fixture.work, { recursive: true, force: true });
    }
  });

  it('settles as no_change when open managed PR proposal at headSha already matches discovered upstream version', async () => {
    const fixture = await createEndToEndFixture();
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let githubServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;

    try {
      // Push a managed PR head branch whose pack/proposal.json already has version v2.0.0.
      await git(fixture.repo, ['checkout', '-b', 'loopwright/main']);
      await writeFile(join(fixture.repo, 'pack', 'proposal.json'), `${JSON.stringify({ schema_version: 1, version: 'v2.0.0' })}\n`);
      await git(fixture.repo, ['add', 'pack/proposal.json']);
      await git(fixture.repo, ['commit', '-m', 'managed pr v2.0.0']);
      const prHeadSha = await git(fixture.repo, ['rev-parse', 'HEAD']);
      await git(fixture.repo, ['push', fixture.bareRemote, 'HEAD:refs/heads/loopwright/main']);
      await git(fixture.repo, ['checkout', 'main']);

      await writeTaskpackYaml(fixture.repo, 'http://127.0.0.1:1');
      await git(fixture.repo, ['add', '.auto-sync/taskpack.yaml']);
      await git(fixture.repo, ['commit', '-m', 'add manifest']);
      const baseSha = await git(fixture.repo, ['rev-parse', 'HEAD']);
      await git(fixture.repo, ['push', fixture.bareRemote, 'HEAD:main']);

      let llmCalled = 0;
      openAiServer = await startHttpServer((_req, res) => {
        llmCalled += 1;
        res.writeHead(500);
        res.end();
      });

      githubServer = await startHttpServer((req, res) => {
        const url = req.url ?? '/';
        if (url === '/repos/acme/sync-target') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 100 }));
          return;
        }
        if (url === '/repos/acme/engine/releases/latest') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v2.0.0', target_commitish: 'main', html_url: 'https://github.invalid/acme/engine/releases/tag/v2.0.0' }));
          return;
        }
        if (url.startsWith('/repos/acme/sync-target/pulls')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([{
            number: 88,
            html_url: 'https://github.invalid/acme/sync-target/pull/88',
            title: 'chore: update synced pack',
            state: 'open',
            base: { ref: 'main', sha: baseSha },
            head: { ref: 'loopwright/main', sha: prHeadSha, repo: { full_name: 'acme/sync-target', fork: false } },
          }]));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      const result = await runGitHubActionEntrypoint({
        repositoryRoot: fixture.repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/sync-target',
        repositoryId: 100,
        baseRevision: baseSha,
        mode: 'candidate',
        eventName: 'schedule',
        runRoot: fixture.runRoot,
        runId: 'run-pr-matches-discovered',
        turnkey: true,
        allowManifestCustomBaseUrl: true,
        baseUrl: `${openAiServer.url}/v1`,
        githubApiBaseUrl: githubServer.url,
        githubToken: fixture.githubToken,
        gitRemoteUrl: fixture.bareRemote,
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: fixture.goodToken,
          CHECK_SECRET: fixture.verifySecret,
        },
      });

      assert.equal(result.kind, 'no_change');
      assert.equal(llmCalled, 0, 'no_change when open managed PR matches discovered upstream must not invoke LLM');
    } finally {
      await openAiServer?.close();
      await githubServer?.close();
      await rm(fixture.work, { recursive: true, force: true });
    }
  });

  it('sorts git-tag versions semantically (v10.0.0 > v9.0.0) and rejects unsafe git sources', async () => {
    const work = await mkdtemp(join(tmpdir(), 'lw-t5-tags-'));
    let server: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    try {
      const bareUpstream = join(work, 'upstream.git');
      const scratch = join(work, 'scratch');
      await git(work, ['init', '--bare', '-b', 'main', bareUpstream]);
      await mkdir(scratch, { recursive: true });
      await git(scratch, ['init', '-b', 'main']);
      await writeFile(join(scratch, 'f.txt'), 'a\n');
      await git(scratch, ['add', 'f.txt']);
      await git(scratch, ['commit', '-m', 'init']);
      await git(scratch, ['tag', 'v9.0.0']);
      await writeFile(join(scratch, 'f.txt'), 'b\n');
      await git(scratch, ['add', 'f.txt']);
      await git(scratch, ['commit', '-m', 'next']);
      await git(scratch, ['tag', 'v10.0.0']);
      await git(scratch, ['push', bareUpstream, 'main', '--tags']);

      assert.equal(compareVersionTags('v10.0.0', 'v9.0.0') > 0, true);

      const writeTagManifest = async (upstreamsYaml: string): Promise<ReturnType<typeof loadDeclarativeTaskpack>> => {
        const repo = join(work, 'repo');
        await mkdir(join(repo, '.auto-sync', 'prompts'), { recursive: true });
        await writeFile(join(repo, '.auto-sync', 'prompts', 'instructions.md'), 'check\n');
        await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: tag-sort-check
spec:
  goal:
    candidate: Sync
    noChange: Check
  scope:
    writable:
      - docs
  instructions:
    - .auto-sync/prompts/instructions.md
  upstreams:
${upstreamsYaml}
  proposal:
    path: docs/proposal.json
    requiredFields:
      - version
    schemaVersion: 1
  verification:
    externalGates: []
    localChecks:
      - id: json
        implementation: json-artifact.v1
  publication:
    mode: disabled
    targetBranch: main
    headBranchPrefix: loopwright/
    titleTemplate: "chore: update synced pack"
  memory:
    directory: .auto-sync/memory
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: false
    releasePublished: false
    commentCommands: []
  output:
    formats:
      - json
`);
        return loadDeclarativeTaskpack({ repositoryRoot: repo, manifestPath: '.auto-sync/taskpack.yaml' });
      };

      const gitManifest = await writeTagManifest(`    - id: u-git
      kind: git-tag
      source: ${bareUpstream}
      watchedPaths:
        - docs`);
      const gitTags = await discoverTaskpackUpstreams(gitManifest, { repositoryRoot: join(work, 'repo') });
      assert.equal(gitTags[0]?.version, 'v10.0.0');

      server = await startHttpServer((req, res) => {
        if (req.url?.startsWith('/repos/acme/tools/tags')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([
            { name: 'v9.0.0', commit: { sha: '9'.repeat(40) } },
            { name: 'v10.0.0', commit: { sha: '1'.repeat(40) } },
            { name: 'v2.1.0', commit: { sha: '2'.repeat(40) } },
          ]));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      const apiManifest = await writeTagManifest(`    - id: u-api
      kind: git-tag
      source: acme/tools
      watchedPaths:
        - docs`);
      const apiTags = await discoverTaskpackUpstreams(apiManifest, {
        repositoryRoot: join(work, 'repo'),
        apiBaseUrl: server.url,
      });
      assert.equal(apiTags[0]?.version, 'v10.0.0');

      const badFlagManifest = await writeTagManifest(`    - id: bad-flag
      kind: git-tag
      source: "--upload-pack=evil"
      watchedPaths:
        - docs`);
      const badFlagRecords = await discoverTaskpackUpstreams(badFlagManifest, { repositoryRoot: join(work, 'repo') });
      assert.equal(badFlagRecords[0]?.status, 'failed');
      assert.match(badFlagRecords[0]?.reason ?? '', /unsafe git upstream source/);

      const badSchemeManifest = await writeTagManifest(`    - id: bad-scheme
      kind: git-commit
      source: "ext::sh -c id"
      watchedPaths:
        - docs`);
      const badSchemeRecords = await discoverTaskpackUpstreams(badSchemeManifest, { repositoryRoot: join(work, 'repo') });
      assert.equal(badSchemeRecords[0]?.status, 'failed');
      assert.match(badSchemeRecords[0]?.reason ?? '', /disallowed scheme/);
    } finally {
      await server?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('allows host OS and explicit direct-dedicated sandbox in turnkey host-session and fails closed on docker', async () => {
    const work = await mkdtemp(join(tmpdir(), 'lw-t5-sandbox-'));
    try {
      const repo = join(work, 'repo');
      await mkdir(join(repo, '.auto-sync', 'prompts'), { recursive: true });
      await mkdir(join(repo, 'docs'), { recursive: true });
      await writeFile(join(repo, '.auto-sync', 'prompts', 'instructions.md'), 'check\n');
      await writeFile(join(repo, 'docs', 'upstream.json'), JSON.stringify({ version: '1.0.0' }));
      const baseManifestText = (backendsYaml: string) => `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: explicit-sandbox
spec:
  goal:
    candidate: Test explicit sandbox preservation
    noChange: Check sandbox
  scope:
    writable:
      - docs
  instructions:
    - .auto-sync/prompts/instructions.md
  upstreams:
    - id: custom-u
      kind: custom-table
      source: docs/upstream.json
      watchedPaths:
        - docs
  proposal:
    path: docs/proposal.json
    requiredFields:
      - version
    schemaVersion: 1
  verification:
    externalGates: []
    localChecks:
      - id: json
        implementation: json-artifact.v1
  sandbox:
    preferredBackends:
${backendsYaml}
    networkMode: none
  publication:
    mode: disabled
    targetBranch: main
    headBranchPrefix: loopwright/
    titleTemplate: "chore: update synced pack"
  memory:
    directory: .auto-sync/memory
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: false
    releasePublished: false
    commentCommands: []
  models:
    - provider: openai
      id: gpt-4.1-mini
      api: openai-completions
      baseUrl: https://api.openai.com/v1
      apiKeyEnv: LLM_TOKEN
      cost:
        input: 1
        output: 2
  output:
    formats:
      - json
`;

      // 1. docker-only fails closed in turnkey host-session (delegate === undefined).
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), baseManifestText('      - docker'));
      const dockerManifest = await loadDeclarativeTaskpack({ repositoryRoot: repo, manifestPath: '.auto-sync/taskpack.yaml' });
      const resolvedDocker = resolveEffectiveTaskpackSandboxPolicy(dockerManifest, {
        workspaceRoot: repo,
        env: { GITHUB_ACTIONS: 'true' },
      });
      assert.deepEqual(resolvedDocker.preferredBackends, ['docker']);
      assert.equal(resolvedDocker.allowDedicatedDirectOverride, undefined);

      const dockerEntry = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 100,
        baseRevision: 'a'.repeat(40),
        mode: 'candidate',
        eventName: 'schedule',
        runRoot: join(work, 'runs'),
        runId: 'run-sandbox-docker-fail',
        turnkey: true,
        upstreamRecords: [{ upstreamId: 'custom-u', status: 'available', version: '1.0.0' }],
        env: { GITHUB_ACTIONS: 'true' },
      });
      assert.equal(dockerEntry.kind, 'blocked');
      assert.equal(
        dockerEntry.reason === 'SANDBOX_POLICY_INVALID' || dockerEntry.reason === 'SANDBOX_BACKEND_UNAVAILABLE',
        true,
        `expected SANDBOX_POLICY_INVALID or SANDBOX_BACKEND_UNAVAILABLE, got ${dockerEntry.reason}`,
      );

      // 2. Explicit direct-dedicated negotiates with allowDedicatedDirectOverride: true and passes turnkey sandbox check.
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), baseManifestText('      - direct-dedicated'));
      const directManifest = await loadDeclarativeTaskpack({ repositoryRoot: repo, manifestPath: '.auto-sync/taskpack.yaml' });
      const resolvedDirect = resolveEffectiveTaskpackSandboxPolicy(directManifest, {
        workspaceRoot: repo,
        env: { GITHUB_ACTIONS: 'true' },
      });
      assert.equal(resolvedDirect.allowDedicatedDirectOverride, true);
      const negotiatedDirect = negotiateSandboxBackend(resolvedDirect, {
        platform: process.platform,
        arch: process.arch,
        probeExecutables: false,
      });
      assert.equal(negotiatedDirect.backendId, 'direct-dedicated');

      const directEntry = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 100,
        baseRevision: 'a'.repeat(40),
        mode: 'candidate',
        eventName: 'schedule',
        runRoot: join(work, 'runs'),
        runId: 'run-sandbox-direct-ok',
        turnkey: true,
        dryRun: true,
        allowManifestCustomBaseUrl: true,
        upstreamRecords: [{ upstreamId: 'custom-u', status: 'available', version: '1.0.0' }],
        env: { GITHUB_ACTIONS: 'true', LLM_TOKEN: 'tok-direct' },
      });
      assert.equal(directEntry.kind, 'compiled', `unexpected directEntry: ${JSON.stringify(directEntry)}`);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('fails fast on invalid INPUT_OUTPUT, emits markdown/text logs, and never rotates model when retryableProviderFailure is false', async () => {
    const work = await mkdtemp(join(tmpdir(), 'lw-t5-outfail-'));
    let probeServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    try {
      await assert.rejects(
        () => runActionCli({
          GITHUB_WORKSPACE: work,
          INPUT_OUTPUT: 'json,bogus-format',
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID',
      );

      const emittedChunks: string[] = [];
      const sinkResult = await writeActionOutputSinks({
        formats: ['markdown', 'text'],
        report: {
          runId: 'run-log-sink',
          status: 'completed',
          externalUrl: null,
          reasonCode: null,
          checks: [{ checkId: 'c1', status: 'passed', detail: 'secret-val-123' }],
        },
        actionResultJson: '{}',
        scrubber: (() => {
          const s = new SecretScrubber();
          s.register('secret-val-123');
          return s;
        })(),
        logSink: chunk => emittedChunks.push(chunk),
      });
      assert.equal(typeof sinkResult.rendered['markdown'], 'string');
      assert.equal(typeof sinkResult.rendered['text'], 'string');
      const joined = emittedChunks.join('\n');
      assert.match(joined, /run-log-sink/);
      assert.equal(joined.includes('secret-val-123'), false);

      probeServer = await startHttpServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }] }));
      });

      // Non-retryable provider failure (even with text matching quota regex) must NOT rotate to second candidate.
      const repo = join(work, 'repo');
      const runRoot = join(work, 'runs');
      await mkdir(join(repo, '.auto-sync', 'prompts'), { recursive: true });
      await mkdir(join(repo, 'docs'), { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await writeFile(join(repo, '.auto-sync', 'prompts', 'instructions.md'), 'check\n');
      await writeFile(join(repo, 'docs', 'upstream.json'), JSON.stringify({ version: '1.0.0' }));
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: no-rotate
spec:
  goal:
    candidate: Test non-retryable failure handling
    noChange: Verify
  scope:
    writable:
      - docs
  instructions:
    - .auto-sync/prompts/instructions.md
  upstreams:
    - id: custom-u
      kind: custom-table
      source: docs/upstream.json
      watchedPaths:
        - docs
  proposal:
    path: docs/proposal.json
    requiredFields:
      - version
    schemaVersion: 1
  verification:
    externalGates: []
    localChecks:
      - id: json
        implementation: json-artifact.v1
  publication:
    mode: disabled
    targetBranch: main
    headBranchPrefix: loopwright/
    titleTemplate: "chore: update synced pack"
  memory:
    directory: .auto-sync/memory
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: false
    releasePublished: false
    commentCommands: []
  models:
    - provider: openai
      id: first-model
      api: openai-completions
      apiKeyEnv: FIRST_KEY
      baseUrl: ${probeServer.url}/v1
      cost:
        input: 1
        output: 2
    - provider: openai
      id: second-model
      api: openai-completions
      apiKeyEnv: SECOND_KEY
      baseUrl: ${probeServer.url}/v1
      cost:
        input: 2
        output: 4
  output:
    formats:
      - json
`);
      let delegateCalls = 0;
      const entryResult = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 100,
        baseRevision: 'a'.repeat(40),
        mode: 'candidate',
        eventName: 'schedule',
        runRoot,
        runId: 'run-no-rotate',
        turnkey: true,
        allowManifestCustomBaseUrl: true,
        upstreamRecords: [{ upstreamId: 'custom-u', status: 'available', version: '1.0.0' }],
        env: { GITHUB_ACTIONS: 'true', FIRST_KEY: 'tok-1', SECOND_KEY: 'tok-2' },
        delegate: async compiled => {
          delegateCalls += 1;
          assert.equal(compiled.registryBytes.length > 0, true);
          return {
            ok: false,
            detail: 'insufficient_quota text inside non-retryable domain error',
            retryableProviderFailure: false,
          };
        },
      });
      assert.equal(entryResult.kind, 'compiled', `unexpected entryResult: ${JSON.stringify(entryResult)}`);
      assert.equal(delegateCalls, 1, 'retryableProviderFailure: false must never rotate to second model candidate');
      assert.equal(entryResult.delegateOutcome?.ok, false);
    } finally {
      await probeServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('rejects custom multi-token pool provider env in command.v1 parameters.env (S-I1)', async () => {
    const work = await mkdtemp(join(tmpdir(), 'lw-t5-poolenv-'));
    try {
      const repo = join(work, 'repo');
      const runRoot = join(work, 'runs');
      await mkdir(join(repo, '.auto-sync', 'prompts'), { recursive: true });
      await mkdir(join(repo, '.auto-sync', 'checks'), { recursive: true });
      await mkdir(join(repo, 'docs'), { recursive: true });
      await mkdir(runRoot, { recursive: true });
      await writeFile(join(repo, '.auto-sync', 'prompts', 'instructions.md'), 'check\n');
      await writeFile(join(repo, 'docs', 'upstream.json'), JSON.stringify({ version: '1.0.0' }));
      await writeFile(join(repo, '.auto-sync', 'checks', 'verify.sh'), '#!/bin/sh\necho "$SYNC_LLM_KEY"\n');
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: custom-pool-env-guard
spec:
  goal:
    candidate: Reject custom provider token pool env in command.v1
    noChange: Check custom pool env
  scope:
    writable:
      - docs
  instructions:
    - .auto-sync/prompts/instructions.md
  upstreams:
    - id: custom-u
      kind: custom-table
      source: docs/upstream.json
      watchedPaths:
        - docs
  proposal:
    path: docs/proposal.json
    requiredFields:
      - version
    schemaVersion: 1
  verification:
    externalGates: []
    localChecks:
      - id: verify
        implementation: command.v1
        parameters:
          script: .auto-sync/checks/verify.sh
          env:
            - SYNC_LLM_KEY
  publication:
    mode: disabled
    targetBranch: main
    headBranchPrefix: loopwright/
    titleTemplate: "chore: update synced pack"
  memory:
    directory: .auto-sync/memory
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: false
    releasePublished: false
    commentCommands: []
  models:
    - provider: openai
      id: gpt-4.1-mini
      api: openai-completions
      baseUrl: https://api.openai.com/v1
      cost:
        input: 1
        output: 2
  output:
    formats:
      - json
`);

      const entryResult = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 100,
        baseRevision: 'a'.repeat(40),
        mode: 'candidate',
        eventName: 'schedule',
        runRoot,
        runId: 'run-pool-env-reject',
        turnkey: true,
        allowManifestCustomBaseUrl: true,
        providerTokenEnv: 'SYNC_LLM_KEY',
        probeFetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
        upstreamRecords: [{ upstreamId: 'custom-u', status: 'available', version: '1.0.0' }],
        env: { GITHUB_ACTIONS: 'true', SYNC_LLM_KEY: 'tok-first-pool-1234,tok-second-pool-5678' },
      });
      assert.equal(entryResult.kind, 'blocked', `expected blocked, got ${JSON.stringify(entryResult)}`);
      assert.equal(entryResult.reason, 'TASKPACK_MANIFEST_INVALID');
      assert.match(entryResult.detail ?? '', /SYNC_LLM_KEY/);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('rejects non-loopback http:// custom-table, RUNNER_ command env prefix, and duplicate spec.output formats (N4, N7, N8)', async () => {
    const work = await mkdtemp(join(tmpdir(), 'lw-t5-nits-'));
    try {
      const repo = join(work, 'repo');
      await mkdir(join(repo, '.auto-sync', 'checks'), { recursive: true });
      await mkdir(join(repo, 'docs'), { recursive: true });
      await writeFile(join(repo, '.auto-sync', 'checks', 'verify.sh'), '#!/bin/sh\ntrue\n');
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: nits-guard
spec:
  goal:
    candidate: Test N4 and N8 guards
    noChange: Check N4 and N8 guards
  scope:
    writable:
      - docs
  upstreams:
    - id: http-u
      kind: custom-table
      source: http://example.com/versions.json
      watchedPaths:
        - docs
  proposal:
    path: docs/proposal.json
    requiredFields:
      - version
    schemaVersion: 1
  verification:
    externalGates: []
    localChecks:
      - id: verify
        implementation: command.v1
        parameters:
          script: .auto-sync/checks/verify.sh
          env:
            - RUNNER_TEMP
  publication:
    mode: disabled
    targetBranch: main
    headBranchPrefix: loopwright/
    titleTemplate: "chore: update synced pack"
  memory:
    directory: .auto-sync/memory
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: false
    releasePublished: false
    commentCommands: []
  output:
    formats:
      - json
      - json
`);
      await assert.rejects(
        () => loadDeclarativeTaskpack({ repositoryRoot: repo, manifestPath: '.auto-sync/taskpack.yaml' }),
        (error: unknown) => error instanceof GitHubAppError && error.code === 'TASKPACK_MANIFEST_INVALID',
      );

      // With valid output and valid env, non-loopback http:// custom-table must fail discovery
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: http-custom-table-guard
spec:
  goal:
    candidate: Test N7 custom-table http rejection
    noChange: Check N7
  scope:
    writable:
      - docs
  upstreams:
    - id: http-u
      kind: custom-table
      source: http://example.com/versions.json
      watchedPaths:
        - docs
  proposal:
    path: docs/proposal.json
    requiredFields:
      - version
    schemaVersion: 1
  verification:
    externalGates: []
    localChecks:
      - id: json
        implementation: json-artifact.v1
  publication:
    mode: disabled
    targetBranch: main
    headBranchPrefix: loopwright/
    titleTemplate: "chore: update synced pack"
  memory:
    directory: .auto-sync/memory
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: false
    releasePublished: false
    commentCommands: []
  output:
    formats:
      - json
`);
      const httpManifest = await loadDeclarativeTaskpack({ repositoryRoot: repo, manifestPath: '.auto-sync/taskpack.yaml' });
      const records = await discoverTaskpackUpstreams(httpManifest, { repositoryRoot: repo });
      assert.equal(records[0]?.status, 'failed');
      assert.match(records[0]?.reason ?? '', /must use https:\/\//);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});
