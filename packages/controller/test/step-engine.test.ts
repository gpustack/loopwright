import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open as fsOpen, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bindSubject } from '@loopwright/core';
import { reopenLocalRun } from '@loopwright/state';
import type { PiAdapterV2, PiHostV2, PiOpenInputV2 } from '@loopwright/agent-pi';
import {
  inspectRun,
  installedHandlerDigests,
  reconcileCycle,
  resumeCycleWithPorts,
  runCycleWithPorts,
  signPayload,
  stepCancel,
  stepNext,
  stepSubmit,
  verifySignedPayload,
  type StepTickResult,
  type StepYield,
} from '../src/index.js';
import { approvedState, loadConfiguration } from '../src/config.js';
import { createCycle, Cycle } from '../src/controller.js';
import { ControllerEvents } from '../src/events.js';
import { ControllerOwner } from '../src/ownership.js';
import { phaseCheckpointId, ProgressStore, verifierOperationId } from '../src/progress.js';
import { prepareGate } from '../src/gate.js';
import { preparePublication } from '../src/publication.js';
import { canonical, hash } from '../src/schema.js';
import { ArtifactStore, stateValue } from '../src/storage.js';
import { configurationFixture } from './config-fixtures.js';
import { setFixture } from './progress-fixtures.js';

function assertOk<T>(res: { readonly ok: boolean; readonly value?: T; readonly error?: unknown }, msg = ''): T {
  assert.equal(res.ok, true, `${msg}: ${JSON.stringify(res.error)}`);
  return res.value as T;
}

function assertStepYield(tick: StepTickResult, msg = ''): StepYield {
  assert.equal(tick.kind, 'step', `${msg}: expected step yield, got ${JSON.stringify(tick)}`);
  if (tick.kind !== 'step') throw new Error('expected step');
  return tick;
}

async function delegatedRepoFixture(options?: {
  readonly multiRole?: boolean;
  readonly mixedPiFirst?: boolean;
  readonly noChangeCheck?: boolean;
  readonly gateUrl?: string;
  readonly wallTimeMs?: number;
  readonly maxModelCalls?: number;
  readonly maxFormatRepairs?: number;
  readonly maxImplementationRepairs?: number;
  readonly maxAttempts?: number;
  readonly submissionPath?: string | null;
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
  git(['-c', 'user.name=Step Fixture', '-c', 'user.email=fixture@localhost.invalid', 'commit', '-qm', 'initial baseline']);
  const revision = git(['rev-parse', 'HEAD']).trim();

  const installed = await installedHandlerDigests();
  setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], revision);
  setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], revision);
  setFixture(f.config, ['spec', 'task', 'spec', 'scope'], {
    writable: ['packages/**'],
    protected: ['docs/**', '.github/workflows/**'],
  });

  if (options?.wallTimeMs !== undefined) {
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'wallTimeMs'], options.wallTimeMs);
  }
  if (options?.maxModelCalls !== undefined) {
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxModelCalls'], options.maxModelCalls);
    setFixture(
      f.config,
      ['spec', 'task', 'spec', 'budgets', 'maxConcurrency'],
      Math.min(f.config.spec.task.spec.budgets.maxConcurrency, options.maxModelCalls),
    );
  }
  if (options?.maxFormatRepairs !== undefined) {
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxFormatRepairs'], options.maxFormatRepairs);
  }
  if (options?.maxImplementationRepairs !== undefined) {
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxImplementationRepairs'], options.maxImplementationRepairs);
  }
  if (options?.maxAttempts !== undefined) {
    setFixture(f.config, ['spec', 'controls', 'maxAttempts'], options.maxAttempts);
  }
  if (options?.submissionPath !== undefined) {
    setFixture(f.config, ['spec', 'controls', 'submission', 'path'], options.submissionPath);
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
      parameters: { purpose: 'review', prompt: 'Review the candidate diff and verify all checks.' },
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

  const gateSecret = 'STEP_GATE_SECRET_CANARY_112233445566';
  if (options?.gateUrl !== undefined) {
    f.environment.GATE_SECRET = gateSecret;
    handlers.push({
      id: 'gate.check',
      version: 1,
      digest: installed['gate.v1'],
      kind: 'check',
      implementation: 'gate.v1',
      parameters: { checkId: 'gate-check', endpointRef: 'local-cmd', gateId: 'cmd-gate' },
      capabilities: ['external_service', 'read_only'],
    });
    setFixture(f.registry, ['spec', 'gateEndpoints'], [
      {
        id: 'local-cmd',
        url: options.gateUrl,
        signingCredentialRef: 'gate-signer',
        authCredentialRef: null,
        timeoutMs: 1500,
        maxPollMs: 3000,
        pollInitialMs: 100,
        pollMaxMs: 200,
        jitter: 0,
      },
    ]);
  }

  setFixture(f.registry, ['spec', 'handlers'], handlers);

  if (options?.mixedPiFirst) {
    const existingProfile = f.registry.spec.roleProfiles[0]!;
    setFixture(f.registry, ['spec', 'roleProfiles'], [
      existingProfile,
      {
        id: 'reviewer-delegated',
        adapter: 'delegated',
        runtimeRef: null,
        providerCredentialRef: null,
        selection: { provider: 'antigravity', model: 'gemini-4-argon', thinking: 'low' },
        tools: ['read'],
        mcp: null,
      },
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'roles'], [
      f.config.spec.task.spec.roles[0]!,
      {
        id: 'reviewer',
        adapter: 'delegated',
        provider: 'antigravity',
        model: 'gemini-4-argon',
        thinking: 'low',
        tools: ['read'],
      },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'roles'], [
      { roleId: 'builder', profileRef: 'builder' },
      { roleId: 'reviewer', profileRef: 'reviewer-delegated' },
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'build', kind: 'agent', uses: 'author.step', roleId: 'builder', dependsOn: [] },
      { id: 'review', kind: 'agent', uses: 'review.step', roleId: 'reviewer', dependsOn: ['build'] },
      { id: 'verify', kind: 'check', uses: 'tests', roleId: null, dependsOn: ['review'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'build', handlerRef: 'author.step' },
      { stepId: 'review', handlerRef: 'review.step' },
      { stepId: 'verify', handlerRef: 'tests' },
    ]);
  } else {
    setFixture(f.registry, ['spec', 'runtimeProfiles'], []);
    const credBindings = options?.gateUrl !== undefined
      ? [{ id: 'gate-signer', consumer: 'gate', destinationRef: 'gate-service', environmentNames: ['GATE_SECRET'], template: '${GATE_SECRET}' }]
      : [];
    const envBindings = options?.gateUrl !== undefined
      ? [{ name: 'GATE_SECRET', classification: 'credential', paths: ['/spec/credentials/0/template'] }]
      : [];
    setFixture(f.registry, ['spec', 'credentialBindings'], credBindings);
    setFixture(f.registry, ['spec', 'environmentBindings'], envBindings);
    setFixture(
      f.config,
      ['spec', 'credentials'],
      options?.gateUrl !== undefined ? [{ ref: 'gate-signer', template: '${GATE_SECRET}' }] : [],
    );

    const roleProfiles: Record<string, unknown>[] = [
      {
        id: 'author',
        adapter: 'delegated',
        runtimeRef: null,
        providerCredentialRef: null,
        selection: { provider: 'antigravity', model: 'gemini-4-carbon', thinking: 'high' },
        tools: ['read', 'write', 'edit', 'bash', 'delete'],
        mcp: null,
      },
    ];
    const taskRoles: Record<string, unknown>[] = [
      {
        id: 'author',
        adapter: 'delegated',
        provider: 'antigravity',
        model: 'gemini-4-carbon',
        thinking: 'high',
        tools: ['read', 'write', 'edit'],
      },
    ];
    const profileRoles: Record<string, unknown>[] = [{ roleId: 'author', profileRef: 'author' }];
    const steps: Record<string, unknown>[] = [
      { id: 'author', kind: 'agent', uses: 'author.step', roleId: 'author', dependsOn: [] },
    ];
    const profileSteps: Record<string, unknown>[] = [{ stepId: 'author', handlerRef: 'author.step' }];

    let checkDependsOn = ['author'];
    if (options?.multiRole) {
      roleProfiles.push({
        id: 'review',
        adapter: 'delegated',
        runtimeRef: null,
        providerCredentialRef: null,
        selection: { provider: 'antigravity', model: 'gemini-4-argon', thinking: 'low' },
        tools: ['read'],
        mcp: null,
      });
      taskRoles.push({
        id: 'review',
        adapter: 'delegated',
        provider: 'antigravity',
        model: 'gemini-4-argon',
        thinking: 'low',
        tools: ['read'],
      });
      profileRoles.push({ roleId: 'review', profileRef: 'review' });
      steps.push({ id: 'review', kind: 'agent', uses: 'review.step', roleId: 'review', dependsOn: ['author'] });
      profileSteps.push({ stepId: 'review', handlerRef: 'review.step' });
      checkDependsOn = ['review'];
    }

    if (options?.noChangeCheck) {
      steps.push({ id: 'verify-unchanged', kind: 'check', uses: 'no-change-explicit', roleId: null, dependsOn: checkDependsOn });
      profileSteps.push({ stepId: 'verify-unchanged', handlerRef: 'no-change-explicit' });
      setFixture(f.config, ['spec', 'task', 'spec', 'acceptance'], {
        required: ['unchanged'],
        checks: [{ id: 'unchanged', allowedEvidenceLevels: ['local_execution'] }],
      });
    } else if (options?.gateUrl !== undefined) {
      steps.push({ id: 'verify', kind: 'check', uses: 'tests', roleId: null, dependsOn: checkDependsOn });
      steps.push({ id: 'gate', kind: 'check', uses: 'gate.check', roleId: null, dependsOn: ['verify'] });
      profileSteps.push({ stepId: 'verify', handlerRef: 'tests' });
      profileSteps.push({ stepId: 'gate', handlerRef: 'gate.check' });
      setFixture(f.config, ['spec', 'task', 'spec', 'acceptance'], {
        required: ['tests', 'gate-check'],
        checks: [
          { id: 'tests', allowedEvidenceLevels: ['local_execution'] },
          { id: 'gate-check', allowedEvidenceLevels: ['external_service'] },
        ],
      });
    } else {
      steps.push({ id: 'verify', kind: 'check', uses: 'tests', roleId: null, dependsOn: checkDependsOn });
      profileSteps.push({ stepId: 'verify', handlerRef: 'tests' });
      setFixture(f.config, ['spec', 'task', 'spec', 'acceptance'], {
        required: ['tests'],
        checks: [{ id: 'tests', allowedEvidenceLevels: ['local_execution'] }],
      });
    }

    setFixture(f.registry, ['spec', 'roleProfiles'], roleProfiles);
    setFixture(f.config, ['spec', 'task', 'spec', 'roles'], taskRoles);
    setFixture(f.config, ['spec', 'profiles', 'roles'], profileRoles);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], steps);
    setFixture(f.config, ['spec', 'profiles', 'steps'], profileSteps);
  }

  await f.save();
  const loaded = assertOk(await f.load(), 'load fixture');
  return { ...f, repository, runRoot, revision, loaded, gateSecret };
}

test('multi-role delegated step lifecycle (author gemini-4-carbon + read-only review gemini-4-argon) with implementation repair and downstream review reset', async () => {
  const f = await delegatedRepoFixture({ multiRole: true, maxImplementationRepairs: 1, maxAttempts: 4 });
  try {
    const runId = 'run-multi-role-repair';
    // 1. First stepNext yields author work order
    const first = assertStepYield(
      assertOk(await stepNext({ configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId }), 'stepNext 1'),
    );
    assert.equal(first.status, 'awaiting_role');
    assert.equal(first.roleId, 'author');
    assert.equal(first.stepId, 'author');
    assert.equal(first.purpose, 'task');
    assert.equal(first.repair, 'none');
    assert.equal(first.selection.model, 'gemini-4-carbon');
    assert.deepEqual(first.allowedTools, ['read', 'write', 'edit']);
    assert.deepEqual(first.contextFiles, []);

    // Check file permissions in candidateDir: writable file is 0o600, protected file is 0o400
    const writableStat = await lstat(join(first.candidateDir, 'packages', 'result.json'));
    const protectedStat = await lstat(join(first.candidateDir, 'docs', 'readme.md'));
    assert.equal(writableStat.mode & 0o777, 0o600);
    assert.equal(protectedStat.mode & 0o777, 0o400);

    // Leave packages/result.json as { ok: false } (or write { ok: false, attempt: 1 }) so json-artifact check fails and triggers implementation repair!
    await writeFile(join(first.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: false, attempt: 1 }), { mode: 0o600 });

    // Submit author attempt 1 -> yields review attempt 2!
    const second = assertStepYield(
      assertOk(await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: first.leaseToken, status: 'completed' }), 'stepSubmit 1'),
    );
    assert.equal(second.roleId, 'review');
    assert.equal(second.stepId, 'review');
    assert.equal(second.purpose, 'reviewer');
    assert.equal(second.repair, 'none');
    assert.deepEqual(second.selection, { provider: 'antigravity', model: 'gemini-4-argon', thinking: 'low' });
    assert.deepEqual(second.allowedTools, ['read']);

    // In read-only review step, all candidate files must be read-only (0o400)
    const reviewWritableStat = await lstat(join(second.candidateDir, 'packages', 'result.json'));
    assert.equal(reviewWritableStat.mode & 0o777, 0o400);

    // Submit review attempt 2 -> check 'tests' runs and fails -> triggers implementation repair on 'author' (attempt 3)!
    const third = assertStepYield(
      assertOk(await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: second.leaseToken, status: 'completed' }), 'stepSubmit 2'),
    );
    assert.equal(third.roleId, 'author');
    assert.equal(third.stepId, 'author');
    assert.equal(third.purpose, 'task');
    assert.equal(third.repair, 'implementation');
    assert.match(third.prompt, /Findings:/);

    // Fix packages/result.json in implementation repair
    await writeFile(join(third.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: true }), { mode: 0o600 });

    // Submit author repair attempt 3 -> downstream 'review' node was reset to 'pending', so it yields 'review' (attempt 4)!
    const fourth = assertStepYield(
      assertOk(await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: third.leaseToken, status: 'completed' }), 'stepSubmit 3'),
    );
    assert.equal(fourth.roleId, 'review');
    assert.equal(fourth.stepId, 'review');
    assert.equal(fourth.purpose, 'reviewer');
    assert.equal(fourth.repair, 'none');

    // Submit review attempt 4 -> check 'tests' and 'scope' pass -> settles 'completed'!
    const settled = assertOk(
      await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: fourth.leaseToken, status: 'completed' }),
      'stepSubmit 4',
    );
    assert.equal(settled.kind, 'result');
    if (settled.kind !== 'result') return;
    assert.equal(settled.result.spec.status, 'completed');

    // Verify target --repo working tree is completely untouched!
    const repoResult = JSON.parse(await readFile(join(f.repository, 'packages', 'result.json'), 'utf8')) as { ok: boolean };
    assert.equal(repoResult.ok, false);
    const gitStatus = execFileSync('/usr/bin/git', ['status', '--porcelain'], { cwd: f.repository, encoding: 'utf8' }).trim();
    assert.equal(gitStatus, '');

    // Verify workspaces/<runId> was cleaned up on settlement
    assert.equal(await lstat(join(f.runRoot, 'workspaces', runId)).then(() => true, () => false), false);
  } finally {
    await f.cleanup();
  }
});

