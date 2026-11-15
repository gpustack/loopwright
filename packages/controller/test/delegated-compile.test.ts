import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { admitTask } from '@loopwright/core';
import { compilePlan } from '../src/compile.js';
import { loadConfiguration, approvedState } from '../src/config.js';
import { validateRegistry } from '../src/registry.js';
import { parseDocumentBytes } from '../src/parser.js';
import type { ControllerResult } from '../src/errors.js';
import type {
  RoleAdapterKind,
  DelegatedSelection,
  RoleSelectionOverride,
  RoleModelOverride,
  StepYield,
} from '../src/types.js';
import { configurationFixture, TOKEN } from './config-fixtures.js';
import { installedHandlerDigests } from '../src/handlers.js';

function good<T>(result: ControllerResult<T>): T {
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.error));
  if (!result.ok) throw new Error('expected success');
  return result.value;
}

function set(value: unknown, path: readonly (string | number)[], replacement: unknown): void {
  let parent = value as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
  parent[path.at(-1)!] = replacement;
}

test('types export RoleAdapterKind, DelegatedSelection, RoleSelectionOverride, RoleModelOverride, and StepYield', () => {
  const adapterKind: RoleAdapterKind = 'delegated';
  const sel: DelegatedSelection = { provider: 'antigravity', model: 'gemini-4-argon', thinking: 'low' };
  const selOverride: RoleSelectionOverride = { provider: 'pi-oauth', model: 'gpt-6.1-terra' };
  const roleOverride: RoleModelOverride = { roleId: 'builder', provider: 'pi-oauth', model: 'gpt-6.1-terra', thinking: 'high' };
  const stepYield: Partial<StepYield> = {
    kind: 'step',
    status: 'awaiting_role',
    selection: sel,
    submissionMode: 'artifact_or_assistant',
  };
  assert.equal(adapterKind, 'delegated');
  assert.equal(selOverride.provider, 'pi-oauth');
  assert.equal(roleOverride.roleId, 'builder');
  assert.equal(stepYield.kind, 'step');
});

test('TrustedRegistry accepts adapter: delegated with null runtimeRef, null providerCredentialRef, null mcp, omitted context, empty runtimeProfiles/credentialBindings, and arbitrary valid labels', async () => {
  for (const selection of [
    { provider: 'antigravity', model: 'gemini-4-argon', thinking: 'low' },
    { provider: 'pi-oauth', model: 'gpt-6.1-terra', thinking: 'high' },
  ] as const) {
    const f = await configurationFixture();
    try {
      f.lookedUp.length = 0;
      set(f.registry, ['spec', 'runtimeProfiles'], []);
      set(f.registry, ['spec', 'credentialBindings'], []);
      set(f.registry, ['spec', 'environmentBindings'], []);
      set(f.registry, ['spec', 'roleProfiles'], [{
        id: 'builder',
        adapter: 'delegated',
        runtimeRef: null,
        providerCredentialRef: null,
        selection,
        tools: ['read', 'write', 'edit', 'bash', 'delete'],
        mcp: null,
      }]);
      set(f.config, ['spec', 'credentials'], []);
      set(f.config, ['spec', 'task', 'spec', 'roles', 0], {
        id: 'builder',
        adapter: 'delegated',
        provider: selection.provider,
        model: selection.model,
        thinking: selection.thinking,
        tools: ['read', 'write', 'edit'],
      });
      await f.save();
      const loaded = good(await f.load());
      assert.deepEqual(f.lookedUp, []);
      const profile = loaded.registry.spec.roleProfiles[0]!;
      assert.equal(profile.adapter, 'delegated');
      assert.equal(profile.runtimeRef, null);
      assert.equal(profile.providerCredentialRef, null);
      assert.equal(profile.mcp, null);
      assert.deepEqual(profile.selection, selection);
      assert.deepEqual(profile.context, {
        mode: 'estimated_guard',
        estimator: 'lw-pi-final-json-bytes-v1',
        proofId: null,
        version: 1,
        evidence: 'estimated',
        workingWindowCeiling: 200000,
        maxRequestBytes: 524288,
        serviceMargin: 32768,
        toolReserve: 16384,
        maxOutputTokens: 65536,
      });

      const roundTrippedJson = validateRegistry(JSON.parse(JSON.stringify(loaded.registry)));
      assert.deepEqual(roundTrippedJson, loaded.registry);
      const roundTrippedYaml = validateRegistry(parseDocumentBytes(Buffer.from(stringify(loaded.registry), 'utf8'), 'yaml'));
      assert.deepEqual(roundTrippedYaml, loaded.registry);

      const plan = good(await compilePlan(loaded));
      assert.equal(plan.roles.length, 1);
      const plannedRole = plan.roles[0]!;
      assert.equal(plannedRole.roleId, 'builder');
      assert.equal(plannedRole.adapter, 'delegated');
      assert.equal(plannedRole.providerCredentialRef, null);
      assert.equal(plannedRole.runtime.id, 'delegated.none');
      assert.equal(plannedRole.runtime.dockerExecutable, '/nonexistent/delegated');
      assert.equal(plannedRole.runtime.dockerSocket, '/nonexistent/delegated.sock');
      assert.deepEqual(plannedRole.policy.selection, {
        provider: selection.provider,
        model: selection.model,
        thinking: selection.thinking,
        api: 'openai-responses',
      });
      assert.deepEqual(plannedRole.policy.tools, ['read', 'write', 'edit']);
      assert.deepEqual(plannedRole.policy.mcp.names, []);
      assert.deepEqual(plannedRole.policy.mcp.effects, []);
      assert.deepEqual(plan.credentialReferences, []);
    } finally {
      await f.cleanup();
    }
  }
});

