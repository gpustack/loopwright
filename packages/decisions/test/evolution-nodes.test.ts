import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DecisionBudgetTracker } from '../src/client.js';
import {
  assertDecisionAuthorityBoundary,
  computeTokenShingleJaccard,
  evaluateCascadeEscalation,
  evaluateMutationNovelty,
  heuristicCascadeEscalation,
  heuristicEvolutionStrategy,
  normalizeEvolveBlockSource,
  routeEvolutionStrategy,
} from '../src/nodes.js';
import type { DecisionRequestBase } from '../src/router.js';
import { validateDecisionPolicy } from '../src/schema.js';
import {
  DECISION_ALLOWED_AUTHORITY_INTENTS,
  DECISION_FORBIDDEN_AUTHORITY_INTENTS,
  DecisionError,
} from '../src/types.js';
import type {
  DecisionCascadeEscalationInput,
  DecisionEvolutionStrategyInput,
  DecisionMutationNoveltyInput,
  DecisionPolicyConfig,
  DecisionTransport,
} from '../src/types.js';

function policy(overrides: Partial<Record<string, unknown>> = {}): DecisionPolicyConfig {
  return validateDecisionPolicy({
    enabled: true,
    disclosurePolicy: 'repo-approved-redacted-evidence',
    ...overrides,
  });
}

function transportFor(
  payload: (body: Record<string, unknown>) => Record<string, unknown>,
): DecisionTransport & { calls: () => number; lastBody: () => Record<string, unknown> | null } {
  let calls = 0;
  let last: Record<string, unknown> | null = null;
  return {
    calls: () => calls,
    lastBody: () => last,
    async send(req) {
      calls += 1;
      last = JSON.parse(req.body) as Record<string, unknown>;
      return { status: 200, body: JSON.stringify(payload(last)) };
    },
  };
}

function base(overrides: Partial<DecisionRequestBase> = {}): DecisionRequestBase {
  return {
    policy: policy(),
    state: {},
    budget: new DecisionBudgetTracker(),
    apiKey: 'fixture-decision-key',
    ...overrides,
  };
}

describe('evolution authority boundaries', () => {
  it('registers the three evolution advisory intents in DECISION_ALLOWED_AUTHORITY_INTENTS', () => {
    for (const intent of [
      'advise_mutation_novelty',
      'route_evolution_strategy',
      'advise_cascade_escalation',
    ]) {
      assert.ok(DECISION_ALLOWED_AUTHORITY_INTENTS.includes(intent), `missing allowed intent ${intent}`);
      assert.doesNotThrow(() => assertDecisionAuthorityBoundary(intent));
    }
  });

  it('strictly refuses all forbidden authority intents with DECISION_AUTHORITY_VIOLATION and authorityViolation: true', () => {
    const forbiddenIntents = [
      ...DECISION_FORBIDDEN_AUTHORITY_INTENTS,
      'approve_gate',
      'mint_evidence',
      'bypass_sandbox',
      'override_scope',
      'publish_unverified',
      'mutate_protected_workflow',
    ];
    for (const intent of forbiddenIntents) {
      assert.throws(
        () => assertDecisionAuthorityBoundary(intent),
        (error: unknown) =>
          error instanceof DecisionError
          && error.code === 'DECISION_AUTHORITY_VIOLATION'
          && error.authorityViolation === true,
      );
    }
  });
});

