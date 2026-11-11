import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SecretScrubber } from '@loopwright/core';
import { validateDecisionPolicy, validateDecisionQuestions } from '../src/schema.js';
import { sanitizeDecisionState, type DecisionScrubber } from '../src/redaction.js';

function throwsCode(run: () => unknown, code: string): void {
  try {
    run();
    assert.fail(`expected ${code}`);
  } catch (error) {
    assert.equal((error as { code?: string }).code, code);
  }
}

const approvedPolicy = (): ReturnType<typeof validateDecisionPolicy> =>
  validateDecisionPolicy({ enabled: true, disclosurePolicy: 'repo-approved-redacted-evidence' });

describe('validateDecisionPolicy', () => {
  it('applies the spec defaults for an empty policy', () => {
    const policy = validateDecisionPolicy({});
    assert.deepEqual(policy, {
      enabled: false, disclosurePolicy: 'disabled', minConfidence: 0.8, confirmThreshold: 0.6,
      hardDeadlineMs: 5000, maxAttempts: 1, fallbackRole: 'deterministic', onFallbackUnavailable: 'blocked',
      provider: 'typesafe-jev', endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest',
      startluxOptions: null, allowImages: false,
    });
    assert.equal(Object.isFrozen(policy), true);
    assert.equal(validateDecisionPolicy(undefined).enabled, false);
  });

  it('defaults endpoint and model per provider and validates overrides', () => {
    const openai = validateDecisionPolicy({ provider: 'openai-decisions' });
    assert.equal(openai.endpoint, 'https://api.openai.com/v1/decisions');
    assert.equal(openai.model, 'gpt-6-luna');
    const startlux = validateDecisionPolicy({ provider: 'startlux-decision' });
    assert.equal(startlux.endpoint, 'https://api.bamboonode.dev/v1/systemone');
    assert.equal(startlux.model, 'startlux-decision-27b-autothink');
    const microsoft = validateDecisionPolicy({ provider: 'microsoft-decision' });
    assert.equal(microsoft.endpoint, 'https://models.inference.ai.azure.com/v1/systemone');
    assert.equal(microsoft.model, 'microsoft-decision-1');
    const startluxWithOptions = validateDecisionPolicy({
      provider: 'startlux-decision', endpoint: 'http://127.0.0.1:8000/v1/decisions',
      startluxOptions: { thinkMode: 'auto', thinkBudget: 1024, gate: 0.6, allowNone: true, noneCheck: true, noneProbabilityThreshold: 0.2 },
    });
    assert.equal(startluxWithOptions.startluxOptions?.thinkBudget, 1024);
    assert.equal(startluxWithOptions.startluxOptions?.allowNone, true);
    throwsCode(() => validateDecisionPolicy({ provider: 'oracle-decisions' }), 'DECISION_POLICY_INVALID');
    throwsCode(() => validateDecisionPolicy({ endpoint: 'ftp://bad' }), 'DECISION_POLICY_INVALID');
    throwsCode(() => validateDecisionPolicy({ model: '' }), 'DECISION_POLICY_INVALID');
    throwsCode(() => validateDecisionPolicy({ startluxOptions: { thinkBudget: 4097 } }), 'DECISION_POLICY_INVALID');
    throwsCode(() => validateDecisionPolicy({ startluxOptions: { thinkMode: 'deep' } }), 'DECISION_POLICY_INVALID');
    throwsCode(() => validateDecisionPolicy({ startluxOptions: { gate: 1.5 } }), 'DECISION_POLICY_INVALID');
    throwsCode(() => validateDecisionPolicy({ startluxOptions: 'auto' }), 'DECISION_POLICY_INVALID');
    throwsCode(() => validateDecisionPolicy({ startluxOptions: { noneProbabilityThreshold: 1 } }), 'DECISION_POLICY_INVALID');
  });

  it('rejects malformed or out-of-range fields with DECISION_POLICY_INVALID', () => {
    throwsCode(() => validateDecisionPolicy('enabled'), 'DECISION_POLICY_INVALID');
    throwsCode(() => validateDecisionPolicy({ enabled: 'yes' }), 'DECISION_POLICY_INVALID');
    throwsCode(() => validateDecisionPolicy({ disclosurePolicy: 'leak-everything' }), 'DECISION_POLICY_INVALID');
    throwsCode(() => validateDecisionPolicy({ minConfidence: 0.49 }), 'DECISION_POLICY_INVALID');
    throwsCode(() => validateDecisionPolicy({ minConfidence: 1.01 }), 'DECISION_POLICY_INVALID');
    throwsCode(() => validateDecisionPolicy({ minConfidence: Number.NaN }), 'DECISION_POLICY_INVALID');
    throwsCode(() => validateDecisionPolicy({ confirmThreshold: 0.9, minConfidence: 0.8 }), 'DECISION_POLICY_INVALID');
    throwsCode(() => validateDecisionPolicy({ confirmThreshold: -0.1 }), 'DECISION_POLICY_INVALID');
    throwsCode(() => validateDecisionPolicy({ hardDeadlineMs: 99 }), 'DECISION_POLICY_INVALID');
    throwsCode(() => validateDecisionPolicy({ hardDeadlineMs: 30_001 }), 'DECISION_POLICY_INVALID');
    throwsCode(() => validateDecisionPolicy({ hardDeadlineMs: 500.5 }), 'DECISION_POLICY_INVALID');
    throwsCode(() => validateDecisionPolicy({ maxAttempts: 0 }), 'DECISION_POLICY_INVALID');
    throwsCode(() => validateDecisionPolicy({ maxAttempts: 3 }), 'DECISION_POLICY_INVALID');
    throwsCode(() => validateDecisionPolicy({ fallbackRole: '' }), 'DECISION_POLICY_INVALID');
    throwsCode(() => validateDecisionPolicy({ onFallbackUnavailable: 'retry_forever' }), 'DECISION_POLICY_INVALID');
  });

  it('accepts boundary values and explicit nulls', () => {
    const policy = validateDecisionPolicy({
      enabled: true, disclosurePolicy: 'public-metadata-only', minConfidence: 0.5, confirmThreshold: 0.5,
      hardDeadlineMs: 100, maxAttempts: 2, fallbackRole: null, onFallbackUnavailable: 'deterministic_default',
    });
    assert.equal(policy.minConfidence, 0.5);
    assert.equal(validateDecisionPolicy({ minConfidence: 1 }).minConfidence, 1);
    assert.equal(validateDecisionPolicy({ hardDeadlineMs: 30_000 }).hardDeadlineMs, 30_000);
    assert.equal(policy.fallbackRole, null);
    assert.equal(policy.maxAttempts, 2);
  });
});