test('negative registry validation for adapter: delegated and invalid adapter values', async () => {
  const cases: readonly {
    readonly name: string;
    readonly mutate: (f: Awaited<ReturnType<typeof configurationFixture>>) => void;
    readonly expectedCode: string;
  }[] = [
    {
      name: 'non-null providerCredentialRef on delegated roleProfile refuses CONFIG_SCHEMA',
      mutate: f => {
        set(f.registry, ['spec', 'roleProfiles', 0], {
          id: 'builder',
          adapter: 'delegated',
          runtimeRef: null,
          providerCredentialRef: 'copilot',
          selection: { provider: 'antigravity', model: 'gemini-4-argon', thinking: 'low' },
          tools: ['read'],
          mcp: null,
        });
      },
      expectedCode: 'CONFIG_SCHEMA',
    },
    {
      name: 'invalid adapter value refuses CONFIG_SCHEMA',
      mutate: f => {
        set(f.registry, ['spec', 'roleProfiles', 0], {
          ...f.registry.spec.roleProfiles[0]!,
          adapter: 'unknown-adapter',
        });
      },
      expectedCode: 'CONFIG_SCHEMA',
    },
    {
      name: 'whitespace in delegated selection provider refuses CONFIG_SCHEMA',
      mutate: f => {
        set(f.registry, ['spec', 'roleProfiles', 0], {
          id: 'builder',
          adapter: 'delegated',
          runtimeRef: null,
          providerCredentialRef: null,
          selection: { provider: 'bad provider', model: 'gemini-4-argon', thinking: 'low' },
          tools: ['read'],
          mcp: null,
        });
      },
      expectedCode: 'CONFIG_SCHEMA',
    },
    {
      name: 'overlong (>128 chars) delegated selection model refuses CONFIG_SCHEMA',
      mutate: f => {
        set(f.registry, ['spec', 'roleProfiles', 0], {
          id: 'builder',
          adapter: 'delegated',
          runtimeRef: null,
          providerCredentialRef: null,
          selection: { provider: 'antigravity', model: 'm'.repeat(129), thinking: 'low' },
          tools: ['read'],
          mcp: null,
        });
      },
      expectedCode: 'CONFIG_SCHEMA',
    },
    {
      name: 'empty delegated selection thinking refuses CONFIG_SCHEMA',
      mutate: f => {
        set(f.registry, ['spec', 'roleProfiles', 0], {
          id: 'builder',
          adapter: 'delegated',
          runtimeRef: null,
          providerCredentialRef: null,
          selection: { provider: 'antigravity', model: 'gemini-4-argon', thinking: '' },
          tools: ['read'],
          mcp: null,
        });
      },
      expectedCode: 'CONFIG_SCHEMA',
    },
    {
      name: 'mcp__workspace__read_file with mcp: null on delegated roleProfile refuses CAPABILITY_UNSUPPORTED',
      mutate: f => {
        set(f.registry, ['spec', 'roleProfiles', 0], {
          id: 'builder',
          adapter: 'delegated',
          runtimeRef: null,
          providerCredentialRef: null,
          selection: { provider: 'antigravity', model: 'gemini-4-argon', thinking: 'low' },
          tools: ['read', 'mcp__workspace__read_file'],
          mcp: null,
        });
      },
      expectedCode: 'CAPABILITY_UNSUPPORTED',
    },
    {
      name: 'codemode with mcp: null on delegated roleProfile refuses CAPABILITY_UNSUPPORTED',
      mutate: f => {
        set(f.registry, ['spec', 'roleProfiles', 0], {
          id: 'builder',
          adapter: 'delegated',
          runtimeRef: null,
          providerCredentialRef: null,
          selection: { provider: 'antigravity', model: 'gemini-4-argon', thinking: 'low' },
          tools: ['read', 'codemode'],
          mcp: null,
        });
      },
      expectedCode: 'CAPABILITY_UNSUPPORTED',
    },
  ];

  for (const c of cases) {
    const f = await configurationFixture();
    try {
      c.mutate(f);
      await f.save();
      const res = await f.load();
      assert.equal(res.ok, false, c.name);
      if (!res.ok) assert.equal(res.error.code, c.expectedCode, `${c.name}: got ${res.error.code}`);
    } finally {
      await f.cleanup();
    }
  }
});