describe('evaluateMutationNovelty', () => {
  const baselineKernel = `
    // Compute tiled dot product
    __device__ void gemm_tile(float* a, float* b, float* c, int n) {
      /* Accumulate across K */
      float acc = 0.0f;
      for (int k = 0; k < n; ++k) {
        acc += a[k] * b[k];
      }
      c[0] = acc;
    }
  `;

  it('normalizes comments (//, /* */, #) and whitespace while preserving string literals', () => {
    const withComments = `
      # python-style comment
      const char* tag = "keep // # /* inside */"; // trailing
      /* multi-line
         comment */
      int   x   =   1 + 2;
    `;
    const normalized = normalizeEvolveBlockSource(withComments);
    assert.equal(normalized, 'const char* tag = "keep // # /* inside */"; int x = 1 + 2;');
  });

  it('rejects exact whitespace/comment-only clones (Jaccard === 1.0) with 0 transport calls', async () => {
    const transport = transportFor(() => {
      throw new Error('must not be called for exact normalized clone');
    });
    const whitespaceOnlyEdit = `
      # different comment style
      __device__ void gemm_tile(float* a, float* b, float* c, int n) {
        float acc = 0.0f;
        for (int k = 0; k < n; ++k) { acc += a[k] * b[k]; }
        c[0] = acc;
      }
    `;
    const input: DecisionMutationNoveltyInput = {
      candidateId: 'cand-clone',
      candidateSlice: whitespaceOnlyEdit,
      historySlices: [{ id: 'hist-1', sourceSlice: baselineKernel }],
    };
    const result = await evaluateMutationNovelty({ ...base({ transport }), novelty: input });
    assert.equal(result.action, 'reject_resample');
    assert.equal(result.noveltyScore, 0);
    assert.equal(result.maxSimilarity, 1);
    assert.equal(result.matchedHistoryId, 'hist-1');
    assert.equal(result.source, 'deterministic_heuristic');
    assert.equal(result.transportCalls, 0);
    assert.equal(result.advisoryOnly, true);
    assert.equal(result.verificationCertified, false);
    assert.equal(transport.calls(), 0);
  });

  it('accepts structurally distinct candidates below noveltyThreshold with 0 transport calls', async () => {
    const transport = transportFor(() => {
      throw new Error('must not be called below noveltyThreshold');
    });
    const novelKernel = `
      __device__ void warp_reduce_softmax(half* logits, int stride) {
        float m = -INFINITY;
        for (int lane = threadIdx.x; lane < stride; lane += 32) {
          m = fmaxf(m, __half2float(logits[lane]));
        }
        m = fmaxf(m, __shfl_xor_sync(0xffffffff, m, 16));
      }
    `;
    const result = await evaluateMutationNovelty({
      ...base({ transport }),
      novelty: {
        candidateId: 'cand-novel',
        candidateSlice: novelKernel,
        historySlices: [{ id: 'hist-1', sourceSlice: baselineKernel }],
        noveltyThreshold: 0.85,
      },
    });
    assert.equal(result.action, 'accept');
    assert.ok(result.maxSimilarity < 0.85);
    assert.ok(result.noveltyScore > 0.15);
    assert.equal(result.source, 'deterministic_heuristic');
    assert.equal(result.transportCalls, 0);
    assert.equal(result.advisoryOnly, true);
    assert.equal(result.verificationCertified, false);
    assert.equal(transport.calls(), 0);
  });

  it('queries System-One noul in the soft high-similarity band [noveltyThreshold, 1.0) and rejects cosmetic clones', async () => {
    const renamedKernel = `
      __device__ void gemm_tile(float* a, float* b, float* c, int n) {
        float sum = 0.0f;
        for (int k = 0; k < n; ++k) {
          sum += a[k] * b[k];
        }
        c[0] = sum;
      }
    `;
    const sim = computeTokenShingleJaccard(baselineKernel, renamedKernel);
    assert.ok(sim >= 0.5 && sim < 1.0, `expected soft-band similarity, got ${sim}`);

    const transport = transportFor(() => ({
      answers: { 'mutation-cosmetic-clone': { noul: 0.96 } },
      usage: { input_tokens: 45, output_tokens: 5 },
    }));
    const result = await evaluateMutationNovelty({
      ...base({ transport }),
      novelty: {
        candidateId: 'cand-rename',
        candidateSlice: renamedKernel,
        historySlices: [{ id: 'hist-1', sourceSlice: baselineKernel }],
        noveltyThreshold: 0.5,
      },
    });
    assert.equal(result.action, 'reject_resample');
    assert.equal(result.source, 'jev');
    assert.equal(result.zone, 'high');
    assert.equal(result.fallbackReason, null);
    assert.equal(result.transportCalls, 1);
    assert.equal(result.advisoryOnly, true);
    assert.equal(result.verificationCertified, false);
  });

  it('accepts soft-band candidates when System-One noul says not a cosmetic clone, or falls back deterministically when disabled/low-confidence/disclosure-blocked', async () => {
    const tunedKernel = `
      __device__ void gemm_tile(float* a, float* b, float* c, int n) {
        float acc = 0.0f;
        for (int k = 0; k < n; k += 2) {
          acc += a[k] * b[k];
        }
        c[0] = acc;
      }
    `;
    const novelty: DecisionMutationNoveltyInput = {
      candidateId: 'cand-tune',
      candidateSlice: tunedKernel,
      historySlices: [{ id: 'hist-1', sourceSlice: baselineKernel }],
      noveltyThreshold: 0.5,
    };

    // System-One says NOT a cosmetic clone (noul = 0.05 -> confidence 0.90, affirmative = false)
    const acceptTransport = transportFor(() => ({
      answers: { 'mutation-cosmetic-clone': { noul: 0.05 } },
    }));
    const accepted = await evaluateMutationNovelty({ ...base({ transport: acceptTransport }), novelty });
    assert.equal(accepted.action, 'accept');
    assert.equal(accepted.source, 'jev');
    assert.equal(accepted.transportCalls, 1);
    assert.equal(accepted.advisoryOnly, true);
    assert.equal(accepted.verificationCertified, false);

    // Disabled policy -> deterministic fallback, 0 transport calls
    const disabled = await evaluateMutationNovelty({
      ...base({ policy: policy({ enabled: false }) }),
      novelty,
    });
    assert.equal(disabled.action, 'accept');
    assert.equal(disabled.source, 'deterministic_fallback');
    assert.equal(disabled.fallbackReason, 'policy_disabled');
    assert.equal(disabled.transportCalls, 0);
    assert.equal(disabled.advisoryOnly, true);
    assert.equal(disabled.verificationCertified, false);

    // Low confidence -> deterministic fallback
    const lowConfTransport = transportFor(() => ({
      answers: { 'mutation-cosmetic-clone': { noul: 0.52 } },
    }));
    const lowConf = await evaluateMutationNovelty({ ...base({ transport: lowConfTransport }), novelty });
    assert.equal(lowConf.action, 'accept');
    assert.equal(lowConf.source, 'deterministic_fallback');
    assert.equal(lowConf.fallbackReason, 'low_confidence');
    assert.equal(lowConf.transportCalls, 1);

    // Secret in slice -> disclosure_violation fallback with 0 transport calls
    const secretTransport = transportFor(() => {
      throw new Error('must not be called when slice contains secret');
    });
    const secretSlice = `${tunedKernel}\nconst char* key = "ghp_1234567890abcdefghij123456";`;
    const secretResult = await evaluateMutationNovelty({
      ...base({ transport: secretTransport }),
      novelty: { ...novelty, candidateSlice: secretSlice, noveltyThreshold: 0.4 },
    });
    assert.equal(secretResult.source, 'deterministic_fallback');
    assert.equal(secretResult.fallbackReason, 'disclosure_violation');
    assert.equal(secretResult.transportCalls, 0);
    assert.equal(secretTransport.calls(), 0);
  });

  it('validates untrusted novelty inputs including null-prototype objects and threshold bounds', async () => {
    const nullProtoInput = Object.assign(Object.create(null), {
      candidateId: 'cand-np',
      candidateSlice: 'int x = 1;',
      historySlices: [Object.assign(Object.create(null), { id: 'h1', sourceSlice: 'int x = 1;' })],
    }) as DecisionMutationNoveltyInput;
    const res = await evaluateMutationNovelty({ ...base(), novelty: nullProtoInput });
    assert.equal(res.action, 'reject_resample');

    await assert.rejects(
      () => evaluateMutationNovelty({
        ...base(),
        novelty: { candidateId: 'c', candidateSlice: 'a', historySlices: [], noveltyThreshold: 0 },
      }),
      (err: unknown) => err instanceof DecisionError && err.code === 'DECISION_SCHEMA_INVALID',
    );
    await assert.rejects(
      () => evaluateMutationNovelty({
        ...base(),
        novelty: { candidateId: 'c', candidateSlice: 'a', historySlices: [], noveltyThreshold: 1.1 },
      }),
      (err: unknown) => err instanceof DecisionError && err.code === 'DECISION_SCHEMA_INVALID',
    );
  });
});

