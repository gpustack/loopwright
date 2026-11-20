import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { admitTask } from '@loopwright/core';
import { compilePlan, checkpointCapacity } from '../src/compile.js';
import { installedHandlerDigests } from '../src/handlers.js';
import { hash } from '../src/schema.js';
import type { ControllerResult } from '../src/errors.js';
import { configurationFixture } from './config-fixtures.js';

function assertOk<T>(result: ControllerResult<T>, msg = ''): T {
  assert.equal(result.ok, true, `${msg}: ${result.ok ? '' : JSON.stringify(result.error)}`);
  if (!result.ok) throw new Error('expected ok');
  return result.value;
}

function set(value: unknown, path: readonly (string | number)[], replacement: unknown): void {
  let parent = value as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
  parent[path.at(-1)!] = replacement;
}

test('compilePlan allows non-null target.matrix when no check requires hardware_execution and binds targetMatrixDigest', async () => {
  const f = await configurationFixture();
  try {
    set(f.config, ['spec', 'task', 'spec', 'target', 'matrix'], [
      { id: 'cuda-sm90', platform: 'linux-x64', variant: 'sm90' },
      { id: 'rocm-gfx942', platform: 'linux-x64', variant: 'gfx942' },
    ]);
    await f.save();
    const loaded = assertOk(await f.load(), 'load target.matrix config');
    const plan = assertOk(await compilePlan(loaded), 'compile target.matrix plan');
    assert.equal(plan.task.spec.target.matrix?.length, 2);
    assert.equal(plan.task.spec.target.matrix?.[0]?.id, 'cuda-sm90');

    const lockRes = admitTask(plan.task, { admissionId: 'adm-matrix', runId: 'run-matrix' });
    assert.equal(lockRes.ok, true);
  } finally {
    await f.cleanup();
  }
});

test('compilePlan still refuses any check requiring hardware_execution with CAPABILITY_UNSUPPORTED', async () => {
  for (const matrix of [null, [{ id: 'cuda-sm90', platform: 'linux-x64', variant: 'sm90' }]] as const) {
    const f = await configurationFixture();
    try {
      set(f.config, ['spec', 'task', 'spec', 'target', 'matrix'], matrix);
      set(f.config, ['spec', 'task', 'spec', 'acceptance'], {
        required: ['tests'],
        checks: [{ id: 'tests', allowedEvidenceLevels: ['hardware_execution'] }],
      });
      await f.save();
      const loaded = assertOk(await f.load(), 'load hardware_execution config');
      const compiled = await compilePlan(loaded);
      assert.equal(compiled.ok, false);
      if (!compiled.ok) {
        assert.equal(compiled.error.code, 'CAPABILITY_UNSUPPORTED');
        assert.equal(compiled.error.phase, 'compile');
      }
    } finally {
      await f.cleanup();
    }
  }
});