test('ControllerConfig.spec.profiles.roles[].selection overrides task.spec.roles[], and LoadConfigurationInput.roleModelOverrides overrides both without changing registrySha256', async () => {
  const f = await configurationFixture();
  try {
    set(f.registry, ['spec', 'runtimeProfiles'], []);
    set(f.registry, ['spec', 'credentialBindings'], []);
    set(f.registry, ['spec', 'environmentBindings'], []);
    set(f.registry, ['spec', 'roleProfiles'], [{
      id: 'builder',
      adapter: 'delegated',
      runtimeRef: null,
      providerCredentialRef: null,
      selection: { provider: 'antigravity', model: 'gemini-4-carbon', thinking: 'medium' },
      tools: ['read', 'write'],
      mcp: null,
    }]);
    set(f.config, ['spec', 'credentials'], []);
    set(f.config, ['spec', 'task', 'spec', 'roles', 0], {
      id: 'builder',
      adapter: 'delegated',
      provider: 'antigravity',
      model: 'gemini-4-carbon',
      thinking: 'medium',
      tools: ['read'],
    });
    await f.save();
    const originalRegistrySha256 = f.input.registrySha256;

    // 1. Baseline load & compile
    const baseLoaded = good(await f.load());
    const basePlan = good(await compilePlan(baseLoaded));
    assert.equal(basePlan.task.spec.roles[0]!.provider, 'antigravity');
    assert.equal(basePlan.task.spec.roles[0]!.model, 'gemini-4-carbon');
    assert.equal(basePlan.task.spec.roles[0]!.thinking, 'medium');

    // 2. ControllerConfig.spec.profiles.roles[0].selection overrides task.spec.roles[0]
    set(f.config, ['spec', 'profiles', 'roles', 0], {
      roleId: 'builder',
      profileRef: 'builder',
      selection: { provider: 'antigravity', model: 'gemini-4-argon', thinking: 'low' },
    });
    await writeFile(f.input.configPath, stringify(f.config), { mode: 0o600 });
    f.input.configPath = join(f.taskDirectory, 'task.yaml');
    await writeFile(f.input.configPath, stringify(f.config), { mode: 0o600 });
    assert.equal(f.input.registrySha256, originalRegistrySha256);

    const profileOverriddenLoaded = good(await f.load());
    const profileOverriddenPlan = good(await compilePlan(profileOverriddenLoaded));
    assert.equal(profileOverriddenPlan.task.spec.roles[0]!.provider, 'antigravity');
    assert.equal(profileOverriddenPlan.task.spec.roles[0]!.model, 'gemini-4-argon');
    assert.equal(profileOverriddenPlan.task.spec.roles[0]!.thinking, 'low');
    assert.deepEqual(profileOverriddenPlan.roles[0]!.policy.selection, {
      provider: 'antigravity',
      model: 'gemini-4-argon',
      thinking: 'low',
      api: 'openai-responses',
    });
    assert.notDeepEqual(profileOverriddenPlan.taskByteDigest, basePlan.taskByteDigest);
    assert.notDeepEqual(profileOverriddenPlan.planDigest, basePlan.planDigest);

    // 3. LoadConfigurationInput.roleModelOverrides overrides both task and profiles.roles[].selection
    // Also test omitting thinking in roleModelOverrides preserves prior thinking ('low' from profiles.roles.selection)
    const cliOverrides: readonly RoleModelOverride[] = [
      { roleId: 'builder', provider: 'pi-oauth', model: 'gpt-6.1-terra' },
    ];
    const cliLoaded1 = good(await loadConfiguration({ ...f.input, roleModelOverrides: cliOverrides }, { environment: name => f.environment[name] }));
    const cliPlan1 = good(await compilePlan(cliLoaded1));
    assert.equal(cliLoaded1.registryDigest.hex, originalRegistrySha256);
    assert.equal(cliPlan1.task.spec.roles[0]!.provider, 'pi-oauth');
    assert.equal(cliPlan1.task.spec.roles[0]!.model, 'gpt-6.1-terra');
    assert.equal(cliPlan1.task.spec.roles[0]!.thinking, 'low');
    assert.deepEqual(approvedState(cliLoaded1).input.roleModelOverrides, [
      { roleId: 'builder', provider: 'pi-oauth', model: 'gpt-6.1-terra' },
    ]);

    // Reloading with the same roleModelOverrides produces identical digests and TaskLock
    const cliLoaded2 = good(await loadConfiguration({ ...f.input, roleModelOverrides: cliOverrides }, { environment: name => f.environment[name] }));
    const cliPlan2 = good(await compilePlan(cliLoaded2));
    assert.deepEqual(cliPlan2.taskByteDigest, cliPlan1.taskByteDigest);
    assert.deepEqual(cliPlan2.planDigest, cliPlan1.planDigest);

    const admitted1 = admitTask(cliPlan1.task, { admissionId: 'admission.' + 'a'.repeat(40), runId: 'run-override' });
    const admitted2 = admitTask(cliPlan2.task, { admissionId: 'admission.' + 'a'.repeat(40), runId: 'run-override' });
    assert.equal(admitted1.ok, true);
    assert.equal(admitted2.ok, true);
    if (admitted1.ok && admitted2.ok) {
      assert.deepEqual(admitted1.value, admitted2.value);
      assert.equal(admitted1.value.spec.contract.spec.roles[0]!.provider, 'pi-oauth');
      assert.equal(admitted1.value.spec.contract.spec.roles[0]!.model, 'gpt-6.1-terra');
    }

    // 4. Empty roleModelOverrides: [] normalizes to undefined
    const emptyOverridesLoaded = good(
      await loadConfiguration({ ...f.input, roleModelOverrides: [] }, { environment: name => f.environment[name] }),
    );
    assert.equal(approvedState(emptyOverridesLoaded).input.roleModelOverrides, undefined);
  } finally {
    await f.cleanup();
  }
});

