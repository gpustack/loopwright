import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { compilePlan, inspectRun, loadTrustedConfiguration, runCycleWithPorts } from '@loopwright/controller';
import { isWritablePath, OVERLAY_LIMITS } from '@loopwright/core';
import {
  RUNNER_ALWAYS_PROTECTED_PATHS,
  RUNNER_PROTECTED_PATHS,
  RUNNER_WRITABLE_PATHS,
  compileRunnerTaskpack,
} from '../src/compile-taskpack.js';
import { defaultCorpusRoot } from '../src/corpus.js';
import { buildParityFixtureRepository, deterministicFakeAdapter } from '../src/parity.js';
import { computeRunnerCandidateDigest, startRunnerTaskpackService } from '../src/service.js';
import { RunnerTaskpackError } from '../src/types.js';

const execFileAsync = promisify(execFile);

function writable(task: unknown, path: string): boolean {
  const res = isWritablePath(task, path);
  assert.equal(res.ok, true, JSON.stringify(res));
  return res.ok && res.value;
}

const SECRET_VALUES: Record<string, string> = {
  RUNNER_PROVIDER_TOKEN: 'RUNNER_V2_PROVIDER_TOKEN_VALUE',
  RUNNER_GATE_SIGNING_SECRET: 'RUNNER_V2_GATE_SIGNING_SECRET_VALUE',
  RUNNER_PUBLICATION_SIGNING_SECRET: 'RUNNER_V2_PUBLICATION_SIGNING_SECRET_VALUE',
};

async function withEnvAndDirs(
  run: (paths: { root: string; operator: string; task: string; runRoot: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'taskpack-v2-parity-'));
  await chmod(root, 0o700);
  const operator = join(root, 'operator');
  const task = join(root, 'task');
  const runRoot = join(root, 'runs');
  await mkdir(operator, { mode: 0o700 });
  await mkdir(task, { mode: 0o700 });
  await mkdir(runRoot, { mode: 0o700 });
  const previous: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(SECRET_VALUES)) {
    previous[name] = process.env[name];
    process.env[name] = value;
  }
  try {
    await run({ root, operator, task, runRoot });
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function loadAndCompile(
  bundle: Awaited<ReturnType<typeof compileRunnerTaskpack>>,
  paths: { operator: string; task: string },
) {
  const registryPath = join(paths.operator, 'registry.json');
  const configPath = join(paths.task, 'task.json');
  await writeFile(registryPath, bundle.registryBytes, { mode: 0o600 });
  await writeFile(configPath, JSON.stringify(bundle.config), { mode: 0o600 });
  const loaded = await loadTrustedConfiguration({
    configPath,
    registryPath,
    registrySha256: bundle.registrySha256,
    untrustedRoots: [paths.task],
  });
  assert.equal(loaded.ok, true, JSON.stringify(loaded.ok ? [] : loaded.error).slice(0, 400));
  if (!loaded.ok) throw new Error('loadTrustedConfiguration failed');
  const compiled = await compilePlan(loaded.value);
  assert.equal(compiled.ok, true, JSON.stringify(compiled.ok ? [] : compiled.error).slice(0, 400));
  if (!compiled.ok) throw new Error('compilePlan failed');
  return { loaded: loaded.value, plan: compiled.value };
}

async function initGitRepo(files: Readonly<Record<string, string>>): Promise<{ path: string; headSha: string }> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'taskpack-v2-repo-'));
  await chmod(root, 0o700);
  const gitEnv = {
    HOME: root,
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
  const git = async (args: string[]) => {
    await execFileAsync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: root,
      env: gitEnv,
      encoding: 'utf8',
    });
  };
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.name', 'Fixture']);
  await git(['config', 'user.email', 'fixture@example.invalid']);
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(root, relPath);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  await git(['add', '.']);
  await git(['commit', '-qm', 'baseline']);
  const headSha = (await execFileAsync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })).stdout.trim();
  return { path: root, headSha };
}