test('protected-path scope.v1 violation in delegated author settles failed without mutating --repo', async () => {
  const f = await delegatedRepoFixture({ multiRole: false, maxImplementationRepairs: 1, maxAttempts: 2 });
  try {
    const runId = 'run-scope-violation';
    const first = assertStepYield(
      assertOk(await stepNext({ configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId }), 'stepNext'),
    );
    // Force-modify a protected file in candidateDir
    await chmod(join(first.candidateDir, 'docs', 'readme.md'), 0o600);
    await writeFile(join(first.candidateDir, 'docs', 'readme.md'), '# Tampered Protected Doc\n', { mode: 0o600 });
    await writeFile(join(first.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: true }), { mode: 0o600 });

    const settled = assertOk(
      await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: first.leaseToken, status: 'completed' }),
      'stepSubmit scope violation',
    );
    assert.equal(settled.kind, 'result');
    if (settled.kind === 'result') {
      assert.equal(settled.result.spec.status, 'failed');
    }
    const repoDoc = await readFile(join(f.repository, 'docs', 'readme.md'), 'utf8');
    assert.equal(repoDoc, '# Protected Doc\n');
  } finally {
    await f.cleanup();
  }
});

test('ControllerEvents.suspend() keeps controller-events.open unsealed across ticks, releases ControllerOwner, and seals on settlement', async () => {
  const f = await delegatedRepoFixture({ multiRole: false });
  try {
    const runId = 'run-events-suspend';
    const step1 = assertStepYield(
      assertOk(await stepNext({ configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId }), 'stepNext'),
    );
    const runDir = join(f.runRoot, runId);
    // While parked at awaiting_role:
    // 1. controller.owner.ndjson is unlinked (ControllerOwner lock released)
    assert.equal(await lstat(join(runDir, 'controller.owner.ndjson')).then(() => true, () => false), false);
    // 2. controller-events.open exists and is non-empty
    const openEventsStat = await lstat(join(runDir, 'artifacts', 'controller-events.open'));
    assert.equal(openEventsStat.isFile(), true);
    assert.ok(openEventsStat.size > 0);

    await writeFile(join(step1.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: true }), { mode: 0o600 });
    const settled = assertOk(
      await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: step1.leaseToken, status: 'completed' }),
      'stepSubmit',
    );
    assert.equal(settled.kind, 'result');
    if (settled.kind !== 'result') return;
    assert.equal(settled.result.spec.status, 'completed');
    // After settlement, controller-events.open is unlinked and sealed into events-*.bin
    assert.equal(await lstat(join(runDir, 'artifacts', 'controller-events.open')).then(() => true, () => false), false);
    assert.ok(settled.observations);
  } finally {
    await f.cleanup();
  }
});

test('single-use leaseToken security: duplicate stepNext refuses OWNER_BUSY, reissueLease rotates token without touching candidateDir, and stale/replayed token refuses AUTHORITY_REFUSED', async () => {
  const f = await delegatedRepoFixture({ multiRole: false });
  try {
    const runId = 'run-lease-security';
    const step1 = assertStepYield(
      assertOk(await stepNext({ configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId }), 'stepNext 1'),
    );

    // Edit candidateDir before reissuing lease
    await writeFile(join(step1.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: true }), { mode: 0o600 });

    // Duplicate stepNext without reissueLease refuses OWNER_BUSY
    const dup = await stepNext({ runRoot: f.runRoot, runId });
    assert.equal(dup.ok, false);
    if (!dup.ok) {
      assert.equal(dup.error.code, 'OWNER_BUSY');
      assert.equal(dup.error.phase, 'execution');
    }

    // stepNext with reissueLease: true rotates leaseToken and preserves candidateDir edits
    const reissued = assertStepYield(
      assertOk(await stepNext({ runRoot: f.runRoot, runId, reissueLease: true }), 'stepNext reissueLease'),
    );
    assert.notEqual(reissued.leaseToken, step1.leaseToken);
    assert.equal(reissued.attemptId, step1.attemptId);
    const preserved = JSON.parse(await readFile(join(reissued.candidateDir, 'packages', 'result.json'), 'utf8')) as { ok: boolean };
    assert.equal(preserved.ok, true);

    // Submitting with old (stale) leaseToken refuses AUTHORITY_REFUSED at /leaseToken
    const staleRes = await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: step1.leaseToken, status: 'completed' });
    assert.equal(staleRes.ok, false);
    if (!staleRes.ok) {
      assert.equal(staleRes.error.code, 'AUTHORITY_REFUSED');
      assert.equal(staleRes.error.path, '/leaseToken');
    }

    // Submitting with wrong token refuses AUTHORITY_REFUSED
    const wrongRes = await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: '0'.repeat(64), status: 'completed' });
    assert.equal(wrongRes.ok, false);
    if (!wrongRes.ok) {
      assert.equal(wrongRes.error.code, 'AUTHORITY_REFUSED');
      assert.equal(wrongRes.error.path, '/leaseToken');
    }

    // Submitting with the rotated leaseToken succeeds!
    const settled = assertOk(
      await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: reissued.leaseToken, status: 'completed' }),
      'stepSubmit valid lease',
    );
    assert.equal(settled.kind, 'result');

    // Replaying the consumed leaseToken refuses AUTHORITY_REFUSED
    const replayRes = await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: reissued.leaseToken, status: 'completed' });
    assert.equal(replayRes.ok, false);
    if (!replayRes.ok) {
      assert.equal(replayRes.error.code, 'AUTHORITY_REFUSED');
    }
  } finally {
    await f.cleanup();
  }
});

test('pre-commit candidateDir hygiene (symlinks, hardlinks, and read-only/format mutations) refuses ARTIFACT_INVALID without burning the lease', async () => {
  const f = await delegatedRepoFixture({ multiRole: true, maxFormatRepairs: 1, maxAttempts: 4 });
  try {
    const runId = 'run-hygiene';
    const step1 = assertStepYield(
      assertOk(await stepNext({ configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId }), 'stepNext 1'),
    );

    // 1. Symlink inside candidateDir refuses ARTIFACT_INVALID and preserves leaseToken
    const symlinkPath = join(step1.candidateDir, 'packages', 'bad-link.txt');
    await symlink(join(step1.candidateDir, 'packages', 'result.json'), symlinkPath);
    const symSubmit = await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: step1.leaseToken, status: 'completed' });
    assert.equal(symSubmit.ok, false);
    if (!symSubmit.ok) assert.equal(symSubmit.error.code, 'ARTIFACT_INVALID');
    await rm(symlinkPath);

    // 2. Hardlink (nlink > 1) inside candidateDir refuses ARTIFACT_INVALID and preserves leaseToken
    const hardlinkPath = join(step1.candidateDir, 'packages', 'hard-link.json');
    await link(join(step1.candidateDir, 'packages', 'result.json'), hardlinkPath);
    const hardSubmit = await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: step1.leaseToken, status: 'completed' });
    assert.equal(hardSubmit.ok, false);
    if (!hardSubmit.ok) assert.equal(hardSubmit.error.code, 'ARTIFACT_INVALID');
    await rm(hardlinkPath);

    // 3. After removing symlink & hardlink, the SAME leaseToken succeeds!
    // Provide an invalid submission file to trigger format repair on author!
    await writeFile(join(step1.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: true }), { mode: 0o600 });
    const badSubmissionFile = join(f.root, 'bad-submission.json');
    await writeFile(badSubmissionFile, 'not valid json {{{', { mode: 0o600 });

    const formatStep = assertStepYield(
      assertOk(
        await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: step1.leaseToken, submissionFile: badSubmissionFile }),
        'stepSubmit triggering format repair',
      ),
    );
    assert.equal(formatStep.roleId, 'author');
    assert.equal(formatStep.repair, 'format');
    assert.deepEqual(formatStep.allowedTools, []);

    // 4. Mutating candidateDir during repair === 'format' refuses ARTIFACT_INVALID without burning formatStep.leaseToken!
    await chmod(join(formatStep.candidateDir, 'packages', 'result.json'), 0o600);
    await writeFile(join(formatStep.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: true, mutatedInFormat: true }), { mode: 0o600 });
    const mutatedFormatSubmit = await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: formatStep.leaseToken, status: 'completed' });
    assert.equal(mutatedFormatSubmit.ok, false);
    if (!mutatedFormatSubmit.ok) assert.equal(mutatedFormatSubmit.error.code, 'ARTIFACT_INVALID');

    // Revert the illegal mutation and submit valid format repair with the SAME formatStep.leaseToken!
    await writeFile(join(formatStep.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: true }), { mode: 0o400 });
    const reviewStep = assertStepYield(
      assertOk(await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: formatStep.leaseToken, status: 'completed' }), 'stepSubmit format repair'),
    );
    assert.equal(reviewStep.roleId, 'review');
    assert.deepEqual(reviewStep.allowedTools, ['read']);

    // 5. Mutating candidateDir during read-only review step refuses ARTIFACT_INVALID without burning reviewStep.leaseToken!
    await chmod(join(reviewStep.candidateDir, 'packages', 'result.json'), 0o600);
    await writeFile(join(reviewStep.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: false }), { mode: 0o600 });
    const mutatedReviewSubmit = await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: reviewStep.leaseToken, status: 'completed' });
    assert.equal(mutatedReviewSubmit.ok, false);
    if (!mutatedReviewSubmit.ok) assert.equal(mutatedReviewSubmit.error.code, 'ARTIFACT_INVALID');

    // Revert the mutation and submit review with the SAME reviewStep.leaseToken -> settles completed!
    await writeFile(join(reviewStep.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: true }), { mode: 0o400 });
    const settled = assertOk(
      await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: reviewStep.leaseToken, status: 'completed' }),
      'stepSubmit review',
    );
    assert.equal(settled.kind, 'result');
    if (settled.kind === 'result') assert.equal(settled.result.spec.status, 'completed');
  } finally {
    await f.cleanup();
  }
});

test('roleModelOverrides persist in run.json so stepSubmit and inspectRun reconstruct planDigest and decode candidate.files.json without re-passing overrides', async () => {
  const f = await delegatedRepoFixture({ multiRole: false });
  try {
    const loadedWithOverrides = assertOk(
      await loadConfiguration(
        {
          ...f.input,
          roleModelOverrides: [{ roleId: 'author', provider: 'pi-oauth', model: 'gpt-6.1-terra', thinking: 'high' }],
        },
        { environment: name => f.environment[name] },
      ),
      'loadConfiguration with roleModelOverrides',
    );

    const runId = 'run-persisted-overrides';
    const step1 = assertStepYield(
      assertOk(await stepNext({ configuration: loadedWithOverrides, repository: f.repository, runRoot: f.runRoot, runId }), 'stepNext'),
    );
    assert.deepEqual(step1.selection, { provider: 'pi-oauth', model: 'gpt-6.1-terra', thinking: 'high' });

    const descriptorRaw = JSON.parse(await readFile(join(f.runRoot, runId, 'run.json'), 'utf8')) as {
      configuration: { roleModelOverrides?: unknown };
    };
    assert.deepEqual(descriptorRaw.configuration.roleModelOverrides, [
      { roleId: 'author', provider: 'pi-oauth', model: 'gpt-6.1-terra', thinking: 'high' },
    ]);

    await writeFile(join(step1.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: true, overridden: true }), { mode: 0o600 });

    // stepSubmit does NOT take configuration — it reloads from run.json including persisted roleModelOverrides!
    const settled = assertOk(
      await stepSubmit({
        runRoot: f.runRoot,
        runId,
        leaseToken: step1.leaseToken,
        status: 'completed',
        environment: name => f.environment[name],
      }),
      'stepSubmit without overrides',
    );
    assert.equal(settled.kind, 'result');
    if (settled.kind !== 'result') return;
    assert.equal(settled.result.spec.status, 'completed');

    // inspectRun decodes candidate.files.json from delegated-capture.v1!
    const exportDir = join(f.root, 'inspect-out');
    const inspected = assertOk(await inspectRun({ runRoot: f.runRoot, runId, output: exportDir }), 'inspectRun');
    assert.equal(inspected.status.status, 'completed');
    const candidateFilesJson = JSON.parse(await readFile(join(exportDir, 'candidate.files.json'), 'utf8')) as {
      files: { name: string; body: string }[];
    };
    const resultEntry = candidateFilesJson.files.find(entry => entry.name === 'packages/result.json');
    assert.ok(resultEntry);
    assert.deepEqual(JSON.parse(Buffer.from(resultEntry.body, 'base64').toString('utf8')), { ok: true, overridden: true });
  } finally {
    await f.cleanup();
  }
});

test('zero-request delegated budget enforcement: maxModelCalls enforced across delegated attempts, unresolvedRequests === 0, and zero reported tokens', async () => {
  // 2 roles in DAG, but maxModelCalls = 1 -> second role hits BUDGET_EXHAUSTED and settles 'exhausted'!
  const f = await delegatedRepoFixture({ multiRole: true, maxModelCalls: 1, maxImplementationRepairs: 0, maxFormatRepairs: 0 });
  try {
    const runId = 'run-delegated-budget';
    const step1 = assertStepYield(
      assertOk(await stepNext({ configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId }), 'stepNext 1'),
    );
    await writeFile(join(step1.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: true }), { mode: 0o600 });

    // Submitting attempt 1 consumes 1 delegated model call; advancing to 'review' sees 1 >= maxModelCalls (1) and settles 'exhausted'!
    const settled = assertOk(
      await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: step1.leaseToken, status: 'completed' }),
      'stepSubmit budget exhausted',
    );
    assert.equal(settled.kind, 'result');
    if (settled.kind !== 'result') return;
    assert.equal(settled.result.spec.status, 'exhausted');

    // Verify zero requests in LocalRunStore, unresolvedRequests === 0, and zero 'reported' tokens in result/observations
    const descriptor = JSON.parse(await readFile(join(f.runRoot, runId, 'run.json'), 'utf8'));
    const store = stateValue(reopenLocalRun(descriptor.identity));
    try {
      const view = stateValue(store.inspect());
      assert.equal(view.counts.requests, 0);
      assert.equal(view.counts.unresolvedRequests, 0);
      assert.equal(view.ledger.reportedTokens.decimal, '0');
    } finally {
      stateValue(store.close());
    }
    assert.deepEqual(settled.result.spec.usage.requests, []);
    assert.equal(settled.result.spec.usage.inputTokens.completeness, 'complete');
    assert.equal(settled.result.spec.usage.inputTokens.knownSubtotal, 0);
  } finally {
    await f.cleanup();
  }
});

