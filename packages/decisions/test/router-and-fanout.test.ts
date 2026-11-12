import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DecisionBudgetTracker, type DecisionBudgetLedgerPort } from '../src/client.js';
import { type DecisionScrubber } from '../src/redaction.js';
import { validateDecisionPolicy, validateDecisionQuestions } from '../src/schema.js';
import { evaluateDecision, evaluateSpeculativeFanOut } from '../src/router.js';
import type {
  DecisionFanOutBranch, DecisionImageAsset, DecisionPolicyConfig, DecisionQuestion, DecisionSdkAdapter,
  DecisionSdkRequest, DecisionTransport,
} from '../src/types.js';

interface RouterRequestBase {
  policy: DecisionPolicyConfig;
  state: unknown;
  budget: DecisionBudgetLedgerPort;
  scrubber?: DecisionScrubber;
  images?: readonly DecisionImageAsset[];
  transport?: DecisionTransport;
  sdkAdapter?: DecisionSdkAdapter;
  apiKey?: string;
}

function base(overrides: Partial<RouterRequestBase> = {}): RouterRequestBase {
  return { policy: policy(), state: { taskId: 'task.one' }, budget: new DecisionBudgetTracker(), apiKey: 'fixture-decision-key', ...overrides };
}

function policy(overrides: Partial<Record<string, unknown>> = {}): DecisionPolicyConfig {
  return validateDecisionPolicy({ enabled: true, disclosurePolicy: 'repo-approved-redacted-evidence', ...overrides });
}

function questions(): readonly DecisionQuestion[] {
  return validateDecisionQuestions([{ type: 'choice', id: 'tier', prompt: 'Tier?', options: { fast: 'Fast', balanced: 'Balanced', strongest: 'Strongest' } }]);
}

function keyedResponse(choice: string, confidence: number): Record<string, unknown> {
  const weight = (1 - confidence) / 2;
  return {
    answers: {
      tier: {
        choice,
        confidence,
        probabilities: {
          fast: choice === 'fast' ? confidence : weight,
          balanced: choice === 'balanced' ? confidence : weight,
          strongest: choice === 'strongest' ? confidence : weight,
        },
      },
    },
    usage: { input_tokens: 25, output_tokens: 4 },
  };
}

function transportFor(payload: () => Record<string, unknown>): DecisionTransport & { calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    async send() {
      calls += 1;
      return { status: 200, body: JSON.stringify(payload()) };
    },
  };
}