test('negative roleModelOverrides and profiles.roles[].selection validation', async () => {
  const f = await configurationFixture();
  try {
    // 1. Unknown roleId in roleModelOverrides refuses CONFIG_REFERENCE
    const unknownRole = await loadConfiguration(
      { ...f.input, roleModelOverrides: [{ roleId: 'nonexistent', provider: 'antigravity', model: 'gemini-4-argon' }] },
      { environment: name => f.environment[name] },
    );
    assert.equal(unknownRole.ok, false);
    if (!unknownRole.ok) {
      assert.equal(unknownRole.error.code, 'CONFIG_REFERENCE');
      assert.equal(unknownRole.error.path, '/roleModelOverrides');
    }

    // 2. > 8 entries in roleModelOverrides refuses CONFIG_LIMIT
    const nineOverrides: RoleModelOverride[] = Array.from({ length: 9 }, (_, i) => ({
      roleId: `role-${i}`,
      provider: 'antigravity',
      model: 'gemini-4-argon',
    }));
    const tooMany = await loadConfiguration(
      { ...f.input, roleModelOverrides: nineOverrides },
      { environment: name => f.environment[name] },
    );
    assert.equal(tooMany.ok, false);
    if (!tooMany.ok) {
      assert.equal(tooMany.error.code, 'CONFIG_LIMIT');
      assert.equal(tooMany.error.path, '/roleModelOverrides');
    }

    // 3. Duplicate roleId in roleModelOverrides refuses CONFIG_SCHEMA or CONFIG_REFERENCE
    const dupRole = await loadConfiguration(
      {
        ...f.input,
        roleModelOverrides: [
          { roleId: 'builder', provider: 'antigravity', model: 'gemini-4-argon' },
          { roleId: 'builder', provider: 'pi-oauth', model: 'gpt-6.1-terra' },
        ],
      },
      { environment: name => f.environment[name] },
    );
    assert.equal(dupRole.ok, false);
    if (!dupRole.ok) {
      assert.ok(['CONFIG_SCHEMA', 'CONFIG_REFERENCE'].includes(dupRole.error.code));
      assert.equal(dupRole.error.path, '/roleModelOverrides');
    }

    // 4. Empty or whitespace label in roleModelOverrides refuses CONFIG_SCHEMA with preserved path
    for (const [badOverride, expectedPath] of [
      [{ roleId: 'builder', provider: '', model: 'gemini-4-argon' }, '/roleModelOverrides/0/provider'],
      [{ roleId: 'builder', provider: 'antigravity', model: 'bad model' }, '/roleModelOverrides/0/model'],
      [{ roleId: 'builder', provider: 'antigravity', model: 'gemini-4-argon', thinking: 'bad\nthinking' }, '/roleModelOverrides/0/thinking'],
      [{ roleId: 'builder', provider: 'p'.repeat(129), model: 'gemini-4-argon' }, '/roleModelOverrides/0/provider'],
    ] as const) {
      const badRes = await loadConfiguration(
        { ...f.input, roleModelOverrides: [badOverride] },
        { environment: name => f.environment[name] },
      );
      assert.equal(badRes.ok, false);
      if (!badRes.ok) {
        assert.equal(badRes.error.code, 'CONFIG_SCHEMA');
        assert.equal(badRes.error.path, expectedPath);
      }
    }

    // 5. Malformed selection in profiles.roles[].selection refuses CONFIG_SCHEMA
    set(f.config, ['spec', 'profiles', 'roles', 0], {
      roleId: 'builder',
      profileRef: 'builder',
      selection: { provider: 'bad provider', model: 'claude-sonnet-5.5' },
    });
    await f.save();
    const badProfileSel = await f.load();
    assert.equal(badProfileSel.ok, false);
    if (!badProfileSel.ok) {
      assert.equal(badProfileSel.error.code, 'CONFIG_SCHEMA');
      assert.equal(badProfileSel.error.path, '/spec/profiles/roles/0/selection/provider');
    }
  } finally {
    await f.cleanup();
  }
});