test('mode: no-change delegated submission passes no-change.v1 acceptance when candidate is unmodified', async () => {
  const f = await delegatedRepoFixture({ multiRole: false, noChangeCheck: true });
  try {
    const runId = 'run-no-change';
    const step1 = assertStepYield(
      assertOk(
        await stepNext({ configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId, mode: 'no-change' }),
        'stepNext no-change',
      ),
    );
    // Do not modify any files in step1.candidateDir; submit with default status (which defaults to no_change in no-change mode)
    const settled = assertOk(
      await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: step1.leaseToken }),
      'stepSubmit no-change',
    );
    assert.equal(settled.kind, 'result');
    if (settled.kind !== 'result') return;
    assert.equal(settled.result.spec.status, 'no_change');
    assert.equal(settled.result.spec.noChange?.checkId, 'unchanged');
  } finally {
    await f.cleanup();
  }
});

test('mixed adapter: pi + adapter: delegated two-role pipeline hands off cleanly and decodes candidateFiles in inspectRun', async () => {
  const f = await delegatedRepoFixture({ mixedPiFirst: true });
  try {
    const runId = 'run-mixed-pi-delegated';
    let piOpened = 0;
    const openAdapter = async (host: PiHostV2, input: PiOpenInputV2) => {
      piOpened++;
      let capturedWorkspace: import('@loopwright/core').ArtifactRef | null = null;
      let capturedSession: import('@loopwright/core').ArtifactRef | null = null;
      let capturedManifest: import('@loopwright/core').ArtifactManifest | null = null;
      const adapter: PiAdapterV2 = {
        capabilities: () => { throw new Error('unused'); },
        events: () => ({ async *[Symbol.asyncIterator]() { yield* []; } }),
        cancel: async () => ({
          ok: true,
          value: {
            status: 'cancelled',
            requestIds: [],
            operationIds: [],
            providerTermination: 'none',
            usage: 'none',
            localCleanup: 'complete',
            error: null,
            cleanupError: null,
          },
        }),
        compact: async () => { throw new Error('unused'); },
        execute: async cmd => {
          stateValue(
            host.store.reserveRequest(host.authority, {
              requestId: 'pi-req-1',
              roleId: input.roleId,
              nodeId: input.stepId,
              attemptId: cmd.commandId,
              purpose: cmd.purpose,
              repair: cmd.repair,
              transportRetryOf: null,
              requestDigest: hash('pi-req-1'),
              inputUpperBound: 80,
              outputUpperBound: 20,
              totalUpperBound: 100,
              capability: {
                adapterId: 'pi',
                adapterVersion: '0.0.0',
                provider: input.policy.selection.provider,
                model: input.policy.selection.model,
                kind: 'soft_only',
                coversAllBillableTokens: false,
                enforcesOutputBound: false,
              },
              operationId: 'pi-op-1',
              targetIdentity: 'fixture:pi-step',
            }),
          );
          stateValue(host.store.authorizeRequestDispatch(host.authority, 'pi-req-1'));
          const op = stateValue(host.store.getOperation('pi-op-1'));
          const view = stateValue(host.store.inspect());
          const usageRef = {
            name: 'pi-usage.json',
            byteLength: 2,
            digest: hash(Buffer.from('{}')),
          };
          await writeFile(join(host.artifactsDirectory, usageRef.name), '{}', { mode: 0o600 });
          stateValue(
            host.store.observeRequest(host.authority, 'pi-req-1', {
              receiptId: 'pi-rec-1',
              termination: 'confirmed',
              outcome: 'succeeded',
              evidence: {
                evidenceId: 'pi-ev-1',
                producerId: 'unit-pi',
                method: 'synthetic',
                artifact: usageRef,
                subject: {
                  storeId: view.storeId,
                  runId: view.runId,
                  lockHash: view.lockHash,
                  operationId: 'pi-op-1',
                  requestId: 'pi-req-1',
                  intentDigest: op.intentDigest,
                  dispatchGeneration: op.dispatch!.generation,
                  dispatchId: op.dispatch!.dispatchId,
                },
              },
              usage: {
                requestId: 'pi-req-1',
                inputTokens: { provenance: 'reported', value: 10 },
                outputTokens: { provenance: 'reported', value: 5 },
                costMicrousd: { provenance: 'unknown' },
              },
            }),
          );

          // Build updated candidate manifest where packages/result.json has { ok: true }
          const updatedBytes = Buffer.from(JSON.stringify({ ok: true }));
          const updatedEntries = input.candidate.manifest.spec.entries.map(entry =>
            entry.name === 'packages/result.json'
              ? { name: 'packages/result.json', byteLength: updatedBytes.byteLength, digest: hash(updatedBytes) }
              : entry,
          );
          capturedManifest = {
            ...input.candidate.manifest,
            spec: { ...input.candidate.manifest.spec, entries: updatedEntries },
          };
          const subject = bindSubject(input.lock, capturedManifest);
          assert.ok(subject.ok);
          if (!subject.ok) throw new Error('subject');

          const checkpointId = phaseCheckpointId(input.lock.spec.runId, 'role.1.native');
          const current = stateValue(host.store.inspect());
          const sourceDigest = hash('loopwright.dev/pi-policy/v2\0' + canonical(input.policy));
          const nativePolicy = { ...input.policy, version: 1, policyId: 'v2.' + BigInt('0x' + sourceDigest.hex).toString(36) };
          const binding = {
            version: 1,
            checkpointId,
            storeId: current.storeId,
            runId: current.runId,
            lockHash: current.lockHash,
            sessionId: input.sessionId,
            roleId: input.roleId,
            stepId: input.stepId,
            runtime: input.policy.runtime,
            policyDigest: hash(canonical(nativePolicy)),
            resourcesDigest: hash(canonical(input.policy.resources)),
            candidateDigest: subject.value.candidateDigest,
            clockBasis: current.clock.basis,
            accountingDigest: hash(canonical({ ledger: current.ledger, requests: current.counts.requests, operations: current.counts.operations })),
            sequence: 1,
          };
          const line = (v: unknown) => JSON.stringify(v) + '\n';
          const fileChunks: string[] = [line({ type: 'workspace_snapshot', version: 1, binding, manifest: capturedManifest })];
          for (const ref of capturedManifest.spec.entries) {
            const bytes =
              ref.name === 'packages/result.json'
                ? updatedBytes
                : Buffer.from(input.candidate.artifacts.find(a => a.name === ref.name)!.bytes);
            fileChunks.push(line({ type: 'file', ref }));
            fileChunks.push(line({ type: 'chunk', index: 0, data: bytes.toString('base64') }));
            fileChunks.push(line({ type: 'file_end', byteLength: bytes.byteLength, digest: hash(bytes).hex }));
          }
          fileChunks.push(line({ type: 'end', files: capturedManifest.spec.entries.length }));
          const wsBytes = Buffer.from(fileChunks.join(''));
          const wsName = 'unit-pi-ws.ndjson';
          await writeFile(join(host.artifactsDirectory, wsName), wsBytes, { mode: 0o600 });
          capturedWorkspace = { name: wsName, byteLength: wsBytes.byteLength, digest: hash(wsBytes) };

          const timestamp = '2026-11-14T00:00:00.000Z';
          const submissionText = JSON.stringify({
            version: 1,
            status: 'completed',
            checks: [{ checkId: 'tests', status: 'passed', evidenceId: null, reason: null }],
            reason: null,
          });
          const sessBytes = Buffer.from(
            line({ type: 'session_snapshot', version: 1, binding }) +
              [
                { type: 'session', version: 3, id: 'unit_pi', cwd: '/workspace/candidate', timestamp },
                { type: 'message', id: 'u1', parentId: null, timestamp, message: { role: 'user', content: cmd.text } },
                {
                  type: 'message',
                  id: 'a1',
                  parentId: 'u1',
                  timestamp,
                  message: {
                    role: 'assistant',
                    ...input.policy.selection,
                    content: [{ type: 'text', text: submissionText }],
                    stopReason: 'stop',
                  },
                },
              ]
                .map(line)
                .join(''),
          );
          const sessName = 'unit-pi-sess.ndjson';
          await writeFile(join(host.artifactsDirectory, sessName), sessBytes, { mode: 0o600 });
          capturedSession = { name: sessName, byteLength: sessBytes.byteLength, digest: hash(sessBytes) };

          stateValue(
            host.store.writeCheckpoint(host.authority, {
              checkpointId,
              expectedRevision: current.revision,
              candidateManifest: capturedManifest,
              workspace: capturedWorkspace,
              privateSession: capturedSession,
              additionalArtifacts: [],
            }),
          );

          return {
            ok: true,
            value: {
              status: 'execution_settled',
              requestIds: ['pi-req-1'],
              operationIds: ['pi-op-1'],
              providerTermination: 'confirmed',
              usage: 'complete',
              localCleanup: 'complete',
              error: null,
              cleanupError: null,
            },
          };
        },
        capture: async ({ checkpointId }) => ({
          ok: true,
          value: {
            checkpointId,
            candidate: capturedManifest!,
            workspace: capturedWorkspace!,
            session: capturedSession!,
          },
        }),
        close: async () => ({ ok: true, value: { closed: true } }),
      };
      return { ok: true as const, value: adapter };
    };

    // stepNext runs the 'pi' builder role automatically via openAdapter, then yields the 'delegated' reviewer role!
    const reviewYield = assertStepYield(
      assertOk(
        await stepNext({ configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId }, { openAdapter }),
        'stepNext mixed',
      ),
    );
    assert.equal(piOpened, 1);
    assert.equal(reviewYield.roleId, 'reviewer');
    assert.equal(reviewYield.purpose, 'reviewer');
    // Verify the pi role's changes are materialized in the delegated reviewer's candidateDir!
    const materializedByPi = JSON.parse(await readFile(join(reviewYield.candidateDir, 'packages', 'result.json'), 'utf8')) as {
      ok: boolean;
    };
    assert.equal(materializedByPi.ok, true);

    // Submit the delegated reviewer step -> settles completed!
    const settled = assertOk(
      await stepSubmit({
        runRoot: f.runRoot,
        runId,
        leaseToken: reviewYield.leaseToken,
        status: 'completed',
        environment: name => f.environment[name],
      }),
      'stepSubmit mixed',
    );
    assert.equal(settled.kind, 'result');
    if (settled.kind !== 'result') return;
    assert.equal(settled.result.spec.status, 'completed');

    // Verify inspectRun works on mixed run
    const exportDir = join(f.root, 'mixed-inspect');
    const inspected = assertOk(await inspectRun({ runRoot: f.runRoot, runId, output: exportDir }), 'inspectRun mixed');
    assert.equal(inspected.status.status, 'completed');
  } finally {
    await f.cleanup();
  }
});