describe('evaluateDecision', () => {
  it('makes zero transport calls for a disabled policy and returns the deterministic fallback', async () => {
    const transport = transportFor(() => keyedResponse('fast', 0.95));
    const result = await evaluateDecision({
      ...base({ policy: policy({ enabled: false }), transport }),
      questions: questions(),
      fallback: () => 'deterministic-tier',
    });
    assert.equal(result.mode, 'disabled');
    assert.equal(result.source, 'deterministic_fallback');
    assert.equal(result.fallbackReason, 'policy_disabled');
    assert.equal(result.transportCalls, 0);
    assert.equal(result.value, 'deterministic-tier');
    assert.equal(transport.calls(), 0);
  });

  it('treats a disabled disclosure policy as a zero-call gate even when enabled', async () => {
    const result = await evaluateDecision({
      ...base({ policy: policy({ disclosurePolicy: 'disabled' }) }),
      questions: questions(),
      fallback: () => 'tier',
    });
    assert.equal(result.fallbackReason, 'policy_disabled');
    assert.equal(result.transportCalls, 0);
  });

  it('accepts high-confidence answers as jev with usage accounting', async () => {
    const transport = transportFor(() => keyedResponse('balanced', 0.95));
    const result = await evaluateDecision({
      ...base({ transport }),
      questions: questions(),
      fallback: () => 'unused',
    });
    assert.equal(result.mode, 'jev');
    assert.equal(result.source, 'jev');
    assert.equal(result.aggregateZone, 'high');
    assert.equal(result.aggregateAction, 'accept_jev');
    assert.equal(result.fallbackReason, null);
    assert.equal(result.transportCalls, 1);
    assert.deepEqual(result.usage, { inputTokens: 25, outputTokens: 4 });
    assert.ok(Array.isArray(result.value) && result.value.length === 1);
  });

  it('flags medium-confidence answers as confirm without invoking the fallback', async () => {
    const transport = transportFor(() => keyedResponse('balanced', 0.7));
    const result = await evaluateDecision({
      ...base({ transport }),
      questions: questions(),
      fallback: () => 'fallback-value',
    });
    assert.equal(result.mode, 'confirm');
    assert.equal(result.aggregateZone, 'medium');
    assert.equal(result.aggregateAction, 'confirm_or_fallback');
    assert.equal(result.fallbackReason, null);
    assert.notEqual(result.value, 'fallback-value');
  });

  it('routes low-confidence answers to the deterministic fallback with the raw outputs', async () => {
    const transport = transportFor(() => keyedResponse('strongest', 0.3));
    let seenReason: string | null = null;
    let seenOutputId: string | null = null;
    const result = await evaluateDecision({
      ...base({ transport }),
      questions: questions(),
      fallback: (context) => {
        seenReason = context.fallbackReason;
        const first = context.outputs[0];
        seenOutputId = first?.id ?? null;
        return 'safe-tier';
      },
    });
    assert.equal(result.mode, 'fallback');
    assert.equal(result.fallbackReason, 'low_confidence');
    assert.equal(result.aggregateZone, 'low');
    assert.equal(result.value, 'safe-tier');
    assert.equal(seenReason, 'low_confidence');
    assert.equal(seenOutputId, 'tier');
  });

  it('routes deadline, transport, budget, and response failures to the fallback', async () => {
    const hanging: DecisionTransport = { send: () => new Promise(() => { /* never resolves */ }) };
    const deadline = await evaluateDecision({
      ...base({ transport: hanging, policy: policy({ hardDeadlineMs: 100 }) }),
      questions: questions(),
      fallback: () => 'deadline-fallback',
    });
    assert.equal(deadline.fallbackReason, 'deadline_exceeded');
    assert.equal(deadline.value, 'deadline-fallback');

    const failing: DecisionTransport = { send: async () => { throw new Error('connection reset'); } };
    const transportError = await evaluateDecision({
      ...base({ transport: failing, policy: policy({ maxAttempts: 2 }) }),
      questions: questions(),
      fallback: () => 'transport-fallback',
    });
    assert.equal(transportError.fallbackReason, 'transport_error');

    const budgeted = await evaluateDecision({
      ...base({ transport: transportFor(() => keyedResponse('fast', 0.95)), budget: new DecisionBudgetTracker({ maxInputTokens: 1 }) }),
      questions: questions(),
      fallback: () => 'budget-fallback',
    });
    assert.equal(budgeted.fallbackReason, 'budget_exceeded');
    assert.equal(budgeted.transportCalls, 0);

    const malformed = transportFor(() => ({ answers: {} }));
    const invalid = await evaluateDecision({
      ...base({ transport: malformed }),
      questions: questions(),
      fallback: () => 'invalid-fallback',
    });
    assert.equal(invalid.fallbackReason, 'invalid_response');
  });

  it('throws under onFallbackUnavailable blocked when no fallback handler exists', async () => {
    const hanging: DecisionTransport = { send: () => new Promise(() => { /* never resolves */ }) };
    await assert.rejects(
      () => evaluateDecision({
        ...base({ transport: hanging, policy: policy({ hardDeadlineMs: 100, onFallbackUnavailable: 'blocked' }) }),
        questions: questions(),
      }),
      (error: { code: string }) => error.code === 'DECISION_DEADLINE_EXCEEDED',
    );
    const relaxed = await evaluateDecision({
      ...base({ transport: hanging, policy: policy({ hardDeadlineMs: 100, onFallbackUnavailable: 'deterministic_default' }) }),
      questions: questions(),
    });
    assert.equal(relaxed.value, null);
    assert.equal(relaxed.fallbackReason, 'deadline_exceeded');
  });

  it('routes disclosure violations in state or image assets to the fallback with zero calls', async () => {
    const transport = transportFor(() => keyedResponse('fast', 0.95));
    const leaked = await evaluateDecision({
      ...base({ transport, state: { token: 'ghs_AAAABBBBCCCCDDDDEEEE' } }),
      questions: questions(),
      fallback: () => 'redacted',
    });
    assert.equal(leaked.fallbackReason, 'disclosure_violation');
    assert.equal(leaked.transportCalls, 0);
    assert.equal(leaked.value, 'redacted');
    const images: readonly DecisionImageAsset[] = [{ id: 'shot', mediaType: 'image/png', data: 'aGVsbG8=' }];
    const withImages = await evaluateDecision({
      ...base({ transport, images }),
      questions: questions(),
      fallback: () => 'no-images',
    });
    assert.equal(withImages.fallbackReason, 'disclosure_violation');
    assert.equal(transport.calls(), 0);
  });

  it('runs through an sdk adapter with the same routing guarantees', async () => {
    const requests: DecisionSdkRequest[] = [];
    const result = await evaluateDecision({
      ...base({
        sdkAdapter: {
          evaluate: async (request: DecisionSdkRequest) => {
            requests.push(request);
            return keyedResponse('fast', 0.95);
          },
        },
      }),
      questions: questions(),
      fallback: () => 'unused',
    });
    assert.equal(result.mode, 'jev');
    assert.equal(result.transportCalls, 1);
    assert.equal(requests.length, 1);
  });
});

