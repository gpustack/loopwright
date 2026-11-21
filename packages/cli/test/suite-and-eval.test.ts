import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeTaskpackDigests, loadDeclarativeTaskpack, writeDigestLockfile } from '@loopwright/taskpack';
import { cycleFixture } from '../../controller/test/scheduling-fixtures.js';
import {
  CLEAN_ENV,
  MAIN_PATH,
  createManagedDelegatedRepoFixture,
  parseNdjson,
  runCliInProcess,
} from './step-cli-fixtures.js';

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    env: {
      PATH: '/usr/bin:/bin',
      LANG: 'C',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      HOME: '/nonexistent',
      GIT_TERMINAL_PROMPT: '0',
    },
    timeout: 10_000,
    encoding: 'utf8',
  }).trim();
}

async function listGitObjectFiles(repoRoot: string): Promise<readonly string[]> {
  const objectsRoot = join(repoRoot, '.git', 'objects');
  const found: string[] = [];
  const walk = async (dir: string, relPrefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else {
        found.push(rel);
      }
    }
  };
  await walk(objectsRoot, '');
  return found.sort();
}

function makeMinimalDomainTaskpackYaml(options: {
  readonly name: string;
  readonly writable: readonly string[];
  readonly headBranchPrefix: string;
  readonly publicationMode?: 'pull_request' | 'disabled' | undefined;
  readonly pinDigests?: boolean | undefined;
  readonly instructionPath?: string | undefined;
}): string {
  const pubBlock = options.publicationMode === 'disabled'
    ? `  publication:\n    mode: disabled\n`
    : `  publication:\n    mode: pull_request\n    targetBranch: main\n    headBranchPrefix: ${options.headBranchPrefix}\n    titleTemplate: "${options.name}: sync"\n`;
  const digestBlock = options.pinDigests === true
    ? `  execution:\n    mode: strict\n    digests:\n      pinDigests: true\n`
    : '';
  const instrBlock = options.instructionPath !== undefined
    ? `  instructions:\n    - ${options.instructionPath}\n`
    : '';
  return `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: ${options.name}
spec:
  goal:
    candidate: Update ${options.name}.
    noChange: Confirm ${options.name} is up to date.
  scope:
    writable:
${options.writable.map(w => `      - ${w}`).join('\n')}
    protected:
      - .git/**
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentPrefixes:
      - /loopwright
    commentCommands:
      - retry
      - revise
      - status
  verification:
    localChecks:
      - id: json-ok
        implementation: json-artifact.v1
    externalGates: []
  models:
    - provider: openai
      id: gpt-5.4
${instrBlock}${digestBlock}${pubBlock}`;
}