test('loopback gateUrlOverrides routes gate.v1 to dynamic 127.0.0.1 port without changing registrySha256 and rejects non-loopback URLs', async () => {
  // Registry has static canonical URL http://127.0.0.1:1/gate, while live server listens on an ephemeral port
  const f = await delegatedRepoFixture({ multiRole: false, gateUrl: 'http://127.0.0.1:1/gate' });
  let hits = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      hits++;
      const sig = req.headers['x-loopwright-signature'];
      if (typeof sig !== 'string' || !verifySignedPayload(f.gateSecret, body, sig)) {
        res.writeHead(403).end();
        return;
      }
      const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      const verdict = {
        version: 1,
        kind: 'gate_verdict',
        storeId: parsed.storeId,
        runId: parsed.runId,
        lockHash: parsed.lockHash,
        operationId: parsed.operationId,
        dispatchId: parsed.dispatchId,
        dispatchGeneration: parsed.dispatchGeneration,
        gateId: parsed.gateId,
        checkId: parsed.checkId,
        candidateDigest: parsed.candidateDigest,
        status: 'approved',
        reason: null,
        expiresAtMs: String(Date.now() + 600_000),
      };
      const bytes = Buffer.from(JSON.stringify(verdict));
      res.writeHead(200, {
        'content-type': 'application/json',
        connection: 'close',
        'x-loopwright-signature': signPayload(f.gateSecret, bytes),
      });
      res.end(bytes);
    })();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const livePort = (server.address() as { port: number }).port;
  const liveUrl = `http://127.0.0.1:${livePort}/gate`;

  try {
    const runId = 'run-gate-override';
    const step1 = assertStepYield(
      assertOk(await stepNext({ configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId }), 'stepNext'),
    );
    await writeFile(join(step1.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: true }), { mode: 0o600 });

    // Non-loopback gateUrlOverrides is rejected with CONFIG_SCHEMA at /gateUrlOverrides without burning the lease!
    const badOverride = await stepSubmit(
      { runRoot: f.runRoot, runId, leaseToken: step1.leaseToken, status: 'completed', environment: name => f.environment[name] },
      { gateUrlOverrides: { 'local-cmd': 'https://example.com:8443/gate' } },
    );
    assert.equal(badOverride.ok, false);
    if (!badOverride.ok) {
      assert.equal(badOverride.error.code, 'CONFIG_SCHEMA');
      assert.equal(badOverride.error.path, '/gateUrlOverrides');
    }

    // Unknown endpoint ID in gateUrlOverrides is rejected with CONFIG_SCHEMA at /gateUrlOverrides without burning the lease or hitting the server!
    const unknownEndpointOverride = await stepSubmit(
      { runRoot: f.runRoot, runId, leaseToken: step1.leaseToken, status: 'completed', environment: name => f.environment[name] },
      { gateUrlOverrides: { 'nonexistent-endpoint': liveUrl } },
    );
    assert.equal(unknownEndpointOverride.ok, false);
    if (!unknownEndpointOverride.ok) {
      assert.equal(unknownEndpointOverride.error.code, 'CONFIG_SCHEMA');
      assert.equal(unknownEndpointOverride.error.path, '/gateUrlOverrides');
    }
    assert.equal(hits, 0);

    // Canonical loopback override routes to liveUrl and settles 'completed'!
    const settled = assertOk(
      await stepSubmit(
        { runRoot: f.runRoot, runId, leaseToken: step1.leaseToken, status: 'completed', environment: name => f.environment[name] },
        { gateUrlOverrides: { 'local-cmd': liveUrl } },
      ),
      'stepSubmit with loopback gateUrlOverrides',
    );
    assert.equal(settled.kind, 'result');
    if (settled.kind !== 'result') return;
    assert.equal(settled.result.spec.status, 'completed');
    assert.equal(hits, 1);

    // Overriding an https:// GateEndpoint to loopback HTTP fails closed with CONFIG_SCHEMA at /gateUrlOverrides and never dispatches fetch
    const fHttps = await delegatedRepoFixture({ multiRole: false, gateUrl: 'https://gate.example.com:8443/gate' });
    try {
      const httpsNext = await stepNext(
        { configuration: fHttps.loaded, repository: fHttps.repository, runRoot: fHttps.runRoot, runId: 'run-https-override' },
        { gateUrlOverrides: { 'local-cmd': liveUrl } },
      );
      assert.equal(httpsNext.ok, false);
      if (!httpsNext.ok) {
        assert.equal(httpsNext.error.code, 'CONFIG_SCHEMA');
        assert.equal(httpsNext.error.path, '/gateUrlOverrides');
      }
      assert.equal(hits, 1);
    } finally {
      await fHttps.cleanup();
    }

    // Overriding a loopback http://127.0.0.1 GateEndpoint that has authCredentialRef !== null fails closed with CONFIG_SCHEMA at /gateUrlOverrides and never leaks the Bearer token
    const fAuthLoopback = await delegatedRepoFixture({ multiRole: false, gateUrl: 'http://127.0.0.1:1/gate' });
    try {
      fAuthLoopback.environment.GATE_AUTH_TOKEN = 'SECRET_BEARER_TOKEN_DO_NOT_LEAK_998877';
      setFixture(fAuthLoopback.registry, ['spec', 'gateEndpoints', 0, 'authCredentialRef'], 'gate-auth');
      setFixture(fAuthLoopback.registry, ['spec', 'credentialBindings'], [
        ...fAuthLoopback.registry.spec.credentialBindings,
        { id: 'gate-auth', consumer: 'gate', destinationRef: 'gate-service', environmentNames: ['GATE_AUTH_TOKEN'], template: '${GATE_AUTH_TOKEN}' },
      ]);
      setFixture(fAuthLoopback.registry, ['spec', 'environmentBindings'], [
        ...fAuthLoopback.registry.spec.environmentBindings,
        { name: 'GATE_AUTH_TOKEN', classification: 'credential', paths: ['/spec/credentials/1/template'] },
      ]);
      setFixture(fAuthLoopback.config, ['spec', 'credentials'], [
        ...fAuthLoopback.config.spec.credentials,
        { ref: 'gate-auth', template: '${GATE_AUTH_TOKEN}' },
      ]);
      await fAuthLoopback.save();
      const loadedAuthLoopback = assertOk(await fAuthLoopback.load(), 'load auth loopback fixture');

      const authStart = assertStepYield(
        assertOk(
          await stepNext({
            configuration: loadedAuthLoopback,
            repository: fAuthLoopback.repository,
            runRoot: fAuthLoopback.runRoot,
            runId: 'run-auth-loopback',
            environment: name => fAuthLoopback.environment[name],
          }),
          'stepNext auth loopback without override',
        ),
      );
      const authSubmit = await stepSubmit(
        {
          runRoot: fAuthLoopback.runRoot,
          runId: 'run-auth-loopback',
          leaseToken: authStart.leaseToken,
          status: 'completed',
          environment: name => fAuthLoopback.environment[name],
        },
        { gateUrlOverrides: { 'local-cmd': liveUrl } },
      );
      assert.equal(authSubmit.ok, false);
      if (!authSubmit.ok) {
        assert.equal(authSubmit.error.code, 'CONFIG_SCHEMA');
        assert.equal(authSubmit.error.path, '/gateUrlOverrides');
      }
      assert.equal(hits, 1);
    } finally {
      await fAuthLoopback.cleanup();
    }
  } finally {
    await new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    await f.cleanup();
  }
});

test('expired wallTimeMs while parked settles status: expired via drain, stepCancel settles cancelled, and runCycle/resumeCycle refuse delegated roles with CAPABILITY_UNSUPPORTED', async () => {
  const f = await delegatedRepoFixture({ multiRole: false });
  try {
    // 1. Unattended runCycle refuses active delegated role with CAPABILITY_UNSUPPORTED at /spec/profiles/roles in phase admission (before creating <runDir>!)
    const unattendedRunId = 'run-unattended-refused';
    const runRes = await runCycleWithPorts({
      configuration: f.loaded,
      repository: f.repository,
      runRoot: f.runRoot,
      runId: unattendedRunId,
    });
    assert.equal(runRes.ok, false);
    if (!runRes.ok) {
      assert.equal(runRes.error.code, 'CAPABILITY_UNSUPPORTED');
      assert.equal(runRes.error.phase, 'admission');
      assert.equal(runRes.error.path, '/spec/profiles/roles');
    }
    assert.equal(await lstat(join(f.runRoot, unattendedRunId)).then(() => true, () => false), false);

    // 2. Start a delegated run via stepNext, then verify unattended resumeCycle refuses CAPABILITY_UNSUPPORTED at /spec/profiles/roles in phase recovery
    const resumeRefusedRunId = 'run-resume-refused';
    const parked = assertStepYield(
      assertOk(await stepNext({ configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId: resumeRefusedRunId }), 'stepNext parked'),
    );
    const resumeRes = await resumeCycleWithPorts({
      configuration: f.loaded,
      repository: f.repository,
      runRoot: f.runRoot,
      runId: resumeRefusedRunId,
    });
    assert.equal(resumeRes.ok, false);
    if (!resumeRes.ok) {
      assert.equal(resumeRes.error.code, 'CAPABILITY_UNSUPPORTED');
      assert.equal(resumeRes.error.phase, 'recovery');
      assert.equal(resumeRes.error.path, '/spec/profiles/roles');
    }

    // 3. stepCancel cleans up workspace & lease and settles status: 'cancelled'
    assert.equal(await lstat(parked.candidateDir).then(() => true, () => false), true);
    const cancelled = assertOk(
      await stepCancel({ runRoot: f.runRoot, runId: resumeRefusedRunId, environment: name => f.environment[name] }),
      'stepCancel',
    );
    assert.equal(cancelled.kind, 'result');
    if (cancelled.kind === 'result') {
      assert.equal(cancelled.result.spec.status, 'cancelled');
    }
    assert.equal(await lstat(join(f.runRoot, 'workspaces', resumeRefusedRunId)).then(() => true, () => false), false);
    assert.equal(await lstat(join(f.runRoot, resumeRefusedRunId, 'step-lease.json')).then(() => true, () => false), false);

    // 4. Expired wallTimeMs (cutoff <= sampledNow) settles status: 'expired' and cleans up workspace
    const fExpired = await delegatedRepoFixture({ multiRole: false, wallTimeMs: 120_001 });
    try {
      const expiredRunId = 'run-expired';
      // With wallTimeMs = 120001 and drainReserveMs = 120000, cutoff is 1ms!
      await new Promise(resolve => setTimeout(resolve, 15));
      const tick = assertOk(
        await stepNext({ configuration: fExpired.loaded, repository: fExpired.repository, runRoot: fExpired.runRoot, runId: expiredRunId }),
        'stepNext expired',
      );
      if (tick.kind === 'step') {
        await new Promise(resolve => setTimeout(resolve, 15));
        const sub = assertOk(
          await stepSubmit({ runRoot: fExpired.runRoot, runId: expiredRunId, leaseToken: tick.leaseToken }),
          'stepSubmit expired',
        );
        assert.equal(sub.kind, 'result');
        if (sub.kind === 'result') assert.equal(sub.result.spec.status, 'expired');
      } else {
        assert.equal(tick.kind, 'result');
        if (tick.kind === 'result') assert.equal(tick.result.spec.status, 'expired');
      }
      assert.equal(await lstat(join(fExpired.runRoot, 'workspaces', expiredRunId)).then(() => true, () => false), false);
    } finally {
      await fExpired.cleanup();
    }
  } finally {
    await f.cleanup();
  }
});

test('terminal re-entry on stepNext/stepCancel returns retained RunResult without leaking ControllerOwner, ControllerEvents.#initialize releases activity hold on error, and publication_pre crash settles reconcile_required', async () => {
  const f = await delegatedRepoFixture({ multiRole: false });
  try {
    // 1. Complete a delegated run normally
    const runId = 'run-terminal-reentry';
    const step1 = assertStepYield(
      assertOk(await stepNext({ configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId }), 'stepNext 1'),
    );
    await writeFile(join(step1.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: true }), { mode: 0o600 });
    const firstSettled = assertOk(
      await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: step1.leaseToken, status: 'completed' }),
      'stepSubmit',
    );
    assert.equal(firstSettled.kind, 'result');
    if (firstSettled.kind !== 'result') return;
    assert.equal(firstSettled.result.spec.status, 'completed');

    // 2. Calling stepNext on the already-completed run returns the retained RunResult cleanly and releases ControllerOwner
    const nextAfterTerminal = assertOk(await stepNext({ runRoot: f.runRoot, runId }), 'stepNext on terminal run');
    assert.equal(canonical(nextAfterTerminal), canonical(firstSettled));
    assert.equal(await lstat(join(f.runRoot, runId, 'controller.owner.ndjson')).then(() => true, () => false), false);

    // 3. Calling stepCancel on the already-completed run ALSO returns the retained RunResult without overwriting with cancelled
    const cancelAfterTerminal = assertOk(await stepCancel({ runRoot: f.runRoot, runId }), 'stepCancel on terminal run');
    assert.equal(canonical(cancelAfterTerminal), canonical(firstSettled));
    assert.equal(await lstat(join(f.runRoot, runId, 'controller.owner.ndjson')).then(() => true, () => false), false);

    // 4. Calling stepSubmit on an already-completed run refuses AUTHORITY_REFUSED without overwriting with expired
    const submitAfterTerminal = await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: step1.leaseToken, status: 'completed' });
    assert.equal(submitAfterTerminal.ok, false);
    if (!submitAfterTerminal.ok) assert.equal(submitAfterTerminal.error.code, 'AUTHORITY_REFUSED');

    // 5. Materialize Attempt Workspace (source.version === 2) when overlay file replaces a deleted baseline directory path
    // Create a repo with >128 files so freezeSource selects version: 2 (tree_overlay mode), including a nested file 'packages/subdir/nested.txt'
    const fV2 = await delegatedRepoFixture({ multiRole: true });
    try {
      for (let i = 0; i < 130; i++) {
        await writeFile(join(fV2.repository, 'packages', `extra-${i}.txt`), `line-${i}\n`, { mode: 0o600 });
      }
      await mkdir(join(fV2.repository, 'packages', 'subdir'), { recursive: true, mode: 0o700 });
      await writeFile(join(fV2.repository, 'packages', 'subdir', 'nested.txt'), 'nested\n', { mode: 0o600 });
      execFileSync('/usr/bin/git', ['add', '.'], { cwd: fV2.repository });
      execFileSync('/usr/bin/git', ['-c', 'user.name=Step Fixture', '-c', 'user.email=fixture@localhost.invalid', 'commit', '-qm', 'v2 baseline'], { cwd: fV2.repository });
      const v2Rev = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: fV2.repository, encoding: 'utf8' }).trim();
      setFixture(fV2.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], v2Rev);
      setFixture(fV2.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], v2Rev);
      await fV2.save();
      const loadedV2 = assertOk(await fV2.load(), 'load v2 fixture');

      const v2RunId = 'run-v2-dir-to-file';
      const v2Step1 = assertStepYield(
        assertOk(await stepNext({ configuration: loadedV2, repository: fV2.repository, runRoot: fV2.runRoot, runId: v2RunId }), 'v2 stepNext 1'),
      );
      // Author removes 'packages/subdir/nested.txt' and 'packages/subdir' directory, and adds 'packages/subdir/replaced.txt'!
      await chmod(join(v2Step1.candidateDir, 'packages', 'subdir'), 0o700);
      await chmod(join(v2Step1.candidateDir, 'packages', 'subdir', 'nested.txt'), 0o600);
      await rm(join(v2Step1.candidateDir, 'packages', 'subdir'), { recursive: true, force: true });
      await mkdir(join(v2Step1.candidateDir, 'packages', 'subdir'), { recursive: true, mode: 0o700 });
      await writeFile(join(v2Step1.candidateDir, 'packages', 'subdir', 'replaced.txt'), 'replaced file\n', { mode: 0o600 });
      await writeFile(join(v2Step1.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: true }), { mode: 0o600 });

      // Submitting author materializes attempt 2 (review) workspace cleanly!
      const v2Step2 = assertStepYield(
        assertOk(await stepSubmit({ runRoot: fV2.runRoot, runId: v2RunId, leaseToken: v2Step1.leaseToken, status: 'completed' }), 'v2 stepSubmit 1'),
      );
      assert.equal(v2Step2.roleId, 'review');
      const replacedContent = await readFile(join(v2Step2.candidateDir, 'packages', 'subdir', 'replaced.txt'), 'utf8');
      assert.equal(replacedContent, 'replaced file\n');
    } finally {
      await fV2.cleanup();
    }

    // 6. ControllerEvents.#initialize releases holdLocalActivity() when lstat/open throws (e.g., symlink at controller-events.open)
    const descriptor = JSON.parse(await readFile(join(f.runRoot, runId, 'run.json'), 'utf8')) as {
      identity: import('@loopwright/state').LocalRunIdentity;
    };
    const store = stateValue(reopenLocalRun(descriptor.identity));
    const leakDir = join(f.root, 'events-leak-check');
    const leakArtifactsDir = join(leakDir, 'artifacts');
    await mkdir(leakArtifactsDir, { recursive: true, mode: 0o700 });
    await symlink(join(leakDir, 'nonexistent'), join(leakArtifactsDir, 'controller-events.open'));
    const owner = await ControllerOwner.acquire(leakDir, 'run-events-leak', hash('events-leak'));
    try {
      const artifacts = new ArtifactStore(leakArtifactsDir, owner, approvedState(f.loaded).vault);
      const events = new ControllerEvents(store, artifacts, undefined, () => {}, 0, false);
      await assert.rejects(() => events.push('admission', null));
      // Verify owner.release() succeeds because holdLocalActivity() was released in catch block!
      await owner.release();
      assert.equal(await lstat(join(leakDir, 'controller.owner.ndjson')).then(() => true, () => false), false);
    } finally {
      stateValue(store.close());
    }
  } finally {
    await f.cleanup();
  }
});

