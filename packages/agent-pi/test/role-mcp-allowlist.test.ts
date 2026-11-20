import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { admitTask, digestArtifact, type Result } from '@loopwright/core';
import { createLocalRun, type StateResult } from '@loopwright/state';
import { contract } from '../../core/test/fixtures.js';
import { digest } from '../src/boundary.js';
import { describePiAdapterFiles } from '../src/descriptor.js';
import { PiFailure } from '../src/errors.js';
import { Execution } from '../src/execution.js';
import {
  HostMcpRegistry,
  createRoleMcpAllowlist,
  createRoleScopedMcpExecutor,
  parseExternalMcpServerId,
  validateAllowedMcpServers,
} from '../src/external-mcp.js';
import {
  isSupportedHostSessionPlatform,
  openPiHostSessionAdapterV2,
} from '../src/host-session.js';
import { MAX_LIMITS } from '../src/policy.js';
import type { PiHostV2, PiOpenInputV2 } from '../src/types-v2.js';
import { requestFixture } from './request-fixtures.js';

function coreGood<T>(value: Result<T>): T {
  assert.equal(value.ok, true, JSON.stringify(value));
  if (!value.ok) throw new Error('core fixture failed');
  return value.value;
}

function stateGood<T>(value: StateResult<T>): T {
  assert.equal(value.ok, true, JSON.stringify(value));
  if (!value.ok) throw new Error('state fixture failed');
  return value.value;
}

async function startMockHttpMcpServer(serverName: string, toolNames: string | readonly string[]) {
  const names = typeof toolNames === 'string' ? [toolNames] : toolNames;
  let toolCalls = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        id?: string | number;
        method?: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      if (payload.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      if (payload.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: serverName, version: '1.0.0' },
          },
        }));
        return;
      }
      if (payload.method === 'tools/list') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            tools: names.map(toolName => ({
              name: toolName,
              description: `Mock tool ${toolName} on ${serverName}`,
              inputSchema: {
                type: 'object',
                properties: { msg: { type: 'string' } },
              },
            })),
          },
        }));
        return;
      }
      if (payload.method === 'tools/call') {
        toolCalls++;
        const calledTool = payload.params?.name ?? names[0] ?? 'unknown';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            content: [{ type: 'text', text: `${serverName}:${calledTool}:${String(payload.params?.arguments?.msg ?? '')}` }],
          },
        }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, error: { code: -32601, message: 'Method not found' } }));
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Expected TCP address');
  return {
    url: `http://127.0.0.1:${addr.port}/mcp`,
    toolCalls: () => toolCalls,
    resetCalls: () => { toolCalls = 0; },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

function sseToolCall(model: string, callId: string, toolName: string, args: Record<string, unknown>): string {
  const chunk1 = {
    id: `chatcmpl-${callId}`,
    object: 'chat.completion.chunk',
    created: 1700000000,
    model,
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }],
      },
      finish_reason: null,
    }],
  };
  const chunk2 = {
    id: `chatcmpl-${callId}`,
    object: 'chat.completion.chunk',
    created: 1700000000,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
  return `data: ${JSON.stringify(chunk1)}\n\ndata: ${JSON.stringify(chunk2)}\n\ndata: [DONE]\n\n`;
}

function sseStop(model: string, text: string): string {
  const chunk1 = {
    id: 'chatcmpl-stop',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model,
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
  };
  const chunk2 = {
    id: 'chatcmpl-stop',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  };
  return `data: ${JSON.stringify(chunk1)}\n\ndata: ${JSON.stringify(chunk2)}\n\ndata: [DONE]\n\n`;
}

