import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateDecisionPolicy, validateDecisionQuestions } from '../src/schema.js';
import { sanitizeDecisionState, validateDecisionImages } from '../src/redaction.js';
import { classifyConfidenceZone, classifyQuestionOutcome, formatProviderRequest, parseAndValidateProviderResponse, providerRequestHeaders } from '../src/primitives.js';
import type { DecisionPolicyConfig, DecisionQuestion, DecisionQuestionOutput } from '../src/types.js';

function throwsCode(run: () => unknown, code: string): void {
  try {
    run();
    assert.fail(`expected ${code}`);
  } catch (error) {
    assert.equal((error as { code?: string }).code, code);
  }
}

function policy(overrides: Partial<Record<string, unknown>> = {}): DecisionPolicyConfig {
  return validateDecisionPolicy({ enabled: true, disclosurePolicy: 'repo-approved-redacted-evidence', ...overrides });
}

const tierQuestion = (): readonly DecisionQuestion[] => validateDecisionQuestions([
  { type: 'choice', id: 'tier', prompt: 'Which capability tier?', options: { fast: 'Fast', balanced: 'Balanced', strongest: 'Strongest' } },
  { type: 'score', id: 'risk', prompt: 'Rate the risk.', criteria: ['low', 'mid', 'high'] },
  { type: 'predicate', id: 'needsReview', prompt: 'Does this need review?' },
]);

const imageAsset = { id: 'shot', mediaType: 'image/png' as const, data: Buffer.from('fakepng').toString('base64') };

describe('classifyConfidenceZone', () => {
  it('maps confidence into high, medium, and low zones with inclusive boundaries', () => {
    const config = policy();
    assert.deepEqual(classifyConfidenceZone(0.8, config), { zone: 'high', action: 'accept_jev' });
    assert.deepEqual(classifyConfidenceZone(0.95, config), { zone: 'high', action: 'accept_jev' });
    assert.deepEqual(classifyConfidenceZone(0.79, config), { zone: 'medium', action: 'confirm_or_fallback' });
    assert.deepEqual(classifyConfidenceZone(0.6, config), { zone: 'medium', action: 'confirm_or_fallback' });
    assert.deepEqual(classifyConfidenceZone(0.59, config), { zone: 'low', action: 'fallback' });
  });

  it('refuses confidences outside [0, 1]', () => {
    throwsCode(() => classifyConfidenceZone(1.2, policy()), 'DECISION_RESPONSE_INVALID');
    throwsCode(() => classifyConfidenceZone(Number.NaN, policy()), 'DECISION_RESPONSE_INVALID');
  });
});

describe('classifyQuestionOutcome', () => {
  it('routes a null choice or a none_probability at or above the default 0.2 threshold to the low zone', () => {
    const config = policy();
    const noneChoice: DecisionQuestionOutput = { type: 'choice', id: 'tier', choice: 'fast', confidence: 0.95, probabilities: {}, noneProbability: 0.2 };
    assert.deepEqual(classifyQuestionOutcome(noneChoice, config), { zone: 'low', action: 'fallback' });
    const nullChoice: DecisionQuestionOutput = { type: 'choice', id: 'tier', choice: null, confidence: 0.99, probabilities: {} };
    assert.deepEqual(classifyQuestionOutcome(nullChoice, config), { zone: 'low', action: 'fallback' });
    const marginalNone: DecisionQuestionOutput = { type: 'choice', id: 'tier', choice: 'fast', confidence: 0.95, probabilities: {}, noneProbability: 0.19 };
    assert.deepEqual(classifyQuestionOutcome(marginalNone, config), { zone: 'high', action: 'accept_jev' });
  });

  it('honors a configured noneProbabilityThreshold override', () => {
    const config = policy({ startluxOptions: { noneProbabilityThreshold: 0.5 } });
    const output: DecisionQuestionOutput = { type: 'choice', id: 'tier', choice: 'fast', confidence: 0.95, probabilities: {}, noneProbability: 0.3 };
    assert.deepEqual(classifyQuestionOutcome(output, config), { zone: 'high', action: 'accept_jev' });
  });
});

