import { DecisionClient, type DecisionBudgetLedgerPort } from './client.js';
import { classifyQuestionOutcome } from './primitives.js';
import { sanitizeDecisionState, validateDecisionImages, type DecisionScrubber } from './redaction.js';
import { DecisionError } from './types.js';
import type {
  DecisionClientOptions, DecisionEvaluation, DecisionFanOutBranch, DecisionImageAsset, DecisionMode,
  DecisionPolicyConfig, DecisionQuestion, DecisionQuestionOutcome, DecisionQuestionOutput, DecisionSdkAdapter,
  DecisionSdkRequest, DecisionTransport, DecisionTransportRequest, DecisionUsage, DecisionZoneAction,
  DecisionConfidenceZone,
} from './types.js';

/** Context handed to a deterministic fallback handler. */
export interface DecisionFallbackContext {
  readonly fallbackReason: DecisionFallbackReason;
  readonly outputs: readonly DecisionQuestionOutput[];
}

export interface DecisionRequestBase {
  readonly policy: DecisionPolicyConfig;
  readonly state: unknown;
  readonly budget: DecisionBudgetLedgerPort;
  readonly scrubber?: DecisionScrubber;
  readonly images?: readonly DecisionImageAsset[];
  readonly transport?: DecisionTransport;
  readonly sdkAdapter?: DecisionSdkAdapter;
  readonly apiKey?: string;
  readonly fallback?: (context: DecisionFallbackContext) => unknown;
}

export interface DecisionRequest extends DecisionRequestBase {
  readonly questions: readonly DecisionQuestion[];
}

export interface DecisionFanOutRequest extends DecisionRequestBase {
  readonly branches: readonly DecisionFanOutBranch[];
}

export interface DecisionEvaluationResult<T = unknown> extends DecisionEvaluation {
  /** The fallback handler's value on fallback paths (null under deterministic_default); the validated
   * outcomes on jev and confirm paths. */
  readonly value: T | readonly DecisionQuestionOutcome[] | null;
}

export interface DecisionFanOutResult<T = unknown> extends DecisionEvaluationResult<T> {
  readonly totalQuestions: number;
  readonly evaluatedBranchIds: readonly string[];
  readonly ignoredBranchIds: readonly string[];
}

type DecisionFallbackReason = NonNullable<DecisionEvaluation['fallbackReason']>;

const ZONE_SEVERITY: Readonly<Record<DecisionConfidenceZone, number>> = { high: 0, medium: 1, low: 2 };

function gateApplies(policy: DecisionPolicyConfig): boolean {
  return policy.enabled !== true || policy.disclosurePolicy === 'disabled';
}

function fallbackResult<T>(fallbackReason: DecisionFallbackReason, value: T | null, transportCalls: number): DecisionEvaluationResult<T> {
  return {
    mode: fallbackReason === 'policy_disabled' ? ('disabled' as DecisionMode) : 'fallback',
    source: 'deterministic_fallback',
    aggregateZone: null,
    aggregateAction: null,
    outcomes: [],
    value,
    fallbackReason,
    transportCalls,
    usage: null,
  };
}

function reasonToErrorCode(reason: DecisionFallbackReason): 'DECISION_DEADLINE_EXCEEDED' | 'DECISION_TRANSPORT_ERROR' | 'DECISION_BUDGET_EXCEEDED' | 'DECISION_RESPONSE_INVALID' | 'DECISION_DISCLOSURE_VIOLATION' | 'DECISION_SCHEMA_INVALID' | 'DECISION_PRIMITIVE_UNSUPPORTED' {
  switch (reason) {
    case 'deadline_exceeded': return 'DECISION_DEADLINE_EXCEEDED';
    case 'budget_exceeded': return 'DECISION_BUDGET_EXCEEDED';
    case 'disclosure_violation': return 'DECISION_DISCLOSURE_VIOLATION';
    case 'invalid_state': return 'DECISION_SCHEMA_INVALID';
    case 'invalid_response': return 'DECISION_RESPONSE_INVALID';
    case 'unsupported_primitive': return 'DECISION_PRIMITIVE_UNSUPPORTED';
    default: return 'DECISION_TRANSPORT_ERROR';
  }
}

function failureReason(error: unknown): DecisionFallbackReason {
  if (error instanceof DecisionError) {
    switch (error.code) {
      case 'DECISION_DEADLINE_EXCEEDED': return 'deadline_exceeded';
      case 'DECISION_BUDGET_EXCEEDED': return 'budget_exceeded';
      case 'DECISION_RESPONSE_INVALID': return 'invalid_response';
      case 'DECISION_DISCLOSURE_VIOLATION': return 'disclosure_violation';
      case 'DECISION_SCHEMA_INVALID': return 'invalid_state';
      case 'DECISION_PRIMITIVE_UNSUPPORTED': return 'unsupported_primitive';
      default: return 'transport_error';
    }
  }
  return 'transport_error';
}

