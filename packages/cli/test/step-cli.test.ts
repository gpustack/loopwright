import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedHandlerDigests } from '@loopwright/controller';
import { GITHUB_APP_ERROR_CODES, serializePrettyYaml, type GitHubAppErrorCode } from '@loopwright/github-app';
import { configurationFixture } from '../../controller/test/config-fixtures.js';
import { setFixture } from '../../controller/test/progress-fixtures.js';
import { parseArguments, UsageError } from '../src/arguments.js';
import { gitHubAppExitCode, main as cliMain } from '../src/main.js';

const MAIN_PATH = fileURLToPath(new URL('../src/main.js', import.meta.url));
const CLEAN_ENV = { PATH: '/usr/bin:/bin' };

function runCli(argv: readonly string[], env: Record<string, string> = CLEAN_ENV) {
  return spawnSync(process.execPath, [MAIN_PATH, ...argv], {
    encoding: 'utf8',
    timeout: 20_000,
    env,
  });
}

function parseNdjson(stdout: string): readonly {
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

function gitStatusPorcelain(repoDir: string): string {
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

async function createManagedDelegatedRepoFixture(options?: {
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

test('step-cli: parseArguments supports step subcommands (positional & --action), argv ceiling 64, and repeatable --role-model', () => {
  const commonConfig = ['--config', '/cfg.yaml', '--registry', '/reg.yaml', '--registry-sha256', 'a'.repeat(64)];
  const runTarget = ['--run-root', '/runs', '--run-id', 'step-1'];

  // Positional and --action subactions
  const posNext = parseArguments(['step', 'next', ...runTarget, '--reissue-lease', '--json']);
  assert.equal(posNext.command, 'step');
  assert.equal(posNext.stepAction, 'next');
  assert.equal(posNext.flags.has('reissue-lease'), true);
  assert.equal(posNext.flags.has('json'), true);

  const flagNext = parseArguments(['step', '--action', 'next', ...runTarget, '--taskpack', '.loopwright/taskpack.yaml', '--repo', '/repo', '--mode', 'no-change']);
  assert.equal(flagNext.command, 'step');
  assert.equal(flagNext.stepAction, 'next');
  assert.equal(flagNext.values.get('mode'), 'no-change');

  // --action appearing after --role-model
  const lateAction = parseArguments(['step', ...runTarget, '--taskpack', 'taskpack.yaml', '--repo', '/repo', '--role-model', 'author=antigravity/gemini-4-carbon:medium', '--action', 'next']);
  assert.equal(lateAction.stepAction, 'next');
  assert.deepEqual(lateAction.roleModelOverrides, [
    { roleId: 'author', provider: 'antigravity', model: 'gemini-4-carbon', thinking: 'medium' },
  ]);

  const posSubmit = parseArguments(['step', 'submit', ...runTarget, '--lease', 'a'.repeat(64), '--status', 'failed', '--reason', 'check failed', '--submission-file', '/sub.json', '--output-format', 'json,text', '--step-summary-file', '/sum.md', '--json']);
  assert.equal(posSubmit.stepAction, 'submit');
  assert.equal(posSubmit.values.get('status'), 'failed');
  assert.equal(posSubmit.values.get('reason'), 'check failed');

  const flagSubmit = parseArguments(['step', '--action', 'submit', ...runTarget, '--lease', 'tok-1', '--status', 'no_change']);
  assert.equal(flagSubmit.stepAction, 'submit');

  const posCancel = parseArguments(['step', 'cancel', ...runTarget, '--output-format', 'markdown', '--step-summary-file', '/sum.md', '--json']);
  assert.equal(posCancel.stepAction, 'cancel');

  const flagCancel = parseArguments(['step', '--action', 'cancel', ...runTarget]);
  assert.equal(flagCancel.stepAction, 'cancel');

  // 8 repeatable --role-model entries across check, run, resume, step next (including model containing '/' and omitted thinking)
  const eightModels = [
    '--role-model', 'r1=antigravity/gemini-4-carbon:high',
    '--role-model', 'r2=antigravity/gemini-4-argon:low',
    '--role-model', 'r3=openrouter/anthropic/claude-sonnet-4:medium',
    '--role-model', 'r4=openai/gpt-6.1-terra',
    '--role-model', 'r5.sub=anthropic/claude-opus-4:high',
    '--role-model', 'r6_alt=google/gemini-2.5-pro:low',
    '--role-model', 'r7-v2=zai/glm-5.3',
    '--role-model', 'r8=local/custom/model-x:minimal',
  ];
  for (const base of [
    ['check', ...commonConfig],
    ['run', ...commonConfig, '--dry-run'],
    ['run', ...commonConfig, '--repo', '/repo', ...runTarget],
    ['resume', ...commonConfig, '--repo', '/repo', ...runTarget],
    ['step', 'next', ...commonConfig, '--repo', '/repo', ...runTarget],
    ['step', 'next', '--taskpack', 'tp.yaml', '--repo', '/repo', ...runTarget],
  ]) {
    const parsed = parseArguments([...base, ...eightModels]);
    assert.equal(parsed.roleModelOverrides?.length, 8);
    assert.deepEqual(parsed.roleModelOverrides?.[2], {
      roleId: 'r3',
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4',
      thinking: 'medium',
    });
    assert.deepEqual(parsed.roleModelOverrides?.[3], {
      roleId: 'r4',
      provider: 'openai',
      model: 'gpt-6.1-terra',
    });
  }

  // Omitted --role-model leaves roleModelOverrides undefined
  assert.equal(parseArguments(['check', ...commonConfig]).roleModelOverrides, undefined);

  // argv length ceiling: 64 allowed (non-length error if bad flag, or exact 64), 65 rejected with UsageError
  const sixtyFiveArgs = ['step', 'next', ...runTarget, ...Array.from({ length: 59 }, () => '--json')];
  assert.equal(sixtyFiveArgs.length, 65);
  assert.throws(() => parseArguments(sixtyFiveArgs), UsageError);

  const thirtyNineValidArgs = [
    'step', '--action', 'next', ...runTarget, ...commonConfig, '--repo', '/repo',
    '--mode', 'candidate', '--output-format', 'json', '--step-summary-file', '/sum.md',
    '--reissue-lease', '--json', ...eightModels,
  ];
  assert.equal(thirtyNineValidArgs.length, 39);
  assert.doesNotThrow(() => parseArguments(thirtyNineValidArgs));
});

test('step-cli: parseArguments rejects malformed --role-model, conflicting step subactions, and invalid flag combinations', () => {
  const commonConfig = ['--config', '/cfg.yaml', '--registry', '/reg.yaml', '--registry-sha256', 'a'.repeat(64)];
  const runTarget = ['--run-root', '/runs', '--run-id', 'step-1'];

  const invalidCases: readonly (readonly string[])[] = [
    // Missing / unknown / both subactions / extra positional
    ['step'],
    ['step', ...runTarget],
    ['step', 'unknown', ...runTarget],
    ['step', '--action', 'unknown', ...runTarget],
    ['step', 'next', '--action', 'next', ...runTarget],
    ['step', 'next', 'extra', ...runTarget],
    // 9th --role-model exceeds cap
    [
      'check', ...commonConfig,
      '--role-model', 'r1=p/m', '--role-model', 'r2=p/m', '--role-model', 'r3=p/m',
      '--role-model', 'r4=p/m', '--role-model', 'r5=p/m', '--role-model', 'r6=p/m',
      '--role-model', 'r7=p/m', '--role-model', 'r8=p/m', '--role-model', 'r9=p/m',
    ],
    // Duplicate roleId
    ['check', ...commonConfig, '--role-model', 'author=p/m1', '--role-model', 'author=p/m2'],
    // Unsupported commands for --role-model
    ['step', 'submit', ...runTarget, '--lease', 'tok', '--role-model', 'author=p/m'],
    ['step', 'cancel', ...runTarget, '--role-model', 'author=p/m'],
    ['reconcile', ...commonConfig, '--repo', '/repo', ...runTarget, '--receipt', '/r.json', '--role-model', 'author=p/m'],
    ['status', ...runTarget, '--role-model', 'author=p/m'],
    ['inspect', ...runTarget, '--role-model', 'author=p/m'],
    ['init', '--directory', '/dir', '--role-model', 'author=p/m'],
    ['closure', '--role-model', 'author=p/m'],
    ['app-serve', '--config', '/app.yaml', '--role-model', 'author=p/m'],
    // --role-model on bare step next (no --taskpack or --config)
    ['step', 'next', ...runTarget, '--role-model', 'author=p/m'],
    // Malformed --role-model syntax
    ['check', ...commonConfig, '--role-model'],
    ['check', ...commonConfig, '--role-model', '--json'],
    ['check', ...commonConfig, '--role-model', 'author:p/m'],
    ['check', ...commonConfig, '--role-model', '=p/m'],
    ['check', ...commonConfig, '--role-model', 'author='],
    ['check', ...commonConfig, '--role-model', 'BadRole=p/m'],
    ['check', ...commonConfig, '--role-model', `${'a'.repeat(65)}=p/m`],
    ['check', ...commonConfig, '--role-model', 'author=provideronly'],
    ['check', ...commonConfig, '--role-model', 'author=/model'],
    ['check', ...commonConfig, '--role-model', 'author=provider/'],
    ['check', ...commonConfig, '--role-model', 'author=provider/:high'],
    ['check', ...commonConfig, '--role-model', 'author=provider/model:'],
    ['check', ...commonConfig, '--role-model', 'author=provider/model:high:extra'],
    ['check', ...commonConfig, '--role-model', 'author=pro vider/model'],
    ['check', ...commonConfig, '--role-model', 'author=provider/mo del'],
    ['check', ...commonConfig, '--role-model', 'author=provider/model:hi gh'],
    ['check', ...commonConfig, '--role-model', 'author=provider/model:\x07'],
    ['check', ...commonConfig, '--role-model', `author=${'p'.repeat(129)}/m`],
    ['check', ...commonConfig, '--role-model', `author=p/${'m'.repeat(129)}`],
    ['check', ...commonConfig, '--role-model', `author=p/m:${'t'.repeat(129)}`],
    // step next flag combinations
    ['step', 'next', '--run-root', '/runs'],
    ['step', 'next', '--run-id', 'step-1'],
    ['step', 'next', ...runTarget, '--taskpack', 'tp.yaml'],
    ['step', 'next', ...runTarget, '--taskpack', 'tp.yaml', '--repo', '/repo', '--config', '/cfg.yaml'],
    ['step', 'next', ...runTarget, '--taskpack', 'tp.yaml', '--repo', '/repo', '--registry', '/reg.yaml'],
    ['step', 'next', ...runTarget, '--taskpack', 'tp.yaml', '--repo', '/repo', '--registry-sha256', 'a'.repeat(64)],
    ['step', 'next', ...runTarget, '--config', '/cfg.yaml', '--repo', '/repo'],
    ['step', 'next', ...runTarget, '--config', '/cfg.yaml', '--registry', '/reg.yaml', '--repo', '/repo'],
    ['step', 'next', ...runTarget, ...commonConfig],
    ['step', 'next', ...runTarget, '--mode', 'invalid'],
    ['step', 'next', ...runTarget, '--lease', 'tok'],
    ['step', 'next', ...runTarget, '--status', 'completed'],
    // step submit flag validation
    ['step', 'submit', ...runTarget],
    ['step', 'submit', ...runTarget, '--lease', '   '],
    ['step', 'submit', ...runTarget, '--lease', 'tok', '--status', 'invalid'],
    ['step', 'submit', ...runTarget, '--lease', 'tok', '--reason'],
    ['step', 'submit', ...runTarget, '--lease', 'tok', '--reason', '--json'],
    ['step', 'submit', ...runTarget, '--lease', 'tok', '--taskpack', 'tp.yaml'],
    ['step', 'submit', ...runTarget, '--lease', 'tok', '--reissue-lease'],
    // step cancel flag validation
    ['step', 'cancel', '--run-root', '/runs'],
    ['step', 'cancel', ...runTarget, '--lease', 'tok'],
    ['step', 'cancel', ...runTarget, '--config', '/cfg.yaml'],
  ];

  for (const argv of invalidCases) {
    assert.throws(() => parseArguments(argv), UsageError, `expected UsageError for ${JSON.stringify(argv)}`);
  }
});

test('step-cli: Managed Controller two-role multi-model CLI lifecycle, lease rotation, repair loop, resume/run refusal, and protected-path failure', async () => {
  const f = await createManagedDelegatedRepoFixture({ maxImplementationRepairs: 1, maxAttempts: 4 });
  try {
    const common = ['--config', f.input.configPath, '--registry', f.input.registryPath, '--registry-sha256', f.input.registrySha256];
    const roleModels = [
      '--role-model', 'author=antigravity/gemini-4-carbon:high',
      '--role-model', 'review=antigravity/gemini-4-argon:low',
    ];
    const runId = 'cli-multi-model';
    const target = ['--run-root', f.runRoot, '--run-id', runId];

    // 1. check --role-model reflects overridden role selections in plan
    const checked = runCli(['check', ...common, ...roleModels, '--json']);
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    const planEnv = parseNdjson(checked.stdout)[0]!;
    assert.equal(planEnv.kind, 'plan');
    const planRoles = planEnv.data['roles'] as { roleId: string; policy: { selection: { provider: string; model: string; thinking: string } } }[];
    assert.equal(planRoles.find(r => r.roleId === 'author')?.policy.selection.model, 'gemini-4-carbon');
    assert.equal(planRoles.find(r => r.roleId === 'author')?.policy.selection.thinking, 'high');
    assert.equal(planRoles.find(r => r.roleId === 'review')?.policy.selection.model, 'gemini-4-argon');
    assert.equal(planRoles.find(r => r.roleId === 'review')?.policy.selection.thinking, 'low');

    // 2. unattended run on delegated role fails closed with CAPABILITY_UNSUPPORTED (exit 3)
    const runBlocked = runCli(['run', ...common, '--repo', f.repository, ...target, ...roleModels, '--json']);
    assert.equal(runBlocked.status, 3, runBlocked.stdout + runBlocked.stderr);
    const runDiag = parseNdjson(runBlocked.stdout).at(-1)!;
    assert.equal(runDiag.kind, 'diagnostic');
    assert.equal(runDiag.data['code'], 'CAPABILITY_UNSUPPORTED');

    // 3. step next yields awaiting_role for author (gemini-4-carbon)
    const step1 = runCli(['step', 'next', ...common, '--repo', f.repository, ...target, ...roleModels, '--json']);
    assert.equal(step1.status, 0, step1.stdout + step1.stderr);
    const step1Env = parseNdjson(step1.stdout)[0]!;
    assert.equal(step1Env.kind, 'step');
    assert.equal(step1Env.runId, runId);
    assert.equal(step1Env.data['status'], 'awaiting_role');
    assert.equal(step1Env.data['roleId'], 'author');
    assert.deepEqual(step1Env.data['selection'], { provider: 'antigravity', model: 'gemini-4-carbon', thinking: 'high' });
    const oldLease = step1Env.data['leaseToken'] as string;
    const candidateDir1 = step1Env.data['candidateDir'] as string;

    // 4. resume while parked at awaiting_role fails closed with CAPABILITY_UNSUPPORTED (exit 3)
    const resumed = runCli(['resume', ...common, '--repo', f.repository, ...target, ...roleModels, '--json']);
    assert.equal(resumed.status, 3, resumed.stdout + resumed.stderr);
    assert.equal(parseNdjson(resumed.stdout).at(-1)!.data['code'], 'CAPABILITY_UNSUPPORTED');

    // 5. duplicate step next without --reissue-lease exits 7 (OWNER_BUSY)
    const dupNext = runCli(['step', 'next', ...target, '--json']);
    assert.equal(dupNext.status, 7, dupNext.stdout + dupNext.stderr);
    assert.equal(parseNdjson(dupNext.stdout)[0]!.data['code'], 'OWNER_BUSY');

    // 6. step next --reissue-lease rotates leaseToken (exit 0); old lease fails with exit 7 (AUTHORITY_REFUSED)
    const reissued = runCli(['step', 'next', ...target, '--reissue-lease', '--json']);
    assert.equal(reissued.status, 0, reissued.stdout + reissued.stderr);
    const reissuedEnv = parseNdjson(reissued.stdout)[0]!;
    assert.equal(reissuedEnv.kind, 'step');
    const newLease = reissuedEnv.data['leaseToken'] as string;
    assert.notEqual(newLease, oldLease);

    const staleSubmit = runCli(['step', 'submit', ...target, '--lease', oldLease, '--json']);
    assert.equal(staleSubmit.status, 7, staleSubmit.stdout + staleSubmit.stderr);
    assert.equal(parseNdjson(staleSubmit.stdout)[0]!.data['code'], 'AUTHORITY_REFUSED');

    // 7. author leaves { ok: false, attempt: 1 } -> submit -> review (gemini-4-argon, read-only)
    await writeFile(join(candidateDir1, 'packages', 'result.json'), JSON.stringify({ ok: false, attempt: 1 }), { mode: 0o600 });
    const step2 = runCli(['step', 'submit', ...target, '--lease', newLease, '--json']);
    assert.equal(step2.status, 0, step2.stdout + step2.stderr);
    const step2Env = parseNdjson(step2.stdout)[0]!;
    assert.equal(step2Env.kind, 'step');
    assert.equal(step2Env.data['roleId'], 'review');
    assert.equal(step2Env.data['purpose'], 'reviewer');
    assert.deepEqual(step2Env.data['selection'], { provider: 'antigravity', model: 'gemini-4-argon', thinking: 'low' });
    assert.deepEqual(step2Env.data['allowedTools'], ['read']);

    // 8. review approves -> json-artifact check fails -> bounded implementation repair yields author
    const step3 = runCli(['step', 'submit', ...target, '--lease', step2Env.data['leaseToken'] as string, '--json']);
    assert.equal(step3.status, 0, step3.stdout + step3.stderr);
    const step3Env = parseNdjson(step3.stdout)[0]!;
    assert.equal(step3Env.kind, 'step');
    assert.equal(step3Env.data['roleId'], 'author');
    assert.equal(step3Env.data['repair'], 'implementation');
    assert.deepEqual(step3Env.data['selection'], { provider: 'antigravity', model: 'gemini-4-carbon', thinking: 'high' });

    // 9. author fixes packages/result.json -> yields review -> review approves -> settles completed (exit 0)
    await writeFile(join(step3Env.data['candidateDir'] as string, 'packages', 'result.json'), JSON.stringify({ ok: true }), { mode: 0o600 });
    const step4 = runCli(['step', 'submit', ...target, '--lease', step3Env.data['leaseToken'] as string, '--json']);
    assert.equal(step4.status, 0, step4.stdout + step4.stderr);
    const step4Env = parseNdjson(step4.stdout)[0]!;
    assert.equal(step4Env.kind, 'step');
    assert.equal(step4Env.data['roleId'], 'review');

    const summaryPath = join(f.root, 'managed-summary.md');
    const settled = runCli([
      'step', 'submit', ...target, '--lease', step4Env.data['leaseToken'] as string,
      '--output-format', 'json,github-step-summary', '--step-summary-file', summaryPath, '--json',
    ]);
    assert.equal(settled.status, 0, settled.stdout + settled.stderr);
    const settledEnv = parseNdjson(settled.stdout)[0]!;
    assert.equal(settledEnv.kind, 'result');
    assert.equal((settledEnv.data['result'] as { spec: { status: string } }).spec.status, 'completed');

    const summaryText = await readFile(summaryPath, 'utf8');
    assert.match(summaryText, /\| Run ID \| cli-multi-model \|/);
    assert.match(summaryText, /\| Status \| completed \|/);

    // Verify target --repo checkout remains untouched
    const repoResult = JSON.parse(await readFile(join(f.repository, 'packages', 'result.json'), 'utf8')) as { ok: boolean };
    assert.equal(repoResult.ok, false);
  } finally {
    await f.cleanup();
  }

  // Protected-path scope.v1 violation settles failed (exit 4) without touching --repo
  const fScope = await createManagedDelegatedRepoFixture({ maxImplementationRepairs: 1, maxAttempts: 2 });
  try {
    const common = ['--config', fScope.input.configPath, '--registry', fScope.input.registryPath, '--registry-sha256', fScope.input.registrySha256];
    const target = ['--run-root', fScope.runRoot, '--run-id', 'cli-scope-fail'];
    const step1 = runCli(['step', 'next', ...common, '--repo', fScope.repository, ...target, '--json']);
    assert.equal(step1.status, 0, step1.stdout + step1.stderr);
    const step1Env = parseNdjson(step1.stdout)[0]!;
    const candDir = step1Env.data['candidateDir'] as string;
    await chmod(join(candDir, 'docs', 'readme.md'), 0o600);
    await writeFile(join(candDir, 'docs', 'readme.md'), '# Tampered\n', { mode: 0o600 });
    await writeFile(join(candDir, 'packages', 'result.json'), JSON.stringify({ ok: true }), { mode: 0o600 });

    const submitAuthor = runCli(['step', 'submit', ...target, '--lease', step1Env.data['leaseToken'] as string, '--json']);
    assert.equal(submitAuthor.status, 0, submitAuthor.stdout + submitAuthor.stderr);
    const reviewEnv = parseNdjson(submitAuthor.stdout)[0]!;
    const submitReview = runCli(['step', 'submit', ...target, '--lease', reviewEnv.data['leaseToken'] as string, '--json']);
    assert.equal(submitReview.status, 4, submitReview.stdout + submitReview.stderr);
    const failEnv = parseNdjson(submitReview.stdout)[0]!;
    assert.equal(failEnv.kind, 'result');
    assert.equal((failEnv.data['result'] as { spec: { status: string } }).spec.status, 'failed');
    assert.equal(await readFile(join(fScope.repository, 'docs', 'readme.md'), 'utf8'), '# Protected Doc\n');
  } finally {
    await fScope.cleanup();
  }
});

test('step-cli: zero-secret --taskpack turnkey CLI step lifecycle with ephemeral command.v1 gate across separate subprocesses', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lw-step-taskpack-cli-')));
  const repoRoot = join(root, 'repo');
  const runRoot = join(root, 'runs');
  try {
    await mkdir(join(repoRoot, '.loopwright', 'checks'), { recursive: true, mode: 0o700 });
    await mkdir(join(repoRoot, 'docs'), { recursive: true, mode: 0o700 });
    await writeFile(join(repoRoot, 'docs', 'proposal.json'), JSON.stringify({ schema_version: 1, candidates: [] }), { mode: 0o600 });
    await writeFile(join(repoRoot, 'docs', 'upstream-versions.json'), JSON.stringify({ version: '1.0.0' }), { mode: 0o600 });
    await writeFile(
      join(repoRoot, '.loopwright', 'checks', 'verify.sh'),
      '#!/bin/sh\ngrep -q \'"ready"\' docs/proposal.json\n',
      { mode: 0o755 },
    );

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
          writable: ['docs'],
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
          localChecks: [
            { id: 'docs-proposal-json', implementation: 'json-artifact.v1' },
            {
              id: 'cmd-check',
              implementation: 'command.v1',
              parameters: { script: '.loopwright/checks/verify.sh', timeoutSeconds: 10 },
            },
          ],
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

    // 1. step next --taskpack stages .taskpack-tp-1 and applies --role-model without provider env vars
    const nextRes = runCli([
      'step', 'next',
      '--taskpack', '.loopwright/taskpack.yaml',
      '--repo', repoRoot,
      '--run-root', runRoot,
      '--run-id', 'tp-1',
      '--role-model', 'author=antigravity/gemini-4-carbon:medium',
      '--json',
    ]);
    assert.equal(nextRes.status, 0, nextRes.stdout + nextRes.stderr);
    const nextEnv = parseNdjson(nextRes.stdout)[0]!;
    assert.equal(nextEnv.kind, 'step');
    assert.equal(nextEnv.data['status'], 'awaiting_role');
    assert.deepEqual(nextEnv.data['selection'], { provider: 'antigravity', model: 'gemini-4-carbon', thinking: 'medium' });

    const stageDir = join(runRoot, '.taskpack-tp-1');
    assert.equal((await lstat(stageDir)).isDirectory(), true);

    // 2. Re-invoking step next --taskpack --reissue-lease reuses .taskpack-tp-1 and rotates lease
    const reissuedNext = runCli([
      'step', '--action', 'next',
      '--taskpack', '.loopwright/taskpack.yaml',
      '--repo', repoRoot,
      '--run-root', runRoot,
      '--run-id', 'tp-1',
      '--role-model', 'author=antigravity/gemini-4-carbon:medium',
      '--reissue-lease',
      '--json',
    ]);
    assert.equal(reissuedNext.status, 0, reissuedNext.stdout + reissuedNext.stderr);
    const reissuedEnv = parseNdjson(reissuedNext.stdout)[0]!;
    assert.equal(reissuedEnv.kind, 'step');
    const activeLease = reissuedEnv.data['leaseToken'] as string;
    assert.notEqual(activeLease, nextEnv.data['leaseToken']);

    // 3. Edit candidate docs/proposal.json so both json-artifact.v1 and command.v1 pass
    const candDir = nextEnv.data['candidateDir'] as string;
    await writeFile(join(candDir, 'docs', 'proposal.json'), JSON.stringify({ schema_version: 1, candidates: ['ready'] }), { mode: 0o600 });

    // 4. step submit with --submission-file and --output-format text (no --json, configuration omitted) starts ephemeral command.v1 gate, runs verify.sh, closes cleanly, and settles completed
    const submissionFile = join(root, 'submission.json');
    await writeFile(
      submissionFile,
      JSON.stringify({
        version: 1,
        status: 'completed',
        checks: [
          { checkId: 'docs-proposal-json', status: 'passed', evidenceId: null, reason: null },
          { checkId: 'cmd-check', status: 'passed', evidenceId: null, reason: null },
        ],
        reason: null,
      }),
      { mode: 0o600 },
    );
    const summaryFile = join(root, 'tp-summary.md');
    const submitRes = runCli([
      'step', 'submit',
      '--run-root', runRoot,
      '--run-id', 'tp-1',
      '--lease', activeLease,
      '--submission-file', submissionFile,
      '--output-format', 'text',
      '--step-summary-file', summaryFile,
    ]);
    assert.equal(submitRes.status, 0, submitRes.stdout + submitRes.stderr);
    assert.match(submitRes.stdout, /^Run ID: tp-1$/m);
    assert.match(submitRes.stdout, /^Status: completed\b/m);
    const summaryMd = await readFile(summaryFile, 'utf8');
    assert.match(summaryMd, /\| Run ID \| tp-1 \|/);
    assert.match(summaryMd, /\| Status \| completed \|/);

    // .taskpack-tp-1 must remain on disk so inspect/status still work after settlement
    assert.equal((await lstat(stageDir)).isDirectory(), true);
    const inspected = runCli(['inspect', '--run-root', runRoot, '--run-id', 'tp-1', '--json']);
    assert.equal(inspected.status, 0, inspected.stdout + inspected.stderr);

    // Invalid taskpack path escapes repo -> GitHubAppError TASKPACK_MANIFEST_INVALID -> exit 2
    const badTp = runCli([
      'step', 'next',
      '--taskpack', '../outside.yaml',
      '--repo', repoRoot,
      '--run-root', runRoot,
      '--run-id', 'tp-bad',
      '--json',
    ]);
    assert.equal(badTp.status, 2, badTp.stdout + badTp.stderr);
    assert.equal(parseNdjson(badTp.stdout)[0]!.data['code'], 'TASKPACK_MANIFEST_INVALID');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('step-cli: --mode no-change, step cancel exit 130, human output, and help text', async () => {
  const f = await createManagedDelegatedRepoFixture({ noChangeCheck: true });
  try {
    const common = ['--config', f.input.configPath, '--registry', f.input.registryPath, '--registry-sha256', f.input.registrySha256];

    // 1. --mode no-change settles status: 'no_change' (exit 0)
    const ncNext = runCli(['step', 'next', ...common, '--repo', f.repository, '--run-root', f.runRoot, '--run-id', 'nc-1', '--mode', 'no-change', '--json']);
    assert.equal(ncNext.status, 0, ncNext.stdout + ncNext.stderr);
    const ncNextEnv = parseNdjson(ncNext.stdout)[0]!;
    assert.equal(ncNextEnv.kind, 'step');

    const ncSubmit = runCli(['step', 'submit', '--run-root', f.runRoot, '--run-id', 'nc-1', '--lease', ncNextEnv.data['leaseToken'] as string, '--json']);
    assert.equal(ncSubmit.status, 0, ncSubmit.stdout + ncSubmit.stderr);
    const ncResultEnv = parseNdjson(ncSubmit.stdout)[0]!;
    assert.equal(ncResultEnv.kind, 'result');
    assert.equal((ncResultEnv.data['result'] as { spec: { status: string } }).spec.status, 'no_change');

    // 2. step cancel cleans up workspace, settles cancelled, and exits 130 (also test human-mode output on step next)
    const humanNext = runCli(['step', 'next', ...common, '--repo', f.repository, '--run-root', f.runRoot, '--run-id', 'cancel-1']);
    assert.equal(humanNext.status, 0, humanNext.stdout + humanNext.stderr);
    assert.match(humanNext.stdout, /awaiting_role: author/);

    const cancelled = runCli(['step', 'cancel', '--run-root', f.runRoot, '--run-id', 'cancel-1', '--json']);
    assert.equal(cancelled.status, 130, cancelled.stdout + cancelled.stderr);
    const cancelEnv = parseNdjson(cancelled.stdout)[0]!;
    assert.equal(cancelEnv.kind, 'result');
    assert.equal((cancelEnv.data['result'] as { spec: { status: string } }).spec.status, 'cancelled');
    assert.equal(await lstat(join(f.runRoot, 'workspaces', 'cancel-1')).then(() => true, () => false), false);

    // 3. --help documents step next/submit/cancel and --role-model
    const helpRes = runCli(['--help']);
    assert.equal(helpRes.status, 0);
    assert.match(helpRes.stdout, /--role-model/);
    assert.match(helpRes.stdout, /step next/);
    assert.match(helpRes.stdout, /step submit/);
    assert.match(helpRes.stdout, /step cancel/);

    // 4. Direct in-process cliMain call for GitHubAppError exit mapping (ACTION_INPUT_INVALID -> 2) with zero mutation
    await chmod(f.repository, 0o755);
    const insideRepoRoot = join(f.repository, 'inside-repo');
    const badExit = await cliMain(['step', 'next', '--taskpack', 'missing.yaml', '--repo', f.repository, '--run-root', insideRepoRoot, '--run-id', 'bad-root', '--json']);
    assert.equal(badExit, 2);
    await assert.rejects(() => lstat(insideRepoRoot), { code: 'ENOENT' });
    assert.equal(gitStatusPorcelain(f.repository), '');

    const equalRootExit = await cliMain(['step', 'next', '--taskpack', 'missing.yaml', '--repo', f.repository, '--run-root', f.repository, '--run-id', 'equal-root', '--json']);
    assert.equal(equalRootExit, 2);
    assert.equal((await lstat(f.repository)).mode & 0o777, 0o755);
    assert.equal(gitStatusPorcelain(f.repository), '');

    const symlinkToRepo = join(f.root, 'symlink-to-repo');
    await symlink(f.repository, symlinkToRepo);
    const symlinkRootExit = await cliMain(['step', 'next', '--taskpack', 'missing.yaml', '--repo', f.repository, '--run-root', symlinkToRepo, '--run-id', 'symlink-root', '--json']);
    assert.equal(symlinkRootExit, 2);
    assert.equal((await lstat(f.repository)).mode & 0o777, 0o755);
    assert.equal(gitStatusPorcelain(f.repository), '');
  } finally {
    await f.cleanup();
  }
});

async function createTaskpackRepo(
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

test('step-cli: gitHubAppExitCode maps all 33 GitHubAppErrorCode values and live CLI scrubs GitHubAppError diagnostics', async () => {
  const expectedExitCodes: Record<GitHubAppErrorCode, number> = {
    TASKPACK_MANIFEST_INVALID: 2,
    TASKPACK_UNTRUSTED_INTERPOLATION: 2,
    TASKPACK_SCOPE_VIOLATION: 2,
    TASKPACK_HOST_BINDING_INVALID: 2,
    SANDBOX_POLICY_INVALID: 2,
    GITHUB_APP_CONFIG_INVALID: 2,
    TOKEN_BROKER_CONFIG_INVALID: 2,
    ACTION_INPUT_INVALID: 2,
    TENANT_IDENTITY_INVALID: 2,
    WEBHOOK_GUIDANCE_INVALID: 2,
    WEBHOOK_DELIVERY_INVALID: 2,
    PROVIDER_OAUTH_UNSUPPORTED: 3,
    SANDBOX_BACKEND_UNAVAILABLE: 3,
    SANDBOX_CAPABILITY_INSUFFICIENT: 3,
    MCP_OAUTH_UNSUPPORTED: 3,
    MCP_AUTHENTICATION_REQUIRED: 3,
    HOST_PROFILE_UNQUALIFIED: 3,
    WEBHOOK_ACTOR_UNAUTHORIZED: 3,
    WEBHOOK_SIGNATURE_INVALID: 3,
    TENANT_BOUNDARY_VIOLATION: 3,
    TENANT_INSTALLATION_REVOKED: 3,
    TOKEN_SCOPE_VIOLATION: 3,
    SANDBOX_EXECUTION_FAILED: 4,
    QUEUE_CAPACITY_EXCEEDED: 5,
    TOKEN_TTL_EXCEEDED: 6,
    HOST_CLOCK_UNTRUSTED: 7,
    QUEUE_LEASE_FENCED: 7,
    WEBHOOK_DELIVERY_CONFLICT: 7,
    STORAGE_PROFILE_INSUFFICIENT: 8,
    TOKEN_SECRET_LEAK_DETECTED: 8,
    SERVICE_FAULT: 8,
    QUEUE_STATE_INVALID: 8,
    WEBHOOK_PAYLOAD_TOO_LARGE: 8,
  };
  assert.deepEqual(Object.keys(expectedExitCodes).sort(), [...GITHUB_APP_ERROR_CODES].sort());
  for (const code of GITHUB_APP_ERROR_CODES) {
    assert.equal(gitHubAppExitCode(code), expectedExitCodes[code], `unexpected exit code for ${code}`);
  }

  const root = await realpath(await mkdtemp(join(tmpdir(), 'lw-step-gha-exit-')));
  const repoRoot = join(root, 'repo');
  const runRoot = join(root, 'runs');
  try {
    // 1. TASKPACK_SCOPE_VIOLATION -> exit 2
    await createTaskpackRepo(repoRoot, { writable: ['.github/workflows'], withCommandCheck: false });
    const scopeRes = runCli([
      'step', 'next',
      '--taskpack', '.loopwright/taskpack.yaml',
      '--repo', repoRoot,
      '--run-root', runRoot,
      '--run-id', 'scope-bad',
      '--json',
    ]);
    assert.equal(scopeRes.status, 2, scopeRes.stdout + scopeRes.stderr);
    assert.equal(parseNdjson(scopeRes.stdout)[0]!.data['code'], 'TASKPACK_SCOPE_VIOLATION');

    // 2. TASKPACK_UNTRUSTED_INTERPOLATION -> exit 2
    await writeFile(join(repoRoot, '.loopwright', 'taskpack.yaml'), 'apiVersion: loopwright.dev/v1alpha1\nkind: Taskpack\nmetadata:\n  name: ${SECRET}\n', { mode: 0o600 });
    const interpRes = runCli([
      'step', 'next',
      '--taskpack', '.loopwright/taskpack.yaml',
      '--repo', repoRoot,
      '--run-root', runRoot,
      '--run-id', 'interp-bad',
      '--json',
    ]);
    assert.equal(interpRes.status, 2, interpRes.stdout + interpRes.stderr);
    assert.equal(parseNdjson(interpRes.stdout)[0]!.data['code'], 'TASKPACK_UNTRUSTED_INTERPOLATION');

    // 3. SecretScrubber scrubs GitHubAppError diagnostic message when GITHUB_SHA leaks GITHUB_TOKEN
    const cleanRepo = join(root, 'clean-repo');
    await createTaskpackRepo(cleanRepo, { withCommandCheck: false });
    const leakedToken = 'ghp_secret_scrub_test_123456';
    const scrubRes = runCli(
      [
        'step', 'next',
        '--taskpack', '.loopwright/taskpack.yaml',
        '--repo', cleanRepo,
        '--run-root', runRoot,
        '--run-id', 'scrub-1',
        '--json',
      ],
      {
        ...CLEAN_ENV,
        GITHUB_TOKEN: leakedToken,
        GITHUB_SHA: leakedToken,
      },
    );
    assert.equal(scrubRes.status, 2, scrubRes.stdout + scrubRes.stderr);
    assert.equal(scrubRes.stdout.includes(leakedToken), false);
    const scrubEnv = parseNdjson(scrubRes.stdout)[0]!;
    assert.equal(scrubEnv.kind, 'diagnostic');
    assert.equal(scrubEnv.data['code'], 'ACTION_INPUT_INVALID');
    assert.match(String(scrubEnv.data['message']), /\[scrubbed\]/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('step-cli: step next --taskpack preserves --repo mismatch fencing (exit 7) and cleans orphaned pre-admission .taskpack-<runId>', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lw-step-repo-orphan-')));
  const repoA = join(root, 'repo-a');
  const repoB = join(root, 'repo-b');
  const repoALink = join(root, 'repo-a-link');
  const runRoot = join(root, 'runs');
  try {
    await createTaskpackRepo(repoA, { withCommandCheck: false });
    await createTaskpackRepo(repoB, { withCommandCheck: false });
    await symlink(repoA, repoALink);

    // 1. Admit run using symlinked repoALink -> succeeds (0)
    const admitted = runCli([
      'step', 'next',
      '--taskpack', '.loopwright/taskpack.yaml',
      '--repo', repoALink,
      '--run-root', runRoot,
      '--run-id', 'repo-mismatch',
      '--json',
    ]);
    assert.equal(admitted.status, 0, admitted.stdout + admitted.stderr);

    // 2. Re-invoke via canonical repoA -> matches staged.repositoryRoot and succeeds (0)
    const sameRepo = runCli([
      'step', 'next',
      '--taskpack', '.loopwright/taskpack.yaml',
      '--repo', repoA,
      '--run-root', runRoot,
      '--run-id', 'repo-mismatch',
      '--reissue-lease',
      '--json',
    ]);
    assert.equal(sameRepo.status, 0, sameRepo.stdout + sameRepo.stderr);

    // 3. Re-invoke with DIFFERENT --repo (repoB) via --taskpack -> RECOVERY_REQUIRED (exit 7)
    const mismatchTaskpack = runCli([
      'step', 'next',
      '--taskpack', '.loopwright/taskpack.yaml',
      '--repo', repoB,
      '--run-root', runRoot,
      '--run-id', 'repo-mismatch',
      '--reissue-lease',
      '--json',
    ]);
    assert.equal(mismatchTaskpack.status, 7, mismatchTaskpack.stdout + mismatchTaskpack.stderr);
    assert.equal(parseNdjson(mismatchTaskpack.stdout)[0]!.data['code'], 'RECOVERY_REQUIRED');

    // 4. Re-invoke with DIFFERENT --repo (repoB) via bare step next -> RECOVERY_REQUIRED (exit 7)
    const mismatchBare = runCli([
      'step', 'next',
      '--repo', repoB,
      '--run-root', runRoot,
      '--run-id', 'repo-mismatch',
      '--reissue-lease',
      '--json',
    ]);
    assert.equal(mismatchBare.status, 7, mismatchBare.stdout + mismatchBare.stderr);
    assert.equal(parseNdjson(mismatchBare.stdout)[0]!.data['code'], 'RECOVERY_REQUIRED');
    // Admitted .taskpack-repo-mismatch stays intact
    assert.equal((await lstat(join(runRoot, '.taskpack-repo-mismatch'))).isDirectory(), true);

    // 5. Pre-admission failure (--role-model nonexistent=...) cleans up .taskpack-orphan-1 so retry with --mode no-change succeeds
    const orphanFail = runCli([
      'step', 'next',
      '--taskpack', '.loopwright/taskpack.yaml',
      '--repo', repoA,
      '--run-root', runRoot,
      '--run-id', 'orphan-1',
      '--role-model', 'nonexistent=antigravity/gemini-4-carbon',
      '--json',
    ]);
    assert.equal(orphanFail.status, 2, orphanFail.stdout + orphanFail.stderr);
    assert.equal(parseNdjson(orphanFail.stdout)[0]!.data['code'], 'CONFIG_REFERENCE');
    assert.equal(await lstat(join(runRoot, 'orphan-1')).then(() => true, () => false), false);
    assert.equal(await lstat(join(runRoot, '.taskpack-orphan-1')).then(() => true, () => false), false);

    // Also verify a pre-existing stale un-admitted .taskpack-<runId> without <runRoot>/<runId> is cleared before staging
    await mkdir(join(runRoot, '.taskpack-orphan-1'), { recursive: true, mode: 0o700 });
    await writeFile(join(runRoot, '.taskpack-orphan-1', 'stale.txt'), 'stale', { mode: 0o600 });

    const retryNoChange = runCli([
      'step', 'next',
      '--taskpack', '.loopwright/taskpack.yaml',
      '--repo', repoA,
      '--run-root', runRoot,
      '--run-id', 'orphan-1',
      '--mode', 'no-change',
      '--json',
    ]);
    assert.equal(retryNoChange.status, 0, retryNoChange.stdout + retryNoChange.stderr);
    const retryEnv = parseNdjson(retryNoChange.stdout)[0]!;
    assert.equal(retryEnv.kind, 'step');

    const submitNoChange = runCli([
      'step', 'submit',
      '--run-root', runRoot,
      '--run-id', 'orphan-1',
      '--lease', retryEnv.data['leaseToken'] as string,
      '--json',
    ]);
    assert.equal(submitNoChange.status, 0, submitNoChange.stdout + submitNoChange.stderr);
    assert.equal((parseNdjson(submitNoChange.stdout)[0]!.data['result'] as { spec: { status: string } }).spec.status, 'no_change');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('step-cli: step command covers exit codes 2, 3, 4, 5, 6, 7, 8, and 143 plus --status/--reason/--repo branches', async () => {
  // 1. Exit 2 (--config unknown --role-model), Exit 3 (--mode no-change ineligible), Exit 8 (cancel missing & candidate symlink), Exit 7 (bare --repo mismatch), Exit 4 (--status failed --reason)
  const f1 = await createManagedDelegatedRepoFixture({ noChangeCheck: false, maxAttempts: 4, maxImplementationRepairs: 0 });
  try {
    const common = ['--config', f1.input.configPath, '--registry', f1.input.registryPath, '--registry-sha256', f1.input.registrySha256];

    const badRole = runCli(['step', 'next', ...common, '--repo', f1.repository, '--run-root', f1.runRoot, '--run-id', 'bad-role', '--role-model', 'nonexistent=antigravity/gemini-4-carbon', '--json']);
    assert.equal(badRole.status, 2, badRole.stdout + badRole.stderr);
    assert.equal(parseNdjson(badRole.stdout)[0]!.data['code'], 'CONFIG_REFERENCE');

    const ineligibleNc = runCli(['step', 'next', ...common, '--repo', f1.repository, '--run-root', f1.runRoot, '--run-id', 'ineligible-nc', '--mode', 'no-change', '--json']);
    assert.equal(ineligibleNc.status, 3, ineligibleNc.stdout + ineligibleNc.stderr);
    assert.equal(parseNdjson(ineligibleNc.stdout)[0]!.data['code'], 'CAPABILITY_UNSUPPORTED');

    const cancelMissing = runCli(['step', 'cancel', '--run-root', f1.runRoot, '--run-id', 'missing-cancel', '--json']);
    assert.equal(cancelMissing.status, 8, cancelMissing.stdout + cancelMissing.stderr);
    assert.equal(parseNdjson(cancelMissing.stdout)[0]!.data['code'], 'STATE_UNAVAILABLE');

    // Start a run, test bare step next --repo mismatch -> 7, then symlink in candidateDir -> 8
    const startRun = runCli(['step', 'next', ...common, '--repo', f1.repository, '--run-root', f1.runRoot, '--run-id', 'artifact-sym', '--json']);
    assert.equal(startRun.status, 0, startRun.stdout + startRun.stderr);
    const startEnv = parseNdjson(startRun.stdout)[0]!;
    const otherRepo = join(f1.root, 'other-repo');
    await mkdir(otherRepo, { recursive: true, mode: 0o700 });
    const bareRepoMismatch = runCli(['step', 'next', '--run-root', f1.runRoot, '--run-id', 'artifact-sym', '--repo', otherRepo, '--reissue-lease', '--json']);
    assert.equal(bareRepoMismatch.status, 7, bareRepoMismatch.stdout + bareRepoMismatch.stderr);
    assert.equal(parseNdjson(bareRepoMismatch.stdout)[0]!.data['code'], 'RECOVERY_REQUIRED');

    await symlink('/etc/hosts', join(startEnv.data['candidateDir'] as string, 'packages', 'evil-symlink'));
    const symSubmit = runCli(['step', 'submit', '--run-root', f1.runRoot, '--run-id', 'artifact-sym', '--lease', startEnv.data['leaseToken'] as string, '--json']);
    assert.equal(symSubmit.status, 8, symSubmit.stdout + symSubmit.stderr);
    assert.equal(parseNdjson(symSubmit.stdout)[0]!.data['code'], 'ARTIFACT_INVALID');

    // --status failed --reason on step submit -> advances through review and settles failed (exit 4)
    const failStart = runCli(['step', 'next', ...common, '--repo', f1.repository, '--run-root', f1.runRoot, '--run-id', 'explicit-fail', '--json']);
    assert.equal(failStart.status, 0, failStart.stdout + failStart.stderr);
    const failLease = parseNdjson(failStart.stdout)[0]!.data['leaseToken'] as string;
    const authorFail = runCli(['step', 'submit', '--run-root', f1.runRoot, '--run-id', 'explicit-fail', '--lease', failLease, '--status', 'failed', '--reason', 'delegated_error', '--json']);
    assert.equal(authorFail.status, 0, authorFail.stdout + authorFail.stderr);
    const reviewFailLease = parseNdjson(authorFail.stdout)[0]!.data['leaseToken'] as string;
    const explicitFail = runCli(['step', 'submit', '--run-root', f1.runRoot, '--run-id', 'explicit-fail', '--lease', reviewFailLease, '--status', 'failed', '--reason', 'delegated_error', '--json']);
    assert.equal(explicitFail.status, 4, explicitFail.stdout + explicitFail.stderr);
    assert.equal((parseNdjson(explicitFail.stdout)[0]!.data['result'] as { spec: { status: string } }).spec.status, 'failed');
  } finally {
    await f1.cleanup();
  }

  // 2. Exit 5 (exhausted / ATTEMPT_LIMIT) when maxAttempts: 1
  const fExhausted = await createManagedDelegatedRepoFixture({ maxAttempts: 1, maxImplementationRepairs: 0 });
  try {
    const common = ['--config', fExhausted.input.configPath, '--registry', fExhausted.input.registryPath, '--registry-sha256', fExhausted.input.registrySha256];
    const s1 = runCli(['step', 'next', ...common, '--repo', fExhausted.repository, '--run-root', fExhausted.runRoot, '--run-id', 'exhaust-1', '--json']);
    assert.equal(s1.status, 0, s1.stdout + s1.stderr);
    const lease = parseNdjson(s1.stdout)[0]!.data['leaseToken'] as string;
    const s2 = runCli(['step', 'submit', '--run-root', fExhausted.runRoot, '--run-id', 'exhaust-1', '--lease', lease, '--json']);
    assert.equal(s2.status, 5, s2.stdout + s2.stderr);
    assert.equal((parseNdjson(s2.stdout)[0]!.data['result'] as { spec: { status: string } }).spec.status, 'exhausted');
  } finally {
    await fExhausted.cleanup();
  }

  // 3. Exit 6 (expired) with tight wallTimeMs (drainReserveMs: 120000, wallTimeMs: 123500)
  const fExpired = await createManagedDelegatedRepoFixture({ drainReserveMs: 120_000, wallTimeMs: 123_500 });
  try {
    const common = ['--config', fExpired.input.configPath, '--registry', fExpired.input.registryPath, '--registry-sha256', fExpired.input.registrySha256];
    const s1 = runCli(['step', 'next', ...common, '--repo', fExpired.repository, '--run-root', fExpired.runRoot, '--run-id', 'expire-1', '--json']);
    assert.equal(s1.status, 0, s1.stdout + s1.stderr);
    const lease = parseNdjson(s1.stdout)[0]!.data['leaseToken'] as string;
    await new Promise(resolveWait => setTimeout(resolveWait, 3_650));
    const s2 = runCli(['step', 'submit', '--run-root', fExpired.runRoot, '--run-id', 'expire-1', '--lease', lease, '--json']);
    assert.equal(s2.status, 6, s2.stdout + s2.stderr);
    assert.equal((parseNdjson(s2.stdout)[0]!.data['result'] as { spec: { status: string } }).spec.status, 'expired');
  } finally {
    await fExpired.cleanup();
  }

  // 4. Exit 143 (SIGTERM) during step submit command.v1 gate
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lw-step-sigterm-')));
  const repoRoot = join(root, 'repo');
  const runRoot = join(root, 'runs');
  try {
    await createTaskpackRepo(repoRoot, { verifyScript: '#!/bin/sh\nsleep 5\n' });
    const nextRes = runCli([
      'step', 'next',
      '--taskpack', '.loopwright/taskpack.yaml',
      '--repo', repoRoot,
      '--run-root', runRoot,
      '--run-id', 'sigterm-1',
      '--json',
    ]);
    assert.equal(nextRes.status, 0, nextRes.stdout + nextRes.stderr);
    const nextEnv = parseNdjson(nextRes.stdout)[0]!;
    await writeFile(join(nextEnv.data['candidateDir'] as string, 'docs', 'proposal.json'), JSON.stringify({ schema_version: 1, candidates: ['ready'] }), { mode: 0o600 });

    const child = spawn(
      process.execPath,
      [MAIN_PATH, 'step', 'submit', '--run-root', runRoot, '--run-id', 'sigterm-1', '--lease', nextEnv.data['leaseToken'] as string, '--json'],
      { env: CLEAN_ENV, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let errOut = '';
    child.stdout.on('data', chunk => { out += String(chunk); });
    child.stderr.on('data', chunk => { errOut += String(chunk); });
    const exitPromise = new Promise<number | null>(resolveExit => {
      child.once('exit', code => resolveExit(code));
    });

    // stepSubmit unlinks step-lease.json immediately before starting runStepTickWithCycle (command.v1 gate).
    const leaseFile = join(runRoot, 'sigterm-1', 'step-lease.json');
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const exists = await lstat(leaseFile).then(() => true, () => false);
      if (!exists) break;
      await new Promise(resolvePoll => setTimeout(resolvePoll, 20));
    }
    child.kill('SIGTERM');
    const code = await exitPromise;
    assert.equal(code, 143, out + errOut);
    const sigEnv = parseNdjson(out)[0]!;
    assert.equal(sigEnv.kind, 'result');
    assert.equal((sigEnv.data['result'] as { spec: { status: string } }).spec.status, 'cancelled');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('step-cli: in-process cliMain exercises runStepCommand branches cleanly', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lw-step-inproc-')));
  const repoA = join(root, 'repo-a');
  const repoB = join(root, 'repo-b');
  const runRoot = join(root, 'runs');
  const f = await createManagedDelegatedRepoFixture({ noChangeCheck: true });

  const runInProc = async (argv: readonly string[]): Promise<{ readonly code: number; readonly out: string }> => {
    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    const origErrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      const done = typeof encoding === 'function' ? encoding : cb;
      if (done) done(null);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void) => {
      const done = typeof encoding === 'function' ? encoding : cb;
      if (done) done(null);
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await cliMain(argv);
      return { code, out: chunks.join('') };
    } finally {
      process.stdout.write = origWrite;
      process.stderr.write = origErrWrite;
    }
  };

  try {
    await createTaskpackRepo(repoA, { withCommandCheck: false });
    await createTaskpackRepo(repoB, { withCommandCheck: false });

    // 1. --taskpack GitHubAppError with non-null path + SecretScrubber branch + ambient GitHub Actions env isolation
    const prevToken = process.env['GITHUB_TOKEN'];
    const prevSigning = process.env['LOOPWRIGHT_LOCAL_COMMAND_SIGNING_SECRET'];
    const prevGhSha = process.env['GITHUB_SHA'];
    const prevGhWorkspace = process.env['GITHUB_WORKSPACE'];
    process.env['GITHUB_TOKEN'] = 'ghp_inproc_scrub_token_123456';
    process.env['LOOPWRIGHT_LOCAL_COMMAND_SIGNING_SECRET'] = 'existing-secret';
    process.env['GITHUB_SHA'] = 'f'.repeat(40);
    process.env['GITHUB_WORKSPACE'] = join(root, 'outer-actions-workspace');
    try {
      const badTp = await runInProc(['step', 'next', '--taskpack', '../escape.yaml', '--repo', repoA, '--run-root', runRoot, '--run-id', 'inproc-bad-tp', '--json']);
      assert.equal(badTp.code, 2);
      assert.equal(parseNdjson(badTp.out)[0]!.data['code'], 'TASKPACK_MANIFEST_INVALID');

      // 2. --taskpack !loaded.ok cleans up .taskpack-inproc-orphan
      const badOverrideTp = await runInProc([
        'step', 'next', '--taskpack', '.loopwright/taskpack.yaml', '--repo', repoA,
        '--run-root', runRoot, '--run-id', 'inproc-orphan', '--role-model', 'nonexistent=antigravity/gemini-4-carbon', '--json',
      ]);
      assert.equal(badOverrideTp.code, 2);
      assert.equal(await lstat(join(runRoot, '.taskpack-inproc-orphan')).then(() => true, () => false), false);

      // 3. --taskpack valid + prevSigning restored -> awaiting_role -> bare step next (--repo) -> --taskpack mismatch -> step submit (--submission-file)
      const tpOk = await runInProc([
        'step', 'next', '--taskpack', '.loopwright/taskpack.yaml', '--repo', repoA,
        '--run-root', runRoot, '--run-id', 'inproc-tp', '--role-model', 'author=antigravity/gemini-4-carbon:medium', '--json',
      ]);
      assert.equal(tpOk.code, 0);
      assert.equal(process.env['LOOPWRIGHT_LOCAL_COMMAND_SIGNING_SECRET'], 'existing-secret');

      const bareSame = await runInProc(['step', 'next', '--run-root', runRoot, '--run-id', 'inproc-tp', '--repo', repoA, '--reissue-lease', '--json']);
      assert.equal(bareSame.code, 0);
      const lease = parseNdjson(bareSame.out)[0]!.data['leaseToken'] as string;

      const mismatchTp = await runInProc([
        'step', 'next', '--taskpack', '.loopwright/taskpack.yaml', '--repo', repoB,
        '--run-root', runRoot, '--run-id', 'inproc-tp', '--reissue-lease', '--json',
      ]);
      assert.equal(mismatchTp.code, 7);

      const subPath = join(root, 'sub.json');
      await writeFile(subPath, JSON.stringify({ version: 1, status: 'completed', checks: [{ checkId: 'docs-proposal-json', status: 'passed', evidenceId: null, reason: null }], reason: null }), { mode: 0o600 });
      await writeFile(join(parseNdjson(tpOk.out)[0]!.data['candidateDir'] as string, 'docs', 'proposal.json'), JSON.stringify({ schema_version: 1, candidates: ['ready'] }), { mode: 0o600 });
      const tpDone = await runInProc(['step', 'submit', '--run-root', runRoot, '--run-id', 'inproc-tp', '--lease', lease, '--submission-file', subPath, '--json']);
      assert.equal(tpDone.code, 0);
    } finally {
      if (prevToken === undefined) delete process.env['GITHUB_TOKEN'];
      else process.env['GITHUB_TOKEN'] = prevToken;
      if (prevSigning === undefined) delete process.env['LOOPWRIGHT_LOCAL_COMMAND_SIGNING_SECRET'];
      else process.env['LOOPWRIGHT_LOCAL_COMMAND_SIGNING_SECRET'] = prevSigning;
      if (prevGhSha === undefined) delete process.env['GITHUB_SHA'];
      else process.env['GITHUB_SHA'] = prevGhSha;
      if (prevGhWorkspace === undefined) delete process.env['GITHUB_WORKSPACE'];
      else process.env['GITHUB_WORKSPACE'] = prevGhWorkspace;
    }

    // 4. --config !loaded.ok, --config ok -> bare step next (without --repo) -> step submit (--status/--reason) -> step cancel
    const common = ['--config', f.input.configPath, '--registry', f.input.registryPath, '--registry-sha256', f.input.registrySha256];
    const badCfg = await runInProc(['step', 'next', ...common, '--repo', f.repository, '--run-root', f.runRoot, '--run-id', 'inproc-bad-cfg', '--role-model', 'nonexistent=antigravity/gemini-4-carbon', '--json']);
    assert.equal(badCfg.code, 2);

    const cfgOk = await runInProc(['step', 'next', ...common, '--repo', f.repository, '--run-root', f.runRoot, '--run-id', 'inproc-cfg', '--mode', 'no-change', '--json']);
    assert.equal(cfgOk.code, 0);
    const bareCfg = await runInProc(['step', 'next', '--run-root', f.runRoot, '--run-id', 'inproc-cfg', '--reissue-lease', '--json']);
    assert.equal(bareCfg.code, 0);
    const bareCfgWithRepo = await runInProc(['step', 'next', '--run-root', f.runRoot, '--run-id', 'inproc-cfg', '--repo', f.repository, '--reissue-lease', '--json']);
    assert.equal(bareCfgWithRepo.code, 0);
    const cfgCancel = await runInProc(['step', 'cancel', '--run-root', f.runRoot, '--run-id', 'inproc-cfg', '--json']);
    assert.equal(cfgCancel.code, 130);

    // 5. Fresh runRoot + unset signing secret + err.path === null + nonexistent --repo fallback
    const savedSecret = process.env['LOOPWRIGHT_LOCAL_COMMAND_SIGNING_SECRET'];
    delete process.env['LOOPWRIGHT_LOCAL_COMMAND_SIGNING_SECRET'];
    try {
      const freshRuns = join(root, 'fresh-runs');
      const freshOk = await runInProc([
        'step', 'next', '--taskpack', '.loopwright/taskpack.yaml', '--repo', repoA,
        '--run-root', freshRuns, '--run-id', 'inproc-fresh', '--json',
      ]);
      assert.equal(freshOk.code, 0);
      assert.equal(process.env['LOOPWRIGHT_LOCAL_COMMAND_SIGNING_SECRET'], undefined);

      await chmod(repoA, 0o755);
      const insideRuns = join(repoA, 'inside-runs');
      const nullPathErr = await runInProc([
        'step', 'next', '--taskpack', '.loopwright/taskpack.yaml', '--repo', repoA,
        '--run-root', insideRuns, '--run-id', 'inproc-inside', '--json',
      ]);
      assert.equal(nullPathErr.code, 2);
      assert.equal(parseNdjson(nullPathErr.out)[0]!.data['code'], 'ACTION_INPUT_INVALID');
      await assert.rejects(() => lstat(insideRuns), { code: 'ENOENT' });
      assert.equal(gitStatusPorcelain(repoA), '');

      const equalRepoErr = await runInProc([
        'step', 'next', '--taskpack', '.loopwright/taskpack.yaml', '--repo', repoA,
        '--run-root', repoA, '--run-id', 'inproc-equal', '--json',
      ]);
      assert.equal(equalRepoErr.code, 2);
      assert.equal(parseNdjson(equalRepoErr.out)[0]!.data['code'], 'ACTION_INPUT_INVALID');
      assert.equal((await lstat(repoA)).mode & 0o777, 0o755);
      assert.equal(gitStatusPorcelain(repoA), '');

      const symlinkRepoA = join(root, 'symlink-repo-a');
      await symlink(repoA, symlinkRepoA);
      const symlinkRepoErr = await runInProc([
        'step', 'next', '--taskpack', '.loopwright/taskpack.yaml', '--repo', repoA,
        '--run-root', symlinkRepoA, '--run-id', 'inproc-symlink-repo', '--json',
      ]);
      assert.equal(symlinkRepoErr.code, 2);
      assert.equal(parseNdjson(symlinkRepoErr.out)[0]!.data['code'], 'ACTION_INPUT_INVALID');
      assert.equal((await lstat(repoA)).mode & 0o777, 0o755);
      assert.equal(gitStatusPorcelain(repoA), '');

      // Ancestor --run-root whose .taskpack-<runId> or root encloses repoA must not run rm() before stageTaskpackForStep validation
      const ancestorPreStage = join(root, '.taskpack-inproc-ancestor');
      await mkdir(ancestorPreStage, { mode: 0o700 });
      const ancestorErr = await runInProc([
        'step', 'next', '--taskpack', '.loopwright/taskpack.yaml', '--repo', repoA,
        '--run-root', root, '--run-id', 'inproc-ancestor', '--json',
      ]);
      assert.equal(ancestorErr.code, 2);
      assert.equal(parseNdjson(ancestorErr.out)[0]!.data['code'], 'ACTION_INPUT_INVALID');
      assert.equal((await lstat(ancestorPreStage)).isDirectory(), true);
      assert.equal(gitStatusPorcelain(repoA), '');

      // Pre-existing symlink at <runRoot>/.taskpack-<runId> must not be removed before stageTaskpackForStep validation
      const victimDir = join(root, 'symlink-victim');
      await mkdir(victimDir, { mode: 0o700 });
      const stageSymlink = join(freshRuns, '.taskpack-inproc-stage-sym');
      await symlink(victimDir, stageSymlink);
      const stageSymErr = await runInProc([
        'step', 'next', '--taskpack', '.loopwright/taskpack.yaml', '--repo', repoA,
        '--run-root', freshRuns, '--run-id', 'inproc-stage-sym', '--json',
      ]);
      assert.equal(stageSymErr.code, 2);
      assert.equal(parseNdjson(stageSymErr.out)[0]!.data['code'], 'ACTION_INPUT_INVALID');
      assert.equal((await lstat(stageSymlink)).isSymbolicLink(), true);
      assert.equal((await lstat(victimDir)).isDirectory(), true);

      const missingRepo = await runInProc([
        'step', 'next', '--taskpack', '.loopwright/taskpack.yaml', '--repo', join(root, 'does-not-exist'),
        '--run-root', freshRuns, '--run-id', 'inproc-missing-repo', '--json',
      ]);
      assert.equal(missingRepo.code, 2);
      assert.equal(parseNdjson(missingRepo.out)[0]!.data['code'], 'ACTION_INPUT_INVALID');
    } finally {
      if (savedSecret !== undefined) process.env['LOOPWRIGHT_LOCAL_COMMAND_SIGNING_SECRET'] = savedSecret;
      else delete process.env['LOOPWRIGHT_LOCAL_COMMAND_SIGNING_SECRET'];
    }

    const cfgSubmitStart = await runInProc(['step', 'next', ...common, '--repo', f.repository, '--run-root', f.runRoot, '--run-id', 'inproc-sub', '--json']);
    assert.equal(cfgSubmitStart.code, 0);
    const cfgLease = parseNdjson(cfgSubmitStart.out)[0]!.data['leaseToken'] as string;
    const cfgSubmit = await runInProc(['step', 'submit', '--run-root', f.runRoot, '--run-id', 'inproc-sub', '--lease', cfgLease, '--status', 'no_change', '--reason', 'clean', '--json']);
    assert.equal(cfgSubmit.code, 0);
  } finally {
    await f.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
