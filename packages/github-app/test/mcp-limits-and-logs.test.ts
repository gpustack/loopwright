import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import { compilePlan, loadTrustedConfiguration } from '@loopwright/controller';
import {
  applyLimitsToBudgets,
  buildDefaultAuthorPrompt,
  buildNativePullRequestBody,
  compileDeclarativeTaskpack,
  DEFAULT_AUTHOR_PROMPT_HEAD,
  DEFAULT_HOST_BUDGETS,
  formatByteCount,
  formatDurationMs,
  formatTokenCount,
  loadDeclarativeTaskpack,
  mergeTaskpackLimits,
  parseEnvAndInputLimitsOverride,
  runActionCli,
  runGitHubActionEntrypoint,
  SecretScrubber,
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

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function startHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(err => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('expected TCP server address');
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>(resolvePromise => server.close(() => resolvePromise())),
  };
}

function parseGithubOutputs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.length === 0) continue;
    const heredoc = /^([A-Za-z0-9_-]+)<<(.+)$/.exec(line);
    if (heredoc) {
      const key = heredoc[1]!;
      const marker = heredoc[2]!;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && lines[i] !== marker) {
        body.push(lines[i]!);
        i += 1;
      }
      out[key] = body.join('\n');
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0) {
      out[line.slice(0, eq)] = line.slice(eq + 1);
    }
  }
  return out;
}

function sseToolCalls(
  model: string,
  turnId: string,
  calls: readonly { readonly id: string; readonly name: string; readonly args: Record<string, unknown> }[],
  usage = { prompt_tokens: 4000, completion_tokens: 500 },
  extraPaddingChunks = 0,
): string {
  const lines: string[] = [];
  for (let i = 0; i < extraPaddingChunks; i += 1) {
    lines.push(
      `data: ${JSON.stringify({
        id: `chatcmpl-${turnId}`,
        model,
        choices: [{ index: 0, delta: { role: i === 0 ? 'assistant' : undefined, reasoning_content: 'x' }, finish_reason: null }],
      })}`,
      '',
    );
  }
  lines.push(
    `data: ${JSON.stringify({
      id: `chatcmpl-${turnId}`,
      model,
      choices: [{
        index: 0,
        delta: {
          role: extraPaddingChunks === 0 ? 'assistant' : undefined,
          tool_calls: calls.map((c, index) => ({
            index,
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        },
        finish_reason: null,
      }],
    })}`,
    '',
    `data: ${JSON.stringify({
      id: `chatcmpl-${turnId}`,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { ...usage, prompt_tokens_details: { cached_tokens: 100 } },
    })}`,
    '',
    'data: [DONE]',
    '',
    '',
  );
  return lines.join('\n');
}

