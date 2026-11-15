import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { compilePlan, loadTrustedConfiguration, stepNext } from '@loopwright/controller';
import {
  CANONICAL_TASKPACK_STEP_GATE_URL,
  compileDeclarativeTaskpack,
  DEFAULT_HOST_BUDGETS,
  DEFAULT_LOCAL_COMMAND_GATE_ENV,
  executeTurnkeyActionCycle,
  GitHubAppError,
  LOCAL_COMMAND_GATE_ENDPOINT_ID,
  LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV,
  openStagedTaskpackStepGate,
  parseTaskpackDocument,
  runGitHubActionEntrypoint,
  serializePrettyYaml,
  stageTaskpackForStep,
  validateTaskpackManifest,
  type HostTaskpackBindings,
  type Json,
  type WrittenCompiledTaskpack,
} from '../src/index.js';

const BASE_MANIFEST_YAML = `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: delegated-sync
spec:
  goal:
    candidate: Apply upstream changes and verify all local checks.
    noChange: Confirm no upstream changes are needed.
  scope:
    writable:
      - docs
    protected:
      - docs/protected-notes.md
  upstreams:
    - id: engine
      kind: github-release
      source: octocat/engine
      watchedPaths:
        - docs
  proposal:
    path: docs/proposal.json
    requiredFields:
      - schema_version
      - candidates
    schemaVersion: 1
  verification:
    localChecks:
      - id: docs-proposal-json
        implementation: json-artifact.v1
    externalGates: []
  publication:
    mode: disabled
    targetBranch: main
    headBranchPrefix: loopwright-docs-
    titleTemplate: 'docs: sync upstream documentation'
  memory:
    directory: .loopwright/memory/delegated-sync
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands:
      - retry
      - revise
      - status
`;

function parseBaseManifest(): Json {
  return parseTaskpackDocument(Buffer.from(BASE_MANIFEST_YAML, 'utf8'), 'yaml');
}

function mutateManifest(mutate: (spec: Record<string, unknown>, root: Record<string, unknown>) => void): Json {
  const doc = parseBaseManifest() as Record<string, unknown>;
  const spec = doc['spec'] as Record<string, unknown>;
  mutate(spec, doc);
  return doc as unknown as Json;
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'lw-delegated-taskpack-'));
  await chmod(dir, 0o700);
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeTrustedArtifacts(
  root: string,
  registryBytes: Buffer,
  configBytes: Buffer,
): Promise<{ registryPath: string; configPath: string }> {
  const regDir = join(root, 'registry');
  const cfgDir = join(root, 'config');
  await mkdir(regDir, { recursive: true, mode: 0o700 });
  await mkdir(cfgDir, { recursive: true, mode: 0o700 });
  await chmod(regDir, 0o700);
  await chmod(cfgDir, 0o700);
  const registryPath = join(regDir, 'registry.yaml');
  const configPath = join(cfgDir, 'controller.yaml');
  await writeFile(registryPath, registryBytes, { mode: 0o600 });
  await writeFile(configPath, configBytes, { mode: 0o600 });
  await chmod(registryPath, 0o600);
  await chmod(configPath, 0o600);
  return { registryPath, configPath };
}

function delegatedBindings(overrides: Partial<HostTaskpackBindings> = {}): HostTaskpackBindings {
  return {
    mode: 'candidate',
    executionMode: 'delegated',
    repository: 'octocat/target',
    baseRevision: 'b'.repeat(40),
    sourceRevision: 'a'.repeat(40),
    budgets: DEFAULT_HOST_BUDGETS,
    ...overrides,
  };
}

function piBindings(overrides: Partial<HostTaskpackBindings> = {}): HostTaskpackBindings {
  return {
    mode: 'candidate',
    executionMode: 'pi',
    repository: 'octocat/target',
    baseRevision: 'b'.repeat(40),
    sourceRevision: 'a'.repeat(40),
    roleSelection: { provider: 'zai', model: 'glm-5.3', thinking: 'high' },
    budgets: DEFAULT_HOST_BUDGETS,
    credentialEnvMap: { provider: 'TASKPACK_TEST_PROVIDER_TOKEN' },
    ...overrides,
  };
}