async function createStagedSuiteFixture(options?: {
  readonly probeUrl?: string;
  readonly pinDocsDigest?: boolean;
}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lw-cli-suite-')));
  const repoRoot = join(root, 'repo');
  await mkdir(join(repoRoot, '.loopwright', 'docs'), { recursive: true, mode: 0o700 });
  await mkdir(join(repoRoot, '.loopwright', 'runtime'), { recursive: true, mode: 0o700 });
  await mkdir(join(repoRoot, 'docs'), { recursive: true, mode: 0o700 });
  await mkdir(join(repoRoot, 'runtime'), { recursive: true, mode: 0o700 });

  await writeFile(join(repoRoot, 'docs', 'guide.md'), '# Docs\n', { mode: 0o600 });
  await writeFile(join(repoRoot, 'runtime', 'version.json'), JSON.stringify({ version: '1.2.0' }) + '\n', { mode: 0o600 });
  await writeFile(join(repoRoot, '.loopwright', 'docs', 'rule.md'), 'Keep docs concise.\n', { mode: 0o600 });

  await writeFile(
    join(repoRoot, '.loopwright', 'docs', 'taskpack.yaml'),
    makeMinimalDomainTaskpackYaml({
      name: 'docs-pack',
      writable: ['docs/**'],
      headBranchPrefix: 'loopwright/docs/',
      pinDigests: options?.pinDocsDigest,
      instructionPath: '.loopwright/docs/rule.md',
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(repoRoot, '.loopwright', 'runtime', 'taskpack.yaml'),
    makeMinimalDomainTaskpackYaml({
      name: 'runtime-pack',
      writable: ['runtime/**'],
      headBranchPrefix: 'loopwright/runtime/',
    }),
    { mode: 0o600 },
  );

  if (options?.pinDocsDigest === true) {
    const manifest = await loadDeclarativeTaskpack({
      manifestPath: '.loopwright/docs/taskpack.yaml',
      repositoryRoot: repoRoot,
      policyProfile: 'local',
      enforceHostAuthority: false,
    });
    const lockfile = await computeTaskpackDigests(repoRoot, manifest, '.loopwright/docs');
    await writeDigestLockfile(repoRoot, '.loopwright/docs/digests.lock.json', lockfile);
  }

  const probeBlock = options?.probeUrl !== undefined
    ? `      readiness:
        - id: release-json
          kind: http-json
          source: ${options.probeUrl}
          jsonPointer: /version
          versionFrom:
            domain: runtime
            path: runtime/version.json
            jsonPointer: /version
`
    : '';

  const suiteYaml = `apiVersion: loopwright.dev/v1alpha1
kind: TaskpackSuite
metadata:
  name: mono-suite
spec:
  stages:
    - id: stage-a
    - id: stage-b
      dependsOn:
        - stage-a
${probeBlock}  domains:
    - id: runtime
      taskpack: .loopwright/runtime/taskpack.yaml
      stage: stage-a
      schedules:
        - nightly
    - id: docs
      taskpack: .loopwright/docs/taskpack.yaml
      stage: stage-b
      schedules:
        - nightly
`;
  await writeFile(join(repoRoot, '.loopwright', 'suite.yaml'), suiteYaml, { mode: 0o600 });

  git(repoRoot, ['init', '-q', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Suite Fixture']);
  git(repoRoot, ['config', 'user.email', 'suite@example.invalid']);
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-qm', 'init suite']);
  const baseSha = git(repoRoot, ['rev-parse', 'HEAD']);

  return {
    root,
    repoRoot,
    baseSha,
    suitePath: '.loopwright/suite.yaml',
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('cli-suite: loopwright suite check validates suites, lockfile digests, cycles, and symlink violations', async () => {
  const fixture = await createStagedSuiteFixture({ pinDocsDigest: true });
  try {
    // Valid suite + --verify-digests -> exit 0
    const ok = spawnSync(
      process.execPath,
      [MAIN_PATH, 'suite', 'check', '--suite', fixture.suitePath, '--repo', fixture.repoRoot, '--verify-digests', '--json'],
      { encoding: 'utf8', timeout: 15_000, env: CLEAN_ENV },
    );
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    const okEnv = JSON.parse(ok.stdout) as { kind: string; data: { action: string; ok: boolean; domains: Array<{ id: string }>; stageOrder: string[] } };
    assert.equal(okEnv.kind, 'suite');
    assert.equal(okEnv.data.action, 'check');
    assert.equal(okEnv.data.ok, true);
    assert.deepEqual(okEnv.data.stageOrder, ['stage-a', 'stage-b']);
    assert.deepEqual(okEnv.data.domains.map(d => d.id), ['runtime', 'docs']);

    // Drifted instruction file with --verify-digests -> exit 2
    await writeFile(join(fixture.repoRoot, '.loopwright', 'docs', 'rule.md'), 'Drifted instruction.\n', { mode: 0o600 });
    const drifted = spawnSync(
      process.execPath,
      [MAIN_PATH, 'suite', 'check', '--suite', fixture.suitePath, '--repo', fixture.repoRoot, '--verify-digests', '--json'],
      { encoding: 'utf8', timeout: 15_000, env: CLEAN_ENV },
    );
    assert.equal(drifted.status, 2, drifted.stdout + drifted.stderr);
    assert.equal(JSON.parse(drifted.stdout).data.code, 'TASKPACK_MANIFEST_INVALID');

    // Stage cycle -> exit 2
    await writeFile(
      join(fixture.repoRoot, '.loopwright', 'suite.yaml'),
      `apiVersion: loopwright.dev/v1alpha1
kind: TaskpackSuite
metadata:
  name: cyclic-suite
spec:
  stages:
    - id: a
      dependsOn: [b]
    - id: b
      dependsOn: [a]
  domains:
    - id: runtime
      taskpack: .loopwright/runtime/taskpack.yaml
      stage: a
`,
      { mode: 0o600 },
    );
    const cycleRes = spawnSync(
      process.execPath,
      [MAIN_PATH, 'suite', 'check', '--suite', fixture.suitePath, '--repo', fixture.repoRoot, '--json'],
      { encoding: 'utf8', timeout: 15_000, env: CLEAN_ENV },
    );
    assert.equal(cycleRes.status, 2, cycleRes.stdout + cycleRes.stderr);
    assert.equal(JSON.parse(cycleRes.stdout).data.code, 'TASKPACK_MANIFEST_INVALID');

    // Symlinked suite file -> TASKPACK_SCOPE_VIOLATION -> exit 2 (static load error matches run --taskpack)
    const linkedSuite = join(fixture.repoRoot, '.loopwright', 'suite-link.yaml');
    await symlink(join(fixture.repoRoot, '.loopwright', 'suite.yaml'), linkedSuite);
    const linkRes = spawnSync(
      process.execPath,
      [MAIN_PATH, 'suite', 'check', '--suite', '.loopwright/suite-link.yaml', '--repo', fixture.repoRoot, '--json'],
      { encoding: 'utf8', timeout: 15_000, env: CLEAN_ENV },
    );
    assert.equal(linkRes.status, 2, linkRes.stdout + linkRes.stderr);
    assert.equal(JSON.parse(linkRes.stdout).data.code, 'TASKPACK_SCOPE_VIOLATION');
  } finally {
    await fixture.cleanup();
  }
});

test('cli-suite: loopwright suite resolve returns exit 0 for eligible/deferred and exit 3 for blocked with scrubbed secrets', async () => {
  let mode: 'ready' | 'unready_404' | 'error_500' | 'open_pr' = 'ready';
  const secretToken = 'ghp_cli_suite_secret_token_987654321';
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith('/repos/octo/mono/pulls')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (mode === 'open_pr') {
        res.end(JSON.stringify([{
          number: 42,
          title: 'runtime: sync',
          html_url: 'https://github.com/octo/mono/pull/42',
          head: { ref: 'loopwright/runtime/main', sha: 'a'.repeat(40), repo: { full_name: 'octo/mono', fork: false } },
          base: { ref: 'main', sha: 'b'.repeat(40) },
        }]));
      } else {
        res.end('[]');
      }
      return;
    }
    if (url === '/release.json') {
      if (mode === 'ready' || mode === 'open_pr') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ version: '1.2.0' }));
      } else if (mode === 'unready_404') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'not found' }));
      } else {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`upstream failed for token ${secretToken}`);
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>(resolveReady => server.listen(0, '127.0.0.1', () => resolveReady()));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('expected TCP port');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const fixture = await createStagedSuiteFixture({ probeUrl: `${baseUrl}/release.json` });
  const env = {
    ...CLEAN_ENV,
    GITHUB_WORKSPACE: fixture.repoRoot,
    GITHUB_REPOSITORY: 'octo/mono',
    GITHUB_API_URL: baseUrl,
    GITHUB_TOKEN: secretToken,
  };
  try {
    // 1. Eligible -> exit 0 with matrix entries
    mode = 'ready';
    const eligibleRes = await runCliInProcess([
      'suite', 'resolve', '--suite', fixture.suitePath, '--repo', fixture.repoRoot,
      '--event', 'schedule', '--schedule', 'nightly', '--json',
    ], env);
    assert.equal(eligibleRes.status, 0, eligibleRes.stdout + eligibleRes.stderr);
    const eligibleEnv = JSON.parse(eligibleRes.stdout) as {
      kind: string;
      data: {
        disposition: string;
        matrix: { include: Array<{ domainId: string; taskpackPath: string; baseRevision: string }> };
      };
    };
    assert.equal(eligibleEnv.kind, 'suite');
    assert.equal(eligibleEnv.data.disposition, 'eligible');
    assert.deepEqual(eligibleEnv.data.matrix.include.map(c => c.domainId), ['runtime', 'docs']);
    assert.equal(eligibleEnv.data.matrix.include[0]?.baseRevision, fixture.baseSha);

    // Human-readable non-JSON output includes disposition, reason, matrix, and per-domain outcomes
    const humanRes = await runCliInProcess([
      'suite', 'resolve', '--suite', fixture.suitePath, '--repo', fixture.repoRoot,
      '--event', 'schedule', '--schedule', 'nightly',
    ], env);
    assert.equal(humanRes.status, 0);
    assert.match(humanRes.stdout, /disposition=eligible/);
    assert.match(humanRes.stdout, /reason=ready/);
    assert.match(humanRes.stdout, /matrix=2/);
    assert.match(humanRes.stdout, /docs:eligible:ready/);

    // 2. Deferred (Stage B waiting on Stage A open PR or 404 readiness probe) -> exit 0
    mode = 'open_pr';
    const deferredPrRes = await runCliInProcess([
      'suite', 'resolve', '--suite', fixture.suitePath, '--repo', fixture.repoRoot,
      '--domain', 'docs', '--json',
    ], env);
    assert.equal(deferredPrRes.status, 0, deferredPrRes.stdout + deferredPrRes.stderr);
    const deferredPrEnv = JSON.parse(deferredPrRes.stdout) as { data: { disposition: string; reason: string; matrix: { include: unknown[] } } };
    assert.equal(deferredPrEnv.data.disposition, 'deferred');
    assert.equal(deferredPrEnv.data.reason, 'stage_not_ready');
    assert.equal(deferredPrEnv.data.matrix.include.length, 0);

    mode = 'unready_404';
    const deferredProbeRes = await runCliInProcess([
      'suite', 'resolve', '--suite', fixture.suitePath, '--repo', fixture.repoRoot,
      '--domain', 'docs', '--json',
    ], env);
    assert.equal(deferredProbeRes.status, 0);
    assert.equal(JSON.parse(deferredProbeRes.stdout).data.disposition, 'deferred');

    // 3. Blocked: <domainId> mismatch on PR branch -> exit 3
    mode = 'ready';
    const mismatchRes = await runCliInProcess([
      'suite', 'resolve', '--suite', fixture.suitePath, '--repo', fixture.repoRoot,
      '--event', 'issue_comment',
      '--comment-body', '/loopwright runtime revise',
      '--pr-head-ref', 'loopwright/docs/main',
      '--pr-base-ref', 'main',
      '--json',
    ], env);
    assert.equal(mismatchRes.status, 3, mismatchRes.stdout + mismatchRes.stderr);
    const mismatchEnv = JSON.parse(mismatchRes.stdout) as { data: { disposition: string; reason: string } };
    assert.equal(mismatchEnv.data.disposition, 'blocked');
    assert.equal(mismatchEnv.data.reason, 'domain_branch_mismatch');

    // 4. Blocked: broken readiness probe (500) -> exit 3 & secret scrubbed
    mode = 'error_500';
    const brokenProbeRes = await runCliInProcess([
      'suite', 'resolve', '--suite', fixture.suitePath, '--repo', fixture.repoRoot,
      '--domain', 'docs', '--json',
    ], env);
    assert.equal(brokenProbeRes.status, 3, brokenProbeRes.stdout + brokenProbeRes.stderr);
    assert.equal(JSON.parse(brokenProbeRes.stdout).data.disposition, 'blocked');
    assert.equal(brokenProbeRes.stdout.includes(secretToken), false);
    assert.equal(brokenProbeRes.stderr.includes(secretToken), false);

    // 5. Ignored: untargeted PR comment matching no domain prefix -> exit 0
    mode = 'ready';
    const ignoredRes = await runCliInProcess([
      'suite', 'resolve', '--suite', fixture.suitePath, '--repo', fixture.repoRoot,
      '--event', 'issue_comment',
      '--comment-body', 'just a regular discussion comment',
      '--pr-head-ref', 'loopwright/docs/main',
      '--pr-base-ref', 'main',
      '--json',
    ], env);
    assert.equal(ignoredRes.status, 0, ignoredRes.stdout + ignoredRes.stderr);
    const ignoredEnv = JSON.parse(ignoredRes.stdout) as { data: { disposition: string; reason: string } };
    assert.equal(ignoredEnv.data.disposition, 'ignored');

    // 6. GITHUB_WORKSPACE mismatch prevents using GITHUB_REPOSITORY; explicit LOOPWRIGHT_REPOSITORY takes precedence
    const mismatchedWsRes = await runCliInProcess([
      'suite', 'resolve', '--suite', fixture.suitePath, '--repo', fixture.repoRoot,
      '--domain', 'docs', '--json',
    ], {
      ...env,
      GITHUB_WORKSPACE: fixture.root,
    });
    assert.equal(mismatchedWsRes.status, 3, mismatchedWsRes.stdout + mismatchedWsRes.stderr);
    const mismatchedWsEnv = JSON.parse(mismatchedWsRes.stdout) as { data: { disposition: string; reason: string } };
    assert.equal(mismatchedWsEnv.data.disposition, 'blocked');
    assert.equal(mismatchedWsEnv.data.reason, 'stage_pr_lookup_unavailable');

    const loopwrightOverrideRes = await runCliInProcess([
      'suite', 'resolve', '--suite', fixture.suitePath, '--repo', fixture.repoRoot,
      '--domain', 'docs', '--json',
    ], {
      ...env,
      GITHUB_WORKSPACE: fixture.root,
      GITHUB_REPOSITORY: 'wrong/repo',
      LOOPWRIGHT_REPOSITORY: 'octo/mono',
    });
    assert.equal(loopwrightOverrideRes.status, 0, loopwrightOverrideRes.stdout + loopwrightOverrideRes.stderr);
    assert.equal(JSON.parse(loopwrightOverrideRes.stdout).data.disposition, 'eligible');

    // 7. Unknown --domain returns TASKPACK_MANIFEST_INVALID with usage/manifest exit 2
    const unknownDomainRes = await runCliInProcess([
      'suite', 'resolve', '--suite', fixture.suitePath, '--repo', fixture.repoRoot,
      '--domain', 'nope', '--json',
    ], env);
    assert.equal(unknownDomainRes.status, 2, unknownDomainRes.stdout + unknownDomainRes.stderr);
    const unknownDomainEnv = JSON.parse(unknownDomainRes.stdout) as { data: { disposition: string; code: string } };
    assert.equal(unknownDomainEnv.data.disposition, 'blocked');
    assert.equal(unknownDomainEnv.data.code, 'TASKPACK_MANIFEST_INVALID');

    // 8. suite resolve --json scrubs registered credentials pasted in comment guidance
    mode = 'ready';
    const scrubbedGuidanceRes = await runCliInProcess([
      'suite', 'resolve', '--suite', fixture.suitePath, '--repo', fixture.repoRoot,
      '--event', 'issue_comment',
      '--comment-body', `/loopwright docs revise please avoid leaking ${secretToken}`,
      '--pr-head-ref', 'loopwright/docs/main',
      '--pr-base-ref', 'main',
      '--json',
    ], env);
    assert.equal(scrubbedGuidanceRes.status, 0, scrubbedGuidanceRes.stdout + scrubbedGuidanceRes.stderr);
    assert.equal(scrubbedGuidanceRes.stdout.includes(secretToken), false);
    assert.equal(scrubbedGuidanceRes.stderr.includes(secretToken), false);
    const scrubbedGuidanceEnv = JSON.parse(scrubbedGuidanceRes.stdout) as { data: { comment?: { guidance: string } } };
    assert.match(scrubbedGuidanceEnv.data.comment?.guidance ?? '', /\[scrubbed\]/);
  } finally {
    await fixture.cleanup();
    await new Promise<void>(resolveClosed => server.close(() => resolveClosed()));
  }
});

