import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { HostSessionCircuitBreakerOptions } from '@loopwright/agent-pi/host-session';
import {
  compileDeclarativeTaskpack,
  DEFAULT_HOST_BUDGETS,
  executeTurnkeyActionCycle,
  executeTurnkeyCycle,
  formatHostSessionProgressLog,
  SecretScrubber,
  serializePrettyYaml,
  stageCompiledInstructionResources,
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

describe('turnkey-progress: formatHostSessionProgressLog and circuitBreakerLimits precedence', () => {
  it('formats HostSessionProgressEvent variants cleanly', () => {
    assert.equal(
      formatHostSessionProgressLog(
        { kind: 'request_start', turn: 1, provider: 'openai', model: 'gpt-5' },
        { cumulativeTokens: 0, totalTokenBudget: 100_000 },
      ),
      'turn #1: dispatching request to openai/gpt-5',
    );
    const settled = formatHostSessionProgressLog(
      {
        kind: 'request_settled',
        turn: 1,
        elapsedMs: 1_500,
        inputTokens: 1_200,
        outputTokens: 300,
        stopReason: 'toolUse',
        toolCallNames: ['read', 'edit'],
      },
      { cumulativeTokens: 1_500, totalTokenBudget: 100_000 },
    );
    assert.ok(settled !== null && settled.includes('tools=[read, edit]'));

    const denied = formatHostSessionProgressLog(
      {
        kind: 'tool_end',
        name: 'write',
        elapsedMs: 12,
        isError: true,
        summary: '.git/config',
        errorCode: 'SCOPE_REFUSED',
        errorPath: '.git/config',
      },
      { cumulativeTokens: 1_500, totalTokenBudget: 100_000 },
    );
    assert.ok(denied !== null && denied.includes('denied (SCOPE_REFUSED .git/config)'));

    assert.equal(
      formatHostSessionProgressLog(
        { kind: 'circuit_breaker', reason: 'max_turns', turn: 5, message: 'circuit breaker tripped at turn 5' },
        { cumulativeTokens: 2_000, totalTokenBudget: 100_000 },
      ),
      'circuit breaker tripped at turn 5',
    );
  });

  it('wires spec.limits.{maxTurns,maxRepairTurns} into executeTurnkeyCycle and gives LOOPWRIGHT_MAX_* env overrides precedence', async () => {
    assert.equal(executeTurnkeyActionCycle, executeTurnkeyCycle);
    const base = await realpath(tmpdir());
    const dir = await mkdtemp(join(base, 'lw-tp-progress-'));
    try {
      const repoRoot = join(dir, 'repo');
      const runRoot = join(dir, 'runs');
      await mkdir(join(repoRoot, 'docs'), { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await writeFile(join(repoRoot, 'docs', 'README.md'), '# Docs\n', 'utf8');
      const baseSha = initGitRepo(repoRoot);

      const manifest = validateTaskpackV2Manifest({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'Taskpack',
        metadata: { name: 'cb-limits' },
        spec: {
          goal: { candidate: 'Update docs.', noChange: 'Confirm no change.' },
          scope: { writable: ['docs/**'], protected: [] },
          limits: { maxTurns: 18, maxRepairTurns: 4 },
          verification: { localChecks: [], externalGates: [] },
        },
      });

      const compiled = await compileDeclarativeTaskpack(manifest, {
        mode: 'no-change',
        repository: 'local/repo',
        repositoryRoot: repoRoot,
        baseRevision: baseSha,
        sourceRevision: baseSha,
        budgets: DEFAULT_HOST_BUDGETS,
        credentialEnvMap: { provider: 'OPENAI_API_KEY' },
      });
      assert.deepEqual(compiled.circuitBreakerLimits, { maxTurns: 18, maxRepairTurns: 4 });

      const trustedDirectory = join(runRoot, 'trusted');
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

      const written: WrittenCompiledTaskpack = {
        ...compiled,
        configBytes,
        trustedDirectory,
        registryPath,
        configPath,
      };

      const capturedBreakers: Array<HostSessionCircuitBreakerOptions | undefined> = [];
      const scrubbedSamples: string[] = [];
      const logs: string[] = [];
      const secretVal = 'sk-secret-provider-999999999';
      const scrubber = new SecretScrubber();
      scrubber.register(secretVal);

      const runWithEnv = async (runtimeEnv: NodeJS.ProcessEnv, seq: number): Promise<void> => {
        await executeTurnkeyCycle({
          runId: 'cb-run',
          attemptSeq: seq,
          repositoryRoot: repoRoot,
          taskpack: written,
          runtimeEnv: { OPENAI_API_KEY: secretVal, ...runtimeEnv },
          scrubber,
          onLog: line => logs.push(line),
          openHostSessionAdapter: async (_host, _input, opts) => {
            capturedBreakers.push(opts?.circuitBreaker);
            if (opts?.scrub !== undefined) {
              scrubbedSamples.push(opts.scrub(`token=${secretVal}`));
            }
            return {
              ok: false,
              error: {
                code: 'MODEL_UNAVAILABLE',
                path: '/model',
                phase: 'preflight',
                retryable: true,
                effect: 'none',
                requestId: null,
                operationId: null,
                stateErrorCode: null,
              },
            };
          },
        });
      };

      // 1. Default uses manifest circuitBreakerLimits; invalid env logs warning and falls back to manifest
      await runWithEnv({ LOOPWRIGHT_MAX_TURNS: 'not-an-int' }, 0);
      assert.deepEqual(capturedBreakers[0], { maxTurns: 18, maxRepairTurns: 4 });
      assert.equal(logs.some(line => line.includes('ignoring invalid LOOPWRIGHT_MAX_TURNS')), true);
      assert.equal(scrubbedSamples[0], 'token=[scrubbed]');

      // 2. Valid LOOPWRIGHT_MAX_TURNS / LOOPWRIGHT_MAX_REPAIR_TURNS override manifest values
      await runWithEnv({ LOOPWRIGHT_MAX_TURNS: '7', LOOPWRIGHT_MAX_REPAIR_TURNS: '2' }, 1);
      assert.deepEqual(capturedBreakers[1], { maxTurns: 7, maxRepairTurns: 2 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