test('createRoleScopedMcpExecutor and Execution independently block crafted cross-role MCP calls before mcpRegistry.callTool is ever invoked', async () => {
  assert.equal(parseExternalMcpServerId('mcp__srva__ping'), 'srva');
  assert.equal(parseExternalMcpServerId('mcp__workspace__read_file'), null);
  assert.equal(parseExternalMcpServerId('read'), null);

  let upstreamCallCount = 0;
  const fakeRegistry = {
    hasTool: (name: string) => name === 'mcp__srva__ping' || name === 'mcp__srvb__pong',
    targetIdentityFor: (name: string) =>
      name === 'mcp__srva__ping' ? 'mcp:srva:ping' : name === 'mcp__srvb__pong' ? 'mcp:srvb:pong' : null,
    callTool: async (name: string) => {
      upstreamCallCount++;
      return { content: [{ type: 'text' as const, text: `called:${name}` }], details: null };
    },
  };

  // Role B with empty allowedServers: [] must block mcp__srva__ping even if policyTools lists it
  const roleBGuard = createRoleScopedMcpExecutor(fakeRegistry, {
    roleTools: ['read', 'mcp__srva__ping'],
    policyTools: ['read', 'mcp__srva__ping'],
    allowedServers: [],
  });
  assert.equal(roleBGuard.hasTool('mcp__srva__ping'), false);
  assert.equal(roleBGuard.targetIdentityFor('mcp__srva__ping'), null);
  await assert.rejects(
    roleBGuard.callTool('mcp__srva__ping', { msg: 'crafted' }, { maxResultBytes: 4096 }),
    err => err instanceof PiFailure && err.detail.code === 'TOOL_DENIED',
  );
  assert.equal(upstreamCallCount, 0, 'mcpRegistry.callTool must never be called for denied server');

  // Role C allowed only srvb must allow mcp__srvb__pong and block mcp__srva__ping before callTool
  const roleCGuard = createRoleScopedMcpExecutor(fakeRegistry, {
    roleTools: ['read', 'mcp__srva__ping', 'mcp__srvb__pong'],
    policyTools: ['read', 'mcp__srva__ping', 'mcp__srvb__pong'],
    allowedServers: ['srvb'],
  });
  assert.equal(roleCGuard.hasTool('mcp__srva__ping'), false);
  assert.equal(roleCGuard.hasTool('mcp__srvb__pong'), true);
  await assert.rejects(
    roleCGuard.callTool('mcp__srva__ping', { msg: 'crafted' }, { maxResultBytes: 4096 }),
    err => err instanceof PiFailure && err.detail.code === 'TOOL_DENIED',
  );
  assert.equal(upstreamCallCount, 0);

  const okRes = await roleCGuard.callTool('mcp__srvb__pong', { msg: 'ok' }, { maxResultBytes: 4096 });
  assert.equal(okRes.content[0]?.text, 'called:mcp__srvb__pong');
  assert.equal(upstreamCallCount, 1);

  // Verify Execution.invoke also refuses crafted mcp__srva__ping before calling mcpRegistry.callTool
  const fx = await requestFixture();
  try {
    const candidateDir = join(fx.directory, 'candidate');
    mkdirSync(candidateDir, { recursive: true });
    const execInput = {
      ...fx.input,
      policy: {
        ...fx.input.policy,
        tools: ['read', 'mcp__srva__ping'],
      },
    };
    const execution = new Execution(fx.host, execInput, candidateDir, {
      process: () => { throw new Error('local process should not run'); },
      mcpExecutor: roleBGuard,
    });
    const beforeCalls = upstreamCallCount;
    await assert.rejects(
      async () => execution.invoke(
        { invocation: 1, slot: 'slot-1', callId: 'call-crafted', name: 'mcp__srva__ping', parentId: null, parentRequestId: 'req-1' },
        Buffer.from('{"msg":"crafted"}'),
        new AbortController().signal,
        () => {},
      ),
      err => err instanceof PiFailure && err.detail.code === 'TOOL_DENIED',
    );
    assert.equal(upstreamCallCount, beforeCalls, 'Execution must block unauthorized MCP call before callTool');

    // Malformed allowedMcpServers option fails closed with INPUT_INVALID
    const invalidOpen = await openPiHostSessionAdapterV2(
      { ...fx.host, resolveMcpCredential: async () => ({ bearerToken: 'unused' }) },
      { ...fx.input, version: 2, policy: { ...fx.input.policy, version: 2 } } as unknown as PiOpenInputV2,
      { allowedMcpServers: ['workspace'] },
    );
    assert.equal(invalidOpen.ok, false);
    if (!invalidOpen.ok) {
      assert.equal(invalidOpen.error.code, 'INPUT_INVALID');
    }
  } finally {
    await fx.cleanup();
  }
});