describe('formatProviderRequest', () => {
  const state = sanitizeDecisionState({ taskId: 'task.one' }, policy());

  it('serializes the typesafe-jev keyed /v1/systemone request with model, state, and a questions map', () => {
    const body = JSON.parse(formatProviderRequest(tierQuestion(), state, policy()));
    assert.equal(body.model, 'jev-latest');
    assert.deepEqual(body.state, { taskId: 'task.one' });
    assert.deepEqual(body.questions['tier'], { type: 'choice', instructions: 'Which capability tier?', criteria: { fast: 'Fast', balanced: 'Balanced', strongest: 'Strongest' } });
    assert.deepEqual(body.questions['risk'], { type: 'score', instructions: 'Rate the risk.', criteria: ['low', 'mid', 'high'] });
    assert.deepEqual(body.questions['needsReview'], { type: 'noul', instructions: 'Does this need review?' });
    assert.equal(body['assets'], undefined);
  });

  it('serializes the startlux request with deliberation-control defaults and overrides', () => {
    const defaults = JSON.parse(formatProviderRequest(tierQuestion(), state, policy({ provider: 'startlux-decision' })));
    assert.equal(defaults['model'], 'startlux-decision-27b-autothink');
    assert.equal(defaults['think_mode'], 'auto');
    assert.equal(defaults['think_budget'], 1024);
    assert.equal(defaults['gate'], 0.6);
    assert.equal(defaults['allow_none'], false);
    assert.equal(defaults['none_check'], true);
    const overrideQuestion = validateDecisionQuestions([{ type: 'choice', id: 'tier', prompt: 'Tier?', options: ['fast'], allowNone: true }]);
    const overrides = JSON.parse(formatProviderRequest(overrideQuestion, state, policy({
      provider: 'startlux-decision',
      startluxOptions: { thinkMode: 'instant', thinkBudget: 512, gate: 0.4, allowNone: false, noneCheck: false },
    })));
    assert.equal(overrides['think_mode'], 'instant');
    assert.equal(overrides['think_budget'], 512);
    assert.equal(overrides['gate'], 0.4);
    assert.equal(overrides['allow_none'], false);
    assert.equal(overrides['none_check'], false);
  });

  it('serializes the openai-decisions request with predicate, choices, and 1-indexed levels', () => {
    const body = JSON.parse(formatProviderRequest(tierQuestion(), state, policy({ provider: 'openai-decisions' })));
    assert.equal(body.model, 'gpt-6-luna');
    assert.deepEqual(body.input, { taskId: 'task.one' });
    assert.deepEqual(body.questions[0], { type: 'choice', name: 'tier', instructions: 'Which capability tier?', choices: ['fast', 'balanced', 'strongest'] });
    assert.deepEqual(body.questions[1].levels, [{ level: 1, description: 'low' }, { level: 2, description: 'mid' }, { level: 3, description: 'high' }]);
    assert.deepEqual(body.questions[2], { type: 'predicate', name: 'needsReview', instructions: 'Does this need review?' });
  });

  it('maps image assets per provider and refuses them without allowImages', () => {
    const images = validateDecisionImages([imageAsset], policy({ allowImages: true }));
    const typesafe = JSON.parse(formatProviderRequest(tierQuestion(), state, policy({ allowImages: true }), images));
    assert.deepEqual(typesafe.assets['shot'], { type: 'image', data: imageAsset.data, media_type: 'image/png' });
    const startlux = JSON.parse(formatProviderRequest(tierQuestion(), state, policy({ provider: 'startlux-decision', allowImages: true }), images));
    assert.deepEqual(startlux.images, [imageAsset.data]);
    const openai = JSON.parse(formatProviderRequest(tierQuestion(), state, policy({ provider: 'openai-decisions', allowImages: true }), images));
    assert.equal(openai.input[0].type, 'input_json');
    assert.equal(openai.input[1].type, 'input_image');
    assert.equal(openai.input[1].image_url, `data:image/png;base64,${imageAsset.data}`);
    throwsCode(() => formatProviderRequest(tierQuestion(), state, policy(), images), 'DECISION_DISCLOSURE_VIOLATION');
    throwsCode(() => formatProviderRequest(tierQuestion(), state, policy({ disclosurePolicy: 'public-metadata-only', allowImages: true }), images), 'DECISION_DISCLOSURE_VIOLATION');
  });

  it('emits the TypeSafe-Danger-Zone-Images header only for image-capable requests', () => {
    assert.deepEqual(providerRequestHeaders(policy(), tierQuestion()), {});
    assert.deepEqual(providerRequestHeaders(policy({ allowImages: true }), tierQuestion(), [imageAsset]), { 'TypeSafe-Danger-Zone-Images': 'true' });
    const boxQuestions = validateDecisionQuestions([{ type: 'box', id: 'region', prompt: 'Where is the button?' }], policy({ allowImages: true }));
    assert.deepEqual(providerRequestHeaders(policy({ allowImages: true }), boxQuestions), { 'TypeSafe-Danger-Zone-Images': 'true' });
  });
});