function runFallback<T>(request: DecisionRequestBase, fallbackReason: DecisionFallbackReason, outputs: readonly DecisionQuestionOutput[], transportCalls: number): DecisionEvaluationResult<T> {
  const handler = request.fallback;
  if (handler === undefined) {
    if (request.policy.onFallbackUnavailable === 'blocked') {
      throw new DecisionError(reasonToErrorCode(fallbackReason), `no deterministic fallback handler is available for ${fallbackReason}`);
    }
    return fallbackResult<T>(fallbackReason, null, transportCalls);
  }
  return fallbackResult<T>(fallbackReason, handler({ fallbackReason, outputs }) as T, transportCalls);
}

function classifyOutputOutcome(question: DecisionQuestion, output: DecisionQuestionOutput, policy: DecisionPolicyConfig): DecisionQuestionOutcome {
  const classification = classifyQuestionOutcome(output, policy);
  return { question, output, zone: classification.zone, action: classification.action };
}

function aggregate(outcomes: readonly DecisionQuestionOutcome[]): { zone: DecisionConfidenceZone; action: DecisionZoneAction } | null {
  let worst: DecisionQuestionOutcome | undefined;
  for (const outcome of outcomes) {
    if (worst === undefined || ZONE_SEVERITY[outcome.zone] > ZONE_SEVERITY[worst.zone]) worst = outcome;
  }
  return worst === undefined ? null : { zone: worst.zone, action: worst.action };
}