test('adapter: pi role with roleModelOverrides validates against @loopwright/agent-pi/catalog and credential destinationRef', async () => {
  const f = await configurationFixture();
  try {
    // 1. Valid built-in github-copilot override (claude-opus-5.5 with thinking: high) compiles cleanly
    const validOverride = good(await loadConfiguration(
      {
        ...f.input,
        roleModelOverrides: [{ roleId: 'builder', provider: 'github-copilot', model: 'claude-opus-5.5', thinking: 'high' }],
      },
      { environment: name => f.environment[name] },
    ));
    const validPlan = good(await compilePlan(validOverride));
    assert.equal(validPlan.roles[0]!.adapter, 'pi');
    assert.deepEqual(validPlan.roles[0]!.policy.selection, {
      provider: 'github-copilot',
      model: 'claude-opus-5.5',
      thinking: 'high',
      api: 'anthropic-messages',
    });

    // 2. Unknown model for adapter: pi refuses CAPABILITY_UNSUPPORTED at compile
    const unknownModelLoaded = good(await loadConfiguration(
      {
        ...f.input,
        roleModelOverrides: [{ roleId: 'builder', provider: 'github-copilot', model: 'nonexistent-model-99', thinking: 'high' }],
      },
      { environment: name => f.environment[name] },
    ));
    const unknownModelPlan = await compilePlan(unknownModelLoaded);
    assert.equal(unknownModelPlan.ok, false);
    if (!unknownModelPlan.ok) assert.equal(unknownModelPlan.error.code, 'CAPABILITY_UNSUPPORTED');

    // 3. Mismatched credential destinationRef for overridden provider refuses CONFIG_REFERENCE at compile
    const mismatchedProviderLoaded = good(await loadConfiguration(
      {
        ...f.input,
        roleModelOverrides: [{ roleId: 'builder', provider: 'anthropic', model: 'claude-sonnet-4-5', thinking: 'medium' }],
      },
      { environment: name => f.environment[name] },
    ));
    const mismatchedPlan = await compilePlan(mismatchedProviderLoaded);
    assert.equal(mismatchedPlan.ok, false);
    if (!mismatchedPlan.ok) assert.equal(mismatchedPlan.error.code, 'CONFIG_REFERENCE');

    // 4. Overridden active adapter: pi role whose catalog maxTokens < profile.context.maxOutputTokens refuses CAPABILITY_UNSUPPORTED at compile
    set(f.registry, ['spec', 'roleProfiles', 0, 'context', 'maxOutputTokens'], 32768);
    set(f.registry, ['spec', 'credentialBindings', 0, 'destinationRef'], 'openai');
    await f.save();
    const smallMaxTokensLoaded = good(await loadConfiguration(
      {
        ...f.input,
        roleModelOverrides: [{ roleId: 'builder', provider: 'openai', model: 'gpt-4o-mini', thinking: 'off' }],
      },
      { environment: name => f.environment[name] },
    ));
    const smallMaxTokensPlan = await compilePlan(smallMaxTokensLoaded);
    assert.equal(smallMaxTokensPlan.ok, false);
    if (!smallMaxTokensPlan.ok) {
      assert.equal(smallMaxTokensPlan.error.code, 'CAPABILITY_UNSUPPORTED');
      assert.equal(smallMaxTokensPlan.error.path, '/spec/profiles/roles');
      assert.equal(smallMaxTokensPlan.error.phase, 'compile');
    }
  } finally {
    await f.cleanup();
  }
});