describe('provider alias normalization (REVIEW-004)', () => {
  const aliasQuestions = validateDecisionQuestions([
    { type: 'choice', id: 'tier', prompt: 'Tier?', options: { fast: 'Fast', balanced: 'Balanced', strongest: 'Strongest' } },
    { type: 'score', id: 'severity', prompt: 'Rate severity.', criteria: ['Minor', 'Critical'] },
    { type: 'score', id: 'risk', prompt: 'Rate risk.', criteria: ['low', 'mid', 'high'] },
    { type: 'boolean', id: 'needsReview', prompt: 'Needs review?' },
  ]);

  function outputsById(outputs: readonly DecisionQuestionOutput[]): Map<string, DecisionQuestionOutput> {
    return new Map(outputs.map(output => [output.id, output]));
  }

  it('unwraps the cloudflare result envelope with selected, expected_score, and label-keyed probabilities', () => {
    const config = policy({ provider: 'cloudflare-clef' });
    const response = {
      result: {
        model: '@cf/cloudflare/clef',
        answers: {
          tier: { selected: 'fast', confidence: 0.9, probabilities: { fast: 0.9, balanced: 0.06, strongest: 0.04 } },
          severity: { expected_score: 0.9, probabilities: { Minor: 0.1, Critical: 0.9 } },
          risk: { expected_score: 1.5, probabilities: { low: 0.2, mid: 0.5, high: 0.3 } },
          needsReview: { probability: 0.9 },
        },
        usage: { input_tokens: 80, output_tokens: 12 },
      },
    };
    const parsed = parseAndValidateProviderResponse(aliasQuestions, response, config);
    assert.deepEqual(parsed.usage, { input_tokens: 80, output_tokens: 12 });
    const outputs = outputsById(parsed.outputs);
    const choice = outputs.get('tier');
    assert.ok(choice?.type === 'choice' && choice.choice === 'fast');
    const severity = outputs.get('severity');
    assert.ok(severity?.type === 'score');
    assert.equal(severity.score, 0.9);
    assert.equal(severity.normalizedScore, 0.9);
    assert.deepEqual(severity.probabilities, [0.1, 0.9]);
    assert.equal(severity.confidence, 0.9);
  });

  it('normalizes liquid-d1 selected + distribution + probability and probability_distribution arrays', () => {
    const config = policy({ provider: 'liquid-d1' });
    const response = {
      answers: {
        tier: { selected: 'balanced', probability: 0.85, distribution: { fast: 0.05, balanced: 0.85, strongest: 0.1 } },
        severity: { expected_score: 0.4, probability_distribution: [0.4, 0.6] },
        risk: { score: 1.5, probability_distribution: [0.2, 0.5, 0.3] },
        needsReview: { probability: 0.9 },
      },
      usage: { input_tokens: 50, output_tokens: 8 },
    };
    const parsed = parseAndValidateProviderResponse(aliasQuestions, response, config);
    const outputs = outputsById(parsed.outputs);
    const choice = outputs.get('tier');
    assert.ok(choice?.type === 'choice' && choice.choice === 'balanced');
    assert.equal(choice.confidence, 0.85);
    const risk = outputs.get('risk');
    assert.ok(risk?.type === 'score');
    assert.equal(risk.score, 1.5);
    assert.ok(Math.abs(risk.normalizedScore - 0.75) < 1e-9);
    assert.deepEqual(risk.probabilities, [0.2, 0.5, 0.3]);
    assert.equal(risk.confidence, 0.5);
  });

  it('accepts perplexity probability binaries and derives score confidence from max(probabilities)', () => {
    const config = policy({ provider: 'perplexity-decider' });
    const response = {
      answers: {
        needsReview: { probability: 0.8 },
        severity: { score: 1, probabilities: [0.4, 0.6] },
        risk: { score: 2, probabilities: [0.1, 0.3, 0.6] },
        tier: { choice: 'fast', confidence: 0.9, probabilities: { fast: 0.9, balanced: 0.05, strongest: 0.05 } },
      },
      usage: { input_tokens: 40, output_tokens: 6 },
    };
    const parsed = parseAndValidateProviderResponse(aliasQuestions, response, config);
    const outputs = outputsById(parsed.outputs);
    const binary = outputs.get('needsReview');
    assert.ok(binary?.type === 'noul');
    assert.equal(binary.noul, 0.8);
    assert.equal(binary.confidence, Math.abs(2 * 0.8 - 1));
    const risk = outputs.get('risk');
    assert.ok(risk?.type === 'score');
    assert.equal(risk.score, 2);
    assert.equal(risk.confidence, 0.6);
  });

  it('merges top-level usage when the cloudflare result envelope omits it', () => {
    const config = policy({ provider: 'cloudflare-clef' });
    const response = {
      usage: { input_tokens: 11, output_tokens: 2 },
      result: {
        answers: {
          tier: { selected: 'balanced', confidence: 0.9, probabilities: { fast: 0.05, balanced: 0.9, strongest: 0.05 } },
          severity: { expected_score: 0.4, probabilities: { Minor: 0.4, Critical: 0.6 } },
          risk: { expected_score: 1, probabilities: { low: 0.3, mid: 0.4, high: 0.3 } },
          needsReview: { probability: 0.2 },
        },
      },
    };
    const parsed = parseAndValidateProviderResponse(aliasQuestions, response, config);
    assert.deepEqual(parsed.usage, { input_tokens: 11, output_tokens: 2 });
  });
});

