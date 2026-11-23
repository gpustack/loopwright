import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import type { ControllerIncident } from '@loopwright/controller';
import { admitTask, digestArtifact } from '@loopwright/core';
import { loadMemoryStore } from '@loopwright/memory';
import {
  compileDeclarativeTaskpack,
  DEFAULT_HOST_BUDGETS,
  finalizeAndPublishTurnkeyMemory,
  runActionCli,
  runGitHubActionEntrypoint,
  SecretScrubber,
  serializePrettyYaml,
  validateTaskpackV2Manifest,
  type Json,
} from '../src/index.js';

const execFileAsync = promisify(execFile);

const GIT_TEST_ENV: Record<string, string> = {
  PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
  HOME: process.env['HOME'] ?? '/tmp',
  LANG: 'C',
  LC_ALL: 'C',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
};

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    '/usr/bin/git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test Bot', '-c', 'user.email=test@example.com', '-C', cwd, ...args],
    { env: GIT_TEST_ENV, encoding: 'utf8', timeout: 15_000 },
  );
  return stdout.trim();
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
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind mock HTTP server');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => await new Promise<void>(resolve => server.close(() => resolve())),
  };
}

describe('github-app turnkey-memory hardware TargetMatrixCell projection', () => {
  it('projects hardware-bearing target.matrix cells to { id, platform, variant } for separate-pull-request memory publication', async () => {
    const baseTmp = await realpath(tmpdir());
    const work = await mkdtemp(join(baseTmp, 'lw-gh-hw-mem-'));
    const bareRemote = join(work, 'remote.git');
    const repo = join(work, 'repo');
    const runRoot = join(work, 'runs');
    await mkdir(bareRemote, { recursive: true });
    await mkdir(repo, { recursive: true });
    await mkdir(runRoot, { recursive: true, mode: 0o700 });

    const prPayloads: unknown[] = [];
    const githubServer = await startHttpServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/repos/acme/kernel-repo/pulls') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([]));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/repos/acme/kernel-repo/pulls') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        prPayloads.push(body);
        const headRef = String(body['head'] ?? '');
        const lsOut = await git(repo, ['ls-remote', bareRemote, `refs/heads/${headRef}`]);
        const remoteSha = lsOut.split(/\s+/)[0] ?? '';
        const baseSha = await git(repo, ['rev-parse', 'HEAD']);
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          number: 88,
          state: 'open',
          html_url: 'https://github.invalid/acme/kernel-repo/pull/88',
          head: { ref: headRef, sha: remoteSha, repo: { full_name: 'acme/kernel-repo', fork: false } },
          base: { ref: 'main', sha: baseSha, repo: { full_name: 'acme/kernel-repo', fork: false } },
        }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'not found' }));
    });

    try {
      await git(bareRemote, ['init', '--bare', '-b', 'main']);
      await git(repo, ['init', '-b', 'main']);
      await mkdir(join(repo, '.auto-sync'), { recursive: true });
      await mkdir(join(repo, 'src'), { recursive: true });
      await writeFile(join(repo, 'src', 'kernel.cu'), '// initial kernel\n', 'utf8');

      const manifestObj = {
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'Taskpack',
        metadata: { name: 'kernel-bench' },
        spec: {
          goal: {
            candidate: 'Optimize CUDA kernel.',
            noChange: 'No change needed.',
          },
          scope: {
            writable: ['src/**'],
            protected: [],
          },
          target: {
            matrix: [
              {
                id: 'h100-sxm',
                platform: 'linux/amd64',
                variant: 'cuda12',
                hardware: {
                  accelerator: 'sm_90a',
                  isolationMode: 'whole_device',
                  deviceCount: 1,
                  driverConstraint: '>=550.54',
                  topology: 'nvlink',
                },
              },
            ],
          },
          verification: {
            localChecks: [],
            externalGates: [
              {
                id: 'bench-h100',
                implementation: 'benchmark-gate.v1',
                gateId: 'Roofline Gate v1',
                endpointId: 'bench-relay',
                required: true,
                targetCellId: 'h100-sxm',
                heldOutWorkloadId: 'kernel.matmul.v1',
                maxPreemptions: 2,
              },
            ],
          },
          publication: {
            mode: 'pull_request',
            targetBranch: 'main',
            headBranchPrefix: 'loopwright/',
            titleTemplate: 'perf(kernel): optimize matmul',
          },
          memory: {
            directory: '.auto-sync/memory/kernel-bench',
            apply: 'separate-pull-request',
            onNoModelBudget: 'deterministic-observations-only',
            publishOnFailure: true,
          },
          triggers: {
            schedule: false,
            workflowDispatch: true,
            releasePublished: false,
            commentCommands: [],
          },
        },
      };

      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), serializePrettyYaml(manifestObj), 'utf8');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'init']);
      await git(repo, ['remote', 'add', 'origin', bareRemote]);
      await git(repo, ['push', '-u', 'origin', 'main']);
      const headSha = await git(repo, ['rev-parse', 'HEAD']);

      const manifest = validateTaskpackV2Manifest(manifestObj as Json, {
        policyProfile: 'github',
        controlRoot: '.auto-sync',
        manifestPath: '.auto-sync/taskpack.yaml',
      });

      const compiled = await compileDeclarativeTaskpack(manifest, {
        mode: 'candidate',
        executionMode: 'delegated',
        hostPolicy: { policyProfile: 'github' },
        repository: 'acme/kernel-repo',
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        baseRevision: headSha,
        sourceRevision: headSha,
        budgets: DEFAULT_HOST_BUDGETS,
        gateEndpoints: [
          {
            id: 'bench-relay',
            url: 'http://127.0.0.1:42002/v1/benchmark/jobs',
            signingCredentialRef: 'bench-signing',
            authCredentialRef: null,
          },
        ],
        credentialEnvMap: { gate: 'BENCH_SIGNING_SECRET' },
      });

      const runId = 'run-gh-hw-mem-1';
      const locked = admitTask(compiled.config.spec.task, { admissionId: 'adm-gh-hw-1', runId });
      assert.equal(locked.ok, true);
      if (!locked.ok) throw new Error('admitTask failed');

      const runDir = join(runRoot, runId);
      const artifactsDir = join(runDir, 'artifacts');
      await mkdir(artifactsDir, { recursive: true });
      await writeFile(join(runDir, 'run.json'), JSON.stringify({ version: 1, identity: { lock: locked.value } }), 'utf8');

      const planBytes = Buffer.from(JSON.stringify({ stage: 'execution', note: 'hardware timeout' }), 'utf8');
      const planRef = digestArtifact('plan-incident.bin', planBytes);
      assert.equal(planRef.ok, true);
      if (!planRef.ok) throw new Error('digestArtifact failed');
      await writeFile(join(artifactsDir, planRef.value.name), planBytes);

      const incident: ControllerIncident = {
        version: 1,
        code: 'DEADLINE',
        runId,
        lockHash: locked.value.spec.lockHash,
        stage: 'execution',
        knownReferences: [planRef.value],
        unavailable: ['candidate'],
        cleanup: 'complete',
      };
      await writeFile(join(artifactsDir, `incident-${runId}.bin`), JSON.stringify(incident), 'utf8');

      const scrubber = new SecretScrubber();
      scrubber.register('ghp_hw_mem_token_123456');

      const published = await finalizeAndPublishTurnkeyMemory({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest,
        repositoryFullName: 'acme/kernel-repo',
        baseRevision: headSha,
        runRoot,
        runId,
        scrubber,
        githubToken: 'ghp_hw_mem_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: bareRemote,
      });

      assert.equal(published.status, 'published', JSON.stringify(published));
      assert.equal(published.entryCount, 1);
      assert.equal(published.pullRequestNumber, 88);
      assert.equal(prPayloads.length, 1);

      const memClone = join(work, 'mem-clone');
      await git(work, ['clone', '--branch', 'loopwright/memory/kernel-bench/main', bareRemote, memClone]);
      const loadedStore = await loadMemoryStore(memClone, 'kernel-bench', 'acme/kernel-repo', '.auto-sync/memory');
      assert.equal(loadedStore.index.entries.length, 1);
      assert.deepEqual(loadedStore.index.entries[0]?.scope.targetMatrix, {
        id: 'h100-sxm',
        platform: 'linux/amd64',
        variant: 'cuda12',
      });
      assert.deepEqual({ ...loadedStore.index.entries[0]?.scope.hardwareScope }, {
        accelerator: 'sm_90a',
        driverConstraint: '>=550.54',
      });
    } finally {
      await githubServer.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('omits hardwareScope completely for non-hardware target.matrix cells in separate-pull-request publication', async () => {
    const baseTmp = await realpath(tmpdir());
    const work = await mkdtemp(join(baseTmp, 'lw-gh-nohw-mem-'));
    const bareRemote = join(work, 'remote.git');
    const repo = join(work, 'repo');
    const runRoot = join(work, 'runs');
    await mkdir(bareRemote, { recursive: true });
    await mkdir(repo, { recursive: true });
    await mkdir(runRoot, { recursive: true, mode: 0o700 });

    const githubServer = await startHttpServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/repos/acme/cpu-repo/pulls') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([]));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/repos/acme/cpu-repo/pulls') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        const headRef = String(body['head'] ?? '');
        const lsOut = await git(repo, ['ls-remote', bareRemote, `refs/heads/${headRef}`]);
        const remoteSha = lsOut.split(/\s+/)[0] ?? '';
        const baseSha = await git(repo, ['rev-parse', 'HEAD']);
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          number: 89,
          state: 'open',
          html_url: 'https://github.invalid/acme/cpu-repo/pull/89',
          head: { ref: headRef, sha: remoteSha, repo: { full_name: 'acme/cpu-repo', fork: false } },
          base: { ref: 'main', sha: baseSha, repo: { full_name: 'acme/cpu-repo', fork: false } },
        }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'not found' }));
    });

    try {
      await git(bareRemote, ['init', '--bare', '-b', 'main']);
      await git(repo, ['init', '-b', 'main']);
      await mkdir(join(repo, '.auto-sync'), { recursive: true });
      await mkdir(join(repo, 'src'), { recursive: true });
      await writeFile(join(repo, 'src', 'app.ts'), '// app\n', 'utf8');

      const manifestObj = {
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'Taskpack',
        metadata: { name: 'cpu-task' },
        spec: {
          goal: { candidate: 'Update app.', noChange: 'No change.' },
          scope: { writable: ['src/**'], protected: [] },
          target: {
            matrix: [{ id: 'cpu-linux', platform: 'linux/amd64', variant: 'node26' }],
          },
          verification: {
            localChecks: [{ id: 'scope-check', implementation: 'scope.v1' }],
            externalGates: [],
          },
          publication: {
            mode: 'pull_request',
            targetBranch: 'main',
            headBranchPrefix: 'loopwright/',
            titleTemplate: 'chore: update app',
          },
          memory: {
            directory: '.auto-sync/memory/cpu-task',
            apply: 'separate-pull-request',
            onNoModelBudget: 'deterministic-observations-only',
            publishOnFailure: true,
          },
          triggers: { schedule: false, workflowDispatch: true, releasePublished: false, commentCommands: [] },
        },
      };
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), serializePrettyYaml(manifestObj), 'utf8');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'init']);
      await git(repo, ['remote', 'add', 'origin', bareRemote]);
      await git(repo, ['push', '-u', 'origin', 'main']);
      const headSha = await git(repo, ['rev-parse', 'HEAD']);

      const manifest = validateTaskpackV2Manifest(manifestObj as Json, {
        policyProfile: 'github',
        controlRoot: '.auto-sync',
        manifestPath: '.auto-sync/taskpack.yaml',
      });
      const compiled = await compileDeclarativeTaskpack(manifest, {
        mode: 'candidate',
        executionMode: 'delegated',
        hostPolicy: { policyProfile: 'github' },
        repository: 'acme/cpu-repo',
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        baseRevision: headSha,
        sourceRevision: headSha,
        budgets: DEFAULT_HOST_BUDGETS,
      });

      const runId = 'run-gh-nohw-mem-1';
      const locked = admitTask(compiled.config.spec.task, { admissionId: 'adm-gh-nohw-1', runId });
      assert.equal(locked.ok, true);
      if (!locked.ok) throw new Error('admitTask failed');
      const runDir = join(runRoot, runId);
      const artifactsDir = join(runDir, 'artifacts');
      await mkdir(artifactsDir, { recursive: true });
      await writeFile(join(runDir, 'run.json'), JSON.stringify({ version: 1, identity: { lock: locked.value } }), 'utf8');
      const planBytes = Buffer.from(JSON.stringify({ stage: 'execution', note: 'cpu timeout' }), 'utf8');
      const planRef = digestArtifact('plan-incident.bin', planBytes);
      assert.equal(planRef.ok, true);
      if (!planRef.ok) throw new Error('digestArtifact failed');
      await writeFile(join(artifactsDir, planRef.value.name), planBytes);
      const incident: ControllerIncident = {
        version: 1,
        code: 'DEADLINE',
        runId,
        lockHash: locked.value.spec.lockHash,
        stage: 'execution',
        knownReferences: [planRef.value],
        unavailable: ['candidate'],
        cleanup: 'complete',
      };
      await writeFile(join(artifactsDir, `incident-${runId}.bin`), JSON.stringify(incident), 'utf8');

      const scrubber = new SecretScrubber();
      scrubber.register('ghp_nohw_mem_token_123456');
      const published = await finalizeAndPublishTurnkeyMemory({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        manifest,
        repositoryFullName: 'acme/cpu-repo',
        baseRevision: headSha,
        runRoot,
        runId,
        scrubber,
        githubToken: 'ghp_nohw_mem_token_123456',
        apiBaseUrl: githubServer.url,
        remoteUrl: bareRemote,
      });
      assert.equal(published.status, 'published', JSON.stringify(published));
      const memClone = join(work, 'mem-clone');
      await git(work, ['clone', '--branch', 'loopwright/memory/cpu-task/main', bareRemote, memClone]);
      const loadedStore = await loadMemoryStore(memClone, 'cpu-task', 'acme/cpu-repo', '.auto-sync/memory');
      assert.equal(loadedStore.index.entries.length, 1);
      const scope = loadedStore.index.entries[0]!.scope as unknown as Record<string, unknown>;
      assert.equal(Object.hasOwn(scope, 'hardwareScope'), false);
    } finally {
      await githubServer.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('forwards byCredentialRef and gateAuth through runGitHubActionEntrypoint and blocks MCP overlap', async () => {
    const baseTmp = await realpath(tmpdir());
    const work = await mkdtemp(join(baseTmp, 'lw-gh-action-bench-'));
    const repo = join(work, 'repo');
    const runRoot = join(work, 'runs');
    await mkdir(join(repo, '.auto-sync'), { recursive: true });
    await mkdir(join(repo, 'src'), { recursive: true });
    await mkdir(runRoot, { recursive: true, mode: 0o700 });
    try {
      await git(repo, ['init', '-b', 'main']);
      await writeFile(join(repo, 'src', 'kernel.cu'), '// kernel\n', 'utf8');
      const baseManifestObj = {
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'Taskpack',
        metadata: { name: 'action-bench' },
        spec: {
          goal: { candidate: 'Optimize CUDA kernel.', noChange: 'No change.' },
          scope: { writable: ['src/**'], protected: [] },
          target: {
            matrix: [
              {
                id: 'h100-sxm',
                platform: 'linux/amd64',
                variant: 'cuda12',
                hardware: { accelerator: 'sm_90a', isolationMode: 'whole_device', deviceCount: 1 },
              },
            ],
          },
          verification: {
            localChecks: [],
            externalGates: [
              {
                id: 'bench-h100',
                implementation: 'benchmark-gate.v1',
                gateId: 'Roofline Gate v1',
                endpointId: 'bench-relay',
                required: true,
                targetCellId: 'h100-sxm',
                heldOutWorkloadId: 'kernel.matmul.v1',
              },
            ],
          },
          publication: { mode: 'disabled' },
          memory: {
            directory: '.auto-sync/memory/action-bench',
            apply: 'disabled',
          },
          triggers: {
            schedule: false,
            workflowDispatch: true,
            releasePublished: false,
            commentCommands: [],
          },
        },
      };
      const upstreamRecords = [
        { upstreamId: 'kernel-src', status: 'available' as const, version: '2.0.0', watchedPaths: ['src/**'] },
      ];
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), serializePrettyYaml(baseManifestObj), 'utf8');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'init']);
      const headSha = await git(repo, ['rev-parse', 'HEAD']);

      const actionRes = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        runRoot,
        runId: 'run-action-bench-1',
        mode: 'candidate',
        repositoryFullName: 'acme/kernel-repo',
        baseRevision: headSha,
        eventName: 'workflow_dispatch',
        upstreamRecords,
        dryRun: true,
        env: {
          ...process.env,
          OPENAI_API_KEY: 'sk-test-action-12345',
          CUSTOM_BENCH_SIGN: 'custom-bench-sign-secret',
          CUSTOM_BENCH_AUTH: 'custom-bench-auth-token',
        },
        gateEndpoints: [
          {
            id: 'bench-relay',
            implementation: 'benchmark-gate.v1',
            url: 'http://127.0.0.1:42050/v1/benchmark/jobs',
            signingCredentialRef: 'bench-signing',
            authCredentialRef: 'bench-auth',
          },
        ],
        credentialEnvMap: {
          provider: 'OPENAI_API_KEY',
          byCredentialRef: {
            'bench-signing': 'CUSTOM_BENCH_SIGN',
            'bench-auth': 'CUSTOM_BENCH_AUTH',
          },
        },
      });
      assert.equal(actionRes.kind, 'compiled', JSON.stringify(actionRes));
      if (actionRes.kind === 'compiled') {
        const creds = actionRes.taskpack.config.spec.credentials;
        assert.equal(creds.find(c => c.ref === 'bench-signing')?.template, '${CUSTOM_BENCH_SIGN}');
        assert.equal(creds.find(c => c.ref === 'bench-auth')?.template, '${CUSTOM_BENCH_AUTH}');
      }

      // MCP server referencing CUSTOM_BENCH_SIGN fails closed through the Action entry point
      const mcpLeakManifestObj = {
        ...baseManifestObj,
        spec: {
          ...baseManifestObj.spec,
          mcp: {
            servers: [
              { id: 'leak-mcp', transport: 'http', url: 'https://mcp.example.test/sse', bearerTokenEnv: 'CUSTOM_BENCH_SIGN' },
            ],
          },
        },
      };
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), serializePrettyYaml(mcpLeakManifestObj), 'utf8');
      const runRootLeak = join(work, 'runs-leak');
      await mkdir(runRootLeak, { recursive: true, mode: 0o700 });
      const leakRes = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        runRoot: runRootLeak,
        runId: 'run-action-bench-leak',
        mode: 'candidate',
        repositoryFullName: 'acme/kernel-repo',
        baseRevision: headSha,
        eventName: 'workflow_dispatch',
        upstreamRecords,
        dryRun: true,
        env: {
          ...process.env,
          OPENAI_API_KEY: 'sk-test-action-12345',
          CUSTOM_BENCH_SIGN: 'custom-bench-sign-secret',
          CUSTOM_BENCH_AUTH: 'custom-bench-auth-token',
        },
        gateEndpoints: [
          {
            id: 'bench-relay',
            implementation: 'benchmark-gate.v1',
            url: 'http://127.0.0.1:42050/v1/benchmark/jobs',
            signingCredentialRef: 'bench-signing',
            authCredentialRef: 'bench-auth',
          },
        ],
        credentialEnvMap: {
          provider: 'OPENAI_API_KEY',
          byCredentialRef: {
            'bench-signing': 'CUSTOM_BENCH_SIGN',
            'bench-auth': 'CUSTOM_BENCH_AUTH',
          },
        },
      });
      assert.equal(leakRes.kind, 'blocked', JSON.stringify(leakRes));

      // Standalone gateAuth fallback forwards cleanly through runGitHubActionEntrypoint
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), serializePrettyYaml(baseManifestObj), 'utf8');
      const runRootGateAuth = join(work, 'runs-gate-auth');
      await mkdir(runRootGateAuth, { recursive: true, mode: 0o700 });
      const gateAuthRes = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        runRoot: runRootGateAuth,
        runId: 'run-action-gate-auth',
        mode: 'candidate',
        repositoryFullName: 'acme/kernel-repo',
        baseRevision: headSha,
        eventName: 'workflow_dispatch',
        upstreamRecords,
        dryRun: true,
        env: {
          ...process.env,
          OPENAI_API_KEY: 'sk-test-action-12345',
          CUSTOM_BENCH_SIGN: 'custom-bench-sign-secret',
          STANDALONE_GATE_AUTH: 'standalone-gate-auth-token',
        },
        gateEndpoints: [
          {
            id: 'bench-relay',
            implementation: 'benchmark-gate.v1',
            url: 'http://127.0.0.1:42050/v1/benchmark/jobs',
            signingCredentialRef: 'bench-signing',
            authCredentialRef: 'bench-auth',
          },
        ],
        credentialEnvMap: {
          provider: 'OPENAI_API_KEY',
          gate: 'CUSTOM_BENCH_SIGN',
          gateAuth: 'STANDALONE_GATE_AUTH',
        },
      });
      assert.equal(gateAuthRes.kind, 'compiled', JSON.stringify(gateAuthRes));
      if (gateAuthRes.kind === 'compiled') {
        const creds = gateAuthRes.taskpack.config.spec.credentials;
        assert.equal(creds.find(c => c.ref === 'bench-signing')?.template, '${CUSTOM_BENCH_SIGN}');
        assert.equal(creds.find(c => c.ref === 'bench-auth')?.template, '${STANDALONE_GATE_AUTH}');
      }

      // Multi-candidate probe MUST refuse BEFORE firing any probe fetch when a candidate source overlaps a gate env
      const multiModelManifestObj = {
        ...baseManifestObj,
        spec: {
          ...baseManifestObj.spec,
          models: [
            { provider: 'openai', id: 'gpt-4.1-mini' },
            { provider: 'anthropic', id: 'claude-sonnet-4-5' },
          ],
        },
      };
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), serializePrettyYaml(multiModelManifestObj), 'utf8');
      const runRootProbe = join(work, 'runs-probe');
      await mkdir(runRootProbe, { recursive: true, mode: 0o700 });
      let probeCalls = 0;
      const probeRes = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        runRoot: runRootProbe,
        runId: 'run-action-probe-overlap',
        mode: 'candidate',
        repositoryFullName: 'acme/kernel-repo',
        baseRevision: headSha,
        eventName: 'workflow_dispatch',
        upstreamRecords,
        dryRun: false,
        turnkey: true,
        probeFetch: async () => {
          probeCalls += 1;
          return new Response('{}', { status: 200 });
        },
        env: {
          ...process.env,
          CUSTOM_OPENAI_OVERRIDE_KEY: 'sk-a,sk-b',
          ANTHROPIC_API_KEY: 'sk-ant-test',
          LOOPWRIGHT_GATE_SIGNING_SECRET: 'default-gate-secret',
        },
        gateEndpoints: [
          {
            id: 'bench-relay',
            implementation: 'benchmark-gate.v1',
            url: 'http://127.0.0.1:42050/v1/benchmark/jobs',
            signingCredentialRef: 'bench-signing',
            authCredentialRef: null,
          },
        ],
        credentialEnvMap: {
          provider: 'GENERAL_FALLBACK_KEY',
          byProvider: { openai: 'CUSTOM_OPENAI_OVERRIDE_KEY' },
          byCredentialRef: { 'bench-signing': 'CUSTOM_OPENAI_OVERRIDE_KEY' },
        },
      });
      assert.equal(probeCalls, 0, 'provider readiness probe must NOT fire when provider source overlaps a host gate credential');
      assert.equal(probeRes.kind, 'refused', JSON.stringify(probeRes));
      if (probeRes.kind === 'refused') {
        assert.equal(probeRes.code, 'TASKPACK_HOST_BINDING_INVALID');
      }

      // Readiness & Pi execution parity:
      // (a) Implicit author with global provider + byProvider binds ${SPECIFIC_SOURCE} (not ${GENERAL_SOURCE})
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), serializePrettyYaml(baseManifestObj), 'utf8');
      const runRootParityA = join(work, 'runs-parity-a');
      await mkdir(runRootParityA, { recursive: true, mode: 0o700 });
      const parityARes = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        runRoot: runRootParityA,
        runId: 'run-parity-implicit',
        mode: 'candidate',
        repositoryFullName: 'acme/kernel-repo',
        baseRevision: headSha,
        eventName: 'workflow_dispatch',
        upstreamRecords,
        provider: 'openai',
        model: 'gpt-5',
        dryRun: true,
        env: {
          ...process.env,
          GENERAL_SOURCE: 'sk-general-token',
          SPECIFIC_SOURCE: 'sk-specific-token',
          CUSTOM_BENCH_SIGN: 'custom-bench-sign-secret',
        },
        gateEndpoints: [
          {
            id: 'bench-relay',
            implementation: 'benchmark-gate.v1',
            url: 'http://127.0.0.1:42050/v1/benchmark/jobs',
            signingCredentialRef: 'bench-signing',
            authCredentialRef: null,
          },
        ],
        credentialEnvMap: {
          provider: 'GENERAL_SOURCE',
          byProvider: { openai: 'SPECIFIC_SOURCE' },
          byCredentialRef: { 'bench-signing': 'CUSTOM_BENCH_SIGN' },
        },
      });
      assert.equal(parityARes.kind, 'compiled', JSON.stringify(parityARes));
      if (parityARes.kind === 'compiled') {
        assert.equal(
          parityARes.taskpack.config.spec.credentials.find(c => c.ref === 'taskpack-provider-token')?.template,
          '${SPECIFIC_SOURCE}',
        );
      }

      // (b) Explicit role with token pool binds ${LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN} (matching active token injection)
      const explicitRoleManifest = {
        ...baseManifestObj,
        spec: {
          ...baseManifestObj.spec,
          roles: [
            { id: 'author', purpose: 'task', provider: 'openai', model: 'gpt-5', tools: ['read', 'write', 'edit'] },
          ],
        },
      };
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), serializePrettyYaml(explicitRoleManifest), 'utf8');
      const runRootParityB = join(work, 'runs-parity-b');
      await mkdir(runRootParityB, { recursive: true, mode: 0o700 });
      const parityBRes = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        runRoot: runRootParityB,
        runId: 'run-parity-pool',
        mode: 'candidate',
        repositoryFullName: 'acme/kernel-repo',
        baseRevision: headSha,
        eventName: 'workflow_dispatch',
        upstreamRecords,
        dryRun: true,
        env: {
          ...process.env,
          SPECIFIC_SOURCE: 'sk-pool-1,sk-pool-2',
          CUSTOM_BENCH_SIGN: 'custom-bench-sign-secret',
        },
        gateEndpoints: [
          {
            id: 'bench-relay',
            implementation: 'benchmark-gate.v1',
            url: 'http://127.0.0.1:42050/v1/benchmark/jobs',
            signingCredentialRef: 'bench-signing',
            authCredentialRef: null,
          },
        ],
        credentialEnvMap: {
          byProvider: { openai: 'SPECIFIC_SOURCE' },
          byCredentialRef: { 'bench-signing': 'CUSTOM_BENCH_SIGN' },
        },
      });
      assert.equal(parityBRes.kind, 'compiled', JSON.stringify(parityBRes));
      if (parityBRes.kind === 'compiled') {
        assert.equal(
          parityBRes.taskpack.config.spec.credentials.find(c => c.ref === 'taskpack-provider-token')?.template,
          '${LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN}',
        );
      }

      // (c) Preflight strips neutral input.providerTokenEnv and models.json apiKeyEnv even under allowHostEnv + explicit env
      await mkdir(join(repo, '.auto-sync', 'scripts'), { recursive: true });
      const preflightSeenPath = join(work, 'preflight-seen.json');
      await writeFile(
        join(repo, '.auto-sync', 'scripts', 'preflight.mjs'),
        `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(preflightSeenPath)}, JSON.stringify({
  neutralProvider: process.env.NEUTRAL_MODEL_VAR ?? null,
  modelsJsonKey: process.env.MODELS_JSON_KEY ?? null,
  allowedFlag: process.env.ALLOWED_PREFLIGHT_FLAG ?? null,
}));
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({ disposition: 'candidate' }));`,
        'utf8',
      );
      const modelsJsonPath = join(work, 'models.json');
      await writeFile(
        modelsJsonPath,
        JSON.stringify({
          providers: {
            openai: {
              api: 'openai-responses',
              baseUrl: 'https://api.openai.com/v1',
              apiKey: 'MODELS_JSON_KEY',
              models: [{ id: 'gpt-5', reasoning: true }],
            },
          },
        }),
        'utf8',
      );
      const preflightProviderManifest = {
        ...baseManifestObj,
        spec: {
          ...baseManifestObj.spec,
          execution: { mode: 'privileged', capabilities: { allowHostEnv: true } },
          preflight: {
            script: '.auto-sync/scripts/preflight.mjs',
            timeoutSeconds: 20,
            env: ['ALLOWED_PREFLIGHT_FLAG', 'NEUTRAL_MODEL_VAR', 'MODELS_JSON_KEY'],
          },
        },
      };
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), serializePrettyYaml(preflightProviderManifest), 'utf8');
      const runRootPreProv = join(work, 'runs-preflight-provider');
      await mkdir(runRootPreProv, { recursive: true, mode: 0o700 });
      const preProvRes = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        runRoot: runRootPreProv,
        runId: 'run-preflight-provider-strip',
        mode: 'candidate',
        repositoryFullName: 'acme/kernel-repo',
        baseRevision: headSha,
        eventName: 'workflow_dispatch',
        upstreamRecords,
        allowPrivilegedExecution: true,
        modelsJsonPath,
        providerTokenEnv: 'NEUTRAL_MODEL_VAR',
        dryRun: true,
        env: {
          ...process.env,
          NEUTRAL_MODEL_VAR: 'secret-neutral-provider-token',
          MODELS_JSON_KEY: 'secret-models-json-token',
          ALLOWED_PREFLIGHT_FLAG: 'visible',
          CUSTOM_BENCH_SIGN: 'custom-bench-sign-secret',
        },
        gateEndpoints: [
          {
            id: 'bench-relay',
            implementation: 'benchmark-gate.v1',
            url: 'http://127.0.0.1:42050/v1/benchmark/jobs',
            signingCredentialRef: 'bench-signing',
            authCredentialRef: null,
          },
        ],
        credentialEnvMap: {
          byCredentialRef: { 'bench-signing': 'CUSTOM_BENCH_SIGN' },
        },
      });
      assert.equal(preProvRes.kind, 'compiled', JSON.stringify(preProvRes));
      const { readFile } = await import('node:fs/promises');
      assert.deepEqual(JSON.parse(await readFile(preflightSeenPath, 'utf8')), {
        neutralProvider: null,
        modelsJsonKey: null,
        allowedFlag: 'visible',
      });

      // Turnkey MCP connection refuses effective default LOOPWRIGHT_GATE_SIGNING_SECRET even without explicit credentialEnvMap
      let mcpServerHits = 0;
      const mcpSpyServer = await startHttpServer((_req, res) => {
        mcpServerHits += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
      try {
        const defaultGateMcpManifest = {
          ...baseManifestObj,
          spec: {
            ...baseManifestObj.spec,
            verification: { localChecks: [], externalGates: [] },
            mcp: {
              servers: [
                { id: 'default-gate-leak', transport: 'http', url: `${mcpSpyServer.url}/sse`, bearerTokenEnv: 'LOOPWRIGHT_GATE_SIGNING_SECRET' },
              ],
            },
          },
        };
        await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), serializePrettyYaml(defaultGateMcpManifest), 'utf8');
        const runRootMcp = join(work, 'runs-mcp-default');
        await mkdir(runRootMcp, { recursive: true, mode: 0o700 });
        const mcpRes = await runGitHubActionEntrypoint({
          repositoryRoot: repo,
          taskpackPath: '.auto-sync/taskpack.yaml',
          runRoot: runRootMcp,
          runId: 'run-action-mcp-default-gate',
          mode: 'candidate',
          repositoryFullName: 'acme/kernel-repo',
          baseRevision: headSha,
          eventName: 'workflow_dispatch',
          upstreamRecords,
          allowManifestCustomBaseUrl: true,
          dryRun: false,
          turnkey: true,
          env: {
            ...process.env,
            OPENAI_API_KEY: 'sk-test-action-12345',
            LOOPWRIGHT_GATE_SIGNING_SECRET: 'default-signing-secret-must-not-leak',
          },
        });
        assert.equal(mcpServerHits, 0, 'MCP server must NEVER be contacted with default LOOPWRIGHT_GATE_SIGNING_SECRET');
        assert.equal(mcpRes.kind, 'blocked', JSON.stringify(mcpRes));
      } finally {
        await mcpSpyServer.close();
      }

      // Shipped Action CLI shim (runActionCli): ordinary manifest inheriting endpoint URL (NO manifest url override)
      // succeeds with gate.v1 designation, fails with benchmark-gate.v1 designation, and fails if URL is omitted.
      const ordinaryInheritedManifest = {
        ...baseManifestObj,
        spec: {
          ...baseManifestObj.spec,
          verification: {
            localChecks: [],
            externalGates: [
              {
                id: 'inherited-ordinary',
                gateId: 'ordinary-gate',
                endpointId: 'default',
                required: true,
              },
            ],
          },
        },
      };
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), serializePrettyYaml(ordinaryInheritedManifest), 'utf8');
      const runRootCliOrd = join(work, 'runs-action-cli-ord');
      const runRootCliBench = join(work, 'runs-action-cli-bench');
      const runRootCliNoUrl = join(work, 'runs-action-cli-no-url');
      await mkdir(runRootCliOrd, { recursive: true, mode: 0o700 });
      await mkdir(runRootCliBench, { recursive: true, mode: 0o700 });
      await mkdir(runRootCliNoUrl, { recursive: true, mode: 0o700 });
      const baseCliEnv = {
        ...process.env,
        GITHUB_WORKSPACE: repo,
        GITHUB_REPOSITORY: 'acme/kernel-repo',
        GITHUB_SHA: headSha,
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        'INPUT_TASKPACK-PATH': '.auto-sync/taskpack.yaml',
        'INPUT_MODE': 'candidate',
        'INPUT_DRY-RUN': 'true',
        'INPUT_UPSTREAM-RECORDS': JSON.stringify(upstreamRecords),
        OPENAI_API_KEY: 'sk-test-action-12345',
        LOOPWRIGHT_GATE_SIGNING_SECRET: 'cli-bench-signing-secret',
      };
      const cliOrdinaryExit = await runActionCli({
        ...baseCliEnv,
        'INPUT_RUN-ROOT': runRootCliOrd,
        'INPUT_RUN-ID': 'run-action-cli-ord',
        'INPUT_GATE-ENDPOINT-URL': 'https://ci.example.test/gate',
        'INPUT_GATE-ENDPOINT-IMPLEMENTATION': 'gate.v1',
      });
      assert.equal(cliOrdinaryExit, 0, 'runActionCli must accept ordinary inherited gate under gate.v1 designation');

      const cliBenchExit = await runActionCli({
        ...baseCliEnv,
        'INPUT_RUN-ROOT': runRootCliBench,
        'INPUT_RUN-ID': 'run-action-cli-bench',
        'INPUT_GATE-ENDPOINT-URL': 'https://ci.example.test/gate',
        'INPUT_GATE-ENDPOINT-IMPLEMENTATION': 'benchmark-gate.v1',
      });
      assert.notEqual(cliBenchExit, 0, 'runActionCli must reject ordinary inherited gate under benchmark-gate.v1 designation');

      // Empty explicit providerTokenEnv fails closed even when credentialEnvMap.provider is present
      const runRootEmptyProv = join(work, 'runs-empty-provider-env');
      await mkdir(runRootEmptyProv, { recursive: true, mode: 0o700 });
      const emptyProvRes = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        runRoot: runRootEmptyProv,
        runId: 'run-empty-provider-token-env',
        mode: 'candidate',
        repositoryFullName: 'acme/kernel-repo',
        baseRevision: headSha,
        eventName: 'workflow_dispatch',
        upstreamRecords,
        providerTokenEnv: '',
        dryRun: true,
        env: { ...process.env, OPENAI_API_KEY: 'sk-test-action-12345', CUSTOM_BENCH_SIGN: 'custom-bench-sign-secret' },
        gateEndpoints: [
          {
            id: 'bench-relay',
            implementation: 'benchmark-gate.v1',
            url: 'http://127.0.0.1:42050/v1/benchmark/jobs',
            signingCredentialRef: 'bench-signing',
            authCredentialRef: null,
          },
        ],
        credentialEnvMap: {
          provider: 'OPENAI_API_KEY',
          byCredentialRef: { 'bench-signing': 'CUSTOM_BENCH_SIGN' },
        },
      });
      assert.equal(emptyProvRes.kind, 'refused', JSON.stringify(emptyProvRes));
      if (emptyProvRes.kind === 'refused') {
        assert.equal(emptyProvRes.code, 'TASKPACK_HOST_BINDING_INVALID');
      }

      // Missing-URL CLI guard test: manifest has a valid manifest-level URL that succeeds WITHOUT host designation,
      // and fails closed with the missing-URL diagnostic when INPUT_GATE-ENDPOINT-IMPLEMENTATION is set with empty URL.
      const manifestWithUrl = {
        ...baseManifestObj,
        spec: {
          ...baseManifestObj.spec,
          verification: {
            localChecks: [],
            externalGates: [
              {
                id: 'manifest-url-ordinary',
                gateId: 'ordinary-gate',
                endpointId: 'default',
                required: true,
                url: 'https://manifest.example.test/gate',
                signingCredentialRef: 'MANIFEST_GATE_SECRET',
              },
            ],
          },
        },
      };
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), serializePrettyYaml(manifestWithUrl), 'utf8');
      const runRootCliNoDesig = join(work, 'runs-action-cli-no-desig');
      await mkdir(runRootCliNoDesig, { recursive: true, mode: 0o700 });
      const cliNoDesigExit = await runActionCli({
        ...baseCliEnv,
        MANIFEST_GATE_SECRET: 'manifest-gate-secret',
        'INPUT_RUN-ROOT': runRootCliNoDesig,
        'INPUT_RUN-ID': 'run-action-cli-no-desig',
      });
      assert.equal(cliNoDesigExit, 0, 'manifest with its own ordinary URL must succeed when no host designation is set');

      const stderrChunks: string[] = [];
      const origStderrWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      }) as typeof process.stderr.write;
      let cliMissingUrlExit = 0;
      try {
        cliMissingUrlExit = await runActionCli({
          ...baseCliEnv,
          MANIFEST_GATE_SECRET: 'manifest-gate-secret',
          'INPUT_RUN-ROOT': runRootCliNoUrl,
          'INPUT_RUN-ID': 'run-action-cli-no-url',
          'INPUT_GATE-ENDPOINT-URL': '',
          'INPUT_GATE-ENDPOINT-IMPLEMENTATION': 'benchmark-gate.v1',
        });
      } finally {
        process.stderr.write = origStderrWrite;
      }
      assert.equal(cliMissingUrlExit, 1, 'runActionCli must reject explicit benchmark-gate.v1 designation when URL is missing');
      assert.match(stderrChunks.join(''), /requires INPUT_GATE-ENDPOINT-URL/);

      // Action boundary competing-input precedence:
      // (a) Unpinned two-model fallback with MANIFEST_KEY & BACKUP_KEY + global credentialEnvMap.provider=GLOBAL_CHOICE
      //     keeps model-specific credentials (does not promote GLOBAL_CHOICE above per-model declarations)
      const twoModelManifest = {
        ...baseManifestObj,
        spec: {
          ...baseManifestObj.spec,
          models: [
            { provider: 'openai', id: 'gpt-5', apiKeyEnv: 'MANIFEST_KEY' },
            { provider: 'anthropic', id: 'claude-sonnet-4-5', apiKeyEnv: 'BACKUP_KEY' },
          ],
        },
      };
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), serializePrettyYaml(twoModelManifest), 'utf8');
      const runRootMultiPrec = join(work, 'runs-action-multi-prec');
      await mkdir(runRootMultiPrec, { recursive: true, mode: 0o700 });
      const multiPrecRes = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        runRoot: runRootMultiPrec,
        runId: 'run-action-multi-prec',
        mode: 'candidate',
        repositoryFullName: 'acme/kernel-repo',
        baseRevision: headSha,
        eventName: 'workflow_dispatch',
        upstreamRecords,
        dryRun: true,
        env: {
          ...process.env,
          MANIFEST_KEY: 'sk-manifest-primary',
          BACKUP_KEY: 'sk-manifest-backup',
          GLOBAL_CHOICE: 'sk-global-unused',
          CUSTOM_BENCH_SIGN: 'custom-bench-sign-secret',
        },
        gateEndpoints: [
          {
            id: 'bench-relay',
            implementation: 'benchmark-gate.v1',
            url: 'http://127.0.0.1:42050/v1/benchmark/jobs',
            signingCredentialRef: 'bench-signing',
            authCredentialRef: null,
          },
        ],
        credentialEnvMap: {
          provider: 'GLOBAL_CHOICE',
          byCredentialRef: { 'bench-signing': 'CUSTOM_BENCH_SIGN' },
        },
      });
      assert.equal(multiPrecRes.kind, 'compiled', JSON.stringify(multiPrecRes));
      if (multiPrecRes.kind === 'compiled') {
        assert.equal(
          multiPrecRes.taskpack.config.spec.credentials.find(c => c.ref === 'taskpack-provider-token')?.template,
          '${MANIFEST_KEY}',
        );
      }

      // (b) Explicit providerTokenEnv=EXPLICIT_KEY takes precedence over credentialEnvMap.provider=GLOBAL_CHOICE
      const runRootExplicitPrec = join(work, 'runs-action-explicit-prec');
      await mkdir(runRootExplicitPrec, { recursive: true, mode: 0o700 });
      const explicitPrecRes = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        runRoot: runRootExplicitPrec,
        runId: 'run-action-explicit-prec',
        mode: 'candidate',
        repositoryFullName: 'acme/kernel-repo',
        baseRevision: headSha,
        eventName: 'workflow_dispatch',
        upstreamRecords,
        providerTokenEnv: 'EXPLICIT_KEY',
        dryRun: true,
        env: {
          ...process.env,
          EXPLICIT_KEY: 'sk-explicit-override',
          MANIFEST_KEY: 'sk-manifest-primary',
          BACKUP_KEY: 'sk-manifest-backup',
          GLOBAL_CHOICE: 'sk-global-unused',
          CUSTOM_BENCH_SIGN: 'custom-bench-sign-secret',
        },
        gateEndpoints: [
          {
            id: 'bench-relay',
            implementation: 'benchmark-gate.v1',
            url: 'http://127.0.0.1:42050/v1/benchmark/jobs',
            signingCredentialRef: 'bench-signing',
            authCredentialRef: null,
          },
        ],
        credentialEnvMap: {
          provider: 'GLOBAL_CHOICE',
          byCredentialRef: { 'bench-signing': 'CUSTOM_BENCH_SIGN' },
        },
      });
      assert.equal(explicitPrecRes.kind, 'compiled', JSON.stringify(explicitPrecRes));
      if (explicitPrecRes.kind === 'compiled') {
        assert.equal(
          explicitPrecRes.taskpack.config.spec.credentials.find(c => c.ref === 'taskpack-provider-token')?.template,
          '${EXPLICIT_KEY}',
        );
      }

      // (c) Candidate discovery with NO preflight, NO upstream updates, and a missing modelsJsonPath
      //     returns no_change without blocking on the unused models.json file
      const runRootNoChangeModels = join(work, 'runs-no-change-missing-models');
      await mkdir(runRootNoChangeModels, { recursive: true, mode: 0o700 });
      const noChangeModelsRes = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        runRoot: runRootNoChangeModels,
        runId: 'run-no-change-missing-models',
        mode: 'candidate',
        repositoryFullName: 'acme/kernel-repo',
        baseRevision: headSha,
        eventName: 'workflow_dispatch',
        upstreamRecords: [],
        modelsJsonPath: join(work, 'missing-unused-models.json'),
        dryRun: true,
        env: { ...process.env, OPENAI_API_KEY: 'sk-test-action-12345' },
      });
      assert.equal(noChangeModelsRes.kind, 'no_change', JSON.stringify(noChangeModelsRes));

      // (d) Turnkey Action run rejects benchmark relay signing/auth mapped to GITHUB_TOKEN or GH_TOKEN
      //     strictly BEFORE resolveGitHubAuth or any GitHub API fetch call occurs — covering both
      //     host-classified (implementation: 'benchmark-gate.v1') and manifest-only unclassified host plans
      //     where the manifest check id ('bench-h100') differs from the host endpointId ('bench-relay')
      for (const includeHostImplementation of [true, false] as const) {
        for (const badCredMap of [
          { byCredentialRef: { 'bench-signing': 'GITHUB_TOKEN' } },
          { byCredentialRef: { 'bench-signing': 'GH_TOKEN' } },
          { gate: 'GITHUB_TOKEN' },
          { byCredentialRef: { 'bench-signing': 'CUSTOM_BENCH_SIGN', 'bench-auth': 'GITHUB_TOKEN' } },
          { byCredentialRef: { 'bench-signing': 'CUSTOM_BENCH_SIGN' }, gateAuth: 'GH_TOKEN' },
        ] as const) {
          let fetchCalls = 0;
          const rejectFetch: typeof fetch = async () => {
            fetchCalls += 1;
            throw new Error('fetch must not be called before benchmark credential validation');
          };
          const runRootBadGh = join(work, `runs-bad-gh-${Math.random().toString(16).slice(2, 10)}`);
          await mkdir(runRootBadGh, { recursive: true, mode: 0o700 });
          const hasAuthRef = 'gateAuth' in badCredMap || ('byCredentialRef' in badCredMap && 'bench-auth' in badCredMap.byCredentialRef);
          const badGhRes = await runGitHubActionEntrypoint({
            repositoryRoot: repo,
            taskpackPath: '.auto-sync/taskpack.yaml',
            runRoot: runRootBadGh,
            runId: 'run-action-bad-gh-bench',
            mode: 'candidate',
            turnkey: true,
            dryRun: false,
            repositoryFullName: 'acme/kernel-repo',
            baseRevision: headSha,
            eventName: 'workflow_dispatch',
            githubApiBaseUrl: 'https://api.github.invalid',
            probeFetch: rejectFetch,
            upstreamRecords,
            env: {
              ...process.env,
              GITHUB_TOKEN: 'relay-secret-must-never-hit-github-api',
              GH_TOKEN: 'relay-auth-must-never-hit-github-api',
              CUSTOM_BENCH_SIGN: 'custom-bench-sign-secret',
            },
            gateEndpoints: [
              {
                id: 'bench-relay',
                ...(includeHostImplementation ? { implementation: 'benchmark-gate.v1' as const } : {}),
                url: 'http://127.0.0.1:42050/v1/benchmark/jobs',
                signingCredentialRef: 'bench-signing',
                authCredentialRef: hasAuthRef ? 'bench-auth' : null,
              },
            ],
            credentialEnvMap: badCredMap,
          });
          assert.equal(fetchCalls, 0, 'resolveGitHubAuth must not make any HTTP call when benchmark gate maps GITHUB_TOKEN/GH_TOKEN');
          assert.equal(badGhRes.kind, 'refused', JSON.stringify(badGhRes));
          if (badGhRes.kind === 'refused') {
            assert.equal(badGhRes.code, 'TASKPACK_HOST_BINDING_INVALID');
          }
        }
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});
