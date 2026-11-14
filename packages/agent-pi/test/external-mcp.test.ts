import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { admitTask, type Result } from '@loopwright/core';
import { createLocalRun, type StateResult } from '@loopwright/state';
import { contract } from '../../core/test/fixtures.js';
import { digest } from '../src/boundary.js';
import { describePiAdapterFiles } from '../src/descriptor.js';
import { HostMcpRegistry, isExternalMcpToolName } from '../src/external-mcp.js';
import {
  isSupportedHostSessionPlatform,
  openPiHostSessionAdapterV2,
  type HostSessionProgressEvent,
} from '../src/host-session.js';
import { MAX_LIMITS } from '../src/policy.js';
import type { PiHostV2, PiOpenInputV2 } from '../src/types-v2.js';

function coreGood<T>(value: Result<T>): T {
  assert.equal(value.ok, true);
  if (!value.ok) throw new Error('core fixture failed');
  return value.value;
}

function stateGood<T>(value: StateResult<T>): T {
  assert.equal(value.ok, true, JSON.stringify(value));
  if (!value.ok) throw new Error('state fixture failed');
  return value.value;
}

function writeMockStdioMcpExecutable(dir: string, name = 'mock-github-mcp'): string {
  const scriptPath = join(dir, name);
  const source = `#!${process.execPath}
const readline = require('node:readline');

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\\n');
}

rl.on('line', async line => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (!('id' in req)) return;
  if (req.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-github-mcp', version: '1.0.0' },
      },
    });
    return;
  }
  if (req.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        tools: [
          {
            name: 'list_commits',
            description: 'List repository commits via GitHub MCP',
            inputSchema: {
              type: 'object',
              properties: { repo: { type: 'string' }, sha: { type: 'string' } },
              required: ['repo'],
            },
          },
          {
            name: 'failing_tool',
            description: 'Simulates an upstream MCP error',
            inputSchema: { type: 'object', properties: { reason: { type: 'string' } } },
          },
          {
            name: 'slow_tool',
            description: 'Simulates a slow MCP call exceeding timeout',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'excluded_tool',
            description: 'Filtered out when includeTools is set',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
    });
    return;
  }
  if (req.method === 'tools/call') {
    const toolName = req.params?.name;
    const args = req.params?.arguments ?? {};
    if (toolName === 'list_commits') {
      const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN ?? 'missing';
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                repo: args.repo,
                sha: args.sha ?? 'HEAD',
                commits: ['abc1234 feat: sync upstream'],
                authEcho: token,
              }),
            },
          ],
        },
      });
      return;
    }
    if (toolName === 'failing_tool') {
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          isError: true,
          content: [{ type: 'text', text: 'GitHub API rate limit exceeded: ' + (args.reason ?? '403') }],
        },
      });
      return;
    }
    if (toolName === 'slow_tool') {
      await new Promise(resolve => setTimeout(resolve, 2500));
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: { content: [{ type: 'text', text: 'too late' }] },
      });
      return;
    }
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Unknown tool: ' + toolName } });
  }
});
`;
  writeFileSync(scriptPath, source, { mode: 0o755 });
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

async function startMockHttpMcpServer(): Promise<{
  readonly url: string;
  readonly seenAuthHeaders: string[];
  readonly close: () => Promise<void>;
}> {
  const seenAuthHeaders: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (req.method === 'DELETE') {
      res.writeHead(204).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    if (typeof req.headers.authorization === 'string') {
      seenAuthHeaders.push(req.headers.authorization);
    }
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        id?: string | number;
        method?: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      if (body.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.setHeader('mcp-session-id', 'session-deepwiki-1');
      if (body.method === 'initialize') {
        res.writeHead(200).end(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'mock-deepwiki', version: '1.0.0' },
          },
        }));
        return;
      }
      if (body.method === 'tools/list') {
        res.writeHead(200).end(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools: [
              {
                name: 'ask_question',
                description: 'Ask DeepWiki about an upstream repository',
                inputSchema: {
                  type: 'object',
                  properties: { repoName: { type: 'string' }, question: { type: 'string' } },
                  required: ['repoName', 'question'],
                },
              },
              {
                name: 'huge_doc',
                description: 'Returns a large document to test byte clamping',
                inputSchema: { type: 'object', properties: {} },
              },
            ],
          },
        }));
        return;
      }
      if (body.method === 'tools/call') {
        if (body.params?.name === 'ask_question') {
          res.writeHead(200).end(JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              content: [
                {
                  type: 'text',
                  text: `DeepWiki answer for ${String(body.params.arguments?.repoName)}: architecture verified`,
                },
              ],
            },
          }));
          return;
        }
        if (body.params?.name === 'huge_doc') {
          res.writeHead(200).end(JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              content: [{ type: 'text', text: Array.from({ length: 400 }, (_, i) => `line-${i}-${'x'.repeat(200)}`).join('\n') }],
            },
          }));
          return;
        }
      }
      res.writeHead(200).end(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32601, message: 'Method not found' },
      }));
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    seenAuthHeaders,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