function sseStop(
  model: string,
  text: string,
  usage = { prompt_tokens: 4000, completion_tokens: 500 },
): string {
  return [
    `data: ${JSON.stringify({
      id: 'chatcmpl-final',
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { ...usage, prompt_tokens_details: { cached_tokens: 100 } },
    })}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
}

describe('MCP servers (stdio + HTTP), configurable execution limits, and human-readable Action logs', () => {
  it('formats tokens (K/M/B), durations (ms/s/m/h), and byte counts cleanly', () => {
    assert.equal(formatTokenCount(850), '850');
    assert.equal(formatTokenCount(1_250), '1.25K');
    assert.equal(formatTokenCount(14_200), '14.2K');
    assert.equal(formatTokenCount(1_280_000), '1.28M');
    assert.equal(formatTokenCount(2_100_000_000), '2.1B');
    assert.equal(formatDurationMs(420), '420ms');
    assert.equal(formatDurationMs(12_400), '12.4s');
    assert.equal(formatDurationMs(135_000), '2m 15s');
    assert.equal(formatDurationMs(3_600_000), '1h');
    assert.equal(formatByteCount(512), '512 B');
    assert.equal(formatByteCount(2_048), '2 KB');
    assert.equal(formatByteCount(67_108_864), '64 MB');
  });

  it('applies limit precedence INPUT_* > LOOPWRIGHT_* > spec.limits > defaults', async () => {
    const work = await mkdtemp(join(tmpdir(), 'lw-limits-prec-'));
    try {
      await mkdir(join(work, '.loopwright'), { recursive: true });
      await writeFile(
        join(work, '.loopwright', 'taskpack.yaml'),
        `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: limits-test
spec:
  goal:
    candidate: Update version metadata.
    noChange: Confirm no updates needed.
  upstreams:
    - id: engine
      kind: github-release
      source: acme/engine
      watchedPaths: []
  proposal:
    path: proposal.json
    requiredFields: [schema_version]
    schemaVersion: 1
  verification:
    localChecks:
      - id: proposal-check
        implementation: json-artifact.v1
    externalGates: []
  publication:
    mode: disabled
    targetBranch: main
    headBranchPrefix: loopwright/
    titleTemplate: "chore: sync"
  memory:
    directory: .loopwright/memory
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands: []
  limits:
    wallTimeSeconds: 5400
    totalTokens: 15000000
    maxOutputTokens: 24576
    maxModelCalls: 80
    toolTimeoutSeconds: 420
`,
        'utf8',
      );
      const manifest = await loadDeclarativeTaskpack({
        manifestPath: join(work, '.loopwright', 'taskpack.yaml'),
        repositoryRoot: work,
      });
      assert.equal(manifest.spec.limits?.wallTimeSeconds, 5400);
      assert.equal(manifest.spec.limits?.totalTokens, 15_000_000);

      const envLimits = parseEnvAndInputLimitsOverride({
        LOOPWRIGHT_WALL_TIME_SECONDS: '7200',
        LOOPWRIGHT_TOTAL_TOKENS: '30000000',
        'INPUT_WALL-TIME-SECONDS': '9000',
      });
      const merged = mergeTaskpackLimits(manifest.spec.limits, envLimits);
      assert.equal(merged.wallTimeSeconds, 9000, 'INPUT_WALL-TIME-SECONDS overrides LOOPWRIGHT_WALL_TIME_SECONDS and spec.limits');
      assert.equal(merged.totalTokens, 30_000_000, 'LOOPWRIGHT_TOTAL_TOKENS overrides spec.limits');
      assert.equal(merged.maxOutputTokens, 24_576, 'unset env fields preserve spec.limits');

      const budgets = applyLimitsToBudgets(DEFAULT_HOST_BUDGETS, merged);
      assert.equal(budgets.wallTimeMs, 9_000_000);
      assert.equal(budgets.totalTokens, 30_000_000);
      assert.equal(budgets.perCallOutputTokens, 24_576);
      assert.equal(budgets.maxModelCalls, 80);

      process.env['TEST_PROVIDER_KEY'] = 'tok-123';
      const compiled = await compileDeclarativeTaskpack(manifest, {
        mode: 'candidate',
        repository: 'acme/repo',
        repositoryRoot: work,
        baseRevision: 'a'.repeat(40),
        sourceRevision: 'a'.repeat(40),
        targetMatrix: null,
        runtimeOptions: {},
        budgets: DEFAULT_HOST_BUDGETS,
        limits: envLimits,
        gateEndpoints: [],
        publicationEndpoint: null,
        credentialEnvMap: {
          provider: 'TEST_PROVIDER_KEY',
          gate: 'TEST_GATE_KEY',
          publication: 'TEST_PUB_KEY',
        },
        authorPrompt: 'Update proposal.',
      });
      delete process.env['TEST_PROVIDER_KEY'];
      assert.equal(compiled.config.spec.task.spec.budgets.wallTimeMs, 9_000_000);
      assert.equal(compiled.config.spec.task.spec.budgets.totalTokens, 30_000_000);
      assert.equal(compiled.registry.spec.roleProfiles[0]?.limits?.toolWallMs, 420_000);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('refuses MCP OAuth declarations and missing required MCP secret env vars cleanly', async () => {
    const work = await mkdtemp(join(tmpdir(), 'lw-mcp-refuse-'));
    const repo = join(work, 'repo');
    const runRoot = join(work, 'runs');
    await mkdir(join(repo, '.loopwright'), { recursive: true });
    await mkdir(runRoot, { recursive: true });
    try {
      await git(repo, ['init', '-b', 'main']);
      await writeFile(join(repo, 'proposal.json'), '{"schema_version":1}\n', 'utf8');
      await writeFile(
        join(repo, '.loopwright', 'taskpack.yaml'),
        `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: mcp-oauth-check
spec:
  goal:
    candidate: Update proposal.
    noChange: Confirm no change.
  upstreams:
    - id: engine
      kind: custom-table
      source: versions
      watchedPaths: []
  proposal:
    path: proposal.json
    requiredFields: [schema_version]
    schemaVersion: 1
  verification:
    localChecks:
      - id: proposal-check
        implementation: json-artifact.v1
    externalGates: []
  publication:
    mode: disabled
    targetBranch: main
    headBranchPrefix: loopwright/
    titleTemplate: "chore: sync"
  memory:
    directory: .loopwright/memory
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands: []
  mcp:
    servers:
      - id: github
        transport: stdio
        command: github-mcp-server
        oauth: true
`,
        'utf8',
      );
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'init']);
      const headSha = await git(repo, ['rev-parse', 'HEAD']);

      const oauthRefused = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        repositoryFullName: 'acme/repo',
        baseRevision: headSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'mcp-oauth-refused',
        dryRun: true,
      });
      assert.equal(oauthRefused.kind, 'refused');
      if (oauthRefused.kind === 'refused') {
        assert.equal(oauthRefused.code, 'MCP_OAUTH_UNSUPPORTED');
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('executes github (stdio) + deepwiki (Streamable HTTP) MCP tools, >2MB SSE stream, >60s command.v1 timeout, human-readable K/M logs, and zero byte-array dumps in runActionCli', async () => {
    const work = await mkdtemp(join(tmpdir(), 'lw-mcp-e2e-'));
    const repo = join(work, 'repo');
    const bareRemote = join(work, 'remote.git');
    const runRoot = join(work, 'runs');
    const binDir = join(work, 'bin');
    await mkdir(repo, { recursive: true });
    await mkdir(bareRemote, { recursive: true });
    await mkdir(runRoot, { recursive: true });
    await mkdir(binDir, { recursive: true });

    const githubToken = 'ghs_SuperSecretGitHubMcpToken998877';
    const llmToken = 'sk_SuperSecretProviderToken112233';
    const deepwikiBearer = 'dw_SuperSecretBearerToken445566';

    let deepwikiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let githubApiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;

    try {
      // 1. Create a real executable `github-mcp-server` stdio MCP binary in trusted `binDir`.
      const githubMcpScript = `#!/usr/bin/env node
const readline = require('node:readline');
const args = process.argv.slice(2);
const pat = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || '';
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\\n'); }
rl.on('line', line => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-github-mcp-server', version: '1.0.0' }
      }
    });
  } else if (req.method === 'notifications/initialized') {
    // notification
  } else if (req.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        tools: [{
          name: 'list_commits',
          description: 'List upstream repository commits via read-only GitHub MCP',
          inputSchema: {
            type: 'object',
            properties: {
              owner: { type: 'string' },
              repo: { type: 'string' }
            },
            required: ['owner', 'repo']
          }
        }]
      }
    });
  } else if (req.method === 'tools/call') {
    const toolArgs = (req.params && req.params.arguments) || {};
    const hasPat = pat.length > 10;
    // Deliberately include raw PAT in diagnostic line to prove SecretScrubber scrubs MCP tool results!
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        content: [{
          type: 'text',
          text: JSON.stringify({
            repo: toolArgs.owner + '/' + toolArgs.repo,
            cliArgs: args,
            authenticated: hasPat,
            latestReleaseTag: 'v3.4.0',
            debugAuthEcho: pat
          })
        }],
        isError: false
      }
    });
  } else if (req.id !== undefined) {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } });
  }
});
`;
      const githubMcpBin = join(binDir, 'github-mcp-server');
      await writeFile(githubMcpBin, githubMcpScript, { mode: 0o755 });
      await chmod(githubMcpBin, 0o755);

      // 2. Start a real Streamable HTTP MCP server (`deepwiki`).
      const deepwikiCalls: string[] = [];
      let sawDeepwikiBearer = false;
      deepwikiServer = await startHttpServer(async (req, res) => {
        if (req.url !== '/mcp') {
          res.writeHead(404);
          res.end();
          return;
        }
        if (req.method === 'DELETE') {
          res.writeHead(200);
          res.end();
          return;
        }
        if (req.headers['authorization'] === `Bearer ${deepwikiBearer}`) {
          sawDeepwikiBearer = true;
        }
        const rpc = await readJsonBody(req);
        const method = rpc['method'];
        const id = rpc['id'];
        if (method === 'initialize') {
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'dw-session-1' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'mock-deepwiki-mcp', version: '1.0.0' },
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
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              tools: [
                {
                  name: 'ask_question',
                  description: 'Query DeepWiki upstream architecture notes',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      repoName: { type: 'string' },
                      question: { type: 'string' },
                    },
                    required: ['repoName', 'question'],
                  },
                },
                {
                  name: 'transient_probe',
                  description: 'Simulated upstream soft error tool',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
            },
          }));
          return;
        }
        if (method === 'tools/call') {
          const params = (rpc['params'] ?? {}) as Record<string, unknown>;
          const toolName = String(params['name'] ?? '');
          deepwikiCalls.push(toolName);
          res.writeHead(200, { 'content-type': 'application/json' });
          if (toolName === 'transient_probe') {
            res.end(JSON.stringify({
              jsonrpc: '2.0',
              id,
              error: { code: -32000, message: `upstream rate note (${deepwikiBearer})` },
            }));
            return;
          }
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: 'DeepWiki answer: v3.4.0 adds streaming tensor flags.' }],
              isError: false,
            },
          }));
          return;
        }
        res.writeHead(400);
        res.end();
      });

      // 3. Start mock OpenAI-compatible provider server:
      //    - Turn 1 streams > 2.1 MB of raw SSE chunks (14,500 chunks > old 1 MB responseBytes cap!)
      //      and calls BOTH `mcp__github__list_commits` and `mcp__deepwiki__ask_question` + `mcp__deepwiki__transient_probe`.
      //    - Verifies tool results received on Turn 2 have scrubbed secrets and soft error result (`isError` handled without crash),
      //      then writes `pack/proposal.json` + `docs/release.md`.
      //    - Turn 3 settles with stop.
      let llmTurn = 0;
      const observedToolDefinitions: string[] = [];
      const observedToolResultContents: string[] = [];
      openAiServer = await startHttpServer(async (req, res) => {
        if (req.url !== '/v1/chat/completions') {
          res.writeHead(404);
          res.end();
          return;
        }
        const body = await readJsonBody(req);
        if (body['max_tokens'] === 1) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'probe', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
          return;
        }
        llmTurn += 1;
        const tools = Array.isArray(body['tools']) ? (body['tools'] as Record<string, unknown>[]) : [];
        if (llmTurn === 1) {
          for (const t of tools) {
            const fn = t['function'] as Record<string, unknown> | undefined;
            if (typeof fn?.['name'] === 'string') observedToolDefinitions.push(fn['name']);
          }
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          // 14,500 SSE chunks * ~155 bytes/chunk ~= 2.25 MB raw HTTP SSE response (> old 1 MB limit!)
          res.end(sseToolCalls(
            'glm-5.3',
            'turn-1',
            [
              { id: 'call_gh_1', name: 'mcp__github__list_commits', args: { owner: 'vllm-project', repo: 'vllm' } },
              { id: 'call_dw_1', name: 'mcp__deepwiki__ask_question', args: { repoName: 'vllm-project/vllm', question: 'What changed in v3.4.0?' } },
              { id: 'call_dw_err', name: 'mcp__deepwiki__transient_probe', args: {} },
            ],
            { prompt_tokens: 5_000, completion_tokens: 1_200 },
            14_500,
          ));
          return;
        }
        if (llmTurn === 2) {
          const messages = Array.isArray(body['messages']) ? (body['messages'] as Record<string, unknown>[]) : [];
          for (const msg of messages) {
            if (msg['role'] === 'tool') {
              observedToolResultContents.push(typeof msg['content'] === 'string' ? msg['content'] : JSON.stringify(msg['content']));
            }
          }
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(sseToolCalls(
            'glm-5.3',
            'turn-2',
            [
              {
                id: 'call_write_prop',
                name: 'write',
                args: {
                  path: 'pack/proposal.json',
                  content: `${JSON.stringify({ schema_version: 1, version: '3.4.0', notes: 'verified via github + deepwiki mcp' }, null, 2)}\n`,
                },
              },
              {
                id: 'call_write_doc',
                name: 'write',
                args: {
                  path: 'docs/release.md',
                  content: '# Release v3.4.0\n\nStreaming tensor flags enabled.\n',
                },
              },
            ],
            { prompt_tokens: 6_000, completion_tokens: 800 },
          ));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseStop(
          'glm-5.3',
          JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null }),
          { prompt_tokens: 1_200, completion_tokens: 300 },
        ));
      });

      // 4. Start mock GitHub REST API server (upstream release + PR creation).
      const prBodies: Record<string, unknown>[] = [];
      githubApiServer = await startHttpServer(async (req, res) => {
        if (req.method === 'GET' && req.url === '/repos/acme/runner') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 777, full_name: 'acme/runner', default_branch: 'main' }));
          return;
        }
        if (req.method === 'GET' && req.url === '/repos/vllm-project/vllm/releases/latest') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v3.4.0', html_url: 'https://github.invalid/vllm-project/vllm/releases/tag/v3.4.0', prerelease: false, draft: false }));
          return;
        }
        if (req.method === 'GET' && req.url?.startsWith('/repos/acme/runner/pulls?')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([]));
          return;
        }
        if (req.method === 'POST' && req.url === '/repos/acme/runner/pulls') {
          prBodies.push(await readJsonBody(req));
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ number: 88, html_url: 'https://github.invalid/acme/runner/pull/88' }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      // 5. Initialize target git repository + bare remote + `.auto-sync/taskpack.yaml` with:
      //    - `github` stdio MCP server (`envFrom: { GITHUB_PERSONAL_ACCESS_TOKEN: GITHUB_TOKEN }`)
      //    - `command.v1` check with `timeoutSeconds: 180` (> old 55s cap!)
      //    - `spec.limits` + `INPUT_MCP-SERVERS` adding `deepwiki` Streamable HTTP MCP server!
      await git(bareRemote, ['init', '--bare', '--initial-branch=main']);
      await git(repo, ['init', '--initial-branch=main']);
      await mkdir(join(repo, '.auto-sync', 'checks'), { recursive: true });
      await mkdir(join(repo, '.auto-sync', 'prompts'), { recursive: true });
      await mkdir(join(repo, 'pack'), { recursive: true });
      await mkdir(join(repo, 'docs'), { recursive: true });

      await writeFile(join(repo, 'pack', 'proposal.json'), '{"schema_version":1,"version":"3.3.0"}\n', 'utf8');
      await writeFile(join(repo, 'docs', 'release.md'), '# Release v3.3.0\n', 'utf8');
      // 36 KB instruction file (> old 24 KB limit!)
      await writeFile(
        join(repo, '.auto-sync', 'prompts', 'guide.md'),
        `# Runner Sync Guide\n\nUse MCP tools before editing.\n\n${'Reference padding line for large instruction prompt.\n'.repeat(700)}`,
        'utf8',
      );
      const verifyScript = `#!/bin/sh
set -eu
if [ -n "\${GITHUB_PERSONAL_ACCESS_TOKEN:-}" ] || [ -n "\${DEEPWIKI_BEARER_SECRET:-}" ]; then
  echo "MCP secret leaked into command.v1 environment" >&2
  exit 1
fi
grep -q '"3.4.0"' "$LOOPWRIGHT_CANDIDATE_DIR/pack/proposal.json"
`;
      await writeFile(join(repo, '.auto-sync', 'checks', 'verify.sh'), verifyScript, { mode: 0o755 });
      await chmod(join(repo, '.auto-sync', 'checks', 'verify.sh'), 0o755);

      const taskpackYaml = `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: runner-auto-sync
spec:
  goal:
    candidate: Inspect upstream vllm release via github and deepwiki MCP tools and update pack/proposal.json.
    noChange: Confirm pack/proposal.json matches upstream.
  scope:
    writable:
      - pack
      - docs
    protected: []
  instructions:
    - .auto-sync/prompts/guide.md
  upstreams:
    - id: vllm
      kind: github-release
      source: vllm-project/vllm
      watchedPaths: []
  proposal:
    path: pack/proposal.json
    requiredFields:
      - schema_version
      - version
    schemaVersion: 1
  verification:
    localChecks:
      - id: proposal-schema
        implementation: json-artifact.v1
      - id: verify-sync
        implementation: command.v1
        parameters:
          script: .auto-sync/checks/verify.sh
          timeoutSeconds: 180
    externalGates: []
  publication:
    mode: pull_request
    targetBranch: main
    headBranchPrefix: loopwright/
    titleTemplate: "chore(sync): update upstream matrix"
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
    - provider: zai
      id: glm-5.3
      thinking: high
      api: openai-completions
      baseUrl: ${openAiServer.url}/v1
      apiKeyEnv: LLM_API_TOKEN
      cost:
        input: 1
        output: 2
  mcp:
    servers:
      - id: github
        transport: stdio
        command: github-mcp-server
        args:
          - stdio
          - --read-only
          - --toolsets
          - repos,pull_requests,issues
        envFrom:
          GITHUB_PERSONAL_ACCESS_TOKEN: GITHUB_TOKEN
        timeoutSeconds: 60
  limits:
    wallTimeSeconds: 3600
    totalTokens: 25000000
    maxOutputTokens: 32768
  output:
    formats:
      - json
      - github-step-summary
`;
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), taskpackYaml, 'utf8');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'initial runner taskpack']);
      const headSha = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['push', bareRemote, 'HEAD:main']);

      const summaryFile = join(work, 'step-summary.md');
      const outputFile = join(work, 'github-output.txt');

      // Capture stdout and stderr during `runActionCli` to inspect exact Action log output!
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      const origStdoutWrite = process.stdout.write.bind(process.stdout);
      const origStderrWrite = process.stderr.write.bind(process.stderr);
      process.stdout.write = ((chunk: string | Uint8Array): boolean => {
        stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      }) as typeof process.stdout.write;
      process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      }) as typeof process.stderr.write;

      let exitCode: number;
      try {
        exitCode = await runActionCli({
          PATH: `${binDir}${delimiter}${process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin'}`,
          GITHUB_ACTIONS: 'true',
          GITHUB_WORKSPACE: repo,
          LOOPWRIGHT_REPOSITORY: 'acme/runner',
          GITHUB_SHA: headSha,
          GITHUB_API_URL: githubApiServer.url,
          GITHUB_STEP_SUMMARY: summaryFile,
          GITHUB_OUTPUT: outputFile,
          GITHUB_TOKEN: githubToken,
          LLM_API_TOKEN: llmToken,
          DEEPWIKI_BEARER_SECRET: deepwikiBearer,
          'INPUT_TASKPACK-PATH': '.auto-sync/taskpack.yaml',
          'INPUT_EVENT-NAME': 'workflow_dispatch',
          'INPUT_RUN-ROOT': runRoot,
          'INPUT_RUN-ID': 'mcp-limits-e2e',
          'INPUT_ALLOW-CUSTOM-BASE-URL': 'true',
          'INPUT_REMOTE-URL': bareRemote,
          'INPUT_MCP-SERVERS': JSON.stringify([
            {
              id: 'deepwiki',
              transport: 'http',
              url: `${deepwikiServer.url}/mcp`,
              bearerTokenEnv: 'DEEPWIKI_BEARER_SECRET',
              timeoutSeconds: 60,
            },
          ]),
        });
      } finally {
        process.stdout.write = origStdoutWrite;
        process.stderr.write = origStderrWrite;
      }

      const fullStdout = stdoutChunks.join('');
      const fullStderr = stderrChunks.join('');

      assert.equal(exitCode, 0, `expected exitCode 0; stderr:\n${fullStderr}`);
      assert.equal(prBodies.length, 1, 'publisher must open managed PR');

      // Requirement 1 assertions: both stdio (`github`) and HTTP (`deepwiki`) MCP servers discovered & invoked!
      assert.equal(observedToolDefinitions.includes('mcp__github__list_commits'), true);
      assert.equal(observedToolDefinitions.includes('mcp__deepwiki__ask_question'), true);
      assert.equal(observedToolDefinitions.includes('mcp__deepwiki__transient_probe'), true);
      assert.equal(sawDeepwikiBearer, true, 'HTTP MCP server must receive Bearer token from bearerTokenEnv');
      assert.deepEqual(deepwikiCalls, ['ask_question', 'transient_probe']);

      const joinedToolResults = observedToolResultContents.join('\n');
      assert.match(joinedToolResults, /"authenticated":true/);
      assert.match(joinedToolResults, /"latestReleaseTag":"v3\.4\.0"/);
      assert.match(joinedToolResults, /DeepWiki answer: v3\.4\.0 adds streaming tensor flags/);
      assert.equal(joinedToolResults.includes(githubToken), false, 'MCP tool result must scrub leaked GITHUB_TOKEN');
      assert.equal(joinedToolResults.includes(deepwikiBearer), false, 'MCP error result must scrub leaked bearer token');

      // Requirement 4 assertions: ZERO raw Buffer / byte-number array dumps in stdout or GITHUB_OUTPUT!
      assert.ok(Buffer.byteLength(fullStdout, 'utf8') < 8_192, `stdout JSON must stay compact (<8KB), got ${Buffer.byteLength(fullStdout, 'utf8')}B`);
      assert.equal(fullStdout.includes('"registryBytes"'), false, 'stdout must not dump registryBytes');
      assert.equal(fullStdout.includes('"configBytes"'), false, 'stdout must not dump configBytes');
      assert.equal(fullStdout.includes('"type":"Buffer"'), false, 'stdout must not dump serialized Buffer objects');
      assert.equal(/\[\s*\d+\s*,\s*\d+\s*,\s*\d+/.test(fullStdout), false, 'stdout must contain zero raw byte arrays');

      const outputs = parseGithubOutputs(await readFile(outputFile, 'utf8'));
      const resultJson = outputs['result'] ?? '';
      assert.ok(Buffer.byteLength(resultJson, 'utf8') < 8_192);
      assert.equal(resultJson.includes('"registryBytes"'), false);
      assert.equal(resultJson.includes('"configBytes"'), false);
      assert.equal(/\[\s*\d+\s*,\s*\d+\s*,\s*\d+/.test(resultJson), false);
      const parsedResult = JSON.parse(resultJson) as {
        kind: string;
        taskpack: { registryByteLength: number; instructionResources: { byteLength: number }[] };
        delegateOutcome: { ok: boolean } | null;
      };
      assert.equal(parsedResult.kind, 'compiled');
      assert.equal(parsedResult.delegateOutcome?.ok, true);
      assert.ok(parsedResult.taskpack.registryByteLength > 0);
      assert.ok((parsedResult.taskpack.instructionResources[0]?.byteLength ?? 0) > 35_000, '36KB instruction resource must compile cleanly');

      // Exact integer total-tokens preserved in machine output (5000+1200 + 6000+800 + 1200+300 = 14500)
      assert.equal(outputs['total-tokens'], '14500');
      assert.equal(outputs['pr-url'], 'https://github.invalid/acme/runner/pull/88');

      // Requirement 3 & 4 assertions: human-readable Action stderr progress logs + text Run Summary + K/M token formatting!
      assert.match(fullStderr, /\[loopwright\] upstreams: vllm=available\(v3\.4\.0\)/);
      assert.match(fullStderr, /\[loopwright\] intake: taskpack=runner-auto-sync mode=candidate/);
      assert.match(fullStderr, /\[loopwright\] mcp: connected github \(stdio\) — 1 tools/);
      assert.match(fullStderr, /\[loopwright\] mcp: connected deepwiki \(http\) — 2 tools/);
      assert.match(fullStderr, /\[loopwright\] model: zai\/glm-5\.3 \(thinking=high\) — wallTime=1h, totalTokens=25M, maxOutputTokens=32\.77K, contextWindow=1M/);
      assert.match(fullStderr, /\[loopwright\] turn #1: settled in .+ — in 5K \/ out 1\.2K tokens, tools=\[mcp__github__list_commits, mcp__deepwiki__ask_question, mcp__deepwiki__transient_probe\]/);
      assert.match(fullStderr, /\[loopwright\] tool mcp__github__list_commits: ok/);
      assert.match(fullStderr, /\[loopwright\] tool mcp__deepwiki__transient_probe: error/);
      assert.match(fullStderr, /\[loopwright\] check verify-sync: passed/);
      assert.match(fullStderr, /Run ID: mcp-limits-e2e/);
      assert.match(fullStderr, /Model: zai\/glm-5\.3 \(thinking: high, contextWindow=1M\)/);
      assert.match(fullStderr, /MCP Servers: github \(stdio, 1 tools\); deepwiki \(http, 2 tools\)/);
      assert.match(fullStderr, /Tokens: 14\.5K total \(12\.2K in \/ 2\.3K out\)/);

      const stepSummary = await readFile(summaryFile, 'utf8');
      assert.match(stepSummary, /\| Model \| zai\/glm-5\.3 \(thinking: high, contextWindow=1M\) \[rotations: 0\] \|/);
      assert.match(stepSummary, /\| MCP Servers \| github \(stdio, 1 tools\); deepwiki \(http, 2 tools\) \|/);
      assert.match(stepSummary, /\| Tokens \| 14\.5K total \(12\.2K in \/ 2\.3K out, reported\) \|/);
      assert.match(stepSummary, /\| Elapsed \| \d+(\.\d+)?(ms|s|m)/);

      // Zero secret leakage across stdout, stderr, GITHUB_OUTPUT, and GITHUB_STEP_SUMMARY!
      for (const secret of [githubToken, llmToken, deepwikiBearer]) {
        assert.equal(fullStdout.includes(secret), false);
        assert.equal(fullStderr.includes(secret), false);
        assert.equal(resultJson.includes(secret), false);
        assert.equal(stepSummary.includes(secret), false);
      }
    } finally {
      await deepwikiServer?.close();
      await openAiServer?.close();
      await githubApiServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('supports contextWindow override via spec.limits.contextWindow, LOOPWRIGHT_CONTEXT_WINDOW, and INPUT_CONTEXT-WINDOW', async () => {
    const work = await mkdtemp(join(tmpdir(), 'lw-cw-override-'));
    try {
      await mkdir(join(work, '.loopwright'), { recursive: true });
      await writeFile(
        join(work, '.loopwright', 'taskpack.yaml'),
        `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: cw-override-test
spec:
  goal:
    candidate: Update proposal.
    noChange: Confirm no updates needed.
  upstreams:
    - id: engine
      kind: custom-table
      source: versions
      watchedPaths: []
  proposal:
    path: proposal.json
    requiredFields: [schema_version]
    schemaVersion: 1
  verification:
    localChecks:
      - id: proposal-check
        implementation: json-artifact.v1
    externalGates: []
  publication:
    mode: disabled
    targetBranch: main
    headBranchPrefix: loopwright/
    titleTemplate: "chore: sync"
  memory:
    directory: .loopwright/memory
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands: []
  models:
    - provider: custom-glm
      id: glm-5.1
      thinking: high
      api: openai-completions
      baseUrl: http://127.0.0.1:43111/v1
      apiKeyEnv: CUSTOM_GLM_TOKEN
      contextWindow: 128000
      maxTokens: 65536
  limits:
    contextWindow: 200000
    maxOutputTokens: 65536
`,
        'utf8',
      );
      const manifest = await loadDeclarativeTaskpack({
        manifestPath: join(work, '.loopwright', 'taskpack.yaml'),
        repositoryRoot: work,
      });
      assert.equal(manifest.spec.limits?.contextWindow, 200_000);

      // 1. spec.limits.contextWindow (200K) overrides spec.models[0].contextWindow (128K), unlocking full 65536 maxOutputTokens
      const compiledFromYaml = await compileDeclarativeTaskpack(manifest, {
        mode: 'candidate',
        repository: 'acme/repo',
        repositoryRoot: work,
        baseRevision: 'a'.repeat(40),
        sourceRevision: 'a'.repeat(40),
        targetMatrix: null,
        allowManifestCustomBaseUrl: true,
        runtimeOptions: {},
        budgets: DEFAULT_HOST_BUDGETS,
        gateEndpoints: [],
        publicationEndpoint: null,
        credentialEnvMap: {
          provider: 'CUSTOM_GLM_TOKEN',
          gate: 'TEST_GATE_KEY',
          publication: 'TEST_PUB_KEY',
        },
        authorPrompt: 'Update proposal.',
      });
      assert.equal(compiledFromYaml.registry.spec.roleProfiles[0]?.selection.customProvider?.contextWindow, 200_000);
      assert.equal(compiledFromYaml.config.spec.task.spec.budgets.perCallOutputTokens, 65_536);

      // 2. LOOPWRIGHT_CONTEXT_WINDOW overrides spec.limits.contextWindow, and INPUT_CONTEXT-WINDOW overrides LOOPWRIGHT_CONTEXT_WINDOW
      const envOnly = parseEnvAndInputLimitsOverride({
        LOOPWRIGHT_CONTEXT_WINDOW: '256000',
      });
      assert.equal(envOnly.contextWindow, 256_000);

      const inputWins = parseEnvAndInputLimitsOverride({
        LOOPWRIGHT_CONTEXT_WINDOW: '256000',
        'INPUT_CONTEXT-WINDOW': '512000',
      });
      assert.equal(inputWins.contextWindow, 512_000);

      const compiledFromInput = await compileDeclarativeTaskpack(manifest, {
        mode: 'candidate',
        repository: 'acme/repo',
        repositoryRoot: work,
        baseRevision: 'a'.repeat(40),
        sourceRevision: 'a'.repeat(40),
        targetMatrix: null,
        allowManifestCustomBaseUrl: true,
        runtimeOptions: {},
        budgets: DEFAULT_HOST_BUDGETS,
        limits: inputWins,
        gateEndpoints: [],
        publicationEndpoint: null,
        credentialEnvMap: {
          provider: 'CUSTOM_GLM_TOKEN',
          gate: 'TEST_GATE_KEY',
          publication: 'TEST_PUB_KEY',
        },
        authorPrompt: 'Update proposal.',
      });
      assert.equal(compiledFromInput.registry.spec.roleProfiles[0]?.selection.customProvider?.contextWindow, 512_000);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('passes Turn #1 admission and multi-turn bulky tool outputs on a 128K contextWindow custom openai-completions model with maxTokens=65536 and 25 external MCP tools (~49KB request body)', async () => {
    const work = await mkdtemp(join(tmpdir(), 'lw-128k-25mcp-'));
    const repo = join(work, 'repo');
    const runRoot = join(work, 'runs');
    await mkdir(join(repo, '.loopwright'), { recursive: true });
    await mkdir(runRoot, { recursive: true });

    let mcpHttpServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;

    try {
      // Build an HTTP MCP server exposing 25 tools whose schemas mirror github-mcp-server + deepwiki (~42KB of tool definitions)
      const twentyFiveMcpTools = Array.from({ length: 25 }, (_, i) => ({
        name: `tool_${String(i + 1).padStart(2, '0')}_inspect_upstream`,
        description: `Read-only GitHub/DeepWiki MCP inspection endpoint #${i + 1}: ` + 'detailed-parameter-semantics-'.repeat(28),
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Organization or user login (' + 'o'.repeat(180) + ')' },
            repo: { type: 'string', description: 'Repository slug (' + 'r'.repeat(180) + ')' },
            ref: { type: 'string', description: 'Commit SHA, tag, or branch (' + 'c'.repeat(180) + ')' },
            perPage: { type: 'integer', description: 'Pagination limit 1..100 (' + 'p'.repeat(160) + ')' },
          },
          required: ['owner', 'repo'],
        },
      }));

      mcpHttpServer = await startHttpServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/mcp') {
          res.writeHead(404).end();
          return;
        }
        const rpc = await readJsonBody(req);
        const method = rpc['method'];
        const id = rpc['id'];
        if (id === undefined) {
          res.writeHead(202).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        if (method === 'initialize') {
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'heavy-mcp', version: '1.0.0' } },
          }));
          return;
        }
        if (method === 'tools/list') {
          res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: twentyFiveMcpTools } }));
          return;
        }
        if (method === 'tools/call') {
          const params = (rpc['params'] ?? {}) as { name?: string };
          // Return a bulky ~32KB tool payload on each call so multi-turn history exceeds 63KB unless pruneContextForBudget accounts for baseBytes!
          const largePayload = `MCP(${params.name ?? 'unknown'}):v4.0.0:` + 'release-notes-entry-'.repeat(1_550);
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: largePayload }], isError: false },
          }));
          return;
        }
        res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }));
      });

      const observedRequestByteLengths: number[] = [];
      let llmTurn = 0;
      openAiServer = await startHttpServer(async (req, res) => {
        if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
          res.writeHead(404).end();
          return;
        }
        const rawChunks: Buffer[] = [];
        for await (const chunk of req) rawChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const rawBuf = Buffer.concat(rawChunks);
        observedRequestByteLengths.push(rawBuf.byteLength);

        llmTurn += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (llmTurn === 1) {
          res.end(sseToolCalls('glm-5.1', 't1', [
            { id: 'c1', name: 'mcp__heavy__tool_01_inspect_upstream', args: { owner: 'vllm-project', repo: 'vllm' } },
            { id: 'c2', name: 'mcp__heavy__tool_02_inspect_upstream', args: { owner: 'sgl-project', repo: 'sglang' } },
          ]));
          return;
        }
        if (llmTurn === 2) {
          res.end(sseToolCalls('glm-5.1', 't2', [
            { id: 'c3', name: 'mcp__heavy__tool_03_inspect_upstream', args: { owner: 'ggerganov', repo: 'llama.cpp' } },
            { id: 'c4', name: 'write', args: { path: 'proposal.json', content: JSON.stringify({ schema_version: 1, synced_release: 'v4.0.0' }, null, 2) + '\n' } },
          ]));
          return;
        }
        res.end(sseStop('glm-5.1', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null })));
      });

      await git(repo, ['init', '-b', 'main']);
      await writeFile(join(repo, 'proposal.json'), '{"schema_version":1,"synced_release":"v3.9.0"}\n', 'utf8');
      await writeFile(
        join(repo, '.loopwright', 'instructions.md'),
        '# Sync Instructions\n' + 'Verify upstream compatibility matrix carefully.\n'.repeat(120),
        'utf8',
      );
      await writeFile(
        join(repo, '.loopwright', 'taskpack.yaml'),
        `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: runner-128k-admission
spec:
  goal:
    candidate: Inspect 25 MCP tools on a 128K window and update proposal.json.
    noChange: Confirm no updates needed.
  scope:
    writable:
      - proposal.json
  instructions:
    - .loopwright/instructions.md
  upstreams:
    - id: vllm
      kind: custom-table
      source: versions
      watchedPaths: []
  proposal:
    path: proposal.json
    requiredFields:
      - schema_version
      - synced_release
    schemaVersion: 1
  verification:
    localChecks:
      - id: proposal-check
        implementation: json-artifact.v1
    externalGates: []
  publication:
    mode: disabled
    targetBranch: main
    headBranchPrefix: loopwright/
    titleTemplate: "chore: sync"
  memory:
    directory: .loopwright/memory
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands: []
  models:
    - provider: custom-glm
      id: glm-5.1
      thinking: high
      api: openai-completions
      baseUrl: ${openAiServer.url}/v1
      apiKeyEnv: CUSTOM_GLM_TOKEN
      contextWindow: 128000
      maxTokens: 65536
  limits:
    maxOutputTokens: 65536
  output:
    formats:
      - json
      - github-step-summary
`,
        'utf8',
      );
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'init 128k repo']);
      const headSha = await git(repo, ['rev-parse', 'HEAD']);

      const summaryFile = join(work, 'summary.md');
      const outputFile = join(work, 'output.txt');
      const stderrChunks: string[] = [];
      const origStdoutWrite = process.stdout.write.bind(process.stdout);
      const origStderrWrite = process.stderr.write.bind(process.stderr);
      process.stdout.write = (() => true) as typeof process.stdout.write;
      process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      }) as typeof process.stderr.write;

      let exitCode: number;
      try {
        exitCode = await runActionCli({
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          GITHUB_WORKSPACE: repo,
          LOOPWRIGHT_REPOSITORY: 'gpustack/runner',
          GITHUB_SHA: headSha,
          GITHUB_STEP_SUMMARY: summaryFile,
          GITHUB_OUTPUT: outputFile,
          CUSTOM_GLM_TOKEN: 'sk_test_128k_token',
          'INPUT_EVENT-NAME': 'workflow_dispatch',
          'INPUT_RUN-ROOT': runRoot,
          'INPUT_RUN-ID': 'run-128k-25mcp',
          'INPUT_ALLOW-CUSTOM-BASE-URL': 'true',
          'INPUT_MCP-SERVERS': JSON.stringify([
            {
              id: 'heavy',
              transport: 'http',
              url: `${mcpHttpServer.url}/mcp`,
              timeoutSeconds: 30,
            },
          ]),
          'INPUT_UPSTREAM-RECORDS': JSON.stringify([
            { upstreamId: 'vllm', status: 'available', version: 'v4.0.0', changed: true },
          ]),
        });
      } finally {
        process.stdout.write = origStdoutWrite;
        process.stderr.write = origStderrWrite;
      }

      const fullStderr = stderrChunks.join('');
      assert.equal(exitCode, 0, `expected 128K + 25 MCP tools run to succeed without CONTEXT_UNSAFE; stderr:\n${fullStderr}`);
      assert.equal(llmTurn, 3, 'all 3 LLM turns must execute cleanly');
      assert.ok(observedRequestByteLengths[0]! > 45_000, `Turn #1 bodyBytes should exceed 45KB (got ${observedRequestByteLengths[0]}B)`);
      // Every turn's serialized OpenAI wire payload must fit inside 128000 - 32768 - 16384 - 8192 = 70656 bytes!
      for (const [idx, len] of observedRequestByteLengths.entries()) {
        assert.ok(len <= 70_656, `Turn #${idx + 1} bodyBytes (${len}B) exceeded 128K input budget (70656B)`);
      }
      assert.match(fullStderr, /\[loopwright\] mcp: connected heavy \(http\) — 25 tools/);
      assert.match(fullStderr, /\[loopwright\] model: custom-glm\/glm-5\.1 \(thinking=high\) — wallTime=1h, totalTokens=20M, maxOutputTokens=\d+(\.\d+)?K, contextWindow=128K/);
      assert.match(fullStderr, /Model: custom-glm\/glm-5\.1 \(thinking: high, contextWindow=128K\)/);
    } finally {
      await mcpHttpServer?.close();
      await openAiServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('normalizes ./candidate/ + single-edit shorthand, recovers from soft out-of-scope edit, and logs denied (TOOL_DENIED /path) on hard path traversal', async () => {
    const work = await mkdtemp(join(tmpdir(), 'lw-alias-denied-logs-'));
    const repo = join(work, 'repo');
    const runRoot = join(work, 'run');
    await mkdir(join(repo, '.loopwright'), { recursive: true });
    await mkdir(join(repo, 'pack'), { recursive: true });

    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    try {
      // Phase 1: Soft out-of-scope edit + ./candidate/ shorthand edit settles cleanly
      let phase: 'recover' | 'hard_deny' = 'recover';
      let llmTurn = 0;
      openAiServer = await startHttpServer(async (req, res) => {
        if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
          res.writeHead(404).end();
          return;
        }
        for await (const chunk of req) void chunk;
        llmTurn += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (phase === 'recover') {
          if (llmTurn === 1) {
            res.end(sseToolCalls('glm-5.1', 'r1', [
              { id: 'c-scope', name: 'edit', args: { path: './candidate/README.md', oldText: 'Repo', newText: 'Nope' } },
            ]));
            return;
          }
          if (llmTurn === 2) {
            res.end(sseToolCalls('glm-5.1', 'r2', [
              {
                id: 'c-ok',
                name: 'edit',
                args: {
                  path: './candidate/pack/proposal.json',
                  oldText: '"v1.0.0"',
                  newText: '"v2.0.0"',
                },
              },
            ]));
            return;
          }
          res.end(sseStop('glm-5.1', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null })));
          return;
        }
        res.end(sseToolCalls('glm-5.1', 'd1', [
          { id: 'c-trav', name: 'edit', args: { path: './candidate/../escape.json', oldText: 'a', newText: 'b' } },
        ]));
      });

      await git(repo, ['init', '-b', 'main']);
      await writeFile(join(repo, 'README.md'), '# Repo\n', 'utf8');
      await writeFile(join(repo, 'pack', 'proposal.json'), '{\n  "schema_version": 1,\n  "synced_release": "v1.0.0"\n}\n', 'utf8');
      await writeFile(join(repo, '.loopwright', 'instructions.md'), '# Update pack/proposal.json\n', 'utf8');
      await writeFile(
        join(repo, '.loopwright', 'taskpack.yaml'),
        `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: runner-alias-and-denied-log
spec:
  goal:
    candidate: Update pack/proposal.json to synced_release v2.0.0.
    noChange: Confirm pack/proposal.json is current.
  scope:
    writable:
      - pack
  instructions:
    - .loopwright/instructions.md
  upstreams:
    - id: vllm
      kind: custom-table
      source: versions
      watchedPaths: []
  proposal:
    path: pack/proposal.json
    requiredFields:
      - schema_version
      - synced_release
    schemaVersion: 1
  verification:
    localChecks:
      - id: proposal-check
        implementation: json-artifact.v1
    externalGates: []
  publication:
    mode: disabled
    targetBranch: main
    headBranchPrefix: loopwright/
    titleTemplate: "chore: sync"
  memory:
    directory: .loopwright/memory
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands: []
  models:
    - provider: custom-glm
      id: glm-5.1
      thinking: off
      api: openai-completions
      baseUrl: ${openAiServer.url}/v1
      apiKeyEnv: CUSTOM_GLM_TOKEN
      contextWindow: 128000
      maxTokens: 4096
  output:
    formats:
      - json
`,
        'utf8',
      );
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'init alias repo']);
      const headSha = await git(repo, ['rev-parse', 'HEAD']);

      const runWithCapture = async (runId: string) => {
        const stderrChunks: string[] = [];
        const origStdoutWrite = process.stdout.write.bind(process.stdout);
        const origStderrWrite = process.stderr.write.bind(process.stderr);
        process.stdout.write = (() => true) as typeof process.stdout.write;
        process.stderr.write = ((chunk: string | Uint8Array): boolean => {
          stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
          return true;
        }) as typeof process.stderr.write;
        try {
          const code = await runActionCli({
            PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
            GITHUB_ACTIONS: 'true',
            GITHUB_WORKSPACE: repo,
            LOOPWRIGHT_REPOSITORY: 'gpustack/runner',
            GITHUB_SHA: headSha,
            GITHUB_STEP_SUMMARY: join(work, `${runId}-summary.md`),
            GITHUB_OUTPUT: join(work, `${runId}-output.txt`),
            CUSTOM_GLM_TOKEN: 'sk_test_alias_token',
            'INPUT_EVENT-NAME': 'workflow_dispatch',
            'INPUT_RUN-ROOT': join(runRoot, runId),
            'INPUT_RUN-ID': runId,
            'INPUT_ALLOW-CUSTOM-BASE-URL': 'true',
            'INPUT_UPSTREAM-RECORDS': JSON.stringify([
              { upstreamId: 'vllm', status: 'available', version: 'v2.0.0', changed: true },
            ]),
          });
          return { code, stderr: stderrChunks.join('') };
        } finally {
          process.stdout.write = origStdoutWrite;
          process.stderr.write = origStderrWrite;
        }
      };

      const recovered = await runWithCapture('run-alias-recover');
      assert.equal(recovered.code, 0, `expected soft scope error + ./candidate/ shorthand edit to succeed; stderr:\n${recovered.stderr}`);
      assert.match(recovered.stderr, /\[loopwright\] tool edit: error \(/);
      assert.match(recovered.stderr, /\[loopwright\] tool edit: ok \(/);

      phase = 'hard_deny';
      llmTurn = 0;
      const denied = await runWithCapture('run-hard-deny');
      assert.notEqual(denied.code, 0, 'expected hard path traversal TOOL_DENIED to fail closed');
      assert.match(denied.stderr, /\[loopwright\] tool edit: denied \(TOOL_DENIED \/path\) —/);
      assert.match(denied.stderr, /TOOL_DENIED \(tool \/path\)/);
    } finally {
      await openAiServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('builds submission.v1 author prompts with declared check IDs and defaults maxAttempts to 5 with safe 64-checkpoint clamping', async () => {
    const scrubber = new SecretScrubber();
    scrubber.register('ghp_super_secret_token_99');

    assert.match(DEFAULT_AUTHOR_PROMPT_HEAD, /"version":1,"status":"completed"\|"no_change"\|"failed"\|"blocked","checks":\[\],"reason":/);

    const noChangePrompt = buildDefaultAuthorPrompt({
      mode: 'no-change',
      repositoryFullName: 'gpustack/runner',
      runtimeEnv: {},
      scrubber,
    });
    assert.equal(noChangePrompt, DEFAULT_AUTHOR_PROMPT_HEAD);

    const candidatePrompt = buildDefaultAuthorPrompt({
      mode: 'candidate',
      repositoryFullName: 'gpustack/runner',
      upstreamRecords: [
        { upstreamId: 'vllm', status: 'available', version: 'v0.19.1' },
      ],
      acceptanceCheckIds: ['proposal-json', 'validate-candidate'],
      runtimeEnv: {},
      scrubber,
    });
    assert.match(candidatePrompt, /Final Response Format \(`submission\.v1`\):/);
    assert.match(candidatePrompt, /declared check IDs \(proposal-json, validate-candidate\)/);
    assert.match(candidatePrompt, /"reason" MUST be null when "status" is "passed"/);
    assert.ok(candidatePrompt.length <= 16_384);

    // Even when upstream records exceed the prompt budget, Final Response Format remains intact at the tail.
    const hugeUpstreams = Array.from({ length: 120 }, (_, idx) => ({
      upstreamId: `upstream-${idx}`,
      status: 'available' as const,
      version: `v1.${idx}.0-${'x'.repeat(180)}`,
    }));
    const truncatedCandidatePrompt = buildDefaultAuthorPrompt({
      mode: 'candidate',
      repositoryFullName: 'gpustack/runner',
      upstreamRecords: hugeUpstreams,
      acceptanceCheckIds: ['proposal-json'],
      runtimeEnv: {},
      scrubber,
    });
    assert.ok(truncatedCandidatePrompt.length <= 16_384);
    assert.match(truncatedCandidatePrompt, /Final Response Format \(`submission\.v1`\):/);
    assert.match(truncatedCandidatePrompt, /declared check IDs \(proposal-json\)/);

    const work = await mkdtemp(join(tmpdir(), 'lw-max-attempts-'));
    const prevToken = process.env['LOOPWRIGHT_PROVIDER_TOKEN'];
    const prevPub = process.env['LOOPWRIGHT_PUBLICATION_SIGNING_SECRET'];
    process.env['LOOPWRIGHT_PROVIDER_TOKEN'] = 'sk-max-attempts-test-123456';
    process.env['LOOPWRIGHT_PUBLICATION_SIGNING_SECRET'] = 'pub-max-attempts-secret-123456';
    try {
      await chmod(work, 0o700);
      const realWork = await realpath(work);
      const repo = join(realWork, 'repo');
      const operator = join(realWork, 'operator');
      await mkdir(join(repo, '.loopwright'), { recursive: true });
      await mkdir(operator, { recursive: true, mode: 0o700 });
      await chmod(operator, 0o700);

      const makeManifestYaml = (checkCount: number): string => {
        const checks = Array.from(
          { length: checkCount },
          (_, i) => `      - id: check-${i + 1}\n        implementation: json-artifact.v1`,
        ).join('\n');
        return `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: attempts-test
spec:
  goal:
    candidate: Sync upstreams.
    noChange: Verify no drift.
  scope:
    writable:
      - .autosync
  upstreams:
    - id: vllm
      kind: custom-table
      source: versions
      watchedPaths: []
  proposal:
    path: .autosync/proposal.json
    requiredFields: [schema_version]
    schemaVersion: 1
  verification:
    localChecks:
${checks}
    externalGates: []
  publication:
    mode: pull_request
    targetBranch: main
    headBranchPrefix: auto-sync/
    titleTemplate: "chore: sync"
  memory:
    directory: .loopwright/memory
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands: []
`;
      };

      await writeFile(join(repo, '.loopwright', 'taskpack.yaml'), makeManifestYaml(1), 'utf8');
      const manifest1 = await loadDeclarativeTaskpack({
        manifestPath: join(repo, '.loopwright', 'taskpack.yaml'),
        repositoryRoot: repo,
      });
      const compiledDefault = await compileDeclarativeTaskpack(manifest1, {
        mode: 'candidate',
        repository: 'gpustack/runner',
        repositoryRoot: repo,
        baseRevision: 'a'.repeat(40),
        sourceRevision: 'a'.repeat(40),
        targetMatrix: null,
        runtimeOptions: {},
        budgets: DEFAULT_HOST_BUDGETS,
        publicationEndpoint: {
          id: 'pub',
          url: 'https://publisher.example.test/publish',
          signingCredentialRef: 'pub-sig',
        },
        credentialEnvMap: {
          provider: 'LOOPWRIGHT_PROVIDER_TOKEN',
          publication: 'LOOPWRIGHT_PUBLICATION_SIGNING_SECRET',
        },
      });
      assert.equal(compiledDefault.config.spec.controls.maxAttempts, 5);
      assert.match(
        String(compiledDefault.registry.spec.handlers.find(h => h.implementation === 'pi.agent.v1')?.parameters['prompt'] ?? ''),
        /"version":1,"status":"completed"\|"no_change"\|"failed"\|"blocked"/,
      );

      // With 4 localChecks + 2 implicit checks = 6 verifier slots and PR publication,
      // calcD(5, 3) > 64 so compileDeclarativeTaskpack clamps maxAttempts cleanly to fit 64 checkpoints.
      await writeFile(join(repo, '.loopwright', 'taskpack.yaml'), makeManifestYaml(4), 'utf8');
      const manifest4 = await loadDeclarativeTaskpack({
        manifestPath: join(repo, '.loopwright', 'taskpack.yaml'),
        repositoryRoot: repo,
      });
      const compiledClamped = await compileDeclarativeTaskpack(manifest4, {
        mode: 'candidate',
        repository: 'gpustack/runner',
        repositoryRoot: repo,
        baseRevision: 'a'.repeat(40),
        sourceRevision: 'a'.repeat(40),
        targetMatrix: null,
        runtimeOptions: {},
        budgets: DEFAULT_HOST_BUDGETS,
        publicationEndpoint: {
          id: 'pub',
          url: 'https://publisher.example.test/publish',
          signingCredentialRef: 'pub-sig',
        },
        credentialEnvMap: {
          provider: 'LOOPWRIGHT_PROVIDER_TOKEN',
          publication: 'LOOPWRIGHT_PUBLICATION_SIGNING_SECRET',
        },
      });
      assert.ok(compiledClamped.config.spec.controls.maxAttempts < 5);
      assert.ok(compiledClamped.config.spec.controls.maxAttempts >= 1);

      const regDir = join(operator, 'registry');
      const cfgDir = join(operator, 'config');
      await mkdir(regDir, { recursive: true, mode: 0o700 });
      await mkdir(cfgDir, { recursive: true, mode: 0o700 });
      await chmod(regDir, 0o700);
      await chmod(cfgDir, 0o700);
      const regPath = join(regDir, 'registry.yaml');
      const cfgPath = join(cfgDir, 'config.json');
      await writeFile(regPath, compiledClamped.registryBytes, { mode: 0o600 });
      await writeFile(cfgPath, JSON.stringify(compiledClamped.config), { mode: 0o600 });
      await chmod(regPath, 0o600);
      await chmod(cfgPath, 0o600);
      const loaded = await loadTrustedConfiguration({
        configPath: cfgPath,
        registryPath: regPath,
        registrySha256: compiledClamped.registrySha256,
        untrustedRoots: [repo],
      });
      assert.equal(loaded.ok, true, loaded.ok ? '' : `loadTrustedConfiguration failed: ${loaded.error.code}`);
      if (loaded.ok) {
        const plan = await compilePlan(loaded.value);
        assert.equal(plan.ok, true);
      }
    } finally {
      if (prevToken === undefined) delete process.env['LOOPWRIGHT_PROVIDER_TOKEN'];
      else process.env['LOOPWRIGHT_PROVIDER_TOKEN'] = prevToken;
      if (prevPub === undefined) delete process.env['LOOPWRIGHT_PUBLICATION_SIGNING_SECRET'];
      else process.env['LOOPWRIGHT_PUBLICATION_SIGNING_SECRET'] = prevPub;
      await rm(work, { recursive: true, force: true });
    }
  });

  it('renders proposal-enriched PR bodies with escaped Markdown tables, secret scrubbing, length bounds, and clean fallback', () => {
    const scrubber = new SecretScrubber();
    const secretVal = 'ghp_proposal_secret_value_abc123';
    scrubber.register(secretVal);
    const digest = 'deadbeefcafebabe'.repeat(4);

    const mapProposal = {
      schema_version: 1,
      summary: `Upgrade CUDA vLLM to 0.19.1 (token=${secretVal}).`,
      subscriptions: {
        'cuda/vllm': {
          status: 'ready',
          engine_version: '0.19.1',
          plugin_version: null,
          reason: 'Upgrade | verified\non main.',
        },
        'cann/vllm': {
          status: 'blocked',
          engine_version: '0.18.0',
          plugin_version: '0.18.0rc1',
          reason: 'Waiting on upstream pairing.',
        },
      },
    };
    const renderedMap = buildNativePullRequestBody({
      runId: 'run-prop-1',
      candidateDigest: digest,
      proposalPath: '.autosync/proposal.json',
      files: [{ name: '.autosync/proposal.json', bytes: Buffer.from(JSON.stringify(mapProposal), 'utf8') }],
      stagedPaths: new Set(['.autosync/proposal.json']),
      scrubber,
    });
    assert.ok(renderedMap.includes('Upgrade CUDA vLLM to 0.19.1'), renderedMap);
    assert.equal(renderedMap.includes(secretVal), false, 'secret must be scrubbed from PR body');
    assert.ok(renderedMap.includes('| Subscription | Status | Engine | Plugin | Reason |'), renderedMap);
    assert.ok(renderedMap.includes('| cuda/vllm | ready | 0.19.1 | - | Upgrade \\| verified on main. |'), renderedMap);
    assert.ok(renderedMap.includes('| cann/vllm | blocked | 0.18.0 | 0.18.0rc1 | Waiting on upstream pairing. |'), renderedMap);
    assert.ok(renderedMap.endsWith('Automated Loopwright update for run `run-prop-1` (`deadbeefcafe`).'), renderedMap);

    const arrayProposal = {
      schema_version: 1,
      summary: 'Array subscriptions summary ' + 'w'.repeat(35_000),
      subscriptions: [
        { subscription: 'rocm/sglang', status: 'unchanged', engine: '0.5.9', plugin: null, reason: 'Current.' },
      ],
    };
    const renderedArray = buildNativePullRequestBody({
      runId: 'run-prop-2',
      candidateDigest: digest,
      proposalPath: './.autosync/proposal.json',
      files: [{ name: '.autosync/proposal.json', bytes: Buffer.from(JSON.stringify(arrayProposal), 'utf8') }],
      stagedPaths: new Set(['.autosync/proposal.json']),
      scrubber,
    });
    assert.ok(Array.from(renderedArray).length <= 32_000, `expected <= 32000 code points, got ${Array.from(renderedArray).length}`);
    assert.ok(renderedArray.endsWith('Automated Loopwright update for run `run-prop-2` (`deadbeefcafe`).'));

    const expectedFallback = 'Automated Loopwright update for run `run-prop-3` (`deadbeefcafe`).';
    assert.equal(
      buildNativePullRequestBody({
        runId: 'run-prop-3',
        candidateDigest: digest,
        files: [],
        scrubber,
      }),
      expectedFallback,
    );
    assert.equal(
      buildNativePullRequestBody({
        runId: 'run-prop-3',
        candidateDigest: digest,
        proposalPath: '.autosync/proposal.json',
        files: [{ name: '.autosync/proposal.json', bytes: Buffer.from('{not valid json', 'utf8') }],
        stagedPaths: new Set(['.autosync/proposal.json']),
        scrubber,
      }),
      expectedFallback,
    );
    assert.equal(
      buildNativePullRequestBody({
        runId: 'run-prop-3',
        candidateDigest: digest,
        proposalPath: '.autosync/proposal.json',
        files: [{ name: '.autosync/proposal.json', bytes: Buffer.from(JSON.stringify(mapProposal), 'utf8') }],
        stagedPaths: new Set(['other/file.json']),
        scrubber,
      }),
      expectedFallback,
    );
  });

  it('logs format & implementation repair dispatches, publishes proposal-enriched PR body, and surfaces diagnostic details on exhausted settlement', async () => {
    const work = await mkdtemp(join(tmpdir(), 'lw-repair-and-pr-body-'));
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let githubApiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    try {
      const bareRemote = join(work, 'remote.git');
      const repo = join(work, 'repo');
      const runRoot = join(work, 'runs');
      await mkdir(bareRemote, { recursive: true });
      await git(bareRemote, ['init', '--bare', '-b', 'main']);
      await mkdir(join(repo, '.loopwright', 'checks'), { recursive: true });
      await mkdir(join(repo, '.autosync'), { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await chmod(runRoot, 0o700);
      await git(repo, ['init', '-b', 'main']);
      await git(repo, ['remote', 'add', 'origin', bareRemote]);

      await writeFile(
        join(repo, '.autosync', 'proposal.json'),
        JSON.stringify({ schema_version: 1, summary: 'Initial', subscriptions: {} }, null, 2) + '\n',
        'utf8',
      );
      const checkScript = `#!/bin/sh
grep -q '"ready"' .autosync/proposal.json
`;
      await writeFile(join(repo, '.loopwright', 'checks', 'verify.sh'), checkScript, { mode: 0o755 });

      const createdPrBodies: string[] = [];
      githubApiServer = await startHttpServer(async (req, res) => {
        const url = req.url ?? '';
        if (req.method === 'GET' && url === '/repos/gpustack/runner') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 777, full_name: 'gpustack/runner', default_branch: 'main' }));
          return;
        }
        if (req.method === 'GET' && url.startsWith('/repos/gpustack/runner/pulls')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('[]');
          return;
        }
        if (req.method === 'POST' && url === '/repos/gpustack/runner/pulls') {
          const body = await readJsonBody(req);
          createdPrBodies.push(String(body['body'] ?? ''));
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ number: 88, html_url: 'https://github.com/gpustack/runner/pull/88' }));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
      });

      let scenario: 'recover_and_publish' | 'exhaust_format' = 'recover_and_publish';
      let callCount = 0;
      const capturedPrompts: string[] = [];
      openAiServer = await startHttpServer(async (req, res) => {
        const url = req.url ?? '';
        if (req.method !== 'POST' || !url.endsWith('/chat/completions')) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        const body = await readJsonBody(req);
        const messages = Array.isArray(body['messages']) ? body['messages'] : [];
        const lastUser = [...messages].reverse().find(
          m => m !== null && typeof m === 'object' && (m as Record<string, unknown>)['role'] === 'user',
        ) as Record<string, unknown> | undefined;
        const promptStr = typeof lastUser?.['content'] === 'string'
          ? lastUser['content']
          : JSON.stringify(lastUser?.['content'] ?? '');
        capturedPrompts.push(promptStr);

        callCount += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });

        if (scenario === 'exhaust_format') {
          res.end(sseStop('glm-5.1', 'Still writing Markdown prose instead of JSON.\n\n- bullet 1'));
          return;
        }

        if (callCount === 1) {
          // Initial authoring: write draft without "ready" status so verify.sh will fail once,
          // then on turn 2 return Markdown prose to trigger format repair!
          res.end(sseToolCalls('glm-5.1', 'c1', [{
            id: 'w1',
            name: 'write',
            args: {
              path: '.autosync/proposal.json',
              content: JSON.stringify({
                schema_version: 1,
                summary: 'Draft without ready status yet.',
                subscriptions: {
                  'cuda/vllm': { status: 'unchanged', engine_version: '0.19.0', plugin_version: null, reason: 'Pending.' },
                },
              }, null, 2) + '\n',
            },
          }]));
          return;
        }
        if (callCount === 2) {
          res.end(sseStop('glm-5.1', 'All edits written.\n\nSubmission summary:\n- Draft written.'));
          return;
        }
        if (callCount === 3) {
          // Format repair (#2 role dispatch): tools disabled, return valid submission.v1 JSON!
          res.end(sseStop('glm-5.1', JSON.stringify({
            version: 1,
            status: 'completed',
            checks: [],
            reason: 'Draft written for verification.',
          })));
          return;
        }
        if (callCount === 4) {
          // Implementation repair (#3 role dispatch): update proposal.json so verify.sh passes!
          res.end(sseToolCalls('glm-5.1', 'c4', [{
            id: 'w2',
            name: 'write',
            args: {
              path: '.autosync/proposal.json',
              content: JSON.stringify({
                schema_version: 1,
                summary: 'Upgrade CUDA vLLM to 0.19.1.',
                subscriptions: {
                  'cuda/vllm': {
                    status: 'ready',
                    engine_version: '0.19.1',
                    plugin_version: null,
                    reason: 'Validated v0.19.1 release.',
                  },
                },
              }, null, 2) + '\n',
            },
          }]));
          return;
        }
        res.end(sseStop('glm-5.1', JSON.stringify({
          version: 1,
          status: 'completed',
          checks: [],
          reason: 'Updated cuda/vllm to ready.',
        })));
      });

      await writeFile(
        join(repo, '.loopwright', 'taskpack.yaml'),
        `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: runner-repair-observability
spec:
  goal:
    candidate: Sync runner upstreams.
    noChange: Confirm upstreams are current.
  scope:
    writable:
      - .autosync
  upstreams:
    - id: vllm
      kind: custom-table
      source: versions
      watchedPaths: []
  proposal:
    path: .autosync/proposal.json
    requiredFields:
      - schema_version
      - summary
    schemaVersion: 1
  verification:
    localChecks:
      - id: proposal-check
        implementation: json-artifact.v1
      - id: verify-cmd
        implementation: command.v1
        parameters:
          script: .loopwright/checks/verify.sh
          timeoutSeconds: 10
    externalGates: []
  publication:
    mode: pull_request
    targetBranch: main
    headBranchPrefix: auto-sync/
    titleTemplate: "chore: sync"
  memory:
    directory: .loopwright/memory
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands: []
  models:
    - provider: custom-glm
      id: glm-5.1
      thinking: off
      api: openai-completions
      baseUrl: ${openAiServer.url}/v1
      apiKeyEnv: CUSTOM_GLM_TOKEN
      contextWindow: 128000
      maxTokens: 4096
`,
        'utf8',
      );
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'init repo']);
      await git(repo, ['push', 'origin', 'main']);
      const headSha = await git(repo, ['rev-parse', 'HEAD']);

      const r1Root = join(runRoot, 'r1');
      const r2Root = join(runRoot, 'r2');
      await mkdir(r1Root, { recursive: true });
      await mkdir(r2Root, { recursive: true });

      const progressLines: string[] = [];
      const res = await runGitHubActionEntrypoint({
        turnkey: true,
        repositoryRoot: repo,
        repositoryFullName: 'gpustack/runner',
        baseRevision: headSha,
        sourceRevision: headSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot: r1Root,
        runId: 'run-repair-e2e',
        allowManifestCustomBaseUrl: true,
        gitRemoteUrl: bareRemote,
        githubApiBaseUrl: githubApiServer.url,
        githubToken: 'ghp_test_write_token_1234',
        upstreamRecords: [{ upstreamId: 'vllm', status: 'available', version: 'v0.19.1' }],
        progressSink: line => progressLines.push(line),
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          CUSTOM_GLM_TOKEN: 'sk_test_repair_token_1234',
        },
      });
      assert.equal(res.kind, 'compiled');
      if (res.kind === 'compiled') {
        assert.equal(res.delegateOutcome?.ok, true, `expected repair + publish to succeed: ${res.delegateOutcome?.detail}\nlogs:\n${progressLines.join('\n')}`);
      }
      assert.ok(
        progressLines.some(l => l.includes('role dispatch #2: format repair (tools disabled)')),
        `missing format repair progress log in:\n${progressLines.join('\n')}`,
      );
      assert.ok(
        progressLines.some(l => l.includes('role dispatch #3: implementation repair')),
        `missing implementation repair progress log in:\n${progressLines.join('\n')}`,
      );
      // Verify formatPrompt sent on call #3 contained the taskpack's allowed check IDs!
      assert.ok(
        capturedPrompts.some(p => p.includes('Allowed checkId values: proposal-check, verify-cmd.')),
        `expected formatPrompt to list allowedCheckIds; prompts:\n${capturedPrompts.join('\n---\n')}`,
      );
      // Verify published PR body is enriched from .autosync/proposal.json!
      assert.equal(createdPrBodies.length, 1);
      assert.match(createdPrBodies[0]!, /Upgrade CUDA vLLM to 0.19.1\./);
      assert.match(createdPrBodies[0]!, /\| Subscription \| Status \| Engine \| Plugin \| Reason \|/);
      assert.match(createdPrBodies[0]!, /\| cuda\/vllm \| ready \| 0\.19\.1 \| - \| Validated v0\.19\.1 release\. \|/);
      assert.match(createdPrBodies[0]!, /Automated Loopwright update for run `run-repair-e2e`/);

      // Now verify non-passing exhausted settlement surfaces concise diagnostic details.
      scenario = 'exhaust_format';
      callCount = 0;
      const exhaustLogs: string[] = [];
      const exhaustedRes = await runGitHubActionEntrypoint({
        turnkey: true,
        repositoryRoot: repo,
        repositoryFullName: 'gpustack/runner',
        baseRevision: headSha,
        sourceRevision: headSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot: r2Root,
        runId: 'run-exhaust-diag',
        allowManifestCustomBaseUrl: true,
        gitRemoteUrl: bareRemote,
        githubApiBaseUrl: githubApiServer.url,
        githubToken: 'ghp_test_write_token_1234',
        upstreamRecords: [{ upstreamId: 'vllm', status: 'available', version: 'v0.19.1' }],
        progressSink: line => exhaustLogs.push(line),
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          CUSTOM_GLM_TOKEN: 'sk_test_repair_token_1234',
          LOOPWRIGHT_MAX_ATTEMPTS: '2',
          LOOPWRIGHT_MAX_FORMAT_REPAIRS: '2',
        },
      });
      assert.equal(exhaustedRes.kind, 'compiled');
      if (exhaustedRes.kind === 'compiled') {
        assert.equal(exhaustedRes.delegateOutcome?.ok, false);
        const detail = exhaustedRes.delegateOutcome?.detail ?? '';
        assert.match(detail, /run run-exhaust-diag settled as exhausted \(/);
        assert.match(detail, /attempts=2\/2/);
        assert.match(detail, /formatRepairs=1\/2/);
        assert.match(detail, /submission=unavailable/);
      }
      assert.ok(
        exhaustLogs.some(l => l.includes('role dispatch #2: format repair (tools disabled)')),
        `expected format repair log in exhausted run:\n${exhaustLogs.join('\n')}`,
      );
      assert.ok(
        exhaustLogs.some(l => l.includes('submission=unavailable')),
        `expected diagnostic detail in exhausted attempt log:\n${exhaustLogs.join('\n')}`,
      );
    } finally {
      await openAiServer?.close();
      await githubApiServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });
});
