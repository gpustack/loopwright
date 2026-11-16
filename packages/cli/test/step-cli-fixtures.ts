import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedHandlerDigests } from '@loopwright/controller';
import { serializePrettyYaml } from '@loopwright/github-app';
import { configurationFixture } from '../../controller/test/config-fixtures.js';
import { setFixture } from '../../controller/test/progress-fixtures.js';

export const MAIN_PATH = fileURLToPath(new URL('../src/main.js', import.meta.url));
export const CLEAN_ENV = { PATH: '/usr/bin:/bin' };

export function runCli(argv: readonly string[], env: Record<string, string> = CLEAN_ENV) {
  return spawnSync(process.execPath, [MAIN_PATH, ...argv], {
    encoding: 'utf8',
    timeout: 20_000,
    env,
  });
}

export function parseNdjson(stdout: string): readonly {
  readonly version: number;
  readonly kind: string;
  readonly sequence: number;
  readonly runId: string | null;
  readonly data: Record<string, unknown>;
}[] {
  const lines = stdout.trim().split('\n').filter(line => line.length > 0);
  return lines.map(line => JSON.parse(line) as {
    readonly version: number;
    readonly kind: string;
    readonly sequence: number;
    readonly runId: string | null;
    readonly data: Record<string, unknown>;
  });
}

export function gitStatusPorcelain(repoDir: string): string {
  return execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', 'status', '--porcelain'], {
    cwd: repoDir,
    env: {
      PATH: '/usr/bin:/bin',
      LANG: 'C',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      HOME: '/nonexistent',
      GIT_TERMINAL_PROMPT: '0',
    },
    timeout: 5000,
    encoding: 'utf8',
  });
}

