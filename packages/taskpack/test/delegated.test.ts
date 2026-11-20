import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { inspectRun, loadTrustedConfiguration, stepNext, stepSubmit } from '@loopwright/controller';
import {
  DEFAULT_LOCAL_COMMAND_GATE_ENV,
  openStagedTaskpackStepGate,
  serializePrettyYaml,
  stageTaskpackForStep,
  TaskpackError,
} from '../src/index.js';

function initGitRepo(repoRoot: string): string {
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.name', 'Loopwright Test'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.email', 'test@loopwright.invalid'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoRoot, stdio: 'ignore' });
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
}

async function removeTreeForceTest(targetDir: string): Promise<void> {
  const unlock = async (dir: string): Promise<void> => {
    await chmod(dir, 0o700).catch(() => undefined);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await unlock(join(dir, entry.name));
      }
    }
  };
  await unlock(targetDir);
  await rm(targetDir, { recursive: true, force: true });
}

describe('delegated.test.ts: CAS-streamed step staging, >1 MiB command.v1 gate, exposeToChecks, and durable policyProfile', () => {
  it('drives a >1 MiB executable CAS overlay + exposeToChecks preflight resource through stageTaskpackForStep, stepNext/stepSubmit, openStagedTaskpackStepGate, and inspectRun v2', async () => {
    const base = await realpath(tmpdir());
    const holder = await mkdtemp(join(base, 'lw-tp-delegated-'));
    const repoRoot = join(holder, 'repo');
    const runRoot = join(holder, 'runs');
    try {
      await mkdir(join(repoRoot, '.loopwright', 'scripts'), { recursive: true });
      await mkdir(join(repoRoot, '.loopwright', 'checks'), { recursive: true });
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      await writeFile(join(repoRoot, 'src', 'keep.txt'), 'baseline\n', 'utf8');

      await writeFile(
        join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs'),
        `import { writeFileSync } from 'node:fs'; import { join } from 'node:path';
const s = process.env.LOOPWRIGHT_STAGING_DIR;
writeFileSync(join(s, 'check-visible.txt'), 'VISIBLE_TO_CHECKS', 'utf8');
writeFileSync(join(s, 'agent-secret-ctx.txt'), 'AGENT_ONLY_CTX', 'utf8');
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'candidate',
  stagedResources: [
    { id: 'vis', kind: 'document', path: 'check-visible.txt', mount: 'workspace', exposeToChecks: true },
    { id: 'priv', kind: 'document', path: 'agent-secret-ctx.txt', mount: 'workspace', exposeToChecks: false },
  ],
}));`,
        'utf8',
      );

      await writeFile(
        join(repoRoot, '.loopwright', 'checks', 'verify.mjs'),
        `import { accessSync, constants, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const cand = process.env.LOOPWRIGHT_CANDIDATE_DIR;
const staged = process.env.LOOPWRIGHT_STAGED_DIR;
if (!staged) process.exit(2);
if (readFileSync(join(staged, 'check-visible.txt'), 'utf8') !== 'VISIBLE_TO_CHECKS') process.exit(3);
let leaked = false;
try { accessSync(join(staged, 'agent-secret-ctx.txt')); leaked = true; } catch {}
if (leaked) process.exit(4);
const binPath = join(cand, 'src', 'tool.bin');
const st = statSync(binPath);
if (st.size !== 1_572_864) process.exit(5);
try { accessSync(binPath, constants.X_OK); } catch { process.exit(6); }
writeFileSync(process.env.LOOPWRIGHT_CHECK_OUT, JSON.stringify({
  detail: 'verified 1.5 MiB CAS overlay and staged check isolation',
  metrics: { verified_bytes: st.size },
  findings: [{ title: 'Executable bit preserved', severity: 'low', path: 'src/tool.bin', line: 1, evidence: 'mode 0755 verified' }],
}));`,
        'utf8',
      );

      await writeFile(
        join(repoRoot, '.loopwright', 'checks', 'verify.sh'),
        `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/verify.mjs"\n`,
        { mode: 0o755 },
      );

      await writeFile(
        join(repoRoot, '.loopwright', 'taskpack.yaml'),
        serializePrettyYaml({
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'Taskpack',
          metadata: { name: 'delegated-cas' },
          spec: {
            goal: { candidate: 'Add 1.5 MiB tool binary and proposal.', noChange: 'Confirm no change.' },
            execution: { mode: 'strict', capabilities: { allowCheckNetwork: true } },
            preflight: { script: '.loopwright/scripts/preflight.mjs', timeoutSeconds: 20 },
            proposal: { path: '.loopwright/proposal.json', schemaVersion: 1, requiredFields: ['schema_version'] },
            scope: { writable: ['src/**', '.loopwright/proposal.json'], protected: [] },
            limits: { overlay: { maxFiles: 256, maxBytes: 16_777_216 } },
            verification: {
              localChecks: [
                { id: 'proposal-json', implementation: 'json-artifact.v1' },
                { id: 'verify-bin', implementation: 'command.v1', parameters: { script: '.loopwright/checks/verify.sh', timeoutSeconds: 20 } },
              ],
              externalGates: [],
            },
          },
        }),
        'utf8',
      );
      initGitRepo(repoRoot);

      const runId = 'delegated-cas-1';
      await assert.rejects(
        () => stageTaskpackForStep({
          taskpackPath: '.loopwright/taskpack.yaml',
          repositoryRoot: repoRoot,
          runRoot,
          runId,
          runtimeEnv: {},
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
      );

      const staged = await stageTaskpackForStep({
        taskpackPath: '.loopwright/taskpack.yaml',
        repositoryRoot: repoRoot,
        runRoot,
        runId,
        allowPrivileged: true,
        runtimeEnv: {},
      });
      assert.equal(staged.policyProfile, 'local');
      assert.ok(staged.checkStagedDir !== null && staged.workspaceStagedDir !== null);

      const gateHandle = await openStagedTaskpackStepGate({ runRoot, runId, runtimeEnv: {} });
      assert.ok(gateHandle !== null);
      assert.equal(gateHandle.policyProfile, 'local');
      assert.equal(gateHandle.ports?.policyProfile, 'local');
      try {
        const prevGateSecret = process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
        process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = gateHandle.environment(DEFAULT_LOCAL_COMMAND_GATE_ENV);
        let loadedCfg: Awaited<ReturnType<typeof loadTrustedConfiguration>>;
        try {
          loadedCfg = await loadTrustedConfiguration({
            configPath: staged.configPath,
            registryPath: staged.registryPath,
            registrySha256: staged.registrySha256,
            untrustedRoots: [repoRoot],
          });
        } finally {
          if (prevGateSecret === undefined) {
            delete process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
          } else {
            process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = prevGateSecret;
          }
        }
        assert.equal(loadedCfg.ok, true, loadedCfg.ok ? '' : JSON.stringify(loadedCfg.error));
        if (!loadedCfg.ok) return;

        const first = await stepNext(
          {
            configuration: loadedCfg.value,
            repository: repoRoot,
            runRoot,
            runId,
            policyProfile: gateHandle.policyProfile,
            allowWorkflowWrites: gateHandle.allowWorkflowWrites,
            environment: gateHandle.environment,
          },
          gateHandle.ports,
        );
        assert.equal(first.ok, true, first.ok ? '' : JSON.stringify(first.error));
        if (!first.ok) return;
        assert.equal(first.value.kind, 'step');
        if (first.value.kind !== 'step') return;

        const wsDir = first.value.candidateDir;
        const payload = Buffer.alloc(1_572_864, 0x33);
        await writeFile(join(wsDir, 'src', 'tool.bin'), payload, { mode: 0o755 });
        await chmod(join(wsDir, 'src', 'tool.bin'), 0o755);
        await mkdir(join(wsDir, '.loopwright'), { recursive: true });
        await writeFile(join(wsDir, '.loopwright', 'proposal.json'), '{"schema_version":1}\n', 'utf8');

        const submitted = await stepSubmit(
          {
            runRoot,
            runId,
            leaseToken: first.value.leaseToken,
            status: 'completed',
            reason: 'added tool.bin',
            environment: gateHandle.environment,
          },
          gateHandle.ports,
        );
        assert.equal(submitted.ok, true, submitted.ok ? '' : JSON.stringify(submitted.error));
        if (!submitted.ok) return;
        assert.equal(submitted.value.kind, 'result');
        if (submitted.value.kind === 'result') {
          assert.equal(submitted.value.result.spec.status, 'completed');
        }

        const bundleOut = join(holder, 'inspect-out');
        const inspected = await inspectRun({ runRoot, runId, output: bundleOut });
        assert.equal(inspected.ok, true);
        const candFiles = JSON.parse(await readFile(join(bundleOut, 'candidate.files.json'), 'utf8')) as {
          version?: number;
          files: Array<{ name: string; mode: string; uri: string; byteLength: number; body?: string }>;
        };
        assert.equal(candFiles.version, 2);
        const binEntry = candFiles.files.find(f => f.name === 'src/tool.bin');
        assert.ok(binEntry !== undefined);
        assert.equal(binEntry.mode, '100755');
        assert.equal(binEntry.byteLength, 1_572_864);
        assert.match(binEntry.uri, /^cas:\/\/sha256\/[0-9a-f]{64}$/);
        assert.equal(binEntry.body, undefined);
      } finally {
        await gateHandle.close();
      }

      // Legacy secrets.json without policyProfile defaults conservatively to 'github'
      const secretsPath = join(staged.stageDir, 'secrets.json');
      await chmod(secretsPath, 0o600);
      const parsedSecrets = JSON.parse(await readFile(secretsPath, 'utf8')) as Record<string, unknown>;
      delete parsedSecrets['policyProfile'];
      await writeFile(secretsPath, `${JSON.stringify(parsedSecrets, null, 2)}\n`, { mode: 0o600 });
      await chmod(secretsPath, 0o600);

      const legacyHandle = await openStagedTaskpackStepGate({ runRoot, runId, runtimeEnv: {} });
      assert.ok(legacyHandle !== null);
      try {
        assert.equal(legacyHandle.policyProfile, 'github');
        assert.equal(legacyHandle.ports?.policyProfile, 'github');
      } finally {
        await legacyHandle.close();
      }
    } finally {
      await removeTreeForceTest(holder);
    }
  });
});