test('compilePlan validates steps[].onRework strict-ancestor edges, maxReworks 1..8, and compact prohibition', async () => {
  const f = await configurationFixture();
  try {
    const installed = await installedHandlerDigests();
    set(f.registry, ['spec', 'handlers'], [
      ...f.registry.spec.handlers,
      {
        id: 'review.handler',
        kind: 'agent',
        implementation: 'pi.agent.v1',
        version: 1,
        digest: installed['pi.agent.v1'],
        parameters: { prompt: 'Review candidate.', purpose: 'review' },
        capabilities: ['pi'],
      },
      {
        id: 'compact.handler',
        kind: 'agent',
        implementation: 'pi.compact.v1',
        version: 1,
        digest: installed['pi.compact.v1'],
        parameters: {},
        capabilities: ['pi', 'compaction'],
      },
    ]);
    set(f.config, ['spec', 'controls', 'maxAttempts'], 10);
    set(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'plan', kind: 'agent', uses: 'package.patch', roleId: 'builder', dependsOn: [] },
      { id: 'implement', kind: 'agent', uses: 'package.patch', roleId: 'builder', dependsOn: ['plan'] },
      { id: 'fast-check', kind: 'check', uses: 'tests', roleId: null, dependsOn: ['implement'] },
      {
        id: 'review',
        kind: 'agent',
        uses: 'review.handler',
        roleId: 'builder',
        dependsOn: ['fast-check'],
        onRework: { rejectTo: 'implement', maxReworks: 8 },
      },
    ]);
    set(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'plan', handlerRef: 'package.patch' },
      { stepId: 'implement', handlerRef: 'package.patch' },
      { stepId: 'fast-check', handlerRef: 'tests' },
      { stepId: 'review', handlerRef: 'review.handler' },
    ]);
    await f.save();

    const loaded = assertOk(await f.load(), 'load valid rework DAG');
    const plan = assertOk(await compilePlan(loaded), 'compile valid rework DAG');
    const reviewNode = plan.orderedDAG.find(node => node.id === 'review');
    assert.deepEqual(reviewNode?.onRework, { rejectTo: 'implement', maxReworks: 8 });
    assert.equal(plan.orderedDAG.find(node => node.id === 'plan')?.onRework, undefined);

    // Non-ancestor rejectTo mutated on loaded configuration refuses at compilePlan
    const siblingLoaded = structuredClone(loaded);
    // Re-load cleanly then test compilePlan refusal when compact step declares onRework
    set(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'implement', kind: 'agent', uses: 'package.patch', roleId: 'builder', dependsOn: [] },
      {
        id: 'compact',
        kind: 'agent',
        uses: 'compact.handler',
        roleId: 'builder',
        dependsOn: ['implement'],
        onRework: { rejectTo: 'implement', maxReworks: 1 },
      },
    ]);
    set(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'implement', handlerRef: 'package.patch' },
      { stepId: 'compact', handlerRef: 'compact.handler' },
    ]);
    await f.save();
    const compactLoaded = assertOk(await f.load(), 'load compact rework');
    const compactCompiled = await compilePlan(compactLoaded);
    assert.equal(compactCompiled.ok, false);
    if (!compactCompiled.ok) assert.equal(compactCompiled.error.code, 'CAPABILITY_UNSUPPORTED');
    void siblingLoaded;

    // Non-ancestor / cycle / maxReworks out-of-range rejected by config/compile
    for (const badSteps of [
      // rejectTo self
      [
        { id: 'implement', kind: 'agent', uses: 'package.patch', roleId: 'builder', dependsOn: [], onRework: { rejectTo: 'implement', maxReworks: 1 } },
      ],
      // rejectTo sibling (not a strict ancestor)
      [
        { id: 'branch-a', kind: 'agent', uses: 'package.patch', roleId: 'builder', dependsOn: [] },
        { id: 'branch-b', kind: 'agent', uses: 'review.handler', roleId: 'builder', dependsOn: [], onRework: { rejectTo: 'branch-a', maxReworks: 1 } },
      ],
      // rejectTo descendant
      [
        { id: 'plan', kind: 'agent', uses: 'package.patch', roleId: 'builder', dependsOn: [], onRework: { rejectTo: 'review', maxReworks: 1 } },
        { id: 'review', kind: 'agent', uses: 'review.handler', roleId: 'builder', dependsOn: ['plan'] },
      ],
      // maxReworks: 0
      [
        { id: 'plan', kind: 'agent', uses: 'package.patch', roleId: 'builder', dependsOn: [] },
        { id: 'review', kind: 'agent', uses: 'review.handler', roleId: 'builder', dependsOn: ['plan'], onRework: { rejectTo: 'plan', maxReworks: 0 } },
      ],
      // maxReworks: 9 (> 8)
      [
        { id: 'plan', kind: 'agent', uses: 'package.patch', roleId: 'builder', dependsOn: [] },
        { id: 'review', kind: 'agent', uses: 'review.handler', roleId: 'builder', dependsOn: ['plan'], onRework: { rejectTo: 'plan', maxReworks: 9 } },
      ],
    ]) {
      set(f.config, ['spec', 'task', 'spec', 'steps'], badSteps);
      set(
        f.config,
        ['spec', 'profiles', 'steps'],
        badSteps.map(s => ({ stepId: s.id, handlerRef: s.uses })),
      );
      await f.save();
      const loadedBad = await f.load();
      const outcome = loadedBad.ok ? await compilePlan(loadedBad.value) : loadedBad;
      assert.equal(outcome.ok, false, `expected failure for ${JSON.stringify(badSteps)}`);
    }
  } finally {
    await f.cleanup();
  }
});

