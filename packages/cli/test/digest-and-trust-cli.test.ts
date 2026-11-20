import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializePrettyYaml } from '@loopwright/taskpack';
import { parseArguments, UsageError } from '../src/arguments.js';
import { parseNdjson, runCli, runCliInProcess } from './step-cli-fixtures.js';

function initGitRepo(repoRoot: string): void {
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
  git(['-c', 'user.name=Digest CLI Test', '-c', 'user.email=digest@localhost.invalid', 'commit', '-qm', 'init']);
}

async function createDigestTaskpackRepo(
  repoRoot: string,
  options?: {
    readonly lockfile?: string;
    readonly execution?: Record<string, unknown>;
    readonly writable?: readonly string[];
    readonly protected?: readonly string[];
    readonly decisions?: Record<string, unknown>;
  },
): Promise<void> {
  await mkdir(join(repoRoot, '.loopwright', 'checks'), { recursive: true, mode: 0o700 });
  await mkdir(join(repoRoot, '.loopwright', 'scripts'), { recursive: true, mode: 0o700 });
  await mkdir(join(repoRoot, 'docs'), { recursive: true, mode: 0o700 });
  await mkdir(join(repoRoot, '.github', 'workflows'), { recursive: true, mode: 0o700 });

  await writeFile(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'name: CI\n', { mode: 0o600 });
  await writeFile(join(repoRoot, 'docs', 'proposal.json'), JSON.stringify({ schema_version: 1, candidates: [] }), { mode: 0o600 });
  await writeFile(join(repoRoot, 'docs', 'upstream-versions.json'), JSON.stringify({ version: '1.0.0' }), { mode: 0o600 });
  await writeFile(join(repoRoot, '.loopwright', 'instructions.md'), '# Instructions\nFollow scope.\n', { mode: 0o600 });
  await writeFile(
    join(repoRoot, '.loopwright', 'checks', 'lib.sh'),
    '#!/bin/sh\ncheck_helper() { test -f docs/proposal.json; }\n',
    { mode: 0o755 },
  );
  await writeFile(
    join(repoRoot, '.loopwright', 'checks', 'verify.sh'),
    '#!/bin/sh\n. "$(dirname "$0")/lib.sh"\ncheck_helper\n',
    { mode: 0o755 },
  );
  await writeFile(
    join(repoRoot, '.loopwright', 'scripts', 'preflight.sh'),
    '#!/bin/sh\nprintf \'{"disposition":"candidate"}\' > "$LOOPWRIGHT_PREFLIGHT_OUT"\n',
    { mode: 0o755 },
  );

  const execution = options?.execution ?? (options?.lockfile
    ? { mode: 'strict', digests: { pinDigests: true, lockfile: options.lockfile } }
    : { mode: 'strict', digests: { pinDigests: true } });

  const taskpackDoc = {
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'Taskpack',
    metadata: { name: 'digest-sync-demo' },
    spec: {
      goal: {
        candidate: 'Update docs/proposal.json with candidate entries.',
        noChange: 'Confirm no changes needed.',
      },
      execution,
      instructions: ['.loopwright/instructions.md'],
      preflight: {
        script: '.loopwright/scripts/preflight.sh',
        timeoutSeconds: 10,
      },
      scope: {
        writable: [...(options?.writable ?? ['docs/**'])],
        protected: [...(options?.protected ?? ['docs/protected.md'])],
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
      ...(options?.decisions !== undefined ? { decisions: options.decisions } : {}),
      publication: {
        mode: 'disabled',
        targetBranch: 'main',
        headBranchPrefix: 'loopwright-docs-',
        titleTemplate: 'docs: sync',
      },
      memory: {
        directory: '.loopwright/memory/digest-sync-demo',
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
  initGitRepo(repoRoot);
}

test('digest-cli: parseArguments validates digest sync and opt-in host privilege flags', () => {
  const syncBasic = parseArguments(['digest', 'sync', '--taskpack', '.loopwright/taskpack.yaml']);
  assert.equal(syncBasic.command, 'digest');
  assert.equal(syncBasic.digestAction, 'sync');
  assert.equal(syncBasic.values.get('taskpack'), '.loopwright/taskpack.yaml');
  assert.equal(syncBasic.flags.has('check'), false);

  const syncFull = parseArguments(['digest', 'sync', '--taskpack', '.loopwright/taskpack.yaml', '--repo', '/repo', '--check', '--json']);
  assert.equal(syncFull.command, 'digest');
  assert.equal(syncFull.digestAction, 'sync');
  assert.equal(syncFull.values.get('repo'), '/repo');
  assert.equal(syncFull.flags.has('check'), true);
  assert.equal(syncFull.flags.has('json'), true);

  // Host privilege flags on taskpack/step/run entrypoints
  const stepPriv = parseArguments([
    'step', 'next', '--run-root', '/runs', '--run-id', 'priv-1',
    '--taskpack', '.loopwright/taskpack.yaml', '--repo', '/repo',
    '--allow-privileged', '--allow-workflow-writes', '--json',
  ]);
  assert.equal(stepPriv.flags.has('allow-privileged'), true);
  assert.equal(stepPriv.flags.has('allow-workflow-writes'), true);

  const stepSubPriv = parseArguments([
    'step', 'submit', '--run-root', '/runs', '--run-id', 'priv-1', '--lease', 'tok-1',
    '--allow-workflow-writes',
  ]);
  assert.equal(stepSubPriv.flags.has('allow-workflow-writes'), true);

  const common = ['--config', '/cfg', '--registry', '/reg', '--registry-sha256', 'a'.repeat(64)];
  const runTarget = ['--repo', '/repo', '--run-root', '/runs', '--run-id', 'run-1'];
  const runPriv = parseArguments(['run', ...common, ...runTarget, '--allow-privileged', '--allow-workflow-writes']);
  assert.equal(runPriv.flags.has('allow-privileged'), true);
  assert.equal(runPriv.flags.has('allow-workflow-writes'), true);

  const resumePriv = parseArguments(['resume', ...common, ...runTarget, '--allow-privileged', '--allow-workflow-writes']);
  assert.equal(resumePriv.flags.has('allow-privileged'), true);
  assert.equal(resumePriv.flags.has('allow-workflow-writes'), true);

  const reconcileWf = parseArguments([
    'reconcile', ...common, ...runTarget, '--receipt', '/receipt.json', '--allow-workflow-writes', '--json',
  ]);
  assert.equal(reconcileWf.command, 'reconcile');
  assert.equal(reconcileWf.flags.has('allow-workflow-writes'), true);
  assert.equal(reconcileWf.flags.has('json'), true);

  // Reject malformed digest commands and privilege flags on non-execution commands
  for (const invalid of [
    ['digest'],
    ['digest', 'unknown', '--taskpack', 'tp.yaml'],
    ['digest', 'sync'],
    ['digest', 'sync', '--taskpack', 'tp.yaml', '--allow-privileged'],
    ['digest', 'sync', '--taskpack', 'tp.yaml', '--bogus'],
    ['reconcile', ...common, ...runTarget, '--receipt', '/receipt.json', '--allow-privileged'],
    ['app-serve', '--config', 'app.yaml', '--allow-privileged'],
    ['app-serve', '--config', 'app.yaml', '--allow-workflow-writes'],
    ['status', '--run-root', '/runs', '--run-id', 'r1', '--allow-privileged'],
    ['closure', '--allow-privileged'],
    ['run', '--dry-run', ...common, '--allow-privileged'],
    ['run', '--dry-run', ...common, '--allow-workflow-writes'],
  ]) {
    assert.throws(() => parseArguments(invalid), UsageError, `expected UsageError for ${JSON.stringify(invalid)}`);
  }
});

test('digest-cli: loopwright digest sync writes deterministic lockfile, --check detects script and lib.sh drift, and re-sync restores parity', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lw-digest-sync-')));
  const repoRoot = join(root, 'repo');
  try {
    await createDigestTaskpackRepo(repoRoot);

    // 1. --check fails closed when lockfile is missing
    const missingCheck = await runCliInProcess([
      'digest', 'sync', '--taskpack', '.loopwright/taskpack.yaml', '--repo', repoRoot, '--check', '--json',
    ]);
    assert.equal(missingCheck.status, 4, missingCheck.stdout + missingCheck.stderr);
    const missingEnv = parseNdjson(missingCheck.stdout)[0]!;
    assert.equal(missingEnv.kind, 'diagnostic');
    assert.equal(missingEnv.data['code'], 'DIGEST_LOCKFILE_DRIFT');
    assert.match(String(missingEnv.data['message']), /digests\.lock\.json/);

    // 2. digest sync writes deterministic digests.lock.json
    const synced1 = await runCliInProcess([
      'digest', 'sync', '--taskpack', '.loopwright/taskpack.yaml', '--repo', repoRoot, '--json',
    ]);
    assert.equal(synced1.status, 0, synced1.stdout + synced1.stderr);
    const syncEnv = parseNdjson(synced1.stdout)[0]!;
    assert.equal(syncEnv.kind, 'digest');
    assert.equal(syncEnv.data['ok'], true);
    assert.equal(syncEnv.data['lockfilePath'], '.loopwright/digests.lock.json');

    const lockBytes1 = await readFile(join(repoRoot, '.loopwright', 'digests.lock.json'), 'utf8');
    const lockObj = JSON.parse(lockBytes1) as { version: number; taskpack: string; entries: readonly { path: string; kind: string; sha256: string }[] };
    assert.equal(lockObj.version, 1);
    assert.equal(lockObj.taskpack, 'digest-sync-demo');
    assert.ok(lockObj.entries.some(e => e.path === '.loopwright/checks' && e.kind === 'directory'));
    assert.ok(lockObj.entries.some(e => e.path === '.loopwright/scripts/preflight.sh' && e.kind === 'file'));
    assert.ok(lockObj.entries.some(e => e.path === '.loopwright/instructions.md' && e.kind === 'file'));

    // Re-running digest sync produces byte-identical output
    const synced2 = await runCliInProcess([
      'digest', 'sync', '--taskpack', '.loopwright/taskpack.yaml', '--repo', repoRoot,
    ]);
    assert.equal(synced2.status, 0, synced2.stdout + synced2.stderr);
    const lockBytes2 = await readFile(join(repoRoot, '.loopwright', 'digests.lock.json'), 'utf8');
    assert.equal(lockBytes2, lockBytes1);

    // 3. --check exits 0 when matching (also verify via real subprocess)
    const checkOk = runCli([
      'digest', 'sync', '--taskpack', '.loopwright/taskpack.yaml', '--repo', repoRoot, '--check', '--json',
    ]);
    assert.equal(checkOk.status, 0, checkOk.stdout + checkOk.stderr);
    assert.equal(parseNdjson(checkOk.stdout)[0]!.data['ok'], true);

    // 4. Editing sibling ./lib.sh helper causes --check to exit non-zero with clear drift diagnostic
    await writeFile(
      join(repoRoot, '.loopwright', 'checks', 'lib.sh'),
      '#!/bin/sh\ncheck_helper() { test -f docs/proposal.json && echo drifted; }\n',
      { mode: 0o755 },
    );
    const driftLibJson = await runCliInProcess([
      'digest', 'sync', '--taskpack', '.loopwright/taskpack.yaml', '--repo', repoRoot, '--check', '--json',
    ]);
    assert.equal(driftLibJson.status, 4, driftLibJson.stdout + driftLibJson.stderr);
    const driftLibEnv = parseNdjson(driftLibJson.stdout)[0]!;
    assert.equal(driftLibEnv.kind, 'diagnostic');
    assert.equal(driftLibEnv.data['code'], 'DIGEST_LOCKFILE_DRIFT');
    assert.match(String(driftLibEnv.data['message']), /\.loopwright\/checks/);
    const drifts = driftLibEnv.data['drifts'] as readonly { path: string; kind: string; status: string }[];
    assert.equal(drifts.length, 1);
    assert.equal(drifts[0]!.path, '.loopwright/checks');
    assert.equal(drifts[0]!.kind, 'directory');
    assert.equal(drifts[0]!.status, 'drifted');

    // Human mode emits drift diagnostic to stderr
    const driftHuman = await runCliInProcess([
      'digest', 'sync', '--taskpack', '.loopwright/taskpack.yaml', '--repo', repoRoot, '--check',
    ]);
    assert.equal(driftHuman.status, 4);
    assert.match(driftHuman.stderr, /\.loopwright\/checks/);

    // 5. Editing tracked preflight script ALSO appears in drift diagnostics alongside .loopwright/checks
    await writeFile(
      join(repoRoot, '.loopwright', 'scripts', 'preflight.sh'),
      '#!/bin/sh\n# mutated\nprintf \'{"disposition":"candidate"}\' > "$LOOPWRIGHT_PREFLIGHT_OUT"\n',
      { mode: 0o755 },
    );
    const driftBoth = await runCliInProcess([
      'digest', 'sync', '--taskpack', '.loopwright/taskpack.yaml', '--repo', repoRoot, '--check', '--json',
    ]);
    assert.equal(driftBoth.status, 4);
    const bothDrifts = parseNdjson(driftBoth.stdout)[0]!.data['drifts'] as readonly { path: string }[];
    assert.deepEqual(bothDrifts.map(d => d.path).sort(), ['.loopwright/checks', '.loopwright/scripts/preflight.sh']);

    // 6. Re-running digest sync restores parity
    const resync = await runCliInProcess([
      'digest', 'sync', '--taskpack', '.loopwright/taskpack.yaml', '--repo', repoRoot, '--json',
    ]);
    assert.equal(resync.status, 0, resync.stdout + resync.stderr);

    const checkRestored = await runCliInProcess([
      'digest', 'sync', '--taskpack', '.loopwright/taskpack.yaml', '--repo', repoRoot, '--check', '--json',
    ]);
    assert.equal(checkRestored.status, 0, checkRestored.stdout + checkRestored.stderr);

    // 7. Custom lockfile path support
    await unlink(join(repoRoot, '.loopwright', 'digests.lock.json'));
    const customRepo = join(root, 'custom-repo');
    await createDigestTaskpackRepo(customRepo, { lockfile: '.loopwright/custom.lock.json' });
    const customSync = await runCliInProcess([
      'digest', 'sync', '--taskpack', '.loopwright/taskpack.yaml', '--repo', customRepo, '--json',
    ]);
    assert.equal(customSync.status, 0, customSync.stdout + customSync.stderr);
    assert.equal(parseNdjson(customSync.stdout)[0]!.data['lockfilePath'], '.loopwright/custom.lock.json');
    const customCheck = await runCliInProcess([
      'digest', 'sync', '--taskpack', '.loopwright/taskpack.yaml', '--repo', customRepo, '--check', '--json',
    ]);
    assert.equal(customCheck.status, 0, customCheck.stdout + customCheck.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('digest-cli: --allow-privileged and --allow-workflow-writes fail closed by default and unlock explicitly on step next', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lw-priv-flags-')));
  const runRoot = join(root, 'runs');
  try {
    // 1. mode: privileged fails closed without --allow-privileged, succeeds with --allow-privileged
    const privRepo = join(root, 'priv-repo');
    await createDigestTaskpackRepo(privRepo, {
      execution: { mode: 'privileged', digests: { pinDigests: false } },
    });

    const deniedPriv = await runCliInProcess([
      'step', 'next', '--taskpack', '.loopwright/taskpack.yaml', '--repo', privRepo,
      '--run-root', runRoot, '--run-id', 'priv-denied', '--json',
    ]);
    assert.equal(deniedPriv.status, 2, deniedPriv.stdout + deniedPriv.stderr);
    assert.equal(parseNdjson(deniedPriv.stdout)[0]!.data['code'], 'TASKPACK_HOST_BINDING_INVALID');

    const allowedPriv = await runCliInProcess([
      'step', 'next', '--taskpack', '.loopwright/taskpack.yaml', '--repo', privRepo,
      '--run-root', runRoot, '--run-id', 'priv-allowed', '--allow-privileged', '--json',
    ]);
    assert.equal(allowedPriv.status, 0, allowedPriv.stdout + allowedPriv.stderr);
    assert.equal(parseNdjson(allowedPriv.stdout)[0]!.kind, 'step');

    // 2. allowWorkflowWrites: true fails closed without --allow-workflow-writes, succeeds with --allow-workflow-writes
    const wfRepo = join(root, 'wf-repo');
    await createDigestTaskpackRepo(wfRepo, {
      execution: { mode: 'strict', capabilities: { allowWorkflowWrites: true }, digests: { pinDigests: false } },
      writable: ['docs/**', '.github/workflows/**'],
    });

    const deniedWf = await runCliInProcess([
      'step', 'next', '--taskpack', '.loopwright/taskpack.yaml', '--repo', wfRepo,
      '--run-root', runRoot, '--run-id', 'wf-denied', '--json',
    ]);
    assert.equal(deniedWf.status, 2, deniedWf.stdout + deniedWf.stderr);
    assert.equal(parseNdjson(deniedWf.stdout)[0]!.data['code'], 'TASKPACK_SCOPE_VIOLATION');

    const allowedWf = await runCliInProcess([
      'step', 'next', '--taskpack', '.loopwright/taskpack.yaml', '--repo', wfRepo,
      '--run-root', runRoot, '--run-id', 'wf-allowed', '--allow-workflow-writes', '--json',
    ]);
    assert.equal(allowedWf.status, 0, allowedWf.stdout + allowedWf.stderr);
    assert.equal(parseNdjson(allowedWf.stdout)[0]!.kind, 'step');

    // 3. step submit --allow-workflow-writes cannot escalate a strict staged taskpack run post-admission
    const strictRepo = join(root, 'strict-no-escalate-repo');
    await createDigestTaskpackRepo(strictRepo, {
      execution: { mode: 'strict', digests: { pinDigests: false } },
      protected: ['docs/protected.md', '.github/workflows/**'],
    });
    const strictStep = await runCliInProcess([
      'step', 'next', '--taskpack', '.loopwright/taskpack.yaml', '--repo', strictRepo,
      '--run-root', runRoot, '--run-id', 'strict-no-escalate', '--json',
    ]);
    assert.equal(strictStep.status, 0, strictStep.stdout + strictStep.stderr);
    const strictYield = parseNdjson(strictStep.stdout)[0]!;
    assert.equal(strictYield.kind, 'step');
    const strictLease = strictYield.data['leaseToken'] as string;
    const strictWorkspace = strictYield.data['candidateDir'] as string;
    const strictWorkflowPath = join(strictWorkspace, '.github', 'workflows', 'ci.yml');
    await chmod(join(strictWorkspace, '.github', 'workflows'), 0o700);
    await chmod(strictWorkflowPath, 0o600);
    await writeFile(strictWorkflowPath, 'name: Escalated\n', { mode: 0o600 });
    const escalatedSubmit = await runCliInProcess([
      'step', 'submit', '--run-root', runRoot, '--run-id', 'strict-no-escalate',
      '--lease', strictLease, '--status', 'completed', '--allow-workflow-writes', '--json',
    ]);
    assert.equal(escalatedSubmit.status, 4, escalatedSubmit.stdout + escalatedSubmit.stderr);
    const escalatedEnv = parseNdjson(escalatedSubmit.stdout).at(-1)!;
    assert.equal(escalatedEnv.kind, 'result');
    assert.equal((escalatedEnv.data['result'] as { spec: { status: string } }).spec.status, 'failed');

    // 4. spec.decisions.enabled: true with triageRules wires ControllerPorts.decisions and records advisoryDecisions
    const decRepo = join(root, 'dec-repo');
    await createDigestTaskpackRepo(decRepo, {
      execution: { mode: 'strict', digests: { pinDigests: false } },
      decisions: {
        enabled: true,
        provider: 'typesafe-jev',
        disclosurePolicy: 'public-metadata-only',
        triageRules: [
          { id: 'docs-triage', description: 'Flag unexpected proposal changes', severity: 'important', kind: 'noul' },
        ],
      },
    });
    const decStep = await runCliInProcess([
      'step', 'next', '--taskpack', '.loopwright/taskpack.yaml', '--repo', decRepo,
      '--run-root', runRoot, '--run-id', 'dec-wired', '--json',
    ]);
    assert.equal(decStep.status, 0, decStep.stdout + decStep.stderr);
    const decEnv = parseNdjson(decStep.stdout)[0]!;
    assert.equal(decEnv.kind, 'step');
    const decLease = decEnv.data['leaseToken'] as string;
    const decWorkspace = decEnv.data['candidateDir'] as string;
    await writeFile(
      join(decWorkspace, 'docs', 'proposal.json'),
      JSON.stringify({ schema_version: 1, candidates: ['v2'] }),
      { mode: 0o600 },
    );
    const decSubmit = await runCliInProcess([
      'step', 'submit', '--run-root', runRoot, '--run-id', 'dec-wired',
      '--lease', decLease, '--status', 'completed', '--json',
    ]);
    assert.equal(decSubmit.status, 0, decSubmit.stdout + decSubmit.stderr);
    const decResult = parseNdjson(decSubmit.stdout).at(-1)!;
    assert.equal(decResult.kind, 'result');
    const obsRef = decResult.data['observations'] as { readonly name?: string } | undefined;
    assert.ok(typeof obsRef?.name === 'string' && obsRef.name.length > 0, `expected observations ref in ${JSON.stringify(decResult.data)}`);
    const obsDoc = JSON.parse(
      await readFile(join(runRoot, 'dec-wired', 'artifacts', obsRef.name), 'utf8'),
    ) as { readonly advisoryDecisions?: readonly Record<string, unknown>[] };
    const advisoryEntries = obsDoc.advisoryDecisions ?? [];
    assert.ok(
      advisoryEntries.some(entry => entry['intent'] === 'triage_candidate_diff' && entry['verificationCertified'] === false),
      `expected triage_candidate_diff advisory entry in ${JSON.stringify(obsDoc)}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('step-cli: loopwright step next --taskpack executes spec.preflight, mounts prompt+workspace staged resources, and exposes LOOPWRIGHT_STAGED_DIR to command.v1 on submit', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lw-step-preflight-cli-')));
  const repoRoot = join(root, 'repo');
  const runRoot = join(root, 'runs');
  try {
    await mkdir(join(repoRoot, '.loopwright', 'scripts'), { recursive: true, mode: 0o700 });
    await mkdir(join(repoRoot, '.loopwright', 'checks'), { recursive: true, mode: 0o700 });
    await mkdir(join(repoRoot, 'docs'), { recursive: true, mode: 0o700 });

    const stagedDataContent = '{"expectedToken":"STAGED_OK_42"}\n';
    const agentOnlyContent = 'AGENT_ONLY_CONTEXT_99\n';
    const promptNoteContent = 'PREFLIGHT_PROMPT_SENTINEL_777\n';
    const expectedStagedSha = createHash('sha256').update(stagedDataContent, 'utf8').digest('hex');
    const expectedAgentOnlySha = createHash('sha256').update(agentOnlyContent, 'utf8').digest('hex');

    await writeFile(join(repoRoot, 'docs', 'proposal.json'), JSON.stringify({ schema_version: 1, candidates: [] }), { mode: 0o600 });
    await writeFile(
      join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs'),
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const stagingDir = process.env.LOOPWRIGHT_STAGING_DIR;
writeFileSync(join(stagingDir, 'prompt-note.md'), ${JSON.stringify(promptNoteContent)}, 'utf8');
writeFileSync(join(stagingDir, 'staged-data.json'), ${JSON.stringify(stagedDataContent)}, 'utf8');
writeFileSync(join(stagingDir, 'agent-only.txt'), ${JSON.stringify(agentOnlyContent)}, 'utf8');
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'candidate',
  stagedResources: [
    { id: 'prompt-note', kind: 'instruction', path: 'prompt-note.md', mount: 'prompt', exposeToChecks: false },
    { id: 'staged-data', kind: 'document', path: 'staged-data.json', mount: 'workspace', exposeToChecks: true },
    { id: 'agent-only', kind: 'document', path: 'agent-only.txt', mount: 'workspace', exposeToChecks: false },
  ],
}), 'utf8');
`,
      { mode: 0o755 },
    );
    await writeFile(
      join(repoRoot, '.loopwright', 'checks', 'verify-staged.sh'),
      `#!/bin/sh
set -eu
test -n "\${LOOPWRIGHT_STAGED_DIR:-}"
test -f "$LOOPWRIGHT_STAGED_DIR/staged-data.json"
grep -q 'STAGED_OK_42' "$LOOPWRIGHT_STAGED_DIR/staged-data.json"
test ! -e "$LOOPWRIGHT_STAGED_DIR/agent-only.txt"
`,
      { mode: 0o755 },
    );
    await writeFile(
      join(repoRoot, '.loopwright', 'taskpack.yaml'),
      serializePrettyYaml({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'Taskpack',
        metadata: { name: 'step-preflight-cli' },
        spec: {
          execution: { mode: 'strict', digests: { pinDigests: false } },
          goal: { candidate: 'Update docs/proposal.json.', noChange: 'Confirm no change.' },
          preflight: { script: '.loopwright/scripts/preflight.mjs', timeoutSeconds: 15 },
          scope: { writable: ['docs/**'], protected: [] },
          roles: [{ id: 'author', provider: 'antigravity', model: 'gemini-4-default', thinking: 'low' }],
          upstreams: [],
          proposal: { path: 'docs/proposal.json', requiredFields: ['schema_version', 'candidates'], schemaVersion: 1 },
          verification: {
            localChecks: [
              { id: 'proposal-json', implementation: 'json-artifact.v1' },
              { id: 'verify-staged', implementation: 'command.v1', parameters: { script: '.loopwright/checks/verify-staged.sh', timeoutSeconds: 15 } },
            ],
            externalGates: [],
          },
          publication: { mode: 'disabled', targetBranch: 'main', headBranchPrefix: 'lw/', titleTemplate: 'docs: sync' },
          memory: { directory: '.loopwright/memory/step-preflight', apply: 'disabled', onNoModelBudget: 'deterministic-observations-only' },
          triggers: { schedule: false, workflowDispatch: true, releasePublished: false, commentCommands: [] },
        },
      }),
      { mode: 0o600 },
    );
    initGitRepo(repoRoot);

    const nextOut = await runCliInProcess([
      'step', 'next', '--taskpack', '.loopwright/taskpack.yaml', '--repo', repoRoot,
      '--run-root', runRoot, '--run-id', 'preflight-cli-1', '--json',
    ]);
    assert.equal(nextOut.status, 0, nextOut.stdout + nextOut.stderr);
    const stepEnv = parseNdjson(nextOut.stdout)[0]!;
    assert.equal(stepEnv.kind, 'step');

    const promptText = String(stepEnv.data['prompt'] ?? '');
    const contextFiles = (stepEnv.data['contextFiles'] as readonly string[] | undefined) ?? [];
    assert.ok(contextFiles.length > 0, `expected mounted prompt contextFiles in StepYield, got: ${JSON.stringify(stepEnv.data)}`);
    const contextContents = await Promise.all(contextFiles.map(file => readFile(file, 'utf8')));
    assert.ok(
      contextContents.some(text => text.includes('PREFLIGHT_PROMPT_SENTINEL_777')),
      `expected mount=prompt resource sentinel in contextFiles (${JSON.stringify(contextFiles)})`,
    );
    const readOnlyMatches = [...promptText.matchAll(/readOnlyPath=(\S+)/g)].map(m => m[1]!);
    assert.equal(readOnlyMatches.length, 2, `expected 2 workspace readOnlyPath pointers in prompt:\n${promptText}`);

    const stagedDataPath = readOnlyMatches.find(p => p.endsWith('staged-data.json'));
    const agentOnlyPath = readOnlyMatches.find(p => p.endsWith('agent-only.txt'));
    assert.ok(stagedDataPath !== undefined && agentOnlyPath !== undefined);

    for (const [filePath, expectedSha] of [
      [stagedDataPath, expectedStagedSha],
      [agentOnlyPath, expectedAgentOnlySha],
    ] as const) {
      const diskBytes = await readFile(filePath);
      assert.equal(createHash('sha256').update(diskBytes).digest('hex'), expectedSha);
      const fileMode = (await lstat(filePath)).mode & 0o777;
      assert.ok(fileMode === 0o444 || fileMode === 0o400, `expected read-only mode on ${filePath}, got 0o${fileMode.toString(8)}`);
    }

    const leaseToken = String(stepEnv.data['leaseToken'] ?? '');
    const candidateDir = String(stepEnv.data['candidateDir'] ?? '');
    await writeFile(
      join(candidateDir, 'docs', 'proposal.json'),
      JSON.stringify({ schema_version: 1, candidates: ['verified-with-staged-dir'] }),
      { mode: 0o600 },
    );

    const submitOut = await runCliInProcess([
      'step', 'submit', '--run-root', runRoot, '--run-id', 'preflight-cli-1',
      '--lease', leaseToken, '--status', 'completed', '--json',
    ]);
    assert.equal(submitOut.status, 0, submitOut.stdout + submitOut.stderr);
    const submitEnv = parseNdjson(submitOut.stdout).at(-1)!;
    assert.equal(submitEnv.kind, 'result');
    const resultSpec = (submitEnv.data['result'] as { spec?: { status?: string } } | undefined)?.spec;
    assert.equal(resultSpec?.status, 'completed');
  } finally {
    const restore = async (p: string): Promise<void> => {
      const st = await lstat(p).catch(() => null);
      if (st === null || st.isSymbolicLink() || !st.isDirectory()) return;
      await chmod(p, 0o700).catch(() => undefined);
      for (const entry of await readdir(p, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory()) await restore(join(p, entry.name));
      }
    };
    await restore(root);
    await rm(root, { recursive: true, force: true });
  }
});