test('publication_pre mid-POST crash reconciled by stepCancel and stepNext preserves reconcile_required and never overwrites uncertain external_write', async () => {
  const pubSecret = 'STEP_PUB_SECRET_CANARY_998877665544';
  const pubToken = 'STEP_PUB_TOKEN_CANARY_112233445566';
  const f = await delegatedRepoFixture({ multiRole: false });
  try {
    f.environment.PUBLISHER_SECRET = pubSecret;
    f.environment.PUBLISHER_TOKEN = pubToken;
    setFixture(f.registry, ['spec', 'credentialBindings'], [
      { id: 'publisher-signer', consumer: 'publisher', destinationRef: 'publisher-service', environmentNames: ['PUBLISHER_SECRET'], template: '${PUBLISHER_SECRET}' },
      { id: 'publisher-auth', consumer: 'publisher', destinationRef: 'publisher-service', environmentNames: ['PUBLISHER_TOKEN'], template: '${PUBLISHER_TOKEN}' },
    ]);
    setFixture(f.registry, ['spec', 'environmentBindings'], [
      { name: 'PUBLISHER_SECRET', classification: 'credential', paths: ['/spec/credentials/0/template'] },
      { name: 'PUBLISHER_TOKEN', classification: 'credential', paths: ['/spec/credentials/1/template'] },
    ]);
    setFixture(f.config, ['spec', 'credentials'], [
      { ref: 'publisher-signer', template: '${PUBLISHER_SECRET}' },
      { ref: 'publisher-auth', template: '${PUBLISHER_TOKEN}' },
    ]);
    setFixture(f.registry, ['spec', 'publicationEndpoints'], [
      { id: 'pr-publisher', url: 'http://127.0.0.1:1/publish', signingCredentialRef: 'publisher-signer', authCredentialRef: 'publisher-auth', timeoutMs: 2000 },
    ]);
    setFixture(f.config, ['spec', 'publication'], {
      mode: 'pull_request',
      endpointRef: 'pr-publisher',
      targetBranch: 'main',
      headBranchPrefix: 'loopwright/',
      titleTemplate: 'Loopwright step publication',
    });
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [{ id: 'verify', kind: 'check', uses: 'tests', roleId: null, dependsOn: [] }]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [{ stepId: 'verify', handlerRef: 'tests' }]);
    await writeFile(join(f.repository, 'packages', 'result.json'), JSON.stringify({ ok: true }), { mode: 0o600 });
    execFileSync('/usr/bin/git', ['add', '.'], { cwd: f.repository });
    execFileSync('/usr/bin/git', ['-c', 'user.name=Step Fixture', '-c', 'user.email=fixture@localhost.invalid', 'commit', '-qm', 'ok true'], { cwd: f.repository });
    const rev = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: f.repository, encoding: 'utf8' }).trim();
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], rev);
    await f.save();
    f.input.untrustedRoots = [f.repository];
    const loaded = assertOk(await f.load(), 'load pub fixture');

    const runId = 'run-step-pub-crash';
    const context = await createCycle({ configuration: loaded, repository: f.repository, runRoot: f.runRoot, runId }, {});
    const cycle = new Cycle(context);
    await cycle.bootstrap();
    await cycle.graph();
    const endpoint = loaded.registry.spec.publicationEndpoints[0]!;
    const bound = bindSubject(context.lock, cycle.candidate.manifest);
    assert.ok(bound.ok);
    if (!bound.ok) return;
    const view = stateValue(context.store.inspect());
    const prepared = preparePublication(context.plan, context.lock, view.storeId, endpoint, bound.value);
    await cycle.events.push('publication', null);
    await cycle.publish(
      {
        ...cycle.draft,
        stage: { ...cycle.draft.stage, kind: 'publication_pre' },
        publication: { status: 'pending', operationId: prepared.operationId, receipt: null },
      },
      'publication.pre',
    );
    stateValue(
      context.store.putIntent(context.authority, {
        operationId: prepared.operationId,
        nodeId: context.plan.orderedDAG[0]!.id,
        attemptId: prepared.idempotencyKey,
        effect: 'external_write',
        requestDigest: prepared.requestDigest,
        targetIdentity: 'publication:' + runId + ':' + bound.value.candidateDigest.hex,
      }),
    );
    const dispatched = stateValue(context.store.authorizeOperationDispatch(context.authority, prepared.operationId));
    assert.equal(dispatched.kind, 'new_dispatch');
    if (dispatched.kind !== 'new_dispatch') return;
    const operation = stateValue(context.store.getOperation(prepared.operationId));
    const requestPayload = {
      version: 1,
      kind: 'publication_request',
      storeId: view.storeId,
      runId,
      lockHash: context.lock.spec.lockHash,
      operationId: prepared.operationId,
      dispatchId: dispatched.permit.dispatchId,
      dispatchGeneration: dispatched.permit.generation,
      idempotencyKey: prepared.idempotencyKey,
      targetBranch: 'main',
      headBranch: prepared.headBranch,
      title: prepared.title,
      candidateDigest: bound.value.candidateDigest.hex,
      baseRevision: context.plan.task.spec.target.baseRevision,
      sourceRevision: context.plan.task.spec.target.sourceRevision,
      requestDigest: prepared.requestDigest.hex,
    };
    const bindingPath = join(context.artifacts.directory, 'publication-producer-' + hash(prepared.operationId).hex + '.binding.json');
    await writeFile(
      bindingPath,
      canonical({
        version: 1,
        planDigest: context.plan.planDigest,
        operationId: prepared.operationId,
        requestDigest: prepared.requestDigest,
        requestBytesDigest: hash(Buffer.from(canonical(requestPayload))).hex,
        intentDigest: operation.intentDigest,
        subject: bound.value,
        endpoint: endpoint.id,
        dispatchReceipt: {
          generation: dispatched.permit.generation,
          dispatchId: dispatched.permit.dispatchId,
          revision: dispatched.permit.authorizedRevision,
          clockEpoch: dispatched.permit.clockEpoch,
        },
      }),
      { mode: 0o600 },
    );
    const eventsRef = await cycle.events.close();
    const restoredEvents = await fsOpen(
      join(context.artifacts.directory, 'controller-events.open'),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await restoredEvents.writeFile(await readFile(join(context.artifacts.directory, eventsRef.name)));
      await restoredEvents.sync();
    } finally {
      await restoredEvents.close();
    }
    stateValue(context.store.release(context.authority));
    stateValue(context.store.close());
    await context.owner.release();

    // Calling stepCancel on a mid-publication crash must NOT overwrite the uncertain external_write with 'cancelled' — it settles 'reconcile_required'!
    const cancelRes = assertOk(
      await stepCancel({ runRoot: f.runRoot, runId, environment: name => f.environment[name] }),
      'stepCancel on mid-publication crash',
    );
    assert.equal(cancelRes.kind, 'result');
    if (cancelRes.kind !== 'result') return;
    assert.equal(cancelRes.result.spec.status, 'reconcile_required');
    assert.equal(cancelRes.result.spec.externalEffects, 'unknown');

    // Subsequent stepNext returns the retained reconcile_required result, and reconcileCycle can still settle it to 'completed'!
    const nextRes = assertOk(
      await stepNext({ runRoot: f.runRoot, runId, environment: name => f.environment[name] }),
      'stepNext after reconcile_required settlement',
    );
    assert.equal(canonical(nextRes), canonical(cancelRes));

    const receiptBody = {
      version: 1,
      kind: 'publication_receipt',
      storeId: requestPayload.storeId,
      runId: requestPayload.runId,
      lockHash: requestPayload.lockHash,
      operationId: requestPayload.operationId,
      dispatchId: requestPayload.dispatchId,
      dispatchGeneration: requestPayload.dispatchGeneration,
      idempotencyKey: requestPayload.idempotencyKey,
      outcome: 'succeeded' as const,
      externalUrl: 'https://x/pull/99',
      reason: null,
    };
    const receiptPath = join(f.root, 'pub-receipt.json');
    await writeFile(
      receiptPath,
      JSON.stringify({ ...receiptBody, signature: signPayload(pubSecret, canonical(receiptBody)) }),
      { mode: 0o600 },
    );
    const reconciled = assertOk(
      await reconcileCycle({ configuration: loaded, runRoot: f.runRoot, runId, receipt: receiptPath }),
      'reconcileCycle after stepCancel reconcile_required',
    );
    assert.equal(reconciled.kind, 'settled');
    if (reconciled.kind === 'settled') {
      assert.equal(reconciled.status, 'completed');
      assert.equal(reconciled.externalEffects, 'confirmed');
    }
  } finally {
    await f.cleanup();
  }
});

test('pre-commit validation in stepSubmit refuses secret leakage and path collisions BEFORE unlinking step-lease.json or candidateDir so the same leaseToken can be retried', async () => {
  const f = await delegatedRepoFixture({ multiRole: false, gateUrl: 'http://127.0.0.1:1/gate' });
  let server: ReturnType<typeof createServer> | null = null;
  try {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks);
        const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
        const verdict = {
          version: 1,
          kind: 'gate_verdict',
          storeId: parsed.storeId,
          runId: parsed.runId,
          lockHash: parsed.lockHash,
          operationId: parsed.operationId,
          dispatchId: parsed.dispatchId,
          dispatchGeneration: parsed.dispatchGeneration,
          gateId: parsed.gateId,
          checkId: parsed.checkId,
          candidateDigest: parsed.candidateDigest,
          status: 'approved',
          reason: null,
          expiresAtMs: String(Date.now() + 600_000),
        };
        const bytes = Buffer.from(JSON.stringify(verdict));
        res.writeHead(200, {
          'content-type': 'application/json',
          connection: 'close',
          'x-loopwright-signature': signPayload(f.gateSecret, bytes),
        });
        res.end(bytes);
      })();
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
    const livePort = (server.address() as { port: number }).port;
    const liveUrl = `http://127.0.0.1:${livePort}/gate`;

    const runId = 'run-precommit-secret';
    const step1 = assertStepYield(
      assertOk(
        await stepNext({
          configuration: f.loaded,
          repository: f.repository,
          runRoot: f.runRoot,
          runId,
          environment: name => f.environment[name],
        }),
        'stepNext',
      ),
    );

    // 1. Write the registered secret into candidateDir/packages/result.json -> vault.assertClean refuses CONFIG_CREDENTIAL_INVALID!
    await writeFile(
      join(step1.candidateDir, 'packages', 'result.json'),
      JSON.stringify({ ok: true, leaked: f.gateSecret }),
      { mode: 0o600 },
    );
    const secretSubmit = await stepSubmit(
      {
        runRoot: f.runRoot,
        runId,
        leaseToken: step1.leaseToken,
        status: 'completed',
        environment: name => f.environment[name],
      },
      { gateUrlOverrides: { 'local-cmd': liveUrl } },
    );
    assert.equal(secretSubmit.ok, false);
    if (!secretSubmit.ok) {
      assert.equal(secretSubmit.error.code, 'CONFIG_CREDENTIAL_INVALID');
    }

    // Verify step-lease.json and step1.candidateDir were NOT unlinked or deleted!
    assert.equal(await lstat(join(f.runRoot, runId, 'step-lease.json')).then(() => true, () => false), true);
    assert.equal(await lstat(step1.candidateDir).then(() => true, () => false), true);

    // 2. Scrub the secret from candidateDir/packages/result.json and retry with the EXACT SAME leaseToken -> succeeds!
    await writeFile(join(step1.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: true }), { mode: 0o600 });
    const cleanSubmit = assertOk(
      await stepSubmit(
        {
          runRoot: f.runRoot,
          runId,
          leaseToken: step1.leaseToken,
          status: 'completed',
          environment: name => f.environment[name],
        },
        { gateUrlOverrides: { 'local-cmd': liveUrl } },
      ),
      'stepSubmit after scrubbing secret',
    );
    assert.equal(cleanSubmit.kind, 'result');
    if (cleanSubmit.kind === 'result') {
      assert.equal(cleanSubmit.result.spec.status, 'completed');
    }
  } finally {
    if (server) {
      await new Promise<void>(resolve => {
        server!.closeAllConnections();
        server!.close(() => resolve());
      });
    }
    await f.cleanup();
  }
});

test('real post-deadline wallTimeMs expiry while parked at awaiting_role (sampledNow >= taskDeadlineMonotonicMs, remainingTaskMs === 0) claims in recovery mode and settles status: expired cleanly', async () => {
  const f = await delegatedRepoFixture({ multiRole: false, wallTimeMs: 130_000 });
  const realDateNow = Date.now;
  const realHrtimeBigint = process.hrtime.bigint;
  let offsetMs = 0n;
  try {
    const runId = 'run-post-deadline-expired';
    const step1 = assertStepYield(
      assertOk(await stepNext({ configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId }), 'stepNext 1'),
    );

    // Advance both wall clock and monotonic clock by 135_000ms (> wallTimeMs 130_000ms) in lockstep so clockStatus remains 'trusted' and remainingTaskMs === 0!
    Date.now = () => realDateNow() + Number(offsetMs);
    process.hrtime.bigint = () => realHrtimeBigint() + offsetMs * 1_000_000n;
    offsetMs = 135_000n;

    const settled = assertOk(
      await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: step1.leaseToken, status: 'completed' }),
      'stepSubmit post-deadline',
    );
    assert.equal(settled.kind, 'result');
    if (settled.kind !== 'result') return;
    assert.equal(settled.result.spec.status, 'expired');

    // Verify lease and workspace were cleaned up
    assert.equal(await lstat(join(f.runRoot, runId, 'step-lease.json')).then(() => true, () => false), false);
    assert.equal(await lstat(join(f.runRoot, 'workspaces', runId)).then(() => true, () => false), false);

    // Subsequent stepNext and stepCancel post-deadline return the same retained expired RunResult
    const nextAgain = assertOk(await stepNext({ runRoot: f.runRoot, runId }), 'stepNext after post-deadline expired');
    assert.equal(canonical(nextAgain), canonical(settled));
    const cancelAgain = assertOk(await stepCancel({ runRoot: f.runRoot, runId }), 'stepCancel after post-deadline expired');
    assert.equal(canonical(cancelAgain), canonical(settled));
  } finally {
    Date.now = realDateNow;
    process.hrtime.bigint = realHrtimeBigint;
    await f.cleanup();
  }
});

