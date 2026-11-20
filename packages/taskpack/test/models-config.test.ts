import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TaskpackError } from '../src/types.js';
import { validateTaskpackV2Manifest, type Json } from '../src/schema.js';
import {
  parsePiModelsJson,
  resolveTaskpackModelCandidates,
  selectHealthyModelCandidate,
  splitProviderTokens,
  validateTaskpackModelDeclaration,
} from '../src/models-config.js';
import { SecretScrubber } from '../src/scrubber.js';

describe('models-config.ts: validation, token pools, and health selection', () => {
  it('validates model declarations, refuses OAuth providers and literal apiKeys, and parses models.json', () => {
    const valid = validateTaskpackModelDeclaration({
      provider: 'custom-gateway',
      id: 'glm-5.3',
      api: 'openai-completions',
      baseUrl: 'https://gateway.example.test/v1',
      cost: { input: 1.5, output: 3, cacheRead: 0.25 },
    });
    assert.equal(valid.provider, 'custom-gateway');
    assert.equal(valid.cost?.output, 3);

    assert.throws(
      () => validateTaskpackModelDeclaration({ provider: 'openai', id: 'gpt-5', apiKey: 'sk-literal-secret' }),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );
    assert.throws(
      () => validateTaskpackModelDeclaration({ provider: 'openai-codex', id: 'codex-1' }),
      (err: unknown) => err instanceof TaskpackError && err.code === 'PROVIDER_OAUTH_UNSUPPORTED',
    );

    const parsed = parsePiModelsJson(Buffer.from(JSON.stringify({
      providers: {
        'self-hosted': {
          baseUrl: 'https://llm.example.test/v1',
          api: 'openai-completions',
          apiKey: '${SELF_HOSTED_KEY}',
          models: [{ id: 'm1', cost: { input: 1, output: 2 } }],
        },
      },
    }), 'utf8'));
    assert.equal(parsed.providers.get('self-hosted')?.apiKeyEnv, 'SELF_HOSTED_KEY');
  });

  it('expands comma-separated token pools, scrubs secrets, and selects first healthy candidate', async () => {
    const scrubber = new SecretScrubber();
    const tokens = splitProviderTokens('tok_first_123456, tok_second_789012, tok_first_123456', 'TEST_KEY', scrubber);
    assert.deepEqual(tokens, ['tok_first_123456', 'tok_second_789012']);
    assert.equal(scrubber.scrub('leaked tok_first_123456'), 'leaked [scrubbed]');

    const manifest = validateTaskpackV2Manifest({
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'Taskpack',
      metadata: { name: 'model-probe' },
      spec: {
        goal: { candidate: 'Work', noChange: 'Verify' },
        scope: { writable: ['docs/**'], protected: [] },
        models: [
          {
            provider: 'custom-gateway',
            id: 'model-a',
            api: 'openai-completions',
            baseUrl: 'https://gateway.example.test/v1',
            apiKeyEnv: 'POOL_KEY',
          },
        ],
        verification: { localChecks: [], externalGates: [] },
      },
    } as Json);

    const candidates = resolveTaskpackModelCandidates(manifest, {
      mode: 'candidate',
      repository: 'local/repo',
      baseRevision: 'a'.repeat(40),
      sourceRevision: 'a'.repeat(40),
      allowManifestCustomBaseUrl: true,
      budgets: {
        wallTimeMs: 60_000,
        totalTokens: 100_000,
        perCallOutputTokens: 16_384,
        maxModelCalls: 8,
        maxConcurrency: 1,
        maxFormatRepairs: 2,
        maxImplementationRepairs: 2,
        maxTransportRetries: 2,
        enforcement: {
          wallTime: 'hard_admission',
          tokens: 'soft_accounting',
          modelCalls: 'hard_admission',
          concurrency: 'hard_admission',
          formatRepairs: 'hard_admission',
          implementationRepairs: 'hard_admission',
          transportRetries: 'hard_admission',
        },
      },
    }, {
      env: { POOL_KEY: 'tok_bad_12345678,tok_good_87654321' },
      scrubber,
    });
    assert.equal(candidates.length, 2);

    const selection = await selectHealthyModelCandidate(candidates, {
      scrubber,
      fetchImpl: async (_url, init) => {
        const headers = init?.headers as Record<string, string>;
        if (headers['authorization'] === 'Bearer tok_good_87654321') {
          return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ error: { code: 'rate_limit' } }), { status: 429 });
      },
    });
    assert.equal(selection.index, 1);
    assert.equal(selection.probed, true);
    assert.equal(selection.attempts.length, 2);

    const multiProviderManifest = validateTaskpackV2Manifest({
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'Taskpack',
      metadata: { name: 'multi-provider-pin' },
      spec: {
        goal: { candidate: 'Work', noChange: 'Verify' },
        scope: { writable: ['docs/**'], protected: [] },
        models: [
          { provider: 'openai', id: 'gpt-5', apiKeyEnv: 'OPENAI_API_KEY' },
          { provider: 'anthropic', id: 'claude-sonnet-4-5', apiKeyEnv: 'ANTHROPIC_API_KEY' },
        ],
        verification: { localChecks: [], externalGates: [] },
      },
    } as Json);
    const modelPinned = resolveTaskpackModelCandidates(multiProviderManifest, {
      mode: 'candidate',
      repository: 'local/repo',
      baseRevision: 'a'.repeat(40),
      sourceRevision: 'a'.repeat(40),
      roleSelection: { model: 'claude-sonnet-4-5' },
      budgets: {
        wallTimeMs: 60_000,
        totalTokens: 100_000,
        perCallOutputTokens: 16_384,
        maxModelCalls: 8,
        maxConcurrency: 1,
        maxFormatRepairs: 2,
        maxImplementationRepairs: 2,
        maxTransportRetries: 2,
        enforcement: {
          wallTime: 'hard_admission',
          tokens: 'soft_accounting',
          modelCalls: 'hard_admission',
          concurrency: 'hard_admission',
          formatRepairs: 'hard_admission',
          implementationRepairs: 'hard_admission',
          transportRetries: 'hard_admission',
        },
      },
    }, {
      env: { ANTHROPIC_API_KEY: 'sk-ant-test-123456' },
      scrubber,
    });
    assert.equal(modelPinned.length, 1);
    assert.equal(modelPinned[0]?.selection.provider, 'anthropic');
    assert.equal(modelPinned[0]?.selection.model, 'claude-sonnet-4-5');
  });
});