test('cli-baseline: --baseline-alignment fail-fast halts conflicted sourceRevision with exit 3 before model probes or .git/objects mutations', async () => {
  const probePathsHit: string[] = [];
  const probeServer = createServer((req, res) => {
    probePathsHit.push(req.url ?? '/');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>(resolveReady => probeServer.listen(0, '127.0.0.1', () => resolveReady()));
  const probeAddr = probeServer.address();
  if (probeAddr === null || typeof probeAddr === 'string') throw new Error('expected TCP port');
  const probeBaseUrl = `http://127.0.0.1:${probeAddr.port}`;

  const root = await realpath(await mkdtemp(join(tmpdir(), 'lw-cli-baseline-')));
  const repoRoot = join(root, 'repo');
  const runRoot = join(root, 'runs');
  const modelsJsonPath = join(root, 'models.json');
  try {
    await mkdir(join(repoRoot, '.loopwright'), { recursive: true, mode: 0o700 });
    await mkdir(join(repoRoot, 'docs'), { recursive: true, mode: 0o700 });
    await mkdir(runRoot, { recursive: true, mode: 0o700 });

    await writeFile(
      modelsJsonPath,
      JSON.stringify({
        providers: {
          'custom-a': {
            baseUrl: `${probeBaseUrl}/a/v1`,
            apiKey: 'LW_PROBE_KEY_A',
            api: 'openai-completions',
            models: [{ id: 'model-a' }],
          },
          'custom-b': {
            baseUrl: `${probeBaseUrl}/b/v1`,
            apiKey: 'LW_PROBE_KEY_B',
            api: 'openai-completions',
            models: [{ id: 'model-b' }],
          },
        },
      }),
      { mode: 0o600 },
    );

    const taskpackYaml = `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: baseline-test
spec:
  goal:
    candidate: Update docs/status.json.
    noChange: Confirm docs/status.json is up to date.
  scope:
    writable:
      - docs/**
    protected:
      - .git/**
  verification:
    localChecks:
      - id: docs-ok
        implementation: json-artifact.v1
    externalGates: []
  models:
    - provider: custom-a
      id: model-a
      api: openai-completions
      apiKeyEnv: LW_PROBE_KEY_A
    - provider: custom-b
      id: model-b
      api: openai-completions
      apiKeyEnv: LW_PROBE_KEY_B
  publication:
    mode: disabled
`;
    await writeFile(join(repoRoot, '.loopwright', 'taskpack.yaml'), taskpackYaml, { mode: 0o600 });
    await writeFile(join(repoRoot, 'docs', 'guide.md'), 'line 1: common\nline 2: shared\n', { mode: 0o600 });

    git(repoRoot, ['init', '-q', '-b', 'main']);
    git(repoRoot, ['config', 'user.name', 'Baseline Fixture']);
    git(repoRoot, ['config', 'user.email', 'baseline@example.invalid']);
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '-qm', 'merge-base']);

    // Create diverged source branch with conflicting edit to docs/guide.md
    git(repoRoot, ['checkout', '-qb', 'source-branch']);
    await writeFile(join(repoRoot, 'docs', 'guide.md'), 'line 1: common\nline 2: source-side\n', { mode: 0o600 });
    git(repoRoot, ['add', 'docs/guide.md']);
    git(repoRoot, ['commit', '-qm', 'source edit']);
    const sourceSha = git(repoRoot, ['rev-parse', 'HEAD']);

    // Advance main (baseRevision) with conflicting edit to the same line
    git(repoRoot, ['checkout', '-q', 'main']);
    await writeFile(join(repoRoot, 'docs', 'guide.md'), 'line 1: common\nline 2: base-side\n', { mode: 0o600 });
    git(repoRoot, ['add', 'docs/guide.md']);
    git(repoRoot, ['commit', '-qm', 'base edit']);

    const objectsBefore = await listGitObjectFiles(repoRoot);
    const env = {
      ...CLEAN_ENV,
      LOOPWRIGHT_MODELS_JSON: modelsJsonPath,
      LOOPWRIGHT_ALLOW_MANIFEST_CUSTOM_BASE_URL: 'true',
      LW_PROBE_KEY_A: 'sk-test-probe-a',
      LW_PROBE_KEY_B: 'sk-test-probe-b',
    };

    const runRes = await runCliInProcess([
      'run',
      '--taskpack', '.loopwright/taskpack.yaml',
      '--repo', repoRoot,
      '--run-root', runRoot,
      '--run-id', 'baseline-failfast-1',
      '--mode', 'candidate',
      '--baseline-alignment', 'fail-fast',
      '--source-revision', sourceSha,
      '--json',
    ], env);
    assert.equal(runRes.status, 3, runRes.stdout + runRes.stderr);
    const diag = parseNdjson(runRes.stdout).at(-1)!;
    assert.equal(diag.kind, 'diagnostic');
    assert.equal(diag.data['code'], 'TASKPACK_SCOPE_VIOLATION');
    assert.equal(diag.data['reason'], 'baseline_merge_conflict');
    assert.equal(probePathsHit.length, 0, 'provider health probe must not run when baseline alignment blocks');

    const objectsAfterRun = await listGitObjectFiles(repoRoot);
    assert.deepEqual(objectsAfterRun, objectsBefore, 'host .git/objects must stay unmodified');

    // Also verify step next --taskpack --baseline-alignment fail-fast returns exit 3
    const stepRes = await runCliInProcess([
      'step', 'next',
      '--run-root', runRoot,
      '--run-id', 'baseline-step-failfast-1',
      '--taskpack', '.loopwright/taskpack.yaml',
      '--repo', repoRoot,
      '--mode', 'candidate',
      '--baseline-alignment', 'fail-fast',
      '--source-revision', sourceSha,
      '--json',
    ], env);
    assert.equal(stepRes.status, 3, stepRes.stdout + stepRes.stderr);
    const stepDiag = parseNdjson(stepRes.stdout).at(-1)!;
    assert.equal(stepDiag.kind, 'diagnostic');
    assert.equal(stepDiag.data['reason'], 'baseline_merge_conflict');
    const objectsAfterStep = await listGitObjectFiles(repoRoot);
    assert.deepEqual(objectsAfterStep, objectsBefore, 'host .git/objects must stay unmodified after step next');

    // Also test --baseline-alignment extract-context:
    // A) Protected-path conflict halts BEFORE any model probes with exit 3 (baseline_merge_conflict)
    const protectedTaskpackYaml = `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: baseline-protected-test
spec:
  goal:
    candidate: Update docs/status.json.
    noChange: Confirm docs/status.json is up to date.
  scope:
    writable:
      - docs/**
    protected:
      - .git/**
      - docs/protected.md
  verification:
    localChecks:
      - id: docs-ok
        implementation: json-artifact.v1
    externalGates: []
  models:
    - provider: custom-a
      id: model-a
      api: openai-completions
      apiKeyEnv: LW_PROBE_KEY_A
    - provider: custom-b
      id: model-b
      api: openai-completions
      apiKeyEnv: LW_PROBE_KEY_B
  publication:
    mode: disabled
`;
    await writeFile(join(repoRoot, '.loopwright', 'protected-taskpack.yaml'), protectedTaskpackYaml, { mode: 0o600 });
    await writeFile(join(repoRoot, 'docs', 'protected.md'), 'shared protected line\n', { mode: 0o600 });
    git(repoRoot, ['add', '.loopwright/protected-taskpack.yaml', 'docs/protected.md']);
    git(repoRoot, ['commit', '-qm', 'add protected baseline']);

    git(repoRoot, ['checkout', '-qb', 'prot-source']);
    await writeFile(join(repoRoot, 'docs', 'protected.md'), 'source protected line\n', { mode: 0o600 });
    git(repoRoot, ['add', 'docs/protected.md']);
    git(repoRoot, ['commit', '-qm', 'source protected conflict']);
    const protSourceSha = git(repoRoot, ['rev-parse', 'HEAD']);

    git(repoRoot, ['checkout', '-q', 'main']);
    await writeFile(join(repoRoot, 'docs', 'protected.md'), 'base protected line\n', { mode: 0o600 });
    git(repoRoot, ['add', 'docs/protected.md']);
    git(repoRoot, ['commit', '-qm', 'base protected conflict']);

    const objectsBeforeProtected = await listGitObjectFiles(repoRoot);
    const protRes = await runCliInProcess([
      'run',
      '--taskpack', '.loopwright/protected-taskpack.yaml',
      '--repo', repoRoot,
      '--run-root', runRoot,
      '--run-id', 'baseline-extract-protected-1',
      '--mode', 'candidate',
      '--baseline-alignment', 'extract-context',
      '--source-revision', protSourceSha,
      '--json',
    ], env);
    assert.equal(protRes.status, 3, protRes.stdout + protRes.stderr);
    const protDiag = parseNdjson(protRes.stdout).at(-1)!;
    assert.equal(protDiag.kind, 'diagnostic');
    assert.equal(protDiag.data['code'], 'TASKPACK_SCOPE_VIOLATION');
    assert.equal(protDiag.data['reason'], 'baseline_merge_conflict');
    assert.equal(probePathsHit.length, 0, 'provider probe must not run on protected extract-context conflict');
    assert.deepEqual(await listGitObjectFiles(repoRoot), objectsBeforeProtected);

    // B) Writable-path conflict via step next --taskpack --baseline-alignment extract-context:
    //    stages baseline-conflict-context resource, fails unresolved submit with baseline_merge_conflict,
    //    and passes when conflict is cleanly resolved.
    const delegatedTaskpackYaml = `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: baseline-extract-step
spec:
  goal:
    candidate: Resolve baseline conflict in docs/guide.md.
    noChange: Confirm docs/guide.md is up to date.
  scope:
    writable:
      - docs/**
    protected:
      - .git/**
  roles:
    - id: author
      provider: antigravity
      model: gemini-4-default
      thinking: low
  limits:
    maxImplementationRepairs: 0
    maxAttempts: 2
  verification:
    localChecks: []
    externalGates: []
  publication:
    mode: disabled
`;
    await writeFile(join(repoRoot, '.loopwright', 'extract-step-taskpack.yaml'), delegatedTaskpackYaml, { mode: 0o600 });
    git(repoRoot, ['add', '.loopwright/extract-step-taskpack.yaml']);
    git(repoRoot, ['commit', '-qm', 'add delegated extract-context taskpack']);

    // Unresolved case: leave docs/guide.md untouched (touch only docs/other.md) -> gate denies with baseline_merge_conflict
    const extractNext1 = await runCliInProcess([
      'step', 'next',
      '--run-root', runRoot,
      '--run-id', 'extract-unresolved-1',
      '--taskpack', '.loopwright/extract-step-taskpack.yaml',
      '--repo', repoRoot,
      '--mode', 'candidate',
      '--baseline-alignment', 'extract-context',
      '--source-revision', sourceSha,
      '--json',
    ], CLEAN_ENV);
    assert.equal(extractNext1.status, 0, extractNext1.stdout + extractNext1.stderr);
    const extractStep1 = parseNdjson(extractNext1.stdout)[0]!.data;
    assert.equal(extractStep1['status'], 'awaiting_role');
    const contextFiles = extractStep1['contextFiles'] as readonly string[] | undefined;
    assert.ok(
      Array.isArray(contextFiles) && contextFiles.some(cf => typeof cf === 'string' && cf.includes('.loopwright-baseline/conflicts.json')),
      `expected baseline-conflict-context in contextFiles: ${JSON.stringify(contextFiles)}`,
    );

    const candDir1 = String(extractStep1['candidateDir']);
    await writeFile(join(candDir1, 'docs', 'other.md'), 'unrelated edit\n', { mode: 0o600 });
    const unresolvedSubmit = await runCliInProcess([
      'step', 'submit',
      '--run-root', runRoot,
      '--run-id', 'extract-unresolved-1',
      '--lease', String(extractStep1['leaseToken']),
      '--json',
    ], CLEAN_ENV);
    assert.equal(unresolvedSubmit.status, 4, unresolvedSubmit.stdout + unresolvedSubmit.stderr);
    const unresolvedEnv = parseNdjson(unresolvedSubmit.stdout).at(-1)!;
    assert.equal(unresolvedEnv.kind, 'result');
    const unresolvedRequired = (
      unresolvedEnv.data['result'] as {
        spec: {
          status: string;
          verification: { spec: { required: Array<{ checkId: string; status: string; detail: string | null }> } };
        };
      }
    ).spec.verification.spec.required;
    assert.ok(
      unresolvedRequired.some(row => row.checkId === 'baseline-conflict-resolution' && row.status === 'failed' && row.detail === 'gate_denied'),
      `expected failed baseline-conflict-resolution gate check: ${JSON.stringify(unresolvedRequired)}`,
    );

    // Resolved case: write clean merged docs/guide.md without conflict markers -> completes with exit 0
    const extractNext2 = await runCliInProcess([
      'step', 'next',
      '--run-root', runRoot,
      '--run-id', 'extract-resolved-1',
      '--taskpack', '.loopwright/extract-step-taskpack.yaml',
      '--repo', repoRoot,
      '--mode', 'candidate',
      '--baseline-alignment', 'extract-context',
      '--source-revision', sourceSha,
      '--json',
    ], CLEAN_ENV);
    assert.equal(extractNext2.status, 0, extractNext2.stdout + extractNext2.stderr);
    const extractStep2 = parseNdjson(extractNext2.stdout)[0]!.data;
    await writeFile(join(String(extractStep2['candidateDir']), 'docs', 'guide.md'), 'line 1: common\nline 2: merged-clean\n', { mode: 0o600 });
    const resolvedSubmit = await runCliInProcess([
      'step', 'submit',
      '--run-root', runRoot,
      '--run-id', 'extract-resolved-1',
      '--lease', String(extractStep2['leaseToken']),
      '--json',
    ], CLEAN_ENV);
    assert.equal(resolvedSubmit.status, 0, resolvedSubmit.stdout + resolvedSubmit.stderr);
    assert.equal(parseNdjson(resolvedSubmit.stdout).at(-1)!.kind, 'result');
  } finally {
    await new Promise<void>(resolveClosed => probeServer.close(() => resolveClosed()));
    await rm(root, { recursive: true, force: true });
  }
});