describe('parseAndValidateProviderResponse', () => {
  const questions = tierQuestion();
  const usage = { input_tokens: 100, output_tokens: 20 };

  it('parses the legacy positional outputs array with integer score enforcement', () => {
    const response = {
      outputs: [
        { choice: 'balanced', confidence: 0.9, probabilities: { fast: 0.1, balanced: 0.6, strongest: 0.3 } },
        { score: 1, confidence: 0.7, probabilities: [0.2, 0.5, 0.3] },
        { noul: 0.85 },
      ],
      usage,
    };
    const parsed = parseAndValidateProviderResponse(questions, response, policy());
    assert.deepEqual(parsed.usage, usage);
    const [choice, score, noul] = parsed.outputs;
    assert.ok(choice?.type === 'choice' && choice.choice === 'balanced');
    assert.ok(score?.type === 'score');
    assert.equal(score.score, 1);
    assert.equal(score.normalizedScore, 0.5);
    assert.ok(noul?.type === 'noul');
    assert.equal(noul.confidence, Math.abs(2 * 0.85 - 1));
    assert.equal(noul.affirmative, true);
    throwsCode(() => parseAndValidateProviderResponse(questions, { ...response, outputs: [{ ...response.outputs[1], score: 1.5 }], answers: undefined }, policy()), 'DECISION_RESPONSE_INVALID');
  });

  it('parses the keyed /v1/systemone answers map with continuous scores and none_probability', () => {
    const response = {
      model: 'jev-latest',
      answers: {
        tier: { choice: 'fast', confidence: 0.9, probabilities: { fast: 0.7, balanced: 0.2, strongest: 0.1 }, none_probability: 0.1 },
        risk: { score: 1.3, confidence: 0.8, probabilities: { '0': 0.4, '1': 0.5, '2': 0.1 } },
        needsReview: { noul: 0.2 },
      },
      usage,
    };
    const parsed = parseAndValidateProviderResponse(questions, response, policy());
    const [choice, score, noul] = parsed.outputs;
    assert.ok(choice?.type === 'choice' && choice.noneProbability === 0.1);
    assert.ok(score?.type === 'score');
    assert.equal(score.score, 1.3);
    assert.ok(Math.abs(score.normalizedScore - 0.65) < 1e-9);
    assert.ok(noul?.type === 'noul' && noul.affirmative === false);
    const startluxNone = parseAndValidateProviderResponse(questions, {
      answers: { ...response.answers, tier: { ...response.answers.tier, choice: null, none_probability: 0.4 } },
    }, policy({ provider: 'startlux-decision' }));
    assert.ok(startluxNone.outputs[0]?.type === 'choice' && startluxNone.outputs[0].choice === null);
    assert.deepEqual(classifyQuestionOutcome(startluxNone.outputs[0], policy({ provider: 'startlux-decision' })), { zone: 'low', action: 'fallback' });
  });

  it('parses the openai-decisions answers array with predicate mapping and 1-indexed score keys', () => {
    const response = {
      answers: [
        { name: 'needsReview', type: 'predicate', probability: 0.3 },
        { name: 'tier', type: 'choice', choice: 'strongest', confidence: 0.9, probabilities: { fast: 0.1, balanced: 0.1, strongest: 0.8 } },
        { name: 'risk', type: 'score', score: 2.5, confidence: 0.8, probabilities: { '1': 0.2, '2': 0.4, '3': 0.4 } },
      ],
      usage,
    };
    const parsed = parseAndValidateProviderResponse(questions, response, policy({ provider: 'openai-decisions' }));
    const outputsById = new Map(parsed.outputs.map(output => [output.id, output]));
    const predicate = outputsById.get('needsReview');
    assert.ok(predicate?.type === 'noul');
    assert.equal(predicate.noul, 0.3);
    assert.equal(predicate.confidence, Math.abs(2 * 0.3 - 1));
    const score = outputsById.get('risk');
    assert.ok(score?.type === 'score');
    assert.equal(score.score, 2.5);
    assert.ok(Math.abs(score.normalizedScore - 0.75) < 1e-9);
    assert.deepEqual(score.probabilities, [0.2, 0.4, 0.4]);
  });

  it('validates box answers on systemone, openai, and legacy shapes', () => {
    const boxQuestions = validateDecisionQuestions([{ type: 'box', id: 'region', prompt: 'Where?' }], policy({ allowImages: true }));
    const imagePolicy = policy({ allowImages: true });
    const boxAnswer = { box: { top: 0.1, bottom: 0.4, left: 0.2, right: 0.8 }, confidence: 0.9 };
    for (const [provider, response] of [
      ['typesafe-jev', { answers: { region: boxAnswer }, usage }],
      ['startlux-decision', { answers: { region: boxAnswer }, usage }],
      ['openai-decisions', { answers: [{ name: 'region', box: boxAnswer.box, confidence: 0.9 }], usage }],
    ] as const) {
      const parsed = parseAndValidateProviderResponse(boxQuestions, response as unknown, policy({ provider, allowImages: true }));
      const output = parsed.outputs[0];
      assert.ok(output?.type === 'box');
      assert.deepEqual(output.box, { top: 0.1, bottom: 0.4, left: 0.2, right: 0.8 });
      assert.equal(output.confidence, 0.9);
      assert.equal(imagePolicy.allowImages, true);
    }
    const inverted = { answers: { region: { box: { top: 0.6, bottom: 0.4, left: 0.2, right: 0.8 }, confidence: 0.9 } } };
    throwsCode(() => parseAndValidateProviderResponse(boxQuestions, inverted, imagePolicy), 'DECISION_RESPONSE_INVALID');
    const outOfRange = { answers: { region: { box: { top: 1.4, bottom: 1.5, left: 0.2, right: 0.8 }, confidence: 0.9 } } };
    throwsCode(() => parseAndValidateProviderResponse(boxQuestions, outOfRange, imagePolicy), 'DECISION_RESPONSE_INVALID');
  });

  it('fails closed on malformed responses with DECISION_RESPONSE_INVALID', () => {
    const config = policy();
    throwsCode(() => parseAndValidateProviderResponse(questions, 'response', config), 'DECISION_RESPONSE_INVALID');
    throwsCode(() => parseAndValidateProviderResponse(questions, {}, config), 'DECISION_RESPONSE_INVALID');
    throwsCode(() => parseAndValidateProviderResponse(questions, { outputs: [] }, config), 'DECISION_RESPONSE_INVALID');
    throwsCode(() => parseAndValidateProviderResponse(questions, {
      outputs: [{ choice: 'unknown', confidence: 0.9, probabilities: { fast: 1 } }, { score: 1, probabilities: [0.5, 0.5] }, { noul: 0.5 }],
    }, config), 'DECISION_RESPONSE_INVALID');
    throwsCode(() => parseAndValidateProviderResponse(questions, {
      outputs: [
        { choice: 'fast', confidence: 0.9, probabilities: { fast: 0.9, balanced: 0.9, strongest: 0 } },
        { score: 1, probabilities: [1, 0, 0] },
        { noul: 0.5 },
      ],
    }, config), 'DECISION_RESPONSE_INVALID');
    throwsCode(() => parseAndValidateProviderResponse(questions, {
      outputs: [
        { choice: 'fast', confidence: 0.9, probabilities: { fast: 0.6, balanced: 0.3, strongest: 0.1 } },
        { score: 4, probabilities: [0, 0, 1] },
        { noul: 0.5 },
      ],
    }, config), 'DECISION_RESPONSE_INVALID');
    throwsCode(() => parseAndValidateProviderResponse(questions, {
      outputs: [{ choice: 'fast', confidence: 0.9, probabilities: { fast: 1, balanced: 0, strongest: 0 } }, { score: 1, probabilities: [0, 1, 0] }, { noul: 5 }],
    }, config), 'DECISION_RESPONSE_INVALID');
    throwsCode(() => parseAndValidateProviderResponse(questions, {
      answers: [{ name: 'tier', choice: 'fast', confidence: 0.9, probabilities: { fast: 1, balanced: 0, strongest: 0 } }],
    }, policy({ provider: 'openai-decisions' })), 'DECISION_RESPONSE_INVALID');
    throwsCode(() => parseAndValidateProviderResponse(questions, {
      answers: { tier: { choice: 'fast', confidence: 0.9, probabilities: { fast: 1, balanced: 0, strongest: 0 } } },
    }, policy({ provider: 'startlux-decision' })), 'DECISION_RESPONSE_INVALID');
    throwsCode(() => parseAndValidateProviderResponse(questions, {
      outputs: [{ choice: 'fast', confidence: 0.9, probabilities: { fast: 1, balanced: 0, strongest: 0 } }, { score: 1, probabilities: [0, 1, 0] }, { noul: 0.5 }],
      usage: { input_tokens: -1, output_tokens: 0 },
    }, config), 'DECISION_RESPONSE_INVALID');
  });
});