test('compilePlan rejects pi.compact.v1 targeting a delegated role with CAPABILITY_UNSUPPORTED', async () => {
  const f = await configurationFixture();
  try {
    const installed = await installedHandlerDigests();
    set(f.registry, ['spec', 'runtimeProfiles'], []);
    set(f.registry, ['spec', 'credentialBindings'], []);
    set(f.registry, ['spec', 'environmentBindings'], []);
    set(f.registry, ['spec', 'handlers'], [
      ...f.registry.spec.handlers,
      {
        id: 'compact.step',
        kind: 'agent',
        implementation: 'pi.compact.v1',
        version: 1,
        digest: installed['pi.compact.v1'],
        parameters: {},
        capabilities: ['pi', 'compaction'],
      },
    ]);
    set(f.registry, ['spec', 'roleProfiles'], [{
      id: 'builder',
      adapter: 'delegated',
      runtimeRef: null,
      providerCredentialRef: null,
      selection: { provider: 'antigravity', model: 'gemini-4-argon', thinking: 'low' },
      tools: ['read', 'write'],
      mcp: null,
    }]);
    set(f.config, ['spec', 'credentials'], []);
    set(f.config, ['spec', 'task', 'spec', 'roles', 0], {
      id: 'builder',
      adapter: 'delegated',
      provider: 'antigravity',
      model: 'gemini-4-argon',
      thinking: 'low',
      tools: ['read'],
    });
    set(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'build', kind: 'agent', uses: 'package.patch', roleId: 'builder', dependsOn: [] },
      { id: 'compact', kind: 'agent', uses: 'compact.step', roleId: 'builder', dependsOn: ['build'] },
    ]);
    set(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'build', handlerRef: 'package.patch' },
      { stepId: 'compact', handlerRef: 'compact.step' },
    ]);
    await f.save();
    const loaded = good(await f.load());
    const compiled = await compilePlan(loaded);
    assert.equal(compiled.ok, false);
    if (!compiled.ok) {
      assert.equal(compiled.error.code, 'CAPABILITY_UNSUPPORTED');
      assert.equal(compiled.error.path, '/spec/profiles/steps');
      assert.equal(compiled.error.phase, 'compile');
    }
  } finally {
    await f.cleanup();
  }
});