test('controls.submission.path with multi-role delegated pipeline allows read-only review to override author artifact submission via status/reason or submissionFile without SUBMISSION_AMBIGUOUS', async () => {
  const f = await delegatedRepoFixture({ multiRole: true, submissionPath: 'packages/sub.json', maxImplementationRepairs: 0 });
  try {
    // Case 1: Author writes packages/sub.json with status: 'completed', then read-only review submits status: 'failed', reason: 'bug found'
    const runId1 = 'run-subpath-review-status';
    const author1 = assertStepYield(
      assertOk(await stepNext({ configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId: runId1 }), 'stepNext author1'),
    );
    assert.equal(author1.submissionPath, 'packages/sub.json');
    await writeFile(join(author1.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: true }), { mode: 0o600 });
    await writeFile(
      join(author1.candidateDir, 'packages', 'sub.json'),
      JSON.stringify({
        version: 1,
        status: 'completed',
        checks: [{ checkId: 'tests', status: 'passed', evidenceId: null, reason: null }],
        reason: null,
      }),
      { mode: 0o600 },
    );

    // Author calls stepSubmit({}) with no explicit status/submissionFile -> uses packages/sub.json!
    const review1 = assertStepYield(
      assertOk(await stepSubmit({ runRoot: f.runRoot, runId: runId1, leaseToken: author1.leaseToken }), 'stepSubmit author1'),
    );
    assert.equal(review1.roleId, 'review');

    // Read-only review calls stepSubmit({ status: 'failed', reason: 'bug found' }) -> must NOT be overridden by packages/sub.json or fail with SUBMISSION_AMBIGUOUS!
    const settled1 = assertOk(
      await stepSubmit({ runRoot: f.runRoot, runId: runId1, leaseToken: review1.leaseToken, status: 'failed', reason: 'bug found' }),
      'stepSubmit review1 failed',
    );
    assert.equal(settled1.kind, 'result');
    if (settled1.kind === 'result') {
      assert.equal(settled1.result.spec.status, 'failed');
    }

    // Case 2: Read-only review passes explicit --submission-file while packages/sub.json exists in candidate overlay
    const runId2 = 'run-subpath-review-file';
    const author2 = assertStepYield(
      assertOk(await stepNext({ configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId: runId2 }), 'stepNext author2'),
    );
    await writeFile(join(author2.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: true }), { mode: 0o600 });
    await writeFile(
      join(author2.candidateDir, 'packages', 'sub.json'),
      JSON.stringify({
        version: 1,
        status: 'completed',
        checks: [{ checkId: 'tests', status: 'passed', evidenceId: null, reason: null }],
        reason: null,
      }),
      { mode: 0o600 },
    );
    const review2 = assertStepYield(
      assertOk(await stepSubmit({ runRoot: f.runRoot, runId: runId2, leaseToken: author2.leaseToken }), 'stepSubmit author2'),
    );
    const explicitSubPath = join(f.root, 'review-explicit-sub.json');
    await writeFile(
      explicitSubPath,
      JSON.stringify({
        version: 1,
        status: 'blocked',
        checks: [{ checkId: 'tests', status: 'blocked', evidenceId: null, reason: 'blocked_by_reviewer' }],
        reason: 'blocked_by_reviewer',
      }),
      { mode: 0o600 },
    );
    const settled2 = assertOk(
      await stepSubmit({ runRoot: f.runRoot, runId: runId2, leaseToken: review2.leaseToken, submissionFile: explicitSubPath }),
      'stepSubmit review2 explicit file',
    );
    assert.equal(settled2.kind, 'result');
    if (settled2.kind === 'result') {
      assert.equal(settled2.result.spec.status, 'blocked');
    }
  } finally {
    await f.cleanup();
  }
});

test('delegated role with tools: [read, bash] receives implementation repair and gate.v1 denial verdict.reason detail is included in the repair prompt', async () => {
  const f = await delegatedRepoFixture({ multiRole: false, gateUrl: 'http://127.0.0.1:1/gate', maxImplementationRepairs: 1, maxAttempts: 3 });
  let gateCallCount = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      gateCallCount++;
      const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      const denied = gateCallCount === 1;
      const verdict = {
        version: 1,
        kind: 'gate_verdict',
        storeId: parsed.storeId,
        runId: parsed.runId,
        lockHash: parsed.lockHash,
        operationId: parsed.operationId,
        dispatchId: parsed.dispatchId,
        dispatchGeneration: parsed.dispatchGeneration,
        gateId: parsed.gateId,
        checkId: parsed.checkId,
        candidateDigest: parsed.candidateDigest,
        status: denied ? 'denied' : 'approved',
        reason: denied ? 'custom_gate_denial_detail_for_repair' : null,
        expiresAtMs: String(Date.now() + 600_000),
      };
      const bytes = Buffer.from(JSON.stringify(verdict));
      res.writeHead(200, {
        'content-type': 'application/json',
        connection: 'close',
        'x-loopwright-signature': signPayload(f.gateSecret, bytes),
      });
      res.end(bytes);
    })();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const livePort = (server.address() as { port: number }).port;
  const liveUrl = `http://127.0.0.1:${livePort}/gate`;

  try {
    // Configure author role with tools: ['read', 'bash'] (no 'write'/'edit'/'delete')
    setFixture(f.registry, ['spec', 'roleProfiles', 0, 'tools'], ['read', 'bash']);
    setFixture(f.config, ['spec', 'task', 'spec', 'roles', 0, 'tools'], ['read', 'bash']);
    await f.save();
    const loaded = assertOk(await f.load(), 'load bash-only author fixture');

    const runId = 'run-bash-gate-repair';
    const step1 = assertStepYield(
      assertOk(
        await stepNext({
          configuration: loaded,
          repository: f.repository,
          runRoot: f.runRoot,
          runId,
          environment: name => f.environment[name],
        }),
        'stepNext 1',
      ),
    );
    assert.deepEqual(step1.allowedTools, ['read', 'bash']);

    // Satisfy 'tests' check so only 'gate-check' fails on attempt 1 with 'custom_gate_denial_detail_for_repair'
    await writeFile(join(step1.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: true, rev: 1 }), { mode: 0o600 });

    const repairStep = assertStepYield(
      assertOk(
        await stepSubmit(
          {
            runRoot: f.runRoot,
            runId,
            leaseToken: step1.leaseToken,
            status: 'completed',
            environment: name => f.environment[name],
          },
          { gateUrlOverrides: { 'local-cmd': liveUrl } },
        ),
        'stepSubmit 1 triggering gate denial repair',
      ),
    );
    assert.equal(repairStep.roleId, 'author');
    assert.equal(repairStep.repair, 'implementation');
    assert.match(repairStep.prompt, /custom_gate_denial_detail_for_repair/);

    // Update candidate in repair step and submit -> gate approves on second call -> settles completed!
    await writeFile(join(repairStep.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: true, rev: 2 }), { mode: 0o600 });
    const settled = assertOk(
      await stepSubmit(
        {
          runRoot: f.runRoot,
          runId,
          leaseToken: repairStep.leaseToken,
          status: 'completed',
          environment: name => f.environment[name],
        },
        { gateUrlOverrides: { 'local-cmd': liveUrl } },
      ),
      'stepSubmit 2 after repair',
    );
    assert.equal(settled.kind, 'result');
    if (settled.kind === 'result') {
      assert.equal(settled.result.spec.status, 'completed');
    }
  } finally {
    await new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    await f.cleanup();
  }
});

test('mixed delegated -> pi pipeline enforces post-capture maxModelCalls when pi dispatches multiple requests in one turn, and stepNext rejects conflicting mode on reopen', async () => {
  const f = await delegatedRepoFixture({ mixedPiFirst: true, maxModelCalls: 2, noChangeCheck: false });
  try {
    // Flip DAG order so delegated 'review' runs FIRST (1 model call), then pi 'build' runs SECOND and makes 2 requests (total = 3 > maxModelCalls 2)!
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'review', kind: 'agent', uses: 'review.step', roleId: 'reviewer', dependsOn: [] },
      { id: 'build', kind: 'agent', uses: 'author.step', roleId: 'builder', dependsOn: ['review'] },
      { id: 'verify', kind: 'check', uses: 'tests', roleId: null, dependsOn: ['build'] },
    ]);
    await f.save();
    const loaded = assertOk(await f.load(), 'load delegated-then-pi fixture');

    const runId = 'run-delegated-then-pi-budget';
    const step1 = assertStepYield(
      assertOk(await stepNext({ configuration: loaded, repository: f.repository, runRoot: f.runRoot, runId }), 'stepNext 1'),
    );
    assert.equal(step1.roleId, 'reviewer');

    // Calling stepNext on an existing 'candidate' mode run with mode: 'no-change' refuses RECOVERY_REQUIRED at /mode
    const modeConflict = await stepNext({
      runRoot: f.runRoot,
      runId,
      mode: 'no-change',
      environment: name => f.environment[name],
    });
    assert.equal(modeConflict.ok, false);
    if (!modeConflict.ok) {
      assert.equal(modeConflict.error.code, 'RECOVERY_REQUIRED');
      assert.equal(modeConflict.error.path, '/mode');
    }

    // Pi adapter that reserves & observes 2 requests in a single turn
    const openAdapter = async (host: PiHostV2, input: PiOpenInputV2) => {
      let capturedWorkspace: import('@loopwright/core').ArtifactRef | null = null;
      let capturedSession: import('@loopwright/core').ArtifactRef | null = null;
      let capturedManifest: import('@loopwright/core').ArtifactManifest | null = null;
      const adapter: PiAdapterV2 = {
        capabilities: () => { throw new Error('unused'); },
        events: () => ({ async *[Symbol.asyncIterator]() { yield* []; } }),
        cancel: async () => ({
          ok: true,
          value: {
            status: 'cancelled',
            requestIds: [],
            operationIds: [],
            providerTermination: 'none',
            usage: 'none',
            localCleanup: 'complete',
            error: null,
            cleanupError: null,
          },
        }),
        compact: async () => { throw new Error('unused'); },
        execute: async cmd => {
          for (const idx of [1, 2]) {
            const reqId = `pi-req-${idx}`;
            const opId = `pi-op-${idx}`;
            stateValue(
              host.store.reserveRequest(host.authority, {
                requestId: reqId,
                roleId: input.roleId,
                nodeId: input.stepId,
                attemptId: cmd.commandId,
                purpose: cmd.purpose,
                repair: cmd.repair,
                transportRetryOf: null,
                requestDigest: hash(reqId),
                inputUpperBound: 40,
                outputUpperBound: 10,
                totalUpperBound: 50,
                capability: {
                  adapterId: 'pi',
                  adapterVersion: '0.0.0',
                  provider: input.policy.selection.provider,
                  model: input.policy.selection.model,
                  kind: 'soft_only',
                  coversAllBillableTokens: false,
                  enforcesOutputBound: false,
                },
                operationId: opId,
                targetIdentity: `fixture:pi-step-${idx}`,
              }),
            );
            stateValue(host.store.authorizeRequestDispatch(host.authority, reqId));
            const op = stateValue(host.store.getOperation(opId));
            const view = stateValue(host.store.inspect());
            const usageRef = { name: `pi-usage-${idx}.json`, byteLength: 2, digest: hash(Buffer.from('{}')) };
            await writeFile(join(host.artifactsDirectory, usageRef.name), '{}', { mode: 0o600 });
            stateValue(
              host.store.observeRequest(host.authority, reqId, {
                receiptId: `pi-rec-${idx}`,
                termination: 'confirmed',
                outcome: 'succeeded',
                evidence: {
                  evidenceId: `pi-ev-${idx}`,
                  producerId: 'unit-pi',
                  method: 'synthetic',
                  artifact: usageRef,
                  subject: {
                    storeId: view.storeId,
                    runId: view.runId,
                    lockHash: view.lockHash,
                    operationId: opId,
                    requestId: reqId,
                    intentDigest: op.intentDigest,
                    dispatchGeneration: op.dispatch!.generation,
                    dispatchId: op.dispatch!.dispatchId,
                  },
                },
                usage: {
                  requestId: reqId,
                  inputTokens: { provenance: 'reported', value: 10 },
                  outputTokens: { provenance: 'reported', value: 5 },
                  costMicrousd: { provenance: 'unknown' },
                },
              }),
            );
          }

          const updatedBytes = Buffer.from(JSON.stringify({ ok: true }));
          const updatedEntries = input.candidate.manifest.spec.entries.map(entry =>
            entry.name === 'packages/result.json'
              ? { name: 'packages/result.json', byteLength: updatedBytes.byteLength, digest: hash(updatedBytes) }
              : entry,
          );
          capturedManifest = {
            ...input.candidate.manifest,
            spec: { ...input.candidate.manifest.spec, entries: updatedEntries },
          };
          const subject = bindSubject(input.lock, capturedManifest);
          assert.ok(subject.ok);
          if (!subject.ok) throw new Error('subject');

          const checkpointId = phaseCheckpointId(input.lock.spec.runId, 'role.2.native');
          const current = stateValue(host.store.inspect());
          const sourceDigest = hash('loopwright.dev/pi-policy/v2\0' + canonical(input.policy));
          const nativePolicy = { ...input.policy, version: 1, policyId: 'v2.' + BigInt('0x' + sourceDigest.hex).toString(36) };
          const binding = {
            version: 1,
            checkpointId,
            storeId: current.storeId,
            runId: current.runId,
            lockHash: current.lockHash,
            sessionId: input.sessionId,
            roleId: input.roleId,
            stepId: input.stepId,
            runtime: input.policy.runtime,
            policyDigest: hash(canonical(nativePolicy)),
            resourcesDigest: hash(canonical(input.policy.resources)),
            candidateDigest: subject.value.candidateDigest,
            clockBasis: current.clock.basis,
            accountingDigest: hash(canonical({ ledger: current.ledger, requests: current.counts.requests, operations: current.counts.operations })),
            sequence: 1,
          };
          const line = (v: unknown) => JSON.stringify(v) + '\n';
          const fileChunks: string[] = [line({ type: 'workspace_snapshot', version: 1, binding, manifest: capturedManifest })];
          for (const ref of capturedManifest.spec.entries) {
            const bytes =
              ref.name === 'packages/result.json'
                ? updatedBytes
                : Buffer.from(input.candidate.artifacts.find(a => a.name === ref.name)!.bytes);
            fileChunks.push(line({ type: 'file', ref }));
            fileChunks.push(line({ type: 'chunk', index: 0, data: bytes.toString('base64') }));
            fileChunks.push(line({ type: 'file_end', byteLength: bytes.byteLength, digest: hash(bytes).hex }));
          }
          fileChunks.push(line({ type: 'end', files: capturedManifest.spec.entries.length }));
          const wsBytes = Buffer.from(fileChunks.join(''));
          const wsName = 'unit-pi-ws-2.ndjson';
          await writeFile(join(host.artifactsDirectory, wsName), wsBytes, { mode: 0o600 });
          capturedWorkspace = { name: wsName, byteLength: wsBytes.byteLength, digest: hash(wsBytes) };

          const timestamp = '2026-11-14T00:00:00.000Z';
          const submissionText = JSON.stringify({
            version: 1,
            status: 'completed',
            checks: [{ checkId: 'tests', status: 'passed', evidenceId: null, reason: null }],
            reason: null,
          });
          const sessBytes = Buffer.from(
            line({ type: 'session_snapshot', version: 1, binding }) +
              [
                { type: 'session', version: 3, id: 'unit_pi_2', cwd: '/workspace/candidate', timestamp },
                { type: 'message', id: 'u1', parentId: null, timestamp, message: { role: 'user', content: cmd.text } },
                {
                  type: 'message',
                  id: 'a1',
                  parentId: 'u1',
                  timestamp,
                  message: {
                    role: 'assistant',
                    ...input.policy.selection,
                    content: [{ type: 'text', text: submissionText }],
                    stopReason: 'stop',
                  },
                },
              ]
                .map(line)
                .join(''),
          );
          const sessName = 'unit-pi-sess-2.ndjson';
          await writeFile(join(host.artifactsDirectory, sessName), sessBytes, { mode: 0o600 });
          capturedSession = { name: sessName, byteLength: sessBytes.byteLength, digest: hash(sessBytes) };

          stateValue(
            host.store.writeCheckpoint(host.authority, {
              checkpointId,
              expectedRevision: current.revision,
              candidateManifest: capturedManifest,
              workspace: capturedWorkspace,
              privateSession: capturedSession,
              additionalArtifacts: [],
            }),
          );

          return {
            ok: true,
            value: {
              status: 'execution_settled',
              requestIds: ['pi-req-1', 'pi-req-2'],
              operationIds: ['pi-op-1', 'pi-op-2'],
              providerTermination: 'confirmed',
              usage: 'complete',
              localCleanup: 'complete',
              error: null,
              cleanupError: null,
            },
          };
        },
        capture: async ({ checkpointId }) => ({
          ok: true,
          value: {
            checkpointId,
            candidate: capturedManifest!,
            workspace: capturedWorkspace!,
            session: capturedSession!,
          },
        }),
        close: async () => ({ ok: true, value: { closed: true } }),
      };
      return { ok: true as const, value: adapter };
    };

    const settled = assertOk(
      await stepSubmit(
        {
          runRoot: f.runRoot,
          runId,
          leaseToken: step1.leaseToken,
          status: 'completed',
          environment: name => f.environment[name],
        },
        { openAdapter },
      ),
      'stepSubmit delegated -> pi exceeding maxModelCalls',
    );
    assert.equal(settled.kind, 'result');
    if (settled.kind === 'result') {
      assert.equal(settled.result.spec.status, 'exhausted');
    }
  } finally {
    await f.cleanup();
  }
});

