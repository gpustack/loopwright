import { DecisionError } from './types.js';
import { isPlainObject } from './schema.js';
import type {
  DecisionBoxOutput, DecisionChoiceOutput, DecisionChoiceQuestion, DecisionImageAsset,
  DecisionNoulOutput, DecisionNoulQuestion, DecisionPolicyConfig, DecisionProviderUsage, DecisionQuestion,
  DecisionQuestionOutput, DecisionScoreOutput, DecisionScoreQuestion, DecisionStartluxOptions, DecisionZoneAction,
  DecisionConfidenceZone,
} from './types.js';

const PROBABILITY_SUM_TOLERANCE = 1e-3;

function failResponse(detail: string): never {
  throw new DecisionError('DECISION_RESPONSE_INVALID', detail);
}

function failDisclosure(detail: string): never {
  throw new DecisionError('DECISION_DISCLOSURE_VIOLATION', detail);
}

function assertFiniteUnit(value: unknown, detail: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) failResponse(detail);
  return value;
}

/** Classify a raw calibrated confidence into the `high` / `medium` / `low` zones (AC-2.3). */
export function classifyConfidenceZone(confidence: number, policy: DecisionPolicyConfig): { zone: DecisionConfidenceZone; action: DecisionZoneAction } {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) failResponse(`confidence ${confidence} is not a finite number in [0, 1]`);
  if (confidence >= policy.minConfidence) return { zone: 'high', action: 'accept_jev' };
  if (confidence >= policy.confirmThreshold) return { zone: 'medium', action: 'confirm_or_fallback' };
  return { zone: 'low', action: 'fallback' };
}

/**
 * Outcome-level classification: a StartLux `none_probability` at or above the fallback threshold
 * (default `0.2`) or a `null` choice is out-of-distribution and routes to the deterministic fallback
 * regardless of the reported confidence.
 */
export function classifyQuestionOutcome(output: DecisionQuestionOutput, policy: DecisionPolicyConfig): { zone: DecisionConfidenceZone; action: DecisionZoneAction } {
  if (output.type === 'choice') {
    const threshold = policy.startluxOptions?.noneProbabilityThreshold ?? 0.2;
    if (output.choice === null || (output.noneProbability !== undefined && output.noneProbability >= threshold)) {
      return { zone: 'low', action: 'fallback' };
    }
  }
  return classifyConfidenceZone(output.confidence, policy);
}

function systemoneQuestionWire(question: DecisionQuestion): unknown {
  if (question.type === 'choice') return { type: 'choice', instructions: question.prompt, criteria: { ...question.options } };
  if (question.type === 'score') return { type: 'score', instructions: question.prompt, criteria: [...question.criteria] };
  if (question.type === 'box') return { type: 'box', instructions: question.prompt };
  return { type: 'noul', instructions: question.prompt };
}

function openaiQuestionWire(question: DecisionQuestion): unknown {
  const name = question.id;
  const instructions = question.prompt;
  if (question.type === 'choice') return { type: 'choice', name, instructions, choices: Object.keys(question.options) };
  if (question.type === 'score') {
    return { type: 'score', name, instructions, levels: question.criteria.map((description, index) => ({ level: index + 1, description })) };
  }
  if (question.type === 'box') return { type: 'box', name, instructions };
  return { type: 'predicate', name, instructions };
}

/**
 * Serialize the sanitized `state`, validated questions, and optional image assets into the provider's wire
 * format (REVIEW-002, REVIEW-003): typesafe-jev and startlux-decision share the keyed `/v1/systemone`
 * protocol (`questions` map keyed by id, `assets`/`images` for multimodal input, StartLux deliberation
 * controls), openai-decisions uses `{ model, input, questions: [...] }` with `predicate` binaries and
 * 1-indexed score levels. Image-carrying requests require an image-capable policy.
 */
