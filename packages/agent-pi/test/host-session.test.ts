import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { admitTask, digestArtifact, type Result } from '@loopwright/core';
import { createLocalRun, type StateResult } from '@loopwright/state';
import { contract } from '../../core/test/fixtures.js';
import { canonical, digest } from '../src/boundary.js';
import { describePiAdapterFiles } from '../src/descriptor.js';
import {
  isSupportedHostSessionPlatform,
  openPiHostSessionAdapter,
  openPiHostSessionAdapterV2,
  type HostSessionProgressEvent,
} from '../src/host-session.js';
import { MAX_LIMITS } from '../src/policy.js';
import type { PiHostV2, PiOpenInputV2 } from '../src/types-v2.js';
import type { PiHost, PiOpenInput } from '../src/types.js';

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

function sseToolCall(model: string, id: string, name: string, args: Record<string, unknown>): string {
  return [
    'data: ' + JSON.stringify({
      id: 'chatcmpl-' + id,
      model,
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
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
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 20 } },
    }),
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
}

function sseStop(model: string, text: string): string {
  return [
    'data: ' + JSON.stringify({
      id: 'chatcmpl-final',
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 20 } },
    }),
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
}

import { decodePiCapture } from '../src/decode-capture.js';
import { gitBlobOid } from '../src/candidate.js';
import { validatePolicy } from '../src/policy.js';
import { PiFailure } from '../src/errors.js';