function toUsage(usage: { readonly input_tokens: number; readonly output_tokens: number } | null): DecisionUsage | null {
  return usage === null ? null : { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
}

interface Prepared {
  readonly client: DecisionClient;
  readonly stateBody: string;
  readonly transportCalls: () => number;
}

/**
 * Zero-call gate (AC-1.2), image-asset disclosure checks, and pre-send state sanitization (AC-1.3) shared
 * by both router entries; disclosure and structural violations route to the deterministic fallback.
 */
function prepare(request: DecisionRequestBase): Prepared | DecisionEvaluationResult<never> {
  if (gateApplies(request.policy)) return runFallback<never>(request, 'policy_disabled', [], 0);
  let calls = 0;
  try {
    validateDecisionImages(request.images, request.policy);
    const stateBody = sanitizeDecisionState(request.state, request.policy, request.scrubber);
    const transport = request.transport;
    const adapter = request.sdkAdapter;
    const clientOptions: DecisionClientOptions = {
      policy: request.policy,
      ...(request.apiKey !== undefined ? { apiKey: request.apiKey } : {}),
      ...(transport !== undefined ? { transport: { async send(req: DecisionTransportRequest) { calls += 1; return transport.send(req); } } } : {}),
      ...(adapter !== undefined ? { sdkAdapter: { async evaluate(req: DecisionSdkRequest) { calls += 1; return adapter.evaluate(req); } } } : {}),
    };
    return { client: new DecisionClient(clientOptions), stateBody, transportCalls: () => calls };
  } catch (error) {
    const reason = failureReason(error);
    if (reason === 'disclosure_violation' || reason === 'invalid_state' || reason === 'unsupported_primitive') {
      return runFallback<never>(request, reason, [], 0);
    }
    throw error;
  }
}

function isPrepared(prepared: Prepared | DecisionEvaluationResult<never>): prepared is Prepared {
  return (prepared as Prepared).client !== undefined;
}

/**
 * Evaluate a validated question batch through the provider with full 3-zone routing (AC-2.3): `high`
 * accepts the Jev outcomes, `medium` returns them flagged `confirm` for the caller's confirmation path,
 * and `low` executes the caller's deterministic fallback (`fallbackReason: 'low_confidence'`). Every
 * deadline, transport, budget, disclosure, and response failure routes to the fallback instead of
 * throwing, unless no fallback handler exists under `onFallbackUnavailable: 'blocked'` (AC-3.1).
 */
export async function evaluateDecision<T>(request: DecisionRequest & { fallback?: (context: DecisionFallbackContext) => T }): Promise<DecisionEvaluationResult<T>> {
  const prepared = prepare(request);
  if (!isPrepared(prepared)) return prepared as DecisionEvaluationResult<T>;
  const { client, stateBody, transportCalls } = prepared;
  try {
    const images = request.images;
    const result = await client.execute(images === undefined
      ? { questions: request.questions, stateBody, budget: request.budget }
      : { questions: request.questions, stateBody, budget: request.budget, images });
    const questionById = new Map(request.questions.map(question => [question.id, question]));
    const outcomes = result.outputs.map(output => classifyOutputOutcome(questionById.get(output.id) as DecisionQuestion, output, request.policy));
    const worst = aggregate(outcomes);
    const usage = toUsage(result.usage);
    if (worst === null || worst.zone === 'low') {
      const fallbackOutcome = runFallback<T>(request, 'low_confidence', result.outputs, transportCalls());
      return { ...fallbackOutcome, outcomes, aggregateZone: worst?.zone ?? 'low', aggregateAction: worst?.action ?? 'fallback', usage };
    }
    return {
      mode: worst.zone === 'medium' ? 'confirm' : 'jev',
      source: 'jev',
      aggregateZone: worst.zone,
      aggregateAction: worst.action,
      outcomes,
      value: outcomes,
      fallbackReason: null,
      transportCalls: transportCalls(),
      usage,
    };
  } catch (error) {
    return runFallback<T>(request, failureReason(error), [], transportCalls());
  }
}

function branchAnswerValue(output: DecisionQuestionOutput): string {
  if (output.type === 'choice') return output.choice ?? 'none';
  if (output.type === 'noul') return output.affirmative ? 'affirmative' : 'negative';
  if (output.type === 'score') return String(output.score);
  return 'box';
}

/**
 * Speculative fan-out (AC-2.4): batches up to 100 branch questions into exactly one transport call, then
 * resolves only the active branch path selected by upstream answers. Unused speculative branch outputs
 * are ignored without extra network calls and reported in `ignoredBranchIds`.
 */
export async function evaluateSpeculativeFanOut<T>(request: DecisionFanOutRequest & { fallback?: (context: DecisionFallbackContext) => T }): Promise<DecisionFanOutResult<T>> {
  if (request.branches.length < 1 || request.branches.length > 100) {
    throw new DecisionError('DECISION_BATCH_SIZE_INVALID', 'fan-out branches must number between 1 and 100');
  }
  const questions = request.branches.map(branch => branch.question);
  const prepared = prepare(request);
  if (!isPrepared(prepared)) {
    return { ...prepared, totalQuestions: request.branches.length, evaluatedBranchIds: [], ignoredBranchIds: [], outcomes: [] };
  }
  const { client, stateBody, transportCalls } = prepared;
  try {
    const images = request.images;
    const result = await client.execute(images === undefined
      ? { questions, stateBody, budget: request.budget }
      : { questions, stateBody, budget: request.budget, images });
    const outputById = new Map(result.outputs.map(output => [output.id, output]));
    const branchByQuestionId = new Map(request.branches.map(branch => [branch.question.id, branch]));
    const evaluated = new Set<string>();
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const branch of request.branches) {
        if (evaluated.has(branch.branchId)) continue;
        if (branch.dependsOn === null) {
          evaluated.add(branch.branchId);
          progressed = true;
          continue;
        }
        const upstreamBranch = branchByQuestionId.get(branch.dependsOn.questionId);
        const upstreamOutput = outputById.get(branch.dependsOn.questionId);
        if (upstreamBranch !== undefined && upstreamOutput !== undefined && evaluated.has(upstreamBranch.branchId)
          && branchAnswerValue(upstreamOutput) === branch.dependsOn.value) {
          evaluated.add(branch.branchId);
          progressed = true;
        }
      }
    }
    const evaluatedBranchIds = request.branches.filter(branch => evaluated.has(branch.branchId)).map(branch => branch.branchId);
    const ignoredBranchIds = request.branches.filter(branch => !evaluated.has(branch.branchId)).map(branch => branch.branchId);
    const outcomes = request.branches
      .filter(branch => evaluated.has(branch.branchId))
      .map(branch => branchByQuestionId.get(branch.question.id))
      .filter((branch): branch is DecisionFanOutBranch => branch !== undefined)
      .map(branch => {
        const output = outputById.get(branch.question.id);
        return output === undefined ? null : classifyOutputOutcome(branch.question, output, request.policy);
      })
      .filter((outcome): outcome is DecisionQuestionOutcome => outcome !== null);
    const worst = aggregate(outcomes);
    const usage = toUsage(result.usage);
    if (worst === null || worst.zone === 'low') {
      const fallbackOutcome = runFallback<T>(request, 'low_confidence', result.outputs, transportCalls());
      return {
        ...fallbackOutcome,
        totalQuestions: request.branches.length,
        evaluatedBranchIds,
        ignoredBranchIds,
        outcomes,
        aggregateZone: worst?.zone ?? 'low',
        aggregateAction: worst?.action ?? 'fallback',
        usage,
      };
    }
    return {
      mode: worst.zone === 'medium' ? 'confirm' : 'jev',
      source: 'jev',
      aggregateZone: worst.zone,
      aggregateAction: worst.action,
      outcomes,
      value: outcomes,
      fallbackReason: null,
      transportCalls: transportCalls(),
      usage,
      totalQuestions: request.branches.length,
      evaluatedBranchIds,
      ignoredBranchIds,
    };
  } catch (error) {
    const fallbackOutcome = runFallback<T>(request, failureReason(error), [], transportCalls());
    return {
      ...fallbackOutcome,
      totalQuestions: request.branches.length,
      evaluatedBranchIds: [],
      ignoredBranchIds: [],
      outcomes: [],
    };
  }
}
