import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializePrettyYaml } from '@loopwright/github-app';
import { main as cliMain } from '../src/main.js';

import {
  MAIN_PATH,
  CLEAN_ENV,
  runCli,
  parseNdjson,
  gitStatusPorcelain,
  createManagedDelegatedRepoFixture,
  createTaskpackRepo,
} from './step-cli-fixtures.js';

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

test('step-cli: allows explicit .auto-sync/proposal.json inside controlRoot while rejecting sibling and control-plane mutations', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lw-step-autosync-proposal-')));
  const repoRoot = join(root, 'repo');
  const runRoot = join(root, 'runs');
  try {
    await mkdir(join(repoRoot, '.auto-sync', 'checks'), { recursive: true, mode: 0o700 });
    await mkdir(join(repoRoot, 'pack', 'cann'), { recursive: true, mode: 0o700 });
    await writeFile(join(repoRoot, '.auto-sync', 'instructions.md'), '# Auto-sync Instructions\n', { mode: 0o600 });
    await writeFile(join(repoRoot, '.auto-sync', 'other.json'), '{"sibling":true}\n', { mode: 0o600 });
    await symlink('../pack/cann/upstream-versions.json', join(repoRoot, '.auto-sync', 'source-link.json'));
    await writeFile(join(repoRoot, 'pack', 'cann', 'upstream-versions.json'), JSON.stringify({ version: '2.0.0' }), { mode: 0o600 });
    await writeFile(join(repoRoot, 'pack', 'cann', 'version.txt'), '1.0.0\n', { mode: 0o600 });
    await writeFile(
      join(repoRoot, '.auto-sync', 'verify.sh'),
      '#!/bin/sh\ntest -f .auto-sync/proposal.json && grep -q \'"ready"\' .auto-sync/proposal.json\n',
      { mode: 0o755 },
    );
    const taskpackDoc = {
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'Taskpack',
      metadata: { name: 'autosync-step-proposal' },
      spec: {
        goal: {
          candidate: 'Update .auto-sync/proposal.json and pack/cann/version.txt.',
          noChange: 'Confirm no changes needed.',
        },
        instructions: ['.auto-sync/instructions.md'],
        limits: {
          maxAttempts: 1,
        },
        scope: {
          writable: ['.auto-sync/proposal.json', 'pack/cann'],
          protected: [],
        },
        roles: [
          { id: 'author', provider: 'antigravity', model: 'gemini-4-default', thinking: 'low' },
        ],
        upstreams: [
          { id: 'cann', kind: 'custom-table', source: 'pack/cann/upstream-versions.json', watchedPaths: ['pack/cann'] },
        ],
        proposal: {
          path: '.auto-sync/proposal.json',
          requiredFields: ['schema_version', 'candidates'],
          schemaVersion: 1,
        },
        verification: {
          localChecks: [
            { id: 'proposal-json', implementation: 'json-artifact.v1' },
            { id: 'cmd-check', implementation: 'command.v1', parameters: { script: '.auto-sync/verify.sh', timeoutSeconds: 10 } },
          ],
          externalGates: [],
        },
        publication: {
          mode: 'disabled',
          targetBranch: 'main',
          headBranchPrefix: 'loopwright-cann-',
          titleTemplate: 'chore(cann): sync',
        },
        memory: {
          directory: '.auto-sync/memory/cann',
          apply: 'separate-pull-request',
          onNoModelBudget: 'deterministic-observations-only',
        },
        triggers: {
          schedule: true,
          workflowDispatch: true,
          releasePublished: false,
          commentCommands: ['retry'],
        },
      },
    };
    await writeFile(join(repoRoot, '.auto-sync', 'taskpack.yaml'), serializePrettyYaml(taskpackDoc), { mode: 0o600 });
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

    // 1. Positive: writing .auto-sync/proposal.json + pack/cann/version.txt settles accepted
    const okNext = runCli([
      'step', 'next', '--taskpack', '.auto-sync/taskpack.yaml',
      '--repo', repoRoot, '--run-root', runRoot, '--run-id', 'autosync-ok', '--json',
    ]);
    assert.equal(okNext.status, 0, okNext.stdout + okNext.stderr);
    const okEnv = parseNdjson(okNext.stdout)[0]!;
    const okCandidateDir = okEnv.data['candidateDir'] as string;
    await writeFile(
      join(okCandidateDir, '.auto-sync', 'proposal.json'),
      JSON.stringify({ schema_version: 1, candidates: ['ready'] }),
      { mode: 0o600 },
    );
    await writeFile(join(okCandidateDir, 'pack', 'cann', 'version.txt'), '2.0.0\n', { mode: 0o600 });
    const okSubmit = runCli([
      'step', 'submit', '--run-root', runRoot, '--run-id', 'autosync-ok',
      '--lease', okEnv.data['leaseToken'] as string, '--json',
    ]);
    assert.equal(okSubmit.status, 0, okSubmit.stdout + okSubmit.stderr);
    const okSubmitEnv = parseNdjson(okSubmit.stdout)[0]!;
    assert.equal(okSubmitEnv.kind, 'result');
    const okResult = okSubmitEnv.data['result'] as { spec: { status: string } };
    assert.equal(okResult.spec.status, 'completed');

    // 2. Negative: writing unlisted sibling .auto-sync/other.json or tampering .auto-sync/instructions.md or .auto-sync/taskpack.yaml is rejected
    for (const [caseId, violate] of [
      ['autosync-bad-sibling', async (dir: string) => {
        await chmod(join(dir, '.auto-sync', 'other.json'), 0o600);
        await writeFile(join(dir, '.auto-sync', 'other.json'), '{"sibling":"tampered"}\n', { mode: 0o600 });
      }],
      ['autosync-bad-instr', async (dir: string) => {
        await chmod(join(dir, '.auto-sync', 'instructions.md'), 0o600);
        await writeFile(join(dir, '.auto-sync', 'instructions.md'), '# Tampered\n', { mode: 0o600 });
      }],
      ['autosync-bad-taskpack', async (dir: string) => {
        await chmod(join(dir, '.auto-sync', 'taskpack.yaml'), 0o600);
        await writeFile(join(dir, '.auto-sync', 'taskpack.yaml'), 'tampered: true\n', { mode: 0o600 });
      }],
    ] as const) {
      const badNext = runCli([
        'step', 'next', '--taskpack', '.auto-sync/taskpack.yaml',
        '--repo', repoRoot, '--run-root', runRoot, '--run-id', caseId, '--json',
      ]);
      assert.equal(badNext.status, 0, badNext.stdout + badNext.stderr);
      const badEnv = parseNdjson(badNext.stdout)[0]!;
      const badCandidateDir = badEnv.data['candidateDir'] as string;
      // Materialized control-plane and sibling files start read-only (0o400)
      assert.equal((await lstat(join(badCandidateDir, '.auto-sync', 'taskpack.yaml'))).mode & 0o222, 0);
      assert.equal((await lstat(join(badCandidateDir, '.auto-sync', 'instructions.md'))).mode & 0o222, 0);
      assert.equal((await lstat(join(badCandidateDir, '.auto-sync', 'other.json'))).mode & 0o222, 0);

      await writeFile(
        join(badCandidateDir, '.auto-sync', 'proposal.json'),
        JSON.stringify({ schema_version: 1, candidates: ['ready'] }),
        { mode: 0o600 },
      );
      await violate(badCandidateDir);

      const badSubmit = runCli([
        'step', 'submit', '--run-root', runRoot, '--run-id', caseId,
        '--lease', badEnv.data['leaseToken'] as string, '--json',
      ]);
      assert.notEqual(badSubmit.status, 0, `expected ${caseId} to be rejected: ${badSubmit.stdout}`);
      const badSubmitEnv = parseNdjson(badSubmit.stdout)[0]!;
      if (badSubmitEnv.kind === 'result') {
        const badResult = badSubmitEnv.data['result'] as { spec: { status: string } };
        assert.notEqual(badResult.spec.status, 'completed', `expected ${caseId} not to complete`);
      } else {
        assert.equal(badSubmitEnv.kind, 'diagnostic');
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