describe('Taskpack 2.0 runner parity alignment', () => {
  const cleanupRoots: string[] = [];
  const cleanupServices: { close(): Promise<void> }[] = [];
  after(async () => {
    for (const service of cleanupServices) await service.close().catch(() => undefined);
    for (const root of cleanupRoots) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it('aligns default scope constants with explicit /** syntax and keeps built-in protected paths neutral', async () => {
    assert.ok((RUNNER_WRITABLE_PATHS as readonly string[]).includes('pack/**'));
    assert.equal((RUNNER_WRITABLE_PATHS as readonly string[]).includes('pack'), false);
    assert.ok((RUNNER_WRITABLE_PATHS as readonly string[]).includes('docs/support-records.md'));
    assert.deepEqual([...RUNNER_ALWAYS_PROTECTED_PATHS], ['.git/**']);
    assert.deepEqual([...RUNNER_PROTECTED_PATHS], ['.github/**', 'tools/**', 'tests/**']);
    for (const forbidden of ['.agents', '.agents/**', '.claude/**', 'CLAUDE.md', 'AGENTS.md']) {
      assert.equal((RUNNER_PROTECTED_PATHS as readonly string[]).includes(forbidden), false);
      assert.equal((RUNNER_ALWAYS_PROTECTED_PATHS as readonly string[]).includes(forbidden), false);
    }

    await withEnvAndDirs(async paths => {
      const bundle = await compileRunnerTaskpack({
        mode: 'candidate',
        repository: 'example-org/runtime-runner',
        baseRevision: 'b'.repeat(40),
        sourceRevision: 'c'.repeat(40),
        gateEndpoint: { id: 'runner-validation-gate', url: 'http://127.0.0.1:47101/gate', signingCredentialRef: 'runner-gate-signing' },
        publication: { mode: 'disabled' },
      });
      await loadAndCompile(bundle, paths);
      const task = bundle.config.spec.task;
      assert.equal(task.spec.scope.writable.includes('pack/**'), true);
      assert.equal(task.spec.scope.writable.includes('docs/support-records.md'), true);
      assert.equal(task.spec.scope.writable.includes('docs/support-records.md/**'), false);
      assert.equal(task.spec.scope.protected.includes('.git/**'), true);
      assert.equal(task.spec.scope.protected.includes('.claude/**'), false);
      assert.equal(task.spec.scope.protected.includes('CLAUDE.md'), false);
      assert.equal(task.spec.scope.protected.includes('AGENTS.md'), false);

      assert.equal(writable(task, 'pack/cuda/Dockerfile.vllm'), true);
      assert.equal(writable(task, 'docs/support-records.md'), true);
      assert.equal(writable(task, 'docs/support-records.md/nested'), false);
      assert.equal(writable(task, '.github/workflows/ci.yml'), false);
      assert.equal(writable(task, '.git/config'), false);
    });
  });

  it('supports explicit /** and bounded */? globs, neutral tool paths, and policyProfile local vs github workflow protection', async () => {
    await withEnvAndDirs(async paths => {
      const bundle = await compileRunnerTaskpack({
        mode: 'candidate',
        repository: 'example-org/runtime-runner',
        baseRevision: 'b'.repeat(40),
        sourceRevision: 'c'.repeat(40),
        publication: { mode: 'disabled' },
        proposal: null,
        scope: {
          writable: ['package.json', 'packages/*/package.json', 'docs/v?.md', 'docs/**', '.agents/**'],
          protected: ['.claude/**'],
        },
        localChecks: [
          { id: 'pkg-keys', implementation: 'json-keys-guard.v1', parameters: { path: 'package.json', allowedPointers: ['/version'] } },
        ],
      });
      await loadAndCompile(bundle, paths);
      const task = bundle.config.spec.task;

      assert.equal(task.spec.scope.writable.includes('package.json'), true);
      assert.equal(task.spec.scope.writable.includes('package.json/**'), false);
      assert.equal(task.spec.scope.writable.includes('.agents/**'), true);
      assert.equal(task.spec.scope.protected.includes('.git/**'), true);
      assert.equal(task.spec.scope.protected.includes('.claude/**'), true);
      assert.equal(task.spec.scope.protected.includes('.github/workflows/**'), true);

      assert.equal(writable(task, 'package.json'), true);
      assert.equal(writable(task, 'packages/core/package.json'), true);
      assert.equal(writable(task, 'packages/core/src/index.ts'), false);
      assert.equal(writable(task, 'docs/v1.md'), true);
      assert.equal(writable(task, 'docs/nested/guide.md'), true);
      assert.equal(writable(task, '.agents/skills/my-skill/SKILL.md'), true);
      assert.equal(writable(task, '.claude/skills/my-skill/SKILL.md'), false);
      assert.equal(writable(task, '.github/workflows/ci.yml'), false);

      // Invalid scope patterns and mandatory protected overlaps must fail closed.
      await assert.rejects(
        () => compileRunnerTaskpack({
          mode: 'candidate',
          repository: 'example-org/runtime-runner',
          baseRevision: 'b'.repeat(40),
          sourceRevision: 'c'.repeat(40),
          publication: { mode: 'disabled' },
          proposal: null,
          scope: { writable: ['packages/{a,b}/package.json'] },
          localChecks: [{ id: 'pkg-keys', implementation: 'json-keys-guard.v1', parameters: { path: 'package.json', allowedPointers: ['/version'] } }],
        }),
        (err: unknown) => err instanceof RunnerTaskpackError && err.code === 'CONFIG_INVALID',
      );
      await assert.rejects(
        () => compileRunnerTaskpack({
          mode: 'candidate',
          repository: 'example-org/runtime-runner',
          baseRevision: 'b'.repeat(40),
          sourceRevision: 'c'.repeat(40),
          publication: { mode: 'disabled' },
          proposal: null,
          scope: { writable: ['.git/**'] },
          localChecks: [{ id: 'pkg-keys', implementation: 'json-keys-guard.v1', parameters: { path: 'package.json', allowedPointers: ['/version'] } }],
        }),
        (err: unknown) => err instanceof RunnerTaskpackError && err.code === 'CONFIG_INVALID',
      );
      await assert.rejects(
        () => compileRunnerTaskpack({
          mode: 'candidate',
          repository: 'example-org/runtime-runner',
          baseRevision: 'b'.repeat(40),
          sourceRevision: 'c'.repeat(40),
          publication: { mode: 'disabled' },
          proposal: null,
          scope: { writable: ['.github/workflows/**'] },
          execution: { capabilities: { allowWorkflowWrites: true } },
          localChecks: [{ id: 'pkg-keys', implementation: 'json-keys-guard.v1', parameters: { path: 'package.json', allowedPointers: ['/version'] } }],
        }),
        (err: unknown) => err instanceof RunnerTaskpackError && err.code === 'CONFIG_INVALID',
      );

      // policyProfile: 'local' disables implicit .github/workflows/** injection while keeping .git/** protected.
      const localBundle = await compileRunnerTaskpack({
        mode: 'candidate',
        repository: 'example-org/runtime-runner',
        baseRevision: 'b'.repeat(40),
        sourceRevision: 'c'.repeat(40),
        publication: { mode: 'disabled' },
        proposal: null,
        hostPolicy: { policyProfile: 'local' },
        scope: { writable: ['.github/workflows/**', '.claude/**', 'AGENTS.md'] },
        localChecks: [{ id: 'pkg-keys', implementation: 'json-keys-guard.v1', parameters: { path: 'package.json', allowedPointers: ['/version'] } }],
      });
      await loadAndCompile(localBundle, paths);
      assert.equal(localBundle.config.spec.task.spec.scope.protected.includes('.github/workflows/**'), false);
      assert.equal(localBundle.config.spec.task.spec.scope.protected.includes('.git/**'), true);
      assert.equal(writable(localBundle.config.spec.task, '.github/workflows/ci.yml'), true);
      assert.equal(writable(localBundle.config.spec.task, '.claude/settings.json'), true);
      assert.equal(writable(localBundle.config.spec.task, 'AGENTS.md'), true);
      assert.equal(writable(localBundle.config.spec.task, '.git/HEAD'), false);

      // Dual-key allowWorkflowWrites unlocks .github/workflows/** in github profile while keeping .git/** and non-workflow .github/** protected.
      const workflowBundle = await compileRunnerTaskpack({
        mode: 'candidate',
        repository: 'example-org/runtime-runner',
        baseRevision: 'b'.repeat(40),
        sourceRevision: 'c'.repeat(40),
        publication: { mode: 'disabled' },
        proposal: null,
        execution: { capabilities: { allowWorkflowWrites: true } },
        hostPolicy: { policyProfile: 'github', allowWorkflowWrites: true },
        scope: { writable: ['.github/workflows/**'], protected: ['.claude/**'] },
        localChecks: [{ id: 'pkg-keys', implementation: 'json-keys-guard.v1', parameters: { path: 'package.json', allowedPointers: ['/version'] } }],
      });
      await loadAndCompile(workflowBundle, paths);
      assert.equal(writable(workflowBundle.config.spec.task, '.github/workflows/ci.yml'), true);
      assert.equal(writable(workflowBundle.config.spec.task, '.github/CODEOWNERS'), false);
      assert.equal(writable(workflowBundle.config.spec.task, '.claude/settings.json'), false);
      assert.equal(writable(workflowBundle.config.spec.task, '.git/config'), false);

      // policyProfile: 'github' rejects non-workflow .github/** writes regardless of custom scope or allowWorkflowWrites.
      for (const badCase of [
        { writable: ['.github/CODEOWNERS'], allowWorkflowWrites: false },
        { writable: ['.github/CODEOWNERS'], allowWorkflowWrites: true },
        { writable: ['.github/**'], allowWorkflowWrites: true },
        { writable: ['**'], allowWorkflowWrites: true },
      ]) {
        await assert.rejects(
          () => compileRunnerTaskpack({
            mode: 'candidate',
            repository: 'example-org/runtime-runner',
            baseRevision: 'b'.repeat(40),
            sourceRevision: 'c'.repeat(40),
            publication: { mode: 'disabled' },
            proposal: null,
            ...(badCase.allowWorkflowWrites ? { execution: { capabilities: { allowWorkflowWrites: true } } } : {}),
            hostPolicy: { policyProfile: 'github', allowWorkflowWrites: badCase.allowWorkflowWrites },
            scope: { writable: badCase.writable },
            localChecks: [{ id: 'pkg-keys', implementation: 'json-keys-guard.v1', parameters: { path: 'package.json', allowedPointers: ['/version'] } }],
          }),
          (err: unknown) => err instanceof RunnerTaskpackError && err.code === 'CONFIG_INVALID',
          `expected CONFIG_INVALID for writable=${JSON.stringify(badCase.writable)} allowWorkflowWrites=${badCase.allowWorkflowWrites}`,
        );
      }

      // policyProfile: 'local' still allows custom .github/CODEOWNERS without GitHub path injection.
      const localCustomGithub = await compileRunnerTaskpack({
        mode: 'candidate',
        repository: 'example-org/runtime-runner',
        baseRevision: 'b'.repeat(40),
        sourceRevision: 'c'.repeat(40),
        publication: { mode: 'disabled' },
        proposal: null,
        hostPolicy: { policyProfile: 'local' },
        scope: { writable: ['.github/CODEOWNERS', '.github/workflows/**'] },
        localChecks: [{ id: 'pkg-keys', implementation: 'json-keys-guard.v1', parameters: { path: 'package.json', allowedPointers: ['/version'] } }],
      });
      assert.equal(writable(localCustomGithub.config.spec.task, '.github/CODEOWNERS'), true);
      assert.equal(writable(localCustomGithub.config.spec.task, '.github/workflows/ci.yml'), true);
    });
  });

  it('supports proposal-optional Taskpack 2.0 runs with submission.path and built-in structural guards', async () => {
    const repo = await initGitRepo({
      'package.json': JSON.stringify({ name: 'demo', version: '1.0.0' }, null, 2) + '\n',
      'docs/README.md': '# Header\n<!-- START -->\nold body\n<!-- END -->\n# Footer\n',
      '.agents/notes/note.md': 'initial\n',
    });
    cleanupRoots.push(repo.path);

    await withEnvAndDirs(async paths => {
      const bundle = await compileRunnerTaskpack({
        mode: 'candidate',
        repository: 'example-org/runtime-runner',
        baseRevision: repo.headSha,
        sourceRevision: repo.headSha,
        publication: { mode: 'disabled' },
        proposal: null,
        submission: { path: 'docs/submission.json' },
        scope: { writable: ['package.json', 'docs/**', '.agents/**'] },
        localChecks: [
          { id: 'pkg-keys', implementation: 'json-keys-guard.v1', parameters: { path: 'package.json', allowedPointers: ['/version'] } },
          { id: 'readme-sec', implementation: 'line-section-guard.v1', parameters: { path: 'docs/README.md', startMarker: '<!-- START -->', endMarker: '<!-- END -->' } },
        ],
      });
      assert.equal(bundle.config.spec.controls.submission.path, 'docs/submission.json');
      const { loaded, plan } = await loadAndCompile(bundle, paths);
      assert.equal(plan.verifierSlots.some(s => s.checkId === 'runner-proposal-json'), false);

      // 1. Valid in-region edits + .agents/** edit without .autosync/proposal.json -> completed.
      const passExec = await runCycleWithPorts(
        { configuration: loaded, repository: repo.path, runRoot: paths.runRoot, runId: 'v2-guards-pass' },
        {
          openAdapter: deterministicFakeAdapter({
            attempts: [{
              proposal: null,
              edits: [
                { path: 'package.json', content: JSON.stringify({ name: 'demo', version: '1.1.0' }, null, 2) + '\n' },
                { path: 'docs/README.md', content: '# Header\n<!-- START -->\nnew body\n<!-- END -->\n# Footer\n' },
                { path: '.agents/notes/note.md', content: 'updated\n' },
                { path: 'docs/submission.json', content: JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null }) },
              ],
              submission: { status: 'completed', reason: null },
            }],
          }),
        },
      );
      assert.equal(passExec.ok, true);
      if (!passExec.ok || passExec.value.kind !== 'result') throw new Error('expected result');
      assert.equal(passExec.value.result.spec.status, 'completed');

      // 2. Disallowed JSON pointer + outside-section edit -> failed with structured guard findings.
      const failExec = await runCycleWithPorts(
        { configuration: loaded, repository: repo.path, runRoot: paths.runRoot, runId: 'v2-guards-fail' },
        {
          openAdapter: deterministicFakeAdapter({
            attempts: [{
              proposal: null,
              edits: [
                { path: 'package.json', content: JSON.stringify({ name: 'hijacked', version: '1.1.0' }, null, 2) + '\n' },
                { path: 'docs/README.md', content: '# Edited Header\n<!-- START -->\nnew body\n<!-- END -->\n# Footer\n' },
              ],
              submission: { status: 'completed', reason: null },
            }],
          }),
        },
      );
      assert.equal(failExec.ok, true);
      if (!failExec.ok || failExec.value.kind !== 'result') throw new Error('expected result');
      assert.equal(failExec.value.result.spec.status, 'exhausted');
      const pkgRow = failExec.value.result.spec.verification.spec.required.find(r => r.checkId === 'pkg-keys');
      const docRow = failExec.value.result.spec.verification.spec.required.find(r => r.checkId === 'readme-sec');
      assert.equal(pkgRow?.status, 'failed');
      assert.ok((pkgRow?.findings?.length ?? 0) >= 1);
      assert.equal(docRow?.status, 'failed');
      assert.ok((docRow?.findings?.length ?? 0) >= 1);
    });
  });

  it('passes spec.limits.overlay (>128 files) through computeRunnerCandidateDigest, identifyManifest, bindSubject, and runCycleWithPorts', async () => {
    const files: Record<string, string> = {
      'docs/README.md': '<!-- START -->\ninit\n<!-- END -->\n',
    };
    for (let i = 0; i < 150; i++) {
      files[`docs/item-${String(i).padStart(3, '0')}.md`] = `item ${i}\n`;
    }
    const repo = await initGitRepo(files);
    cleanupRoots.push(repo.path);

    const treeOid = (await execFileAsync('/usr/bin/git', ['rev-parse', 'HEAD^{tree}'], { cwd: repo.path, encoding: 'utf8' })).stdout.trim();
    const baseTree = { objectFormat: 'sha1' as const, commitOid: repo.headSha, treeOid };
    const overlayFiles = Object.fromEntries(
      Array.from({ length: 140 }, (_, i) => [`docs/item-${String(i).padStart(3, '0')}.md`, `updated ${i}\n`]),
    );
    const overlay = { maxFiles: 512, maxBytes: 16_777_216 };
    const digestWithOverlay = await computeRunnerCandidateDigest({
      repositorySnapshot: repo.path,
      headSha: repo.headSha,
      candidateFiles: overlayFiles,
      baseTree,
      overlay,
    });
    assert.equal(digestWithOverlay.files.size, 140);

    await assert.rejects(
      () => computeRunnerCandidateDigest({
        repositorySnapshot: repo.path,
        headSha: repo.headSha,
        candidateFiles: overlayFiles,
        baseTree,
      }),
      (err: unknown) => err instanceof RunnerTaskpackError && err.code === 'SERVICE_FAULT',
    );

    await withEnvAndDirs(async paths => {
      const bundle = await compileRunnerTaskpack({
        mode: 'candidate',
        repository: 'example-org/runtime-runner',
        baseRevision: repo.headSha,
        sourceRevision: repo.headSha,
        publication: { mode: 'disabled' },
        proposal: null,
        limits: { overlay },
        scope: { writable: ['docs/**'] },
        localChecks: [
          { id: 'readme-sec', implementation: 'line-section-guard.v1', parameters: { path: 'docs/README.md', startMarker: '<!-- START -->', endMarker: '<!-- END -->' } },
        ],
      });
      assert.deepEqual({ ...bundle.config.spec.task.spec.budgets.overlay }, overlay);
      const { loaded } = await loadAndCompile(bundle, paths);

      const edits = Object.entries(overlayFiles).map(([path, content]) => ({ path, content }));
      const exec = await runCycleWithPorts(
        { configuration: loaded, repository: repo.path, runRoot: paths.runRoot, runId: 'v2-wide-overlay' },
        {
          openAdapter: deterministicFakeAdapter({
            attempts: [{ proposal: null, edits, submission: { status: 'completed', reason: null } }],
          }),
        },
      );
      assert.equal(exec.ok, true);
      if (!exec.ok || exec.value.kind !== 'result') throw new Error('expected result');
      assert.equal(exec.value.result.spec.status, 'completed');
    });
  });

  it('preserves extensible Evidence / EvaluatedCheck metrics, findings, and detail on passed and failed gate verdicts', { timeout: 120000 }, async () => {
    const corpusRoot = defaultCorpusRoot();
    if (corpusRoot === null) throw new Error('vendored corpus absent');
    const fixture = await buildParityFixtureRepository();
    cleanupRoots.push(fixture.path);

    const readyRaw = JSON.parse(
      await readFile(join(corpusRoot, 'tests', 'auto_sync', 'fixtures', 'proposals', 'ready.json'), 'utf8'),
    ) as { identity: Record<string, unknown> };
    readyRaw.identity.default_sha = fixture.headSha;
    readyRaw.identity.head_sha = fixture.headSha;
    const proposal = JSON.stringify(readyRaw);

    const service = await startRunnerTaskpackService({
      gateSecret: SECRET_VALUES.RUNNER_GATE_SIGNING_SECRET!,
      publicationSecret: SECRET_VALUES.RUNNER_PUBLICATION_SIGNING_SECRET!,
      corpusRoot,
    });
    cleanupServices.push(service);

    await withEnvAndDirs(async paths => {
      const runId = 'v2-extensible-evidence-pass';
      const storeId = 'store.' + createHash('sha256').update('loopwright.dev/controller/store/v1\0' + runId, 'utf8').digest('hex').slice(0, 40);
      await service.registerCandidate({
        storeId,
        runId,
        candidateDigest: null,
        proposalJson: proposal,
        identity: {
          repository: 'example-org/runtime-runner',
          defaultSha: fixture.headSha,
          headSha: fixture.headSha,
          mode: 'discover',
          prNumber: null,
          commandId: null,
          commandDigest: null,
        },
        repositorySnapshot: fixture.path,
        upstreamSources: {},
        ascendPairs: {},
        enginePrereleases: [],
        prereleasePackages: [],
        runRoot: paths.runRoot,
        gateVerdictMetadata: {
          detail: 'all benchmark checks green',
          metrics: { latency_us: 42.5, speedup: 1.18, delta: -0, ok: true, profile: 'arm64' },
          findings: [
            { title: 'Advisory note', severity: 'low', path: 'pack/cuda/Dockerfile.vllm', line: 1, evidence: 'pinned base image' },
          ],
        },
      });

      const bundle = await compileRunnerTaskpack({
        mode: 'candidate',
        repository: 'example-org/runtime-runner',
        baseRevision: fixture.headSha,
        sourceRevision: fixture.headSha,
        gateEndpoint: { id: 'runner-validation-gate', url: service.gateUrl, signingCredentialRef: 'runner-gate-signing' },
        publication: { mode: 'disabled' },
      });
      const { loaded } = await loadAndCompile(bundle, paths);

      const exec = await runCycleWithPorts(
        { configuration: loaded, repository: fixture.path, runRoot: paths.runRoot, runId },
        {
          openAdapter: deterministicFakeAdapter({
            attempts: [{ proposal, edits: [], submission: { status: 'completed', reason: null } }],
          }),
        },
      );
      assert.equal(exec.ok, true);
      if (!exec.ok || exec.value.kind !== 'result') throw new Error('expected result');
      assert.equal(exec.value.result.spec.status, 'completed');

      const gateRow = exec.value.result.spec.verification.spec.required.find(r => r.checkId === 'runner-candidate-validation');
      assert.ok(gateRow, 'gate row missing');
      assert.equal(gateRow.status, 'passed');
      assert.equal(gateRow.reason, 'observed_pass');
      assert.equal(gateRow.detail, 'all benchmark checks green');
      assert.deepEqual({ ...gateRow.metrics }, { delta: 0, latency_us: 42.5, ok: true, profile: 'arm64', speedup: 1.18 });
      assert.equal(Object.is(gateRow.metrics?.delta, 0), true);
      assert.deepEqual(gateRow.findings?.map(f => ({ ...f })), [
        { title: 'Advisory note', severity: 'low', path: 'pack/cuda/Dockerfile.vllm', line: 1, evidence: 'pinned base image' },
      ]);

      // Also verify denied gate verdict preserves detail, metrics, and findings on failed EvaluatedCheck.
      const denyRunId = 'v2-extensible-evidence-fail';
      const denyStoreId = 'store.' + createHash('sha256').update('loopwright.dev/controller/store/v1\0' + denyRunId, 'utf8').digest('hex').slice(0, 40);
      await service.registerCandidate({
        storeId: denyStoreId,
        runId: denyRunId,
        candidateDigest: null,
        proposalJson: null,
        identity: {
          repository: 'example-org/runtime-runner',
          defaultSha: fixture.headSha,
          headSha: fixture.headSha,
          mode: 'discover',
          prNumber: null,
          commandId: null,
          commandDigest: null,
        },
        repositorySnapshot: fixture.path,
        upstreamSources: {},
        ascendPairs: {},
        enginePrereleases: [],
        prereleasePackages: [],
        runRoot: paths.runRoot,
        gateVerdictMetadata: {
          detail: 'candidate proposal omitted from snapshot',
          metrics: { missing_files: 1, passed: false },
          findings: [
            { title: 'Missing proposal', severity: 'high', evidence: '.autosync/proposal.json was absent' },
          ],
        },
      });
      const denyBundle = await compileRunnerTaskpack({
        mode: 'candidate',
        repository: 'example-org/runtime-runner',
        baseRevision: fixture.headSha,
        sourceRevision: fixture.headSha,
        gateEndpoint: { id: 'runner-validation-gate', url: service.gateUrl, signingCredentialRef: 'runner-gate-signing' },
        publication: { mode: 'disabled' },
        proposal: null,
      });
      const { loaded: denyLoaded } = await loadAndCompile(denyBundle, paths);
      const denyExec = await runCycleWithPorts(
        { configuration: denyLoaded, repository: fixture.path, runRoot: paths.runRoot, runId: denyRunId },
        {
          openAdapter: deterministicFakeAdapter({
            attempts: [{ proposal: null, edits: [], submission: { status: 'completed', reason: null } }],
          }),
        },
      );
      assert.equal(denyExec.ok, true);
      if (!denyExec.ok || denyExec.value.kind !== 'result') throw new Error('expected result');
      assert.equal(denyExec.value.result.spec.status, 'exhausted');
      const deniedGateRow = denyExec.value.result.spec.verification.spec.required.find(r => r.checkId === 'runner-candidate-validation');
      assert.equal(deniedGateRow?.status, 'failed');
      assert.equal(deniedGateRow?.detail, 'candidate proposal omitted from snapshot');
      assert.deepEqual({ ...deniedGateRow?.metrics }, { missing_files: 1, passed: false });
      assert.deepEqual(deniedGateRow?.findings?.map(f => ({ ...f })), [
        { title: 'Missing proposal', severity: 'high', evidence: '.autosync/proposal.json was absent' },
      ]);

      const inspectedDeny = await inspectRun({ runRoot: paths.runRoot, runId: denyRunId });
      assert.equal(inspectedDeny.ok, true);
      if (!inspectedDeny.ok) throw new Error('expected inspectRun ok');
      assert.notEqual(inspectedDeny.value.runEval, null);
      assert.ok(inspectedDeny.value.runEval!.breakdown.byStep.length >= 1);
      for (const suggestion of inspectedDeny.value.runEval!.suggestions) {
        assert.equal(suggestion.autoApplied, false);
      }
    });
  });

  it('rejects custom scope.writable that omits proposal.path or protects proposal.path when proposal is enabled', async () => {
    await assert.rejects(
      () => compileRunnerTaskpack({
        mode: 'candidate',
        repository: 'example-org/runtime-runner',
        baseRevision: '1'.repeat(40),
        sourceRevision: '1'.repeat(40),
        publication: { mode: 'disabled' },
        localChecks: [{ id: 'ok', implementation: 'json-artifact.v1', parameters: { path: 'docs/out.json', required: ['ok'], equals: { ok: true } } }],
        scope: { writable: ['docs/**'], protected: [] },
        proposal: { path: '.autosync/proposal.json' },
      }),
      (err: unknown) => err instanceof RunnerTaskpackError && err.code === 'CONFIG_INVALID' && /scope\.writable/.test(err.message),
    );
    await assert.rejects(
      () => compileRunnerTaskpack({
        mode: 'candidate',
        repository: 'example-org/runtime-runner',
        baseRevision: '1'.repeat(40),
        sourceRevision: '1'.repeat(40),
        publication: { mode: 'disabled' },
        localChecks: [{ id: 'ok', implementation: 'json-artifact.v1', parameters: { path: 'docs/out.json', required: ['ok'], equals: { ok: true } } }],
        scope: { writable: ['docs/**'], protected: ['docs/proposal.json'] },
        proposal: { path: 'docs/proposal.json' },
      }),
      (err: unknown) => err instanceof RunnerTaskpackError && err.code === 'CONFIG_INVALID' && /protected pattern/.test(err.message),
    );

    // Exact-file control-root proposal carve-out succeeds when controlRoot/** is protected, while keeping siblings unwritable.
    const carvedOut = await compileRunnerTaskpack({
      mode: 'candidate',
      repository: 'example-org/runtime-runner',
      baseRevision: '1'.repeat(40),
      sourceRevision: '1'.repeat(40),
      publication: { mode: 'disabled' },
      localChecks: [{ id: 'ok', implementation: 'json-artifact.v1', parameters: { path: 'docs/out.json', required: ['ok'], equals: { ok: true } } }],
      scope: { writable: ['docs/**', '.autosync/proposal.json'], protected: ['.autosync/**'] },
      proposal: { path: '.autosync/proposal.json' },
    });
    assert.equal(writable(carvedOut.config.spec.task, '.autosync/proposal.json'), true);
    assert.equal(writable(carvedOut.config.spec.task, '.autosync/taskpack.yaml'), false);

    // Sibling writable under protected controlRoot/** still fails closed.
    await assert.rejects(
      () => compileRunnerTaskpack({
        mode: 'candidate',
        repository: 'example-org/runtime-runner',
        baseRevision: '1'.repeat(40),
        sourceRevision: '1'.repeat(40),
        publication: { mode: 'disabled' },
        localChecks: [{ id: 'ok', implementation: 'json-artifact.v1', parameters: { path: 'docs/out.json', required: ['ok'], equals: { ok: true } } }],
        scope: { writable: ['docs/**', '.autosync/proposal.json', '.autosync/extra.txt'], protected: ['.autosync/**'] },
        proposal: { path: '.autosync/proposal.json' },
      }),
      (err: unknown) => err instanceof RunnerTaskpackError && err.code === 'CONFIG_INVALID' && /protected pattern/.test(err.message),
    );

    // Overlay limits respect OVERLAY_LIMITS.maxMaxFiles (16_384).
    const maxOverlayBundle = await compileRunnerTaskpack({
      mode: 'candidate',
      repository: 'example-org/runtime-runner',
      baseRevision: '1'.repeat(40),
      sourceRevision: '1'.repeat(40),
      publication: { mode: 'disabled' },
      proposal: null,
      limits: { overlay: { maxFiles: OVERLAY_LIMITS.maxMaxFiles, maxBytes: 16_777_216 } },
      scope: { writable: ['docs/**'] },
      localChecks: [{ id: 'ok', implementation: 'json-artifact.v1', parameters: { path: 'docs/out.json', required: ['ok'], equals: { ok: true } } }],
    });
    assert.equal(maxOverlayBundle.config.spec.task.spec.budgets.overlay?.maxFiles, 16_384);
    await assert.rejects(
      () => compileRunnerTaskpack({
        mode: 'candidate',
        repository: 'example-org/runtime-runner',
        baseRevision: '1'.repeat(40),
        sourceRevision: '1'.repeat(40),
        publication: { mode: 'disabled' },
        proposal: null,
        limits: { overlay: { maxFiles: OVERLAY_LIMITS.maxMaxFiles + 1, maxBytes: 16_777_216 } },
        scope: { writable: ['docs/**'] },
        localChecks: [{ id: 'ok', implementation: 'json-artifact.v1', parameters: { path: 'docs/out.json', required: ['ok'], equals: { ok: true } } }],
      }),
      (err: unknown) => err instanceof RunnerTaskpackError && err.code === 'CONFIG_INVALID',
    );
  });
});