describe('validateDecisionQuestions', () => {
  it('rejects bad batch sizes and non-arrays', () => {
    throwsCode(() => validateDecisionQuestions('questions'), 'DECISION_BATCH_SIZE_INVALID');
    throwsCode(() => validateDecisionQuestions([]), 'DECISION_BATCH_SIZE_INVALID');
    throwsCode(() => validateDecisionQuestions(Array.from({ length: 101 }, (_, index) => ({
      type: 'noul', id: `q${index}`, prompt: 'p',
    }))), 'DECISION_BATCH_SIZE_INVALID');
  });

  it('refuses the GUI box primitive and unknown primitive types pre-send', () => {
    throwsCode(() => validateDecisionQuestions([{ type: 'box', id: 'q1', prompt: 'click where?' }]), 'DECISION_PRIMITIVE_UNSUPPORTED');
    throwsCode(() => validateDecisionQuestions([{ type: 'varchar', id: 'q1', prompt: 'p' }]), 'DECISION_SCHEMA_INVALID');
    throwsCode(() => validateDecisionQuestions([{ id: 'q1', prompt: 'p' }]), 'DECISION_SCHEMA_INVALID');
  });

  it('canonicalizes the openai predicate alias to the noul type', () => {
    const questions = validateDecisionQuestions([
      { type: 'predicate', id: 'q1', prompt: 'does this hold?' },
      { type: 'predicate', id: 'q2', prompt: 'with threshold', threshold: 0.3 },
    ]);
    assert.equal(questions[0]?.type, 'noul');
    assert.equal(questions[1]?.type, 'noul');
  });

  it('canonicalizes the perplexity boolean alias to the noul type', () => {
    const questions = validateDecisionQuestions([{ type: 'boolean', id: 'q1', prompt: 'does this hold?' }]);
    assert.equal(questions[0]?.type, 'noul');
  });

  it('validates choice allowNone as an optional boolean', () => {
    throwsCode(() => validateDecisionQuestions([{ type: 'choice', id: 'q1', prompt: 'p', options: ['a'], allowNone: 'yes' }]), 'DECISION_SCHEMA_INVALID');
    const allowed = validateDecisionQuestions([{ type: 'choice', id: 'q1', prompt: 'p', options: ['a'], allowNone: true }]);
    assert.ok(allowed[0]?.type === 'choice');
    assert.equal(allowed[0].allowNone, true);
  });

  it('enforces unique bounded ids and bounded prompts', () => {
    throwsCode(() => validateDecisionQuestions([{ type: 'noul', id: '', prompt: 'p' }]), 'DECISION_SCHEMA_INVALID');
    throwsCode(() => validateDecisionQuestions([{ type: 'noul', id: 'x'.repeat(129), prompt: 'p' }]), 'DECISION_SCHEMA_INVALID');
    throwsCode(() => validateDecisionQuestions([{ type: 'noul', id: 'q1', prompt: '' }]), 'DECISION_SCHEMA_INVALID');
    throwsCode(() => validateDecisionQuestions([{ type: 'noul', id: 'q1', prompt: 'p'.repeat(2049) }]), 'DECISION_SCHEMA_INVALID');
    throwsCode(() => validateDecisionQuestions([
      { type: 'noul', id: 'same', prompt: 'a' }, { type: 'noul', id: 'same', prompt: 'b' },
    ]), 'DECISION_SCHEMA_INVALID');
  });

  it('validates choice options with cardinality and distinctness rules', () => {
    throwsCode(() => validateDecisionQuestions([{ type: 'choice', id: 'q1', prompt: 'p', options: [] }]), 'DECISION_SCHEMA_INVALID');
    throwsCode(() => validateDecisionQuestions([{ type: 'choice', id: 'q1', prompt: 'p', options: {} }]), 'DECISION_SCHEMA_INVALID');
    throwsCode(() => validateDecisionQuestions([{ type: 'choice', id: 'q1', prompt: 'p', options: { a: '', b: 'b' } }]), 'DECISION_SCHEMA_INVALID');
    throwsCode(() => validateDecisionQuestions([{ type: 'choice', id: 'q1', prompt: 'p', options: ['a', 'a'] }]), 'DECISION_SCHEMA_INVALID');
    throwsCode(() => validateDecisionQuestions([{ type: 'choice', id: 'q1', prompt: 'p', options: Array.from({ length: 256 }, (_, index) => `o${index}`) }]), 'DECISION_SCHEMA_INVALID');
    const fromArray = validateDecisionQuestions([{ type: 'choice', id: 'q1', prompt: 'p', options: ['fast', 'balanced'] }]);
    assert.ok(fromArray[0]?.type === 'choice');
    assert.deepEqual(fromArray[0].options, { fast: 'fast', balanced: 'balanced' });
    const fromRecord = validateDecisionQuestions([{ type: 'choice', id: 'q1', prompt: 'p', options: { fast: 'Fast tier', balanced: 'Balanced tier', strongest: 'Strongest tier' } }]);
    assert.equal(Object.isFrozen(fromRecord[0]), true);
    assert.equal(validateDecisionQuestions([{ type: 'choice', id: 'q1', prompt: 'p', options: Array.from({ length: 255 }, (_, index) => `o${index}`) }]).length, 1);
  });

  it('validates score criteria ordering cardinality between 2 and 10', () => {
    throwsCode(() => validateDecisionQuestions([{ type: 'score', id: 'q1', prompt: 'p', criteria: ['only'] }]), 'DECISION_SCHEMA_INVALID');
    throwsCode(() => validateDecisionQuestions([{ type: 'score', id: 'q1', prompt: 'p', criteria: Array.from({ length: 11 }, (_, index) => `l${index}`) }]), 'DECISION_SCHEMA_INVALID');
    throwsCode(() => validateDecisionQuestions([{ type: 'score', id: 'q1', prompt: 'p', criteria: ['low', ''] }]), 'DECISION_SCHEMA_INVALID');
    const scored = validateDecisionQuestions([{ type: 'score', id: 'q1', prompt: 'p', criteria: ['low', 'mid', 'high'] }]);
    assert.ok(scored[0]?.type === 'score');
    assert.deepEqual(scored[0].criteria, ['low', 'mid', 'high']);
  });

  it('validates noul thresholds strictly inside (0, 1) and preserves them', () => {
    throwsCode(() => validateDecisionQuestions([{ type: 'noul', id: 'q1', prompt: 'p', threshold: 0 }]), 'DECISION_SCHEMA_INVALID');
    throwsCode(() => validateDecisionQuestions([{ type: 'noul', id: 'q1', prompt: 'p', threshold: 1 }]), 'DECISION_SCHEMA_INVALID');
    throwsCode(() => validateDecisionQuestions([{ type: 'noul', id: 'q1', prompt: 'p', threshold: Number.NaN }]), 'DECISION_SCHEMA_INVALID');
    const withThreshold = validateDecisionQuestions([{ type: 'noul', id: 'q1', prompt: 'p', threshold: 0.3 }]);
    assert.equal((withThreshold[0] as { threshold?: number }).threshold, 0.3);
    const withoutThreshold = validateDecisionQuestions([{ type: 'noul', id: 'q1', prompt: 'p' }]);
    assert.equal((withoutThreshold[0] as { threshold?: number }).threshold, undefined);
  });

  it('accepts a full 100-question mixed batch', () => {
    const questions = Array.from({ length: 100 }, (_, index) => (
      index % 3 === 0
        ? { type: 'noul', id: `q${index}`, prompt: 'does this apply?' }
        : index % 3 === 1
          ? { type: 'choice', id: `q${index}`, prompt: 'pick one', options: ['a', 'b'] }
          : { type: 'score', id: `q${index}`, prompt: 'rate it', criteria: ['low', 'high'] }
    ));
    assert.equal(validateDecisionQuestions(questions).length, 100);
  });
});

