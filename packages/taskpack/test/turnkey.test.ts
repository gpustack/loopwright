import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadTrustedConfiguration, stepNext, stepSubmit } from '@loopwright/controller';
import { loadMemoryStore } from '@loopwright/memory';
import {
  buildCommandScriptInvocation,
  compileDeclarativeTaskpack,
  DEFAULT_HOST_BUDGETS,
  DEFAULT_LOCAL_COMMAND_GATE_ENV,
  executeTurnkeyCycle,
  finalizeLocalTurnkeyMemory,
  openStagedTaskpackStepGate,
  SANITIZED_READ_ONLY_GIT_CONFIG,
  SecretScrubber,
  serializePrettyYaml,
  stageCompiledInstructionResources,
  stageReadOnlyGitForCommandCheck,
  stageTaskpackForStep,
  startLocalCommandGateServer,
  TaskpackError,
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

describe('turnkey.ts & turnkey-memory.ts: hybrid mountReadOnlyGit, CAS security, and local memory finalization', () => {
  it('stages hybrid mountReadOnlyGit cleanly (strips config/credentials/hooks, supports git rev-parse/log/status, emits bwrap --ro-bind .git/objects, clones via CoW + 1 MiB fallback, and rejects object symlinks)', async () => {
    const base = await realpath(tmpdir());
    const holder = await mkdtemp(join(base, 'lw-tp-git-'));
    const repoRoot = join(holder, 'repo');
    const runRoot = join(holder, 'runs');
    try {
      await mkdir(join(repoRoot, '.loopwright', 'checks'), { recursive: true });
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      await writeFile(join(repoRoot, 'src', 'app.txt'), 'v1\n', 'utf8');
      await writeFile(
        join(repoRoot, '.loopwright', 'checks', 'git-check.sh'),
        [
          '#!/bin/sh',
          'set -eu',
          'test ! -e .git/credentials',
          'test ! -e .git/config.worktree',
          'test ! -d .git/hooks',
          'if grep -q "ghs_secretGitConfigToken1234567890" .git/config; then exit 11; fi',
          'git rev-parse --verify HEAD >/dev/null',
          'git log -1 --oneline >/dev/null',
          'git status --porcelain >/dev/null',
        ].join('\n') + '\n',
        { mode: 0o755 },
      );
      await writeFile(
        join(repoRoot, '.loopwright', 'taskpack.yaml'),
        serializePrettyYaml({
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'Taskpack',
          metadata: { name: 'hybrid-git' },
          spec: {
            goal: { candidate: 'Update app.txt.', noChange: 'Confirm no change.' },
            execution: { mode: 'strict', capabilities: { mountReadOnlyGit: true, allowCheckNetwork: true } },
            scope: { writable: ['src/**'], protected: [] },
            verification: {
              localChecks: [
                { id: 'git-check', implementation: 'command.v1', parameters: { script: '.loopwright/checks/git-check.sh', timeoutSeconds: 20 } },
              ],
              externalGates: [],
            },
          },
        }),
        'utf8',
      );
      const headSha = initGitRepo(repoRoot);

      // Inject secret extraheader, credentials, config.worktree, and hook into source .git
      const origGitConfig = await readFile(join(repoRoot, '.git', 'config'), 'utf8');
      await writeFile(
        join(repoRoot, '.git', 'config'),
        `${origGitConfig}\n[http "https://github.com/"]\n\textraheader = AUTHORIZATION: bearer ghs_secretGitConfigToken1234567890\n`,
        'utf8',
      );
      await writeFile(join(repoRoot, '.git', 'credentials'), 'https://x-access-token:ghs_secretGitConfigToken1234567890@github.com\n', 'utf8');
      await writeFile(join(repoRoot, '.git', 'config.worktree'), '[user]\n\tname = secret\n', 'utf8');
      await mkdir(join(repoRoot, '.git', 'hooks'), { recursive: true });
      await writeFile(join(repoRoot, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

      // 1. Verify Linux bwrap invocation uses --ro-bind <srcObjects> <destObjects> and NEVER binds raw .git
      const srcObjects = join(repoRoot, '.git', 'objects');
      const destGit = join(holder, 'dest-bwrap-git');
      const mountBind = await stageReadOnlyGitForCommandCheck(join(repoRoot, '.git'), destGit, {
        useMountNamespaceBind: true,
      });
      assert.ok(mountBind !== null);
      assert.equal(await readFile(join(destGit, 'config'), 'utf8'), SANITIZED_READ_ONLY_GIT_CONFIG);
      assert.deepEqual(await readdir(join(destGit, 'objects')), []);

      const noNetBwrap = buildCommandScriptInvocation('/tmp/check.sh', {
        platform: 'linux',
        linuxBwrapExecutable: '/usr/bin/bwrap',
        allowCheckNetwork: false,
        readOnlyGitObjectsBind: mountBind,
      });
      assert.equal(noNetBwrap.command, '/usr/bin/bwrap');
      assert.equal(noNetBwrap.args.includes('--unshare-net'), true);
      const roIdx = noNetBwrap.args.indexOf('--ro-bind');
      assert.ok(roIdx !== -1);
      assert.equal(noNetBwrap.args[roIdx + 1], await realpath(srcObjects));
      assert.equal(noNetBwrap.args[roIdx + 2], join(destGit, 'objects'));
      assert.equal(noNetBwrap.args.includes(join(repoRoot, '.git')), false);

      const netAllowedBwrap = buildCommandScriptInvocation('/tmp/check.sh', {
        platform: 'linux',
        linuxBwrapExecutable: '/usr/bin/bwrap',
        allowCheckNetwork: true,
        readOnlyGitObjectsBind: mountBind,
      });
      assert.equal(netAllowedBwrap.command, '/usr/bin/bwrap');
      assert.equal(netAllowedBwrap.args.includes('--unshare-net'), false);
      assert.equal(netAllowedBwrap.args.includes('--ro-bind'), true);

      // 2. Verify non-mount-namespace cloning works via both CoW reflink AND disableReflink 1 MiB fallback with nlink === 1
      for (const disableReflink of [false, true]) {
        const clonedGit = join(holder, `dest-cloned-${String(disableReflink)}`);
        const bindRes = await stageReadOnlyGitForCommandCheck(join(repoRoot, '.git'), clonedGit, {
          useMountNamespaceBind: false,
          disableReflink,
        });
        assert.equal(bindRes, null);
        assert.equal(await readFile(join(clonedGit, 'config'), 'utf8'), SANITIZED_READ_ONLY_GIT_CONFIG);
        const looseDirs = (await readdir(join(clonedGit, 'objects'))).filter(n => /^[0-9a-f]{2}$/.test(n));
        assert.ok(looseDirs.length > 0);
        const firstLooseDir = join(clonedGit, 'objects', looseDirs[0]!);
        const looseFiles = await readdir(firstLooseDir);
        assert.ok(looseFiles.length > 0);
        const objStat = await lstat(join(firstLooseDir, looseFiles[0]!));
        assert.equal(objStat.nlink, 1);
        assert.equal(objStat.mode & 0o777, 0o444);
      }

      // 3. End-to-end command.v1 execution with mountReadOnlyGit: true succeeds with git rev-parse/log/status
      const runId = 'hybrid-git-run';
      const staged = await stageTaskpackForStep({
        taskpackPath: '.loopwright/taskpack.yaml',
        repositoryRoot: repoRoot,
        runRoot,
        runId,
        allowPrivileged: true,
        runtimeEnv: {},
      });
      const gateHandle = await openStagedTaskpackStepGate({ runRoot, runId, runtimeEnv: {} });
      assert.ok(gateHandle !== null);
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

        const next = await stepNext(
          {
            configuration: loadedCfg.value,
            repository: repoRoot,
            runRoot,
            runId,
            policyProfile: gateHandle.policyProfile,
            environment: gateHandle.environment,
          },
          gateHandle.ports,
        );
        assert.equal(next.ok, true, next.ok ? '' : JSON.stringify(next.error));
        if (!next.ok || next.value.kind !== 'step') return;

        await writeFile(join(next.value.candidateDir, 'src', 'app.txt'), `v2-${headSha.slice(0, 8)}\n`, 'utf8');
        const sub = await stepSubmit(
          {
            runRoot,
            runId,
            leaseToken: next.value.leaseToken,
            status: 'completed',
            reason: 'updated app.txt',
            environment: gateHandle.environment,
          },
          gateHandle.ports,
        );
        assert.equal(sub.ok, true, sub.ok ? '' : JSON.stringify(sub.error));
        if (sub.ok && sub.value.kind === 'result') {
          assert.equal(sub.value.result.spec.status, 'completed');
        }
      } finally {
        await gateHandle.close();
      }

      // 4. Symlink inside <repo>/.git/objects fails closed with TASKPACK_SCOPE_VIOLATION
      const evilLink = join(repoRoot, '.git', 'objects', 'evil-link');
      await symlink('/etc/hosts', evilLink);
      try {
        await assert.rejects(
          () => stageReadOnlyGitForCommandCheck(join(repoRoot, '.git'), join(holder, 'dest-evil'), {
            useMountNamespaceBind: true,
          }),
          (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_SCOPE_VIOLATION',
        );
      } finally {
        await rm(evilLink, { force: true });
      }
    } finally {
      await removeTreeForceTest(holder);
    }
  });

  it('runs executeTurnkeyCycle + finalizeLocalTurnkeyMemory (disabled, local-only, and separate-pull-request refusal)', async () => {
    const base = await realpath(tmpdir());
    const holder = await mkdtemp(join(base, 'lw-tp-mem-'));
    const repoRoot = join(holder, 'repo');
    const runRoot = join(holder, 'runs');
    try {
      await mkdir(join(repoRoot, '.loopwright', 'checks'), { recursive: true });
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await writeFile(join(repoRoot, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
      await writeFile(
        join(repoRoot, '.loopwright', 'checks', 'fail.sh'),
        '#!/bin/sh\necho "check intentional failure"\nexit 1\n',
        { mode: 0o755 },
      );
      const baseSha = initGitRepo(repoRoot);

      // Build a manifest that runs in delegated mode and settles as failed check (producing deterministic failure observation memory!)
      const localMemManifest = validateTaskpackV2Manifest({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'Taskpack',
        metadata: { name: 'local-mem-test' },
        spec: {
          goal: { candidate: 'Update index.ts.', noChange: 'Confirm no change.' },
          scope: { writable: ['src/**'], protected: [] },
          memory: {
            directory: '.loopwright/memory/local-mem-test',
            apply: 'local-only',
            onNoModelBudget: 'deterministic-observations-only',
          },
          verification: {
            localChecks: [
              { id: 'fail-check', implementation: 'command.v1', parameters: { script: '.loopwright/checks/fail.sh', timeoutSeconds: 15 } },
            ],
            externalGates: [],
          },
        },
      });

      const scrubber = new SecretScrubber();
      const gate = await startLocalCommandGateServer({
        runRoot,
        repositoryRoot: repoRoot,
        gates: [],
        scrubber,
      });
      await gate.close();

      // Pre-compile once to extract localCommandGates, then start gate server and compile with its live URL
      const preCompiled = await compileDeclarativeTaskpack(localMemManifest, {
        mode: 'candidate',
        executionMode: 'delegated',
        repository: 'local/repo',
        repositoryRoot: repoRoot,
        baseRevision: baseSha,
        sourceRevision: baseSha,
        budgets: DEFAULT_HOST_BUDGETS,
        credentialEnvMap: { localCommandGate: DEFAULT_LOCAL_COMMAND_GATE_ENV },
      });

      const liveGate = await startLocalCommandGateServer({
        runRoot,
        repositoryRoot: repoRoot,
        gates: preCompiled.localCommandGates ?? [],
        scrubber,
      });
      try {
        const compiled = await compileDeclarativeTaskpack(localMemManifest, {
          mode: 'candidate',
          executionMode: 'delegated',
          repository: 'local/repo',
          repositoryRoot: repoRoot,
          baseRevision: baseSha,
          sourceRevision: baseSha,
          budgets: DEFAULT_HOST_BUDGETS,
          credentialEnvMap: { localCommandGate: DEFAULT_LOCAL_COMMAND_GATE_ENV },
          gateEndpoints: [
            {
              id: 'taskpack-local-command',
              url: liveGate.url,
              signingCredentialRef: 'taskpack-local-command-signing',
              authCredentialRef: null,
              timeoutMs: 35_000,
              maxPollMs: 50_000,
              pollInitialMs: 100,
              pollMaxMs: 500,
              jitter: 0,
            },
          ],
        });
        const trustedDir = join(runRoot, 'trusted');
        const regDir = join(trustedDir, 'registry');
        const cfgDir = join(trustedDir, 'config');
        await mkdir(regDir, { recursive: true, mode: 0o700 });
        await mkdir(cfgDir, { recursive: true, mode: 0o700 });
        await chmod(trustedDir, 0o700);
        const regPath = join(regDir, 'registry.yaml');
        const cfgPath = join(cfgDir, 'config.yaml');
        await writeFile(regPath, compiled.registryBytes, { mode: 0o600 });
        await writeFile(cfgPath, serializePrettyYaml(compiled.config), { mode: 0o600 });
        await stageCompiledInstructionResources(regDir, compiled.instructionResources);

        const prevGateSecret = process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
        process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = liveGate.signingSecret;
        let loaded: Awaited<ReturnType<typeof loadTrustedConfiguration>>;
        try {
          loaded = await loadTrustedConfiguration({
            configPath: cfgPath,
            registryPath: regPath,
            registrySha256: compiled.registrySha256,
            untrustedRoots: [repoRoot],
          });
        } finally {
          if (prevGateSecret === undefined) {
            delete process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
          } else {
            process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = prevGateSecret;
          }
        }
        assert.equal(loaded.ok, true, loaded.ok ? '' : JSON.stringify(loaded.error));
        if (!loaded.ok) return;

        const runId = 'mem-run-1';
        const stepEnv = (name: string): string | undefined =>
          name === DEFAULT_LOCAL_COMMAND_GATE_ENV ? liveGate.signingSecret : undefined;
        const stepPorts = {
          policyProfile: 'local' as const,
        };
        const s1 = await stepNext(
          { configuration: loaded.value, repository: repoRoot, runRoot, runId, policyProfile: 'local', environment: stepEnv },
          stepPorts,
        );
        assert.equal(s1.ok, true, s1.ok ? '' : JSON.stringify(s1.error));
        if (!s1.ok || s1.value.kind !== 'step') return;
        await writeFile(join(s1.value.candidateDir, 'src', 'index.ts'), 'export const x = 2;\n', 'utf8');
        const s2 = await stepSubmit(
          {
            runRoot,
            runId,
            leaseToken: s1.value.leaseToken,
            status: 'completed',
            reason: 'try x=2',
            environment: stepEnv,
          },
          stepPorts,
        );
        assert.equal(s2.ok, true);
        if (s2.ok && s2.value.kind === 'step') {
          // Repair turn settles as blocked/failed cleanly so run is terminal
          await stepSubmit(
            {
              runRoot,
              runId,
              leaseToken: s2.value.leaseToken,
              status: 'blocked',
              reason: 'stopping after check failure',
              environment: stepEnv,
            },
            stepPorts,
          );
        }

        // 1. Disabled memory returns skipped
        const disabledManifest = validateTaskpackV2Manifest({
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'Taskpack',
          metadata: { name: 'local-mem-test' },
          spec: {
            goal: { candidate: 'Update index.ts.', noChange: 'Confirm no change.' },
            scope: { writable: ['src/**'], protected: [] },
            verification: { localChecks: [], externalGates: [] },
          },
        });
        const skippedSummary = await finalizeLocalTurnkeyMemory({
          runRoot,
          runId,
          repositoryRoot: repoRoot,
          repositoryFullName: 'local/repo',
          manifest: disabledManifest,
          baseRevision: baseSha,
          scrubber,
        });
        assert.equal(skippedSummary.status, 'skipped');
        assert.equal(skippedSummary.reason, 'memory_apply_disabled');

        // 2. local-only memory applies deterministic failure observation to disk without git commits
        const localSummary = await finalizeLocalTurnkeyMemory({
          runRoot,
          runId,
          repositoryRoot: repoRoot,
          repositoryFullName: 'local/repo',
          manifest: localMemManifest,
          baseRevision: baseSha,
          scrubber,
        });
        assert.equal(localSummary.status, 'local_only', localSummary.reason ?? '');
        assert.ok(localSummary.entryCount >= 1);
        const store = await loadMemoryStore(repoRoot, 'local-mem-test', 'local/repo', '.loopwright/memory');
        assert.equal(store.index.entries.length, localSummary.entryCount);

        // 3. separate-pull-request fails closed with TASKPACK_HOST_BINDING_INVALID when no GitHub PR publisher is delegated
        const prMemManifest = validateTaskpackV2Manifest({
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'Taskpack',
          metadata: { name: 'local-mem-test' },
          spec: {
            goal: { candidate: 'Update index.ts.', noChange: 'Confirm no change.' },
            scope: { writable: ['src/**'], protected: [] },
            memory: {
              directory: '.loopwright/memory/local-mem-test',
              apply: 'separate-pull-request',
              onNoModelBudget: 'deterministic-observations-only',
            },
            verification: { localChecks: [], externalGates: [] },
          },
        });
        await assert.rejects(
          () => finalizeLocalTurnkeyMemory({
            runRoot,
            runId,
            repositoryRoot: repoRoot,
            repositoryFullName: 'local/repo',
            manifest: prMemManifest,
            baseRevision: baseSha,
            scrubber,
          }),
          (err: unknown) => {
            if (!(err instanceof TaskpackError)) return false;
            return err.code === 'TASKPACK_HOST_BINDING_INVALID';
          },
        );
      } finally {
        await liveGate.close();
      }

      // Also verify executeTurnkeyCycle settles a real openPiHostSessionAdapterV2 no-change run against a local loopback SSE endpoint
      const submissionJson = '{"version":1,"status":"no_change","checks":[],"reason":"up to date"}';
      const sseServer = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const chunk = {
            id: 'chatcmpl-1',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { role: 'assistant', content: submissionJson }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 12, completion_tokens: 10, total_tokens: 22 },
          };
          res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
        });
      });
      await new Promise<void>(resolveListen => sseServer.listen(0, '127.0.0.1', () => resolveListen()));
      const ssePort = (sseServer.address() as { port: number }).port;
      try {
        const modelsJsonPath = join(holder, 'models.json');
        await writeFile(
          modelsJsonPath,
          JSON.stringify({
            providers: {
              'local-oai': {
                baseUrl: `http://127.0.0.1:${ssePort}/v1`,
                api: 'openai-completions',
                apiKey: 'LOCAL_OAI_KEY',
                models: [{ id: 'mock-model', contextWindow: 128_000, maxTokens: 4_096 }],
              },
            },
          }),
          'utf8',
        );

        const noChangeCompiled = await compileDeclarativeTaskpack(
          validateTaskpackV2Manifest({
            apiVersion: 'loopwright.dev/v1alpha1',
            kind: 'Taskpack',
            metadata: { name: 'pi-nochange' },
            spec: {
              goal: { candidate: 'Update src.', noChange: 'Confirm no change.' },
              scope: { writable: ['src/**'], protected: [] },
              models: [{ provider: 'local-oai', id: 'mock-model', apiKeyEnv: 'LOCAL_OAI_KEY' }],
              verification: { localChecks: [], externalGates: [] },
            },
          }),
          {
            mode: 'no-change',
            repository: 'local/repo',
            repositoryRoot: repoRoot,
            baseRevision: baseSha,
            sourceRevision: baseSha,
            budgets: DEFAULT_HOST_BUDGETS,
            modelsJsonPath,
            credentialEnvMap: { provider: 'LOCAL_OAI_KEY' },
          },
        );
        const ncTrusted = join(runRoot, 'trusted-nc');
        await mkdir(join(ncTrusted, 'registry'), { recursive: true, mode: 0o700 });
        await mkdir(join(ncTrusted, 'config'), { recursive: true, mode: 0o700 });
        await chmod(ncTrusted, 0o700);
        const ncRegPath = join(ncTrusted, 'registry', 'registry.yaml');
        const ncCfgPath = join(ncTrusted, 'config', 'config.yaml');
        const ncCfgBytes = Buffer.from(serializePrettyYaml(noChangeCompiled.config), 'utf8');
        await writeFile(ncRegPath, noChangeCompiled.registryBytes, { mode: 0o600 });
        await writeFile(ncCfgPath, ncCfgBytes, { mode: 0o600 });
        await stageCompiledInstructionResources(join(ncTrusted, 'registry'), noChangeCompiled.instructionResources);
        const ncWritten: WrittenCompiledTaskpack = {
          ...noChangeCompiled,
          configBytes: ncCfgBytes,
          trustedDirectory: ncTrusted,
          registryPath: ncRegPath,
          configPath: ncCfgPath,
        };
        const cycleSummary = await executeTurnkeyCycle({
          runId: 'pi-nc-run',
          attemptSeq: 0,
          repositoryRoot: repoRoot,
          taskpack: ncWritten,
          runtimeEnv: { LOCAL_OAI_KEY: 'sk-local-mock-1234567890' },
          scrubber,
        });
        assert.equal(cycleSummary.ok, true, cycleSummary.detail);
        assert.equal(cycleSummary.status, 'no_change');
      } finally {
        await new Promise<void>(resolveClose => sseServer.close(() => resolveClose()));
      }
    } finally {
      await removeTreeForceTest(holder);
    }
  });
});