export async function createManagedDelegatedRepoFixture(options?: {
  readonly noChangeCheck?: boolean;
  readonly maxImplementationRepairs?: number;
  readonly maxAttempts?: number;
  readonly wallTimeMs?: number;
  readonly drainReserveMs?: number;
}) {
  const f = await configurationFixture();
  const repository = join(f.root, 'repository');
  const runRoot = join(f.root, 'runs');
  await mkdir(repository, { mode: 0o700 });
  const git = (args: string[]) =>
    execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: repository,
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        HOME: '/nonexistent',
        GIT_TERMINAL_PROMPT: '0',
      },
      timeout: 5000,
      encoding: 'utf8',
    });
  git(['init', '-q']);
  await mkdir(join(repository, 'packages'), { recursive: true, mode: 0o700 });
  await mkdir(join(repository, 'docs'), { recursive: true, mode: 0o700 });
  await mkdir(join(repository, '.github', 'workflows'), { recursive: true, mode: 0o700 });
  await writeFile(join(repository, 'packages', 'result.json'), JSON.stringify({ ok: false }), { mode: 0o600 });
  await writeFile(join(repository, 'docs', 'readme.md'), '# Protected Doc\n', { mode: 0o600 });
  await writeFile(join(repository, '.github', 'workflows', 'ci.yml'), 'name: CI\n', { mode: 0o600 });
  git(['add', '.']);
  git(['-c', 'user.name=Step CLI Fixture', '-c', 'user.email=fixture@localhost.invalid', 'commit', '-qm', 'initial baseline']);
  const revision = git(['rev-parse', 'HEAD']).trim();

  const installed = await installedHandlerDigests();
  setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], revision);
  setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], revision);
  setFixture(f.config, ['spec', 'task', 'spec', 'scope'], {
    writable: ['packages/**'],
    protected: ['docs/**', '.github/workflows/**'],
  });
  if (options?.maxImplementationRepairs !== undefined) {
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxImplementationRepairs'], options.maxImplementationRepairs);
  }
  if (options?.maxAttempts !== undefined) {
    setFixture(f.config, ['spec', 'controls', 'maxAttempts'], options.maxAttempts);
  }
  if (options?.drainReserveMs !== undefined) {
    setFixture(f.config, ['spec', 'controls', 'drainReserveMs'], options.drainReserveMs);
  }
  if (options?.wallTimeMs !== undefined) {
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'wallTimeMs'], options.wallTimeMs);
  }

  const handlers: Record<string, unknown>[] = [
    {
      id: 'author.step',
      version: 1,
      digest: installed['pi.agent.v1'],
      kind: 'agent',
      implementation: 'pi.agent.v1',
      parameters: { purpose: 'task', prompt: 'Update packages/result.json so ok is true.' },
      capabilities: ['pi'],
    },
    {
      id: 'review.step',
      version: 1,
      digest: installed['pi.agent.v1'],
      kind: 'agent',
      implementation: 'pi.agent.v1',
      parameters: { purpose: 'review', prompt: 'Review candidate changes and confirm verification.' },
      capabilities: ['pi'],
    },
    {
      id: 'tests',
      version: 1,
      digest: installed['json-artifact.v1'],
      kind: 'check',
      implementation: 'json-artifact.v1',
      parameters: { checkId: 'tests', path: 'packages/result.json', required: ['ok'], equals: { ok: true } },
      capabilities: ['inert_bytes', 'read_only'],
    },
    {
      id: 'no-change-explicit',
      version: 1,
      digest: installed['no-change.v1'],
      kind: 'check',
      implementation: 'no-change.v1',
      parameters: { checkId: 'unchanged' },
      capabilities: ['inert_bytes', 'read_only'],
    },
    ...f.registry.spec.handlers.filter(h => h.id === 'scope' || h.id === 'no-change').map(h => ({ ...h })),
  ];
  setFixture(f.registry, ['spec', 'handlers'], handlers);
  setFixture(f.registry, ['spec', 'runtimeProfiles'], []);
  setFixture(f.registry, ['spec', 'credentialBindings'], []);
  setFixture(f.registry, ['spec', 'environmentBindings'], []);
  setFixture(f.config, ['spec', 'credentials'], []);

  setFixture(f.registry, ['spec', 'roleProfiles'], [
    {
      id: 'author',
      adapter: 'delegated',
      runtimeRef: null,
      providerCredentialRef: null,
      selection: { provider: 'antigravity', model: 'gemini-4-default', thinking: 'medium' },
      tools: ['read', 'write', 'edit', 'bash', 'delete'],
      mcp: null,
    },
    {
      id: 'review',
      adapter: 'delegated',
      runtimeRef: null,
      providerCredentialRef: null,
      selection: { provider: 'antigravity', model: 'gemini-4-default', thinking: 'medium' },
      tools: ['read'],
      mcp: null,
    },
  ]);

  setFixture(f.config, ['spec', 'task', 'spec', 'roles'], [
    {
      id: 'author',
      adapter: 'delegated',
      provider: 'antigravity',
      model: 'gemini-4-default',
      thinking: 'medium',
      tools: ['read', 'write', 'edit'],
    },
    {
      id: 'review',
      adapter: 'delegated',
      provider: 'antigravity',
      model: 'gemini-4-default',
      thinking: 'medium',
      tools: ['read'],
    },
  ]);
  setFixture(f.config, ['spec', 'profiles', 'roles'], [
    { roleId: 'author', profileRef: 'author' },
    { roleId: 'review', profileRef: 'review' },
  ]);

  if (options?.noChangeCheck) {
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'author', kind: 'agent', uses: 'author.step', roleId: 'author', dependsOn: [] },
      { id: 'verify-unchanged', kind: 'check', uses: 'no-change-explicit', roleId: null, dependsOn: ['author'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'author', handlerRef: 'author.step' },
      { stepId: 'verify-unchanged', handlerRef: 'no-change-explicit' },
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'acceptance'], {
      required: ['unchanged'],
      checks: [{ id: 'unchanged', allowedEvidenceLevels: ['local_execution'] }],
    });
  } else {
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'author', kind: 'agent', uses: 'author.step', roleId: 'author', dependsOn: [] },
      { id: 'review', kind: 'agent', uses: 'review.step', roleId: 'review', dependsOn: ['author'] },
      { id: 'verify', kind: 'check', uses: 'tests', roleId: null, dependsOn: ['review'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'author', handlerRef: 'author.step' },
      { stepId: 'review', handlerRef: 'review.step' },
      { stepId: 'verify', handlerRef: 'tests' },
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'acceptance'], {
      required: ['tests'],
      checks: [{ id: 'tests', allowedEvidenceLevels: ['local_execution'] }],
    });
  }

  await f.save();
  return { ...f, repository, runRoot, revision };
}

