import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { validateDocument } from '@loopwright/core';
import { inspectRun, loadTrustedConfiguration, stepNext, stepSubmit } from '@loopwright/controller';
import {
  assertDigestLockfileVerified,
  assertManifestScopeInvariants,
  collectManifestControlPlanePaths,
  collectTaskpackDigestTargets,
  compileDeclarativeTaskpack,
  computeTaskpackDigests,
  DEFAULT_HOST_BUDGETS,
  deriveManifestCompiledScope,
  effectiveProtectedPaths,
  extractTaskpackResourcePaths,
  INSTRUCTION_MAX_AGGREGATE_BYTES,
  loadDeclarativeTaskpack,
  openStagedTaskpackStepGate,
  parseTaskpackManifest,
  resolveEffectiveProtectedPaths,
  resolveTaskpackResourcePath,
  resolveTaskpackResourceWhen,
  serializePrettyYaml,
  stageTaskpackForStep,
  TaskpackError,
  validateTaskpackV2Manifest,
  verifyDigestLockfile,
  writeDigestLockfile,
  type Json,
  type StepHandoffSelector,
} from '../src/index.js';

function initGitRepo(repoRoot: string): string {
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.name', 'Loopwright Test'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.email', 'test@loopwright.invalid'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoRoot, stdio: 'ignore' });
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
}

async function removeTreeForce(targetDir: string): Promise<void> {
  const unlock = async (dir: string): Promise<void> => {
    await chmod(dir, 0o700).catch(() => undefined);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await unlock(join(dir, entry.name));
      }
    }
  };
  await unlock(targetDir);
  await rm(targetDir, { recursive: true, force: true });
}

function nullProto<T extends Record<string, unknown>>(entries: T): T {
  const out = Object.create(null) as Record<string, unknown>;
  for (const [k, v] of Object.entries(entries)) {
    out[k] = v;
  }
  return out as T;
}

function baseMultiRoleManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'Taskpack',
    metadata: { name: 'handoff-rules-demo' },
    spec: {
      goal: {
        candidate: 'Plan, implement, and review scoped changes.',
        noChange: 'Confirm repository requires no changes.',
      },
      scope: {
        writable: ['src/**', '.loopwright/proposal.json'],
        protected: [],
      },
      proposal: {
        path: '.loopwright/proposal.json',
        schemaVersion: 1,
        requiredFields: ['schema_version', 'summary'],
      },
      verification: {
        localChecks: [
          { id: 'proposal-check', implementation: 'json-artifact.v1' },
        ],
        externalGates: [],
      },
      publication: { mode: 'disabled' },
      roles: [
        { id: 'plan', purpose: 'task', provider: 'delegated', model: 'default', tools: ['read', 'write', 'edit'] },
        { id: 'implement', purpose: 'task', provider: 'delegated', model: 'default', dependsOn: ['plan'], tools: ['read', 'write', 'edit'] },
        { id: 'review', purpose: 'review', provider: 'delegated', model: 'default', dependsOn: ['implement'], tools: ['read'] },
      ],
      ...overrides,
    },
  };
}