test('mixed pi + delegated two-role DAG compiles cleanly: pi binds credential and runtime while delegated requires zero credential and zero runtime', async () => {
  const f = await configurationFixture();
  try {
    const installed = await installedHandlerDigests();
    set(f.registry, ['spec', 'handlers'], [
      ...f.registry.spec.handlers,
      {
        id: 'package.review',
        kind: 'agent',
        implementation: 'pi.agent.v1',
        version: 1,
        digest: installed['pi.agent.v1'],
        parameters: { prompt: 'Review the candidate changes carefully.', purpose: 'review' },
        capabilities: ['pi'],
      },
    ]);
    set(f.registry, ['spec', 'roleProfiles'], [
      f.registry.spec.roleProfiles[0]!,
      {
        id: 'reviewer',
        adapter: 'delegated',
        runtimeRef: null,
        providerCredentialRef: null,
        selection: { provider: 'antigravity', model: 'gemini-4-argon', thinking: 'low' },
        tools: ['read'],
        mcp: null,
      },
    ]);
    set(f.config, ['spec', 'task', 'spec', 'roles'], [
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
    set(f.config, ['spec', 'profiles', 'roles'], [
      { roleId: 'builder', profileRef: 'builder' },
      { roleId: 'reviewer', profileRef: 'reviewer' },
    ]);
    set(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'build', kind: 'agent', uses: 'package.patch', roleId: 'builder', dependsOn: [] },
      { id: 'review', kind: 'agent', uses: 'package.review', roleId: 'reviewer', dependsOn: ['build'] },
    ]);
    set(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'build', handlerRef: 'package.patch' },
      { stepId: 'review', handlerRef: 'package.review' },
    ]);
    await f.save();

    const loaded = good(await f.load());
    const plan = good(await compilePlan(loaded));
    assert.equal(plan.roles.length, 2);
    const builderRole = plan.roles.find(r => r.roleId === 'builder')!;
    const reviewerRole = plan.roles.find(r => r.roleId === 'reviewer')!;
    assert.equal(builderRole.adapter, 'pi');
    assert.equal(builderRole.providerCredentialRef, 'copilot');
    assert.equal(builderRole.runtime.id, 'docker');
    assert.equal(reviewerRole.adapter, 'delegated');
    assert.equal(reviewerRole.providerCredentialRef, null);
    assert.equal(reviewerRole.runtime.id, 'delegated.none');
    assert.deepEqual(plan.credentialReferences, [
      { ref: 'copilot', consumer: 'provider', destinationRef: 'github-copilot' },
    ]);
    assert.ok(!JSON.stringify(plan).includes(TOKEN));
  } finally {
    await f.cleanup();
  }
});

test('delegated roleProfile with explicit context, explicit runtimeRef, and compile-time mismatch/context refusals', async () => {
  const f = await configurationFixture();
  try {
    // 1. Delegated roleProfile with explicit runtimeRef and explicit context compiles cleanly
    set(f.registry, ['spec', 'credentialBindings'], []);
    set(f.registry, ['spec', 'environmentBindings'], []);
    set(f.registry, ['spec', 'roleProfiles'], [{
      id: 'builder',
      adapter: 'delegated',
      runtimeRef: 'docker',
      providerCredentialRef: null,
      selection: { provider: 'antigravity', model: 'gemini-4-argon', thinking: 'low' },
      tools: ['read', 'write'],
      context: {
        mode: 'estimated_guard',
        estimator: 'lw-pi-final-json-bytes-v1',
        proofId: null,
        version: 1,
        evidence: 'estimated',
        workingWindowCeiling: 98304,
        maxRequestBytes: 65536,
        serviceMargin: 32768,
        toolReserve: 16384,
        maxOutputTokens: 1024,
      },
      mcp: null,
    }]);
    set(f.config, ['spec', 'credentials'], []);
    set(f.config, ['spec', 'task', 'spec', 'roles', 0], {
      id: 'builder',
      adapter: 'delegated',
      provider: 'antigravity',
      model: 'gemini-4-argon',
      thinking: 'low',
      tools: ['read'],
    });
    await f.save();

    const loaded = good(await f.load());
    const plan = good(await compilePlan(loaded));
    assert.equal(plan.roles[0]!.adapter, 'delegated');
    assert.equal(plan.roles[0]!.runtime.id, 'docker');
    assert.equal(plan.roles[0]!.policy.context.maxOutputTokens, 1024);

    // 2. Mismatched selection without override refuses CONFIG_REFERENCE at compile
    set(f.config, ['spec', 'task', 'spec', 'roles', 0, 'model'], 'gemini-4-carbon');
    await f.save();
    const mismatchLoaded = good(await f.load());
    const mismatchPlan = await compilePlan(mismatchLoaded);
    assert.equal(mismatchPlan.ok, false);
    if (!mismatchPlan.ok) assert.equal(mismatchPlan.error.code, 'CONFIG_REFERENCE');

    // 3. Mismatched adapter between TaskContract role ('pi') and RoleProfile ('delegated') refuses CONFIG_REFERENCE
    set(f.config, ['spec', 'task', 'spec', 'roles', 0, 'model'], 'gemini-4-argon');
    set(f.config, ['spec', 'task', 'spec', 'roles', 0, 'adapter'], 'pi');
    await f.save();
    const adapterMismatchLoaded = good(await f.load());
    const adapterMismatchPlan = await compilePlan(adapterMismatchLoaded);
    assert.equal(adapterMismatchPlan.ok, false);
    if (!adapterMismatchPlan.ok) assert.equal(adapterMismatchPlan.error.code, 'CONFIG_REFERENCE');

    // 4. perCallOutputTokens > profile.context.maxOutputTokens on active delegated role refuses CAPABILITY_UNSUPPORTED
    set(f.config, ['spec', 'task', 'spec', 'roles', 0, 'adapter'], 'delegated');
    set(f.config, ['spec', 'task', 'spec', 'budgets', 'perCallOutputTokens'], 2048);
    await f.save();
    const budgetLoaded = good(await f.load());
    const budgetPlan = await compilePlan(budgetLoaded);
    assert.equal(budgetPlan.ok, false);
    if (!budgetPlan.ok) assert.equal(budgetPlan.error.code, 'CAPABILITY_UNSUPPORTED');

    // 5. Mismatched task.spec.roles[0].thinking vs profile.selection.thinking refuses CONFIG_REFERENCE when roleModelOverrides overrides only provider/model without thinking
    set(f.config, ['spec', 'task', 'spec', 'budgets', 'perCallOutputTokens'], 128);
    set(f.config, ['spec', 'task', 'spec', 'roles', 0, 'thinking'], 'high');
    await f.save();
    const partialOverrideLoaded = good(await loadConfiguration(
      { ...f.input, roleModelOverrides: [{ roleId: 'builder', provider: 'pi-oauth', model: 'gpt-6.1-terra' }] },
      { environment: name => f.environment[name] },
    ));
    const partialOverridePlan = await compilePlan(partialOverrideLoaded);
    assert.equal(partialOverridePlan.ok, false);
    if (!partialOverridePlan.ok) {
      assert.equal(partialOverridePlan.error.code, 'CONFIG_REFERENCE');
      assert.equal(partialOverridePlan.error.path, '/spec/profiles/roles');
    }
  } finally {
    await f.cleanup();
  }
});

