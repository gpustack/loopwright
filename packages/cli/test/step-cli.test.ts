import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GITHUB_APP_ERROR_CODES, serializePrettyYaml, type GitHubAppErrorCode } from '@loopwright/github-app';
import { parseArguments, UsageError } from '../src/arguments.js';
import { gitHubAppExitCode, main as cliMain } from '../src/main.js';

import {
  CLEAN_ENV,
  runCli,
  parseNdjson,
  gitStatusPorcelain,
  createManagedDelegatedRepoFixture,
  createTaskpackRepo,
} from './step-cli-fixtures.js';

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