describe('Taskpack manifest schema validation for spec.roles (1..4)', () => {
  it('validates a 1-role manifest with default purpose, thinking, tools, and dependsOn when spec.models is omitted', () => {
    const manifest = validateTaskpackManifest(mutateManifest(spec => {
      delete spec['models'];
      spec['roles'] = [
        {
          id: 'author',
          provider: 'antigravity',
          model: 'gemini-4-carbon',
        },
      ];
    }));
    assert.equal(manifest.spec.roles?.length, 1);
    const role0 = manifest.spec.roles![0]!;
    assert.equal(role0.id, 'author');
    assert.equal(role0.purpose, 'task');
    assert.equal(role0.provider, 'antigravity');
    assert.equal(role0.model, 'gemini-4-carbon');
    assert.equal(role0.thinking, 'medium');
    assert.deepEqual(role0.tools, ['read', 'write', 'edit', 'bash']);
    assert.deepEqual(role0.dependsOn, []);
  });

  it('validates a 4-role acyclic DAG with purpose: review defaulting to [read] tools', () => {
    const manifest = validateTaskpackManifest(mutateManifest(spec => {
      spec['roles'] = [
        {
          id: 'planner',
          purpose: 'task',
          provider: 'pi-oauth',
          model: 'gpt-6.1-terra',
          thinking: 'high',
          tools: ['read', 'write'],
        },
        {
          id: 'coder-a',
          provider: 'antigravity',
          model: 'gemini-4-carbon',
          dependsOn: ['planner'],
        },
        {
          id: 'coder-b',
          provider: 'claude-code',
          model: 'claude-4.5-sonnet',
          tools: ['read', 'write', 'edit', 'bash', 'delete'],
          dependsOn: ['planner'],
        },
        {
          id: 'reviewer',
          purpose: 'review',
          provider: 'antigravity',
          model: 'gemini-4-argon',
          thinking: 'low',
          dependsOn: ['coder-a', 'coder-b'],
        },
      ];
    }));
    assert.equal(manifest.spec.roles?.length, 4);
    const reviewer = manifest.spec.roles![3]!;
    assert.equal(reviewer.id, 'reviewer');
    assert.equal(reviewer.purpose, 'review');
    assert.deepEqual(reviewer.tools, ['read']);
    assert.deepEqual(reviewer.dependsOn, ['coder-a', 'coder-b']);
  });

  it('rejects 0 roles, 5 roles, non-array roles, custom-prototype objects, and unknown role fields with TASKPACK_MANIFEST_INVALID', () => {
    assert.throws(
      () => validateTaskpackManifest(mutateManifest(spec => { spec['roles'] = []; })),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID' && err.path === '/spec/roles',
    );
    assert.throws(
      () => validateTaskpackManifest(mutateManifest(spec => {
        spec['roles'] = [1, 2, 3, 4, 5].map(i => ({ id: `r${i}`, provider: 'p', model: 'm' }));
      })),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID' && err.path === '/spec/roles',
    );
    assert.throws(
      () => validateTaskpackManifest(mutateManifest(spec => { spec['roles'] = 'not-an-array'; })),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID' && err.path === '/spec/roles',
    );
    assert.throws(
      () => validateTaskpackManifest(mutateManifest(spec => {
        spec['roles'] = [{ id: 'r1', provider: 'p', model: 'm', extraKey: true }];
      })),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );
    assert.throws(
      () => validateTaskpackManifest(mutateManifest(spec => {
        const customProtoRole = Object.assign(Object.create({ purpose: 'review', extra: 1 }), {
          id: 'r1',
          provider: 'p',
          model: 'm',
        });
        spec['roles'] = [customProtoRole];
      })),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID' && err.path === '/spec/roles/0',
    );
  });

  it('rejects duplicate role IDs, reserved IDs, and role IDs colliding with check IDs', () => {
    assert.throws(
      () => validateTaskpackManifest(mutateManifest(spec => {
        spec['roles'] = [
          { id: 'dup', provider: 'p', model: 'm' },
          { id: 'dup', provider: 'p', model: 'm' },
        ];
      })),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );
    assert.throws(
      () => validateTaskpackManifest(mutateManifest(spec => {
        spec['roles'] = [{ id: 'docs-proposal-json', provider: 'p', model: 'm' }];
      })),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );
    assert.throws(
      () => validateTaskpackManifest(mutateManifest(spec => {
        spec['roles'] = [{ id: 'controller.scope', provider: 'p', model: 'm' }];
      })),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );
  });

  it('rejects self-dependency, forward dependsOn references, cycles, and unknown dependsOn IDs', () => {
    // Self-dependency
    assert.throws(
      () => validateTaskpackManifest(mutateManifest(spec => {
        spec['roles'] = [{ id: 'r1', provider: 'p', model: 'm', dependsOn: ['r1'] }];
      })),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID' && err.path?.startsWith('/spec/roles/0/dependsOn') === true,
    );
    // Unknown dependsOn
    assert.throws(
      () => validateTaskpackManifest(mutateManifest(spec => {
        spec['roles'] = [{ id: 'r1', provider: 'p', model: 'm', dependsOn: ['missing'] }];
      })),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID' && err.path?.startsWith('/spec/roles/0/dependsOn') === true,
    );
    // Forward dependsOn reference ([{ id: 'r2', dependsOn: ['r1'] }, { id: 'r1' }])
    assert.throws(
      () => validateTaskpackManifest(mutateManifest(spec => {
        spec['roles'] = [
          { id: 'r2', provider: 'p', model: 'm', dependsOn: ['r1'] },
          { id: 'r1', provider: 'p', model: 'm' },
        ];
      })),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID' && err.path === '/spec/roles/0/dependsOn/0',
    );
    // 2-node cycle
    assert.throws(
      () => validateTaskpackManifest(mutateManifest(spec => {
        spec['roles'] = [
          { id: 'r1', provider: 'p', model: 'm', dependsOn: ['r2'] },
          { id: 'r2', provider: 'p', model: 'm', dependsOn: ['r1'] },
        ];
      })),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID' && err.path?.includes('dependsOn') === true,
    );
    // 3-node cycle
    assert.throws(
      () => validateTaskpackManifest(mutateManifest(spec => {
        spec['roles'] = [
          { id: 'r1', provider: 'p', model: 'm', dependsOn: ['r3'] },
          { id: 'r2', provider: 'p', model: 'm', dependsOn: ['r1'] },
          { id: 'r3', provider: 'p', model: 'm', dependsOn: ['r2'] },
        ];
      })),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID' && err.path?.includes('dependsOn') === true,
    );
  });

  it('rejects invalid tools (such as mcp__workspace__read_file or codemode), invalid labels with whitespace, and unasked prompt field', () => {
    assert.throws(
      () => validateTaskpackManifest(mutateManifest(spec => {
        spec['roles'] = [{ id: 'r1', provider: 'p', model: 'm', tools: ['read', 'mcp__workspace__read_file'] }];
      })),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );
    assert.throws(
      () => validateTaskpackManifest(mutateManifest(spec => {
        spec['roles'] = [{ id: 'r1', provider: 'p', model: 'bad model' }];
      })),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );
    assert.throws(
      () => validateTaskpackManifest(mutateManifest(spec => {
        spec['roles'] = [{ id: 'r1', provider: 'p', model: 'm', purpose: 'unknown' }];
      })),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );
    assert.throws(
      () => validateTaskpackManifest(mutateManifest(spec => {
        spec['roles'] = [{ id: 'r1', provider: 'p', model: 'm', prompt: 'custom prompt' }];
      })),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID' && err.path === '/spec/roles/0',
    );
  });
});