export function formatProviderRequest(questions: readonly DecisionQuestion[], stateBody: string, policy: DecisionPolicyConfig, images: readonly DecisionImageAsset[] = []): string {
  if (images.length > 0 && (!policy.allowImages || policy.disclosurePolicy !== 'repo-approved-redacted-evidence')) {
    failDisclosure('image assets require policy.allowImages === true under the repo-approved-redacted-evidence disclosure policy');
  }
  let state: unknown;
  try {
    state = JSON.parse(stateBody);
  } catch {
    throw new DecisionError('DECISION_SCHEMA_INVALID', 'sanitized state body is not valid JSON');
  }
  if (policy.provider === 'openai-decisions') {
    const input = images.length === 0
      ? state
      : [{ type: 'input_json', json: state }, ...images.map(asset => ({ type: 'input_image', image_url: `data:${asset.mediaType};base64,${asset.data}` }))];
    const wireQuestions = questions.map(openaiQuestionWire);
    return JSON.stringify({ model: policy.model, input, questions: wireQuestions });
  }
  const wireQuestions: Record<string, unknown> = {};
  for (const question of questions) wireQuestions[question.id] = systemoneQuestionWire(question);
  const request: Record<string, unknown> = { model: policy.model, state, questions: wireQuestions };
  if (policy.provider === 'startlux-decision') {
    const options: DecisionStartluxOptions = policy.startluxOptions ?? {};
    const allowNone = questions.some(question => question.type === 'choice' && question.allowNone === true);
    request['think_mode'] = options.thinkMode ?? 'auto';
    request['think_budget'] = options.thinkBudget ?? 1024;
    request['gate'] = options.gate ?? 0.6;
    request['allow_none'] = options.allowNone ?? allowNone;
    request['none_check'] = options.noneCheck ?? true;
  }
  if (images.length > 0) {
    if (policy.provider === 'typesafe-jev') {
      const assets: Record<string, unknown> = {};
      for (const asset of images) assets[asset.id] = { type: 'image', data: asset.data, media_type: asset.mediaType };
      request['assets'] = assets;
    } else {
      request['images'] = images.map(asset => asset.data);
    }
  }
  return JSON.stringify(request);
}

/** Transport headers the client must attach when dispatching multimodal or long-context requests. */
export function providerRequestHeaders(policy: DecisionPolicyConfig, questions: readonly DecisionQuestion[], images: readonly DecisionImageAsset[] = []): Readonly<Record<string, string>> {
  if (images.length === 0 && !questions.some(question => question.type === 'box')) return {};
  return Object.freeze({ 'TypeSafe-Danger-Zone-Images': 'true' });
}

function assertUsage(raw: unknown): DecisionProviderUsage | null {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) failResponse('usage must be a plain object when present');
  for (const key of ['input_tokens', 'output_tokens']) {
    const value = raw[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) failResponse(`usage.${key} must be a non-negative finite number`);
  }
  return { input_tokens: raw['input_tokens'] as number, output_tokens: raw['output_tokens'] as number };
}

function assertSumToOne(values: readonly number[], detail: string): void {
  const sum = values.reduce((total, value) => total + value, 0);
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) failResponse(`${detail} sum to ${sum} instead of 1.0 ± ${PROBABILITY_SUM_TOLERANCE}`);
}

/**
 * Normalize array or keyed-object score probabilities (`"0".."n-1"` or `"1".."n"` keys) to a plain array;
 * `offset` reports the detected scale origin so continuous scores normalize into `[0, 1]`.
 */
function normalizeScoreProbabilities(raw: unknown, question: DecisionScoreQuestion, detail: string): { probabilities: readonly number[]; offset: 0 | 1 } {
  const criteriaCount = question.criteria.length;
  if (Array.isArray(raw)) {
    if (raw.length !== criteriaCount) failResponse(`${detail} probabilities array must have ${criteriaCount} entries`);
    const probabilities = raw.map((value, index) => assertFiniteUnit(value, `${detail} probability ${index}`));
    assertSumToOne(probabilities, `${detail} probabilities`);
    return { probabilities, offset: 0 };
  }
  if (isPlainObject(raw)) {
    for (const offset of [0, 1] as const) {
      const keys = Array.from({ length: criteriaCount }, (_, index) => String(index + offset));
      if (keys.every(key => typeof raw[key] === 'number')) {
        const probabilities = keys.map(key => assertFiniteUnit(raw[key], `${detail} probability for level ${key}`));
        assertSumToOne(probabilities, `${detail} probabilities`);
        return { probabilities, offset };
      }
    }
    // Cloudflare Clef style: probabilities keyed by the exact criteria label strings.
    if (question.criteria.every(label => typeof raw[label] === 'number')) {
      const probabilities = question.criteria.map(label => assertFiniteUnit(raw[label], `${detail} probability for level "${label}"`));
      assertSumToOne(probabilities, `${detail} probabilities`);
      return { probabilities, offset: 0 };
    }
    failResponse(`${detail} probabilities object must carry "0".."n-1", "1".."n", or criteria-label keys`);
  }
  failResponse(`${detail} probabilities must be an array or a keyed object`);
}

