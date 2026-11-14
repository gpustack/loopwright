import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parsePiModelsJson, resolveTaskpackModelCandidates, validateTaskpackModelDeclaration } from '../src/models-config.js';
import { loadDeclarativeTaskpack, compileDeclarativeTaskpack, DEFAULT_HOST_BUDGETS } from '../src/taskpack.js';
import { GitHubAppError } from '../src/types.js';

const BASE_MANIFEST_YAML = `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: cost-test
spec:
  goal:
    candidate: Refresh docs.
    noChange: Confirm no change.
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
    schemaVersion: 1
  verification:
    localChecks:
      - id: docs-proposal-json
        implementation: json-artifact.v1
    externalGates: []
  publication:
    mode: disabled
    targetBranch: main
    headBranchPrefix: docs-
    titleTemplate: 'docs: sync'
  memory:
    directory: .loopwright/memory/cost-test
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

describe('model cost validation and resolution (T2)', () => {
  it('validates spec.models[].cost and rejects invalid cost objects with TASKPACK_MANIFEST_INVALID', () => {
    const valid = validateTaskpackModelDeclaration({
      provider: 'custom-gateway',
      id: 'glm-5.3',
      api: 'openai-completions',
      baseUrl: 'https://gateway.example.test/v1',
      cost: { input: 1.5, output: 3, cacheRead: 0.25, cacheWrite: 0.5 },
    });
    assert.deepEqual(valid.cost, { input: 1.5, output: 3, cacheRead: 0.25, cacheWrite: 0.5 });

    const minimal = validateTaskpackModelDeclaration({
      provider: 'zai',
      id: 'glm-5.3',
      cost: { input: 0, output: 0 },
    });
    assert.deepEqual(minimal.cost, { input: 0, output: 0 });

    for (const badCost of [
      null,
      'free',
      { input: 1 },
      { output: 1 },
      { input: -1, output: 1 },
      { input: -0, output: 1 },
      { input: Number.POSITIVE_INFINITY, output: 1 },
      { input: 1_000_001, output: 1 },
      { input: 1, output: 2, extra: 3 },
    ]) {
      assert.throws(
        () => validateTaskpackModelDeclaration({ provider: 'zai', id: 'glm-5.3', cost: badCost }),
        (err: GitHubAppError) => err.code === 'TASKPACK_MANIFEST_INVALID' && (err.path?.startsWith('/spec/models/0/cost') ?? false),
      );
    }
  });

  it('validates cost in models.json models[] and modelOverrides with TASKPACK_HOST_BINDING_INVALID', () => {
    const parsed = parsePiModelsJson(Buffer.from(JSON.stringify({
      providers: {
        'self-hosted': {
          baseUrl: 'https://llm.example.test/v1',
          api: 'openai-completions',
          models: [{ id: 'm1', cost: { input: 2, output: 6, cacheRead: 0.5 } }],
          modelOverrides: {
            m2: { cost: { input: 0.5, output: 1.5 } },
          },
        },
      },
    }), 'utf8'));
    const provider = parsed.providers.get('self-hosted')!;
    assert.deepEqual(provider.models.get('m1')?.cost, { input: 2, output: 6, cacheRead: 0.5 });
    assert.deepEqual(provider.modelOverrides.get('m2')?.cost, { input: 0.5, output: 1.5 });

    assert.throws(
      () => parsePiModelsJson(Buffer.from(JSON.stringify({
        providers: {
          'self-hosted': {
            baseUrl: 'https://llm.example.test/v1',
            api: 'openai-completions',
            models: [{ id: 'm1', cost: { input: -0.1, output: 1 } }],
          },
        },
      }), 'utf8')),
      (err: GitHubAppError) => err.code === 'TASKPACK_HOST_BINDING_INVALID' && (err.path?.includes('/cost') ?? false),
    );
  });

  it('preserves model cost precedence (hostCustom > modelsEntry > modelsOverride > manifest > builtIn) during compilation', async () => {
    const yamlWithCost = `${BASE_MANIFEST_YAML}  models:
    - provider: custom-gateway
      id: glm-5.3
      api: openai-completions
      baseUrl: https://gateway.example.test/v1
      cost:
        input: 1.25
        output: 5.0
        cacheRead: 0.25