describe('handoff-and-rules.test.ts: taskpack handoffs, conditional rules, lockfile digests, scope protection, and controller integration', () => {
  it('parses and compiles spec.steps[].handoffs and spec.roles[].handoffs, enforces strict ancestors, bounds, RFC 6901 prototype keys, and null-prototype safety', async () => {
    const stepHandoffs: readonly StepHandoffSelector[] = [
      {
        id: 'plan-changes',
        fromStep: 'plan',
        source: { kind: 'artifact', path: 'src/plan.md' },
        select: { kind: 'markdown_heading', heading: '## File Changes', includeSubheadings: true },
        maxBytes: 4_096,
        required: true,
      },
      {
        id: 'plan-constraints',
        fromStep: 'plan',
        source: { kind: 'artifact', path: 'src/plan.json' },
        select: { kind: 'json_pointer', pointers: ['/constraints', '/a~1b/m~0n', ''] },
        maxBytes: 2_048,
        required: false,
      },
    ];
    const roleHandoff: StepHandoffSelector = {
      id: 'role-sub',
      fromStep: 'plan',
      source: { kind: 'submission' },
      select: { kind: 'full' },
      maxBytes: 1_024,
    };

    // 1. Explicit spec.steps: step-level handoffs override role-level handoffs; role-level inherits when step omits handoffs
    const explicitRaw = baseMultiRoleManifest({
      roles: [
        { id: 'plan', purpose: 'task', provider: 'delegated', model: 'default', tools: ['read', 'write', 'edit'] },
        { id: 'implement', purpose: 'task', provider: 'delegated', model: 'default', handoffs: [roleHandoff], tools: ['read', 'write', 'edit'] },
        { id: 'review', purpose: 'review', provider: 'delegated', model: 'default', handoffs: [{ id: 'rev-h', fromStep: 'implement', source: { kind: 'verdict' }, select: { kind: 'full' }, required: false }], tools: ['read'] },
      ],
      steps: [
        { id: 'plan', kind: 'agent', role: 'plan', dependsOn: [] },
        { id: 'implement', kind: 'agent', role: 'implement', dependsOn: ['plan'], handoffs: stepHandoffs },
        { id: 'review', kind: 'agent', role: 'review', dependsOn: ['implement'] },
        { id: 'proposal-check', kind: 'check', check: 'proposal-check', dependsOn: ['review'] },
      ],
    });
    const parsedExplicit = validateTaskpackV2Manifest(explicitRaw as unknown as Json);
    const compiledExplicit = await compileDeclarativeTaskpack(parsedExplicit, {
      mode: 'candidate',
      executionMode: 'delegated',
      repository: 'org/repo',
      baseRevision: 'main',
      sourceRevision: 'main',
      budgets: DEFAULT_HOST_BUDGETS,
    });
    const taskContract = compiledExplicit.config.spec.task;
    assert.equal(validateDocument(taskContract, 'TaskContract').ok, true);
    const implStep = taskContract.spec.steps.find(s => s.id === 'implement');
    const revStep = taskContract.spec.steps.find(s => s.id === 'review');
    const checkStep = taskContract.spec.steps.find(s => s.id === 'proposal-check');
    assert.deepEqual(JSON.parse(JSON.stringify(implStep?.handoffs)), stepHandoffs);
    assert.equal(revStep?.handoffs?.length, 1);
    assert.equal(revStep?.handoffs?.[0]?.fromStep, 'implement');
    assert.equal(checkStep?.handoffs, undefined);

    // 2. no-change mode NEVER attaches handoffs to any step
    const compiledNoChange = await compileDeclarativeTaskpack(parsedExplicit, {
      mode: 'no-change',
      executionMode: 'delegated',
      repository: 'org/repo',
      baseRevision: 'main',
      sourceRevision: 'main',
      budgets: DEFAULT_HOST_BUDGETS,
    });
    assert.equal(validateDocument(compiledNoChange.config.spec.task, 'TaskContract').ok, true);
    for (const step of compiledNoChange.config.spec.task.spec.steps) {
      assert.equal(step.handoffs, undefined);
    }

    // 3. Role-based DAG (spec.steps omitted): role.handoffs validated against role DAG ancestors and compiled into TaskContract
    const roleDagRaw = baseMultiRoleManifest({
      roles: [
        { id: 'plan', purpose: 'task', provider: 'delegated', model: 'default', tools: ['read', 'write', 'edit'] },
        { id: 'implement', purpose: 'task', provider: 'delegated', model: 'default', dependsOn: ['plan'], handoffs: [roleHandoff], tools: ['read', 'write', 'edit'] },
        { id: 'review', purpose: 'review', provider: 'delegated', model: 'default', dependsOn: ['implement'], handoffs: [{ fromStep: 'plan', source: { kind: 'artifact', path: 'src/plan.md' }, select: { kind: 'markdown_heading', heading: '## C#' } }], tools: ['read'] },
      ],
    });
    const parsedRoleDag = validateTaskpackV2Manifest(roleDagRaw as unknown as Json);
    const compiledRoleDag = await compileDeclarativeTaskpack(parsedRoleDag, {
      mode: 'candidate',
      executionMode: 'delegated',
      repository: 'org/repo',
      baseRevision: 'main',
      sourceRevision: 'main',
      budgets: DEFAULT_HOST_BUDGETS,
    });
    assert.equal(validateDocument(compiledRoleDag.config.spec.task, 'TaskContract').ok, true);
    assert.equal(compiledRoleDag.config.spec.task.spec.steps.find(s => s.id === 'implement')?.handoffs?.[0]?.fromStep, 'plan');
    assert.equal(compiledRoleDag.config.spec.task.spec.steps.find(s => s.id === 'review')?.handoffs?.[0]?.fromStep, 'plan');

    // 4. Null-prototype records (`Object.create(null)`) for steps, roles, handoffs, source, and select
    const nullProtoManifest = nullProto({
      ...baseMultiRoleManifest({
        steps: [
          nullProto({ id: 'plan', kind: 'agent', role: 'plan', dependsOn: [] }),
          nullProto({
            id: 'implement',
            kind: 'agent',
            role: 'implement',
            dependsOn: ['plan'],
            handoffs: [
              nullProto({
                id: 'np-handoff',
                fromStep: 'plan',
                source: nullProto({ kind: 'artifact', path: 'src/plan.md' }),
                select: nullProto({ kind: 'markdown_heading', heading: '## File Changes', includeSubheadings: false }),
                maxBytes: 256,
                required: true,
              }),
            ],
          }),
        ],
      }),
    });
    const parsedNullProto = validateTaskpackV2Manifest(nullProtoManifest as unknown as Json);
    assert.equal(parsedNullProto.spec.steps?.[1]?.handoffs?.[0]?.id, 'np-handoff');

    // 5. Reject handoffs on `check` and `compact` steps
    assert.throws(
      () => validateTaskpackV2Manifest(baseMultiRoleManifest({
        steps: [
          { id: 'plan', kind: 'agent', role: 'plan', dependsOn: [] },
          { id: 'proposal-check', kind: 'check', check: 'proposal-check', dependsOn: ['plan'], handoffs: [roleHandoff] },
        ],
      }) as unknown as Json),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );
    assert.throws(
      () => validateTaskpackV2Manifest(baseMultiRoleManifest({
        roles: [
          { id: 'plan', purpose: 'task', provider: 'openai', model: 'gpt-5', tools: ['read', 'write'] },
        ],
        steps: [
          { id: 'plan', kind: 'agent', role: 'plan', dependsOn: [] },
          { id: 'compact-plan', kind: 'compact', role: 'plan', dependsOn: ['plan'], handoffs: [roleHandoff] },
        ],
      }) as unknown as Json),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );

    // 6. Strict ancestor enforcement (unknown, self, sibling, descendant, compact target, and role-DAG non-ancestor)
    for (const badFromStep of ['nonexistent', 'implement', 'sibling', 'review']) {
      assert.throws(
        () => validateTaskpackV2Manifest(baseMultiRoleManifest({
          roles: [
            { id: 'plan', purpose: 'task', provider: 'delegated', model: 'default' },
            { id: 'sibling', purpose: 'task', provider: 'delegated', model: 'default' },
            { id: 'implement', purpose: 'task', provider: 'delegated', model: 'default' },
            { id: 'review', purpose: 'review', provider: 'delegated', model: 'default' },
          ],
          steps: [
            { id: 'plan', kind: 'agent', role: 'plan', dependsOn: [] },
            { id: 'sibling', kind: 'agent', role: 'sibling', dependsOn: ['plan'] },
            {
              id: 'implement',
              kind: 'agent',
              role: 'implement',
              dependsOn: ['plan'],
              handoffs: [{ fromStep: badFromStep, source: { kind: 'submission' }, select: { kind: 'full' } }],
            },
            { id: 'review', kind: 'agent', role: 'review', dependsOn: ['implement'] },
          ],
        }) as unknown as Json),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
        `expected non-ancestor fromStep "${badFromStep}" to fail`,
      );
    }
    // Role-based DAG non-ancestor refusal
    assert.throws(
      () => validateTaskpackV2Manifest(baseMultiRoleManifest({
        roles: [
          { id: 'plan', purpose: 'task', provider: 'delegated', model: 'default' },
          { id: 'sibling', purpose: 'task', provider: 'delegated', model: 'default', dependsOn: ['plan'] },
          {
            id: 'implement',
            purpose: 'task',
            provider: 'delegated',
            model: 'default',
            dependsOn: ['plan'],
            handoffs: [{ fromStep: 'sibling', source: { kind: 'submission' }, select: { kind: 'full' } }],
          },
        ],
      }) as unknown as Json),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );
    // Compact step as fromStep target refused
    assert.throws(
      () => validateTaskpackV2Manifest(baseMultiRoleManifest({
        roles: [
          { id: 'plan', purpose: 'task', provider: 'openai', model: 'gpt-5' },
          { id: 'implement', purpose: 'task', provider: 'openai', model: 'gpt-5' },
        ],
        steps: [
          { id: 'plan', kind: 'agent', role: 'plan', dependsOn: [] },
          { id: 'compact-plan', kind: 'compact', role: 'plan', dependsOn: ['plan'] },
          {
            id: 'implement',
            kind: 'agent',
            role: 'implement',
            dependsOn: ['compact-plan'],
            handoffs: [{ fromStep: 'compact-plan', source: { kind: 'submission' }, select: { kind: 'full' } }],
          },
        ],
      }) as unknown as Json),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );

    // 6b. Always validate spec.roles[].handoffs under explicit spec.steps even when steps override handoffs or omit the role
    assert.throws(
      () => validateTaskpackV2Manifest(baseMultiRoleManifest({
        roles: [
          { id: 'plan', purpose: 'task', provider: 'delegated', model: 'default' },
          {
            id: 'implement',
            purpose: 'task',
            provider: 'delegated',
            model: 'default',
            handoffs: [{ fromStep: 'does-not-exist', source: { kind: 'submission' }, select: { kind: 'full' } }],
          },
          {
            id: 'unused',
            purpose: 'review',
            provider: 'delegated',
            model: 'default',
            handoffs: [{ fromStep: 'plan', source: { kind: 'submission' }, select: { kind: 'full' } }],
          },
        ],
        steps: [
          { id: 'plan', kind: 'agent', role: 'plan', dependsOn: [] },
          { id: 'implement', kind: 'agent', role: 'implement', dependsOn: ['plan'], handoffs: [roleHandoff] },
        ],
      }) as unknown as Json),
      (err: unknown) => (
        err instanceof TaskpackError
        && err.code === 'TASKPACK_MANIFEST_INVALID'
        && err.path === '/spec/roles/1/handoffs/0/fromStep'
      ),
    );
    assert.throws(
      () => validateTaskpackV2Manifest(baseMultiRoleManifest({
        roles: [
          { id: 'plan', purpose: 'task', provider: 'delegated', model: 'default' },
          {
            id: 'unused',
            purpose: 'review',
            provider: 'delegated',
            model: 'default',
            handoffs: [{ fromStep: 'does-not-exist', source: { kind: 'submission' }, select: { kind: 'full' } }],
          },
        ],
        steps: [
          { id: 'plan', kind: 'agent', role: 'plan', dependsOn: [] },
        ],
      }) as unknown as Json),
      (err: unknown) => (
        err instanceof TaskpackError
        && err.code === 'TASKPACK_MANIFEST_INVALID'
        && err.path === '/spec/roles/1/handoffs/0/fromStep'
      ),
    );
    assert.throws(
      () => validateTaskpackV2Manifest(baseMultiRoleManifest({
        roles: [
          { id: 'plan', purpose: 'task', provider: 'openai', model: 'gpt-5' },
          {
            id: 'implement',
            purpose: 'task',
            provider: 'openai',
            model: 'gpt-5',
            handoffs: [{ fromStep: 'compact-plan', source: { kind: 'submission' }, select: { kind: 'full' } }],
          },
        ],
        steps: [
          { id: 'plan', kind: 'agent', role: 'plan', dependsOn: [] },
          { id: 'compact-plan', kind: 'compact', role: 'plan', dependsOn: ['plan'] },
          { id: 'implement', kind: 'agent', role: 'implement', dependsOn: ['compact-plan'], handoffs: [roleHandoff] },
        ],
      }) as unknown as Json),
      (err: unknown) => (
        err instanceof TaskpackError
        && err.code === 'TASKPACK_MANIFEST_INVALID'
        && err.path === '/spec/roles/1/handoffs/0/fromStep'
      ),
    );

    // 7. Decoded RFC 6901 prototype-key refusal & invalid escapes
    for (const badPtr of ['/__proto__', '/nested/constructor/x', '/prototype', '/bad~2escape', 'no-slash']) {
      assert.throws(
        () => validateTaskpackV2Manifest(baseMultiRoleManifest({
          steps: [
            { id: 'plan', kind: 'agent', role: 'plan', dependsOn: [] },
            {
              id: 'implement',
              kind: 'agent',
              role: 'implement',
              dependsOn: ['plan'],
              handoffs: [{
                fromStep: 'plan',
                source: { kind: 'artifact', path: 'src/plan.json' },
                select: { kind: 'json_pointer', pointers: [badPtr] },
              }],
            },
          ],
        }) as unknown as Json),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
        `expected bad JSON pointer "${badPtr}" to fail`,
      );
    }

    // 8. Selector count (0, 16 ok, 17 fail), pointer count (0, 32 ok, 33 fail), and maxBytes bounds (63, 65537, aggregate > 65536)
    const makeSelector = (i: number, maxBytes = 4_096): StepHandoffSelector => ({
      id: `h-${i}`,
      fromStep: 'plan',
      source: { kind: 'submission' },
      select: { kind: 'full' },
      maxBytes,
    });
    const sixteenValid = validateTaskpackV2Manifest(baseMultiRoleManifest({
      steps: [
        { id: 'plan', kind: 'agent', role: 'plan', dependsOn: [] },
        {
          id: 'implement',
          kind: 'agent',
          role: 'implement',
          dependsOn: ['plan'],
          handoffs: Array.from({ length: 16 }, (_, i) => makeSelector(i, 4_096)),
        },
      ],
    }) as unknown as Json);
    assert.equal(sixteenValid.spec.steps?.[1]?.handoffs?.length, 16);

    for (const badHandoffs of [
      [],
      Array.from({ length: 17 }, (_, i) => makeSelector(i, 1_024)),
      [makeSelector(0, 63)],
      [makeSelector(0, 65_537)],
      [makeSelector(0, 40_000), makeSelector(1, 30_000)],
      [{
        fromStep: 'plan',
        source: { kind: 'artifact', path: 'src/plan.json' },
        select: { kind: 'json_pointer', pointers: [] },
      }],
      [{
        fromStep: 'plan',
        source: { kind: 'artifact', path: 'src/plan.json' },
        select: { kind: 'json_pointer', pointers: Array.from({ length: 33 }, (_, i) => `/k${i}`) },
      }],
    ]) {
      assert.throws(
        () => validateTaskpackV2Manifest(baseMultiRoleManifest({
          steps: [
            { id: 'plan', kind: 'agent', role: 'plan', dependsOn: [] },
            { id: 'implement', kind: 'agent', role: 'implement', dependsOn: ['plan'], handoffs: badHandoffs },
          ],
        }) as unknown as Json),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );
    }
  });

  it('parses conditional { path, when } rules, preserves plain strings, rejects conflicting same-path predicates, pins when in TaskContract, and enforces the 256 KiB aggregate ceiling', async () => {
    const base = await realpath(tmpdir());
    const holder = await mkdtemp(join(base, 'lw-tp-rules-'));
    try {
      await mkdir(join(holder, '.loopwright', 'rules'), { recursive: true });
      await mkdir(join(holder, '.loopwright', 'skills'), { recursive: true });
      await writeFile(join(holder, '.loopwright', 'rules', 'base.md'), '# Base Rule\nAlways active.\n', 'utf8');
      await writeFile(join(holder, '.loopwright', 'rules', 'ts-only.md'), '# TS Rule\nActive on .ts changes.\n', 'utf8');
      await writeFile(join(holder, '.loopwright', 'skills', 'repair-skill.md'), '# Repair Skill\nActive on repair.\n', 'utf8');
      await writeFile(join(holder, '.loopwright', 'rules', 'plain-obj.md'), '# Normalized Plain\n', 'utf8');

      // 1. Plain strings remain plain strings; { path } without when normalizes to plain string; { path, when } stays frozen object
      const manifest = validateTaskpackV2Manifest(baseMultiRoleManifest({
        instructions: [
          '.loopwright/rules/base.md',
          { path: '.loopwright/rules/plain-obj.md' },
          nullProto({
            path: '.loopwright/rules/ts-only.md',
            when: nullProto({ changedPaths: ['src/**'], extensions: ['.ts'], phases: ['author', 'repair'] }),
          }),
        ],
        skills: {
          path: '.loopwright/skills/repair-skill.md',
          when: { phases: ['repair'], failedChecks: ['proposal-check'], failureCodes: ['JSON_MISSING'] },
        },
        roles: [
          {
            id: 'plan',
            purpose: 'task',
            provider: 'delegated',
            model: 'default',
            // Identical path + canonically equal `when` (reordered phases) deduplicates cleanly!
            instructions: [
              '.loopwright/rules/base.md',
              { path: '.loopwright/rules/ts-only.md', when: { phases: ['repair', 'author'], extensions: ['.ts'], changedPaths: ['src/**'] } },
            ],
          },
          {
            id: 'implement',
            purpose: 'task',
            provider: 'delegated',
            model: 'default',
            dependsOn: ['plan'],
            skills: [
              { path: '.loopwright/skills/repair-skill.md', when: { failureCodes: ['JSON_MISSING'], failedChecks: ['proposal-check'], phases: ['repair'] } },
            ],
          },
        ],
      }) as unknown as Json);

      assert.equal(manifest.spec.instructions?.[0], '.loopwright/rules/base.md');
      assert.equal(manifest.spec.instructions?.[1], '.loopwright/rules/plain-obj.md');
      assert.equal(typeof manifest.spec.instructions?.[2], 'object');
      assert.equal(resolveTaskpackResourcePath(manifest.spec.instructions![2]!), '.loopwright/rules/ts-only.md');
      assert.deepEqual(resolveTaskpackResourceWhen(manifest.spec.instructions![2]!)?.extensions, ['.ts']);
      assert.deepEqual(extractTaskpackResourcePaths(manifest.spec.instructions), [
        '.loopwright/rules/base.md',
        '.loopwright/rules/plain-obj.md',
        '.loopwright/rules/ts-only.md',
      ]);

      // 1b. Single-list duplicate paths are rejected (`duplicate list entry`), while cross-kind plain-string dedup preserves first-wins
      assert.throws(
        () => validateTaskpackV2Manifest(baseMultiRoleManifest({
          instructions: ['.loopwright/rules/base.md', '.loopwright/rules/base.md'],
        }) as unknown as Json),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );
      const crossKindManifest = validateTaskpackV2Manifest(baseMultiRoleManifest({
        instructions: ['.loopwright/rules/base.md'],
        roles: [
          {
            id: 'plan',
            purpose: 'task',
            provider: 'delegated',
            model: 'default',
            skills: ['.loopwright/rules/base.md'],
          },
        ],
      }) as unknown as Json);
      const compiledCrossKind = await compileDeclarativeTaskpack(crossKindManifest, {
        mode: 'candidate',
        executionMode: 'delegated',
        repository: 'org/repo',
        repositoryRoot: holder,
        baseRevision: 'main',
        sourceRevision: 'main',
        budgets: DEFAULT_HOST_BUDGETS,
      });
      const crossKindResources = compiledCrossKind.config.spec.task.spec.trustedContext.resources;
      assert.equal(crossKindResources.length, 1);
      assert.equal(crossKindResources[0]?.path, '.loopwright/rules/base.md');
      assert.equal(crossKindResources[0]?.kind, 'instruction');
      assert.ok(compiledCrossKind.config.spec.task.spec.roles[0]?.resourceIds?.includes(crossKindResources[0]!.id));

      // Compile and verify discovery: 'disabled', pre-hashed pinning, `when` preservation, and 4-field TrustedRegistry identity
      const compiled = await compileDeclarativeTaskpack(manifest, {
        mode: 'candidate',
        executionMode: 'delegated',
        repository: 'org/repo',
        repositoryRoot: holder,
        baseRevision: 'main',
        sourceRevision: 'main',
        budgets: DEFAULT_HOST_BUDGETS,
      });
      const contract = compiled.config.spec.task;
      assert.equal(validateDocument(contract, 'TaskContract').ok, true);
      assert.equal(contract.spec.trustedContext.discovery, 'disabled');
      assert.equal(contract.spec.trustedContext.resources.length, 4);
      const tsRes = contract.spec.trustedContext.resources.find(r => r.path === '.loopwright/rules/ts-only.md');
      const repairRes = contract.spec.trustedContext.resources.find(r => r.path === '.loopwright/skills/repair-skill.md');
      const baseRes = contract.spec.trustedContext.resources.find(r => r.path === '.loopwright/rules/base.md');
      assert.ok(tsRes?.when !== undefined);
      assert.deepEqual(tsRes?.when?.changedPaths, ['src/**']);
      assert.deepEqual(repairRes?.when?.failedChecks, ['proposal-check']);
      assert.equal(baseRes?.when, undefined);
      // TrustedRegistry keeps strict 4-field ResourceIdentity (no `when` field)
      for (const regRes of compiled.registry.spec.resources) {
        assert.equal(Object.hasOwn(regRes, 'when'), false);
      }
      // Roles pin all declared resource IDs (unconditional + conditional)
      const implRole = contract.spec.roles.find(r => r.id === 'implement');
      assert.ok(implRole?.resourceIds?.includes(tsRes!.id));
      assert.ok(implRole?.resourceIds?.includes(repairRes!.id));

      // 2. Conflicting same-path `when` predicates fail closed with TASKPACK_MANIFEST_INVALID
      // 2a. Unconditional (top-level) vs conditional (role)
      assert.throws(
        () => validateTaskpackV2Manifest(baseMultiRoleManifest({
          instructions: ['.loopwright/rules/base.md'],
          roles: [
            {
              id: 'plan',
              purpose: 'task',
              provider: 'delegated',
              model: 'default',
              instructions: [{ path: '.loopwright/rules/base.md', when: { phases: ['repair'] } }],
            },
          ],
        }) as unknown as Json),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );
      // 2b. Different `when` predicates across roles
      assert.throws(
        () => validateTaskpackV2Manifest(baseMultiRoleManifest({
          roles: [
            {
              id: 'plan',
              purpose: 'task',
              provider: 'delegated',
              model: 'default',
              instructions: [{ path: '.loopwright/rules/ts-only.md', when: { phases: ['author'] } }],
            },
            {
              id: 'implement',
              purpose: 'task',
              provider: 'delegated',
              model: 'default',
              dependsOn: ['plan'],
              instructions: [{ path: '.loopwright/rules/ts-only.md', when: { phases: ['repair'] } }],
            },
          ],
        }) as unknown as Json),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );
      // 2c. Empty `when: {}` or invalid extension / phase rejected
      for (const badWhen of [
        {},
        { phases: ['unknown-phase'] },
        { extensions: ['ts'] },
        { changedPaths: [] },
        { unknownKey: ['x'] },
      ]) {
        assert.throws(
          () => validateTaskpackV2Manifest(baseMultiRoleManifest({
            instructions: [{ path: '.loopwright/rules/ts-only.md', when: badWhen }],
          }) as unknown as Json),
          (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
        );
      }

      // 3. Worst-case 256 KiB (262,144-byte) aggregate ceiling counts conditional rules too!
      await writeFile(join(holder, '.loopwright', 'rules', 'big-uncond.md'), 'A'.repeat(150_000), 'utf8');
      await writeFile(join(holder, '.loopwright', 'rules', 'big-cond.md'), 'B'.repeat(115_000), 'utf8');
      assert.ok(150_000 + 115_000 > INSTRUCTION_MAX_AGGREGATE_BYTES);
      const oversizeManifest = validateTaskpackV2Manifest(baseMultiRoleManifest({
        instructions: [
          '.loopwright/rules/big-uncond.md',
          { path: '.loopwright/rules/big-cond.md', when: { phases: ['repair'] } },
        ],
      }) as unknown as Json);
      await assert.rejects(
        () => compileDeclarativeTaskpack(oversizeManifest, {
          mode: 'candidate',
          executionMode: 'delegated',
          repository: 'org/repo',
          repositoryRoot: holder,
          baseRevision: 'main',
          sourceRevision: 'main',
          budgets: DEFAULT_HOST_BUDGETS,
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );
    } finally {
      await removeTreeForce(holder);
    }
  });

  it('covers inactive conditional rule files in digests.lock.json (pinDigests: true) and mandatory protected paths', async () => {
    const base = await realpath(tmpdir());
    const holder = await mkdtemp(join(base, 'lw-tp-digest-rules-'));
    const repoRoot = join(holder, 'repo');
    const runRoot = join(holder, 'runs');
    try {
      await mkdir(join(repoRoot, '.loopwright', 'rules'), { recursive: true });
      await mkdir(join(repoRoot, 'docs', 'rules'), { recursive: true });
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      await writeFile(join(repoRoot, 'src', 'keep.txt'), 'ok\n', 'utf8');
      await writeFile(join(repoRoot, '.loopwright', 'rules', 'always.md'), '# Always\n', 'utf8');
      await writeFile(join(repoRoot, 'docs', 'rules', 'conditional-repair.md'), '# Repair Only\n', 'utf8');

      // 1. Mandatory protected-path coverage: conditional rule file inside writable fails closed!
      assert.throws(
        () => parseTaskpackManifest(serializePrettyYaml(baseMultiRoleManifest({
          scope: { writable: ['src/**', 'docs/rules/conditional-repair.md', '.loopwright/proposal.json'], protected: [] },
          instructions: [
            '.loopwright/rules/always.md',
            { path: 'docs/rules/conditional-repair.md', when: { phases: ['repair'] } },
          ],
        }))),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_SCOPE_VIOLATION',
      );

      // 2. Valid pinned manifest with conditional rule outside .loopwright/
      const yaml = serializePrettyYaml(baseMultiRoleManifest({
        execution: { mode: 'strict', digests: { pinDigests: true } },
        instructions: [
          '.loopwright/rules/always.md',
          { path: 'docs/rules/conditional-repair.md', when: { phases: ['repair'], failedChecks: ['proposal-check'] } },
        ],
      }));
      await writeFile(join(repoRoot, '.loopwright', 'taskpack.yaml'), yaml, 'utf8');
      const loaded = await loadDeclarativeTaskpack({
        manifestPath: '.loopwright/taskpack.yaml',
        repositoryRoot: repoRoot,
      });

      // Protected path helpers all include the conditional rule path
      const effProt = effectiveProtectedPaths([], {
        controlRoot: '.loopwright',
        instructions: loaded.spec.instructions,
      });
      assert.ok(effProt.includes('docs/rules/conditional-repair.md'));
      assert.ok(resolveEffectiveProtectedPaths(loaded).includes('docs/rules/conditional-repair.md'));
      assert.ok(collectManifestControlPlanePaths(loaded).compactMandatoryPaths.includes('docs/rules/conditional-repair.md'));
      assert.ok(deriveManifestCompiledScope({
        manifest: loaded,
        repositoryRoot: repoRoot,
        taskpackPath: '.loopwright/taskpack.yaml',
        baseRevision: 'main',
        sourceRevision: 'main',
      }).protectedPaths.some(p => p.startsWith('docs/rules/conditional-repair.md')));
      assertManifestScopeInvariants(loaded, { controlRoot: '.loopwright', manifestPath: '.loopwright/taskpack.yaml' });

      // Digest targets cover conditional rules
      const targets = collectTaskpackDigestTargets(loaded, '.loopwright');
      assert.deepEqual(
        targets.map(t => t.path),
        ['.loopwright/rules/always.md', 'docs/rules/conditional-repair.md'],
      );

      // Sync digests.lock.json -> verification passes and stageTaskpackForStep succeeds
      const lockfile = await computeTaskpackDigests(repoRoot, loaded, '.loopwright');
      await writeDigestLockfile(repoRoot, '.loopwright/digests.lock.json', lockfile);
      initGitRepo(repoRoot);

      const okVerify = await verifyDigestLockfile(repoRoot, loaded, '.loopwright');
      assert.equal(okVerify.ok, true);
      await assertDigestLockfileVerified(repoRoot, loaded, '.loopwright');

      const stagedOk = await stageTaskpackForStep({
        taskpackPath: '.loopwright/taskpack.yaml',
        repositoryRoot: repoRoot,
        runRoot,
        runId: 'pin-ok-1',
        runtimeEnv: {},
      });
      assert.ok(stagedOk.registrySha256.length === 64);

      // Tamper the INACTIVE conditional rule file on disk -> fails closed at intake before execution!
      await writeFile(join(repoRoot, 'docs', 'rules', 'conditional-repair.md'), '# TAMPERED RULE\n', 'utf8');
      const drifted = await verifyDigestLockfile(repoRoot, loaded, '.loopwright');
      assert.equal(drifted.ok, false);
      if (!drifted.ok) {
        assert.equal(drifted.drifts.length, 1);
        assert.equal(drifted.drifts[0]?.path, 'docs/rules/conditional-repair.md');
        assert.equal(drifted.drifts[0]?.status, 'drifted');
      }
      await assert.rejects(
        () => assertDigestLockfileVerified(repoRoot, loaded, '.loopwright'),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );
      await assert.rejects(
        () => stageTaskpackForStep({
          taskpackPath: '.loopwright/taskpack.yaml',
          repositoryRoot: repoRoot,
          runRoot,
          runId: 'pin-tampered-1',
          runtimeEnv: {},
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );
    } finally {
      await removeTreeForce(holder);
    }
  });

  it('executes a compiled plan -> implement -> review DAG end-to-end with @loopwright/controller stepNext/stepSubmit, --reissue-lease recovery, section handoffs, and repair conditional rules', async () => {
    const base = await realpath(tmpdir());
    const holder = await mkdtemp(join(base, 'lw-tp-e2e-handoff-'));
    const repoRoot = join(holder, 'repo');
    const runRoot = join(holder, 'runs');
    try {
      await mkdir(join(repoRoot, '.loopwright', 'rules'), { recursive: true });
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      await writeFile(join(repoRoot, 'src', 'keep.txt'), 'baseline\n', 'utf8');
      await writeFile(join(repoRoot, '.loopwright', 'rules', 'base.md'), 'BASE_UNCONDITIONAL_RULE\n', 'utf8');
      await writeFile(join(repoRoot, '.loopwright', 'rules', 'ts-style.md'), 'TS_CHANGED_PATH_RULE\n', 'utf8');
      await writeFile(join(repoRoot, '.loopwright', 'rules', 'repair-json.md'), 'REPAIR_PROPOSAL_CHECK_RULE\n', 'utf8');

      const manifestObj = baseMultiRoleManifest({
        execution: { mode: 'strict', digests: { pinDigests: true } },
        instructions: [
          '.loopwright/rules/base.md',
          { path: '.loopwright/rules/ts-style.md', when: { changedPaths: ['src/**'], extensions: ['.ts'] } },
          { path: '.loopwright/rules/repair-json.md', when: { phases: ['repair'], failedChecks: ['proposal-check'] } },
        ],
        steps: [
          { id: 'plan', kind: 'agent', role: 'plan', dependsOn: [] },
          {
            id: 'implement',
            kind: 'agent',
            role: 'implement',
            dependsOn: ['plan'],
            handoffs: [
              {
                id: 'plan-changes',
                fromStep: 'plan',
                source: { kind: 'artifact', path: 'src/plan.md' },
                select: { kind: 'markdown_heading', heading: '## File Changes' },
                maxBytes: 4_096,
              },
              {
                id: 'plan-csharp',
                fromStep: 'plan',
                source: { kind: 'artifact', path: 'src/plan.md' },
                select: { kind: 'markdown_heading', heading: '## C#', includeSubheadings: false },
                maxBytes: 4_096,
              },
              {
                id: 'plan-constraints',
                fromStep: 'plan',
                source: { kind: 'artifact', path: 'src/plan.json' },
                select: { kind: 'json_pointer', pointers: ['/constraints'] },
                maxBytes: 4_096,
              },
            ],
          },
          { id: 'review', kind: 'agent', role: 'review', dependsOn: ['implement'] },
          { id: 'proposal-check', kind: 'check', check: 'proposal-check', dependsOn: ['review'] },
        ],
      });
      await writeFile(join(repoRoot, '.loopwright', 'taskpack.yaml'), serializePrettyYaml(manifestObj), 'utf8');

      const loadedManifest = await loadDeclarativeTaskpack({
        manifestPath: '.loopwright/taskpack.yaml',
        repositoryRoot: repoRoot,
      });
      const lockfile = await computeTaskpackDigests(repoRoot, loadedManifest, '.loopwright');
      await writeDigestLockfile(repoRoot, '.loopwright/digests.lock.json', lockfile);
      initGitRepo(repoRoot);

      const runId = 'e2e-handoff-rules-1';
      const staged = await stageTaskpackForStep({
        taskpackPath: '.loopwright/taskpack.yaml',
        repositoryRoot: repoRoot,
        runRoot,
        runId,
        runtimeEnv: {},
      });

      const loadedCfg = await loadTrustedConfiguration({
        configPath: staged.configPath,
        registryPath: staged.registryPath,
        registrySha256: staged.registrySha256,
        untrustedRoots: [repoRoot],
      });
      assert.equal(loadedCfg.ok, true, loadedCfg.ok ? '' : JSON.stringify(loadedCfg.error));
      if (!loadedCfg.ok) return;

      // Step 1: `plan` (unrelated turn) -> ONLY base rule mounted, conditional rules unmounted
      const sPlan = await stepNext({
        configuration: loadedCfg.value,
        repository: repoRoot,
        runRoot,
        runId,
        policyProfile: staged.policyProfile,
      });
      assert.equal(sPlan.ok, true, sPlan.ok ? '' : JSON.stringify(sPlan.error));
      if (!sPlan.ok || sPlan.value.kind !== 'step') return;
      assert.equal(sPlan.value.stepId, 'plan');
      const planContextBodies = await Promise.all(sPlan.value.contextFiles.map(cf => readFile(cf, 'utf8')));
      assert.equal(planContextBodies.some(b => b.includes('BASE_UNCONDITIONAL_RULE')), true);
      assert.equal(planContextBodies.some(b => b.includes('TS_CHANGED_PATH_RULE')), false);
      assert.equal(planContextBodies.some(b => b.includes('REPAIR_PROPOSAL_CHECK_RULE')), false);

      // Write plan artifacts including code-fenced `#` trap, `## File Changes`, `## C#`, and JSON `/constraints`
      await writeFile(
        join(sPlan.value.candidateDir, 'src', 'plan.md'),
        [
          '# Plan',
          '```markdown',
          '## File Changes',
          'FENCED_TRAP_MUST_BE_IGNORED',
          '```',
          '## File Changes',
          '- Create src/feature.ts',
          '## C#',
          'Preserve trailing hash in C# heading.',
          '## Unrelated Notes',
          'OMITTED_UNRELATED_BODY',
        ].join('\n') + '\n',
        'utf8',
      );
      await writeFile(
        join(sPlan.value.candidateDir, 'src', 'plan.json'),
        JSON.stringify({ constraints: { maxFiles: 2, strict: true }, ignoredSecretNote: 'DO_NOT_FORWARD' }, null, 2),
        'utf8',
      );

      // Step 2: `implement` receives compact Markdown-heading & JSON-pointer handoffs from `plan`
      const sImpl = await stepSubmit({
        runRoot,
        runId,
        leaseToken: sPlan.value.leaseToken,
        status: 'completed',
        reason: 'wrote plan artifacts',
      });
      assert.equal(sImpl.ok, true, sImpl.ok ? '' : JSON.stringify(sImpl.error));
      if (!sImpl.ok || sImpl.value.kind !== 'step') return;
      assert.equal(sImpl.value.stepId, 'implement');
      const implBodies = await Promise.all(sImpl.value.contextFiles.map(cf => readFile(cf, 'utf8')));
      assert.equal(implBodies.some(b => b.includes('Create src/feature.ts')), true);
      assert.equal(implBodies.some(b => b.includes('Preserve trailing hash in C# heading.')), true);
      assert.equal(implBodies.some(b => b.includes('"/constraints":{"maxFiles":2,"strict":true}')), true);
      assert.equal(implBodies.some(b => b.includes('FENCED_TRAP_MUST_BE_IGNORED')), false);
      assert.equal(implBodies.some(b => b.includes('OMITTED_UNRELATED_BODY')), false);
      assert.equal(implBodies.some(b => b.includes('DO_NOT_FORWARD')), false);
      assert.equal(implBodies.some(b => b.includes('TS_CHANGED_PATH_RULE')), false);
      assert.equal(implBodies.some(b => b.includes('REPAIR_PROPOSAL_CHECK_RULE')), false);
      for (const cf of sImpl.value.contextFiles) {
        const st = await lstat(cf);
        assert.equal(st.mode & 0o777, 0o400);
      }

      // Simulate crash + `--reissue-lease`: delete step-lease.json and context directory, reconstruct 0o400 contextFiles from CAS
      await unlink(join(runRoot, runId, 'step-lease.json'));
      await rm(join(runRoot, 'workspaces', runId, sImpl.value.attemptId, 'context'), { recursive: true, force: true });
      const reissued = await stepNext({ runRoot, runId, reissueLease: true });
      assert.equal(reissued.ok, true, reissued.ok ? '' : JSON.stringify(reissued.error));
      if (!reissued.ok || reissued.value.kind !== 'step') return;
      assert.equal(reissued.value.attemptId, sImpl.value.attemptId);
      assert.equal(reissued.value.contextFiles.length, sImpl.value.contextFiles.length);
      for (const cf of reissued.value.contextFiles) {
        const st = await lstat(cf);
        assert.equal(st.mode & 0o777, 0o400);
      }
      const reissuedBodies = await Promise.all(reissued.value.contextFiles.map(cf => readFile(cf, 'utf8')));
      assert.equal(reissuedBodies.some(b => b.includes('Create src/feature.ts')), true);

      // Write `src/feature.ts` (matches `src/**/*.ts`) and an INVALID proposal (missing `summary`) to trigger repair
      await writeFile(join(reissued.value.candidateDir, 'src', 'feature.ts'), 'export const value = 42;\n', 'utf8');
      await mkdir(join(reissued.value.candidateDir, '.loopwright'), { recursive: true });
      await writeFile(join(reissued.value.candidateDir, '.loopwright', 'proposal.json'), JSON.stringify({ schema_version: 1 }) + '\n', 'utf8');

      // Step 3: `review` now sees `TS_CHANGED_PATH_RULE` (because `src/feature.ts` changed), NOT repair rule
      const sReview = await stepSubmit({
        runRoot,
        runId,
        leaseToken: reissued.value.leaseToken,
        status: 'completed',
        reason: 'implemented feature.ts',
      });
      assert.equal(sReview.ok, true, sReview.ok ? '' : JSON.stringify(sReview.error));
      if (!sReview.ok || sReview.value.kind !== 'step') return;
      assert.equal(sReview.value.stepId, 'review');
      const reviewBodies = await Promise.all(sReview.value.contextFiles.map(cf => readFile(cf, 'utf8')));
      assert.equal(reviewBodies.some(b => b.includes('TS_CHANGED_PATH_RULE')), true);
      assert.equal(reviewBodies.some(b => b.includes('REPAIR_PROPOSAL_CHECK_RULE')), false);

      // Review passes -> `proposal-check` fails -> controller yields `implementation` repair turn with BOTH conditional rules mounted!
      const sRepair = await stepSubmit({
        runRoot,
        runId,
        leaseToken: sReview.value.leaseToken,
        verdict: { verdict: 'pass', summary: 'Code looks good, proceed to checks.', findings: [] },
      });
      assert.equal(sRepair.ok, true, sRepair.ok ? '' : JSON.stringify(sRepair.error));
      if (!sRepair.ok || sRepair.value.kind !== 'step') return;
      assert.equal(sRepair.value.stepId, 'implement');
      const repairBodies = await Promise.all(sRepair.value.contextFiles.map(cf => readFile(cf, 'utf8')));
      assert.equal(repairBodies.some(b => b.includes('BASE_UNCONDITIONAL_RULE')), true);
      assert.equal(repairBodies.some(b => b.includes('TS_CHANGED_PATH_RULE')), true);
      assert.equal(repairBodies.some(b => b.includes('REPAIR_PROPOSAL_CHECK_RULE')), true);

      // Fix proposal.json on repair turn -> verification passes and run completes!
      await chmod(join(sRepair.value.candidateDir, '.loopwright', 'proposal.json'), 0o600);
      await writeFile(
        join(sRepair.value.candidateDir, '.loopwright', 'proposal.json'),
        JSON.stringify({ schema_version: 1, summary: 'Implemented feature.ts cleanly.' }) + '\n',
        'utf8',
      );
      let settled = await stepSubmit({
        runRoot,
        runId,
        leaseToken: sRepair.value.leaseToken,
        status: 'completed',
        reason: 'fixed proposal.json summary field',
      });
      assert.equal(settled.ok, true, settled.ok ? '' : JSON.stringify(settled.error));
      if (!settled.ok) return;
      if (settled.value.kind === 'step' && settled.value.stepId === 'review') {
        settled = await stepSubmit({
          runRoot,
          runId,
          leaseToken: settled.value.leaseToken,
          verdict: { verdict: 'pass', summary: 'Repaired proposal approved.', findings: [] },
        });
        assert.equal(settled.ok, true, settled.ok ? '' : JSON.stringify(settled.error));
        if (!settled.ok) return;
      }
      assert.equal(
        settled.value.kind,
        'result',
        settled.value.kind === 'step'
          ? `unexpected step yield: ${settled.value.stepId} (attempt ${settled.value.attemptId})`
          : '',
      );
      if (settled.value.kind === 'result') {
        assert.equal(settled.value.result.spec.status, 'completed');
      }

      const inspected = await inspectRun({ runRoot, runId, output: join(holder, 'inspect-out') });
      assert.equal(inspected.ok, true);
      if (inspected.ok) {
        assert.equal(inspected.value.status.status, 'completed');
        assert.notEqual(inspected.value.runEval, null);
      }
    } finally {
      await removeTreeForce(holder);
    }
  });

  it('propagates watchedPaths through compiled and staged step ports so conditional rules activate on initial turns', async () => {
    const holder = await realpath(await mkdtemp(join(tmpdir(), 'lw-t8-watched-')));
    try {
      const repoRoot = join(holder, 'repo');
      const runRoot = join(holder, 'runs');
      await mkdir(join(repoRoot, '.loopwright', 'rules'), { recursive: true });
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      await writeFile(join(repoRoot, 'src', 'app.ts'), 'export const app = 1;\n', 'utf8');
      await writeFile(join(repoRoot, '.loopwright', 'rules', 'base.md'), 'WATCHED_BASE_RULE\n', 'utf8');
      await writeFile(join(repoRoot, '.loopwright', 'rules', 'ts-only.md'), 'WATCHED_TS_RULE\n', 'utf8');
      await writeFile(join(repoRoot, '.loopwright', 'rules', 'py-only.md'), 'WATCHED_PY_RULE\n', 'utf8');

      const yaml = [
        'apiVersion: loopwright.dev/v1alpha1',
        'kind: Taskpack',
        'metadata:',
        '  name: watched-paths-taskpack',
        'spec:',
        '  goal:',
        '    candidate: Update watched TypeScript files.',
        '    noChange: Confirm watched files are current.',
        '  scope:',
        '    writable:',
        '      - src/**',
        '    protected:',
        '      - .git/**',
        '  upstreams:',
        '    - id: ts-feed',
        '      kind: http-json',
        '      source: https://example.invalid/ts.json',
        '      versionPath: version',
        '      watchedPaths:',
        '        - src/app.ts',
        '    - id: py-feed',
        '      kind: http-json',
        '      source: https://example.invalid/py.json',
        '      versionPath: version',
        '      watchedPaths:',
        '        - scripts/tool.py',
        '  instructions:',
        '    - .loopwright/rules/base.md',
        '    - path: .loopwright/rules/ts-only.md',
        '      when:',
        '        changedPaths:',
        '          - src/**',
        '    - path: .loopwright/rules/py-only.md',
        '      when:',
        '        extensions:',
        '          - .py',
        '  verification:',
        '    localChecks:',
        '      - id: ok',
        '        implementation: no-change.v1',
        '    externalGates: []',
        '  publication:',
        '    mode: disabled',
        '',
      ].join('\n');
      await writeFile(join(repoRoot, '.loopwright', 'taskpack.yaml'), yaml, 'utf8');
      const baseSha = initGitRepo(repoRoot);

      // 1. Direct compilation narrows watchedPaths to available upstreamRecords when present, else all upstreams.
      const manifest = await loadDeclarativeTaskpack({
        manifestPath: '.loopwright/taskpack.yaml',
        repositoryRoot: repoRoot,
        policyProfile: 'local',
        executionMode: 'delegated',
      });
      const compiledFiltered = await compileDeclarativeTaskpack(manifest, {
        mode: 'candidate',
        executionMode: 'delegated',
        repository: 'octo/repo',
        repositoryRoot: repoRoot,
        taskpackPath: '.loopwright/taskpack.yaml',
        baseRevision: baseSha,
        sourceRevision: baseSha,
        budgets: DEFAULT_HOST_BUDGETS,
        upstreamRecords: [{ upstreamId: 'ts-feed', status: 'available', version: '2.0.0' }],
      });
      assert.deepEqual(compiledFiltered.watchedPaths, ['src/app.ts']);

      // 2. Staged step run persists watchedPaths in secrets.json and forwards them via gateHandle.ports to stepNext.
      const runId = 'watched-step-1';
      const staged = await stageTaskpackForStep({
        taskpackPath: '.loopwright/taskpack.yaml',
        repositoryRoot: repoRoot,
        runRoot,
        runId,
        baseRevision: baseSha,
        sourceRevision: baseSha,
        policyProfile: 'local',
        upstreamRecordsJson: JSON.stringify([{ upstreamId: 'ts-feed', status: 'available', version: '2.0.0' }]),
      });
      assert.deepEqual(staged.watchedPaths, ['src/app.ts']);

      const gate = await openStagedTaskpackStepGate({ runRoot, runId });
      assert.notEqual(gate, null);
      try {
        assert.deepEqual(gate?.ports?.watchedPaths, ['src/app.ts']);
        const loaded = await loadTrustedConfiguration({
          configPath: staged.configPath,
          registryPath: staged.registryPath,
          registrySha256: staged.registrySha256,
          untrustedRoots: [repoRoot],
        });
        assert.equal(loaded.ok, true);
        if (!loaded.ok) return;

        const firstTurn = await stepNext(
          { configuration: loaded.value, repository: repoRoot, runRoot, runId },
          gate?.ports,
        );
        assert.equal(firstTurn.ok, true, firstTurn.ok ? '' : JSON.stringify(firstTurn.error));
        if (!firstTurn.ok || firstTurn.value.kind !== 'step') return;
        const bodies = await Promise.all(firstTurn.value.contextFiles.map(cf => readFile(cf, 'utf8')));
        assert.equal(bodies.some(b => b.includes('WATCHED_BASE_RULE')), true);
        assert.equal(bodies.some(b => b.includes('WATCHED_TS_RULE')), true);
        assert.equal(bodies.some(b => b.includes('WATCHED_PY_RULE')), false);
      } finally {
        await gate?.close();
      }
    } finally {
      await removeTreeForce(holder);
    }
  });
});