async function createHostSessionFixture(options: {
  readonly baseUrl: string;
  readonly tools?: readonly string[];
  readonly mcpNames?: readonly 'mcp__workspace__read_file'[];
  readonly candidate?: PiOpenInput['candidate'];
}) {
  const filesRes = await describePiAdapterFiles();
  assert.equal(filesRes.ok, true);
  if (!filesRes.ok) throw new Error('describePiAdapterFiles failed');
  const adapterFiles = filesRes.value;
  const graphDigest = digest(readFileSync(new URL('../../../../package-lock.json', import.meta.url)));

  const tools = [...(options.tools ?? ['read', 'bash', 'write', 'edit'])];
  const mcpNames = [...(options.mcpNames ?? [])];

  const task = contract();
  task.spec.roles[0]!.provider = 'custom-glm';
  task.spec.roles[0]!.model = 'glm-5.3';
  task.spec.roles[0]!.thinking = 'off';
  task.spec.roles[0]!.tools = tools;
  task.spec.trustedContext.revision = 'context-host-1';
  task.spec.budgets.wallTimeMs = 60000;
  task.spec.budgets.totalTokens = 1000000;
  task.spec.budgets.perCallOutputTokens = 512;
  task.spec.budgets.maxModelCalls = 16;

  const lock = coreGood(admitTask(task, { admissionId: 'admission-host-1', runId: 'run-host-1' }));
  const exampleBytes = Buffer.from('export const value = 1;\n', 'utf8');

  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'loopwright-host-session-'));
  const runtimeDir = join(directory, 'runtime');
  const artifactsDir = join(directory, 'artifacts');
  mkdirSync(runtimeDir, { mode: 0o700 });
  mkdirSync(artifactsDir, { mode: 0o700 });

  const store = stateGood(createLocalRun({
    directory: join(directory, 'state'),
    storeId: 'store-host-1',
    lock,
    policy: { version: 1, leaseMs: 10000, cost: 'observe_only' },
    binding: {
      coreApiVersion: 'loopwright.dev/v1alpha1',
      hostVersion: 'test',
      adapters: [{ id: 'pi', version: '0.0.0' }],
      resourceVersion: 'context-host-1',
      clockEpoch: 'host-boot-1',
    },
  }));
  const view = stateGood(store.inspect());
  const claimed = stateGood(store.claim({
    ownerId: 'owner-host-1',
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

  const hostV1: PiHost = {
    store,
    authority: claimed.authority,
    directory: runtimeDir,
    artifactsDirectory: artifactsDir,
    dockerExecutable: '/nonexistent/docker',
    dockerSocket: '/nonexistent/docker.sock',
    runtime,
    resolveCredential: async () => ({ bearerToken: 'host-session-bearer-token-1234' }),
  };

  const hostV2: PiHostV2 = {
    ...hostV1,
    resolveMcpCredential: async () => ({ bearerToken: 'unused-mcp-bearer-token-1234' }),
  };

  const inputV1: PiOpenInput = {
    version: 1,
    lock,
    roleId: 'builder',
    stepId: 'build',
    sessionId: 'session-host-1',
    policy: {
      version: 1,
      policyId: 'policy-host-1',
      resourceVersion: 'context-host-1',
      adapterId: 'pi',
      adapterVersion: '0.0.0',
      runtime,
      selection: {
        provider: 'custom-glm',
        model: 'glm-5.3',
        thinking: 'off',
        api: 'openai-completions',
        customProvider: {
          baseUrl: options.baseUrl,
          contextWindow: 128000,
          maxTokens: 4096,
          reasoning: false,
          cost: { input: 2, output: 10, cacheRead: 0.5 },
        },
      },
      resources: [adapterFiles.preamble],
      tools,
      mcp: {
        serverId: 'workspace',
        scriptDigest: adapterFiles.localMcpScriptDigest,
        names: mcpNames,
        effects: mcpNames.map(() => 'read_only' as const),
        idleTimeoutSeconds: 2,
        absoluteTimeoutSeconds: 10,
      },
      context: {
        mode: 'estimated_guard',
        estimator: 'lw-pi-final-json-bytes-v1',
        proofId: null,
        version: 1,
        evidence: 'estimated',
        workingWindowCeiling: 98304,
        maxRequestBytes: 65536,
        serviceMargin: 32768,
        toolReserve: 16384,
        maxOutputTokens: 512,
      },
      accounting: 'soft_only',
      retry: 'sender_only',
      extensions: [],
      privateArtifacts: true,
      limits: MAX_LIMITS,
    },
    candidate: options.candidate ?? {
      manifest: {
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'ArtifactManifest',
        metadata: { id: 'candidate' },
        spec: { entries: [coreGood(digestArtifact('packages/example.ts', exampleBytes))] },
      },
      baseRevision: 'base-1',
      sourceRevision: 'source-1',
      artifacts: [{ name: 'packages/example.ts', bytes: exampleBytes }],
    },
    resources: [],
    restore: null,
  };

  const inputV2: PiOpenInputV2 = {
    ...inputV1,
    version: 2,
    policy: {
      ...inputV1.policy,
      version: 2,
    },
  };

  return {
    directory,
    runtimeDir,
    artifactsDir,
    store,
    hostV1,
    hostV2,
    inputV1,
    inputV2,
    cleanup: () => {
      store.close();
      const unlockDirs = (dir: string) => {
        if (!existsSync(dir)) return;
        try { chmodSync(dir, 0o755); } catch { /* ignore */ }
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) unlockDirs(join(dir, entry.name));
        }
      };
      unlockDirs(directory);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('root export surface stays locked to 4 runtime symbols while ./host-session exports strictly 3 symbols', async () => {
  const rootExports = await import('../src/index.js');
  assert.deepEqual(Object.keys(rootExports).sort(), [
    'decodePiCapture',
    'describePiAdapterFiles',
    'openPiAdapter',
    'openPiAdapterV2',
  ]);
  const subpathExports = await import('@loopwright/agent-pi/host-session');
  assert.deepEqual(Object.keys(subpathExports).sort(), [
    'isSupportedHostSessionPlatform',
    'openPiHostSessionAdapter',
    'openPiHostSessionAdapterV2',
  ]);
  assert.equal(typeof openPiHostSessionAdapter, 'function');
  assert.equal(typeof openPiHostSessionAdapterV2, 'function');
  assert.equal(typeof isSupportedHostSessionPlatform, 'function');
});

test('isSupportedHostSessionPlatform accepts darwin/arm64 and linux/{arm64,x64} and rejects unsupported targets', () => {
  assert.equal(isSupportedHostSessionPlatform('darwin', 'arm64'), true);
  assert.equal(isSupportedHostSessionPlatform('linux', 'arm64'), true);
  assert.equal(isSupportedHostSessionPlatform('linux', 'x64'), true);

  assert.equal(isSupportedHostSessionPlatform('darwin', 'x64'), false);
  assert.equal(isSupportedHostSessionPlatform('win32', 'x64'), false);
  assert.equal(isSupportedHostSessionPlatform('win32', 'arm64'), false);
  assert.equal(isSupportedHostSessionPlatform('linux', 'ia32'), false);
  assert.equal(isSupportedHostSessionPlatform('freebsd', 'x64'), false);
  assert.equal(isSupportedHostSessionPlatform('', ''), false);
});

test('openPiHostSessionAdapterV2 executes read, write, edit, and scrubbed scratch bash end-to-end without Docker and records estimated cost', async () => {
  const capturedBodies: Record<string, unknown>[] = [];
  const capturedAuthHeaders: (string | undefined)[] = [];
  let callIndex = 0;
  let bashCandidateDir = '';
  let bashOutsideDir = '';

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    capturedAuthHeaders.push(req.headers.authorization);
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    capturedBodies.push(parsed);
    callIndex++;

    let body: string;
    if (callIndex === 1) {
      body = sseToolCall('glm-5.3', 'call-read-1', 'read', { path: 'packages/example.ts' });
    } else if (callIndex === 2) {
      body = sseToolCall('glm-5.3', 'call-write-1', 'write', {
        path: 'packages/created.ts',
        content: 'export const created = 42;\n',
      });
    } else if (callIndex === 3) {
      body = sseToolCall('glm-5.3', 'call-edit-1', 'edit', {
        path: 'packages/example.ts',
        edits: [{ oldText: '1', newText: '99' }],
      });
    } else if (callIndex === 4) {
      body = sseToolCall('glm-5.3', 'call-bash-1', 'bash', {
        command: [
          'env',
          'echo "BASH_PWD=$(pwd)"',
          'echo scratch > scratch-marker.txt',
          'echo tmp-ok > "$TMPDIR/tmp-marker.txt"',
          `(echo pwn > "${bashCandidateDir}/pwn.txt") 2>/dev/null && echo CANDIDATE_WRITE=allowed || echo CANDIDATE_WRITE=denied`,
          `(echo pwn > "${bashOutsideDir}/pwn.txt") 2>/dev/null && echo OUTSIDE_WRITE=allowed || echo OUTSIDE_WRITE=denied`,
        ].join('; '),
      });
    } else {
      body = sseStop('glm-5.3', 'Completed all candidate updates.');
    }

    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(body);
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server address failed');

  const prevPoolToken = process.env.LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN;
  const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
  process.env.LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN = 'SECRET_POOL_TOKEN_DO_NOT_LEAK';
  process.env.ANTHROPIC_API_KEY = 'SECRET_ANTHROPIC_KEY_DO_NOT_LEAK';

  const fixture = await createHostSessionFixture({
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
  });
  bashCandidateDir = join(fixture.runtimeDir, 'sdk-' + fixture.inputV2.sessionId, 'candidate');
  bashOutsideDir = join(fixture.directory, 'outside-writable');
  mkdirSync(bashOutsideDir, { mode: 0o755 });

  try {
    const opened = await openPiHostSessionAdapterV2(fixture.hostV2, fixture.inputV2);
    assert.equal(opened.ok, true, JSON.stringify(opened));
    if (!opened.ok) return;
    const adapter = opened.value;

    const executed = await adapter.execute({
      commandId: 'cmd-host-1',
      text: 'Update candidate files and run scratch check.',
      purpose: 'task',
      repair: 'none',
    });
    assert.equal(executed.ok, true, JSON.stringify(executed));
    if (!executed.ok) return;
    assert.equal(executed.value.status, 'execution_settled', JSON.stringify(executed.value));
    assert.equal(executed.value.requestIds.length, 5);

    // 1. Verify /workspace/candidate logical prompt framing in outbound requests
    const firstMessages = capturedBodies[0]?.messages as { role?: string; content?: unknown }[];
    assert.ok(Array.isArray(firstMessages) && firstMessages.length > 0);
    const firstSystemText = typeof firstMessages[0]?.content === 'string'
      ? firstMessages[0].content
      : JSON.stringify(firstMessages[0]?.content);
    assert.ok(firstSystemText.includes('<cwd>\n/workspace/candidate\n</cwd>'));
    assert.ok(capturedAuthHeaders.every(h => h === 'Bearer host-session-bearer-token-1234'));

    // 2. Verify bash ran in isolated scratch with ambient secrets scrubbed and writes confined
    const fifthRequestJson = JSON.stringify(capturedBodies[4]);
    assert.ok(!fifthRequestJson.includes('SECRET_POOL_TOKEN_DO_NOT_LEAK'));
    assert.ok(!fifthRequestJson.includes('SECRET_ANTHROPIC_KEY_DO_NOT_LEAK'));
    assert.ok(!fifthRequestJson.includes('LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN'));
    assert.ok(!fifthRequestJson.includes('ANTHROPIC_API_KEY'));
    assert.ok(fifthRequestJson.includes('BASH_PWD='));
    assert.ok(fifthRequestJson.includes('/scratch'));
    assert.ok(fifthRequestJson.includes('CANDIDATE_WRITE=denied'));
    if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
      assert.ok(fifthRequestJson.includes('OUTSIDE_WRITE=denied'));
      assert.equal(existsSync(join(bashOutsideDir, 'pwn.txt')), false);
    }

    // 3. Verify read/write/edit mutated owned.candidate while candidate directories remain 0o555 and scratch/pwn stayed out
    const candidateDir = bashCandidateDir;
    assert.equal(statSync(candidateDir).mode & 0o777, 0o555);
    assert.equal(statSync(join(candidateDir, 'packages')).mode & 0o777, 0o555);
    assert.equal(readFileSync(join(candidateDir, 'packages/created.ts'), 'utf8'), 'export const created = 42;\n');
    assert.equal(readFileSync(join(candidateDir, 'packages/example.ts'), 'utf8'), 'export const value = 99;\n');
    assert.equal(existsSync(join(candidateDir, 'scratch-marker.txt')), false);
    assert.equal(existsSync(join(candidateDir, 'pwn.txt')), false);

    // 4. Verify Candidate hash guards remain intact on capture
    const captured = await adapter.capture({ checkpointId: 'cp-host-1' });
    assert.equal(captured.ok, true, JSON.stringify(captured));
    if (captured.ok) {
      assert.deepEqual(
        captured.value.candidate.spec.entries.map(e => e.name),
        ['packages/created.ts', 'packages/example.ts'],
      );
    }

    // 5. Verify estimated costMicrousd recorded in store (80*2 + 20*0.5 + 20*10 = 370 per call)
    for (const reqId of executed.value.requestIds) {
      const record = stateGood(fixture.store.getRequest(reqId));
      assert.deepEqual(record.initialObservation?.usage.costMicrousd, {
        provenance: 'estimated',
        value: 370,
      });
    }

    const closed = await adapter.close();
    assert.equal(closed.ok, true, JSON.stringify(closed));
  } finally {
    if (prevPoolToken === undefined) delete process.env.LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN;
    else process.env.LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN = prevPoolToken;
    if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fixture.cleanup();
  }
});

test('out-of-band tampering with owned.candidate files is refused with RECOVERY_REQUIRED in host-session', async () => {
  let callIndex = 0;
  let candidateFile = '';

  const server = http.createServer(async (req, res) => {
    for await (const chunk of req) { void chunk; }
    callIndex++;
    if (callIndex === 1) {
      // Tamper with the candidate file out-of-band before the model's read tool executes
      chmodSync(candidateFile, 0o644);
      writeFileSync(candidateFile, 'export const value = 999999;\n', 'utf8');
      chmodSync(candidateFile, 0o444);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sseToolCall('glm-5.3', 'call-tampered-read', 'read', { path: 'packages/example.ts' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sseStop('glm-5.3', 'unexpected'));
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server address failed');

  const fixture = await createHostSessionFixture({
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
  });
  candidateFile = join(fixture.runtimeDir, 'sdk-' + fixture.inputV2.sessionId, 'candidate', 'packages/example.ts');

  try {
    const opened = await openPiHostSessionAdapterV2(fixture.hostV2, fixture.inputV2);
    assert.equal(opened.ok, true, JSON.stringify(opened));
    if (!opened.ok) return;

    const executed = await opened.value.execute({
      commandId: 'cmd-tamper-1',
      text: 'Read packages/example.ts',
      purpose: 'task',
      repair: 'none',
    });
    assert.equal(executed.ok, true, JSON.stringify(executed));
    if (!executed.ok) return;
    assert.equal(executed.value.status, 'failed');
    assert.equal(executed.value.error?.code, 'RECOVERY_REQUIRED');
    await opened.value.close();
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fixture.cleanup();
  }

  // Also verify out-of-band tampering after a settled turn is refused on capture() with RECOVERY_REQUIRED
  const captureServer = http.createServer(async (req, res) => {
    for await (const chunk of req) { void chunk; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sseStop('glm-5.3', 'Turn settled cleanly.'));
  });
  await new Promise<void>(resolve => captureServer.listen(0, '127.0.0.1', resolve));
  const captureAddr = captureServer.address();
  if (!captureAddr || typeof captureAddr === 'string') throw new Error('captureServer address failed');
  const captureFixture = await createHostSessionFixture({
    baseUrl: `http://127.0.0.1:${captureAddr.port}/v1`,
  });
  try {
    const opened = await openPiHostSessionAdapterV2(captureFixture.hostV2, captureFixture.inputV2);
    assert.equal(opened.ok, true, JSON.stringify(opened));
    if (!opened.ok) return;
    const settled = await opened.value.execute({
      commandId: 'cmd-tamper-capture-1',
      text: 'Do nothing and stop.',
      purpose: 'task',
      repair: 'none',
    });
    assert.equal(settled.ok, true);
    if (!settled.ok) return;
    assert.equal(settled.value.status, 'execution_settled');

    const settledCandidateFile = join(captureFixture.runtimeDir, 'sdk-' + captureFixture.inputV2.sessionId, 'candidate', 'packages/example.ts');
    chmodSync(settledCandidateFile, 0o644);
    writeFileSync(settledCandidateFile, 'export const tampered = true;\n', 'utf8');
    chmodSync(settledCandidateFile, 0o444);

    const captured = await opened.value.capture({ checkpointId: 'cp-tampered-1' });
    assert.equal(captured.ok, false);
    if (!captured.ok) {
      assert.equal(captured.error.code, 'RECOVERY_REQUIRED');
    }
    await opened.value.close();
  } finally {
    captureServer.closeAllConnections();
    await new Promise<void>(resolve => captureServer.close(() => resolve()));
    captureFixture.cleanup();
  }
});

test('HostExecutionLease recovers stale dead-owner lease and kills leftover detached child process group', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sseStop('glm-5.3', 'ok'));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server address failed');

  const fixture = await createHostSessionFixture({
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
  });

  // Spawn an orphan detached process group to verify recovery cleans it up
  const orphan = spawn('/bin/sleep', ['60'], { detached: true, stdio: 'ignore' });
  orphan.unref();
  const orphanPid = orphan.pid!;

  try {
    // Spawn a short-lived process to get a real dead owner PID + birth
    const deadOwner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { stdio: 'ignore' });
    const deadPid = deadOwner.pid!;

    // Capture birth & boot using the same OS primitives via openPiHostSessionAdapter on a temp store or helper
    const { execFileSync } = await import('node:child_process');
    const env = { PATH: '/usr/bin:/bin:/usr/sbin', LANG: 'C' };
    const deadBirth = execFileSync('/bin/ps', ['-p', String(deadPid), '-o', 'lstart='], { env, encoding: 'utf8' }).trim();
    const orphanBirth = execFileSync('/bin/ps', ['-p', String(orphanPid), '-o', 'lstart='], { env, encoding: 'utf8' }).trim();
    const bootId = process.platform === 'linux'
      ? readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
      : execFileSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { env, encoding: 'utf8' }).trim();

    deadOwner.kill('SIGKILL');
    await new Promise<void>(resolve => deadOwner.once('exit', () => resolve()));

    const view = stateGood(fixture.store.inspect());
    const leaseDigest = digest(Buffer.from(canonical({ storeId: view.storeId, runId: fixture.inputV1.lock.spec.runId }))).hex;
    const leasePath = join(fixture.artifactsDir, `pi-execution-${leaseDigest}.ndjson`);
    const staleToken = 'a'.repeat(32);
    const childNonce = 'b'.repeat(32);
    const rows = [
      {
        type: 'owner',
        version: 2,
        daemon: { kind: 'host-process-group', platform: process.platform, arch: process.arch },
        token: staleToken,
        pid: deadPid,
        birth: deadBirth,
        boot: bootId,
        authority: fixture.hostV1.authority,
        storeId: view.storeId,
        runId: view.runId,
        lockHash: view.lockHash,
        clockBasis: view.clock.basis,
      },
      {
        type: 'child',
        name: 'lw-pi-' + childNonce,
        nonce: childNonce,
        role: 'sdk',
        labels: {
          'org.loopwright.generation': String(fixture.hostV1.authority.generation),
          'org.loopwright.run': view.runId,
          'org.loopwright.session': fixture.inputV1.sessionId,
          'org.loopwright.nonce': childNonce,
        },
      },
      {
        type: 'attach',
        nonce: childNonce,
        pid: orphanPid,
        birth: orphanBirth,
      },
    ];
    writeFileSync(leasePath, rows.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });

    const opened = await openPiHostSessionAdapter(fixture.hostV1, fixture.inputV1);
    assert.equal(opened.ok, true, JSON.stringify(opened));
    if (!opened.ok) return;

    // Orphan should be dead and recovery receipt should exist
    assert.throws(() => process.kill(orphanPid, 0), { code: 'ESRCH' });
    assert.equal(existsSync(join(fixture.artifactsDir, `pi-recovery-${staleToken}.json`)), true);

    await opened.value.close();
  } finally {
    try { process.kill(-orphanPid, 'SIGKILL'); } catch { /* already dead */ }
    try { process.kill(orphanPid, 'SIGKILL'); } catch { /* already dead */ }
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fixture.cleanup();
  }
});

test('HostMcpProcess executes stdio mcp__workspace__read_file against owned.candidate without Docker', async () => {
  let callIndex = 0;
  const capturedBodies: Record<string, unknown>[] = [];

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    capturedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
    callIndex++;

    const body = callIndex === 1
      ? sseToolCall('glm-5.3', 'call-mcp-read-1', 'mcp__workspace__read_file', { path: 'packages/example.ts' })
      : sseStop('glm-5.3', 'Read via MCP succeeded.');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(body);
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server address failed');

  const fixture = await createHostSessionFixture({
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    tools: ['mcp__workspace__read_file'],
    mcpNames: ['mcp__workspace__read_file'],
  });

  try {
    const opened = await openPiHostSessionAdapterV2(fixture.hostV2, fixture.inputV2);
    assert.equal(opened.ok, true, JSON.stringify(opened));
    if (!opened.ok) return;

    const executed = await opened.value.execute({
      commandId: 'cmd-mcp-host-1',
      text: 'Read packages/example.ts using MCP.',
      purpose: 'task',
      repair: 'none',
    });
    assert.equal(executed.ok, true, JSON.stringify(executed));
    if (!executed.ok) return;
    assert.equal(executed.value.status, 'execution_settled', JSON.stringify(executed.value));
    assert.ok(JSON.stringify(capturedBodies[1]).includes('export const value = 1;'));

    await opened.value.close();
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fixture.cleanup();
  }
});

test('HostToolProcess fails closed with CONTAINMENT_MISMATCH when host confinement is unavailable (never runs unconfined /bin/bash)', async () => {
  let callIndex = 0;
  let bashMarkerPath = '';

  const server = http.createServer(async (req, res) => {
    for await (const chunk of req) {
      void chunk;
    }
    callIndex++;
    const body = callIndex === 1
      ? sseToolCall('glm-5.3', 'call-bash-unconfined-1', 'bash', {
          command: `echo UNCONFINED > "${bashMarkerPath}"`,
        })
      : sseStop('glm-5.3', 'Should not reach second turn.');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(body);
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server address failed');

  const fixture = await createHostSessionFixture({
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
  });
  bashMarkerPath = join(fixture.directory, 'unconfined-marker.txt');

  const prevDisable = process.env['LOOPWRIGHT_TEST_DISABLE_HOST_CONFINEMENT'];
  process.env['LOOPWRIGHT_TEST_DISABLE_HOST_CONFINEMENT'] = '1';

  try {
    const opened = await openPiHostSessionAdapterV2(fixture.hostV2, fixture.inputV2);
    assert.equal(opened.ok, true, JSON.stringify(opened));
    if (!opened.ok) return;

    const executed = await opened.value.execute({
      commandId: 'cmd-host-unconfined-fail-1',
      text: 'Attempt bash execution while confinement is disabled.',
      purpose: 'task',
      repair: 'none',
    });
    const errorCode = executed.ok ? executed.value.error?.code : executed.error.code;
    assert.equal(errorCode, 'CONTAINMENT_MISMATCH', JSON.stringify(executed));
    assert.equal(callIndex, 1);
    assert.equal(existsSync(bashMarkerPath), false);

    await opened.value.close();
  } finally {
    if (prevDisable === undefined) {
      delete process.env['LOOPWRIGHT_TEST_DISABLE_HOST_CONFINEMENT'];
    } else {
      process.env['LOOPWRIGHT_TEST_DISABLE_HOST_CONFINEMENT'] = prevDisable;
    }
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fixture.cleanup();
  }
});

test('validatePolicy accepts 7 tools including delete and rejects > 8 tools', async () => {
  const filesRes = await describePiAdapterFiles();
  assert.equal(filesRes.ok, true);
  if (!filesRes.ok) return;
  const seven = ['read', 'bash', 'write', 'edit', 'delete', 'codemode', 'mcp__workspace__read_file'];
  const graphDigest = digest(readFileSync(new URL('../../../../package-lock.json', import.meta.url)));
  const runtime = {
    sdkIntegrity: filesRes.value.sdkIntegrity,
    graphDigest,
    imageDigest: 'sha256:' + 'b'.repeat(64),
    configDigest: filesRes.value.restrictionDigest,
    profile: 'linux/arm64' as const,
  };
  const basePolicy = {
    version: 1,
    policyId: 'policy-p7',
    resourceVersion: 'context-host-1',
    adapterId: 'pi',
    adapterVersion: '0.0.0',
    runtime,
    selection: { provider: 'github-copilot', model: 'claude-sonnet-5.5', thinking: 'xhigh', api: 'anthropic-messages' },
    resources: [filesRes.value.preamble],
    tools: seven,
    mcp: { serverId: 'workspace', scriptDigest: filesRes.value.localMcpScriptDigest, names: ['mcp__workspace__read_file'], effects: ['read_only'], idleTimeoutSeconds: 2, absoluteTimeoutSeconds: 10 },
    context: { mode: 'estimated_guard', estimator: 'lw-pi-final-json-bytes-v1', proofId: null, version: 1, evidence: 'estimated', workingWindowCeiling: 98304, maxRequestBytes: 65536, serviceMargin: 32768, toolReserve: 16384, maxOutputTokens: 512 },
    accounting: 'soft_only',
    retry: 'sender_only',
    extensions: [],
    privateArtifacts: true,
    limits: MAX_LIMITS,
  };
  const okPolicy = validatePolicy(JSON.parse(JSON.stringify(basePolicy)) as import('../src/boundary.js').Json);
  assert.equal(okPolicy.tools.length, 7);
  assert.throws(
    () => validatePolicy(JSON.parse(JSON.stringify({ ...basePolicy, tools: [...seven, 'read', 'write'] })) as import('../src/boundary.js').Json),
    error => error instanceof PiFailure && error.detail.code === 'INPUT_INVALID',
  );
});

test('HostRuntimeSession tree_overlay materializes 100755 baseline, gates delete with ENOENT subdir relock tolerance, and preserves overlay capture', { skip: !isSupportedHostSessionPlatform() }, async () => {
  let callIndex = 0;
  let bashCandidateDir = '';
  const capturedBodies: Record<string, unknown>[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    capturedBodies.push(parsed);
    callIndex++;
    const body = callIndex === 1
      ? sseToolCall('glm-5.3', 'call-ov-del', 'delete', { path: 'packages/nested/deep/to-delete.ts' })
      : callIndex === 2
        ? sseToolCall('glm-5.3', 'call-ov-bash', 'bash', { command: `"${bashCandidateDir}/packages/run.sh"` })
        : callIndex === 3
          ? sseToolCall('glm-5.3', 'call-ov-write', 'write', { path: 'packages/created/sub/new.ts', content: 'export const created = true;\n' })
          : sseStop('glm-5.3', 'Overlay delete, exec, and write complete.');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server address failed');

  const stagingParent = mkdtempSync(join(realpathSync(tmpdir()), 'loopwright-host-overlay-stage-'));
  const stagingDir = join(stagingParent, 'baseline');
  mkdirSync(join(stagingDir, 'packages/nested/deep'), { recursive: true, mode: 0o755 });
  const initialGoneBytes = Buffer.from('gone\n');
  const toDeleteBytes = Buffer.from('delete me\n');
  const keepBytes = Buffer.from('export const keep = 1;\n');
  const baseExampleBytes = Buffer.from('export const value = 0;\n');
  const overrideExampleBytes = Buffer.from('export const value = 42;\n');
  const runShBytes = Buffer.from('#!/bin/sh\necho EXEC_100755_OK\n');
  writeFileSync(join(stagingDir, 'packages/example.ts'), baseExampleBytes, { mode: 0o444 });
  writeFileSync(join(stagingDir, 'packages/nested/deep/gone.ts'), initialGoneBytes, { mode: 0o444 });
  writeFileSync(join(stagingDir, 'packages/nested/deep/to-delete.ts'), toDeleteBytes, { mode: 0o444 });
  writeFileSync(join(stagingDir, 'packages/nested/keep.ts'), keepBytes, { mode: 0o444 });
  writeFileSync(join(stagingDir, 'packages/run.sh'), runShBytes, { mode: 0o555 });

  const baselineEntries = [
    { name: 'packages/example.ts', mode: '100644' as const, oid: gitBlobOid('sha256', baseExampleBytes), byteLength: baseExampleBytes.length },
    { name: 'packages/nested/deep/gone.ts', mode: '100644' as const, oid: gitBlobOid('sha256', initialGoneBytes), byteLength: initialGoneBytes.length },
    { name: 'packages/nested/deep/to-delete.ts', mode: '100644' as const, oid: gitBlobOid('sha256', toDeleteBytes), byteLength: toDeleteBytes.length },
    { name: 'packages/nested/keep.ts', mode: '100644' as const, oid: gitBlobOid('sha256', keepBytes), byteLength: keepBytes.length },
    { name: 'packages/run.sh', mode: '100755' as const, oid: gitBlobOid('sha256', runShBytes), byteLength: runShBytes.length },
  ];

  const fixture = await createHostSessionFixture({
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    tools: ['read', 'bash', 'write', 'edit', 'delete'],
    candidate: {
      manifest: {
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'ArtifactManifest',
        metadata: { id: 'candidate' },
        spec: {
          baseTree: { objectFormat: 'sha256', commitOid: 'a'.repeat(64), treeOid: 'b'.repeat(64) },
          entries: [coreGood(digestArtifact('packages/example.ts', overrideExampleBytes))],
          deleted: ['packages/nested/deep/gone.ts'],
        },
      },
      baseRevision: 'base-1',
      sourceRevision: 'source-1',
      artifacts: [{ name: 'packages/example.ts', bytes: overrideExampleBytes }],
      baseline: { directory: stagingDir, entries: baselineEntries },
    },
  });
  bashCandidateDir = join(fixture.runtimeDir, 'sdk-' + fixture.inputV2.sessionId, 'candidate');

  try {
    const opened = await openPiHostSessionAdapterV2(fixture.hostV2, fixture.inputV2);
    assert.equal(opened.ok, true, JSON.stringify(opened));
    if (!opened.ok) return;

    const executed = await opened.value.execute({
      commandId: 'cmd-ov-1',
      text: 'Delete to-delete.ts, run packages/run.sh, and write packages/created/sub/new.ts.',
      purpose: 'task',
      repair: 'none',
    });
    assert.equal(executed.ok, true, JSON.stringify(executed));
    if (!executed.ok) return;
    assert.equal(executed.value.status, 'execution_settled', JSON.stringify(executed.value));
    assert.equal(callIndex, 4);
    assert.ok(JSON.stringify(capturedBodies[2]).includes('EXEC_100755_OK'));

    const candidateDir = bashCandidateDir;
    assert.equal(existsSync(join(candidateDir, 'packages/nested/deep')), false);
    assert.equal(statSync(join(candidateDir, 'packages/run.sh')).mode & 0o777, 0o555);
    assert.equal(statSync(join(candidateDir, 'packages/created/sub')).mode & 0o777, 0o555);
    assert.equal(statSync(join(candidateDir, 'packages/created')).mode & 0o777, 0o555);
    assert.equal(statSync(candidateDir).mode & 0o777, 0o555);

    const captured = await opened.value.capture({ checkpointId: 'checkpoint-ov-1' });
    assert.equal(captured.ok, true, JSON.stringify(captured));
    if (!captured.ok) return;

    const decoded = await decodePiCapture({
      version: 1,
      lock: fixture.inputV2.lock,
      policy: fixture.inputV2.policy,
      checkpoint: stateGood(fixture.store.getCheckpoint('checkpoint-ov-1')),
      sessionId: fixture.inputV2.sessionId,
      roleId: fixture.inputV2.roleId,
      stepId: fixture.inputV2.stepId,
      workspace: {
        ref: captured.value.workspace,
        bytes: readFileSync(join(fixture.artifactsDir, captured.value.workspace.name)),
      },
      session: {
        ref: captured.value.session,
        bytes: readFileSync(join(fixture.artifactsDir, captured.value.session.name)),
      },
      command: null,
    });
    assert.equal(decoded.ok, true, JSON.stringify(decoded));
    if (!decoded.ok) return;
    assert.deepEqual({ ...decoded.value.candidate.spec.baseTree }, {
      objectFormat: 'sha256',
      commitOid: 'a'.repeat(64),
      treeOid: 'b'.repeat(64),
    });
    assert.deepEqual(decoded.value.candidate.spec.deleted, [
      'packages/nested/deep/gone.ts',
      'packages/nested/deep/to-delete.ts',
    ]);
    assert.deepEqual(
      decoded.value.candidate.spec.entries.map(entry => entry.name),
      ['packages/created/sub/new.ts', 'packages/example.ts'],
    );
    assert.equal(decoded.value.artifacts.some(item => item.name === 'packages/run.sh'), false);

    await opened.value.close();
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fixture.cleanup();
    rmSync(stagingParent, { recursive: true, force: true });
  }
});

test('HostRuntimeSession tree_overlay refuses wrong-mode, extra-file, or hardlinked staged baseline with RECOVERY_REQUIRED before worker boot', { skip: !isSupportedHostSessionPlatform() }, async () => {
  for (const kind of ['wrong-mode', 'extra-file', 'hardlink'] as const) {
    const stagingParent = mkdtempSync(join(realpathSync(tmpdir()), 'loopwright-host-overlay-bad-'));
    const stagingDir = join(stagingParent, 'baseline');
    mkdirSync(join(stagingDir, 'packages'), { recursive: true, mode: 0o755 });
    const keepBytes = Buffer.from('export const keep = 1;\n');
    const keepPath = join(stagingDir, 'packages/keep.ts');
    writeFileSync(keepPath, keepBytes, { mode: kind === 'wrong-mode' ? 0o644 : 0o444 });
    if (kind === 'extra-file') {
      writeFileSync(join(stagingDir, 'packages/rogue.ts'), 'rogue\n', { mode: 0o444 });
    } else if (kind === 'hardlink') {
      linkSync(keepPath, join(stagingParent, 'outside-link.ts'));
    }

    const fixture = await createHostSessionFixture({
      baseUrl: 'http://127.0.0.1:1/v1',
      tools: ['read', 'write', 'edit', 'delete'],
      candidate: {
        manifest: {
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'ArtifactManifest',
          metadata: { id: 'candidate' },
          spec: {
            baseTree: { objectFormat: 'sha256', commitOid: 'a'.repeat(64), treeOid: 'b'.repeat(64) },
            entries: [],
            deleted: [],
          },
        },
        baseRevision: 'base-1',
        sourceRevision: 'source-1',
        artifacts: [],
        baseline: {
          directory: stagingDir,
          entries: [
            { name: 'packages/keep.ts', mode: '100644', oid: gitBlobOid('sha256', keepBytes), byteLength: keepBytes.length },
          ],
        },
      },
    });
    try {
      const opened = await openPiHostSessionAdapterV2(fixture.hostV2, fixture.inputV2);
      assert.equal(opened.ok, false, `expected ${kind} to refuse`);
      if (!opened.ok) {
        assert.equal(opened.error.code, 'RECOVERY_REQUIRED', JSON.stringify(opened.error));
      }
    } finally {
      fixture.cleanup();
      rmSync(stagingParent, { recursive: true, force: true });
    }
  }
});

test('HostRuntimeSession tree_overlay allows untouched oversize baseline (> fileBytes), refuses read with TOOL_DENIED, and captures sibling edits/deletes', { skip: !isSupportedHostSessionPlatform() }, async () => {
  const oversizeBytes = Buffer.alloc(MAX_LIMITS.fileBytes + 1024, 0x41);
  const keepBytes = Buffer.from('export const keep = 1;\n');
  const toDeleteBytes = Buffer.from('delete me\n');

  const createOversizeOverlay = () => {
    const stagingParent = mkdtempSync(join(realpathSync(tmpdir()), 'loopwright-host-overlay-oversize-'));
    const stagingDir = join(stagingParent, 'baseline');
    mkdirSync(join(stagingDir, 'packages'), { recursive: true, mode: 0o755 });
    writeFileSync(join(stagingDir, 'packages/keep.ts'), keepBytes, { mode: 0o444 });
    writeFileSync(join(stagingDir, 'packages/large.bin'), oversizeBytes, { mode: 0o444 });
    writeFileSync(join(stagingDir, 'packages/to-delete.ts'), toDeleteBytes, { mode: 0o444 });
    const entries = [
      { name: 'packages/keep.ts', mode: '100644' as const, oid: gitBlobOid('sha256', keepBytes), byteLength: keepBytes.length },
      { name: 'packages/large.bin', mode: '100644' as const, oid: gitBlobOid('sha256', oversizeBytes), byteLength: oversizeBytes.length },
      { name: 'packages/to-delete.ts', mode: '100644' as const, oid: gitBlobOid('sha256', toDeleteBytes), byteLength: toDeleteBytes.length },
    ];
    return { stagingParent, stagingDir, entries };
  };

  // 1) Sibling edit + delete + capture succeed while oversize baseline stays untouched
  {
    let callIndex = 0;
    const server = http.createServer(async (req, res) => {
      for await (const chunk of req) {
        void chunk;
      }
      callIndex++;
      const body = callIndex === 1
        ? sseToolCall('glm-5.3', 'call-ov-big-edit', 'edit', { path: 'packages/keep.ts', edits: [{ oldText: 'keep = 1', newText: 'keep = 2' }] })
        : callIndex === 2
          ? sseToolCall('glm-5.3', 'call-ov-big-del', 'delete', { path: 'packages/to-delete.ts' })
          : sseStop('glm-5.3', 'Edited and deleted sibling files.');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(body);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('server address failed');

    const { stagingParent, stagingDir, entries } = createOversizeOverlay();
    const fixture = await createHostSessionFixture({
      baseUrl: `http://127.0.0.1:${addr.port}/v1`,
      tools: ['read', 'write', 'edit', 'delete'],
      candidate: {
        manifest: {
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'ArtifactManifest',
          metadata: { id: 'candidate' },
          spec: {
            baseTree: { objectFormat: 'sha256', commitOid: 'a'.repeat(64), treeOid: 'b'.repeat(64) },
            entries: [],
            deleted: [],
          },
        },
        baseRevision: 'base-1',
        sourceRevision: 'source-1',
        artifacts: [],
        baseline: { directory: stagingDir, entries },
      },
    });
    try {
      const opened = await openPiHostSessionAdapterV2(fixture.hostV2, fixture.inputV2);
      assert.equal(opened.ok, true, JSON.stringify(opened));
      if (!opened.ok) return;

      const executed = await opened.value.execute({
        commandId: 'cmd-ov-oversize-ok',
        text: 'Edit packages/keep.ts and delete packages/to-delete.ts.',
        purpose: 'task',
        repair: 'none',
      });
      assert.equal(executed.ok, true, JSON.stringify(executed));
      if (!executed.ok) return;
      assert.equal(executed.value.status, 'execution_settled', JSON.stringify(executed.value));

      const captured = await opened.value.capture({ checkpointId: 'checkpoint-ov-oversize-1' });
      assert.equal(captured.ok, true, JSON.stringify(captured));
      if (!captured.ok) return;

      const decoded = await decodePiCapture({
        version: 1,
        lock: fixture.inputV2.lock,
        policy: fixture.inputV2.policy,
        checkpoint: stateGood(fixture.store.getCheckpoint('checkpoint-ov-oversize-1')),
        sessionId: fixture.inputV2.sessionId,
        roleId: fixture.inputV2.roleId,
        stepId: fixture.inputV2.stepId,
        workspace: {
          ref: captured.value.workspace,
          bytes: readFileSync(join(fixture.artifactsDir, captured.value.workspace.name)),
        },
        session: {
          ref: captured.value.session,
          bytes: readFileSync(join(fixture.artifactsDir, captured.value.session.name)),
        },
        command: null,
      });
      assert.equal(decoded.ok, true, JSON.stringify(decoded));
      if (!decoded.ok) return;
      assert.deepEqual(decoded.value.candidate.spec.entries.map(e => e.name), ['packages/keep.ts']);
      assert.deepEqual(decoded.value.candidate.spec.deleted, ['packages/to-delete.ts']);

      await opened.value.close();
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      fixture.cleanup();
      rmSync(stagingParent, { recursive: true, force: true });
    }
  }

  // 2) Attempting to read the oversize baseline file fails closed with TOOL_DENIED
  {
    const server = http.createServer(async (req, res) => {
      for await (const chunk of req) {
        void chunk;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sseToolCall('glm-5.3', 'call-ov-big-read', 'read', { path: 'packages/large.bin' }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('server address failed');

    const { stagingParent, stagingDir, entries } = createOversizeOverlay();
    const fixture = await createHostSessionFixture({
      baseUrl: `http://127.0.0.1:${addr.port}/v1`,
      tools: ['read', 'write', 'edit', 'delete'],
      candidate: {
        manifest: {
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'ArtifactManifest',
          metadata: { id: 'candidate' },
          spec: {
            baseTree: { objectFormat: 'sha256', commitOid: 'a'.repeat(64), treeOid: 'b'.repeat(64) },
            entries: [],
            deleted: [],
          },
        },
        baseRevision: 'base-1',
        sourceRevision: 'source-1',
        artifacts: [],
        baseline: { directory: stagingDir, entries },
      },
    });
    try {
      const opened = await openPiHostSessionAdapterV2(fixture.hostV2, fixture.inputV2);
      assert.equal(opened.ok, true, JSON.stringify(opened));
      if (!opened.ok) return;

      const executed = await opened.value.execute({
        commandId: 'cmd-ov-oversize-read',
        text: 'Read packages/large.bin.',
        purpose: 'task',
        repair: 'none',
      });
      assert.equal(executed.ok, true, JSON.stringify(executed));
      if (!executed.ok) return;
      assert.equal(executed.value.error?.code, 'TOOL_DENIED', JSON.stringify(executed.value));

      await opened.value.close();
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      fixture.cleanup();
      rmSync(stagingParent, { recursive: true, force: true });
    }
  }
});

test('HostRuntimeSession Linux Landlock bootstrap grants read-only access to candidateDir while keeping ownedRoot denied', async () => {
  const python3 = existsSync('/usr/bin/python3')
    ? '/usr/bin/python3'
    : existsSync('/bin/python3')
      ? '/bin/python3'
      : null;
  if (python3 === null) return;

  const hostSessionJs = readFileSync(new URL('../src/host-session.js', import.meta.url), 'utf8');
  assert.match(hostSessionJs, /candidateDir:\s*options\.candidateDir/);

  const scriptMatch = /const HOST_LANDLOCK_BOOTSTRAP_SCRIPT = `([\s\S]*?)`;/.exec(hostSessionJs);
  assert.ok(scriptMatch?.[1], 'expected HOST_LANDLOCK_BOOTSTRAP_SCRIPT in host-session.js');
  const bootstrapScript = scriptMatch[1];

  const rawRoot = mkdtempSync(join(tmpdir(), 'lw-landlock-unit-'));
  const ownedRoot = realpathSync(rawRoot);
  try {
    chmodSync(ownedRoot, 0o700);
    const sdkDir = join(ownedRoot, 'sdk-s1');
    const candidateDir = join(sdkDir, 'candidate');
    const toolDir = join(ownedRoot, 'tool-op1');
    const scratchDir = join(toolDir, 'scratch');
    const tmpDir = join(toolDir, 'tmp');
    mkdirSync(candidateDir, { recursive: true, mode: 0o700 });
    mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
    mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(ownedRoot, 'process-intent.json'), '{"secret":true}\n', { mode: 0o600 });
    writeFileSync(join(candidateDir, 'run.sh'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
    chmodSync(candidateDir, 0o555);

    const harness = [
      'import ctypes, json, os, sys',
      'payload = json.loads(sys.stdin.read())',
      'rules = []',
      'fd_to_path = {}',
      'next_fd = 1000',
      'def tracked_open(path, flags, *args):',
      '    global next_fd',
      '    if not os.path.exists(path):',
      '        raise FileNotFoundError(path)',
      '    fd = next_fd',
      '    next_fd += 1',
      '    fd_to_path[fd] = path',
      '    return fd',
      'def tracked_close(fd):',
      '    if fd == 99:',
      '        return',
      '    if fd not in fd_to_path:',
      '        raise OSError(9, "Bad file descriptor")',
      '    fd_to_path.pop(fd, None)',
      'os.open = tracked_open',
      'os.close = tracked_close',
      'class FakeLibc:',
      '    def prctl(self, *args):',
      '        return 0',
      '    def syscall(self, nr, *args):',
      '        if nr == 444:',
      '            if args[0] is None:',
      '                return 4',
      '            return 99',
      '        if nr == 445:',
      '            ruleset_fd, rule_type, rule_ref, flags = args',
      '            assert ruleset_fd == 99 and rule_type == 1 and flags == 0',
      '            addr = ctypes.addressof(rule_ref._obj)',
      '            allowed = ctypes.c_uint64.from_address(addr).value',
      '            parent_fd = ctypes.c_int32.from_address(addr + 8).value',
      '            rules.append({"path": fd_to_path[parent_fd], "access": allowed})',
      '            return 0',
      '        if nr == 446:',
      '            assert args[0] == 99 and args[1] == 0',
      '            return 0',
      '        raise AssertionError(f"unexpected syscall {nr}")',
      'ctypes.CDLL = lambda *a, **kw: FakeLibc()',
      'def fake_execvp(file, argv):',
      '    sys.stdout.write(json.dumps({"cwd": os.getcwd(), "file": file, "argv": argv, "rules": rules}))',
      '    sys.exit(0)',
      'os.execvp = fake_execvp',
      'sys.argv = ["bootstrap", json.dumps(payload["cfg"]), payload["cmd"]]',
      'exec(compile(payload["script"], "<landlock_bootstrap>", "exec"), {"__name__": "__main__"})',
    ].join('\n');

    const proc = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(python3, ['-c', harness], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify({
        script: bootstrapScript,
        cfg: {
          candidateDir,
          scratchDir,
          tmpDir,
          deniedReadPaths: [`/proc/${process.pid}`, ownedRoot],
        },
        cmd: './run.sh',
      }));
    });

    assert.equal(proc.code, 0, `stderr=${proc.stderr} stdout=${proc.stdout}`);
    const parsed = JSON.parse(proc.stdout) as {
      cwd: string;
      file: string;
      argv: string[];
      rules: Array<{ path: string; access: number }>;
    };
    assert.equal(parsed.cwd, scratchDir);
    assert.equal(parsed.file, '/bin/bash');
    assert.deepEqual(parsed.argv, ['/bin/bash', '-c', './run.sh']);

    const ruleMap = new Map(parsed.rules.map(r => [r.path, r.access]));
    const READ_ACCESS = (1 << 0) | (1 << 2) | (1 << 3); // FS_EXECUTE | FS_READ_FILE | FS_READ_DIR = 13
    assert.equal(ruleMap.get(candidateDir), READ_ACCESS, 'candidateDir must be granted strictly read+execute access');
    const scratchAccess = ruleMap.get(scratchDir) ?? 0;
    const tmpAccess = ruleMap.get(tmpDir) ?? 0;
    assert.equal((scratchAccess & READ_ACCESS) === READ_ACCESS && scratchAccess > READ_ACCESS, true);
    assert.equal((tmpAccess & READ_ACCESS) === READ_ACCESS && tmpAccess > READ_ACCESS, true);
    assert.equal(ruleMap.has(ownedRoot), false, 'ownedRoot must remain excluded from Landlock read rules');
    assert.equal(ruleMap.has(sdkDir), false, 'sdkDir must remain excluded from Landlock read rules');
    assert.equal(ruleMap.has(toolDir), false, 'toolDir must remain excluded from Landlock read rules');
    assert.equal(ruleMap.has(join(ownedRoot, 'process-intent.json')), false);
  } finally {
    try {
      chmodSync(join(ownedRoot, 'sdk-s1', 'candidate'), 0o700);
    } catch {
      // ignore cleanup chmod failure
    }
    rmSync(ownedRoot, { recursive: true, force: true });
  }
});

test('openPiHostSessionAdapterV2 paginates quote-heavy >140KB JSON read cleanly without OUTPUT_LIMIT and pruneContextForBudget compacts older tool results', { skip: !isSupportedHostSessionPlatform() }, async () => {
  const { pruneContextForBudget } = await import('../src/sdk-worker.js');
  const syntheticHistory = {
    systemPrompt: 'system',
    messages: [
      { role: 'user' as const, content: 'sync upstream releases', timestamp: 1 },
      ...Array.from({ length: 6 }, (_, idx) => ([
        {
          role: 'assistant' as const,
          content: [{ type: 'toolCall' as const, id: `call-${idx}`, name: 'read', arguments: { path: `file-${idx}.json` } }],
          api: 'openai-completions' as const,
          provider: 'custom-glm',
          model: 'glm-5.3',
          usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'toolUse' as const,
          timestamp: idx * 2 + 2,
        },
        {
          role: 'toolResult' as const,
          toolCallId: `call-${idx}`,
          toolName: 'read',
          content: [{ type: 'text' as const, text: `line-${idx}-` + 'y'.repeat(16000) }],
          isError: false,
          timestamp: idx * 2 + 3,
        },
      ])).flat(),
    ],
  };
  const compacted = pruneContextForBudget(syntheticHistory, 62464, 'openai-completions');
  assert.ok(Buffer.byteLength(JSON.stringify(compacted)) <= 62464 - 8192);
  // Original context remains unmutated and recent tool results stay intact when older compaction suffices.
  const origFirstTool = syntheticHistory.messages.find(m => m.role === 'toolResult');
  assert.equal(origFirstTool?.role === 'toolResult' && origFirstTool.content[0]?.type === 'text' && origFirstTool.content[0].text.length > 16000, true);
  const compactedToolResults = compacted.messages.filter(m => m.role === 'toolResult');
  const firstBlock = compactedToolResults[0]?.content[0];
  const lastBlock = compactedToolResults.at(-1)?.content[0];
  assert.equal(firstBlock?.type === 'text' && firstBlock.text.includes('compacted to fit context budget'), true);
  assert.equal(lastBlock?.type === 'text' && lastBlock.text.length > 16000, true);

  // Live host-session read on a 150 KB quote-dense JSON catalog (mirrors gpustack_runner/runner.py.json)
  const jsonRows = Array.from({ length: 1800 }, (_, i) => `  "runner_${i}": { "backend": "cuda", "version": "0.${i}.0", "image": "gpustack/runner:cuda-${i}" }`);
  const largeJsonBytes = Buffer.from(`{\n${jsonRows.join(',\n')}\n}\n`, 'utf8');
  assert.ok(largeJsonBytes.byteLength > 140000);

  let callCount = 0;
  let observedToolText = '';
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages?: Array<{ role?: string; content?: unknown }> };
    callCount++;
    let body: string;
    if (callCount === 1) {
      body = sseToolCall('glm-5.3', 'call-big-json', 'read', { path: 'gpustack_runner/runner.py.json' });
    } else {
      const toolMsg = parsed.messages?.find(m => m.role === 'tool');
      observedToolText = typeof toolMsg?.content === 'string' ? toolMsg.content : JSON.stringify(toolMsg?.content ?? '');
      body = sseStop('glm-5.3', 'Read paginated catalog cleanly.');
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server listen failed');

  const fixture = await createHostSessionFixture({
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    candidate: {
      manifest: {
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'ArtifactManifest',
        metadata: { id: 'candidate' },
        spec: { entries: [coreGood(digestArtifact('gpustack_runner/runner.py.json', largeJsonBytes))] },
      },
      baseRevision: 'base-1',
      sourceRevision: 'source-1',
      artifacts: [{ name: 'gpustack_runner/runner.py.json', bytes: largeJsonBytes }],
    },
  });
  try {
    const opened = await openPiHostSessionAdapterV2(fixture.hostV2, fixture.inputV2);
    assert.equal(opened.ok, true, JSON.stringify(opened));
    if (!opened.ok) return;
    try {
      const executed = await opened.value.execute({ commandId: 'cmd-big-json', text: 'Inspect runner.py.json', purpose: 'task', repair: 'none' });
      assert.equal(executed.ok, true, JSON.stringify(executed));
      if (!executed.ok) return;
      assert.equal(executed.value.status, 'execution_settled', JSON.stringify(executed.value));
      assert.ok(observedToolText.includes('runner_0'));
      assert.ok(observedToolText.includes('truncated to fit tool result byte limit'));
    } finally {
      await opened.value.close();
    }
  } finally {
    fixture.cleanup();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('openPiHostSessionAdapterV2 recovers across missing-file/directory read, mismatched edit, missing delete, and exposes read-only $CANDIDATE_DIR + ./candidate in bash while keeping traversal/protected paths hard-denied', { skip: !isSupportedHostSessionPlatform() }, async () => {
  const observedToolOutputs: string[] = [];
  let turn = 0;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages?: Array<{ role?: string; content?: unknown }> };
    const latestTool = [...(parsed.messages ?? [])].reverse().find(m => m.role === 'tool');
    if (latestTool) {
      observedToolOutputs.push(typeof latestTool.content === 'string' ? latestTool.content : JSON.stringify(latestTool.content));
    }
    turn++;
    let body: string;
    if (turn === 1) {
      body = sseToolCall('glm-5.3', 'call-rec-1', 'read', { path: '.autosync/proposal.json' });
    } else if (turn === 2) {
      body = sseToolCall('glm-5.3', 'call-rec-2', 'read', { path: 'packages' });
    } else if (turn === 3) {
      body = sseToolCall('glm-5.3', 'call-rec-3', 'edit', {
        path: 'packages/example.ts',
        edits: [{ oldText: 'value = 999999', newText: 'value = 2' }],
      });
    } else if (turn === 4) {
      body = sseToolCall('glm-5.3', 'call-rec-4', 'delete', { path: 'packages/does-not-exist.ts' });
    } else if (turn === 5) {
      body = sseToolCall('glm-5.3', 'call-rec-5', 'bash', {
        command: [
          'echo "FROM_ENV=$(cat "$CANDIDATE_DIR/packages/example.ts" | tr -d "\\n")"',
          'echo "FROM_REL=$(cat ./candidate/packages/example.ts | tr -d "\\n")"',
          '(echo nope > ./candidate/packages/pwn.ts) 2>/dev/null && echo REL_WRITE=allowed || echo REL_WRITE=denied',
        ].join('; '),
      });
    } else if (turn === 6) {
      body = sseToolCall('glm-5.3', 'call-rec-6', 'edit', {
        path: './packages/example.ts',
        edits: [{ oldText: 'value = 1', newText: 'value = 77' }],
      });
    } else {
      body = sseStop('glm-5.3', 'Recovered and updated candidate cleanly.');
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server listen failed');

  const fixture = await createHostSessionFixture({
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    tools: ['read', 'bash', 'write', 'edit', 'delete'],
  });
  try {
    const opened = await openPiHostSessionAdapterV2(fixture.hostV2, fixture.inputV2);
    assert.equal(opened.ok, true, JSON.stringify(opened));
    if (!opened.ok) return;
    try {
      const executed = await opened.value.execute({ commandId: 'cmd-recover-tools', text: 'Inspect and update packages/example.ts', purpose: 'task', repair: 'none' });
      assert.equal(executed.ok, true, JSON.stringify(executed));
      if (!executed.ok) return;
      assert.equal(executed.value.status, 'execution_settled', JSON.stringify(executed.value));
      assert.equal(turn, 7);
      assert.ok(observedToolOutputs[0]?.includes('File not found: .autosync/proposal.json'), observedToolOutputs[0] ?? 'missing[0]');
      assert.ok(observedToolOutputs[1]?.includes('Path "packages" is a directory, not a file.'), observedToolOutputs[1] ?? 'missing[1]');
      assert.ok(observedToolOutputs[1]?.includes('example.ts'), observedToolOutputs[1] ?? 'missing[1]');
      assert.ok(observedToolOutputs[2]?.includes('oldText was not found'), observedToolOutputs[2] ?? 'missing[2]');
      assert.ok(observedToolOutputs[3]?.includes('Cannot delete packages/does-not-exist.ts: file does not exist.'), observedToolOutputs[3] ?? 'missing[3]');
      assert.ok(observedToolOutputs[4]?.includes('FROM_ENV=export const value = 1;'), observedToolOutputs[4] ?? 'missing[4]');
      assert.ok(observedToolOutputs[4]?.includes('FROM_REL=export const value = 1;'), observedToolOutputs[4] ?? 'missing[4]');
      assert.ok(observedToolOutputs[4]?.includes('REL_WRITE=denied'), observedToolOutputs[4] ?? 'missing[4]');

      const candidateDir = join(fixture.runtimeDir, 'sdk-' + fixture.inputV2.sessionId, 'candidate');
      assert.equal(readFileSync(join(candidateDir, 'packages/example.ts'), 'utf8'), 'export const value = 77;\n');
      assert.equal(statSync(candidateDir).mode & 0o777, 0o555);
      assert.equal(statSync(join(candidateDir, 'packages')).mode & 0o777, 0o555);
    } finally {
      await opened.value.close();
    }
  } finally {
    fixture.cleanup();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  // Negative check: path traversal on read still fails closed with TOOL_DENIED
  const denyServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sseToolCall('glm-5.3', 'call-traversal', 'read', { path: 'packages/../escape.txt' }));
  });
  await new Promise<void>(resolve => denyServer.listen(0, '127.0.0.1', resolve));
  const denyAddr = denyServer.address();
  if (!denyAddr || typeof denyAddr === 'string') throw new Error('denyServer listen failed');
  const denyFixture = await createHostSessionFixture({ baseUrl: `http://127.0.0.1:${denyAddr.port}/v1` });
  try {
    const opened = await openPiHostSessionAdapterV2(denyFixture.hostV2, denyFixture.inputV2);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    try {
      const executed = await opened.value.execute({ commandId: 'cmd-deny-traversal', text: 'Try traversal', purpose: 'task', repair: 'none' });
      assert.equal(executed.ok, true);
      if (!executed.ok) return;
      assert.equal(executed.value.status, 'failed');
      assert.equal(executed.value.error?.code, 'TOOL_DENIED');
    } finally {
      await opened.value.close();
    }
  } finally {
    denyFixture.cleanup();
    await new Promise<void>(resolve => denyServer.close(() => resolve()));
  }
});

test('openPiHostSessionAdapterV2 normalizes bash candidate path aliases, supports edit { path, oldText, newText } shorthand, returns soft scope errors without unlocking 0o555 dirs, and emits tool_end errorCode/errorPath on hard TOOL_DENIED', { skip: !isSupportedHostSessionPlatform() }, async () => {
  const observedToolOutputs: string[] = [];
  const progressEvents: HostSessionProgressEvent[] = [];
  let turn = 0;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages?: Array<{ role?: string; content?: unknown }> };
    const latestTool = [...(parsed.messages ?? [])].reverse().find(m => m.role === 'tool');
    if (latestTool) {
      observedToolOutputs.push(typeof latestTool.content === 'string' ? latestTool.content : JSON.stringify(latestTool.content));
    }
    turn += 1;
    let body: string;
    if (turn === 1) {
      body = sseToolCall('glm-5.3', 'call-alias-1', 'edit', {
        path: './candidate/README.md',
        oldText: 'old',
        newText: 'new',
      });
    } else if (turn === 2) {
      body = sseToolCall('glm-5.3', 'call-alias-2', 'write', {
        path: '/scratch/candidate/packages/policy/settings.ts',
        content: 'PWNED',
      });
    } else if (turn === 3) {
      body = sseToolCall('glm-5.3', 'call-alias-3', 'read', {
        path: './candidate',
      });
    } else if (turn === 4) {
      body = sseToolCall('glm-5.3', 'call-alias-4', 'write', {
        path: './candidate/packages/temp.ts',
        content: 'export const temp = 1;\n',
      });
    } else if (turn === 5) {
      body = sseToolCall('glm-5.3', 'call-alias-5', 'edit', {
        path: '/scratch/candidate/packages/example.ts',
        oldText: 'value = 1',
        newText: 'value = 99',
      });
    } else if (turn === 6) {
      body = sseToolCall('glm-5.3', 'call-alias-6', 'delete', {
        path: 'candidate/packages/temp.ts',
      });
    } else {
      body = sseStop('glm-5.3', 'Updated candidate via normalized aliases and shorthand edit.');
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server listen failed');

  const exampleBytes = Buffer.from('export const value = 1;\n', 'utf8');
  const protectedBytes = Buffer.from('export const policyLocked = true;\n', 'utf8');
  const fixture = await createHostSessionFixture({
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    tools: ['read', 'bash', 'write', 'edit', 'delete'],
    candidate: {
      manifest: {
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'ArtifactManifest',
        metadata: { id: 'candidate' },
        spec: {
          entries: [
            coreGood(digestArtifact('packages/example.ts', exampleBytes)),
            coreGood(digestArtifact('packages/policy/settings.ts', protectedBytes)),
          ],
        },
      },
      baseRevision: 'base-1',
      sourceRevision: 'source-1',
      artifacts: [
        { name: 'packages/example.ts', bytes: exampleBytes },
        { name: 'packages/policy/settings.ts', bytes: protectedBytes },
      ],
    },
  });
  try {
    const opened = await openPiHostSessionAdapterV2(
      fixture.hostV2,
      fixture.inputV2,
      { onProgress: event => progressEvents.push(event) },
    );
    assert.equal(opened.ok, true, JSON.stringify(opened));
    if (!opened.ok) return;
    try {
      const executed = await opened.value.execute({ commandId: 'cmd-alias-shorthand', text: 'Update packages/example.ts', purpose: 'task', repair: 'none' });
      assert.equal(executed.ok, true, JSON.stringify(executed));
      if (!executed.ok) return;
      assert.equal(executed.value.status, 'execution_settled', JSON.stringify(executed.value));
      assert.equal(turn, 7);
      assert.match(observedToolOutputs[0] ?? '', /Cannot edit README\.md: path is outside writable scope/);
      assert.match(observedToolOutputs[1] ?? '', /Cannot write packages\/policy\/settings\.ts: path is outside writable scope/);
      assert.match(observedToolOutputs[2] ?? '', /packages\//);

      const candidateDir = join(fixture.runtimeDir, 'sdk-' + fixture.inputV2.sessionId, 'candidate');
      assert.equal(readFileSync(join(candidateDir, 'packages/example.ts'), 'utf8'), 'export const value = 99;\n');
      assert.equal(readFileSync(join(candidateDir, 'packages/policy/settings.ts'), 'utf8'), 'export const policyLocked = true;\n');
      assert.equal(existsSync(join(candidateDir, 'packages/temp.ts')), false);
      assert.equal(statSync(candidateDir).mode & 0o777, 0o555);
      assert.equal(statSync(join(candidateDir, 'packages')).mode & 0o777, 0o555);
      assert.equal(statSync(join(candidateDir, 'packages/policy')).mode & 0o777, 0o555);

      const toolEnds = progressEvents.filter((e): e is Extract<HostSessionProgressEvent, { kind: 'tool_end' }> => e.kind === 'tool_end');
      assert.equal(toolEnds.length, 6);
      assert.equal(toolEnds[0]?.isError, true);
      assert.equal(toolEnds[0]?.errorCode, undefined);
      assert.equal(toolEnds[1]?.isError, true);
      assert.equal(toolEnds[1]?.errorCode, undefined);
      assert.equal(toolEnds[4]?.isError, false);
    } finally {
      await opened.value.close();
    }
  } finally {
    fixture.cleanup();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  // Negative check: hard TOOL_DENIED on path traversal emits tool_end with errorCode + errorPath and fails closed
  const denyEvents: HostSessionProgressEvent[] = [];
  const denyServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sseToolCall('glm-5.3', 'call-edit-traversal', 'edit', {
      path: './candidate/../escape.txt',
      oldText: 'a',
      newText: 'b',
    }));
  });
  await new Promise<void>(resolve => denyServer.listen(0, '127.0.0.1', resolve));
  const denyAddr = denyServer.address();
  if (!denyAddr || typeof denyAddr === 'string') throw new Error('denyServer listen failed');
  const denyFixture = await createHostSessionFixture({ baseUrl: `http://127.0.0.1:${denyAddr.port}/v1` });
  try {
    const opened = await openPiHostSessionAdapterV2(
      denyFixture.hostV2,
      denyFixture.inputV2,
      { onProgress: event => denyEvents.push(event) },
    );
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    try {
      const executed = await opened.value.execute({ commandId: 'cmd-edit-traversal', text: 'Try traversal edit', purpose: 'task', repair: 'none' });
      assert.equal(executed.ok, true);
      if (!executed.ok) return;
      assert.equal(executed.value.status, 'failed');
      assert.equal(executed.value.error?.code, 'TOOL_DENIED');
      assert.equal(executed.value.error?.path, '/path');

      const toolStarts = denyEvents.filter(e => e.kind === 'tool_start');
      const toolEnds = denyEvents.filter((e): e is Extract<HostSessionProgressEvent, { kind: 'tool_end' }> => e.kind === 'tool_end');
      assert.equal(toolStarts.length, 1);
      assert.equal(toolEnds.length, 1);
      assert.equal(toolEnds[0]?.name, 'edit');
      assert.equal(toolEnds[0]?.isError, true);
      assert.equal(toolEnds[0]?.errorCode, 'TOOL_DENIED');
      assert.equal(toolEnds[0]?.errorPath, '/path');
    } finally {
      await opened.value.close();
    }
  } finally {
    denyFixture.cleanup();
    await new Promise<void>(resolve => denyServer.close(() => resolve()));
  }
});