describe('compileDeclarativeTaskpack multi-role and zero-secret delegated mode', () => {
  it('wires sink roles of a 2-branch DAG (r1 -> r2, r1 -> r3) into checks[0].dependsOn sorted deterministically', async () => {
    const manifest = validateTaskpackManifest(mutateManifest(spec => {
      spec['roles'] = [
        { id: 'r1', provider: 'antigravity', model: 'gemini-4-carbon' },
        { id: 'r3', provider: 'antigravity', model: 'gemini-4-argon', dependsOn: ['r1'] },
        { id: 'r2', provider: 'pi-oauth', model: 'gpt-6.1-terra', dependsOn: ['r1'] },
      ];
    }));
    const compiled = await compileDeclarativeTaskpack(manifest, delegatedBindings());
    const steps = compiled.config.spec.task.spec.steps;
    const firstCheck = steps.find(s => s.kind === 'check')!;
    assert.deepEqual(firstCheck.dependsOn, ['r2', 'r3']);
  });

  it('preserves single-author compilation when spec.roles is omitted in both executionMode: pi and executionMode: delegated', async () => {
    const manifest = validateTaskpackManifest(parseBaseManifest());

    // 1. executionMode: 'pi'
    const compiledPi = await compileDeclarativeTaskpack(manifest, piBindings());
    assert.equal(compiledPi.config.spec.task.spec.roles.length, 1);
    assert.equal(compiledPi.config.spec.task.spec.roles[0]!.id, 'author');
    assert.equal(compiledPi.config.spec.task.spec.roles[0]!.adapter, 'pi');
    assert.equal(compiledPi.config.spec.task.spec.steps[0]!.id, 'author-candidate');
    assert.equal(compiledPi.registry.spec.runtimeProfiles.length, 1);
    assert.equal(compiledPi.registry.spec.credentialBindings.some(c => c.consumer === 'provider'), true);

    // 2. executionMode: 'delegated' with omitted spec.models -> defaults to { provider: 'delegated', model: 'default', thinking: 'medium' }
    const compiledDelegatedDefault = await compileDeclarativeTaskpack(manifest, delegatedBindings());
    assert.equal(compiledDelegatedDefault.config.spec.task.spec.roles.length, 1);
    const defaultRole0 = compiledDelegatedDefault.config.spec.task.spec.roles[0]!;
    assert.deepEqual({ ...defaultRole0 }, {
      id: 'author',
      adapter: 'delegated',
      provider: 'delegated',
      model: 'default',
      thinking: 'medium',
      tools: ['read', 'write', 'edit', 'bash', 'delete'],
    });
    assert.equal(compiledDelegatedDefault.config.spec.task.spec.steps[0]!.id, 'author-candidate');
    assert.deepEqual(compiledDelegatedDefault.registry.spec.runtimeProfiles, []);
    assert.deepEqual(compiledDelegatedDefault.registry.spec.credentialBindings, []);
    assert.deepEqual(compiledDelegatedDefault.registry.spec.environmentBindings, []);
    assert.deepEqual(compiledDelegatedDefault.config.spec.credentials, []);

    // 3. executionMode: 'delegated' with spec.models present -> takes first model's provider/id/thinking as raw labels
    const manifestWithModels = validateTaskpackManifest(mutateManifest(spec => {
      spec['models'] = [{ provider: 'custom-vendor', id: 'unregistered-model-v9', thinking: 'low' }];
    }));
    const compiledDelegatedModel = await compileDeclarativeTaskpack(manifestWithModels, delegatedBindings());
    const modelRole0 = compiledDelegatedModel.config.spec.task.spec.roles[0]!;
    assert.deepEqual({ ...modelRole0 }, {
      id: 'author',
      adapter: 'delegated',
      provider: 'custom-vendor',
      model: 'unregistered-model-v9',
      thinking: 'low',
      tools: ['read', 'write', 'edit', 'bash', 'delete'],
    });
  });

  it('compiles zero-secret multi-role delegated taskpacks and passes loadConfiguration + compilePlan (including roleModelOverrides)', async () => {
    await withTempDir(async dir => {
      const manifest = validateTaskpackManifest(mutateManifest(spec => {
        spec['roles'] = [
          {
            id: 'implementer',
            purpose: 'task',
            provider: 'antigravity',
            model: 'gemini-4-carbon',
            thinking: 'high',
            tools: ['read', 'write', 'edit', 'bash'],
          },
          {
            id: 'reviewer',
            purpose: 'review',
            provider: 'pi-oauth',
            model: 'gpt-6.1-terra',
            thinking: 'medium',
            dependsOn: ['implementer'],
          },
        ];
      }));
      const compiled = await compileDeclarativeTaskpack(manifest, delegatedBindings({
        authorPrompt: 'Author prompt with upstream discovery context',
      }));
      assert.deepEqual(compiled.registry.spec.runtimeProfiles, []);
      assert.deepEqual(compiled.registry.spec.credentialBindings, []);
      assert.deepEqual(compiled.registry.spec.environmentBindings, []);
      assert.deepEqual(compiled.config.spec.credentials, []);
      assert.equal(compiled.registry.spec.roleProfiles.length, 2);
      const implHandler = compiled.registry.spec.handlers.find(h => h.id === 'agent.implementer');
      assert.equal(implHandler?.parameters['prompt'], 'Author prompt with upstream discovery context');
      for (const rp of compiled.registry.spec.roleProfiles) {
        assert.equal(rp.adapter, 'delegated');
        assert.equal(rp.runtimeRef, null);
        assert.equal(rp.providerCredentialRef, null);
        assert.equal(rp.mcp, null);
      }

      const configBytes = Buffer.from(serializePrettyYaml(compiled.config), 'utf8');
      const { registryPath, configPath } = await writeTrustedArtifacts(dir, compiled.registryBytes, configBytes);

      const loaded = await loadTrustedConfiguration({
        configPath,
        registryPath,
        registrySha256: compiled.registrySha256,
        untrustedRoots: [join(dir, 'repo')],
      });
      assert.equal(loaded.ok, true, loaded.ok ? '' : JSON.stringify(loaded.error));
      if (!loaded.ok) return;

      const plan = await compilePlan(loaded.value);
      assert.equal(plan.ok, true, plan.ok ? '' : JSON.stringify(plan.error));
      if (!plan.ok) return;
      assert.equal(plan.value.roles.length, 2);
      assert.equal(plan.value.roles[0]!.roleId, 'implementer');
      assert.equal(plan.value.roles[0]!.adapter, 'delegated');
      assert.equal(plan.value.roles[1]!.roleId, 'reviewer');
      assert.equal(plan.value.roles[1]!.adapter, 'delegated');
      assert.deepEqual(plan.value.roles[1]!.policy.tools, ['read']);

      // Verify --role-model roleModelOverrides also compile cleanly without mutating registrySha256
      const loadedOverride = await loadTrustedConfiguration({
        configPath,
        registryPath,
        registrySha256: compiled.registrySha256,
        untrustedRoots: [join(dir, 'repo')],
        roleModelOverrides: [
          { roleId: 'reviewer', provider: 'claude-code', model: 'claude-4.5-opus', thinking: 'high' },
        ],
      });
      assert.equal(loadedOverride.ok, true);
      if (!loadedOverride.ok) return;
      const planOverride = await compilePlan(loadedOverride.value);
      assert.equal(planOverride.ok, true);
      if (!planOverride.ok) return;
      assert.equal(planOverride.value.roles[1]!.policy.selection.provider, 'claude-code');
      assert.equal(planOverride.value.roles[1]!.policy.selection.model, 'claude-4.5-opus');
      assert.equal(planOverride.value.roles[1]!.policy.selection.thinking, 'high');
    });
  });

  it('computes dynamic controls.maxAttempts within D <= 64 on 4-role taskpacks and refuses excess capacity with TASKPACK_MANIFEST_INVALID', async () => {
    await withTempDir(async dir => {
      const manifest4 = validateTaskpackManifest(mutateManifest(spec => {
        spec['roles'] = [
          { id: 'r1', provider: 'antigravity', model: 'gemini-4-carbon' },
          { id: 'r2', provider: 'antigravity', model: 'gemini-4-carbon', dependsOn: ['r1'] },
          { id: 'r3', provider: 'antigravity', model: 'gemini-4-carbon', dependsOn: ['r2'] },
          { id: 'r4', purpose: 'review', provider: 'antigravity', model: 'gemini-4-argon', dependsOn: ['r3'] },
        ];
      }));
      const compiled4 = await compileDeclarativeTaskpack(manifest4, delegatedBindings());
      assert.equal(compiled4.config.spec.controls.maxAttempts >= 4, true);
      assert.equal(compiled4.config.spec.controls.maxAttempts <= 16, true);

      const configBytes = Buffer.from(serializePrettyYaml(compiled4.config), 'utf8');
      const { registryPath, configPath } = await writeTrustedArtifacts(dir, compiled4.registryBytes, configBytes);
      const loaded = await loadTrustedConfiguration({
        configPath,
        registryPath,
        registrySha256: compiled4.registrySha256,
        untrustedRoots: [join(dir, 'repo')],
      });
      assert.equal(loaded.ok, true);
      if (!loaded.ok) return;
      const plan = await compilePlan(loaded.value);
      assert.equal(plan.ok, true);
      if (!plan.ok) return;
      assert.equal(plan.value.capacity.D <= 64, true);

      // Excess checks + 4 roles where even A = N exceeds D <= 64 must throw TASKPACK_MANIFEST_INVALID
      const excessManifest = validateTaskpackManifest(mutateManifest(spec => {
        spec['roles'] = [
          { id: 'r1', provider: 'antigravity', model: 'gemini-4-carbon' },
          { id: 'r2', provider: 'antigravity', model: 'gemini-4-carbon', dependsOn: ['r1'] },
          { id: 'r3', provider: 'antigravity', model: 'gemini-4-carbon', dependsOn: ['r2'] },
          { id: 'r4', provider: 'antigravity', model: 'gemini-4-carbon', dependsOn: ['r3'] },
        ];
        spec['verification'] = {
          localChecks: [1, 2, 3, 4, 5].map(i => ({ id: `chk-${i}`, implementation: 'json-artifact.v1' })),
          externalGates: [],
        };
      }));
      await assert.rejects(
        () => compileDeclarativeTaskpack(excessManifest, delegatedBindings()),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID' && err.path === '/spec/roles',
      );

      // Zero required checks with spec.roles throws TASKPACK_MANIFEST_INVALID at /spec/verification
      const zeroChecksManifest = validateTaskpackManifest(mutateManifest(spec => {
        spec['roles'] = [{ id: 'r1', provider: 'antigravity', model: 'gemini-4-carbon' }];
        spec['verification'] = { localChecks: [], externalGates: [] };
      }));
      await assert.rejects(
        () => compileDeclarativeTaskpack(zeroChecksManifest, delegatedBindings()),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID' && err.path === '/spec/verification',
      );
    });
  });

  it('compiles multi-role executionMode: pi across distinct providers (zai + openai), tolerates candidateIndex: 1, and rejects invalid Pi thinking or OAuth providers', async () => {
    const multiProviderManifest = validateTaskpackManifest(mutateManifest(spec => {
      spec['models'] = [
        { provider: 'zai', id: 'glm-5.3', thinking: 'high' },
        { provider: 'openai', id: 'gpt-5', thinking: 'medium' },
      ];
      spec['roles'] = [
        { id: 'role-a', provider: 'zai', model: 'glm-5.3', thinking: 'high' },
        { id: 'role-b', purpose: 'review', provider: 'openai', model: 'gpt-5', thinking: 'medium', dependsOn: ['role-a'] },
      ];
    }));
    const compiledPiMulti = await compileDeclarativeTaskpack(multiProviderManifest, piBindings({
      roleSelection: undefined,
      candidateIndex: 1,
      credentialEnvMap: undefined,
    }));
    const providerBindings = compiledPiMulti.registry.spec.credentialBindings.filter(b => b.consumer === 'provider');
    assert.equal(providerBindings.length, 2);
    const zaiBinding = providerBindings.find(b => b.destinationRef === 'zai')!;
    const openaiBinding = providerBindings.find(b => b.destinationRef === 'openai')!;
    assert.equal(zaiBinding.id, 'taskpack-provider-token');
    assert.equal(openaiBinding.id, 'taskpack-provider-token-role-b');
    assert.deepEqual(zaiBinding.environmentNames, ['ZAI_API_KEY']);
    assert.deepEqual(openaiBinding.environmentNames, ['OPENAI_API_KEY']);
    assert.notEqual(zaiBinding.environmentNames[0], openaiBinding.environmentNames[0]);

    // Invalid Pi thinking level in spec.roles throws TASKPACK_MANIFEST_INVALID at /spec/roles/0/thinking
    const badThinkingManifest = validateTaskpackManifest(mutateManifest(spec => {
      spec['roles'] = [{ id: 'role-a', provider: 'zai', model: 'glm-5.3', thinking: 'ultra-deep' }];
    }));
    await assert.rejects(
      () => compileDeclarativeTaskpack(badThinkingManifest, piBindings({ roleSelection: undefined })),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID' && err.path === '/spec/roles/0/thinking',
    );

    // OAuth / delegated provider in executionMode: 'pi' throws PROVIDER_OAUTH_UNSUPPORTED
    const oauthRoleManifest = validateTaskpackManifest(mutateManifest(spec => {
      spec['roles'] = [{ id: 'role-a', provider: 'antigravity', model: 'gemini-4-carbon' }];
    }));
    await assert.rejects(
      () => compileDeclarativeTaskpack(oauthRoleManifest, piBindings({ roleSelection: undefined })),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'PROVIDER_OAUTH_UNSUPPORTED',
    );
  });
});