describe('routeEvolutionStrategy', () => {
  const baseStrategy: DecisionEvolutionStrategyInput = {
    operatorKind: 'flash_decode',
    tensorRank: 4,
    dtype: 'bf16',
    isReduction: true,
    isCausal: true,
    declaredTracks: ['triton', 'cute', 'cuda_raw'],
    allowedMutationKinds: ['diff_tune', 'full_rewrite', 'crossover'],
    hardwareDiagnostics: {
      boundPipeline: 'smem_lds_ub',
      rooflineHeadroom: 1.6,
      occupancyPct: 28,
      localSpillBytes: 0,
    },
  };

  it('selects declared trackId and mutationKind via System-One when high-confidence', async () => {
    const transport = transportFor(() => ({
      answers: {
        'evolution-track': {
          choice: 'cute',
          confidence: 0.91,
          probabilities: { triton: 0.04, cute: 0.91, cuda_raw: 0.05 },
        },
        'evolution-mutation-kind': {
          choice: 'full_rewrite',
          confidence: 0.89,
          probabilities: { diff_tune: 0.06, full_rewrite: 0.89, crossover: 0.05 },
        },
      },
      usage: { input_tokens: 70, output_tokens: 10 },
    }));

    const result = await routeEvolutionStrategy({ ...base({ transport }), strategy: baseStrategy });
    assert.equal(result.trackId, 'cute');
    assert.equal(result.mutationKind, 'full_rewrite');
    assert.equal(result.source, 'jev');
    assert.equal(result.transportCalls, 1);
    assert.equal(result.advisoryOnly, true);
    assert.equal(result.verificationCertified, false);
  });

  it('fails closed to deterministic Roofline fallback if provider returns an undeclared track', async () => {
    const transport = transportFor(() => ({
      answers: {
        'evolution-track': {
          choice: 'undeclared_custom_dsl',
          confidence: 0.95,
          probabilities: { triton: 0.02, cute: 0.95, cuda_raw: 0.03 },
        },
        'evolution-mutation-kind': {
          choice: 'diff_tune',
          confidence: 0.95,
          probabilities: { diff_tune: 0.95, full_rewrite: 0.03, crossover: 0.02 },
        },
      },
    }));

    const result = await routeEvolutionStrategy({ ...base({ transport }), strategy: baseStrategy });
    assert.ok(baseStrategy.declaredTracks.includes(result.trackId));
    assert.ok(baseStrategy.allowedMutationKinds.includes(result.mutationKind));
    assert.equal(result.source, 'deterministic_fallback');
    assert.equal(result.fallbackReason, 'invalid_response');
    assert.equal(result.advisoryOnly, true);
    assert.equal(result.verificationCertified, false);
  });

  it('applies deterministic Roofline fallback rules for spills, smem/hbm low occupancy, and tensor_cube', async () => {
    // High register spills -> diff_tune + low-level track
    const spillStrategy: DecisionEvolutionStrategyInput = {
      ...baseStrategy,
      hardwareDiagnostics: {
        boundPipeline: 'vector_valu',
        rooflineHeadroom: 1.3,
        occupancyPct: 50,
        localSpillBytes: 128,
      },
    };
    const spillResult = await routeEvolutionStrategy({
      ...base({ policy: policy({ enabled: false }) }),
      strategy: spillStrategy,
    });
    assert.equal(spillResult.mutationKind, 'diff_tune');
    assert.equal(spillResult.trackId, 'cute');
    assert.equal(spillResult.source, 'deterministic_fallback');
    assert.equal(spillResult.fallbackReason, 'policy_disabled');
    assert.equal(spillResult.transportCalls, 0);
    assert.equal(spillResult.advisoryOnly, true);
    assert.equal(spillResult.verificationCertified, false);

    // smem_lds_ub + low occupancy -> full_rewrite + layout track
    const smemHeuristic = heuristicEvolutionStrategy(baseStrategy);
    assert.equal(smemHeuristic.mutationKind, 'full_rewrite');
    assert.equal(smemHeuristic.trackId, 'cute');

    // Ascend tracks only -> strictly picks from declared Ascend tracks
    const ascendHeuristic = heuristicEvolutionStrategy({
      ...baseStrategy,
      declaredTracks: ['ascend_tile', 'ascend_regbase', 'ascend_simt'],
      hardwareDiagnostics: { boundPipeline: 'tensor_cube', rooflineHeadroom: 1.4, occupancyPct: 70 },
    });
    assert.equal(ascendHeuristic.trackId, 'ascend_tile');
    assert.equal(ascendHeuristic.mutationKind, 'crossover');
  });

  it('rejects empty declaredTracks or invalid diagnostics with DECISION_SCHEMA_INVALID', async () => {
    await assert.rejects(
      () => routeEvolutionStrategy({
        ...base(),
        strategy: { ...baseStrategy, declaredTracks: [] },
      }),
      (err: unknown) => err instanceof DecisionError && err.code === 'DECISION_SCHEMA_INVALID',
    );
  });
});