test('parseExternalMcpServerId, validateAllowedMcpServers, and HostMcpRegistry disambiguate double-underscore tools and reject invalid/Proxy inputs', async () => {
  // Double-underscore upstream tool names resolve unambiguously to the server ID before the first __
  assert.equal(parseExternalMcpServerId('mcp__srva__sub__ping'), 'srva');
  assert.equal(parseExternalMcpServerId('mcp__srva__very_long_module_prefix__ping'), 'srva');
  assert.equal(parseExternalMcpServerId('mcp__my_srv-1__a__b__c'), 'my_srv-1');
  assert.equal(parseExternalMcpServerId('mcp__srv__a__ping'), 'srv');
  assert.equal(parseExternalMcpServerId('mcp__srv___ping'), 'srv');
  assert.equal(parseExternalMcpServerId('mcp__srv__'), null);
  assert.equal(parseExternalMcpServerId('mcp__bad--id__ping'), null);

  const allowlist = createRoleMcpAllowlist({
    roleTools: ['read', 'mcp__srva__sub__ping', 'mcp__srva__very_long_module_prefix__ping'],
    policyTools: ['read', 'mcp__srva__sub__ping', 'mcp__srva__very_long_module_prefix__ping'],
    allowedServers: ['srva'],
  });
  assert.equal(allowlist.isToolAllowed('mcp__srva__sub__ping', 'srva'), true);
  assert.equal(allowlist.isToolAllowed('mcp__srva__very_long_module_prefix__ping', 'srva'), true);
  assert.equal(allowlist.isToolAllowed('mcp__srva__sub__ping', 'srvb'), false);

  // Server IDs containing __ or invalid characters are rejected in validateAllowedMcpServers and HostMcpRegistry.connect
  for (const bad of [['srv__a'], ['srv_'], ['BAD ID'], ['a/b'], ['workspace'], ['']]) {
    assert.throws(
      () => validateAllowedMcpServers(bad),
      err => err instanceof PiFailure && err.detail.code === 'INPUT_INVALID',
    );
  }

  // Proxy arrays and getter-backed array elements are rejected without running traps
  const proxyServers = new Proxy(['srva'], {});
  assert.throws(
    () => validateAllowedMcpServers(proxyServers),
    err => err instanceof PiFailure && err.detail.code === 'INPUT_INVALID',
  );
  let getterRan = false;
  const getterArray: string[] = [];
  Object.defineProperty(getterArray, '0', {
    enumerable: true,
    get() {
      getterRan = true;
      return 'srva';
    },
  });
  getterArray.length = 1;
  assert.throws(
    () => validateAllowedMcpServers(getterArray),
    err => err instanceof PiFailure && err.detail.code === 'INPUT_INVALID',
  );
  assert.equal(getterRan, false);

  await assert.rejects(
    HostMcpRegistry.connect([
      { id: 'srv__a', transport: 'http', url: 'http://127.0.0.1:9/mcp', allowInsecureHttp: true, required: true },
    ]),
    /Invalid or reserved MCP server id/,
  );
});