export async function createTaskpackRepo(
  repoRoot: string,
  options?: {
    readonly writable?: readonly string[];
    readonly verifyScript?: string;
    readonly withCommandCheck?: boolean;
  },
): Promise<void> {
  await mkdir(join(repoRoot, '.loopwright', 'checks'), { recursive: true, mode: 0o700 });
  await mkdir(join(repoRoot, 'docs'), { recursive: true, mode: 0o700 });
  await writeFile(join(repoRoot, 'docs', 'proposal.json'), JSON.stringify({ schema_version: 1, candidates: [] }), { mode: 0o600 });
  await writeFile(join(repoRoot, 'docs', 'upstream-versions.json'), JSON.stringify({ version: '1.0.0' }), { mode: 0o600 });
  await writeFile(
    join(repoRoot, '.loopwright', 'checks', 'verify.sh'),
    options?.verifyScript ?? '#!/bin/sh\ngrep -q \'"ready"\' docs/proposal.json\n',
    { mode: 0o755 },
  );
  const localChecks: Record<string, unknown>[] = [
    { id: 'docs-proposal-json', implementation: 'json-artifact.v1' },
  ];
  if (options?.withCommandCheck !== false) {
    localChecks.push({
      id: 'cmd-check',
      implementation: 'command.v1',
      parameters: { script: '.loopwright/checks/verify.sh', timeoutSeconds: 10 },
    });
  }
  const taskpackDoc = {
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'Taskpack',
    metadata: { name: 'turnkey-step-demo' },
    spec: {
      goal: {
        candidate: 'Update docs/proposal.json with candidate entries.',
        noChange: 'Confirm no changes needed.',
      },
      scope: {
        writable: [...(options?.writable ?? ['docs'])],
        protected: ['docs/protected.md'],
      },
      roles: [
        { id: 'author', provider: 'antigravity', model: 'gemini-4-default', thinking: 'low' },
      ],
      upstreams: [
        { id: 'engine', kind: 'custom-table', source: 'docs/upstream-versions.json', watchedPaths: ['docs'] },
      ],
      proposal: {
        path: 'docs/proposal.json',
        requiredFields: ['schema_version', 'candidates'],
        schemaVersion: 1,
      },
      verification: {
        localChecks,
        externalGates: [],
      },
      publication: {
        mode: 'disabled',
        targetBranch: 'main',
        headBranchPrefix: 'loopwright-docs-',
        titleTemplate: 'docs: sync',
      },
      memory: {
        directory: '.loopwright/memory/turnkey-step-demo',
        apply: 'separate-pull-request',
        onNoModelBudget: 'deterministic-observations-only',
      },
      triggers: {
        schedule: true,
        workflowDispatch: true,
        releasePublished: false,
        commentCommands: ['retry', 'revise', 'status'],
      },
    },
  };
  await writeFile(join(repoRoot, '.loopwright', 'taskpack.yaml'), serializePrettyYaml(taskpackDoc), { mode: 0o600 });
  const git = (args: string[]) =>
    execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: repoRoot,
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        HOME: '/nonexistent',
        GIT_TERMINAL_PROMPT: '0',
      },
      encoding: 'utf8',
    });
  git(['init', '-q']);
  git(['add', '.']);
  git(['-c', 'user.name=Taskpack CLI', '-c', 'user.email=tp@localhost.invalid', 'commit', '-qm', 'init']);
}