test('compilePlan scales 16-step DAG + rework checkpoint and attempt budgets up to 256 checkpoints', async () => {
  // Worked 256 exact fit: A=40, N=16, I=2, C=3, pub=false => V=19, J=57, D = 4 + 120 + 114 = 238 <= 256
  const cap238 = checkpointCapacity(40, 16, 2, 3, false);
  assert.equal(cap238.D, 238);
  // Exact 256: A=46, N=16, I=2, C=3, pub=false => V=19, J=57, D = 4 + 138 + 114 = 256
  const cap256 = checkpointCapacity(46, 16, 2, 3, false);
  assert.equal(cap256.D, 256);
  // 257+ refuses CONFIG_LIMIT
  assert.throws(() => checkpointCapacity(46, 16, 2, 3, true));
  assert.throws(() => checkpointCapacity(47, 16, 2, 3, false));

  const f = await configurationFixture();
  try {
    const installed = await installedHandlerDigests();
    set(f.registry, ['spec', 'handlers'], [
      ...f.registry.spec.handlers,
      {
        id: 'review.handler',
        kind: 'agent',
        implementation: 'pi.agent.v1',
        version: 1,
        digest: installed['pi.agent.v1'],
        parameters: { prompt: 'Review 16-step pipeline.', purpose: 'review' },
        capabilities: ['pi'],
      },
    ]);
    const steps: Record<string, unknown>[] = [];
    const profileSteps: Record<string, unknown>[] = [];
    for (let i = 1; i <= 14; i++) {
      const id = `step-${i}`;
      steps.push({
        id,
        kind: 'agent',
        uses: 'package.patch',
        roleId: 'builder',
        dependsOn: i === 1 ? [] : [`step-${i - 1}`],
      });
      profileSteps.push({ stepId: id, handlerRef: 'package.patch' });
    }
    steps.push({
      id: 'fast-check',
      kind: 'check',
      uses: 'tests',
      roleId: null,
      dependsOn: ['step-14'],
    });
    profileSteps.push({ stepId: 'fast-check', handlerRef: 'tests' });
    steps.push({
      id: 'review',
      kind: 'agent',
      uses: 'review.handler',
      roleId: 'builder',
      dependsOn: ['fast-check'],
      onRework: { rejectTo: 'step-12', maxReworks: 3 },
    });
    profileSteps.push({ stepId: 'review', handlerRef: 'review.handler' });

    set(f.config, ['spec', 'task', 'spec', 'steps'], steps);
    set(f.config, ['spec', 'profiles', 'steps'], profileSteps);
    set(f.config, ['spec', 'controls', 'maxAttempts'], 28);
    set(f.config, ['spec', 'task', 'spec', 'budgets', 'maxModelCalls'], 64);
    await f.save();

    const loaded = assertOk(await f.load(), 'load 16-step rework config');
    const plan = assertOk(await compilePlan(loaded), 'compile 16-step rework plan');
    assert.equal(plan.orderedDAG.length, 16);
    assert.ok(plan.capacity.D > 64 && plan.capacity.D <= 256, `expected 64 < D <= 256, got ${plan.capacity.D}`);
    assert.equal(plan.capacity.A, 28);
  } finally {
    await f.cleanup();
  }
});

test('compilePlan filters PlannedRole.policy.resources per role.resourceIds', async () => {
  const f = await configurationFixture();
  try {
    const resABytes = Buffer.from('Role A guide\n');
    const resBBytes = Buffer.from('Role B guide\n');
    const resA = { id: 'guide-a', kind: 'instruction' as const, path: 'guide-a.md', digest: hash(resABytes) };
    const resB = { id: 'guide-b', kind: 'skill' as const, path: 'guide-b.md', digest: hash(resBBytes) };
    await writeFile(join(f.operator, resA.path), resABytes, { mode: 0o600 });
    await writeFile(join(f.operator, resB.path), resBBytes, { mode: 0o600 });

    set(f.registry, ['spec', 'resources'], [resA, resB]);
    set(f.config, ['spec', 'task', 'spec', 'trustedContext', 'resources'], [resA, resB]);
    const baseRoleProfile = f.registry.spec.roleProfiles[0]!;
    set(f.registry, ['spec', 'roleProfiles'], [
      baseRoleProfile,
      {
        id: 'reviewer',
        adapter: 'delegated',
        runtimeRef: null,
        providerCredentialRef: null,
        selection: { provider: 'antigravity', model: 'gemini-4-argon', thinking: 'low' },
        tools: ['read'],
        mcp: null,
      },
      {
        id: 'auditor',
        adapter: 'delegated',
        runtimeRef: null,
        providerCredentialRef: null,
        selection: { provider: 'antigravity', model: 'gemini-4-argon', thinking: 'low' },
        tools: ['read'],
        mcp: null,
      },
    ]);
    set(f.config, ['spec', 'task', 'spec', 'roles'], [
      { ...f.config.spec.task.spec.roles[0]!, resourceIds: ['guide-a'] },
      { id: 'reviewer', adapter: 'delegated', provider: 'antigravity', model: 'gemini-4-argon', thinking: 'low', tools: ['read'], resourceIds: [] },
      { id: 'auditor', adapter: 'delegated', provider: 'antigravity', model: 'gemini-4-argon', thinking: 'low', tools: ['read'] },
    ]);
    set(f.config, ['spec', 'profiles', 'roles'], [
      { roleId: 'builder', profileRef: 'builder' },
      { roleId: 'reviewer', profileRef: 'reviewer' },
      { roleId: 'auditor', profileRef: 'auditor' },
    ]);
    await f.save();

    const loaded = assertOk(await f.load(), 'load resourceIds config');
    const plan = assertOk(await compilePlan(loaded), 'compile resourceIds plan');

    const builderRole = plan.roles.find(r => r.roleId === 'builder')!;
    const reviewerRole = plan.roles.find(r => r.roleId === 'reviewer')!;
    const auditorRole = plan.roles.find(r => r.roleId === 'auditor')!;

    assert.deepEqual(builderRole.policy.resources.map(r => r.id), ['loopwright-preamble', 'guide-a']);
    assert.deepEqual(reviewerRole.policy.resources.map(r => r.id), ['loopwright-preamble']);
    assert.deepEqual(auditorRole.policy.resources.map(r => r.id), ['loopwright-preamble', 'guide-a', 'guide-b']);
  } finally {
    await f.cleanup();
  }
});