function parseChoiceOutput(question: DecisionChoiceQuestion, raw: Record<string, unknown>): DecisionChoiceOutput {
  const declaredKeys = Object.keys(question.options);
  const rawProbabilities = raw['probabilities'] ?? raw['distribution'];
  if (!isPlainObject(rawProbabilities)) failResponse(`choice answer ${question.id} probabilities must be a keyed object`);
  const values = declaredKeys.map(key => assertFiniteUnit(rawProbabilities[key], `choice answer ${question.id} probability for option ${key}`));
  assertSumToOne(values, `choice answer ${question.id} probabilities`);
  const probabilities: Record<string, number> = {};
  for (const [index, key] of declaredKeys.entries()) probabilities[key] = values[index] as number;
  const confidence = assertFiniteUnit(raw['confidence'] ?? raw['probability'], `choice answer ${question.id} confidence`);
  const rawChoice = raw['choice'] !== undefined ? raw['choice'] : raw['selected'];
  if (rawChoice === null) return { type: 'choice', id: question.id, choice: null, confidence, probabilities };
  if (typeof rawChoice !== 'string' || !declaredKeys.includes(rawChoice)) {
    failResponse(`choice answer ${question.id} must select a declared option key`);
  }
  const noneProbability = raw['none_probability'] ?? raw['noneProbability'];
  if (noneProbability === undefined) return { type: 'choice', id: question.id, choice: rawChoice, confidence, probabilities };
  const normalizedNoneProbability = assertFiniteUnit(noneProbability, `choice answer ${question.id} none_probability`);
  return { type: 'choice', id: question.id, choice: rawChoice, confidence, probabilities, noneProbability: normalizedNoneProbability };
}

function parseScoreOutput(question: DecisionScoreQuestion, raw: Record<string, unknown>, requireIntegerScore: boolean): DecisionScoreOutput {
  const criteriaCount = question.criteria.length;
  const { probabilities, offset } = normalizeScoreProbabilities(raw['probabilities'] ?? raw['probability_distribution'], question, `score answer ${question.id}`);
  const rawScore = raw['score'] ?? raw['expected_score'];
  if (typeof rawScore !== 'number' || !Number.isFinite(rawScore)) failResponse(`score answer ${question.id} score must be a finite number`);
  if (rawScore < offset || rawScore > offset + criteriaCount - 1) {
    failResponse(`score answer ${question.id} score ${rawScore} is outside the declared [${offset}, ${offset + criteriaCount - 1}] scale`);
  }
  if (requireIntegerScore && !Number.isInteger(rawScore)) {
    failResponse(`score answer ${question.id} score must be an integer on the legacy discrete scale`);
  }
  const normalizedScore = (rawScore - offset) / (criteriaCount - 1);
  const confidence = assertFiniteUnit(raw['confidence'] ?? Math.max(...probabilities), `score answer ${question.id} confidence`);
  return { type: 'score', id: question.id, score: rawScore, normalizedScore, confidence, probabilities };
}

function parseNoulOutput(question: DecisionNoulQuestion, rawNoul: unknown, policy: DecisionPolicyConfig): DecisionNoulOutput {
  const noul = assertFiniteUnit(rawNoul, `noul answer ${question.id} probability`);
  const threshold = question.threshold ?? policy.minConfidence;
  const confidence = Math.abs(2 * noul - 1);
  return { type: 'noul', id: question.id, noul, confidence, threshold, affirmative: noul >= threshold };
}

function parseBoxOutput(questionId: string, raw: Record<string, unknown>): DecisionBoxOutput {
  const rawBox = raw['box'];
  if (!isPlainObject(rawBox)) failResponse(`box answer ${questionId} must carry a plain box object`);
  const top = assertFiniteUnit(rawBox['top'], `box answer ${questionId} top coordinate`);
  const bottom = assertFiniteUnit(rawBox['bottom'], `box answer ${questionId} bottom coordinate`);
  const left = assertFiniteUnit(rawBox['left'], `box answer ${questionId} left coordinate`);
  const right = assertFiniteUnit(rawBox['right'], `box answer ${questionId} right coordinate`);
  if (top > bottom || left > right) failResponse(`box answer ${questionId} coordinates must satisfy top <= bottom and left <= right`);
  const confidence = assertFiniteUnit(raw['confidence'], `box answer ${questionId} confidence`);
  return { type: 'box', id: questionId, box: { top, bottom, left, right }, confidence };
}