describe('sanitizeDecisionState', () => {
  it('returns the serialized body for a clean state', () => {
    const body = sanitizeDecisionState({ taskId: 'task.one', estimatedFilesCount: 3 }, approvedPolicy());
    assert.deepEqual(JSON.parse(body), { taskId: 'task.one', estimatedFilesCount: 3 });
  });

  it('rejects non-plain-object roots with DECISION_SCHEMA_INVALID', () => {
    for (const root of [['a'], 'state', 42, null, true]) {
      throwsCode(() => sanitizeDecisionState(root, approvedPolicy()), 'DECISION_SCHEMA_INVALID');
    }
    class NotPlain { readonly value = 1; }
    throwsCode(() => sanitizeDecisionState(new NotPlain(), approvedPolicy()), 'DECISION_SCHEMA_INVALID');
  });

  it('rejects circular references and non-JSON values with DECISION_SCHEMA_INVALID', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular['self'] = circular;
    throwsCode(() => sanitizeDecisionState(circular, approvedPolicy()), 'DECISION_SCHEMA_INVALID');
    throwsCode(() => sanitizeDecisionState({ score: Number.NaN }, approvedPolicy()), 'DECISION_SCHEMA_INVALID');
    throwsCode(() => sanitizeDecisionState({ score: Number.POSITIVE_INFINITY }, approvedPolicy()), 'DECISION_SCHEMA_INVALID');
    throwsCode(() => sanitizeDecisionState({ fn: () => 1 }, approvedPolicy()), 'DECISION_SCHEMA_INVALID');
    throwsCode(() => sanitizeDecisionState({ big: 10n }, approvedPolicy()), 'DECISION_SCHEMA_INVALID');
    throwsCode(() => sanitizeDecisionState({ gap: undefined }, approvedPolicy()), 'DECISION_SCHEMA_INVALID');
  });

  it('enforces the 16-level depth cap and the 65536-byte size cap', () => {
    let shallow: Record<string, unknown> = { leaf: true };
    for (let level = 0; level < 15; level += 1) shallow = { nested: shallow };
    assert.equal(Object.keys(JSON.parse(sanitizeDecisionState(shallow, approvedPolicy()))).length, 1);
    let deep: Record<string, unknown> = { leaf: true };
    for (let level = 0; level < 16; level += 1) deep = { nested: deep };
    throwsCode(() => sanitizeDecisionState(deep, approvedPolicy()), 'DECISION_SCHEMA_INVALID');
    throwsCode(() => sanitizeDecisionState({ blob: 'x'.repeat(70_000) }, approvedPolicy()), 'DECISION_STATE_TOO_LARGE');
    const boundary = { blob: 'x'.repeat(65_000) };
    assert.equal(Buffer.byteLength(sanitizeDecisionState(boundary, approvedPolicy()), 'utf8') <= 65_536, true);
  });

  it('rejects prototype-pollution keys at any depth with DECISION_DISCLOSURE_VIOLATION', () => {
    throwsCode(() => sanitizeDecisionState(JSON.parse('{"__proto__": {"injected": true}}'), approvedPolicy()), 'DECISION_DISCLOSURE_VIOLATION');
    throwsCode(() => sanitizeDecisionState({ outer: JSON.parse('{"constructor": "fake"}') }, approvedPolicy()), 'DECISION_DISCLOSURE_VIOLATION');
    throwsCode(() => sanitizeDecisionState({ prototype: 'clone-me' }, approvedPolicy()), 'DECISION_DISCLOSURE_VIOLATION');
  });

  it('rejects forbidden raw-content keys with DECISION_DISCLOSURE_VIOLATION', () => {
    for (const key of ['rawFileContent', 'fileBody', 'fullTranscript', 'rawTranscript', 'envDump', 'processEnv', 'privateKey', 'secret', 'token', 'authorization', 'cookie']) {
      throwsCode(() => sanitizeDecisionState({ [key]: 'value' }, approvedPolicy()), 'DECISION_DISCLOSURE_VIOLATION');
    }
    throwsCode(() => sanitizeDecisionState({ nested: { secret: 'value' } }, approvedPolicy()), 'DECISION_DISCLOSURE_VIOLATION');
  });

  it('rejects secret-shaped string values with DECISION_DISCLOSURE_VIOLATION', () => {
    const secrets = [
      'key=TYPESAFE_API_KEY_VALUE_X', 'token ghs_AAAABBBBCCCCDDDDEEEE', 'token ghu_AAAABBBBCCCCDDDDEEEE',
      'token ghp_AAAABBBBCCCCDDDDEEEE', 'github_pat_AAAA_BBBBCCCCDDDDEEEE', 'github_app_AAAABBBBCCCCAAAA',
      'Authorization: Bearer abc', '-----BEGIN RSA PRIVATE KEY-----', 'AWS_SECRET_ACCESS_KEY=1',
      'OPENAI_API_KEY=1', 'ANTHROPIC_API_KEY=1', 'STARTLUX_API_KEY=1', 'deploy to ${SECRET_TOKEN_URL}',
    ];
    for (const secret of secrets) {
      throwsCode(() => sanitizeDecisionState({ note: secret }, approvedPolicy()), 'DECISION_DISCLOSURE_VIOLATION');
    }
  });

  it('integrates a structural scrubber without containsSecret via scrub comparison', () => {
    const structural: DecisionScrubber = { scrub: (value: string) => value.split('hunter2-secret').join('[redacted]') };
    throwsCode(() => sanitizeDecisionState({ note: 'value hunter2-secret hidden' }, approvedPolicy(), structural), 'DECISION_DISCLOSURE_VIOLATION');
    assert.equal(sanitizeDecisionState({ note: 'clean' }, approvedPolicy(), structural), '{"note":"clean"}');
  });

  it('integrates the core SecretScrubber registered secrets', () => {
    const scrubber = new SecretScrubber();
    scrubber.register('hunter2-secret-value');
    assert.equal(typeof scrubber.containsSecret, 'function');
    throwsCode(() => sanitizeDecisionState({ note: 'token hunter2-secret-value' }, approvedPolicy(), scrubber), 'DECISION_DISCLOSURE_VIOLATION');
    throwsCode(() => sanitizeDecisionState({ note: 'token ' + Buffer.from('hunter2-secret-value').toString('base64') }, approvedPolicy(), scrubber), 'DECISION_DISCLOSURE_VIOLATION');
    assert.equal(sanitizeDecisionState({ note: 'clean' }, approvedPolicy(), scrubber), '{"note":"clean"}');
  });

  it('enforces public-metadata-only denials on evidence keys and long strings', () => {
    const metadataPolicy = validateDecisionPolicy({ enabled: true, disclosurePolicy: 'public-metadata-only' });
    for (const key of ['diffPatch', 'rawDiff', 'patchBody', 'stdout', 'stderr']) {
      throwsCode(() => sanitizeDecisionState({ [key]: '- line' }, metadataPolicy), 'DECISION_DISCLOSURE_VIOLATION');
    }
    throwsCode(() => sanitizeDecisionState({ note: 'x'.repeat(513) }, metadataPolicy), 'DECISION_DISCLOSURE_VIOLATION');
    assert.equal(sanitizeDecisionState({ note: 'x'.repeat(512) }, metadataPolicy), JSON.stringify({ note: 'x'.repeat(512) }));
    assert.equal(sanitizeDecisionState({ note: 'x'.repeat(513) }, approvedPolicy()), JSON.stringify({ note: 'x'.repeat(513) }));
  });
});