test(
  'openPiHostSessionAdapterV2 handles double-underscore upstream tools and enforces allowedMcpServers during restore-start',
  { skip: !isSupportedHostSessionPlatform() },
  async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'loopwright-role-mcp-restore-'));
    const srvA = await startMockHttpMcpServer('srva', ['ping', 'sub__ping']);
    const mcpRegistry = await HostMcpRegistry.connect([
      { id: 'srva', transport: 'http', url: srvA.url, allowInsecureHttp: true, required: true },
    ]);
    assert.equal(mcpRegistry.hasTool('mcp__srva__sub__ping'), true);

    const filesRes = await describePiAdapterFiles();
    assert.equal(filesRes.ok, true);
    if (!filesRes.ok) throw new Error('describePiAdapterFiles failed');
    const adapterFiles = filesRes.value;
    const graphDigest = digest(readFileSync(new URL('../../../../package-lock.json', import.meta.url)));

    let turn = 0;
    const providerServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      req.on('end', () => {
        turn++;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (turn === 1) {
          res.end(sseToolCall('glm-5.3', 'call-sub-1', 'mcp__srva__sub__ping', { msg: 'nested' }));
          return;
        }
        res.end(sseStop('glm-5.3', 'DONE'));
      });
    });

    await new Promise<void>(resolve => providerServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = providerServer.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected TCP address');
    const providerBaseUrl = `http://127.0.0.1:${addr.port}/v1`;

    const runtimeDir1 = join(root, 'runtime-1');
    const runtimeDir2 = join(root, 'runtime-2');
    const runtimeDir3 = join(root, 'runtime-3');
    const artifactsDir = join(root, 'artifacts');
    mkdirSync(runtimeDir1, { recursive: true, mode: 0o700 });
    mkdirSync(runtimeDir2, { recursive: true, mode: 0o700 });
    mkdirSync(runtimeDir3, { recursive: true, mode: 0o700 });
    mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });

    const tools = ['read', 'mcp__srva__ping', 'mcp__srva__sub__ping'];
    const task = contract();
    task.spec.roles[0]!.provider = 'custom-glm';
    task.spec.roles[0]!.model = 'glm-5.3';
    task.spec.roles[0]!.thinking = 'off';
    task.spec.roles[0]!.tools = tools;
    task.spec.trustedContext.revision = 'ctx-restore-mcp';
    task.spec.budgets.wallTimeMs = 60_000;
    task.spec.budgets.totalTokens = 2_000_000;
    task.spec.budgets.perCallOutputTokens = 4_096;
    task.spec.budgets.maxModelCalls = 8;

    const lock = coreGood(admitTask(task, { admissionId: 'adm-restore-mcp', runId: 'run-restore-mcp' }));
    const store = stateGood(createLocalRun({
      directory: join(root, 'state'),
      storeId: 'store-restore-mcp',
      lock,
      policy: { version: 1, leaseMs: 10_000, cost: 'observe_only' },
      binding: {
        coreApiVersion: 'loopwright.dev/v1alpha1',
        hostVersion: 'test',
        adapters: [{ id: 'pi', version: '0.0.0' }],
        resourceVersion: 'ctx-restore-mcp',
        clockEpoch: 'boot-restore-mcp',
      },
    }));

    try {
      const view = stateGood(store.inspect());
      const claimed = stateGood(store.claim({
        ownerId: 'owner-restore-mcp',
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
      const exampleBytes = Buffer.from('export const ok = true;\n', 'utf8');
      const exampleRef = coreGood(digestArtifact('packages/example.ts', exampleBytes));
      const makeHost = (dir: string): PiHostV2 => ({
        store,
        authority: claimed.authority,
        directory: dir,
        artifactsDirectory: artifactsDir,
        dockerExecutable: '/nonexistent/docker',
        dockerSocket: '/nonexistent/docker.sock',
        runtime,
        resolveCredential: async () => ({ bearerToken: 'host-provider-token-restore' }),
        resolveMcpCredential: async () => ({ bearerToken: 'unused-mcp-token' }),
      });
      const baseInput: PiOpenInputV2 = {
        version: 2,
        lock,
        roleId: 'builder',
        stepId: 'build',
        sessionId: 'session-restore-mcp',
        policy: {
          version: 2,
          policyId: 'policy-restore-mcp',
          resourceVersion: 'ctx-restore-mcp',
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
          resources: [adapterFiles.preamble],
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
          limits: MAX_LIMITS,
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

      // 1. Execute mcp__srva__sub__ping with allowedMcpServers: ['srva'] and capture checkpoint
      const opened1 = await openPiHostSessionAdapterV2(makeHost(runtimeDir1), baseInput, {
        mcpRegistry,
        allowedMcpServers: ['srva'],
      });
      assert.equal(opened1.ok, true, JSON.stringify(opened1));
      if (!opened1.ok) throw new Error('opened1 failed');
      let captureRef;
      try {
        const exec = await opened1.value.execute({
          commandId: 'cmd-sub-1',
          text: 'Call sub__ping.',
          purpose: 'task',
          repair: 'none',
        });
        assert.equal(exec.ok, true, JSON.stringify(exec));
        if (exec.ok) assert.equal(exec.value.status, 'execution_settled');
        assert.equal(srvA.toolCalls(), 1);
        const cap = await opened1.value.capture({ checkpointId: 'cp-sub-1' });
        assert.equal(cap.ok, true, JSON.stringify(cap));
        if (!cap.ok) throw new Error('capture failed');
        captureRef = cap.value;
      } finally {
        await opened1.value.close();
      }

      const restoreInput: PiOpenInputV2 = {
        ...baseInput,
        candidate: { ...baseInput.candidate, manifest: captureRef.candidate },
        restore: {
          checkpointId: 'cp-sub-1',
          workspace: { ref: captureRef.workspace, bytes: readFileSync(join(artifactsDir, captureRef.workspace.name)) },
          session: { ref: captureRef.session, bytes: readFileSync(join(artifactsDir, captureRef.session.name)) },
        },
      };

      // 2. Restoring the transcript containing mcp__srva__sub__ping under allowedMcpServers: [] must fail closed during restore-start
      const deniedRestore = await openPiHostSessionAdapterV2(makeHost(runtimeDir2), restoreInput, {
        mcpRegistry,
        allowedMcpServers: [],
      });
      if (deniedRestore.ok) await deniedRestore.value.close();
      assert.equal(deniedRestore.ok, false, 'restore-start must refuse transcript toolCall outside allowedMcpServers');

      // 3. Restoring the same checkpoint with allowedMcpServers: ['srva'] succeeds cleanly
      const allowedRestore = await openPiHostSessionAdapterV2(makeHost(runtimeDir3), restoreInput, {
        mcpRegistry,
        allowedMcpServers: ['srva'],
      });
      assert.equal(allowedRestore.ok, true, JSON.stringify(allowedRestore));
      if (allowedRestore.ok) await allowedRestore.value.close();
    } finally {
      store.close();
      await new Promise<void>(resolve => providerServer.close(() => resolve()));
      await mcpRegistry.close();
      await srvA.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'openPiHostSessionAdapterV2 enforces per-role MCP tool exposure and execution guard across Role A (srva), read-only Role B ([]), Role C (srvb), and default role.tools',
  { skip: !isSupportedHostSessionPlatform() },
  async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'loopwright-role-mcp-'));
    const srvA = await startMockHttpMcpServer('srva', 'ping');
    const srvB = await startMockHttpMcpServer('srvb', 'pong');
    const mcpRegistry = await HostMcpRegistry.connect([
      { id: 'srva', transport: 'http', url: srvA.url, allowInsecureHttp: true, required: true },
      { id: 'srvb', transport: 'http', url: srvB.url, allowInsecureHttp: true, required: true },
    ]);

    let registryCallToolCount = 0;
    const origCallTool = mcpRegistry.callTool.bind(mcpRegistry);
    (mcpRegistry as unknown as { callTool: typeof mcpRegistry.callTool }).callTool = async (name, args, options) => {
      registryCallToolCount++;
      return origCallTool(name, args, options);
    };

    const filesRes = await describePiAdapterFiles();
    assert.equal(filesRes.ok, true);
    if (!filesRes.ok) throw new Error('describePiAdapterFiles failed');
    const adapterFiles = filesRes.value;
    const graphDigest = digest(readFileSync(new URL('../../../../package-lock.json', import.meta.url)));

    const runRoleSession = async (cfg: {
      readonly suffix: string;
      readonly roleTools: readonly string[];
      readonly policyTools: readonly string[];
      readonly allowedMcpServers?: readonly string[] | undefined;
      readonly turn1ToolCall: { readonly name: string; readonly args: Record<string, unknown> };
    }) => {
      const subRoot = join(root, cfg.suffix);
      const runtimeDir = join(subRoot, 'runtime');
      const artifactsDir = join(subRoot, 'artifacts');
      mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
      mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });

      let turn = 0;
      const capturedToolNamesPerTurn: string[][] = [];
      const providerServer = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { tools?: { function?: { name?: string } }[] };
          const exposed = (body.tools ?? []).map(item => item.function?.name ?? '').filter(Boolean);
          capturedToolNamesPerTurn.push(exposed);
          turn++;
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          if (turn === 1) {
            res.end(sseToolCall('glm-5.3', `call-${cfg.suffix}-1`, cfg.turn1ToolCall.name, cfg.turn1ToolCall.args));
            return;
          }
          res.end(sseStop('glm-5.3', 'DONE'));
        });
      });

      await new Promise<void>(resolve => providerServer.listen(0, '127.0.0.1', () => resolve()));
      const addr = providerServer.address();
      if (!addr || typeof addr === 'string') throw new Error('Expected TCP address');
      const providerBaseUrl = `http://127.0.0.1:${addr.port}/v1`;

      const task = contract();
      task.spec.roles[0]!.provider = 'custom-glm';
      task.spec.roles[0]!.model = 'glm-5.3';
      task.spec.roles[0]!.thinking = 'off';
      task.spec.roles[0]!.tools = [...cfg.roleTools];
      task.spec.trustedContext.revision = `ctx-${cfg.suffix}`;
      task.spec.budgets.wallTimeMs = 60_000;
      task.spec.budgets.totalTokens = 2_000_000;
      task.spec.budgets.perCallOutputTokens = 4_096;
      task.spec.budgets.maxModelCalls = 8;

      const lock = coreGood(admitTask(task, { admissionId: `adm-${cfg.suffix}`, runId: `run-${cfg.suffix}` }));
      const store = stateGood(createLocalRun({
        directory: join(subRoot, 'state'),
        storeId: `store-${cfg.suffix}`,
        lock,
        policy: { version: 1, leaseMs: 10_000, cost: 'observe_only' },
        binding: {
          coreApiVersion: 'loopwright.dev/v1alpha1',
          hostVersion: 'test',
          adapters: [{ id: 'pi', version: '0.0.0' }],
          resourceVersion: `ctx-${cfg.suffix}`,
          clockEpoch: `boot-${cfg.suffix}`,
        },
      }));

      try {
        const view = stateGood(store.inspect());
        const claimed = stateGood(store.claim({
          ownerId: `owner-${cfg.suffix}`,
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
          resolveCredential: async () => ({ bearerToken: 'host-provider-token-9999' }),
          resolveMcpCredential: async () => ({ bearerToken: 'unused-mcp-token' }),
        };

        const exampleBytes = Buffer.from('export const ok = true;\n', 'utf8');
        const exampleRef = coreGood(digestArtifact('packages/example.ts', exampleBytes));
        const inputV2: PiOpenInputV2 = {
          version: 2,
          lock,
          roleId: 'builder',
          stepId: 'build',
          sessionId: `session-${cfg.suffix}`,
          policy: {
            version: 2,
            policyId: `policy-${cfg.suffix}`,
            resourceVersion: `ctx-${cfg.suffix}`,
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
            resources: [adapterFiles.preamble],
            tools: [...cfg.policyTools],
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
            limits: MAX_LIMITS,
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

        const opened = await openPiHostSessionAdapterV2(hostV2, inputV2, {
          mcpRegistry,
          ...(cfg.allowedMcpServers !== undefined ? { allowedMcpServers: cfg.allowedMcpServers } : {}),
        });
        assert.equal(opened.ok, true, JSON.stringify(opened));
        if (!opened.ok) throw new Error('openPiHostSessionAdapterV2 failed');
        const adapter = opened.value;
        try {
          const outcome = await adapter.execute({
            commandId: `cmd-${cfg.suffix}`,
            text: 'Run tool check.',
            purpose: 'task',
            repair: 'none',
          });
          return { outcome, exposedTools: capturedToolNamesPerTurn[0] ?? [] };
        } finally {
          await adapter.close();
        }
      } finally {
        store.close();
        await new Promise<void>(resolve => providerServer.close(() => resolve()));
      }
    };

    try {
      // 1. Role A allowed only ['srva']: exposes mcp__srva__ping, hides mcp__srvb__pong, executes mcp__srva__ping.
      srvA.resetCalls();
      srvB.resetCalls();
      registryCallToolCount = 0;
      const roleA = await runRoleSession({
        suffix: 'role-a',
        roleTools: ['read', 'mcp__srva__ping', 'mcp__srvb__pong'],
        policyTools: ['read', 'mcp__srva__ping', 'mcp__srvb__pong'],
        allowedMcpServers: ['srva'],
        turn1ToolCall: { name: 'mcp__srva__ping', args: { msg: 'from-a' } },
      });
      assert.equal(roleA.outcome.ok, true);
      if (roleA.outcome.ok) assert.equal(roleA.outcome.value.status, 'execution_settled');
      assert.equal(roleA.exposedTools.includes('mcp__srva__ping'), true);
      assert.equal(roleA.exposedTools.includes('mcp__srvb__pong'), false);
      assert.equal(srvA.toolCalls(), 1);
      assert.equal(srvB.toolCalls(), 0);
      assert.equal(registryCallToolCount, 1);

      // 2. Read-only Role B with allowedMcpServers: []: exposes ZERO external MCP tools and crafted call to mcp__srva__ping NEVER invokes mcpRegistry.callTool.
      srvA.resetCalls();
      srvB.resetCalls();
      registryCallToolCount = 0;
      const roleB = await runRoleSession({
        suffix: 'role-b',
        roleTools: ['read', 'mcp__srva__ping'],
        policyTools: ['read', 'mcp__srva__ping'],
        allowedMcpServers: [],
        turn1ToolCall: { name: 'mcp__srva__ping', args: { msg: 'crafted-from-b' } },
      });
      assert.equal(roleB.exposedTools.some(name => name.startsWith('mcp__')), false);
      assert.equal(srvA.toolCalls(), 0, 'srva server must never receive a crafted call from Role B');
      assert.equal(registryCallToolCount, 0, 'mcpRegistry.callTool must never be invoked for Role B');

      // 3. Role C with allowedMcpServers: ['srvb']: exposes mcp__srvb__pong, hides mcp__srva__ping, crafted call to mcp__srva__ping NEVER invokes mcpRegistry.callTool.
      srvA.resetCalls();
      srvB.resetCalls();
      registryCallToolCount = 0;
      const roleC = await runRoleSession({
        suffix: 'role-c',
        roleTools: ['read', 'mcp__srva__ping', 'mcp__srvb__pong'],
        policyTools: ['read', 'mcp__srva__ping', 'mcp__srvb__pong'],
        allowedMcpServers: ['srvb'],
        turn1ToolCall: { name: 'mcp__srva__ping', args: { msg: 'crafted-from-c' } },
      });
      assert.equal(roleC.exposedTools.includes('mcp__srvb__pong'), true);
      assert.equal(roleC.exposedTools.includes('mcp__srva__ping'), false);
      assert.equal(srvA.toolCalls(), 0);
      assert.equal(registryCallToolCount, 0);

      // 4. Backwards compatibility (no allowedMcpServers override): respects role.tools from TaskContract.
      srvA.resetCalls();
      srvB.resetCalls();
      registryCallToolCount = 0;
      const roleDefault = await runRoleSession({
        suffix: 'role-default',
        roleTools: ['read', 'mcp__srva__ping'],
        policyTools: ['read', 'mcp__srva__ping'],
        turn1ToolCall: { name: 'mcp__srva__ping', args: { msg: 'default' } },
      });
      assert.equal(roleDefault.outcome.ok, true);
      if (roleDefault.outcome.ok) assert.equal(roleDefault.outcome.value.status, 'execution_settled');
      assert.equal(roleDefault.exposedTools.includes('mcp__srva__ping'), true);
      assert.equal(roleDefault.exposedTools.includes('mcp__srvb__pong'), false);
      assert.equal(srvA.toolCalls(), 1);
    } finally {
      await mcpRegistry.close();
      await srvA.close();
      await srvB.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('createRoleScopedMcpExecutor fails closed when targetIdentityFor is null, malformed, or mismatched', async () => {
  let upstreamCalls = 0;
  const flakyRegistry = {
    hasTool: (name: string) => name.startsWith('mcp__srva__'),
    targetIdentityFor: (name: string) => {
      if (name === 'mcp__srva__null_identity') return null;
      if (name === 'mcp__srva__malformed_identity') return 'not-an-mcp-identity';
      if (name === 'mcp__srva__mismatched_identity') return 'mcp:other:ping';
      return 'mcp:srva:ok';
    },
    callTool: async (name: string) => {
      upstreamCalls += 1;
      return { content: [{ type: 'text' as const, text: name }], details: null };
    },
  };
  const scoped = createRoleScopedMcpExecutor(flakyRegistry, {
    roleTools: [
      'mcp__srva__null_identity',
      'mcp__srva__malformed_identity',
      'mcp__srva__mismatched_identity',
      'mcp__srva__ok',
    ],
    policyTools: [
      'mcp__srva__null_identity',
      'mcp__srva__malformed_identity',
      'mcp__srva__mismatched_identity',
      'mcp__srva__ok',
    ],
    allowedServers: ['srva'],
  });
  for (const bad of ['mcp__srva__null_identity', 'mcp__srva__malformed_identity', 'mcp__srva__mismatched_identity']) {
    assert.equal(scoped.hasTool(bad), false, `${bad} must fail closed`);
    assert.equal(scoped.targetIdentityFor(bad), null, `${bad} targetIdentityFor must fail closed`);
    await assert.rejects(
      scoped.callTool(bad, {}, { maxResultBytes: 1024 }),
      err => err instanceof PiFailure && err.detail.code === 'TOOL_DENIED',
    );
  }
  assert.equal(upstreamCalls, 0);
  assert.equal(scoped.hasTool('mcp__srva__ok'), true);
  assert.equal(scoped.targetIdentityFor('mcp__srva__ok'), 'mcp:srva:ok');
  const res = await scoped.callTool('mcp__srva__ok', {}, { maxResultBytes: 1024 });
  assert.equal(res.content[0]?.text, 'mcp__srva__ok');
  assert.equal(upstreamCalls, 1);
});