function parseAnswerFor(question: DecisionQuestion, raw: Record<string, unknown>, policy: DecisionPolicyConfig, requireIntegerScore: boolean): DecisionQuestionOutput {
  if (question.type === 'choice') return parseChoiceOutput(question, raw);
  if (question.type === 'score') return parseScoreOutput(question, raw, requireIntegerScore);
  if (question.type === 'box') return parseBoxOutput(question.id, raw);
  const probability = raw['noul'] ?? raw['probability'];
  return parseNoulOutput(question, probability, policy);
}

/** Legacy positional `outputs` parse (AC-2.2 wire shape); kept backward-compatible by REVIEW-003. */
function parseLegacyOutputs(questions: readonly DecisionQuestion[], rawOutputs: unknown, policy: DecisionPolicyConfig): readonly DecisionQuestionOutput[] {
  if (!Array.isArray(rawOutputs) || rawOutputs.length !== questions.length) {
    failResponse(`outputs length ${Array.isArray(rawOutputs) ? rawOutputs.length : 'non-array'} must equal the ${questions.length}-question batch`);
  }
  return questions.map((question, index) => {
    const raw = rawOutputs[index];
    if (!isPlainObject(raw)) failResponse(`output ${index} must be a plain object`);
    return parseAnswerFor(question, raw, policy, true);
  });
}

/** OpenAI `/v1/decisions` answers array keyed by `name` with `predicate` binaries. */
function parseOpenAiAnswers(questions: readonly DecisionQuestion[], rawAnswers: unknown, policy: DecisionPolicyConfig): readonly DecisionQuestionOutput[] {
  if (!Array.isArray(rawAnswers) || rawAnswers.length !== questions.length) {
    failResponse(`answers length must equal the ${questions.length}-question batch`);
  }
  const byName = new Map<string, Record<string, unknown>>();
  for (const raw of rawAnswers) {
    if (!isPlainObject(raw) || typeof raw['name'] !== 'string') failResponse('each openai answer must carry a string name');
    if (byName.has(raw['name'])) failResponse(`duplicate openai answer for ${raw['name']}`);
    byName.set(raw['name'], raw);
  }
  return questions.map(question => {
    const raw = byName.get(question.id);
    if (raw === undefined) failResponse(`missing openai answer for ${question.id}`);
    return parseAnswerFor(question, raw, policy, false);
  });
}

/** `/v1/systemone` keyed `answers` map shared by typesafe-jev and startlux-decision. */
function parseKeyedAnswers(questions: readonly DecisionQuestion[], rawAnswers: unknown, policy: DecisionPolicyConfig): readonly DecisionQuestionOutput[] {
  if (!isPlainObject(rawAnswers)) failResponse('systemone answers must be a keyed object');
  return questions.map(question => {
    const raw = rawAnswers[question.id];
    if (!isPlainObject(raw)) failResponse(`missing systemone answer for ${question.id}`);
    return parseAnswerFor(question, raw, policy, false);
  });
}

export interface ParsedProviderResponse {
  readonly outputs: readonly DecisionQuestionOutput[];
  readonly usage: DecisionProviderUsage | null;
}

/**
 * Shape-driven provider response parsing (REVIEW-002, REVIEW-003): accepts the `/v1/systemone` keyed
 * `answers` map, the openai-decisions `answers` array keyed by `name`, and the legacy positional
 * `outputs` array, so all three providers and existing fixtures interoperate. Any structural or numeric
 * violation fails closed with `DECISION_RESPONSE_INVALID`.
 */
export function parseAndValidateProviderResponse(questions: readonly DecisionQuestion[], rawResponse: unknown, policy: DecisionPolicyConfig): ParsedProviderResponse {
  if (!isPlainObject(rawResponse)) failResponse('provider response must be a plain object');
  // Cloudflare Workers AI wraps payloads in `{ result: { answers|outputs, usage } }`; unwrap and merge usage.
  let effective: Record<string, unknown> = rawResponse;
  const wrapped = rawResponse['result'];
  if (isPlainObject(wrapped) && (Array.isArray(wrapped['answers']) || Array.isArray(wrapped['outputs']) || isPlainObject(wrapped['answers']))) {
    effective = { ...wrapped, usage: wrapped['usage'] ?? rawResponse['usage'] };
  }
  const usage = assertUsage(effective['usage']);
  if (Array.isArray(effective['outputs'])) return { outputs: parseLegacyOutputs(questions, effective['outputs'], policy), usage };
  if (Array.isArray(effective['answers'])) return { outputs: parseOpenAiAnswers(questions, effective['answers'], policy), usage };
  if (isPlainObject(effective['answers'])) return { outputs: parseKeyedAnswers(questions, effective['answers'], policy), usage };
  failResponse('provider response must carry an outputs array or an answers array/map');
}