test('cli-runeval: inspect --json and --output-format markdown,github-step-summary + --step-summary-file emit RunEval metrics and autoApplied:false hints', async () => {
  const f = await cycleFixture(true);
  const delegated = await createManagedDelegatedRepoFixture({ maxImplementationRepairs: 1, maxAttempts: 4 });
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lw-cli-runeval-')));
  try {
    // 1. Cycle fixture run -> markdown + github-step-summary + inspect --json + run-eval.json bundle export
    const cycleCommon = ['--config', f.input.configPath, '--registry', f.input.registryPath, '--registry-sha256', f.input.registrySha256];
    const cycleSummaryFile = join(root, 'cycle-summary.md');
    const cycleRun = spawnSync(
      process.execPath,
      [
        MAIN_PATH, 'run', ...cycleCommon,
        '--repo', f.repository, '--run-root', f.runRoot, '--run-id', 'runeval-cycle-1',
        '--output-format', 'markdown,github-step-summary',
        '--step-summary-file', cycleSummaryFile,
      ],
      { encoding: 'utf8', timeout: 15_000, env: CLEAN_ENV },
    );
    assert.equal(cycleRun.status, 0, cycleRun.stdout + cycleRun.stderr);
    assert.match(cycleRun.stdout, /### Run Health/);
    assert.match(cycleRun.stdout, /#### Breakdown by Step/);
    const cycleSummaryMd = await readFile(cycleSummaryFile, 'utf8');
    assert.match(cycleSummaryMd, /### Run Health/);
    assert.match(cycleSummaryMd, /\| Repair Convergence \|/);

    const exportDir = join(root, 'inspect-export');
    const inspectCycle = spawnSync(
      process.execPath,
      [MAIN_PATH, 'inspect', '--run-root', f.runRoot, '--run-id', 'runeval-cycle-1', '--output', exportDir, '--json'],
      { encoding: 'utf8', timeout: 15_000, env: CLEAN_ENV },
    );
    assert.equal(inspectCycle.status, 0, inspectCycle.stdout + inspectCycle.stderr);
    const inspectEnv = JSON.parse(inspectCycle.stdout) as {
      kind: string;
      data: {
        runEval: {
          schemaVersion: number;
          breakdown: { byStep: unknown[]; byRole: unknown[] };
          suggestions: Array<{ autoApplied: boolean }>;
        } | null;
      };
    };
    assert.equal(inspectEnv.kind, 'inspection');
    assert.notEqual(inspectEnv.data.runEval, null);
    assert.ok(inspectEnv.data.runEval!.breakdown.byStep.length >= 1);
    const exportedEval = JSON.parse(await readFile(join(exportDir, 'run-eval.json'), 'utf8')) as { runId: string };
    assert.equal(exportedEval.runId, 'runeval-cycle-1');

    // 2. Delegated step run that fails repair convergence -> emits non-empty suggestions with autoApplied: false
    const stepSummaryFile = join(root, 'step-summary.md');
    const stepCommon = ['--config', delegated.input.configPath, '--registry', delegated.input.registryPath, '--registry-sha256', delegated.input.registrySha256];
    const stepTarget = ['--run-root', delegated.runRoot, '--run-id', 'runeval-step-1'];

    const next1 = await runCliInProcess(['step', 'next', ...stepTarget, ...stepCommon, '--repo', delegated.repository, '--json'], CLEAN_ENV);
    assert.equal(next1.status, 0, next1.stdout + next1.stderr);
    const next1Data = parseNdjson(next1.stdout)[0]!.data;
    const lease1 = String(next1Data['leaseToken']);
    await writeFile(join(String(next1Data['candidateDir']), 'packages', 'result.json'), JSON.stringify({ ok: false, attempt: 1 }), { mode: 0o600 });

    // Submit author -> yields review
    const sub1 = await runCliInProcess(['step', 'submit', ...stepTarget, '--lease', lease1, '--json'], CLEAN_ENV);
    assert.equal(sub1.status, 0, sub1.stdout + sub1.stderr);
    const lease2 = String(parseNdjson(sub1.stdout)[0]!.data['leaseToken']);

    // Submit review -> verify fails -> implementation repair yields author
    const sub2 = await runCliInProcess(['step', 'submit', ...stepTarget, '--lease', lease2, '--json'], CLEAN_ENV);
    assert.equal(sub2.status, 0, sub2.stdout + sub2.stderr);
    const sub2Data = parseNdjson(sub2.stdout)[0]!.data;
    const lease3 = String(sub2Data['leaseToken']);

    // Submit repair author with updated failing artifact -> yields review
    await writeFile(join(String(sub2Data['candidateDir']), 'packages', 'result.json'), JSON.stringify({ ok: false, attempt: 2 }), { mode: 0o600 });
    const sub3 = await runCliInProcess(['step', 'submit', ...stepTarget, '--lease', lease3, '--json'], CLEAN_ENV);
    assert.equal(sub3.status, 0, sub3.stdout + sub3.stderr);
    const lease4 = String(parseNdjson(sub3.stdout)[0]!.data['leaseToken']);

    // Submit repair review -> verify fails -> repair budget exhausted (exit 5)
    // Exercise text, json, markdown, and github-step-summary outputs together
    const sub4 = await runCliInProcess([
      'step', 'submit', ...stepTarget, '--lease', lease4,
      '--output-format', 'text,json,markdown,github-step-summary',
      '--step-summary-file', stepSummaryFile,
    ], CLEAN_ENV);
    assert.equal(sub4.status, 5, sub4.stdout + sub4.stderr);
    assert.match(sub4.stdout, /^Run Health:$/m);
    assert.match(sub4.stdout, /\[autoApplied=false\]/);
    assert.match(sub4.stdout, /### Run Health/);
    assert.match(sub4.stdout, /#### Breakdown by Role/);
    assert.match(sub4.stdout, /#### Breakdown by Step/);
    assert.match(sub4.stdout, /\[autoApplied: false\]/);

    const jsonLine = sub4.stdout.split('\n').find(line => line.startsWith('{"runId":'));
    assert.ok(jsonLine !== undefined, 'expected --output-format json line in stdout');
    const jsonReport = JSON.parse(jsonLine) as {
      runEval: {
        toolTelemetry: string;
        breakdown: { byRole: unknown[]; byStep: unknown[] };
        suggestions: Array<{ autoApplied: boolean }>;
      } | null;
    };
    assert.notEqual(jsonReport.runEval, null);
    assert.equal(jsonReport.runEval!.toolTelemetry, 'delegated_unavailable');
    assert.ok(jsonReport.runEval!.breakdown.byRole.length >= 1);
    assert.ok(jsonReport.runEval!.breakdown.byStep.length >= 1);
    assert.ok(jsonReport.runEval!.suggestions.length >= 1);
    for (const suggestion of jsonReport.runEval!.suggestions) {
      assert.equal(suggestion.autoApplied, false);
    }

    const stepSummaryMd = await readFile(stepSummaryFile, 'utf8');
    assert.match(stepSummaryMd, /### Run Health/);
    assert.match(stepSummaryMd, /#### Breakdown by Role/);
    assert.match(stepSummaryMd, /\[autoApplied: false\]/);

    const inspectStep = await runCliInProcess(['inspect', ...stepTarget, '--json'], CLEAN_ENV);
    assert.equal(inspectStep.status, 0, inspectStep.stdout + inspectStep.stderr);
    const stepInspectData = parseNdjson(inspectStep.stdout)[0]!.data as {
      runEval: {
        toolTelemetry: string;
        breakdown: { byRole: unknown[]; byStep: unknown[] };
        suggestions: Array<{ code: string; autoApplied: boolean }>;
      } | null;
    };
    assert.notEqual(stepInspectData.runEval, null);
    assert.equal(stepInspectData.runEval!.toolTelemetry, 'delegated_unavailable');
    assert.ok(stepInspectData.runEval!.breakdown.byRole.length >= 1);
    assert.ok(stepInspectData.runEval!.breakdown.byStep.length >= 1);
    assert.ok(stepInspectData.runEval!.suggestions.length >= 1);
    for (const suggestion of stepInspectData.runEval!.suggestions) {
      assert.equal(suggestion.autoApplied, false);
    }
  } finally {
    await f.cleanup();
    await delegated.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