describe('evaluateSpeculativeFanOut', () => {
  function fanOutBranches(): readonly DecisionFanOutBranch[] {
    const validated = validateDecisionQuestions([
      { type: 'choice', id: 'path', prompt: 'Which path?', options: { left: 'Left', right: 'Right' } },
      { type: 'predicate', id: 'leftCheck', prompt: 'Apply the left check?' },
      { type: 'predicate', id: 'rightCheck', prompt: 'Apply the right check?' },
    ]);
    return [
      { branchId: 'root', question: validated[0] as DecisionQuestion, dependsOn: null },
      { branchId: 'left', question: validated[1] as DecisionQuestion, dependsOn: { questionId: 'path', value: 'left' } },
      { branchId: 'right', question: validated[2] as DecisionQuestion, dependsOn: { questionId: 'path', value: 'right' } },
    ];
  }

  it('resolves only the active branch path from one transport call and ignores unused branches', async () => {
    const transport = transportFor(() => ({
      answers: {
        path: { choice: 'left', confidence: 0.9, probabilities: { left: 0.8, right: 0.2 } },
        leftCheck: { noul: 0.9 },
        rightCheck: { noul: 0.1 },
      },
      usage: { input_tokens: 40, output_tokens: 6 },
    }));
    const result = await evaluateSpeculativeFanOut({
      ...base({ transport }),
      branches: fanOutBranches(),
      fallback: () => 'unused',
    });
    assert.equal(result.mode, 'jev');
    assert.equal(result.transportCalls, 1);
    assert.equal(result.totalQuestions, 3);
    assert.deepEqual(result.evaluatedBranchIds, ['root', 'left']);
    assert.deepEqual(result.ignoredBranchIds, ['right']);
    assert.equal(result.outcomes.length, 2);
  });

  it('makes zero transport calls when the policy gate is closed', async () => {
    const result = await evaluateSpeculativeFanOut({
      ...base({ policy: policy({ enabled: false }) }),
      branches: fanOutBranches(),
      fallback: () => 'deterministic',
    });
    assert.equal(result.transportCalls, 0);
    assert.deepEqual(result.evaluatedBranchIds, []);
    assert.equal(result.value, 'deterministic');
  });

  it('routes fan-out failures to the deterministic fallback', async () => {
    const hanging: DecisionTransport = { send: () => new Promise(() => { /* never resolves */ }) };
    const result = await evaluateSpeculativeFanOut({
      ...base({ transport: hanging, policy: policy({ hardDeadlineMs: 100 }) }),
      branches: fanOutBranches(),
      fallback: () => 'fanout-fallback',
    });
    assert.equal(result.fallbackReason, 'deadline_exceeded');
    assert.deepEqual(result.evaluatedBranchIds, []);
    assert.deepEqual(result.ignoredBranchIds, []);
  });

  it('rejects empty or oversized fan-out batches', async () => {
    await assert.rejects(
      () => evaluateSpeculativeFanOut({ ...base(), branches: [] }),
      (error: { code: string }) => error.code === 'DECISION_BATCH_SIZE_INVALID',
    );
  });
});