test('compilePlan refuses onRework.rejectTo targeting pi.compact.v1 and sizes check-step onRework generations', async () => {
  const f = await configurationFixture();
  try {
    const installed = await installedHandlerDigests();
    set(f.registry, ['spec', 'handlers'], [
      ...f.registry.spec.handlers,
      { id: 'compact.h', kind: 'agent', implementation: 'pi.compact.v1', version: 1, digest: installed['pi.compact.v1'], parameters: {}, capabilities: ['pi', 'compaction'] },
      { id: 'review.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Review.', purpose: 'review' }, capabilities: ['pi'] },
    ]);
    set(f.config, ['spec', 'controls', 'maxAttempts'], 6);
    set(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'build', kind: 'agent', uses: 'package.patch', roleId: 'builder', dependsOn: [] },
      { id: 'compact', kind: 'agent', uses: 'compact.h', roleId: 'builder', dependsOn: ['build'] },
      { id: 'review', kind: 'agent', uses: 'review.h', roleId: 'builder', dependsOn: ['compact'], onRework: { rejectTo: 'compact', maxReworks: 1 } },
    ]);
    set(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'build', handlerRef: 'package.patch' },
      { stepId: 'compact', handlerRef: 'compact.h' },
      { stepId: 'review', handlerRef: 'review.h' },
    ]);
    await f.save();
    const badLoaded = assertOk(await f.load(), 'load rejectTo compact config');
    const badCompiled = await compilePlan(badLoaded);
    assert.equal(badCompiled.ok, false);
    if (!badCompiled.ok) {
      assert.equal(badCompiled.error.code, 'CAPABILITY_UNSUPPORTED');
      assert.equal(badCompiled.error.path, '/spec/profiles/steps');
    }

    // Valid kind: 'check' step with onRework allocates generation headroom beyond A alone
    set(f.registry, ['spec', 'roleProfiles', 0, 'tools'], ['read', 'write']);
    set(f.config, ['spec', 'task', 'spec', 'roles', 0, 'tools'], ['read', 'write']);
    set(f.config, ['spec', 'controls', 'maxAttempts'], 3);
    set(f.config, ['spec', 'task', 'spec', 'budgets', 'maxImplementationRepairs'], 0);
    set(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'build', kind: 'agent', uses: 'package.patch', roleId: 'builder', dependsOn: [] },
      { id: 'verify', kind: 'check', uses: 'tests', roleId: null, dependsOn: ['build'], onRework: { rejectTo: 'build', maxReworks: 2 } },
    ]);
    set(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'build', handlerRef: 'package.patch' },
      { stepId: 'verify', handlerRef: 'tests' },
    ]);
    await f.save();
    const okLoaded = assertOk(await f.load(), 'load check-rework config');
    const okCompiled = assertOk(await compilePlan(okLoaded), 'compile check-rework plan');
    // 1 initial + 3 build mutations + 2 check reworks -> V = 6 (would have been capped at 4 without K!)
    assert.equal(okCompiled.capacity.V, 6);
  } finally {
    await f.cleanup();
  }
});