test('non-null profile.mcp on a delegated role validates scriptDigest and populates mcp names/effects', async () => {
  const f = await configurationFixture();
  try {
    const validMcp = {
      ...f.registry.spec.roleProfiles[0]!.mcp!,
      names: ['mcp__workspace__read_file'],
      effects: ['read_only'],
    };
    set(f.registry, ['spec', 'runtimeProfiles'], []);
    set(f.registry, ['spec', 'credentialBindings'], []);
    set(f.registry, ['spec', 'environmentBindings'], []);
    set(f.registry, ['spec', 'roleProfiles'], [{
      id: 'builder',
      adapter: 'delegated',
      runtimeRef: null,
      providerCredentialRef: null,
      selection: { provider: 'antigravity', model: 'gemini-4-argon', thinking: 'low' },
      tools: ['read', 'mcp__workspace__read_file'],
      mcp: validMcp,
    }]);
    set(f.config, ['spec', 'credentials'], []);
    set(f.config, ['spec', 'task', 'spec', 'roles', 0], {
      id: 'builder',
      adapter: 'delegated',
      provider: 'antigravity',
      model: 'gemini-4-argon',
      thinking: 'low',
      tools: ['read', 'mcp__workspace__read_file'],
    });
    await f.save();

    // 1. Valid non-null mcp compiles cleanly with mcp__workspace__read_file
    const validLoaded = good(await f.load());
    const validPlan = good(await compilePlan(validLoaded));
    assert.deepEqual(validPlan.roles[0]!.policy.mcp.names, ['mcp__workspace__read_file']);
    assert.deepEqual(validPlan.roles[0]!.policy.mcp.effects, ['read_only']);

    // 2. Tampered scriptDigest on non-null delegated mcp refuses CONFIG_REFERENCE at compile
    set(f.registry, ['spec', 'roleProfiles', 0, 'mcp'], {
      ...validMcp,
      scriptDigest: { algorithm: 'sha256', hex: '0'.repeat(64) },
    });
    await f.save();
    const tamperedLoaded = good(await f.load());
    const tamperedPlan = await compilePlan(tamperedLoaded);
    assert.equal(tamperedPlan.ok, false);
    if (!tamperedPlan.ok) {
      assert.equal(tamperedPlan.error.code, 'CONFIG_REFERENCE');
      assert.equal(tamperedPlan.error.path, '/registry/spec/roleProfiles');
    }
  } finally {
    await f.cleanup();
  }
});