test('settleForcedStepRun settles cancelled and expired cleanly when interrupted at verifier_pre before operation dispatch', async () => {
  const f = await delegatedRepoFixture({ multiRole: false, wallTimeMs: 130_000 });
  const realDateNow = Date.now;
  const realHrtimeBigint = process.hrtime.bigint;
  let offsetMs = 0n;
  try {
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [{ id: 'verify', kind: 'check', uses: 'tests', roleId: null, dependsOn: [] }]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [{ stepId: 'verify', handlerRef: 'tests' }]);
    await writeFile(join(f.repository, 'packages', 'result.json'), JSON.stringify({ ok: true }), { mode: 0o600 });
    execFileSync('/usr/bin/git', ['add', '.'], { cwd: f.repository });
    execFileSync('/usr/bin/git', ['-c', 'user.name=Step Fixture', '-c', 'user.email=fixture@localhost.invalid', 'commit', '-qm', 'ok true'], { cwd: f.repository });
    const rev = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: f.repository, encoding: 'utf8' }).trim();
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], rev);
    await f.save();
    f.input.untrustedRoots = [f.repository];
    const loaded = assertOk(await f.load(), 'load check-only fixture');

    const createVerifyPreInterruptedRun = async (runId: string): Promise<void> => {
      const context = await createCycle({ configuration: loaded, repository: f.repository, runRoot: f.runRoot, runId }, {});
      const cycle = new Cycle(context);
      await cycle.bootstrap();
      const slot = context.plan.verifierSlots[0]!;
      const nonce = '0123456789abcdef0123456789abcdef';
      const opId = verifierOperationId(runId, slot.id, 0);
      await cycle.events.push('verification', null);
      await cycle.publish(
        {
          ...cycle.draft,
          stage: { ...cycle.draft.stage, kind: 'verifier_pre' },
          verifierReceipts: [
            {
              slot: slot.id,
              generation: 0,
              operationId: opId,
              producerNonce: nonce,
              output: null,
              receipt: null,
            },
          ],
        },
        'verify.0.0.pre',
      );
      await cycle.deadline.dispose();
      await cycle.events.suspend();
      stateValue(context.store.release(context.authority));
      stateValue(context.store.close());
      await context.owner.release();
    };

    // 1. Interrupted at verify.0.0.pre (receipt === null, operation RECORD_NOT_FOUND) + stepCancel -> settles status: 'cancelled' (NOT incident)
    await createVerifyPreInterruptedRun('run-verify-pre-cancel');
    const cancelled = assertOk(
      await stepCancel({ runRoot: f.runRoot, runId: 'run-verify-pre-cancel', environment: name => f.environment[name] }),
      'stepCancel after verifier_pre before dispatch',
    );
    assert.equal(cancelled.kind, 'result');
    if (cancelled.kind === 'result') {
      assert.equal(cancelled.result.spec.status, 'cancelled');
    }

    // 2. Interrupted at verify.0.0.pre (receipt === null, operation RECORD_NOT_FOUND) + wallTimeMs expiry -> stepNext settles status: 'expired' (NOT incident)
    await createVerifyPreInterruptedRun('run-verify-pre-expire');

    Date.now = () => realDateNow() + Number(offsetMs);
    process.hrtime.bigint = () => realHrtimeBigint() + offsetMs * 1_000_000n;
    offsetMs = 15_000n; // remainingTaskMs <= drainReserveMs (130_000 - 15_000 <= 120_000)

    const expired = assertOk(
      await stepNext({ runRoot: f.runRoot, runId: 'run-verify-pre-expire', environment: name => f.environment[name] }),
      'stepNext expired after verifier_pre before dispatch',
    );
    assert.equal(expired.kind, 'result');
    if (expired.kind === 'result') {
      assert.equal(expired.result.spec.status, 'expired');
    }
  } finally {
    Date.now = realDateNow;
    process.hrtime.bigint = realHrtimeBigint;
    await f.cleanup();
  }
});

test('two loopback gateEndpoints overridden in ports.gateUrlOverrides both dispatch and settle completed with zero unresolvedOperations', async () => {
  const f = await delegatedRepoFixture({ multiRole: false, gateUrl: 'http://127.0.0.1:1/gate-a' });
  const hitsByPath = new Map<string, number>();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      const path = (req.url ?? '/').split('?')[0]!;
      hitsByPath.set(path, (hitsByPath.get(path) ?? 0) + 1);
      const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      const verdict = {
        version: 1,
        kind: 'gate_verdict',
        storeId: parsed.storeId,
        runId: parsed.runId,
        lockHash: parsed.lockHash,
        operationId: parsed.operationId,
        dispatchId: parsed.dispatchId,
        dispatchGeneration: parsed.dispatchGeneration,
        gateId: parsed.gateId,
        checkId: parsed.checkId,
        candidateDigest: parsed.candidateDigest,
        status: 'approved',
        reason: null,
        expiresAtMs: String(Date.now() + 600_000),
      };
      const bytes = Buffer.from(JSON.stringify(verdict));
      res.writeHead(200, {
        'content-type': 'application/json',
        connection: 'close',
        'x-loopwright-signature': signPayload(f.gateSecret, bytes),
      });
      res.end(bytes);
    })();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const livePort = (server.address() as { port: number }).port;
  const urlA = `http://127.0.0.1:${livePort}/gate-a`;
  const urlB = `http://127.0.0.1:${livePort}/gate-b`;

  try {
    const installed = await installedHandlerDigests();
    setFixture(f.registry, ['spec', 'handlers'], [
      ...f.registry.spec.handlers,
      {
        id: 'gate.check.b',
        version: 1,
        digest: installed['gate.v1'],
        kind: 'check',
        implementation: 'gate.v1',
        parameters: { checkId: 'gate-check-b', endpointRef: 'local-cmd-b', gateId: 'cmd-gate-b' },
        capabilities: ['external_service', 'read_only'],
      },
    ]);
    setFixture(f.registry, ['spec', 'gateEndpoints'], [
      {
        id: 'local-cmd',
        url: 'http://127.0.0.1:1/gate-a',
        signingCredentialRef: 'gate-signer',
        authCredentialRef: null,
        timeoutMs: 1500,
        maxPollMs: 3000,
        pollInitialMs: 100,
        pollMaxMs: 200,
        jitter: 0,
      },
      {
        id: 'local-cmd-b',
        url: 'http://127.0.0.1:1/gate-b',
        signingCredentialRef: 'gate-signer',
        authCredentialRef: null,
        timeoutMs: 1500,
        maxPollMs: 3000,
        pollInitialMs: 100,
        pollMaxMs: 200,
        jitter: 0,
      },
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'author', kind: 'agent', uses: 'author.step', roleId: 'author', dependsOn: [] },
      { id: 'verify', kind: 'check', uses: 'tests', roleId: null, dependsOn: ['author'] },
      { id: 'gate', kind: 'check', uses: 'gate.check', roleId: null, dependsOn: ['verify'] },
      { id: 'gate-b', kind: 'check', uses: 'gate.check.b', roleId: null, dependsOn: ['gate'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'author', handlerRef: 'author.step' },
      { stepId: 'verify', handlerRef: 'tests' },
      { stepId: 'gate', handlerRef: 'gate.check' },
      { stepId: 'gate-b', handlerRef: 'gate.check.b' },
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'acceptance'], {
      required: ['tests', 'gate-check', 'gate-check-b'],
      checks: [
        { id: 'tests', allowedEvidenceLevels: ['local_execution'] },
        { id: 'gate-check', allowedEvidenceLevels: ['external_service'] },
        { id: 'gate-check-b', allowedEvidenceLevels: ['external_service'] },
      ],
    });
    await f.save();
    const loaded = assertOk(await f.load(), 'load two-gate fixture');

    const runId = 'run-two-gate-overrides';
    const step1 = assertStepYield(
      assertOk(
        await stepNext(
          {
            configuration: loaded,
            repository: f.repository,
            runRoot: f.runRoot,
            runId,
            environment: name => f.environment[name],
          },
          { gateUrlOverrides: { 'local-cmd': urlA, 'local-cmd-b': urlB } },
        ),
        'stepNext two-gate override',
      ),
    );
    await writeFile(join(step1.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: true }), { mode: 0o600 });

    const settled = assertOk(
      await stepSubmit(
        {
          runRoot: f.runRoot,
          runId,
          leaseToken: step1.leaseToken,
          status: 'completed',
          environment: name => f.environment[name],
        },
        { gateUrlOverrides: { 'local-cmd': urlA, 'local-cmd-b': urlB } },
      ),
      'stepSubmit two-gate override',
    );
    assert.equal(settled.kind, 'result');
    if (settled.kind === 'result') {
      assert.equal(settled.result.spec.status, 'completed');
    }
    assert.equal(hitsByPath.get('/gate-a'), 1);
    assert.equal(hitsByPath.get('/gate-b'), 1);

    const inspected = assertOk(await inspectRun({ runRoot: f.runRoot, runId }), 'inspectRun two-gate override');
    assert.equal(inspected.status.currentState?.counts.unresolvedOperations, 0);
  } finally {
    await new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    await f.cleanup();
  }
});

