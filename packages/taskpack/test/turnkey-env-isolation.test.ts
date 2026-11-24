import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { openPiHostSessionAdapterV2 } from '@loopwright/agent-pi/host-session';
import {
  compileDeclarativeTaskpack,
  DEFAULT_HOST_BUDGETS,
  DEFAULT_LOCAL_COMMAND_GATE_ENV,
  executeTurnkeyCycle,
  LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV,
  SecretScrubber,
  serializePrettyYaml,
  stageCompiledInstructionResources,
  startLocalCommandGateServer,
  validateTaskpackV2Manifest,
  type WrittenCompiledTaskpack,
} from '../src/index.js';

function initGitRepo(repoRoot: string): string {
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.name', 'Loopwright Test'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.email', 'test@loopwright.invalid'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoRoot, stdio: 'ignore' });
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
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
      usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
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
      usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
    })}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
}

function createBarrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= parties) {
      release();
    }
    await gate;
  };
}

describe('executeTurnkeyCycle concurrent environment isolation', () => {
  it('runs two parallel executeTurnkeyCycle calls with distinct ephemeralEnv secrets without clobbering each other or mutating process.env', async () => {
    const base = await realpath(tmpdir());
    const holder = await mkdtemp(join(base, 'lw-tp-env-iso-'));
    const prevActiveToken = process.env[LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV];
    const prevGateSecret = process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
    const hostGateSentinel = 'HOST_SENTINEL_GATE_SECRET_MUST_NOT_CHANGE_9876543210';

    const tokenA = 'sk-island-A-provider-token-1111111111';
    const tokenB = 'sk-island-B-provider-token-2222222222';

    const observedAuthHeaders: Record<'a' | 'b', string[]> = { a: [], b: [] };
    const turnCounters: Record<'a' | 'b', number> = { a: 0, b: 0 };
    const envSnapshotsDuringExec: Array<{
      readonly island: 'a' | 'b';
      readonly activeToken: string | undefined;
      readonly gateSecret: string | undefined;
    }> = [];
    const fallbackTokens: Record<'a' | 'b', string | null> = { a: null, b: null };

    const adapterBarrier = createBarrier(2);

    const sseServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.resume();
      req.on('end', () => {
        const url = req.url ?? '';
        const island: 'a' | 'b' = url.startsWith('/island-a/') ? 'a' : 'b';
        const authHeader = typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : '';
        observedAuthHeaders[island].push(authHeader);
        envSnapshotsDuringExec.push({
          island,
          activeToken: process.env[LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV],
          gateSecret: process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV],
        });

        const turn = turnCounters[island]++;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (turn === 0) {
          res.end(sseToolCall('mock-model', `call-${island}-0`, 'write', {
            path: 'src/app.txt',
            content: `updated-by-${island}\n`,
          }));
        } else {
          res.end(sseStop('mock-model', JSON.stringify({
            version: 1,
            status: 'completed',
            checks: [],
            reason: `island ${island} updated src/app.txt`,
          })));
        }
      });
    });

    await new Promise<void>(resolveListen => sseServer.listen(0, '127.0.0.1', () => resolveListen()));
    const ssePort = (sseServer.address() as { port: number }).port;

    let gateServerA: Awaited<ReturnType<typeof startLocalCommandGateServer>> | undefined;
    let gateServerB: Awaited<ReturnType<typeof startLocalCommandGateServer>> | undefined;

    try {
      delete process.env[LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV];
      process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = hostGateSentinel;

      const setupIsland = async (island: 'a' | 'b') => {
        const repoRoot = join(holder, `repo-${island}`);
        const runRoot = join(holder, `runs-${island}`);
        await mkdir(join(repoRoot, 'src'), { recursive: true });
        await mkdir(join(repoRoot, '.loopwright', 'checks'), { recursive: true });
        await mkdir(runRoot, { recursive: true, mode: 0o700 });
        await chmod(runRoot, 0o700);
        await writeFile(join(repoRoot, 'src', 'app.txt'), 'initial\n', 'utf8');
        await writeFile(
          join(repoRoot, '.loopwright', 'checks', 'verify.sh'),
          [
            '#!/bin/sh',
            'set -eu',
            `grep -q "updated-by-${island}" "$LOOPWRIGHT_CANDIDATE_DIR/src/app.txt"`,
            `printf '{"detail":"verified-${island}"}\\n' > "$LOOPWRIGHT_CHECK_OUT"`,
          ].join('\n') + '\n',
          { mode: 0o755 },
        );
        const baseSha = initGitRepo(repoRoot);

        const modelsJsonPath = join(holder, `models-${island}.json`);
        await writeFile(
          modelsJsonPath,
          JSON.stringify({
            providers: {
              'local-oai': {
                baseUrl: `http://127.0.0.1:${ssePort}/island-${island}/v1`,
                api: 'openai-completions',
                apiKey: LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV,
                models: [{ id: 'mock-model', contextWindow: 128_000, maxTokens: 4_096 }],
              },
            },
          }),
          'utf8',
        );

        const manifest = validateTaskpackV2Manifest({
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'Taskpack',
          metadata: { name: `env-iso-${island}` },
          spec: {
            goal: { candidate: `Update src/app.txt for island ${island}.`, noChange: 'Confirm no change.' },
            scope: { writable: ['src/**'], protected: [] },
            models: [{ provider: 'local-oai', id: 'mock-model', apiKeyEnv: LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV }],
            verification: {
              localChecks: [
                {
                  id: 'verify-cmd',
                  implementation: 'command.v1',
                  parameters: { script: '.loopwright/checks/verify.sh', timeoutSeconds: 20 },
                },
              ],
              externalGates: [],
            },
          },
        });

        const baseBindings = {
          mode: 'candidate' as const,
          repository: `local/island-${island}`,
          repositoryRoot: repoRoot,
          baseRevision: baseSha,
          sourceRevision: baseSha,
          budgets: DEFAULT_HOST_BUDGETS,
          modelsJsonPath,
          hostPolicy: { policyProfile: 'local' as const, allowPrivileged: false, allowWorkflowWrites: false },
          credentialEnvMap: {
            provider: LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV,
            localCommandGate: DEFAULT_LOCAL_COMMAND_GATE_ENV,
          },
        };

        const preview = await compileDeclarativeTaskpack(manifest, baseBindings);
        const gateServer = await startLocalCommandGateServer({
          runRoot,
          repositoryRoot: repoRoot,
          gates: preview.localCommandGates ?? [],
          hostPolicy: { policyProfile: 'local', allowPrivileged: false, allowWorkflowWrites: false },
          runtimeEnv: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
        });
        const compiled = await compileDeclarativeTaskpack(manifest, {
          ...baseBindings,
          gateEndpoints: [gateServer.endpointPlan],
        });

        const trustedDirectory = join(runRoot, `trusted-${island}`);
        const regDir = join(trustedDirectory, 'registry');
        const cfgDir = join(trustedDirectory, 'config');
        await mkdir(regDir, { recursive: true, mode: 0o700 });
        await mkdir(cfgDir, { recursive: true, mode: 0o700 });
        await chmod(trustedDirectory, 0o700);
        const registryPath = join(regDir, 'registry.yaml');
        const configPath = join(cfgDir, 'config.yaml');
        const configBytes = Buffer.from(serializePrettyYaml(compiled.config), 'utf8');
        await writeFile(registryPath, compiled.registryBytes, { mode: 0o600 });
        await writeFile(configPath, configBytes, { mode: 0o600 });
        await stageCompiledInstructionResources(regDir, compiled.instructionResources);

        const taskpack: WrittenCompiledTaskpack = {
          ...compiled,
          configBytes,
          trustedDirectory,
          registryPath,
          configPath,
        };
        return { repoRoot, gateServer, taskpack };
      };

      const islandA = await setupIsland('a');
      gateServerA = islandA.gateServer;
      const islandB = await setupIsland('b');
      gateServerB = islandB.gateServer;

      assert.notEqual(gateServerA.signingSecret, gateServerB.signingSecret);

      const makeWrappedAdapter = (
        island: 'a' | 'b',
        postBarrierDelayMs: number,
      ): NonNullable<Parameters<typeof executeTurnkeyCycle>[0]['openHostSessionAdapter']> =>
        async (host, input, opts) => {
          await adapterBarrier();
          envSnapshotsDuringExec.push({
            island,
            activeToken: process.env[LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV],
            gateSecret: process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV],
          });

          // Trigger the active-token fallback path in wrappedHost.resolveCredential using a mismatched destination.
          const fallback = await host.resolveCredential({
            provider: input.policy.selection.provider,
            model: input.policy.selection.model,
            destination: 'https://mismatched.invalid/v1/chat/completions',
            purpose: 'task',
            runId: `env-iso-run-${island}`,
            roleId: input.roleId,
            stepId: input.stepId,
            notAfterMonotonicMs: '1000',
            signal: new AbortController().signal,
          });
          fallbackTokens[island] = fallback.bearerToken;

          if (postBarrierDelayMs > 0) {
            await new Promise<void>(resolveDelay => setTimeout(resolveDelay, postBarrierDelayMs));
          }
          return await openPiHostSessionAdapterV2(host, input, opts);
        };

      const [resA, resB] = await Promise.all([
        executeTurnkeyCycle({
          runId: 'env-iso-run-a',
          attemptSeq: 0,
          repositoryRoot: islandA.repoRoot,
          taskpack: islandA.taskpack,
          runtimeEnv: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
          ephemeralEnv: {
            [LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV]: tokenA,
            [DEFAULT_LOCAL_COMMAND_GATE_ENV]: gateServerA.signingSecret,
          },
          scrubber: new SecretScrubber(),
          policyProfile: 'local',
          openHostSessionAdapter: makeWrappedAdapter('a', 0),
        }),
        executeTurnkeyCycle({
          runId: 'env-iso-run-b',
          attemptSeq: 0,
          repositoryRoot: islandB.repoRoot,
          taskpack: islandB.taskpack,
          runtimeEnv: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
          ephemeralEnv: {
            [LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV]: tokenB,
            [DEFAULT_LOCAL_COMMAND_GATE_ENV]: gateServerB.signingSecret,
          },
          scrubber: new SecretScrubber(),
          policyProfile: 'local',
          // Delay island B slightly so island A finishes while island B is still verifying its gate HMAC.
          openHostSessionAdapter: makeWrappedAdapter('b', 150),
        }),
      ]);

      assert.equal(resA.ok, true, `island A failed: ${resA.detail}`);
      assert.equal(resA.status, 'completed');
      assert.equal(resB.ok, true, `island B failed: ${resB.detail}`);
      assert.equal(resB.status, 'completed');

      // Each island sent exclusively its own provider bearer token on the wire and via fallback.
      assert.ok(observedAuthHeaders.a.length >= 2);
      assert.ok(observedAuthHeaders.b.length >= 2);
      assert.equal(observedAuthHeaders.a.every(h => h === `Bearer ${tokenA}`), true, JSON.stringify(observedAuthHeaders.a));
      assert.equal(observedAuthHeaders.b.every(h => h === `Bearer ${tokenB}`), true, JSON.stringify(observedAuthHeaders.b));
      assert.equal(fallbackTokens.a, tokenA);
      assert.equal(fallbackTokens.b, tokenB);

      // Global process.env was never mutated during or after concurrent execution.
      assert.ok(envSnapshotsDuringExec.length >= 4);
      for (const snap of envSnapshotsDuringExec) {
        assert.equal(snap.activeToken, undefined, `process.env.${LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV} mutated during island ${snap.island}`);
        assert.equal(snap.gateSecret, hostGateSentinel, `process.env.${DEFAULT_LOCAL_COMMAND_GATE_ENV} mutated during island ${snap.island}`);
      }
      assert.equal(process.env[LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV], undefined);
      assert.equal(process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV], hostGateSentinel);
    } finally {
      if (prevActiveToken === undefined) {
        delete process.env[LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV];
      } else {
        process.env[LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV] = prevActiveToken;
      }
      if (prevGateSecret === undefined) {
        delete process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
      } else {
        process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = prevGateSecret;
      }
      await gateServerA?.close().catch(() => undefined);
      await gateServerB?.close().catch(() => undefined);
      await new Promise<void>(resolveClose => sseServer.close(() => resolveClose()));
      await rm(holder, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