describe('evaluateCascadeEscalation', () => {
  const baseCascade: DecisionCascadeEscalationInput = {
    candidateId: 'cand-42',
    smokeCorrectnessPassed: true,
    smokeMetrics: { latency_us_p50: 85, peak_mem_bytes: 1024 },
    referenceMetrics: { latency_us_p50: 100, peak_mem_bytes: 1024 },
    primaryMetric: 'latency_us_p50',
    direction: 'minimize',
    remainingBudgetRatio: 0.6,
  };

  it('deterministically prunes with 0 transport calls when smoke correctness failed', async () => {
    const transport = transportFor(() => {
      throw new Error('must not be called when smoke correctness failed');
    });
    const result = await evaluateCascadeEscalation({
      ...base({ transport }),
      cascade: { ...baseCascade, smokeCorrectnessPassed: false },
    });
    assert.equal(result.action, 'prune');
    assert.equal(result.smokeCorrectnessPassed, false);
    assert.equal(result.source, 'deterministic_heuristic');
    assert.equal(result.transportCalls, 0);
    assert.equal(result.advisoryOnly, true);
    assert.equal(result.verificationCertified, false);
    assert.equal(transport.calls(), 0);
  });

  it('accepts high-confidence System-One prune | confirm | escalate decisions while never certifying verification', async () => {
    for (const action of ['prune', 'confirm', 'escalate'] as const) {
      const transport = transportFor(() => ({
        answers: {
          'cascade-escalation': {
            choice: action,
            confidence: 0.92,
            probabilities: {
              prune: action === 'prune' ? 0.92 : 0.04,
              confirm: action === 'confirm' ? 0.92 : 0.04,
              escalate: action === 'escalate' ? 0.92 : 0.04,
            },
          },
        },
        usage: { input_tokens: 40, output_tokens: 5 },
      }));
      const result = await evaluateCascadeEscalation({ ...base({ transport }), cascade: baseCascade });
      assert.equal(result.action, action);
      assert.equal(result.smokeCorrectnessPassed, true);
      assert.equal(result.source, 'jev');
      assert.equal(result.transportCalls, 1);
      assert.equal(result.advisoryOnly, true);
      assert.equal(result.verificationCertified, false);
    }
  });

  it('falls back deterministically to escalate, confirm, or prune when System-One is disabled or low-confidence', async () => {
    // Improving smoke latency -> escalate
    const escalated = await evaluateCascadeEscalation({
      ...base({ policy: policy({ enabled: false }) }),
      cascade: baseCascade,
    });
    assert.equal(escalated.action, 'escalate');
    assert.equal(escalated.source, 'deterministic_fallback');
    assert.equal(escalated.fallbackReason, 'policy_disabled');
    assert.equal(escalated.transportCalls, 0);
    assert.equal(escalated.advisoryOnly, true);
    assert.equal(escalated.verificationCertified, false);

    // Slight regression within 5% tolerance and healthy budget -> confirm
    assert.equal(
      heuristicCascadeEscalation({
        ...baseCascade,
        smokeMetrics: { latency_us_p50: 103 },
        remainingBudgetRatio: 0.5,
      }),
      'confirm',
    );

    // Large regression -> prune even with low-confidence Jev response
    const lowConfTransport = transportFor(() => ({
      answers: {
        'cascade-escalation': {
          choice: 'escalate',
          confidence: 0.35,
          probabilities: { prune: 0.35, confirm: 0.30, escalate: 0.35 },
        },
      },
    }));
    const pruned = await evaluateCascadeEscalation({
      ...base({ transport: lowConfTransport }),
      cascade: {
        ...baseCascade,
        smokeMetrics: { latency_us_p50: 140 },
      },
    });
    assert.equal(pruned.action, 'prune');
    assert.equal(pruned.source, 'deterministic_fallback');
    assert.equal(pruned.fallbackReason, 'low_confidence');
    assert.equal(pruned.advisoryOnly, true);
    assert.equal(pruned.verificationCertified, false);
  });

  it('validates primaryMetric presence and remainingBudgetRatio bounds', async () => {
    await assert.rejects(
      () => evaluateCascadeEscalation({
        ...base(),
        cascade: { ...baseCascade, primaryMetric: 'missing_metric' },
      }),
      (err: unknown) => err instanceof DecisionError && err.code === 'DECISION_SCHEMA_INVALID',
    );
    await assert.rejects(
      () => evaluateCascadeEscalation({
        ...base(),
        cascade: { ...baseCascade, remainingBudgetRatio: 1.5 },
      }),
      (err: unknown) => err instanceof DecisionError && err.code === 'DECISION_SCHEMA_INVALID',
    );
  });
});