describe('stageTaskpackForStep and openStagedTaskpackStepGate', () => {
  it('stages .taskpack-<runId> with 0o700/0o600 permissions, keeps registrySha256 constant across ticks, and rebinds ephemeral command.v1 gate URLs', async () => {
    await withTempDir(async dir => {
      const repoRoot = join(dir, 'repo');
      const runRoot = join(dir, 'runs');
      await mkdir(join(repoRoot, '.loopwright', 'checks'), { recursive: true });
      await mkdir(join(repoRoot, 'docs'), { recursive: true });
      await writeFile(join(repoRoot, 'docs', 'proposal.json'), '{"schema_version":1,"candidates":[]}\n');
      const checkScript = join(repoRoot, '.loopwright', 'checks', 'verify.sh');
      await writeFile(checkScript, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      const manifestDoc = mutateManifest(spec => {
        spec['roles'] = [
          { id: 'author', provider: 'antigravity', model: 'gemini-4-carbon' },
          { id: 'reviewer', purpose: 'review', provider: 'antigravity', model: 'gemini-4-argon', dependsOn: ['author'] },
        ];
        spec['verification'] = {
          localChecks: [
            { id: 'docs-proposal-json', implementation: 'json-artifact.v1' },
            { id: 'verify-cmd', implementation: 'command.v1', parameters: { script: '.loopwright/checks/verify.sh', timeoutSeconds: 10 } },
          ],
          externalGates: [],
        };
      });
      await writeFile(join(repoRoot, '.loopwright', 'taskpack.yaml'), serializePrettyYaml(manifestDoc));

      // Initialize local git repository without any remote configured
      spawnSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, stdio: 'ignore' });

      // Managed controller run without staged .taskpack-<runId> returns null from openStagedTaskpackStepGate
      const noStage = await openStagedTaskpackStepGate({ runRoot, runId: 'managed-run' });
      assert.equal(noStage, null);

      const staged1 = await stageTaskpackForStep({
        taskpackPath: '.loopwright/taskpack.yaml',
        repositoryRoot: repoRoot,
        runRoot,
        runId: 'step-run-1',
        discoverUpstreams: false,
      });
      assert.equal(staged1.localCommandGates.length, 1);

      const stageDirStat = await stat(staged1.stageDir);
      assert.equal(stageDirStat.mode & 0o777, 0o700);
      const regStat = await stat(staged1.registryPath);
      assert.equal(regStat.mode & 0o777, 0o600);
      const cfgStat = await stat(staged1.configPath);
      assert.equal(cfgStat.mode & 0o777, 0o600);
      const secretsStat = await stat(join(staged1.stageDir, 'secrets.json'));
      assert.equal(secretsStat.mode & 0o777, 0o600);

      const regText = await readFile(staged1.registryPath, 'utf8');
      assert.equal(regText.includes(CANONICAL_TASKPACK_STEP_GATE_URL), true);
      assert.equal(regText.includes(staged1.signingSecret), false);

      // Second call to stageTaskpackForStep on same runId reuses existing secrets.json & registrySha256
      const staged2 = await stageTaskpackForStep({
        taskpackPath: '.loopwright/taskpack.yaml',
        repositoryRoot: repoRoot,
        runRoot,
        runId: 'step-run-1',
        discoverUpstreams: false,
      });
      assert.equal(staged2.registrySha256, staged1.registrySha256);
      assert.equal(staged2.signingSecret, staged1.signingSecret);

      // Open two separate step gate handles sequentially; ephemeral port changes while registrySha256 stays identical
      const handle1 = await openStagedTaskpackStepGate({ runRoot, runId: 'step-run-1' });
      assert.notEqual(handle1, null);
      if (handle1 === null) return;
      try {
        assert.equal(handle1.staged.registrySha256, staged1.registrySha256);
        assert.equal(handle1.environment(DEFAULT_LOCAL_COMMAND_GATE_ENV), staged1.signingSecret);
        const overrideUrl1 = handle1.gateUrlOverrides[LOCAL_COMMAND_GATE_ENDPOINT_ID];
        assert.equal(typeof overrideUrl1, 'string');
        assert.notEqual(overrideUrl1, CANONICAL_TASKPACK_STEP_GATE_URL);

        const previousSecret = process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
        process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = handle1.environment(DEFAULT_LOCAL_COMMAND_GATE_ENV);
        try {
          const loaded1 = await loadTrustedConfiguration({
            configPath: handle1.staged.configPath,
            registryPath: handle1.staged.registryPath,
            registrySha256: handle1.staged.registrySha256,
            untrustedRoots: [repoRoot],
          });
          assert.equal(loaded1.ok, true, loaded1.ok ? '' : JSON.stringify(loaded1.error));
          if (loaded1.ok) {
            const plan1 = await compilePlan(loaded1.value);
            assert.equal(plan1.ok, true, plan1.ok ? '' : JSON.stringify(plan1.error));
          }
        } finally {
          if (previousSecret === undefined) {
            delete process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
          } else {
            process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = previousSecret;
          }
        }
      } finally {
        await handle1.close();
      }

      const handle2 = await openStagedTaskpackStepGate({ runRoot, runId: 'step-run-1' });
      assert.notEqual(handle2, null);
      if (handle2 === null) return;
      try {
        assert.equal(handle2.staged.registrySha256, staged1.registrySha256);
        assert.equal(typeof handle2.gateUrlOverrides[LOCAL_COMMAND_GATE_ENDPOINT_ID], 'string');
      } finally {
        await handle2.close();
      }

      // World-readable secrets.json (0o644) is rejected with ACTION_INPUT_INVALID
      await chmod(join(staged1.stageDir, 'secrets.json'), 0o644);
      await assert.rejects(
        () => openStagedTaskpackStepGate({ runRoot, runId: 'step-run-1' }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID',
      );

      // Symlinked secrets.json is rejected with ACTION_INPUT_INVALID
      await rm(join(staged1.stageDir, 'secrets.json'), { force: true });
      const decoySecrets = join(dir, 'decoy-secrets.json');
      await writeFile(decoySecrets, '{"version":1}\n', { mode: 0o600 });
      await symlink(decoySecrets, join(staged1.stageDir, 'secrets.json'));
      await assert.rejects(
        () => openStagedTaskpackStepGate({ runRoot, runId: 'step-run-1' }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID',
      );
    });
  });

  it('rejects pre-existing symlink at <runRoot>/.taskpack-<runId> and hardlinked secrets.json (nlink > 1) with ACTION_INPUT_INVALID', async () => {
    await withTempDir(async dir => {
      const repoRoot = join(dir, 'repo');
      const runRoot = join(dir, 'runs');
      const outsideDir = join(dir, 'outside-target');
      await mkdir(join(repoRoot, '.loopwright'), { recursive: true });
      await mkdir(join(repoRoot, 'docs'), { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await mkdir(outsideDir, { recursive: true, mode: 0o700 });
      await writeFile(join(repoRoot, 'docs', 'proposal.json'), '{"schema_version":1,"candidates":[]}\n');
      await writeFile(join(repoRoot, '.loopwright', 'taskpack.yaml'), BASE_MANIFEST_YAML);

      spawnSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, stdio: 'ignore' });

      // 1. Pre-existing directory symlink at <runRoot>/.taskpack-<runId> is rejected by stageTaskpackForStep
      const symlinkStageDir = join(runRoot, '.taskpack-symlink-run');
      await symlink(outsideDir, symlinkStageDir);
      await assert.rejects(
        () => stageTaskpackForStep({
          taskpackPath: '.loopwright/taskpack.yaml',
          repositoryRoot: repoRoot,
          runRoot,
          runId: 'symlink-run',
          discoverUpstreams: false,
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID',
      );
      await assert.rejects(
        () => openStagedTaskpackStepGate({ runRoot, runId: 'symlink-run' }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID',
      );

      // 2. Hardlinked secrets.json (nlink > 1) is rejected by both stageTaskpackForStep reuse and openStagedTaskpackStepGate
      const staged = await stageTaskpackForStep({
        taskpackPath: '.loopwright/taskpack.yaml',
        repositoryRoot: repoRoot,
        runRoot,
        runId: 'hardlink-run',
        discoverUpstreams: false,
      });
      const hardlinkTarget = join(dir, 'hardlinked-secrets.json');
      await link(join(staged.stageDir, 'secrets.json'), hardlinkTarget);
      await assert.rejects(
        () => stageTaskpackForStep({
          taskpackPath: '.loopwright/taskpack.yaml',
          repositoryRoot: repoRoot,
          runRoot,
          runId: 'hardlink-run',
          discoverUpstreams: false,
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID',
      );
      await assert.rejects(
        () => openStagedTaskpackStepGate({ runRoot, runId: 'hardlink-run' }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID',
      );
    });
  });

  it('rejects overlapping, symlinked, or ancestor runRoot in stageTaskpackForStep with ACTION_INPUT_INVALID and zero filesystem mutation', async () => {
    await withTempDir(async dir => {
      const parentForAncestorTest = join(dir, 'ancestor-root');
      const repoRoot = join(parentForAncestorTest, 'workspaces', 'nested-repo');
      await mkdir(join(repoRoot, '.loopwright'), { recursive: true });
      await mkdir(join(repoRoot, 'docs'), { recursive: true });
      await writeFile(join(repoRoot, 'docs', 'proposal.json'), '{"schema_version":1,"candidates":[]}\n');
      await writeFile(join(repoRoot, '.loopwright', 'taskpack.yaml'), BASE_MANIFEST_YAML);

      spawnSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, stdio: 'ignore' });
      await chmod(repoRoot, 0o755);

      const assertRepoUnmutated = async () => {
        const statusOut = spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
        assert.equal(statusOut, '');
        const repoStat = await lstat(repoRoot);
        assert.equal(repoStat.mode & 0o777, 0o755);
      };

      // 1. runRoot is <repo>/inside-runs (non-existent subdirectory inside repositoryRoot)
      const insideRunRoot = join(repoRoot, 'inside-runs');
      await assert.rejects(
        () => stageTaskpackForStep({
          taskpackPath: '.loopwright/taskpack.yaml',
          repositoryRoot: repoRoot,
          runRoot: insideRunRoot,
          runId: 'inside-run',
          discoverUpstreams: false,
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID',
      );
      assert.equal(await lstat(insideRunRoot).then(() => true, () => false), false);
      await assertRepoUnmutated();

      // 2. runRoot equals repositoryRoot (0o755 mode preserved, NOT changed to 0o700!)
      await assert.rejects(
        () => stageTaskpackForStep({
          taskpackPath: '.loopwright/taskpack.yaml',
          repositoryRoot: repoRoot,
          runRoot: repoRoot,
          runId: 'equal-run',
          discoverUpstreams: false,
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID',
      );
      await assertRepoUnmutated();

      // 3. runRoot is a symlink pointing at repositoryRoot (0o755 mode preserved on repositoryRoot)
      const symlinkRunRoot = join(dir, 'symlink-to-repo');
      await symlink(repoRoot, symlinkRunRoot);
      await assert.rejects(
        () => stageTaskpackForStep({
          taskpackPath: '.loopwright/taskpack.yaml',
          repositoryRoot: repoRoot,
          runRoot: symlinkRunRoot,
          runId: 'symlink-repo-run',
          discoverUpstreams: false,
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID',
      );
      await assertRepoUnmutated();

      // 4. runRoot is an ancestor directory whose <runRoot>/workspaces or <runRoot>/<runId> encloses repositoryRoot
      await chmod(parentForAncestorTest, 0o755);
      await assert.rejects(
        () => stageTaskpackForStep({
          taskpackPath: '.loopwright/taskpack.yaml',
          repositoryRoot: repoRoot,
          runRoot: parentForAncestorTest,
          runId: 'ancestor-run',
          discoverUpstreams: false,
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID',
      );
      assert.equal((await lstat(parentForAncestorTest)).mode & 0o777, 0o755);
      assert.equal(await lstat(join(parentForAncestorTest, '.taskpack-ancestor-run')).then(() => true, () => false), false);
      await assertRepoUnmutated();
    });
  });

  it('forwards process.env variables declared in command.v1 parameters.env when openStagedTaskpackStepGate is called with runtimeEnv omitted, and refuses OAuth spec.roles in runGitHubActionEntrypoint', async () => {
    await withTempDir(async dir => {
      const repoRoot = join(dir, 'repo');
      const runRoot = join(dir, 'runs');
      await mkdir(join(repoRoot, '.loopwright', 'checks'), { recursive: true });
      await mkdir(join(repoRoot, 'docs'), { recursive: true });
      await writeFile(join(repoRoot, 'docs', 'proposal.json'), '{"schema_version":1,"candidates":[]}\n');
      const checkScript = join(repoRoot, '.loopwright', 'checks', 'env-check.sh');
      await writeFile(
        checkScript,
        '#!/bin/sh\nif [ "$CUSTOM_GATE_VAR" != "expected-from-process-env" ]; then echo "missing CUSTOM_GATE_VAR"; exit 1; fi\nexit 0\n',
        { mode: 0o755 },
      );

      const manifestDoc = mutateManifest(spec => {
        spec['roles'] = [
          { id: 'author', provider: 'antigravity', model: 'gemini-4-carbon' },
        ];
        spec['verification'] = {
          localChecks: [
            {
              id: 'env-cmd',
              implementation: 'command.v1',
              parameters: {
                script: '.loopwright/checks/env-check.sh',
                timeoutSeconds: 10,
                env: ['CUSTOM_GATE_VAR'],
              },
            },
          ],
          externalGates: [],
        };
      });
      await writeFile(join(repoRoot, '.loopwright', 'taskpack.yaml'), serializePrettyYaml(manifestDoc));

      spawnSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, stdio: 'ignore' });
      const headSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();

      // Unattended runGitHubActionEntrypoint refuses OAuth/delegated spec.roles providers with PROVIDER_OAUTH_UNSUPPORTED
      const actionResult = await runGitHubActionEntrypoint({
        repositoryRoot: repoRoot,
        repositoryFullName: 'octocat/target',
        baseRevision: headSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'action-oauth-refusal',
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: 'v2.0.0' }],
        dryRun: true,
      });
      assert.equal(actionResult.kind, 'refused');
      if (actionResult.kind === 'refused') {
        assert.equal(actionResult.code, 'PROVIDER_OAUTH_UNSUPPORTED');
      }

      // Stage with oversized upstream records (> 12288 bytes) and verify truncation preserves upstream header instead of dropping all upstreams
      const largeUpstreams = Array.from({ length: 120 }, (_, idx) => ({
        upstreamId: 'engine',
        status: 'available' as const,
        version: `v2.0.${idx}-${'x'.repeat(120)}`,
      }));
      const staged = await stageTaskpackForStep({
        taskpackPath: '.loopwright/taskpack.yaml',
        repositoryRoot: repoRoot,
        runRoot,
        runId: 'env-step-run',
        upstreamRecordsJson: JSON.stringify(largeUpstreams),
      });
      const stagedRegText = await readFile(staged.registryPath, 'utf8');
      assert.equal(stagedRegText.includes('Host-discovered upstream states'), true);
      assert.equal(stagedRegText.includes('...[truncated to fit prompt budget]'), true);

      const previousCustomVar = process.env['CUSTOM_GATE_VAR'];
      process.env['CUSTOM_GATE_VAR'] = 'expected-from-process-env';
      try {
        const handle = await openStagedTaskpackStepGate({ runRoot, runId: 'env-step-run' });
        assert.notEqual(handle, null);
        if (handle === null) return;
        try {
          assert.equal(handle.environment('CUSTOM_GATE_VAR'), 'expected-from-process-env');
          assert.equal(handle.environment('toString'), undefined);
        } finally {
          await handle.close();
        }
      } finally {
        if (previousCustomVar === undefined) {
          delete process.env['CUSTOM_GATE_VAR'];
        } else {
          process.env['CUSTOM_GATE_VAR'] = previousCustomVar;
        }
      }
    });
  });

  it('rejects provider credential env vars and _1.._16 pool suffixes in command.v1 parameters.env and staged secrets.json, and includes declared check IDs in StepYield.prompt', async () => {
    await withTempDir(async dir => {
      const repoRoot = join(dir, 'repo');
      const runRoot = join(dir, 'runs');
      await mkdir(join(repoRoot, '.loopwright', 'checks'), { recursive: true });
      await mkdir(join(repoRoot, 'docs'), { recursive: true });
      await writeFile(join(repoRoot, 'docs', 'proposal.json'), '{"schema_version":1,"candidates":[]}\n');
      const checkScript = join(repoRoot, '.loopwright', 'checks', 'verify.sh');
      await writeFile(checkScript, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      spawnSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, stdio: 'ignore' });

      // 1. compileDeclarativeTaskpack(..., { executionMode: 'delegated' }) and stageTaskpackForStep reject ZAI_API_KEY, ZAI_API_KEY_1, DEEPSEEK_API_KEY, and custom role/model default provider env + _1.._16 pool suffixes
      const baseValidManifest = validateTaskpackManifest(mutateManifest(spec => {
        spec['roles'] = [{ id: 'author', provider: 'antigravity', model: 'gemini-4-carbon' }];
        spec['verification'] = {
          localChecks: [
            {
              id: 'cmd-check',
              implementation: 'command.v1',
              parameters: {
                script: '.loopwright/checks/verify.sh',
                timeoutSeconds: 10,
                env: ['SAFE_ENV'],
              },
            },
          ],
          externalGates: [],
        };
      }));
      for (const forbiddenEnv of ['ZAI_API_KEY', 'ZAI_API_KEY_1', 'DEEPSEEK_API_KEY', 'LOOPWRIGHT_PROVIDER_TOKEN', 'LOOPWRIGHT_PROVIDER_TOKEN_16']) {
        const mutatedManifest = {
          ...baseValidManifest,
          spec: {
            ...baseValidManifest.spec,
            verification: {
              ...baseValidManifest.spec.verification,
              localChecks: [
                {
                  id: 'cmd-check',
                  implementation: 'command.v1' as const,
                  parameters: {
                    script: '.loopwright/checks/verify.sh',
                    timeoutSeconds: 10,
                    allowReadOnlyGitHubToken: false,
                    env: [forbiddenEnv],
                  },
                },
              ],
            },
          },
        };
        await assert.rejects(
          () => compileDeclarativeTaskpack(mutatedManifest, delegatedBindings({ repositoryRoot: repoRoot })),
          (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
        );
      }

      // Also verify stageTaskpackForStep rejects command.v1 parameters.env: ['ZAI_API_KEY'] and ['ZAI_API_KEY_1'] (and ['DEEPSEEK_API_KEY']) with TASKPACK_MANIFEST_INVALID
      for (const [idx, envVar] of ['ZAI_API_KEY', 'ZAI_API_KEY_1', 'DEEPSEEK_API_KEY'].entries()) {
        const rawDoc = mutateManifest(spec => {
          spec['roles'] = [{ id: 'author', provider: 'antigravity', model: 'gemini-4-carbon' }];
          spec['verification'] = {
            localChecks: [
              {
                id: 'cmd-check',
                implementation: 'command.v1',
                parameters: {
                  script: '.loopwright/checks/verify.sh',
                  timeoutSeconds: 10,
                  env: [envVar],
                },
              },
            ],
            externalGates: [],
          };
        });
        await writeFile(join(repoRoot, '.loopwright', 'taskpack.yaml'), serializePrettyYaml(rawDoc));
        await assert.rejects(
          () => stageTaskpackForStep({
            taskpackPath: '.loopwright/taskpack.yaml',
            repositoryRoot: repoRoot,
            runRoot,
            runId: `bad-stage-env-${idx}`,
            discoverUpstreams: false,
          }),
          (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
        );
      }

      // 2. Stage a valid taskpack with localChecks and verify StepYield.prompt lists declared check IDs (never "none declared for this taskpack")
      const validManifestDoc = mutateManifest(spec => {
        spec['roles'] = [{ id: 'author', provider: 'antigravity', model: 'gemini-4-carbon' }];
        spec['verification'] = {
          localChecks: [
            { id: 'docs-proposal-json', implementation: 'json-artifact.v1' },
            {
              id: 'verify-cmd',
              implementation: 'command.v1',
              parameters: { script: '.loopwright/checks/verify.sh', timeoutSeconds: 10 },
            },
          ],
          externalGates: [],
        };
      });
      await writeFile(join(repoRoot, '.loopwright', 'taskpack.yaml'), serializePrettyYaml(validManifestDoc));

      const staged = await stageTaskpackForStep({
        taskpackPath: '.loopwright/taskpack.yaml',
        repositoryRoot: repoRoot,
        runRoot,
        runId: 'step-check-ids-and-env',
        discoverUpstreams: false,
      });

      const handle = await openStagedTaskpackStepGate({ runRoot, runId: 'step-check-ids-and-env' });
      assert.notEqual(handle, null);
      if (handle === null) return;
      try {
        const previousSecret = process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
        process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = handle.environment(DEFAULT_LOCAL_COMMAND_GATE_ENV);
        try {
          const loaded = await loadTrustedConfiguration({
            configPath: staged.configPath,
            registryPath: staged.registryPath,
            registrySha256: staged.registrySha256,
            untrustedRoots: [repoRoot],
          });
          assert.equal(loaded.ok, true);
          if (!loaded.ok) return;

          const nextRes = await stepNext(
            {
              configuration: loaded.value,
              repository: repoRoot,
              runRoot,
              runId: 'step-check-ids-and-env',
              environment: handle.environment,
            },
            { gateUrlOverrides: handle.gateUrlOverrides },
          );
          assert.equal(nextRes.ok, true);
          if (!nextRes.ok) return;
          assert.equal(nextRes.value.kind, 'step');
          if (nextRes.value.kind === 'step') {
            assert.equal(nextRes.value.prompt.includes('docs-proposal-json'), true);
            assert.equal(nextRes.value.prompt.includes('verify-cmd'), true);
            assert.equal(nextRes.value.prompt.includes('none declared for this taskpack'), false);
          }
        } finally {
          if (previousSecret === undefined) {
            delete process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
          } else {
            process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = previousSecret;
          }
        }
      } finally {
        await handle.close();
      }

      // 3. Tampering secrets.json to inject ZAI_API_KEY or ZAI_API_KEY_2 into gate.env is refused by openStagedTaskpackStepGate / readAndValidateStagedTaskpackSecrets
      const secretsPath = join(staged.stageDir, 'secrets.json');
      const originalSecrets = JSON.parse(await readFile(secretsPath, 'utf8')) as Record<string, unknown>;
      for (const badGateEnv of ['ZAI_API_KEY', 'ZAI_API_KEY_2']) {
        const tampered = {
          ...originalSecrets,
          localCommandGates: (originalSecrets['localCommandGates'] as Record<string, unknown>[]).map(g => ({
            ...g,
            env: [badGateEnv],
          })),
        };
        await writeFile(secretsPath, `${JSON.stringify(tampered, null, 2)}\n`, { mode: 0o600 });
        await chmod(secretsPath, 0o600);
        await assert.rejects(
          () => openStagedTaskpackStepGate({ runRoot, runId: 'step-check-ids-and-env' }),
          (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID',
        );
      }
    });
  });

  it('does not leak role 0 LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN to role 1 in a multi-role Pi taskpack when role 1 env var is missing', async () => {
    await withTempDir(async dir => {
      const repoRoot = join(dir, 'repo');
      await mkdir(join(repoRoot, 'docs'), { recursive: true });
      await writeFile(join(repoRoot, 'docs', 'proposal.json'), '{"schema_version":1,"candidates":[]}\n');
      spawnSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, stdio: 'ignore' });
      const headSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();

      const multiRolePiManifest = validateTaskpackManifest(mutateManifest(spec => {
        spec['roles'] = [
          { id: 'author', provider: 'zai', model: 'glm-5.3', thinking: 'high' },
          { id: 'reviewer', purpose: 'review', provider: 'openai', model: 'gpt-5', thinking: 'medium', dependsOn: ['author'] },
        ];
        spec['verification'] = {
          localChecks: [
            { id: 'docs-proposal-json', implementation: 'json-artifact.v1' },
          ],
          externalGates: [],
        };
      }));
      const compiled = await compileDeclarativeTaskpack(multiRolePiManifest, piBindings({
        baseRevision: headSha,
        sourceRevision: headSha,
        roleSelection: undefined,
        credentialEnvMap: { provider: LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV },
      }));
      // Reorder steps so reviewer runs first (reviewer -> author -> docs-proposal-json) without changing credentials or roles!
      const reviewerFirstConfig = JSON.parse(JSON.stringify(compiled.config)) as Record<string, unknown>;
      const spec = reviewerFirstConfig['spec'] as Record<string, unknown>;
      const taskSpec = (spec['task'] as Record<string, unknown>)['spec'] as Record<string, unknown>;
      taskSpec['steps'] = [
        { id: 'reviewer', kind: 'agent', uses: 'agent.reviewer', roleId: 'reviewer', dependsOn: [] },
        { id: 'author', kind: 'agent', uses: 'agent.author', roleId: 'author', dependsOn: ['reviewer'] },
        { id: 'docs-proposal-json', kind: 'check', uses: 'docs-proposal-json', roleId: null, dependsOn: ['author'] },
      ];
      (spec['profiles'] as Record<string, unknown>)['steps'] = [
        { stepId: 'reviewer', handlerRef: 'agent.reviewer' },
        { stepId: 'author', handlerRef: 'agent.author' },
        { stepId: 'docs-proposal-json', handlerRef: 'docs-proposal-json' },
      ];
      const revConfigBytes = Buffer.from(serializePrettyYaml(reviewerFirstConfig), 'utf8');
      const revTrustedDir = join(dir, 'trusted-rev');
      const revPaths = await writeTrustedArtifacts(revTrustedDir, compiled.registryBytes, revConfigBytes);
      await chmod(revTrustedDir, 0o700);

      let role1ImplicitError: unknown = null;
      let role1ExplicitError: unknown = null;
      await executeTurnkeyActionCycle({
        taskpack: {
          ...compiled,
          config: reviewerFirstConfig as unknown as WrittenCompiledTaskpack['config'],
          trustedDirectory: revTrustedDir,
          registryPath: revPaths.registryPath,
          configPath: revPaths.configPath,
          configBytes: revConfigBytes,
        },
        repositoryRoot: repoRoot,
        runId: 'pi-reviewer-role-isolation',
        attemptSeq: 0,
        runtimeEnv: {
          [LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV]: 'ROLE0_ACTIVE_PROVIDER_SECRET_TOKEN',
          ZAI_API_KEY: 'ROLE0_ZAI_VALID_SECRET_TOKEN',
          OPENAI_API_KEY: 'ROLE1_PLACEHOLDER_TOKEN',
          [DEFAULT_LOCAL_COMMAND_GATE_ENV]: 'LOCAL_GATE_SIGNING_SECRET_TOKEN',
        },
        openHostSessionAdapter: async (host, input) => {
          assert.equal(input.roleId, 'reviewer');
          // Force inner host.resolveCredential to fail (e.g. destination mismatch) so wrappedHost.resolveCredential enters its LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN fallback check!
          try {
            await host.resolveCredential({
              provider: 'openai',
              model: 'gpt-5',
              destination: 'https://unmatched.example.invalid',
              purpose: 'reviewer',
              runId: input.lock.spec.runId,
              roleId: input.roleId,
              stepId: input.stepId,
              notAfterMonotonicMs: '999999999999',
              signal: new AbortController().signal,
            });
          } catch (err) {
            role1ImplicitError = err;
          }
          try {
            await host.resolveCredential({
              provider: 'openai',
              model: 'gpt-5',
              destination: 'https://unmatched.example.invalid',
              purpose: 'reviewer',
              runId: input.lock.spec.runId,
              roleId: input.roleId,
              stepId: input.stepId,
              notAfterMonotonicMs: '999999999999',
              signal: new AbortController().signal,
              ref: 'taskpack-provider-token-reviewer',
            } as unknown as Parameters<typeof host.resolveCredential>[0]);
          } catch (err) {
            role1ExplicitError = err;
          }
          return {
            ok: false,
            error: {
              version: 1,
              code: 'CAPABILITY_UNSUPPORTED',
              phase: 'admission',
              path: '',
              effect: 'none',
              retryable: false,
              requestId: null,
              operationId: null,
              stateErrorCode: null,
            },
          };
        },
      });

      assert.equal(role1ImplicitError instanceof GitHubAppError && role1ImplicitError.code === 'ACTION_INPUT_INVALID', true);
      assert.equal(role1ExplicitError instanceof GitHubAppError && role1ExplicitError.code === 'ACTION_INPUT_INVALID', true);
    });
  });

  it('scopes ambient GITHUB_SHA and GITHUB_REPOSITORY in stageTaskpackForStep to matching GITHUB_WORKSPACE and verified commits', async () => {
    await withTempDir(async dir => {
      const repoRoot = join(dir, 'repo');
      const runRoot = join(dir, 'runs');
      await mkdir(join(repoRoot, '.loopwright'), { recursive: true });
      await mkdir(join(repoRoot, 'docs'), { recursive: true });
      await writeFile(join(repoRoot, 'docs', 'proposal.json'), '{"schema_version":1,"candidates":[]}\n');
      const manifestDoc = mutateManifest(spec => {
        spec['roles'] = [{ id: 'author', provider: 'antigravity', model: 'gemini-4-carbon' }];
        spec['verification'] = {
          localChecks: [{ id: 'docs-proposal-json', implementation: 'json-artifact.v1' }],
          externalGates: [],
        };
      });
      await writeFile(join(repoRoot, '.loopwright', 'taskpack.yaml'), serializePrettyYaml(manifestDoc));

      spawnSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'c1'], { cwd: repoRoot, stdio: 'ignore' });
      const firstSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();

      await writeFile(join(repoRoot, 'docs', 'proposal.json'), '{"schema_version":1,"candidates":["v2"]}\n');
      spawnSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'c2'], { cwd: repoRoot, stdio: 'ignore' });
      const headSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();

      // 1. Unrelated GITHUB_WORKSPACE + nonexistent outer GITHUB_SHA + unreachable GITHUB_API_URL falls back to repo HEAD
      const stagedUnrelated = await stageTaskpackForStep({
        taskpackPath: '.loopwright/taskpack.yaml',
        repositoryRoot: repoRoot,
        runRoot,
        runId: 'ambient-gh-unrelated',
        discoverUpstreams: false,
        runtimeEnv: {
          ...process.env,
          GITHUB_WORKSPACE: join(dir, 'outer-runner-checkout'),
          GITHUB_SHA: 'f'.repeat(40),
          GITHUB_REPOSITORY: 'gpustack/loopwright',
          GITHUB_API_URL: 'http://127.0.0.1:9',
        },
      });
      const loadedUnrelated = await loadTrustedConfiguration({
        configPath: stagedUnrelated.configPath,
        registryPath: stagedUnrelated.registryPath,
        registrySha256: stagedUnrelated.registrySha256,
        untrustedRoots: [repoRoot],
      });
      assert.equal(loadedUnrelated.ok, true);
      if (!loadedUnrelated.ok) return;
      assert.equal(loadedUnrelated.value.configuration.spec.task.spec.target.repository, 'local/repo');
      assert.equal(loadedUnrelated.value.configuration.spec.task.spec.target.baseRevision, headSha);

      const nextRes = await stepNext({
        configuration: loadedUnrelated.value,
        repository: repoRoot,
        runRoot,
        runId: 'ambient-gh-unrelated',
      });
      assert.equal(nextRes.ok, true);

      // 2. Matching GITHUB_WORKSPACE + valid earlier commit GITHUB_SHA adopts GITHUB_SHA and GITHUB_REPOSITORY
      const stagedMatching = await stageTaskpackForStep({
        taskpackPath: '.loopwright/taskpack.yaml',
        repositoryRoot: repoRoot,
        runRoot,
        runId: 'ambient-gh-matching',
        discoverUpstreams: false,
        runtimeEnv: {
          ...process.env,
          GITHUB_WORKSPACE: repoRoot,
          GITHUB_SHA: firstSha,
          GITHUB_REPOSITORY: 'gpustack/runner',
          GITHUB_API_URL: 'http://127.0.0.1:9',
        },
      });
      const loadedMatching = await loadTrustedConfiguration({
        configPath: stagedMatching.configPath,
        registryPath: stagedMatching.registryPath,
        registrySha256: stagedMatching.registrySha256,
        untrustedRoots: [repoRoot],
      });
      assert.equal(loadedMatching.ok, true);
      if (!loadedMatching.ok) return;
      assert.equal(loadedMatching.value.configuration.spec.task.spec.target.repository, 'gpustack/runner');
      assert.equal(loadedMatching.value.configuration.spec.task.spec.target.baseRevision, firstSha);
    });
  });
});