function sseToolCall(model: string, id: string, name: string, args: Record<string, unknown>, extraPadding = 0): string {
  const reasoning = extraPadding > 0 ? 'R'.repeat(extraPadding) : undefined;
  return [
    'data: ' + JSON.stringify({
      id: 'chatcmpl-' + id,
      model,
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: null,
      }],
    }),
    '',
    'data: ' + JSON.stringify({
      id: 'chatcmpl-' + id,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 0 } },
    }),
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
}

function sseChunkedStop(model: string, text: string, chunkCount: number, chunkPayloadLen: number): string {
  const frames: string[] = [];
  for (let i = 0; i < chunkCount; i++) {
    frames.push(
      'data: ' + JSON.stringify({
        id: 'chatcmpl-big-final',
        model,
        choices: [{ index: 0, delta: { role: i === 0 ? 'assistant' : undefined, reasoning_content: 'r'.repeat(chunkPayloadLen) }, finish_reason: null }],
      }),
      '',
    );
  }
  frames.push(
    'data: ' + JSON.stringify({
      id: 'chatcmpl-big-final',
      model,
      choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 240, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 0 } },
    }),
    '',
    'data: [DONE]',
    '',
    '',
  );
  return frames.join('\n');
}

test('HostMcpRegistry connects stdio + Streamable HTTP MCP servers, scrubs secrets, clamps bytes, and handles errors/timeouts softly', async () => {
  assert.equal(isExternalMcpToolName('mcp__github__list_commits'), true);
  assert.equal(isExternalMcpToolName('mcp__deepwiki__ask_question'), true);
  assert.equal(isExternalMcpToolName('mcp__workspace__read_file'), false);
  assert.equal(isExternalMcpToolName('mcp__workspace__denied_write'), false);

  const root = mkdtempSync(join(realpathSync(tmpdir()), 'loopwright-ext-mcp-'));
  const trustedBin = join(root, 'bin');
  const untrustedRepo = join(root, 'repo');
  mkdirSync(trustedBin, { mode: 0o755 });
  mkdirSync(untrustedRepo, { mode: 0o755 });
  writeMockStdioMcpExecutable(trustedBin, 'mock-github-mcp');
  const untrustedScript = writeMockStdioMcpExecutable(untrustedRepo, 'evil-mcp');
  const httpMcp = await startMockHttpMcpServer();

  const secretToken = 'ghp_super_secret_mcp_pat_987654321';
  const scrub = (text: string): string => text.split(secretToken).join('[REDACTED]');
  const logs: string[] = [];

  try {
    await assert.rejects(
      HostMcpRegistry.connect([{ id: 'workspace', transport: 'stdio', command: 'mock-github-mcp' }], {
        trustedPathEnv: trustedBin,
      }),
      /Invalid or reserved MCP server id/,
    );

    await assert.rejects(
      HostMcpRegistry.connect([{ id: 'evil', transport: 'stdio', command: untrustedScript, required: true }], {
        trustedPathEnv: trustedBin,
        untrustedRoots: [untrustedRepo],
      }),
      /Required MCP server "evil" failed to initialize/,
    );

    const registry = await HostMcpRegistry.connect(
      [
        {
          id: 'github',
          transport: 'stdio',
          command: 'mock-github-mcp',
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: secretToken },
          includeTools: ['list_commits', 'failing_tool', 'slow_tool'],
          timeoutMs: 10_000,
          required: true,
        },
        {
          id: 'deepwiki',
          transport: 'http',
          url: httpMcp.url,
          allowInsecureHttp: true,
          headers: { Authorization: 'Bearer dw_test_header_token' },
          timeoutMs: 5_000,
          required: true,
        },
        {
          id: 'optional-down',
          transport: 'stdio',
          command: 'nonexistent-mcp-binary',
          required: false,
        },
      ],
      {
        trustedPathEnv: trustedBin,
        untrustedRoots: [untrustedRepo],
        scrub,
        onLog: msg => logs.push(msg),
      },
    );

    try {
      assert.deepEqual(registry.toolNames, [
        'mcp__github__list_commits',
        'mcp__github__failing_tool',
        'mcp__github__slow_tool',
        'mcp__deepwiki__ask_question',
        'mcp__deepwiki__huge_doc',
      ]);
      assert.equal(registry.servers.length, 3);
      assert.equal(registry.servers[0]?.status, 'connected');
      assert.equal(registry.servers[1]?.status, 'connected');
      assert.equal(registry.servers[2]?.status, 'failed');
      assert.equal(registry.targetIdentityFor('mcp__github__list_commits'), 'mcp:github:list_commits');

      const commitsResult = await registry.callTool(
        'mcp__github__list_commits',
        { repo: 'vllm-project/vllm', sha: 'main' },
        { maxResultBytes: 65_536 },
      );
      assert.equal(commitsResult.isError, undefined);
      const commitsText = commitsResult.content[0]!.text;
      assert.match(commitsText, /vllm-project\/vllm/);
      assert.equal(commitsText.includes(secretToken), false);
      assert.match(commitsText, /\[REDACTED\]/);

      const wikiResult = await registry.callTool(
        'mcp__deepwiki__ask_question',
        { repoName: 'vllm-project/vllm', question: 'How does speculative decoding work?' },
        { maxResultBytes: 65_536 },
      );
      assert.equal(wikiResult.isError, undefined);
      assert.match(wikiResult.content[0]!.text, /DeepWiki answer for vllm-project\/vllm/);
      assert.ok(httpMcp.seenAuthHeaders.includes('Bearer dw_test_header_token'));

      const hugeResult = await registry.callTool('mcp__deepwiki__huge_doc', {}, { maxResultBytes: 16_384 });
      assert.ok(Buffer.byteLength(JSON.stringify(hugeResult)) <= 16_384);
      assert.match(hugeResult.content[0]!.text, /truncated to fit tool result byte limit/);

      const errResult = await registry.callTool(
        'mcp__github__failing_tool',
        { reason: 'secondary rate limit' },
        { maxResultBytes: 65_536 },
      );
      assert.equal(errResult.isError, true);
      assert.match(errResult.content[0]!.text, /rate limit exceeded/);

      const timeoutResult = await registry.callTool(
        'mcp__github__slow_tool',
        {},
        { maxResultBytes: 65_536, timeoutMs: 250 },
      );
      assert.equal(timeoutResult.isError, true);
      assert.match(timeoutResult.content[0]!.text, /MCP tool error \(github\/slow_tool\)/);
      assert.ok(logs.some(line => line.includes('Connected MCP server "github"')));
    } finally {
      await registry.close();
    }
  } finally {
    await httpMcp.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'openPiHostSessionAdapterV2 executes stdio + HTTP MCP tools, survives soft MCP errors + >1.5MB SSE streams + oversized bash output, and emits progress',
  { skip: !isSupportedHostSessionPlatform() },
  async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'loopwright-host-ext-mcp-'));
    const trustedBin = join(root, 'bin');
    const runtimeDir = join(root, 'runtime');
    const artifactsDir = join(root, 'artifacts');
    mkdirSync(trustedBin, { mode: 0o755 });
    mkdirSync(runtimeDir, { mode: 0o700 });
    mkdirSync(artifactsDir, { mode: 0o700 });

    writeMockStdioMcpExecutable(trustedBin, 'mock-github-mcp');
    const httpMcp = await startMockHttpMcpServer();
    const secretToken = 'ghp_live_session_secret_token_55555';
    const scrub = (text: string): string => text.split(secretToken).join('[REDACTED]');

    let modelTurn = 0;
    const capturedBodies: Record<string, unknown>[] = [];
    const providerServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      req.on('end', () => {
        capturedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
        modelTurn++;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (modelTurn === 1) {
          res.end(sseToolCall('glm-5.3', 'call-gh-1', 'mcp__github__list_commits', { repo: 'sgl-project/sglang', sha: 'HEAD' }));
          return;
        }
        if (modelTurn === 2) {
          res.end(sseToolCall('glm-5.3', 'call-dw-2', 'mcp__deepwiki__ask_question', { repoName: 'sgl-project/sglang', question: 'What changed?' }));
          return;
        }
        if (modelTurn === 3) {
          res.end(sseToolCall('glm-5.3', 'call-gh-err-3', 'mcp__github__failing_tool', { reason: '403' }));
          return;
        }
        if (modelTurn === 4) {
          res.end(sseToolCall('glm-5.3', 'call-bash-4', 'bash', {
            command: `python3 -c 'print("B" * 150000)' 2>/dev/null || head -c 150000 /dev/zero | tr '\\0' 'B'`,
          }));
          return;
        }
        // Turn 5: stream >1.5 MB of raw SSE chunks (exceeds old 1 MB responseBytes ceiling!)
        const largeSse = sseChunkedStop('glm-5.3', 'ALL_CHECKS_AND_MCP_OK', 320, 5000);
        assert.ok(Buffer.byteLength(largeSse) > 1_500_000);
        res.end(largeSse);
      });
    });

    await new Promise<void>(resolve => providerServer.listen(0, '127.0.0.1', () => resolve()));
    const providerAddr = providerServer.address();
    if (!providerAddr || typeof providerAddr === 'string') throw new Error('Expected provider TCP address');
    const providerBaseUrl = `http://127.0.0.1:${providerAddr.port}/v1`;

    let store: ReturnType<typeof stateGood<ReturnType<typeof createLocalRun> extends StateResult<infer S> ? S : never>> | null = null;
    try {
      const mcpRegistry = await HostMcpRegistry.connect(
        [
          {
            id: 'github',
            transport: 'stdio',
            command: 'mock-github-mcp',
            env: { GITHUB_PERSONAL_ACCESS_TOKEN: secretToken },
            includeTools: ['list_commits', 'failing_tool'],
            required: true,
          },
          {
            id: 'deepwiki',
            transport: 'http',
            url: httpMcp.url,
            allowInsecureHttp: true,
            required: true,
          },
        ],
        { trustedPathEnv: trustedBin, scrub },
      );

      try {
        const filesRes = await describePiAdapterFiles();
        assert.equal(filesRes.ok, true);
        if (!filesRes.ok) throw new Error('describePiAdapterFiles failed');
        const adapterFiles = filesRes.value;
        const graphDigest = digest(readFileSync(new URL('../../../../package-lock.json', import.meta.url)));

        const tools = ['read', 'bash', 'write', 'edit', ...mcpRegistry.toolNames];
        const task = contract();
        task.spec.roles[0]!.provider = 'custom-glm';
        task.spec.roles[0]!.model = 'glm-5.3';
        task.spec.roles[0]!.thinking = 'off';
        task.spec.roles[0]!.tools = tools;
        task.spec.trustedContext.revision = 'context-ext-mcp-1';
        task.spec.budgets.wallTimeMs = 60_000;
        task.spec.budgets.totalTokens = 2_000_000;
        task.spec.budgets.perCallOutputTokens = 4_096;
        task.spec.budgets.maxModelCalls = 16;

        const lock = coreGood(admitTask(task, { admissionId: 'admission-ext-mcp-1', runId: 'run-ext-mcp-1' }));
        store = stateGood(createLocalRun({
          directory: join(root, 'state'),
          storeId: 'store-ext-mcp-1',
          lock,
          policy: { version: 1, leaseMs: 10_000, cost: 'observe_only' },
          binding: {
            coreApiVersion: 'loopwright.dev/v1alpha1',
            hostVersion: 'test',
            adapters: [{ id: 'pi', version: '0.0.0' }],
            resourceVersion: 'context-ext-mcp-1',
            clockEpoch: 'host-boot-ext-mcp-1',
          },
        }));
        const view = stateGood(store.inspect());
        const claimed = stateGood(store.claim({
          ownerId: 'owner-ext-mcp-1',
          expectedGeneration: view.owner.generation,
          expectedRevision: view.revision,
          mode: 'active',
        }));

        const runtime = {
          sdkIntegrity: adapterFiles.sdkIntegrity,
          graphDigest,
          imageDigest: 'sha256:' + 'b'.repeat(64),
          configDigest: adapterFiles.restrictionDigest,
          profile: 'linux/arm64' as const,
        };

        const hostV2: PiHostV2 = {
          store,
          authority: claimed.authority,
          directory: runtimeDir,
          artifactsDirectory: artifactsDir,
          dockerExecutable: '/nonexistent/docker',
          dockerSocket: '/nonexistent/docker.sock',
          runtime,
          resolveCredential: async () => ({ bearerToken: 'host-provider-token-1234' }),
          resolveMcpCredential: async () => ({ bearerToken: 'unused-mcp-token' }),
        };

        const exampleBytes = Buffer.from('export const ok = true;\n', 'utf8');
        const exampleRef = coreGood(digestArtifactFallback(exampleBytes));

        const inputV2: PiOpenInputV2 = {
          version: 2,
          lock,
          roleId: 'builder',
          stepId: 'build',
          sessionId: 'session-ext-mcp-1',
          policy: {
            version: 2,
            policyId: 'policy-ext-mcp-1',
            resourceVersion: 'context-ext-mcp-1',
            adapterId: 'pi',
            adapterVersion: '0.0.0',
            runtime,
            selection: {
              provider: 'custom-glm',
              model: 'glm-5.3',
              thinking: 'off',
              api: 'openai-completions',
              customProvider: {
                baseUrl: providerBaseUrl,
                contextWindow: 262_144,
                maxTokens: 32_768,
                reasoning: true,
              },
            },
            resources: [adapterFiles.preamble, ...task.spec.trustedContext.resources],
            tools,
            mcp: {
              serverId: 'workspace',
              scriptDigest: adapterFiles.localMcpScriptDigest,
              names: [],
              effects: [],
              idleTimeoutSeconds: 1,
              absoluteTimeoutSeconds: 5,
            },
            context: {
              mode: 'estimated_guard',
              estimator: 'lw-pi-final-json-bytes-v1',
              proofId: null,
              version: 1,
              evidence: 'estimated',
              workingWindowCeiling: 4_194_304,
              maxRequestBytes: 4_194_304,
              serviceMargin: 32_768,
              toolReserve: 16_384,
              maxOutputTokens: 32_768,
            },
            accounting: 'soft_only',
            retry: 'sender_only',
            extensions: [],
            privateArtifacts: true,
            limits: {
              ...MAX_LIMITS,
              toolResultBytes: 98_304,
              sessionBytes: 8_388_608,
            },
          },
          candidate: {
            manifest: {
              apiVersion: 'loopwright.dev/v1alpha1',
              kind: 'ArtifactManifest',
              metadata: { id: 'candidate' },
              spec: { entries: [exampleRef] },
            },
            baseRevision: task.spec.target.baseRevision,
            sourceRevision: task.spec.target.sourceRevision,
            artifacts: [{ name: exampleRef.name, bytes: exampleBytes }],
          },
          resources: [],
          restore: null,
        };

        const progressEvents: HostSessionProgressEvent[] = [];
        const opened = await openPiHostSessionAdapterV2(hostV2, inputV2, {
          mcpRegistry,
          onProgress: ev => progressEvents.push(ev),
        });
        assert.equal(opened.ok, true, JSON.stringify(opened));
        if (!opened.ok) throw new Error('openPiHostSessionAdapterV2 failed');
        const adapter = opened.value;

        try {
          const executed = await adapter.execute({
            commandId: 'cmd-ext-mcp-1',
            text: 'Inspect GitHub and DeepWiki MCP tools, run bash, and summarize.',
            purpose: 'task',
            repair: 'none',
          });
          assert.equal(executed.ok, true, JSON.stringify(executed));
          if (!executed.ok) throw new Error('adapter.execute failed');
          assert.equal(executed.value.status, 'execution_settled', JSON.stringify(executed.value));
          assert.equal(executed.value.requestIds.length, 5);
          assert.equal(executed.value.operationIds.length, 9);

          const serializedBodies = JSON.stringify(capturedBodies);
          assert.equal(serializedBodies.includes(secretToken), false, 'secret token must be scrubbed before model context');
          assert.match(serializedBodies, /\[REDACTED\]/);
          assert.match(serializedBodies, /DeepWiki answer for sgl-project\/sglang/);
          assert.match(serializedBodies, /truncated to fit tool result byte limit/);

          assert.ok(progressEvents.some(e => e.kind === 'request_start' && e.turn === 1));
          assert.ok(progressEvents.some(e => e.kind === 'tool_start' && e.name === 'mcp__github__list_commits'));
          assert.ok(progressEvents.some(e => e.kind === 'tool_end' && e.name === 'mcp__github__failing_tool' && e.isError === true));
          assert.ok(progressEvents.some(e => e.kind === 'request_settled' && e.turn === 5));
        } finally {
          const closed = await adapter.close();
          assert.equal(closed.ok, true);
        }
      } finally {
        await mcpRegistry.close();
      }
    } finally {
      store?.close();
      await new Promise<void>(resolve => providerServer.close(() => resolve()));
      await httpMcp.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

import { digestArtifact } from '@loopwright/core';
function digestArtifactFallback(bytes: Uint8Array) {
  return digestArtifact('packages/example.ts', bytes);
}

test('pruneContextForBudget accounts for heavy MCP tool schemas (baseBytes) and Pass 4 fallback keeps outbound context within targetBytes', async () => {
  const { pruneContextForBudget } = await import('../src/sdk-worker.js');
  const tools = Array.from({ length: 30 }, (_, i) => ({
    name: `mcp__github__tool_${String(i).padStart(2, '0')}`,
    description: `GitHub MCP read-only inspection endpoint #${i}: ` + 'schema-doc-'.repeat(32),
    parameters: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login or org (' + 'd'.repeat(110) + ')' },
        repo: { type: 'string', description: 'Repository name (' + 'r'.repeat(110) + ')' },
        page: { type: 'integer', description: '1-indexed pagination cursor (' + 'p'.repeat(90) + ')' },
        perPage: { type: 'integer', description: 'Results per page (' + 'n'.repeat(90) + ')' },
      },
      required: ['owner', 'repo'],
    } as never,
  }));

  const systemPrompt = 'Trusted author preamble.\n' + 'rule-line-'.repeat(420);
  const maxBodyBytes = 63_078; // Exact 128K window budget after serviceMargin (32768) + toolReserve (16384) + maxOutputTokens (15770)
  const wireHeadroom = Math.min(9_216, Math.max(4_096, Math.floor(maxBodyBytes / 7) + tools.length * 48));
  const targetBytes = maxBodyBytes - wireHeadroom; // 53_862 bytes

  const baseBytes = Buffer.byteLength(JSON.stringify({ systemPrompt, tools, messages: [] }));
  assert.ok(baseBytes > 38_000 && baseBytes < targetBytes - 4_000, `expected ~40-48KB baseBytes, got ${baseBytes}`);

  // Case 1: 2 recent large tool results on top of ~44KB baseBytes (Pass 3 must use availableMessageBytes, not targetBytes!)
  const twoTurnContext = {
    systemPrompt,
    tools,
    messages: [
      { role: 'user' as const, content: 'Inspect 25 MCP tools and sync versions.', timestamp: 1 },
      {
        role: 'assistant' as const,
        content: [
          { type: 'thinking' as const, thinking: 't'.repeat(800) },
          { type: 'toolCall' as const, id: 'call-1', name: 'mcp__github__tool_00', arguments: { owner: 'acme', repo: 'one' } },
          { type: 'toolCall' as const, id: 'call-2', name: 'mcp__github__tool_01', arguments: { owner: 'acme', repo: 'two' } },
        ],
        api: 'openai-completions' as const,
        provider: 'custom-glm',
        model: 'glm-5.3',
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'toolUse' as const,
        timestamp: 2,
      },
      {
        role: 'toolResult' as const,
        toolCallId: 'call-1',
        toolName: 'mcp__github__tool_00',
        content: [{ type: 'text' as const, text: 'commit-payload-1:' + 'x'.repeat(24_000) }],
        isError: false,
        timestamp: 3,
      },
      {
        role: 'toolResult' as const,
        toolCallId: 'call-2',
        toolName: 'mcp__github__tool_01',
        content: [{ type: 'text' as const, text: 'commit-payload-2:' + 'y'.repeat(24_000) }],
        isError: false,
        timestamp: 4,
      },
    ],
  };

  const prunedPass3 = pruneContextForBudget(twoTurnContext, maxBodyBytes, 'openai-completions');
  const pass3Bytes = Buffer.byteLength(JSON.stringify(prunedPass3));
  assert.ok(pass3Bytes <= targetBytes, `Pass 3 output (${pass3Bytes}B) must stay <= targetBytes (${targetBytes}B)`);

  // Case 2: 20 accumulated turns including bulky write arguments + assistant reasoning traces -> Pass 4 fallback keeps context <= targetBytes
  const manyTurnMessages = [
    { role: 'user' as const, content: 'Perform multi-turn sync.', timestamp: 1 },
    ...Array.from({ length: 20 }, (_, idx) => ([
      {
        role: 'assistant' as const,
        content: [
          { type: 'thinking' as const, thinking: 'reasoning-step-'.repeat(60) },
          { type: 'text' as const, text: 'Progress narrative '.repeat(30) },
          {
            type: 'toolCall' as const,
            id: `call-m-${idx}`,
            name: idx === 4 ? 'write' : `mcp__github__tool_0${idx % 5}`,
            arguments: idx === 4
              ? { path: 'proposal.json', content: '{"big": "' + 'z'.repeat(18_000) + '"}' }
              : { owner: 'acme', repo: `repo-${idx}` },
          },
        ],
        api: 'openai-completions' as const,
        provider: 'custom-glm',
        model: 'glm-5.3',
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'toolUse' as const,
        timestamp: idx * 2 + 2,
      },
      {
        role: 'toolResult' as const,
        toolCallId: `call-m-${idx}`,
        toolName: idx === 4 ? 'write' : `mcp__github__tool_0${idx % 5}`,
        content: [{ type: 'text' as const, text: `result-${idx}:` + 'w'.repeat(12_000) }],
        isError: false,
        timestamp: idx * 2 + 3,
      },
    ])).flat(),
  ];

  const manyTurnContext = { systemPrompt, tools, messages: manyTurnMessages };
  const prunedPass4 = pruneContextForBudget(manyTurnContext, maxBodyBytes, 'openai-completions');
  const pass4Bytes = Buffer.byteLength(JSON.stringify(prunedPass4));
  assert.ok(pass4Bytes <= targetBytes, `Pass 4 output (${pass4Bytes}B) must stay <= targetBytes (${targetBytes}B)`);
  // Original context messages remain untouched
  const origWriteTurn = manyTurnContext.messages[9];
  assert.equal(
    origWriteTurn?.role === 'assistant'
      && origWriteTurn.content[2]?.type === 'toolCall'
      && String((origWriteTurn.content[2].arguments as Record<string, unknown>)['content']).length > 18_000,
    true,
  );
});