test('resumeCycleWithPorts refuses CAPABILITY_UNSUPPORTED when delegated format or implementation repair is needed, and reconcileCycle returns unresolved delegated_step_required on denied gate verdict', async () => {
  const f = await delegatedRepoFixture({
    multiRole: false,
    gateUrl: 'http://127.0.0.1:1/gate',
    maxFormatRepairs: 1,
    maxImplementationRepairs: 1,
    maxAttempts: 4,
    submissionPath: 'packages/sub.json',
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      const verdict = {
        version: 1,
        kind: 'gate_verdict',
        storeId: parsed.storeId,
        runId: parsed.runId,
        lockHash: parsed.lockHash,
        operationId: parsed.operationId,
        dispatchId: parsed.dispatchId,
        dispatchGeneration: parsed.dispatchGeneration,
        gateId: parsed.gateId,
        checkId: parsed.checkId,
        candidateDigest: parsed.candidateDigest,
        status: 'approved',
        reason: null,
        expiresAtMs: String(Date.now() + 600_000),
      };
      const bytes = Buffer.from(JSON.stringify(verdict));
      res.writeHead(200, {
        'content-type': 'application/json',
        connection: 'close',
        'x-loopwright-signature': signPayload(f.gateSecret, bytes),
      });
      res.end(bytes);
    })();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const livePort = (server.address() as { port: number }).port;
  const liveUrl = `http://127.0.0.1:${livePort}/gate`;

  try {
    // 1. Format repair case: interrupt right after role.1.post when submission at packages/sub.json is invalid
    const fmtRunId = 'run-resume-delegated-format-repair';
    const fmtStep1 = assertStepYield(
      assertOk(
        await stepNext({
          configuration: f.loaded,
          repository: f.repository,
          runRoot: f.runRoot,
          runId: fmtRunId,
          environment: name => f.environment[name],
        }),
        'stepNext format repair case',
      ),
    );
    await writeFile(join(fmtStep1.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: true }), { mode: 0o600 });
    await writeFile(join(fmtStep1.candidateDir, 'packages', 'sub.json'), '{not-valid-json', { mode: 0o600 });

    await assert.rejects(
      async () => {
        const res = await stepSubmit(
          {
            runRoot: f.runRoot,
            runId: fmtRunId,
            leaseToken: fmtStep1.leaseToken,
            environment: name => f.environment[name],
          },
          {
            afterCheckpoint: async phase => {
              if (phase === 'role.1.post') throw new Error('simulated crash after role.1.post');
            },
          },
        );
        if (!res.ok) throw new Error(res.error.code);
      },
    );

    const fmtBeforeInspect = assertOk(await inspectRun({ runRoot: f.runRoot, runId: fmtRunId }), 'inspect before resume');
    const fmtResume = await resumeCycleWithPorts({
      configuration: f.loaded,
      repository: f.repository,
      runRoot: f.runRoot,
      runId: fmtRunId,
    });
    assert.equal(fmtResume.ok, false);
    if (!fmtResume.ok) {
      assert.equal(fmtResume.error.code, 'CAPABILITY_UNSUPPORTED');
      assert.equal(fmtResume.error.path, '/spec/profiles/roles');
      assert.equal(fmtResume.error.phase, 'recovery');
    }
    const fmtAfterInspect = assertOk(await inspectRun({ runRoot: f.runRoot, runId: fmtRunId }), 'inspect after resume');
    assert.equal(fmtAfterInspect.status.status, 'in_progress');
    assert.equal(fmtAfterInspect.status.currentState?.counts.checkpoints, fmtBeforeInspect.status.currentState?.counts.checkpoints);

    // Subsequent stepNext yields repair: 'format' and completes the run!
    const fmtRepairStep = assertStepYield(
      assertOk(
        await stepNext(
          { runRoot: f.runRoot, runId: fmtRunId, environment: name => f.environment[name] },
          { gateUrlOverrides: { 'local-cmd': liveUrl } },
        ),
        'stepNext after refused resume yields format repair',
      ),
    );
    assert.equal(fmtRepairStep.repair, 'format');
    const fmtSettled = assertOk(
      await stepSubmit(
        {
          runRoot: f.runRoot,
          runId: fmtRunId,
          leaseToken: fmtRepairStep.leaseToken,
          status: 'completed',
          environment: name => f.environment[name],
        },
        { gateUrlOverrides: { 'local-cmd': liveUrl } },
      ),
      'stepSubmit format repair completion',
    );
    assert.equal(fmtSettled.kind, 'result');
    if (fmtSettled.kind === 'result') {
      assert.equal(fmtSettled.result.spec.status, 'completed');
    }

    // 2. Implementation repair + reconcileCycle case:
    // Interrupt after verify.1.1.pre with gate operation in dispatch_uncertain, then reconcile a 'denied' gate_verdict receipt via reconcileCycle!
    const implRunId = 'run-reconcile-denied-gate-impl-repair';
    const implStep1 = assertStepYield(
      assertOk(
        await stepNext({
          configuration: f.loaded,
          repository: f.repository,
          runRoot: f.runRoot,
          runId: implRunId,
          environment: name => f.environment[name],
        }),
        'stepNext impl repair case',
      ),
    );
    await writeFile(join(implStep1.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: true, v: 1 }), { mode: 0o600 });
    await writeFile(
      join(implStep1.candidateDir, 'packages', 'sub.json'),
      JSON.stringify({
        version: 1,
        status: 'completed',
        checks: [
          { checkId: 'tests', status: 'passed', evidenceId: null, reason: null },
          { checkId: 'gate-check', status: 'passed', evidenceId: null, reason: null },
        ],
        reason: null,
      }),
      { mode: 0o600 },
    );

    // Interrupt at role.1.post (before runStepTickWithCycle is entered); stepSubmit rethrows the afterCheckpoint error!
    await assert.rejects(
      async () => {
        const res = await stepSubmit(
          {
            runRoot: f.runRoot,
            runId: implRunId,
            leaseToken: implStep1.leaseToken,
            environment: name => f.environment[name],
          },
          {
            gateUrlOverrides: { 'local-cmd': liveUrl },
            afterCheckpoint: async phase => {
              if (phase === 'role.1.post') throw new Error('simulated crash after role.1.post');
            },
          },
        );
        if (!res.ok) throw new Error(res.error.code);
      },
    );

    // Calling resumeCycleWithPorts when a required check ('gate-check') is not yet confirmed passing and maxImplementationRepairs > 0 refuses CAPABILITY_UNSUPPORTED without mutating checkpoints or terminalizing as blocked!
    const implBeforeInspect = assertOk(await inspectRun({ runRoot: f.runRoot, runId: implRunId }), 'inspect before impl resume');
    const implResume = await resumeCycleWithPorts(
      {
        configuration: f.loaded,
        repository: f.repository,
        runRoot: f.runRoot,
        runId: implRunId,
      },
      { gateUrlOverrides: { 'local-cmd': liveUrl } },
    );
    assert.equal(implResume.ok, false);
    if (!implResume.ok) {
      assert.equal(implResume.error.code, 'CAPABILITY_UNSUPPORTED');
      assert.equal(implResume.error.path, '/spec/profiles/roles');
      assert.equal(implResume.error.phase, 'recovery');
    }
    const implAfterInspect = assertOk(await inspectRun({ runRoot: f.runRoot, runId: implRunId }), 'inspect after impl resume');
    assert.equal(implAfterInspect.status.status, 'in_progress');
    assert.equal(implAfterInspect.status.currentState?.counts.checkpoints, implBeforeInspect.status.currentState?.counts.checkpoints);

    // Now simulate an interrupted gate dispatch (dispatch_uncertain) on a separate run and reconcile a 'denied' external gate_verdict via reconcileCycle!
    const recRunId = 'run-reconcile-gate-denied';
    const recStep1 = assertStepYield(
      assertOk(
        await stepNext({
          configuration: f.loaded,
          repository: f.repository,
          runRoot: f.runRoot,
          runId: recRunId,
          environment: name => f.environment[name],
        }),
        'stepNext recRunId',
      ),
    );
    await writeFile(join(recStep1.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: true, v: 1 }), { mode: 0o600 });
    await writeFile(
      join(recStep1.candidateDir, 'packages', 'sub.json'),
      JSON.stringify({
        version: 1,
        status: 'completed',
        checks: [
          { checkId: 'tests', status: 'passed', evidenceId: null, reason: null },
          { checkId: 'gate-check', status: 'passed', evidenceId: null, reason: null },
        ],
        reason: null,
      }),
      { mode: 0o600 },
    );

    // Interrupt at role.1.post, then advance to verify.1.1.pre with an in-flight read_only gate operation + .binding.json (no .proof.json) to simulate SIGKILL mid-poll!
    await assert.rejects(
      async () => {
        const res = await stepSubmit(
          {
            runRoot: f.runRoot,
            runId: recRunId,
            leaseToken: recStep1.leaseToken,
            environment: name => f.environment[name],
          },
          {
            gateUrlOverrides: { 'local-cmd': liveUrl },
            afterCheckpoint: async phase => {
              if (phase === 'role.1.post') throw new Error('simulated crash after role.1.post');
            },
          },
        );
        if (!res.ok) throw new Error(res.error.code);
      },
    );

    const recRunDir = join(f.runRoot, recRunId);
    const descriptor = JSON.parse(await readFile(join(recRunDir, 'run.json'), 'utf8')) as {
      identity: import('@loopwright/state').LocalRunIdentity;
      plan: import('@loopwright/core').ArtifactRef;
      source: import('@loopwright/core').ArtifactRef;
    };
    const plan = JSON.parse(await readFile(join(recRunDir, 'artifacts', descriptor.plan.name), 'utf8')) as import('../src/types.js').CompiledPlan;
    const owner = await ControllerOwner.acquire(recRunDir, recRunId, plan.planDigest);
    const store = stateValue(reopenLocalRun(descriptor.identity));
    let gateOpId: string;
    let gateDispatchId: string;
    let gateDispatchGen: number;
    let storeId: string;
    let lockHash: import('@loopwright/core').Digest;
    let candidateDigestHex: string;
    try {
      const view = stateValue(store.inspect());
      storeId = view.storeId;
      lockHash = view.lockHash;
      const authority = stateValue(
        store.claim({
          ownerId: 'controller.' + owner.nonce,
          expectedGeneration: view.owner.generation,
          expectedRevision: view.revision,
          mode: 'active',
        }),
      ).authority;
      const artifacts = new ArtifactStore(join(recRunDir, 'artifacts'), owner, approvedState(f.loaded).vault);
      const progress = new ProgressStore(store, authority, artifacts, plan, descriptor.identity.lock, descriptor.plan, descriptor.source);
      const head0 = (await progress.read())!;
      const candManifest = await progress.manifest(head0.progress.candidate.manifest);
      const nonce = '11223344556677889900aabbccddeeff';
      const job = prepareGate(
        plan,
        descriptor.identity.lock,
        'check.gate-check',
        { manifest: candManifest, ref: head0.progress.candidate.manifest, files: [] },
        1,
        nonce,
        f.loaded.registry.spec.gateEndpoints,
      );
      const head = await progress.publish(
        {
          ...head0.progress,
          stage: { ...head0.progress.stage, kind: 'verifier_pre' },
          verifierReceipts: [
            ...head0.progress.verifierReceipts,
            {
              slot: 'check.gate-check',
              generation: 1,
              operationId: job.operationId,
              producerNonce: nonce,
              output: null,
              receipt: null,
            },
          ],
        },
        'verify.1.1.pre',
      );
      const subject = head.checkpoint.subject;
      candidateDigestHex = subject.candidateDigest.hex;
      stateValue(
        store.putIntent(authority, {
          operationId: job.operationId,
          nodeId: plan.orderedDAG[0]!.id,
          attemptId: 'job.' + hash(job.operationId + '\0' + nonce).hex.slice(0, 40),
          effect: 'read_only',
          requestDigest: job.requestDigest,
          targetIdentity: 'gate:check.gate-check:1:' + candidateDigestHex,
        }),
      );
      const dispatched = stateValue(store.authorizeOperationDispatch(authority, job.operationId));
      assert.equal(dispatched.kind, 'new_dispatch');
      if (dispatched.kind !== 'new_dispatch') throw new Error('expected new_dispatch');
      const op = stateValue(store.getOperation(job.operationId));
      gateOpId = job.operationId;
      gateDispatchId = dispatched.permit.dispatchId;
      gateDispatchGen = dispatched.permit.generation;
      const request: Record<string, unknown> = {
        version: 1,
        kind: 'gate_request',
        gateId: 'cmd-gate',
        checkId: 'gate-check',
        candidateDigest: candidateDigestHex,
        subject,
        storeId,
        runId: recRunId,
        lockHash,
        operationId: job.operationId,
        dispatchId: gateDispatchId,
        dispatchGeneration: gateDispatchGen,
        requestDigest: job.requestDigest.hex,
      };
      const prefix = join(artifacts.directory, 'gate-producer-' + hash(job.operationId + '\0' + nonce).hex);
      await writeFile(
        prefix + '.binding.json',
        canonical({
          version: 1,
          planDigest: plan.planDigest,
          operationId: job.operationId,
          producerNonce: nonce,
          requestDigest: job.requestDigest,
          requestBytesDigest: hash(Buffer.from(canonical(request))).hex,
          intentDigest: op.intentDigest,
          subject,
          generation: 1,
          endpoint: 'local-cmd',
          dispatchReceipt: {
            generation: dispatched.permit.generation,
            dispatchId: dispatched.permit.dispatchId,
            revision: dispatched.permit.authorizedRevision,
            clockEpoch: dispatched.permit.clockEpoch,
          },
        }),
        { mode: 0o600 },
      );
      stateValue(store.release(authority));
    } finally {
      stateValue(store.close());
      await owner.release();
    }

    const deniedVerdictBody = {
      version: 1,
      kind: 'gate_verdict',
      storeId,
      runId: recRunId,
      lockHash,
      operationId: gateOpId,
      dispatchId: gateDispatchId,
      dispatchGeneration: gateDispatchGen,
      gateId: 'cmd-gate',
      checkId: 'gate-check',
      candidateDigest: candidateDigestHex,
      status: 'denied' as const,
      reason: 'external_gate_denied_needs_impl_repair',
      expiresAtMs: String(Date.now() + 300_000),
    };
    const receiptPath = join(f.root, 'denied-gate-verdict.json');
    await writeFile(
      receiptPath,
      JSON.stringify({ ...deniedVerdictBody, signature: signPayload(f.gateSecret, canonical(deniedVerdictBody)) }),
      { mode: 0o600 },
    );

    const reconciled1 = assertOk(
      await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId: recRunId, receipt: receiptPath }),
      'reconcileCycle denied gate verdict on delegated run',
    );
    assert.deepEqual(reconciled1, {
      kind: 'unresolved',
      version: 1,
      runId: recRunId,
      reason: 'delegated_step_required',
    });

    // Idempotent replay when operation.state === 'confirmed' and !head.progress.stage.kind.startsWith('terminal') returns the exact same unresolved result!
    const reconciled2 = assertOk(
      await reconcileCycle({ configuration: f.loaded, runRoot: f.runRoot, runId: recRunId, receipt: receiptPath }),
      'reconcileCycle idempotent replay',
    );
    assert.deepEqual(reconciled2, reconciled1);

    // Subsequent stepNext yields repair: 'implementation' with the gate denial reason, and completes the run!
    const recRepairStep = assertStepYield(
      assertOk(
        await stepNext(
          { runRoot: f.runRoot, runId: recRunId, environment: name => f.environment[name] },
          { gateUrlOverrides: { 'local-cmd': liveUrl } },
        ),
        'stepNext after reconcileCycle yields implementation repair',
      ),
    );
    assert.equal(recRepairStep.repair, 'implementation');
    assert.match(recRepairStep.prompt, /external_gate_denied_needs_impl_repair/);

    await writeFile(join(recRepairStep.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: true, v: 2 }), { mode: 0o600 });
    const recSettled = assertOk(
      await stepSubmit(
        {
          runRoot: f.runRoot,
          runId: recRunId,
          leaseToken: recRepairStep.leaseToken,
          status: 'completed',
          environment: name => f.environment[name],
        },
        { gateUrlOverrides: { 'local-cmd': liveUrl } },
      ),
      'stepSubmit after implementation repair',
    );
    assert.equal(recSettled.kind, 'result');
    if (recSettled.kind === 'result') {
      assert.equal(recSettled.result.spec.status, 'completed');
    }
  } finally {
    await new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    await f.cleanup();
  }
});
