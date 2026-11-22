import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadTrustedConfiguration, stepNext, stepSubmit } from '@loopwright/controller';
import { loadMemoryStore } from '@loopwright/memory';
import {
  ALLOWED_READ_ONLY_GIT_TOP_LEVEL,
  assertDeletedPathsAbsent,
  buildCommandScriptInvocation,
  BWRAP_LOOPBACK_UP_SCRIPT,
  collectPositiveRuntimeToolReadRoots,
  compileDeclarativeTaskpack,
  copyDirectoryTreeReadOnly,
  copySingleRegularFileReadOnly,
  DARWIN_COMMAND_POSITIVE_READ_ROOTS,
  DEFAULT_HOST_BUDGETS,
  DEFAULT_LOCAL_COMMAND_GATE_ENV,
  executeTurnkeyCycle,
  finalizeLocalTurnkeyMemory,
  LANDLOCK_BOOTSTRAP_SCRIPT,
  LINUX_COMMAND_POSITIVE_READ_ROOTS,
  MAX_HELPER_ACTIVE_STAGES,
  MAX_HELPER_CONNECTIONS,
  openStagedTaskpackStepGate,
  parseAllowedHostMounts,
  SANITIZED_READ_ONLY_GIT_CONFIG,
  SecretScrubber,
  serializePrettyYaml,
  stageCompiledInstructionResources,
  stageReadOnlyGitForCommandCheck,
  stageTaskpackForStep,
  startLocalCommandGateServer,
  startMacosStageSeatbeltHelper,
  TaskpackError,
  validateExecutionAuthority,
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

describe('turnkey.ts & turnkey-memory.ts: hybrid mountReadOnlyGit, CAS security, and local memory finalization', { concurrency: 1 }, () => {
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
          'test ! -e .git/modules',
          'if grep -qi "extraheader" .git/config; then exit 11; fi',
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
      await mkdir(join(repoRoot, '.git', 'modules', 'submod', 'hooks'), { recursive: true });
      await writeFile(
        join(repoRoot, '.git', 'modules', 'submod', 'config'),
        '[http "https://github.com/"]\n\textraheader = AUTHORIZATION: bearer ghs_secretSubmoduleToken9999999999\n',
        'utf8',
      );
      await writeFile(join(repoRoot, '.git', 'modules', 'submod', 'hooks', 'post-checkout'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      await mkdir(join(repoRoot, '.git', 'info'), { recursive: true });
      await writeFile(join(repoRoot, '.git', 'info', 'credentials'), 'secret\n', 'utf8');
      await writeFile(join(repoRoot, '.git', 'info', '.git-credentials'), 'secret\n', 'utf8');
      await writeFile(join(repoRoot, '.git', 'refs', 'heads', 'config'), `${headSha}\n`, 'utf8');

      assert.deepEqual([...ALLOWED_READ_ONLY_GIT_TOP_LEVEL].sort(), ['head', 'index', 'info', 'packed-refs', 'refs', 'shallow']);

      // 1. Verify Linux bwrap invocation uses --ro-bind / / and --ro-bind <srcObjects> <destObjects> and NEVER binds raw .git or --bind / /
      const srcObjects = join(repoRoot, '.git', 'objects');
      const destGit = join(holder, 'dest-bwrap-git');
      const mountBind = await stageReadOnlyGitForCommandCheck(join(repoRoot, '.git'), destGit, {
        useMountNamespaceBind: true,
      });
      assert.ok(mountBind !== null);
      assert.equal(await readFile(join(destGit, 'config'), 'utf8'), SANITIZED_READ_ONLY_GIT_CONFIG);
      assert.deepEqual(await readdir(join(destGit, 'objects')), []);
      await assert.rejects(stat(join(destGit, 'modules')), { code: 'ENOENT' });
      await assert.rejects(stat(join(destGit, 'info', 'credentials')), { code: 'ENOENT' });
      await assert.rejects(stat(join(destGit, 'info', '.git-credentials')), { code: 'ENOENT' });
      await assert.rejects(stat(join(destGit, 'refs', 'heads', 'config')), { code: 'ENOENT' });

      const noNetBwrap = buildCommandScriptInvocation('/tmp/check.sh', {
        platform: 'linux',
        linuxBwrapExecutable: '/usr/bin/bwrap',
        allowCheckNetwork: false,
        readOnlyGitObjectsBind: mountBind,
      });
      assert.equal(noNetBwrap.command, '/usr/bin/bwrap');
      assert.equal(noNetBwrap.filesystemIsolated, true);
      assert.equal(noNetBwrap.networkIsolated, true);
      assert.equal(noNetBwrap.args.includes('--unshare-pid'), true);
      assert.equal(noNetBwrap.args.includes('--unshare-net'), true);
      assert.equal(noNetBwrap.args.includes('--bind'), false);
      const rootRoIdx = noNetBwrap.args.indexOf('--ro-bind');
      assert.ok(rootRoIdx !== -1);
      assert.equal(noNetBwrap.args[rootRoIdx + 1], '/');
      assert.equal(noNetBwrap.args[rootRoIdx + 2], '/');
      const realSrcObjects = await realpath(srcObjects);
      const realDestObjects = await realpath(join(destGit, 'objects'));
      let gitObjRoIdx = -1;
      for (let i = 0; i <= noNetBwrap.args.length - 3; i += 1) {
        if (noNetBwrap.args[i] === '--ro-bind' && noNetBwrap.args[i + 2] === realDestObjects) {
          gitObjRoIdx = i;
          break;
        }
      }
      assert.ok(gitObjRoIdx > rootRoIdx);
      assert.equal(noNetBwrap.args[gitObjRoIdx + 1], realSrcObjects);
      assert.equal(noNetBwrap.args.includes(join(repoRoot, '.git')), false);

      const netAllowedBwrap = buildCommandScriptInvocation('/tmp/check.sh', {
        platform: 'linux',
        linuxBwrapExecutable: '/usr/bin/bwrap',
        allowCheckNetwork: true,
        readOnlyGitObjectsBind: mountBind,
      });
      assert.equal(netAllowedBwrap.command, '/usr/bin/bwrap');
      assert.equal(netAllowedBwrap.filesystemIsolated, true);
      assert.equal(netAllowedBwrap.networkIsolated, false);
      assert.equal(netAllowedBwrap.args.includes('--unshare-net'), false);
      assert.equal(netAllowedBwrap.args.includes('--bind'), false);
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

        // 3. separate-pull-request and inline-with-candidate fail closed with TASKPACK_HOST_BINDING_INVALID when no GitHub PR publisher is delegated
        for (const remoteApply of ['separate-pull-request', 'inline-with-candidate'] as const) {
          const prMemManifest = validateTaskpackV2Manifest({
            apiVersion: 'loopwright.dev/v1alpha1',
            kind: 'Taskpack',
            metadata: { name: 'local-mem-test' },
            spec: {
              goal: { candidate: 'Update index.ts.', noChange: 'Confirm no change.' },
              scope: { writable: ['src/**'], protected: [] },
              memory: {
                directory: '.loopwright/memory/local-mem-test',
                apply: remoteApply,
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
        }
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

        // PR #31 parity: startLocalCommandGateServer rejects tmpdir-rooted toolchainPaths at startup before binding
        const tmpToolchainDir = join(holder, 'tmp-toolchain');
        await mkdir(tmpToolchainDir, { recursive: true, mode: 0o700 });
        await assert.rejects(
          () => startLocalCommandGateServer({
            runRoot,
            repositoryRoot: repoRoot,
            gates: [{
              checkId: 'bad-tc',
              gateId: 'gate-bad-tc',
              endpointRef: 'loopwright-local-command',
              script: '.loopwright/checks/git-check.sh',
              scriptSha256: '0'.repeat(64),
              timeoutSeconds: 10,
              allowReadOnlyGitHubToken: false,
              env: [],
              toolchainPaths: [tmpToolchainDir],
              allowPrivileged: false,
            }],
          }),
          (err: unknown) => err instanceof TaskpackError
            && err.code === 'ACTION_INPUT_INVALID'
            && /under tmpdir is forbidden without allowPrivileged/.test(err.message),
        );
      } finally {
        await new Promise<void>(resolveClose => sseServer.close(() => resolveClose()));
      }
    } finally {
      await removeTreeForceTest(holder);
    }
  });

  it('enforces command.v1 OS positive-read/write containment, seccomp/loopback socket isolation, per-stage macOS sandbox helper, and collision-safe single-link copies', async () => {
    const base = await realpath(tmpdir());
    const holder = await mkdtemp(join(base, 'lw-tp-contain-'));
    const repoRoot = join(holder, 'repo');
    const runRoot = join(holder, 'runs');
    const outsideDir = join(holder, 'outside');
    const homeBase = await realpath(homedir());
    const ungrantedHomeSiblingDir = await mkdtemp(join(homeBase, '.lw-ungranted-test-'));
    try {
      const ungrantedHomeSiblingFile = join(ungrantedHomeSiblingDir, 'sibling-secret.txt');
      await writeFile(ungrantedHomeSiblingFile, 'UNGRANTED_SIBLING_PROJECT_SECRET\n', { mode: 0o644 });

      // 1. Unit tests for buildCommandScriptInvocation across Linux bwrap, Linux Landlock+seccomp fallback, macOS Seatbelt, and fail-closed backends
      const bwrapContain = buildCommandScriptInvocation('/work/check-dir/check.sh', {
        platform: 'linux',
        linuxBwrapExecutable: '/usr/bin/bwrap',
        allowCheckNetwork: true,
        cwd: '/work/cand',
        deniedReadPaths: ['/repo', '/work', '/work/cand/secret-sub'],
        allowedReadOnlyPaths: ['/work/cand', '/work/check-dir'],
        writablePaths: ['/work/out', '/work/home', '/work/tmp'],
        readOnlyGitObjectsBind: {
          sourceObjectsDir: '/repo/.git/objects',
          targetObjectsDir: '/work/cand/.git/objects',
        },
      });
      assert.equal(bwrapContain.command, '/usr/bin/bwrap');
      assert.equal(bwrapContain.filesystemIsolated, true);
      assert.equal(bwrapContain.networkIsolated, false);
      assert.equal(bwrapContain.args.includes('--unshare-pid'), true);
      const findTriplet = (args: readonly string[], flag: string, a: string, b: string): number => {
        for (let i = 0; i <= args.length - 3; i += 1) {
          if (args[i] === flag && args[i + 1] === a && args[i + 2] === b) return i;
        }
        return -1;
      };
      // R2-1: NO default-allow `--ro-bind / /`; positive `/usr` + explicit allowedReadOnlyPaths only!
      assert.equal(findTriplet(bwrapContain.args, '--ro-bind', '/', '/'), -1);
      assert.equal(findTriplet(bwrapContain.args, '--bind', '/', '/'), -1);
      const usrIdx = findTriplet(bwrapContain.args, '--ro-bind', '/usr', '/usr');
      const candIdx = findTriplet(bwrapContain.args, '--ro-bind', '/work/cand', '/work/cand');
      const gitObjIdx = findTriplet(bwrapContain.args, '--ro-bind', '/repo/.git/objects', '/work/cand/.git/objects');
      const outIdx = findTriplet(bwrapContain.args, '--bind', '/work/out', '/work/out');
      const maskIdx = bwrapContain.args.indexOf('/work/cand/secret-sub');
      assert.ok(usrIdx >= 0);
      assert.equal(bwrapContain.args.includes('/repo'), false);
      assert.ok(candIdx > usrIdx);
      assert.ok(gitObjIdx > candIdx, 'git objects --ro-bind must follow candidateDir --ro-bind');
      assert.ok(outIdx > candIdx);
      assert.ok(maskIdx > outIdx, 'strict denied child inside mounted root is masked after mounts');

      // Writable candidateDir still keeps .git/objects mounted read-only AFTER --bind candidateDir
      const bwrapWritableCand = buildCommandScriptInvocation('/work/check-dir/check.sh', {
        platform: 'linux',
        arch: 'x64',
        linuxBwrapExecutable: '/usr/bin/bwrap',
        networkMode: 'none',
        cwd: '/work/cand',
        allowedReadOnlyPaths: ['/work/base', '/work/check-dir', '/tmp/autosync-stage/priors'],
        writablePaths: ['/work/cand', '/work/out'],
        readOnlyGitObjectsBind: { sourceObjectsDir: '/repo/.git/objects', targetObjectsDir: '/work/cand/.git/objects' },
      });
      const expectedStageRo = process.platform === 'darwin'
        ? '/private/tmp/autosync-stage/priors'
        : '/tmp/autosync-stage/priors';
      const rwCandIdx = findTriplet(bwrapWritableCand.args, '--bind', '/work/cand', '/work/cand');
      const rwGitObjIdx = findTriplet(bwrapWritableCand.args, '--ro-bind', '/repo/.git/objects', '/work/cand/.git/objects');
      const roStageIdx = findTriplet(bwrapWritableCand.args, '--ro-bind', expectedStageRo, expectedStageRo);
      assert.ok(rwCandIdx >= 0);
      assert.ok(roStageIdx >= 0, 'explicitly allowed stage dir under /tmp is bind-mounted read-only');
      assert.ok(rwGitObjIdx > rwCandIdx, 'git objects --ro-bind must follow writable candidateDir --bind');
      assert.equal(bwrapWritableCand.args.includes('/run/docker.sock'), false, 'host mounts must not be bound unless hostMounts is set');

      // Explicit hostMounts bind read-only, read-write, and socket alias targets inside Linux bwrap
      const bwrapMounts = buildCommandScriptInvocation('/work/check-dir/check.sh', {
        platform: 'linux',
        arch: 'x64',
        linuxBwrapExecutable: '/usr/bin/bwrap',
        networkMode: 'allow-outbound',
        cwd: '/work/cand',
        allowedReadOnlyPaths: ['/work/base', '/work/check-dir'],
        writablePaths: ['/work/cand', '/work/out'],
        hostMounts: [
          { source: '/run/docker.sock', target: '/var/run/docker.sock', mode: 'rw', aliasTarget: '/run/docker.sock' },
          { source: '/mnt/shared-cache', target: '/cache/shared', mode: 'ro' },
        ],
      });
      assert.ok(findTriplet(bwrapMounts.args, '--bind', '/run/docker.sock', '/var/run/docker.sock') >= 0);
      assert.ok(findTriplet(bwrapMounts.args, '--bind', '/run/docker.sock', '/run/docker.sock') >= 0);
      assert.ok(findTriplet(bwrapMounts.args, '--ro-bind', '/mnt/shared-cache', '/cache/shared') >= 0);

      // parseAllowedHostMounts parses comma/newline lists and rejects invalid/root/relative paths
      assert.deepEqual(
        parseAllowedHostMounts(' /var/run/docker.sock,\n/mnt/shared-cache/ , /var/run/docker.sock '),
        ['/var/run/docker.sock', '/mnt/shared-cache'],
      );
      assert.throws(
        () => parseAllowedHostMounts('relative/path'),
        (err: unknown) => err instanceof TaskpackError && err.code === 'ACTION_INPUT_INVALID',
      );
      assert.throws(
        () => parseAllowedHostMounts('/'),
        (err: unknown) => err instanceof TaskpackError && err.code === 'ACTION_INPUT_INVALID',
      );

      // Dual-key authority guard for command.v1 parameters.mounts requires allowPrivileged + allowedHostMounts
      const mountChecks = [{
        id: 'docker-build',
        implementation: 'command.v1' as const,
        parameters: {
          script: '.loopwright/checks/build.sh',
          mounts: [{ source: '/var/run/docker.sock', target: '/var/run/docker.sock', mode: 'rw' as const }],
        },
      }];
      const mountExec = {
        mode: 'strict' as const,
        capabilities: {
          allowHostEnv: false,
          allowHostPath: false,
          mountReadOnlyGit: false,
          allowCheckNetwork: true,
          allowWorkflowWrites: false,
          allowAgentNetwork: false,
        },
        digests: { pinDigests: false },
      };
      assert.throws(
        () => validateExecutionAuthority(mountExec, { policyProfile: 'github', allowPrivileged: true, allowedHostMounts: [] }, { localChecks: mountChecks }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
      );
      assert.throws(
        () => validateExecutionAuthority(mountExec, { policyProfile: 'github', allowPrivileged: false, allowedHostMounts: ['/var/run/docker.sock'] }, { localChecks: mountChecks }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
      );
      validateExecutionAuthority(mountExec, { policyProfile: 'github', allowPrivileged: true, allowedHostMounts: ['/var/run/docker.sock'] }, { localChecks: mountChecks });
      assert.throws(
        () => validateExecutionAuthority(
          mountExec,
          { policyProfile: 'github', allowPrivileged: true, allowedHostMounts: ['/etc/passwd'] },
          {
            localChecks: [{
              id: 'bad-mount',
              implementation: 'command.v1',
              parameters: { script: '.loopwright/checks/build.sh', mounts: [{ source: '/etc/passwd', target: '/etc/passwd', mode: 'ro' }] },
            }],
          },
        ),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_SCOPE_VIOLATION',
      );

      // R3-5 & R4-1: Linux bwrap "none" installs --seccomp 3 IP-socket filter while "loopback-only" omits --seccomp (lo is auto-configured by bwrap)
      const bwrapNone = buildCommandScriptInvocation('/work/check-dir/check.sh', {
        platform: 'linux',
        arch: 'x64',
        linuxBwrapExecutable: '/usr/bin/bwrap',
        networkMode: 'none',
        writablePaths: ['/work/out'],
      });
      const bwrapLoopback = buildCommandScriptInvocation('/work/check-dir/check.sh', {
        platform: 'linux',
        arch: 'x64',
        linuxBwrapExecutable: '/usr/bin/bwrap',
        networkMode: 'loopback-only',
        writablePaths: ['/work/out'],
      });
      assert.equal(bwrapNone.args.includes('--unshare-pid'), true);
      assert.equal(bwrapNone.args.includes('--unshare-net'), true);
      assert.equal(bwrapNone.processIsolated, true);
      assert.equal(bwrapNone.args.includes(BWRAP_LOOPBACK_UP_SCRIPT), false);
      const noneDashIdx = bwrapNone.args.indexOf('--');
      assert.ok(noneDashIdx >= 2);
      assert.deepEqual(bwrapNone.args.slice(noneDashIdx - 2, noneDashIdx), ['--seccomp', '3']);
      assert.ok(Buffer.isBuffer(bwrapNone.seccompBpf) && bwrapNone.seccompBpf.byteLength > 0);

      assert.equal(bwrapLoopback.args.includes('--unshare-pid'), true);
      assert.equal(bwrapLoopback.args.includes('--unshare-net'), true);
      assert.equal(bwrapLoopback.processIsolated, true);
      assert.equal(bwrapLoopback.args.includes('--seccomp'), false);
      assert.equal(bwrapLoopback.args.includes(BWRAP_LOOPBACK_UP_SCRIPT), false);
      assert.equal(bwrapLoopback.seccompBpf, undefined);
      assert.notDeepEqual(bwrapNone.args, bwrapLoopback.args);
      assert.throws(
        () => buildCommandScriptInvocation('/work/check-dir/check.sh', {
          platform: 'linux',
          arch: 's390x',
          linuxBwrapExecutable: '/usr/bin/bwrap',
          networkMode: 'none',
          writablePaths: ['/work/out'],
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'SANDBOX_BACKEND_UNAVAILABLE',
      );

      // R2-1, R2-2, R2-4, R3-1, R3-4, R4-3, & R5-9: Landlock fallback uses -I -S -B -c, spawnCwd '/', ABI >= 3, restricted procfs roots (no /proc/self), processIsolated: false, and seccomp before chdir
      assert.ok(LANDLOCK_BOOTSTRAP_SCRIPT.includes('if abi < 3:'));
      assert.ok(LANDLOCK_BOOTSTRAP_SCRIPT.includes('PR_SET_SECCOMP'));
      assert.ok(LANDLOCK_BOOTSTRAP_SCRIPT.includes('positive_read_roots = cfg.get("positiveReadRoots")'));
      assert.equal(LANDLOCK_BOOTSTRAP_SCRIPT.includes('/proc/self'), false);
      assert.equal(LINUX_COMMAND_POSITIVE_READ_ROOTS.includes('/proc'), false, 'Landlock must NOT grant bare /proc');
      assert.equal(LINUX_COMMAND_POSITIVE_READ_ROOTS.includes('/proc/self'), false, 'Landlock must NOT grant parent-only /proc/self');
      assert.equal(LINUX_COMMAND_POSITIVE_READ_ROOTS.includes('/proc/cpuinfo'), true);
      assert.equal(LINUX_COMMAND_POSITIVE_READ_ROOTS.includes('/proc/meminfo'), true);
      assert.ok(
        LANDLOCK_BOOTSTRAP_SCRIPT.indexOf('PR_SET_SECCOMP') < LANDLOCK_BOOTSTRAP_SCRIPT.indexOf('os.chdir(cwd)'),
        'Landlock bootstrap must install seccomp BEFORE os.chdir(cwd)',
      );
      const landlockFallback = buildCommandScriptInvocation('/work/check-dir/check.sh', {
        platform: 'linux',
        arch: 'x64',
        linuxBwrapExecutable: null,
        linuxPythonExecutable: '/usr/bin/python3',
        linuxSeccompAvailable: true,
        allowCheckNetwork: false,
        cwd: '/work/cand',
        env: { GITHUB_TOKEN: 'ghs_secret_token_value', CUSTOM_VAR: 'visible_only_in_spawn_env' },
        deniedReadPaths: ['/repo', '/work'],
        allowedReadOnlyPaths: ['/work/cand', '/work/check-dir'],
        writablePaths: ['/work/out', '/work/home', '/work/tmp'],
      });
      assert.equal(landlockFallback.command, '/usr/bin/python3');
      assert.deepEqual(landlockFallback.args.slice(0, 4), ['-I', '-S', '-B', '-c']);
      assert.equal(landlockFallback.args[4], LANDLOCK_BOOTSTRAP_SCRIPT);
      assert.equal(landlockFallback.spawnCwd, '/');
      assert.equal(landlockFallback.filesystemIsolated, true);
      assert.equal(landlockFallback.networkIsolated, true);
      assert.equal(landlockFallback.processIsolated, false);
      const unsandboxedLinux = buildCommandScriptInvocation('/work/check-dir/check.sh', {
        platform: 'linux',
        linuxBwrapExecutable: null,
        allowCheckNetwork: true,
        requireFilesystemContainment: false,
      });
      assert.equal(unsandboxedLinux.filesystemIsolated, false);
      assert.equal(unsandboxedLinux.processIsolated, false);
      const serializedLandlockArgs = JSON.stringify(landlockFallback.args);
      assert.equal(serializedLandlockArgs.includes('ghs_secret_token_value'), false);
      assert.equal(serializedLandlockArgs.includes('GITHUB_TOKEN'), false);
      const parsedLandlockCfg = JSON.parse(landlockFallback.args[5]!) as Record<string, unknown>;
      assert.equal('env' in parsedLandlockCfg, false);
      assert.equal(parsedLandlockCfg['blockIpSockets'], true);
      assert.deepEqual(parsedLandlockCfg['positiveReadRoots'], [...LINUX_COMMAND_POSITIVE_READ_ROOTS]);
      assert.equal((parsedLandlockCfg['positiveReadRoots'] as string[]).includes('/proc'), false);

      // R3-5: Landlock without seccomp socket filter MUST fail closed when networkMode !== 'allow-outbound'
      assert.throws(
        () => buildCommandScriptInvocation('/work/check-dir/check.sh', {
          platform: 'linux',
          linuxBwrapExecutable: null,
          linuxPythonExecutable: '/usr/bin/python3',
          linuxSeccompAvailable: false,
          networkMode: 'none',
          writablePaths: ['/work/out'],
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'SANDBOX_BACKEND_UNAVAILABLE',
      );

      const dedicatedLoopback = buildCommandScriptInvocation('/work/check-dir/check.sh', {
        platform: 'linux',
        arch: 'x64',
        linuxBwrapExecutable: null,
        linuxPythonExecutable: '/usr/bin/python3',
        linuxSeccompAvailable: true,
        networkMode: 'loopback-only',
        allowDedicatedRunnerLoopbackFallback: true,
        writablePaths: ['/work/out'],
      });
      assert.equal(dedicatedLoopback.command, '/usr/bin/python3');
      assert.equal(dedicatedLoopback.filesystemIsolated, true);
      assert.equal(dedicatedLoopback.networkIsolated, false);
      assert.throws(
        () => buildCommandScriptInvocation('/work/check-dir/check.sh', {
          platform: 'linux',
          linuxBwrapExecutable: null,
          linuxPythonExecutable: '/usr/bin/python3',
          networkMode: 'loopback-only',
          writablePaths: ['/work/out'],
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'SANDBOX_BACKEND_UNAVAILABLE',
      );

      for (const netMode of ['none', 'loopback-only', 'allow-outbound'] as const) {
        const darwinProfile = buildCommandScriptInvocation('/work/check-dir/check.sh', {
          platform: 'darwin',
          darwinSeatbeltAvailable: true,
          networkMode: netMode,
          deniedReadPaths: ['/repo', '/work', '/opt/homebrew/etc/secret'],
          allowedReadOnlyPaths: ['/work/cand', '/work/check-dir'],
          writablePaths: ['/work/out', '/work/home', '/work/tmp'],
        });
        assert.equal(darwinProfile.command, '/usr/bin/sandbox-exec');
        assert.equal(darwinProfile.filesystemIsolated, true);
        assert.equal(darwinProfile.networkIsolated, netMode !== 'allow-outbound');
        assert.equal(darwinProfile.processIsolated, true);
        const sbpl = darwinProfile.args[1]!;
        assert.ok(sbpl.includes('(deny process-info*)'));
        assert.ok(sbpl.includes('(allow process-info* (target same-sandbox))'));
        const denyAllReadIdx = sbpl.indexOf('(deny file-read*)');
        const allowPositiveReadIdx = sbpl.indexOf('(allow file-read*');
        assert.ok(denyAllReadIdx > 0, 'darwin SBPL must start with default-deny (deny file-read*)');
        assert.ok(allowPositiveReadIdx > denyAllReadIdx, 'positive (allow file-read* ...) follows (deny file-read*)');
        for (const sysRoot of DARWIN_COMMAND_POSITIVE_READ_ROOTS) {
          assert.ok(sbpl.includes(`(subpath "${sysRoot}")`));
        }
        assert.ok(sbpl.includes('(deny file-read*\n  (subpath "/opt/homebrew/etc/secret")'));
        assert.ok(sbpl.includes('(deny file-write*)'));
        assert.ok(sbpl.includes('  (subpath "/work/out")'));
        assert.equal(sbpl.includes('(deny network*)'), netMode !== 'allow-outbound');
        assert.equal(sbpl.includes('(allow network-outbound (remote ip "localhost:*"))'), netMode === 'loopback-only');
      }

      assert.throws(
        () => buildCommandScriptInvocation('/work/check.sh', {
          platform: 'darwin',
          darwinSeatbeltAvailable: false,
          writablePaths: ['/work/out'],
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'SANDBOX_BACKEND_UNAVAILABLE',
      );
      assert.throws(
        () => buildCommandScriptInvocation('/work/check.sh', {
          platform: 'linux',
          linuxBwrapExecutable: null,
          linuxPythonExecutable: null,
          requireFilesystemContainment: true,
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'SANDBOX_BACKEND_UNAVAILABLE',
      );
      assert.throws(
        () => buildCommandScriptInvocation('/work/check.sh', {
          platform: 'win32',
          writablePaths: ['/work/out'],
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'SANDBOX_BACKEND_UNAVAILABLE',
      );

      // 2. R2-7 & R2-16: Hardlink rejection, disableReflink: true >1 MiB digest/inode/0o444 verification, and EEXIST preservation
      await mkdir(outsideDir, { recursive: true });
      const outsideTool = join(outsideDir, 'outside-helper.sh');
      await writeFile(outsideTool, '#!/bin/sh\necho secret\n', { mode: 0o755 });
      const hlSrcDir = join(holder, 'hl-toolchain');
      await mkdir(hlSrcDir, { recursive: true });
      await link(outsideTool, join(hlSrcDir, 'helper.sh'));
      for (const disableReflink of [false, true]) {
        await assert.rejects(
          () => copyDirectoryTreeReadOnly(hlSrcDir, join(holder, `hl-dest-${String(disableReflink)}`), { disableReflink }),
          (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_SCOPE_VIOLATION',
        );
      }

      const streamSrcFile = join(outsideDir, 'multi-chunk-src.bin');
      const streamPayload = Buffer.alloc(1_200_000, 0x6b);
      streamPayload.set([0xde, 0xad, 0xbe, 0xef], 1_048_574);
      const streamPayloadSha = createHash('sha256').update(streamPayload).digest('hex');
      await writeFile(streamSrcFile, streamPayload, { mode: 0o600 });
      const srcStatBefore = await lstat(streamSrcFile);
      const streamDestFile = join(holder, 'copied-readonly-noreflink.bin');
      const copiedBytes = await copySingleRegularFileReadOnly(
        streamSrcFile,
        streamDestFile,
        streamPayload.byteLength,
        false,
        true,
      );
      assert.equal(copiedBytes, streamPayload.byteLength);
      const copiedStat = await lstat(streamDestFile);
      assert.equal(copiedStat.nlink, 1);
      assert.notEqual(copiedStat.ino, srcStatBefore.ino);
      assert.equal(copiedStat.mode & 0o777, 0o444);
      assert.equal(createHash('sha256').update(await readFile(streamDestFile)).digest('hex'), streamPayloadSha);

      for (const disableReflink of [false, true]) {
        const sentinelDest = join(holder, `sentinel-${String(disableReflink)}.txt`);
        await writeFile(sentinelDest, 'SENTINEL_MUST_SURVIVE_EEXIST\n', 'utf8');
        await assert.rejects(
          () => copySingleRegularFileReadOnly(
            streamSrcFile,
            sentinelDest,
            streamPayload.byteLength,
            false,
            disableReflink,
          ),
        );
        assert.equal(await readFile(sentinelDest, 'utf8'), 'SENTINEL_MUST_SURVIVE_EEXIST\n');
      }

      // R3-3: HUGO_BIN=/private/tmp/hugo (or /tmp/hugo) grants ONLY the regular file itself, NEVER /private/tmp or /tmp
      const sysTmpReal = await realpath('/tmp');
      const fakeHugoPath = join(sysTmpReal, `lw-r3-hugo-${process.pid}-${Date.now()}`);
      const fakeHugoHardlink = `${fakeHugoPath}-hl`;
      await writeFile(fakeHugoPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      try {
        const privGate = {
          checkId: 'hugo-check',
          gateId: 'gate-hugo',
          endpointRef: 'loopwright-local-command' as const,
          script: '.loopwright/checks/v.sh',
          scriptSha256: '0'.repeat(64),
          timeoutSeconds: 10,
          allowReadOnlyGitHubToken: false,
          env: [],
          allowPrivileged: true,
        };
        const toolRoots = collectPositiveRuntimeToolReadRoots({
          childEnv: { PATH: '/usr/bin:/bin', HUGO_BIN: fakeHugoPath },
          gate: privGate,
          canonRepoRoot: repoRoot,
          canonRunRoot: runRoot,
          canonScratchBase: join(holder, 'scratch'),
          canonTmpDir: base,
          homeDeniedSet: new Set<string>(),
        });
        assert.equal(toolRoots.includes(fakeHugoPath), true, 'must grant validated HUGO_BIN regular file');
        assert.equal(toolRoots.includes(sysTmpReal), false, 'must NOT grant containing /private/tmp or /tmp directory');
        assert.equal(toolRoots.includes('/tmp'), false);
        assert.equal(toolRoots.includes('/private/tmp'), false);

        // Env-derived read roots admit strict tmp subdirectories (plus safe direct child symlink targets) while refusing /etc, /tmp, and repoRoot
        const envStageDir = join(sysTmpReal, `lw-env-stage-${process.pid}-${Date.now()}`);
        const envSharedTarget = join(sysTmpReal, `lw-env-shared-${process.pid}-${Date.now()}`);
        await mkdir(envStageDir, { recursive: true });
        await mkdir(envSharedTarget, { recursive: true });
        await symlink(envSharedTarget, join(envStageDir, 'go-mod'));
        await symlink('/etc', join(envStageDir, 'bad-etc-link'));
        try {
          const envRoots = collectPositiveRuntimeToolReadRoots({
            childEnv: {
              PATH: '/usr/bin:/bin',
              AUTOSYNC_STAGE_DIR: envStageDir,
              BAD_ETC_DIR: '/etc',
              BAD_TMP_DIR: '/tmp',
              BAD_REPO_DIR: repoRoot,
            },
            gate: {
              ...privGate,
              env: ['AUTOSYNC_STAGE_DIR', 'BAD_ETC_DIR', 'BAD_TMP_DIR', 'BAD_REPO_DIR'],
            },
            canonRepoRoot: repoRoot,
            canonRunRoot: runRoot,
            canonScratchBase: join(holder, 'scratch'),
            canonTmpDir: base,
            homeDeniedSet: new Set<string>(),
          });
          assert.equal(envRoots.includes(envStageDir), true, 'must admit strict child stage dir declared in gate.env');
          assert.equal(envRoots.includes(envSharedTarget), true, 'must admit safe direct child symlink target inside gate.env dir');
          assert.equal(envRoots.includes('/etc'), false, 'must refuse /etc via gate.env and child symlink');
          assert.equal(envRoots.includes('/private/etc'), false, 'must refuse /private/etc via gate.env and child symlink');
          assert.equal(envRoots.includes('/tmp'), false, 'must refuse bare /tmp via gate.env');
          assert.equal(envRoots.includes('/private/tmp'), false, 'must refuse bare /private/tmp via gate.env');
          assert.equal(envRoots.includes(repoRoot), false, 'must refuse repoRoot via gate.env');
        } finally {
          await rm(envStageDir, { recursive: true, force: true }).catch(() => undefined);
          await rm(envSharedTarget, { recursive: true, force: true }).catch(() => undefined);
        }

        // Hardlinked HUGO_BIN (nlink > 1) must be refused
        await link(fakeHugoPath, fakeHugoHardlink);
        const hlToolRoots = collectPositiveRuntimeToolReadRoots({
          childEnv: { PATH: '/usr/bin:/bin', HUGO_BIN: fakeHugoPath },
          gate: privGate,
          canonRepoRoot: repoRoot,
          canonRunRoot: runRoot,
          canonScratchBase: join(holder, 'scratch'),
          canonTmpDir: base,
          homeDeniedSet: new Set<string>(),
        });
        assert.equal(hlToolRoots.includes(fakeHugoPath), false, 'hardlinked HUGO_BIN must not be granted');
        await rm(fakeHugoHardlink, { force: true });

        // R4-10: Non-executable (mode 0o644) regular file passed as HUGO_BIN must NOT be granted read access
        const nonExecHugoPath = `${fakeHugoPath}-nonexec`;
        await writeFile(nonExecHugoPath, 'NOT_AN_EXECUTABLE_SECRET\n', { mode: 0o644 });
        await chmod(nonExecHugoPath, 0o644);
        try {
          const nonExecToolRoots = collectPositiveRuntimeToolReadRoots({
            childEnv: { PATH: '/usr/bin:/bin', HUGO_BIN: nonExecHugoPath },
            gate: privGate,
            canonRepoRoot: repoRoot,
            canonRunRoot: runRoot,
            canonScratchBase: join(holder, 'scratch'),
            canonTmpDir: base,
            homeDeniedSet: new Set<string>(),
          });
          assert.equal(nonExecToolRoots.includes(nonExecHugoPath), false, 'mode-0o644 HUGO_BIN must not be granted');
        } finally {
          await rm(nonExecHugoPath, { force: true });
        }

        // Verify Seatbelt, bwrap, and Landlock keep /private/tmp denied while granting fakeHugoPath
        const darwinHugo = buildCommandScriptInvocation('/work/check.sh', {
          platform: 'darwin',
          darwinSeatbeltAvailable: true,
          deniedReadPaths: [sysTmpReal, '/tmp'],
          allowedReadOnlyPaths: ['/work', fakeHugoPath],
          writablePaths: ['/work/out'],
        });
        assert.equal(darwinHugo.args[1]!.includes(`(literal "${fakeHugoPath}")`), true);
        assert.equal(darwinHugo.args[1]!.includes(`(subpath "${sysTmpReal}")`), false);

        const bwrapHugo = buildCommandScriptInvocation('/work/check.sh', {
          platform: 'linux',
          linuxBwrapExecutable: '/usr/bin/bwrap',
          deniedReadPaths: [sysTmpReal, '/tmp'],
          allowedReadOnlyPaths: ['/work', fakeHugoPath],
          writablePaths: ['/work/out'],
        });
        assert.ok(findTriplet(bwrapHugo.args, '--ro-bind', fakeHugoPath, fakeHugoPath) >= 0);
        assert.equal(findTriplet(bwrapHugo.args, '--ro-bind', sysTmpReal, sysTmpReal), -1);

        const landlockHugo = buildCommandScriptInvocation('/work/check.sh', {
          platform: 'linux',
          linuxBwrapExecutable: null,
          linuxPythonExecutable: '/usr/bin/python3',
          linuxSeccompAvailable: true,
          deniedReadPaths: [sysTmpReal],
          allowedReadOnlyPaths: ['/work', fakeHugoPath],
          writablePaths: ['/work/out'],
        });
        const hugoLandlockCfg = JSON.parse(landlockHugo.args[5]!) as {
          deniedReadPaths: string[];
          allowedReadOnlyPaths: string[];
        };
        assert.equal(hugoLandlockCfg.allowedReadOnlyPaths.includes(fakeHugoPath), true);
        assert.equal(hugoLandlockCfg.deniedReadPaths.includes(sysTmpReal), true);
      } finally {
        await rm(fakeHugoHardlink, { force: true }).catch(() => undefined);
        await rm(fakeHugoPath, { force: true }).catch(() => undefined);
      }

      // R3-13: copyDirectoryTreeReadOnly rejects symlinked destRoot/subdirs and preserves pre-existing sibling permissions
      const r3SrcTree = join(holder, 'r3-src-tree');
      await mkdir(join(r3SrcTree, 'nested'), { recursive: true });
      await writeFile(join(r3SrcTree, 'nested', 'copied.txt'), 'copied-payload\n', { mode: 0o644 });

      const symDestTarget = join(outsideDir, 'sym-dest-target');
      await mkdir(symDestTarget, { recursive: true });
      const symDestRoot = join(holder, 'r3-sym-dest-root');
      await symlink(symDestTarget, symDestRoot);
      await assert.rejects(
        () => copyDirectoryTreeReadOnly(r3SrcTree, symDestRoot),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_SCOPE_VIOLATION',
      );
      assert.deepEqual(await readdir(symDestTarget), []);

      const existingDestWithSymSub = join(holder, 'r3-existing-sym-sub');
      await mkdir(existingDestWithSymSub, { recursive: true, mode: 0o755 });
      await symlink(symDestTarget, join(existingDestWithSymSub, 'nested'));
      await assert.rejects(
        () => copyDirectoryTreeReadOnly(r3SrcTree, existingDestWithSymSub),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_SCOPE_VIOLATION',
      );

      const existingSharedDest = join(holder, 'r3-existing-shared-dest');
      await mkdir(existingSharedDest, { recursive: true, mode: 0o755 });
      await chmod(existingSharedDest, 0o755);
      const preexistingSibling = join(existingSharedDest, 'preexisting-sibling.txt');
      await writeFile(preexistingSibling, 'keep-writable\n', { mode: 0o640 });
      await chmod(preexistingSibling, 0o640);
      await copyDirectoryTreeReadOnly(r3SrcTree, existingSharedDest);
      assert.equal((await lstat(existingSharedDest)).mode & 0o777, 0o755, 'pre-existing destRoot mode must not be mutated');
      assert.equal((await lstat(preexistingSibling)).mode & 0o777, 0o640, 'pre-existing sibling file mode must not be mutated');
      assert.equal((await lstat(join(existingSharedDest, 'nested'))).mode & 0o777, 0o555, 'newly created subdir must be 0o555');
      assert.equal((await lstat(join(existingSharedDest, 'nested', 'copied.txt'))).mode & 0o777, 0o444);

      // R4-8 & R4-12: Missing ancestor directories strictly above destRoot remain 0o700 writable while destRoot & descendants become 0o555
      const r4NewParent = join(holder, 'new-parent');
      const r4ProjectionDest = join(r4NewParent, 'projection');
      await copyDirectoryTreeReadOnly(r3SrcTree, r4ProjectionDest);
      assert.equal((await lstat(r4NewParent)).mode & 0o777, 0o700, 'missing ancestor above destRoot must remain 0o700 writable');
      assert.equal((await lstat(r4ProjectionDest)).mode & 0o777, 0o555, 'created destRoot must be 0o555');
      assert.equal((await lstat(join(r4ProjectionDest, 'nested'))).mode & 0o777, 0o555, 'created subdir must be 0o555');
      await mkdir(join(r4NewParent, 'receipts'), { mode: 0o700 });
      assert.equal((await lstat(join(r4NewParent, 'receipts'))).isDirectory(), true);
      assert.equal(
        (await readdir(r4NewParent)).some(name => name.startsWith('.lw-tree-')),
        false,
        'staging tree must be atomically renamed with zero residue',
      );

      // R5-11: copySingleRegularFileReadOnly rejects mismatched expectedParentId without publishing destPath
      const wrongParentDest = join(holder, 'wrong-parent-id.bin');
      await assert.rejects(
        () => copySingleRegularFileReadOnly(
          streamSrcFile,
          wrongParentDest,
          streamPayload.byteLength,
          false,
          true,
          { dev: 0, ino: 0 },
        ),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_SCOPE_VIOLATION',
      );
      await assert.rejects(stat(wrongParentDest), { code: 'ENOENT' });

      // R5-14: copyDirectoryTreeReadOnly enforces aggregate maxEntries cap across empty subdirectories and cleans up stageRoot
      const emptyDirsSrc = join(holder, 'r5-many-empty-dirs');
      const emptyDirsParent = join(holder, 'r5-empty-dest-parent');
      await mkdir(emptyDirsSrc, { recursive: true });
      await mkdir(emptyDirsParent, { recursive: true, mode: 0o700 });
      await Promise.all(
        Array.from({ length: 40 }, (_, idx) => mkdir(join(emptyDirsSrc, `empty-${String(idx).padStart(3, '0')}`))),
      );
      const emptyDirsDest = join(emptyDirsParent, 'dest');
      await assert.rejects(
        () => copyDirectoryTreeReadOnly(emptyDirsSrc, emptyDirsDest, { maxEntries: 15 }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'ACTION_INPUT_INVALID',
      );
      await assert.rejects(stat(emptyDirsDest), { code: 'ENOENT' });
      assert.deepEqual(await readdir(emptyDirsParent), [], 'failed staging tree must be cleaned up completely');

      // R5-12: assertDeletedPathsAbsent supports valid file <-> directory transitions while rejecting surviving files and symlinks
      const r5CandDir = join(holder, 'r5-deleted-transitions');
      // 1) Deleted file a/b replaced by candidate directory subtree a/b/c.txt (file -> directory)
      await mkdir(join(r5CandDir, 'f2d', 'a', 'b'), { recursive: true });
      await writeFile(join(r5CandDir, 'f2d', 'a', 'b', 'c.txt'), 'new\n', 'utf8');
      await assertDeletedPathsAbsent(join(r5CandDir, 'f2d'), ['a/b'], new Set(['a/b/c.txt']));
      // Without overlay file under a/b, lingering directory a/b MUST fail
      await assert.rejects(
        () => assertDeletedPathsAbsent(join(r5CandDir, 'f2d'), ['a/b'], new Set()),
        (err: unknown) => err instanceof TaskpackError && err.code === 'ACTION_INPUT_INVALID',
      );

      // 2) Deleted file a/b/old.txt replaced by candidate regular file a/b (directory -> file)
      await mkdir(join(r5CandDir, 'd2f', 'a'), { recursive: true });
      await writeFile(join(r5CandDir, 'd2f', 'a', 'b'), 'regular-file\n', 'utf8');
      await assertDeletedPathsAbsent(join(r5CandDir, 'd2f'), ['a/b/old.txt'], new Set(['a/b']));
      // Without a/b in overlayFileNames, unexpected non-directory ancestor a/b MUST fail
      await assert.rejects(
        () => assertDeletedPathsAbsent(join(r5CandDir, 'd2f'), ['a/b/old.txt'], new Set()),
        (err: unknown) => err instanceof TaskpackError && err.code === 'ACTION_INPUT_INVALID',
      );

      // 3) Surviving regular file a/b or symlink at/above a/b MUST fail
      await assert.rejects(
        () => assertDeletedPathsAbsent(join(r5CandDir, 'd2f'), ['a/b'], new Set(['other.txt'])),
        (err: unknown) => err instanceof TaskpackError && err.code === 'ACTION_INPUT_INVALID',
      );
      await mkdir(join(r5CandDir, 'sym-case'), { recursive: true });
      await symlink(outsideTool, join(r5CandDir, 'sym-case', 'link-target'));
      await assert.rejects(
        () => assertDeletedPathsAbsent(join(r5CandDir, 'sym-case'), ['link-target'], new Set()),
        (err: unknown) => err instanceof TaskpackError && err.code === 'ACTION_INPUT_INVALID',
      );
      await assert.rejects(
        () => assertDeletedPathsAbsent(join(r5CandDir, 'sym-case'), ['link-target/sub.txt'], new Set()),
        (err: unknown) => err instanceof TaskpackError && err.code === 'ACTION_INPUT_INVALID',
      );

      // R3-8 & R3-9: macOS stage Seatbelt helper enforces idle header deadline, non-blocking close(), and stream backpressure
      if (process.platform === 'darwin') {
        const helperWork = join(holder, 'sb-helper-r3');
        await mkdir(helperWork, { recursive: true, mode: 0o700 });
        const helperAbort = new AbortController();
        const helper = await startMacosStageSeatbeltHelper({
          outerNetworkMode: 'none',
          outerWritablePaths: [helperWork],
          outerAllowedReadOnlyPaths: [helperWork],
          outerDeniedReadPaths: new Set<string>(),
          homeDeniedSet: new Set<string>(),
          idleHeaderTimeoutMs: 120,
          signal: helperAbort.signal,
          registerKiller: () => () => undefined,
        });
        try {
          // 1) Idle client without newline is destroyed automatically by headerTimer
          await new Promise<void>((resolveIdle, rejectIdle) => {
            const idleConn = createConnection(helper.socketPath);
            const failTimer = setTimeout(() => {
              idleConn.destroy();
              rejectIdle(new Error('idle helper socket was not closed within deadline'));
            }, 2_000);
            idleConn.on('close', () => {
              clearTimeout(failTimer);
              resolveIdle();
            });
          });

          // 2) Slow client triggers pause/drain backpressure without dropping bytes
          const expectedBytes = 524_288;
          const receivedChunks: Buffer[] = [];
          let exitCodeSeen: number | null = null;
          await new Promise<void>((resolveStream, rejectStream) => {
            const client = createConnection(helper.socketPath);
            let recvBuf = '';
            client.on('connect', () => {
              client.pause();
              const req = {
                op: 'exec',
                argv: ['/usr/bin/python3', '-I', '-S', '-B', '-c', `import sys; sys.stdout.buffer.write(b"A" * ${expectedBytes})`],
                cwd: helperWork,
                env: { PATH: '/usr/bin:/bin', HOME: helperWork, TMPDIR: helperWork },
                allowedReadRoots: [helperWork],
                deniedReadRoots: [],
                writablePaths: [helperWork],
                readOnlyMasks: [],
                networkMode: 'none',
              };
              client.write(`${JSON.stringify(req)}\n`);
              setTimeout(() => {
                client.resume();
              }, 80);
            });
            client.on('data', chunk => {
              recvBuf += chunk.toString('utf8');
              let nl = recvBuf.indexOf('\n');
              while (nl !== -1) {
                const line = recvBuf.slice(0, nl);
                recvBuf = recvBuf.slice(nl + 1);
                if (line.length > 0) {
                  const frame = JSON.parse(line) as { ok?: boolean; error?: string; stream?: string; data?: string; done?: boolean; exitCode?: number };
                  if (frame.ok === false) {
                    rejectStream(new Error(frame.error ?? 'helper error'));
                    return;
                  }
                  if (frame.stream === 'stdout' && typeof frame.data === 'string') {
                    receivedChunks.push(Buffer.from(frame.data, 'base64'));
                  }
                  if (frame.done === true) {
                    exitCodeSeen = frame.exitCode ?? 1;
                  }
                }
                nl = recvBuf.indexOf('\n');
              }
            });
            client.on('error', rejectStream);
            client.on('close', () => resolveStream());
          });
          assert.equal(exitCodeSeen, 0);
          const combined = Buffer.concat(receivedChunks);
          assert.equal(combined.byteLength, expectedBytes);
          assert.equal(combined.every(b => b === 0x41), true);
        } finally {
          await helper.close();
        }

        // 3) Stalled socket does NOT block helper.close() even with long 5_000ms idleHeaderTimeoutMs
        const closeAbort = new AbortController();
        const helper2 = await startMacosStageSeatbeltHelper({
          outerNetworkMode: 'none',
          outerWritablePaths: [helperWork],
          outerAllowedReadOnlyPaths: [helperWork],
          outerDeniedReadPaths: new Set<string>(),
          homeDeniedSet: new Set<string>(),
          idleHeaderTimeoutMs: 5_000,
          signal: closeAbort.signal,
          registerKiller: () => () => undefined,
        });
        const stalledClient = createConnection(helper2.socketPath);
        await new Promise<void>(resolveConn => stalledClient.once('connect', () => resolveConn()));
        const closeStart = Date.now();
        await helper2.close();
        assert.ok(Date.now() - closeStart < 1_500, 'helper.close() must destroy active sockets immediately without waiting for idle timeout');
        stalledClient.destroy();

        // 4) R4-11: MAX_HELPER_CONNECTIONS (4) and MAX_HELPER_ACTIVE_STAGES (2) bounds
        assert.equal(MAX_HELPER_CONNECTIONS, 4);
        assert.equal(MAX_HELPER_ACTIVE_STAGES, 2);
        const capAbort = new AbortController();
        const helperCap = await startMacosStageSeatbeltHelper({
          outerNetworkMode: 'none',
          outerWritablePaths: [helperWork],
          outerAllowedReadOnlyPaths: [helperWork],
          outerDeniedReadPaths: new Set<string>(),
          homeDeniedSet: new Set<string>(),
          idleHeaderTimeoutMs: 5_000,
          signal: capAbort.signal,
          registerKiller: () => () => undefined,
        });
        try {
          // 4a) 5th concurrent connection is destroyed immediately
          const heldConns = await Promise.all(
            Array.from({ length: MAX_HELPER_CONNECTIONS }, () => new Promise<ReturnType<typeof createConnection>>(resConn => {
              const c = createConnection(helperCap.socketPath);
              c.once('connect', () => resConn(c));
            })),
          );
          await new Promise<void>((resFifth, rejFifth) => {
            const fifth = createConnection(helperCap.socketPath);
            const t = setTimeout(() => {
              fifth.destroy();
              rejFifth(new Error('5th connection was not immediately closed'));
            }, 1_500);
            fifth.on('error', () => undefined);
            fifth.on('close', () => {
              clearTimeout(t);
              resFifth();
            });
          });
          for (const c of heldConns) {
            c.destroy();
          }
          await new Promise<void>(r => setTimeout(r, 30));

          // 4b) 3rd concurrent active stage receives ok: false while 2 stages are running
          const runHelperExec = (pyCode: string): Promise<Record<string, unknown>[]> => new Promise((resExec, rejExec) => {
            const sock = createConnection(helperCap.socketPath);
            let buf = '';
            sock.on('connect', () => {
              sock.write(`${JSON.stringify({
                op: 'exec',
                argv: ['/usr/bin/python3', '-I', '-S', '-B', '-c', pyCode],
                cwd: helperWork,
                env: { PATH: '/usr/bin:/bin', HOME: helperWork, TMPDIR: helperWork },
                allowedReadRoots: [helperWork],
                deniedReadRoots: [],
                writablePaths: [helperWork],
                readOnlyMasks: [],
                networkMode: 'none',
              })}\n`);
            });
            sock.on('data', d => { buf += d.toString('utf8'); });
            sock.on('error', rejExec);
            sock.on('close', () => {
              const frames = buf.split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>);
              resExec(frames);
            });
          });

          const stage1 = runHelperExec('import time; time.sleep(0.35)');
          const stage2 = runHelperExec('import time; time.sleep(0.35)');
          await new Promise<void>(r => setTimeout(r, 100));
          const stage3Frames = await runHelperExec('import sys; sys.exit(0)');
          assert.equal(stage3Frames[0]?.['ok'], false, `expected 3rd concurrent stage to be rejected: ${JSON.stringify(stage3Frames)}`);
          const [f1, f2] = await Promise.all([stage1, stage2]);
          assert.equal(f1.at(-1)?.['exitCode'], 0);
          assert.equal(f2.at(-1)?.['exitCode'], 0);
          const afterFrames = await runHelperExec('import sys; sys.exit(0)');
          assert.equal(afterFrames.at(-1)?.['exitCode'], 0, 'subsequent stage after active slots drain must succeed');
        } finally {
          await helperCap.close();
        }
      }

      // 3. Live command.v1 OS containment blocks ungranted sibling outside repoRoot/runRoot/tmpdir AND enforces macOS per-stage none vs loopback-only helper
      const loopbackProbeServer = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('LOOPBACK_OK');
      });
      await new Promise<void>(resolveListen => loopbackProbeServer.listen(0, '127.0.0.1', () => resolveListen()));
      const loopbackPort = (loopbackProbeServer.address() as { port: number }).port;

      try {
        await mkdir(join(repoRoot, '.loopwright', 'checks'), { recursive: true });
        await mkdir(join(repoRoot, '.loopwright', 'scripts'), { recursive: true });
        await mkdir(join(repoRoot, 'src'), { recursive: true });
        await writeFile(join(repoRoot, 'src', 'target.txt'), 'v1\n', 'utf8');
        await writeFile(
          join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs'),
          `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const staging = process.env.LOOPWRIGHT_STAGING_DIR;
writeFileSync(join(staging, 'agent-secret.txt'), 'TOP_SECRET_AGENT_ONLY\\n', 'utf8');
writeFileSync(join(staging, 'public-check.txt'), 'PUBLIC_CHECK_OK\\n', 'utf8');
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'candidate',
  stagedResources: [
    { id: 'secret-ws', kind: 'document', path: 'agent-secret.txt', mount: 'workspace', exposeToChecks: false },
    { id: 'public-ws', kind: 'document', path: 'public-check.txt', mount: 'workspace', exposeToChecks: true },
  ],
}));\n`,
          'utf8',
        );
        await writeFile(
          join(repoRoot, '.loopwright', 'checks', 'contain-check.sh'),
          [
            '#!/bin/sh',
            'set -eu',
            'STAGE_PARENT="$(dirname "$LOOPWRIGHT_STAGED_DIR")"',
            '# Reading ungranted sibling in $HOME (outside repoRoot, runRoot, and tmpdir) MUST fail under positive read grants',
            'if cat "$UNGRANTED_HOME_FILE" >/dev/null 2>&1; then echo "READ_UNGRANTED_HOME_SIBLING_LEAK"; exit 20; fi',
            '# Reading non-exposeToChecks workspace-staged file, secrets.json, and host repo .git/config MUST fail',
            'if cat "$AGENT_WS_FILE" >/dev/null 2>&1; then echo "READ_AGENT_WS_LEAK"; exit 21; fi',
            'if cat "$STAGE_PARENT/secrets.json" >/dev/null 2>&1; then echo "READ_SECRETS_JSON_LEAK"; exit 22; fi',
            'if cat "$REPO_ROOT_PATH/.git/config" >/dev/null 2>&1; then echo "READ_REPO_GIT_CONFIG_LEAK"; exit 23; fi',
            '# Writing to read-only baseDir, stagedDir, declaredStageDir, or host repoRoot MUST fail',
            'if sh -c \'echo hacked > "$LOOPWRIGHT_BASE_DIR/hacked.txt"\' >/dev/null 2>&1; then echo "WRITE_BASE_LEAK"; exit 24; fi',
            'if sh -c \'echo hacked > "$LOOPWRIGHT_STAGED_DIR/hacked.txt"\' >/dev/null 2>&1; then echo "WRITE_STAGED_LEAK"; exit 25; fi',
            'if sh -c \'echo hacked > "$DECLARED_STAGE_DIR/hacked.txt"\' >/dev/null 2>&1; then echo "WRITE_DECLARED_STAGE_LEAK"; exit 26; fi',
            'if sh -c \'echo hacked > "$REPO_ROOT_PATH/hacked.txt"\' >/dev/null 2>&1; then echo "WRITE_REPO_LEAK"; exit 27; fi',
            '# Reading candidateDir, baseDir, exposeToChecks LOOPWRIGHT_STAGED_DIR, and declared stage dir + writing disposable candidateDir & TMPDIR MUST succeed',
            'grep -q "v2" "$LOOPWRIGHT_CANDIDATE_DIR/src/target.txt"',
            'grep -q "v1" "$LOOPWRIGHT_BASE_DIR/src/target.txt"',
            'grep -q "PUBLIC_CHECK_OK" "$LOOPWRIGHT_STAGED_DIR/public-check.txt"',
            'grep -q "DECLARED_STAGE_OK" "$DECLARED_STAGE_DIR/cache.txt"',
            'echo "build-temp-ok" > "$LOOPWRIGHT_CANDIDATE_DIR/scratch-build.txt"',
            'grep -q "build-temp-ok" "$LOOPWRIGHT_CANDIDATE_DIR/scratch-build.txt"',
            'echo "scratch-ok" > "$TMPDIR/scratch.txt"',
            'grep -q "scratch-ok" "$TMPDIR/scratch.txt"',
            '# On macOS, verify LOOPWRIGHT_MACOS_SB_SOCK enforces genuine per-stage none vs loopback-only and monotonic tightening',
            'if [ "$(uname -s)" = "Darwin" ]; then',
            '  test -n "${LOOPWRIGHT_MACOS_SB_SOCK:-}"',
            '  mkdir -p "$TMPDIR/stage-work/masked"',
            '  echo "immutable" > "$TMPDIR/stage-work/masked/locked.txt"',
            '  python3 - <<\'PY\'',
            'import json, os, socket, sys',
            'sock_path = os.environ["LOOPWRIGHT_MACOS_SB_SOCK"]',
            'tmp_dir = os.path.realpath(os.environ["TMPDIR"])',
            'stage_work = os.path.join(tmp_dir, "stage-work")',
            'masked_dir = os.path.join(stage_work, "masked")',
            'port = int(os.environ["LOOPBACK_PROBE_PORT"])',
            'ungranted = os.environ["UNGRANTED_HOME_FILE"]',
            '',
            'def call_helper(payload):',
            '    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:',
            '        s.connect(sock_path)',
            '        s.sendall((json.dumps(payload) + "\\n").encode("utf-8"))',
            '        buf = b""',
            '        while True:',
            '            chunk = s.recv(65536)',
            '            if not chunk:',
            '                break',
            '            buf += chunk',
            '    frames = [json.loads(line.decode("utf-8")) for line in buf.splitlines() if line.strip()]',
            '    return frames',
            '',
            '# 1) Stage with networkMode="none" MUST block 127.0.0.1 loopback AND readOnlyMasks writes',
            'none_py = f"""import errno, os, socket, sys',
            'try:',
            '    s = socket.create_connection(("127.0.0.1", {port}), timeout=1.0)',
            '    s.close()',
            '    sys.exit(31)',
            'except OSError:',
            '    pass',
            'try:',
            '    open({masked_dir!r} + "/locked.txt", "w").close()',
            '    sys.exit(32)',
            'except OSError:',
            '    pass',
            'with open({stage_work!r} + "/ok.txt", "w") as f:',
            '    f.write("ok")',
            '"""',
            'f_none = call_helper({',
            '    "op": "exec",',
            '    "argv": [sys.executable, "-c", none_py],',
            '    "cwd": stage_work,',
            '    "env": {"PATH": "/usr/bin:/bin", "HOME": tmp_dir, "TMPDIR": tmp_dir},',
            '    "allowedReadRoots": [stage_work, os.path.dirname(os.path.dirname(os.path.realpath(sys.executable)))],',
            '    "deniedReadRoots": [],',
            '    "writablePaths": [stage_work],',
            '    "readOnlyMasks": [masked_dir],',
            '    "networkMode": "none",',
            '})',
            'assert f_none[-1].get("done") is True and f_none[-1].get("exitCode") == 0, f_none',
            '',
            '# 2) Stage with networkMode="loopback-only" MUST allow 127.0.0.1 while blocking 192.0.2.1:80',
            'loop_py = f"""import errno, socket, sys',
            's = socket.create_connection(("127.0.0.1", {port}), timeout=2.0)',
            's.close()',
            'ext = socket.socket(socket.AF_INET, socket.SOCK_STREAM)',
            'ext.setblocking(False)',
            'try:',
            '    ext.connect(("192.0.2.1", 80))',
            '    sys.exit(33)',
            'except PermissionError:',
            '    pass',
            'except OSError as e:',
            '    if e.errno not in (errno.EPERM, errno.EACCES):',
            '        sys.exit(34)',
            'finally:',
            '    ext.close()',
            '"""',
            'f_loop = call_helper({',
            '    "op": "exec",',
            '    "argv": [sys.executable, "-c", loop_py],',
            '    "cwd": stage_work,',
            '    "env": {"PATH": "/usr/bin:/bin", "HOME": tmp_dir, "TMPDIR": tmp_dir},',
            '    "allowedReadRoots": [stage_work, os.path.dirname(os.path.dirname(os.path.realpath(sys.executable)))],',
            '    "deniedReadRoots": [],',
            '    "writablePaths": [stage_work],',
            '    "readOnlyMasks": [],',
            '    "networkMode": "loopback-only",',
            '})',
            'assert f_loop[-1].get("done") is True and f_loop[-1].get("exitCode") == 0, f_loop',
            '',
            '# 3) Policy widening (allow-outbound, ungranted read root, or ungranted writable path) MUST be rejected',
            'for bad_req in [',
            '    {"op": "exec", "argv": ["/usr/bin/true"], "cwd": stage_work, "env": {}, "allowedReadRoots": [stage_work], "writablePaths": [stage_work], "networkMode": "allow-outbound"},',
            '    {"op": "exec", "argv": ["/usr/bin/true"], "cwd": stage_work, "env": {}, "allowedReadRoots": [os.path.dirname(ungranted)], "writablePaths": [stage_work], "networkMode": "none"},',
            '    {"op": "exec", "argv": ["/usr/bin/true"], "cwd": stage_work, "env": {}, "allowedReadRoots": [stage_work], "writablePaths": ["/private/tmp"], "networkMode": "none"},',
            ']:',
            '    resp = call_helper(bad_req)',
            '    assert resp[0].get("ok") is False, resp',
            'PY',
            'fi',
            'printf \'{"detail":"OS containment verified"}\\n\' > "$LOOPWRIGHT_CHECK_OUT"',
          ].join('\n') + '\n',
          { mode: 0o755 },
        );
        const canEnforceLoopbackNetns = process.platform === 'darwin'
          || (
            process.platform === 'linux'
            && ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap'].some(
              candidate => existsSync(candidate)
                && spawnSync(candidate, ['--unshare-pid', '--unshare-net', '--ro-bind', '/', '/', '--', '/bin/true'], { stdio: 'ignore' }).status === 0,
            )
          );
        await writeFile(
          join(repoRoot, '.loopwright', 'taskpack.yaml'),
          serializePrettyYaml({
            apiVersion: 'loopwright.dev/v1alpha1',
            kind: 'Taskpack',
            metadata: { name: 'contain-gate' },
            spec: {
              goal: { candidate: 'Update target.txt.', noChange: 'Confirm no change.' },
              execution: { mode: 'strict', capabilities: { allowHostPath: true, allowCheckNetwork: true } },
              preflight: {
                script: '.loopwright/scripts/preflight.mjs',
                timeoutSeconds: 20,
              },
              scope: { writable: ['src/**'], protected: [] },
              verification: {
                localChecks: [
                  {
                    id: 'contain-check',
                    implementation: 'command.v1',
                    parameters: {
                      script: '.loopwright/checks/contain-check.sh',
                      timeoutSeconds: 20,
                      networkMode: canEnforceLoopbackNetns ? 'loopback-only' : 'none',
                      env: ['REPO_ROOT_PATH', 'AGENT_WS_FILE', 'UNGRANTED_HOME_FILE', 'DECLARED_STAGE_DIR', 'LOOPBACK_PROBE_PORT'],
                    },
                  },
                ],
                externalGates: [],
              },
            },
          }),
          'utf8',
        );
        initGitRepo(repoRoot);

        const runId = 'contain-run-1';
        const staged = await stageTaskpackForStep({
          taskpackPath: '.loopwright/taskpack.yaml',
          repositoryRoot: repoRoot,
          runRoot,
          runId,
          allowPrivileged: true,
          runtimeEnv: { REPO_ROOT_PATH: repoRoot },
        });
        assert.ok(staged.workspaceStagedDir !== undefined);
        assert.ok(staged.checkStagedDir !== undefined);
        const agentWsFile = join(staged.workspaceStagedDir!, 'agent-secret.txt');
        assert.equal(await readFile(agentWsFile, 'utf8'), 'TOP_SECRET_AGENT_ONLY\n');

        const declaredStageDir = join(holder, 'declared-stage-cache');
        await mkdir(declaredStageDir, { recursive: true });
        await writeFile(join(declaredStageDir, 'cache.txt'), 'DECLARED_STAGE_OK\n', 'utf8');

        const gateHandle = await openStagedTaskpackStepGate({
          runRoot,
          runId,
          runtimeEnv: {
            PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
            REPO_ROOT_PATH: repoRoot,
            AGENT_WS_FILE: agentWsFile,
            UNGRANTED_HOME_FILE: ungrantedHomeSiblingFile,
            DECLARED_STAGE_DIR: declaredStageDir,
            LOOPBACK_PROBE_PORT: String(loopbackPort),
          },
        });
        assert.ok(gateHandle !== null);
        try {
          const prevSecret = process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
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
            if (prevSecret === undefined) {
              delete process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
            } else {
              process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = prevSecret;
            }
          }
          assert.equal(loadedCfg.ok, true);
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
          assert.equal(next.ok, true);
          if (!next.ok || next.value.kind !== 'step') return;

          await writeFile(join(next.value.candidateDir, 'src', 'target.txt'), 'v2\n', 'utf8');
          const sub = await stepSubmit(
            {
              runRoot,
              runId,
              leaseToken: next.value.leaseToken,
              status: 'completed',
              reason: 'updated target.txt',
              environment: gateHandle.environment,
            },
            gateHandle.ports,
          );
          assert.equal(sub.ok, true, sub.ok ? '' : JSON.stringify(sub.error));
          if (!sub.ok) return;
          assert.equal(
            sub.value.kind === 'result' ? sub.value.result.spec.status : JSON.stringify(sub.value),
            'completed',
          );
          await assert.rejects(stat(join(repoRoot, 'hacked.txt')), { code: 'ENOENT' });
          await assert.rejects(stat(join(repoRoot, 'scratch-build.txt')), { code: 'ENOENT' });
          await assert.rejects(stat(join(declaredStageDir, 'hacked.txt')), { code: 'ENOENT' });
        } finally {
          await gateHandle.close();
        }
      } finally {
        await new Promise<void>(resolveClose => loopbackProbeServer.close(() => resolveClose()));
      }
    } finally {
      await rm(ungrantedHomeSiblingDir, { recursive: true, force: true }).catch(() => undefined);
      await removeTreeForceTest(holder);
    }
  });
});