`;
    const manifest = await loadDeclarativeTaskpack({ bytes: Buffer.from(yamlWithCost, 'utf8'), format: 'yaml' });
    const modelsConfig = parsePiModelsJson(Buffer.from(JSON.stringify({
      providers: {
        'custom-gateway': {
          baseUrl: 'https://gateway.example.test/v1',
          api: 'openai-completions',
          models: [{ id: 'glm-5.3', cost: { input: 2.0, output: 8.0 } }],
        },
      },
    }), 'utf8'));

    const fromManifest = resolveTaskpackModelCandidates(manifest, {
      mode: 'candidate',
      repository: 'octocat/target',
      baseRevision: 'b'.repeat(40),
      sourceRevision: 'a'.repeat(40),
      allowManifestCustomBaseUrl: true,
      budgets: DEFAULT_HOST_BUDGETS,
      credentialEnvMap: { provider: 'TEST_PROVIDER_TOKEN' },
    });
    assert.deepEqual(
      { ...fromManifest[0]?.selection.customProvider?.cost },
      { input: 1.25, output: 5.0, cacheRead: 0.25 },
    );

    const fromModelsJson = resolveTaskpackModelCandidates(manifest, {
      mode: 'candidate',
      repository: 'octocat/target',
      baseRevision: 'b'.repeat(40),
      sourceRevision: 'a'.repeat(40),
      allowManifestCustomBaseUrl: true,
      budgets: DEFAULT_HOST_BUDGETS,
      credentialEnvMap: { provider: 'TEST_PROVIDER_TOKEN' },
    }, { modelsConfig });
    assert.deepEqual(
      { ...fromModelsJson[0]?.selection.customProvider?.cost },
      { input: 2.0, output: 8.0 },
    );

    const compiled = await compileDeclarativeTaskpack(manifest, {
      mode: 'candidate',
      repository: 'octocat/target',
      baseRevision: 'b'.repeat(40),
      sourceRevision: 'a'.repeat(40),
      allowManifestCustomBaseUrl: true,
      budgets: DEFAULT_HOST_BUDGETS,
      credentialEnvMap: { provider: 'TEST_PROVIDER_TOKEN' },
    });
    assert.deepEqual(
      { ...compiled.registry.spec.roleProfiles[0]?.selection.customProvider?.cost },
      { input: 1.25, output: 5.0, cacheRead: 0.25 },
    );

    // Built-in model with a cost override preserves built-in thinkingLevelMap (medium remains null/unsupported)
    const builtInCostOverrideYaml = `${BASE_MANIFEST_YAML}  models:
    - provider: zai
      id: glm-5.3
      thinking: high
      cost:
        input: 0.5
        output: 1.5
`;
    const builtInCostManifest = await loadDeclarativeTaskpack({ bytes: Buffer.from(builtInCostOverrideYaml, 'utf8'), format: 'yaml' });
    const resolvedBuiltInOverride = resolveTaskpackModelCandidates(builtInCostManifest, {
      mode: 'candidate',
      repository: 'octocat/target',
      baseRevision: 'b'.repeat(40),
      sourceRevision: 'a'.repeat(40),
      budgets: DEFAULT_HOST_BUDGETS,
      credentialEnvMap: { provider: 'TEST_PROVIDER_TOKEN' },
    });
    assert.deepEqual(
      { ...resolvedBuiltInOverride[0]?.selection.customProvider?.cost },
      { input: 0.5, output: 1.5 },
    );
    assert.equal(resolvedBuiltInOverride[0]?.selection.customProvider?.thinkingLevelMap?.['medium'], null);
    assert.throws(
      () => resolveTaskpackModelCandidates(builtInCostManifest, {
        mode: 'candidate',
        repository: 'octocat/target',
        baseRevision: 'b'.repeat(40),
        sourceRevision: 'a'.repeat(40),
        roleSelection: { thinking: 'medium' },
        budgets: DEFAULT_HOST_BUDGETS,
        credentialEnvMap: { provider: 'TEST_PROVIDER_TOKEN' },
      }),
      (err: GitHubAppError) => err.code === 'TASKPACK_HOST_BINDING_INVALID',
    );
  });
});
