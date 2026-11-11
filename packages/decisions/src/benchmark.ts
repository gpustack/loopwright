import { DecisionBudgetTracker, type DecisionBudgetLedgerPort } from './client.js';
import { assertDecisionAuthorityBoundary, evaluateCycleAlignment, evaluateSoftCompactionAdvisory, routeTaskCapability, triageCandidateDiff } from './nodes.js';
import { validateDecisionPolicy } from './schema.js';
import { DecisionError, getProviderDialect } from './types.js';
import type {
  DecisionBenchmarkArm, DecisionBenchmarkArmSummary, DecisionBenchmarkCase, DecisionBenchmarkFixture,
  DecisionBenchmarkReport, DecisionPolicyConfig, DecisionProviderKind, DecisionQuestion, DecisionTransport,
  DecisionTransportRequest,
} from './types.js';

const FIXTURE_USAGE = { input_tokens: 100, output_tokens: 10 };

class DecisionFixtureError extends Error {}

/**
 * Fixed offline corpus (AC-5.1): capability routing, cycle alignment, soft compaction, diff triage,
 * timeout fallback, and an authority-boundary rejection. Each case is crafted so the deterministic
 * baseline and a correctly-calibrated Jev answer agree, and so the low-confidence arm must fall back to
 * that same deterministic outcome (the capability fallback fixture carries a StartLux-style
 * `noneProbability` at or above the `0.2` fallback threshold).
 */
export const DEFAULT_DECISION_BENCHMARK_CORPUS: readonly DecisionBenchmarkCase[] = Object.freeze([
  {
    id: 'capability.login-bugfix',
    kind: 'capability_routing',
    description: 'bug-fix login task routes to the balanced tier with the run-tests skill',
    task: {
      taskId: 'task.login-bugfix', taskKind: 'tests-bugfix', estimatedFilesCount: 3,
      hasFailingTests: true, requiresArchitectureChange: false,
      candidateSkills: ['run-tests', 'deploy-service', 'review-diff'],
    },
    expected: { tier: 'balanced', skills: ['run-tests'] },
    jevOnFixtures: {
      'capability-tier': { choice: 'balanced', confidence: 0.95 },
      'skill:run-tests': { noul: 0.95 },
      'skill:deploy-service': { noul: 0.05 },
      'skill:review-diff': { noul: 0.05 },
    },
    fallbackFixtures: {
      'capability-tier': { choice: 'fast', confidence: 0.95, noneProbability: 0.25 },
      'skill:run-tests': { noul: 0.95 },
      'skill:deploy-service': { noul: 0.05 },
      'skill:review-diff': { noul: 0.05 },
    },
  },
  {
    id: 'cycle.green-login',
    kind: 'cycle_alignment',
    description: 'a green cycle continues',
    cycle: {
      contractHash: { algorithm: 'sha256', hex: 'a'.repeat(64) },
      expectedContractHash: { algorithm: 'sha256', hex: 'a'.repeat(64) },
      baseRevision: 'b'.repeat(40), expectedBaseRevision: 'b'.repeat(40),
      leaseEpoch: 'epoch-1', expectedLeaseEpoch: 'epoch-1', leaseExpired: false,
      writableScopeViolations: [],
      remainingBudgetUsd: 5, remainingCycles: 3,
      contextUtilization: 0.42, failedVerificationLoops: 0,
    },
    expected: { route: 'continue' },
    jevOnFixtures: { 'cycle-alignment': { choice: 'continue', confidence: 0.95 } },
    fallbackFixtures: { 'cycle-alignment': { choice: 'blocked', confidence: 0.3 } },
  },
  {
    id: 'compaction.soft-login',
    kind: 'soft_compaction',
    description: 'soft-zone utilization defers compaction',
    compaction: { contextUtilization: 0.7, failedVerificationLoops: 0 },
    expected: { advisoryDecision: 'defer' },
    jevOnFixtures: { 'soft-compaction': { choice: 'defer', confidence: 0.95 } },
    fallbackFixtures: { 'soft-compaction': { choice: 'compact', confidence: 0.3 } },
  },
  {
    id: 'triage.auth-token',
    kind: 'diff_triage',
    description: 'auth token rule escalates deterministically and via calibrated jev',
    diff: {
      summary: {
        changedFiles: ['services/auth/login.ts'], addedLines: 40, deletedLines: 8,
        touchedPackages: ['services/auth'], redactedHunkSummaries: ['replaced session token validation in auth'],
      },
      rules: [
        { id: 'auth-token-rule', description: 'auth session token validation changed', severity: 'blocking', kind: 'noul', threshold: 0.8 },
        { id: 'docs-rule', description: 'unrelated frontend styling drift', severity: 'nit', kind: 'noul' },
      ],
    },
    expected: { escalatedRuleIds: ['auth-token-rule'] },
    jevOnFixtures: { 'rule:auth-token-rule': { noul: 0.95 }, 'rule:docs-rule': { noul: 0.05 } },
    fallbackFixtures: { 'rule:auth-token-rule': { noul: 0.3 }, 'rule:docs-rule': { noul: 0.3 } },
  },
  {
    id: 'timeout.login-bugfix',
    kind: 'timeout_fallback',
    description: 'a hung provider call falls back inside the hard deadline',
    task: {
      taskId: 'task.login-bugfix', taskKind: 'tests-bugfix', estimatedFilesCount: 3,
      hasFailingTests: true, requiresArchitectureChange: false,
      candidateSkills: ['run-tests'],
    },
    expected: { tier: 'balanced', skills: ['run-tests'] },
    jevOnFixtures: {
      'capability-tier': { choice: 'balanced', confidence: 0.95 },
      'skill:run-tests': { noul: 0.95 },
    },
    fallbackFixtures: {
      'capability-tier': { timeout: true },
      'skill:run-tests': { timeout: true },
    },
  },
  {
    id: 'authority.veto-hard-compaction',
    kind: 'authority_boundary',
    description: 'vetoing a hard compaction trigger is refused in every arm',
    forbiddenAuthorityIntent: 'veto_hard_compaction',
    expected: {},
    jevOnFixtures: {},
    fallbackFixtures: {},
  },
]);

export interface DecisionBenchmarkOptions {
  readonly corpus?: readonly DecisionBenchmarkCase[];
  readonly provider?: DecisionProviderKind;
  readonly policyOverrides?: Partial<DecisionPolicyConfig>;
  readonly apiKey?: string;
  readonly now?: () => number;
}

function fixtureAnswer(question: DecisionQuestion, fixture: DecisionBenchmarkFixture): Record<string, unknown> {
  if ('timeout' in fixture || 'httpStatus' in fixture) {
    throw new DecisionFixtureError(`fixture for ${question.id} is not an answer fixture`);
  }
  const confidence = fixture.confidence ?? 0.95;
  if (question.type === 'choice') {
    const keys = Object.keys(question.options);
    const choice = fixture.choice ?? keys[0] ?? 'none';
    const spread = (1 - confidence) / Math.max(1, keys.length - 1);
    const probabilities: Record<string, number> = {};
    for (const key of keys) probabilities[key] = key === choice ? confidence : spread;
    const answer: Record<string, unknown> = { choice, confidence, probabilities };
    if (fixture.noneProbability !== undefined) answer['none_probability'] = fixture.noneProbability;
    return answer;
  }
  if (question.type === 'score') {
    const count = question.criteria.length;
    const score = fixture.score ?? 1;
    const probabilities = question.criteria.map((_, index) => (index === score ? confidence : (1 - confidence) / Math.max(1, count - 1)));
    return { score, confidence, probabilities };
  }
  return { noul: fixture.noul ?? 0.95 };
}

function parseFixtureQuestions(payload: Record<string, unknown>, dialect: 'systemone' | 'openai-decisions'): readonly DecisionQuestion[] {
  if (dialect === 'openai-decisions') {
    const raw = Array.isArray(payload['questions']) ? payload['questions'] as Array<Record<string, unknown>> : [];
    return raw.map(entry => {
      const name = String(entry['name']);
      if (entry['type'] === 'choice') {
        const choices = Array.isArray(entry['choices']) ? entry['choices'] as string[] : [];
        return { type: 'choice' as const, id: name, prompt: String(entry['instructions'] ?? ''), options: Object.fromEntries(choices.map(key => [key, key])) };
      }
      if (entry['type'] === 'score') {
        const levels = Array.isArray(entry['levels']) ? entry['levels'] as Array<Record<string, unknown>> : [];
        return { type: 'score' as const, id: name, prompt: String(entry['instructions'] ?? ''), criteria: levels.map(level => String(level['description'])) };
      }
      return { type: 'noul' as const, id: name, prompt: String(entry['instructions'] ?? '') };
    });
  }
  const rawQuestions = payload['questions'];
  const raw = rawQuestions !== null && typeof rawQuestions === 'object' && !Array.isArray(rawQuestions)
    ? rawQuestions as Record<string, Record<string, unknown>>
    : {};
  return Object.keys(raw).map(id => {
    const entry = raw[id] ?? {};
    const instructions = String(entry['instructions'] ?? '');
    if (entry['type'] === 'choice') {
      const criteria = entry['criteria'];
      const options = criteria !== null && typeof criteria === 'object' && !Array.isArray(criteria)
        ? criteria as Record<string, string>
        : {};
      return { type: 'choice' as const, id, prompt: instructions, options };
    }
    if (entry['type'] === 'score') {
      const criteria = Array.isArray(entry['criteria']) ? entry['criteria'] as string[] : ['absent', 'partial', 'present'];
      return { type: 'score' as const, id, prompt: instructions, criteria };
    }
    return { type: 'noul' as const, id, prompt: instructions };
  });
}

function fixtureTransport(arm: DecisionBenchmarkArm, testCase: DecisionBenchmarkCase, provider: DecisionProviderKind): DecisionTransport {
  const dialect = getProviderDialect(provider);
  const fixtures = arm === 'jev_on' ? testCase.jevOnFixtures : testCase.fallbackFixtures;
  return {
    async send(request: DecisionTransportRequest) {
      const payload = JSON.parse(request.body) as Record<string, unknown>;
      const questions = parseFixtureQuestions(payload, dialect);
      for (const question of questions) {
        const fixture = fixtures[question.id];
        if (fixture === undefined) {
          throw new DecisionFixtureError(`missing fixture for ${question.id} in ${testCase.id} (${arm})`);
        }
        if ('timeout' in fixture) {
          return new Promise<never>(() => { /* hang until the client's deadline abort fires */ });
        }
        if ('httpStatus' in fixture) return { status: fixture.httpStatus, body: '' };
      }
      const answers: Record<string, unknown> = {};
      const listAnswers: Array<Record<string, unknown>> = [];
      for (const question of questions) {
        const fixture = fixtures[question.id];
        if (fixture === undefined) throw new DecisionFixtureError(`missing fixture for ${question.id} in ${testCase.id} (${arm})`);
        const answer = fixtureAnswer(question, fixture);
        answers[question.id] = answer;
        listAnswers.push({ name: question.id, ...answer });
      }
      const body = dialect === 'openai-decisions'
        ? { answers: listAnswers, usage: FIXTURE_USAGE }
        : { answers, usage: FIXTURE_USAGE };
      return { status: 200, body: JSON.stringify(body) };
    },
  };
}

function armPolicy(base: DecisionPolicyConfig, arm: DecisionBenchmarkArm): DecisionPolicyConfig {
  return validateDecisionPolicy({ ...base, enabled: arm !== 'jev_off' });
}

interface BenchmarkRequestBase {
  policy: DecisionPolicyConfig;
  state: unknown;
  transport: DecisionTransport;
  budget: DecisionBudgetLedgerPort;
  apiKey?: string;
}

function matchesCapability(testCase: DecisionBenchmarkCase, arm: DecisionBenchmarkArm, outcome: { source: string; fallbackReason: string | null; tier: string; skills: readonly string[] }): boolean {
  // The timeout case only asserts the deadline-supervised fallback shape in the low-confidence arm;
  // the other arms must answer normally under identical contracts.
  if (testCase.kind === 'timeout_fallback' && arm === 'low_confidence_fallback') {
    return outcome.source === 'deterministic_fallback' && outcome.fallbackReason === 'deadline_exceeded';
  }
  if (outcome.tier !== testCase.expected.tier) return false;
  return (testCase.expected.skills ?? []).every(skill => outcome.skills.includes(skill));
}

/**
 * Controlled offline A/B benchmark (AC-5.1, AC-5.2): runs the fixed corpus through the real decision
 * nodes under identical contracts and budgets across `jev_off`, `jev_on`, and `low_confidence_fallback`
 * arms with deterministic fixture transports, and returns per-arm metrics, pairwise deltas, and the
 * recommendation gate. No live network is involved in any arm.
 */
export async function runControlledDecisionBenchmark(options: DecisionBenchmarkOptions = {}): Promise<DecisionBenchmarkReport> {
  const corpus = options.corpus ?? DEFAULT_DECISION_BENCHMARK_CORPUS;
  const provider = options.provider ?? 'typesafe-jev';
  const basePolicy = validateDecisionPolicy({
    enabled: true, disclosurePolicy: 'repo-approved-redacted-evidence',
    hardDeadlineMs: options.policyOverrides?.hardDeadlineMs ?? 100,
    ...options.policyOverrides,
    provider,
  });
  const now = options.now ?? Date.now;
  const arms: DecisionBenchmarkArmSummary[] = [];
  for (const arm of ['jev_off', 'jev_on', 'low_confidence_fallback'] as const) {
    const policy = armPolicy(basePolicy, arm);
    const budget = new DecisionBudgetTracker();
    const startedAt = now();
    let passedCases = 0;
    let falsePositiveEscalations = 0;
    let falseNegativeMisses = 0;
    let authorityViolationCount = 0;
    let fallbackCount = 0;
    let decisionCases = 0;
    for (const testCase of corpus) {
      if (testCase.kind === 'authority_boundary') {
        let refused = false;
        try {
          assertDecisionAuthorityBoundary(testCase.forbiddenAuthorityIntent ?? 'veto_hard_compaction');
        } catch {
          refused = true;
        }
        if (refused) passedCases += 1;
        else authorityViolationCount += 1;
        continue;
      }
      decisionCases += 1;
      const transport = fixtureTransport(arm, testCase, provider);
      const requestBase: BenchmarkRequestBase = { policy, state: {}, transport, budget, apiKey: options.apiKey ?? 'loopwright-benchmark-fixture' };
      let resultSource = 'deterministic_fallback';
      if (testCase.kind === 'capability_routing' || testCase.kind === 'timeout_fallback') {
        const outcome = await routeTaskCapability({ ...requestBase, task: testCase.task as Parameters<typeof routeTaskCapability>[0]['task'] });
        resultSource = outcome.source;
        if (matchesCapability(testCase, arm, outcome)) passedCases += 1;
      } else if (testCase.kind === 'cycle_alignment') {
        const outcome = await evaluateCycleAlignment({ ...requestBase, cycle: testCase.cycle as Parameters<typeof evaluateCycleAlignment>[0]['cycle'] });
        resultSource = outcome.source;
        if (outcome.route === testCase.expected.route) passedCases += 1;
      } else if (testCase.kind === 'soft_compaction') {
        const outcome = await evaluateSoftCompactionAdvisory({ ...requestBase, compaction: testCase.compaction as Parameters<typeof evaluateSoftCompactionAdvisory>[0]['compaction'] });
        resultSource = outcome.source;
        if (outcome.advisoryDecision === testCase.expected.advisoryDecision) passedCases += 1;
      } else if (testCase.kind === 'diff_triage') {
        const outcome = await triageCandidateDiff({ ...requestBase, diff: testCase.diff as Parameters<typeof triageCandidateDiff>[0]['diff'] });
        resultSource = outcome.source;
        const escalatedIds = outcome.escalated.map(entry => entry.ruleId).sort();
        const expectedIds = [...(testCase.expected.escalatedRuleIds ?? [])].sort();
        falsePositiveEscalations += escalatedIds.filter(id => !expectedIds.includes(id)).length;
        falseNegativeMisses += expectedIds.filter(id => !escalatedIds.includes(id)).length;
        if (escalatedIds.length === expectedIds.length && escalatedIds.every((id, index) => id === expectedIds[index])) passedCases += 1;
      }
      if (resultSource === 'deterministic_fallback') fallbackCount += 1;
    }
    const snapshot = budget.snapshot();
    const totalCases = corpus.length;
    arms.push({
      arm,
      totalCases,
      passedCases,
      acceptancePassRate: totalCases === 0 ? 1 : passedCases / totalCases,
      falsePositiveEscalations,
      falseNegativeMisses,
      authorityViolationCount,
      fallbackCount,
      fallbackRate: decisionCases === 0 ? 0 : fallbackCount / decisionCases,
      totalInputTokens: snapshot.totalInputTokens,
      totalOutputTokens: snapshot.totalOutputTokens,
      unknownUsageCount: snapshot.unknownUsageCount,
      estimatedCostUsd: snapshot.estimatedCostUsd,
      wallTimeMs: now() - startedAt,
    });
  }
  const [jevOff, jevOn, lowConfidence] = arms;
  if (jevOff === undefined || jevOn === undefined || lowConfidence === undefined) {
    throw new DecisionError('DECISION_RESPONSE_INVALID', 'benchmark arms failed to execute');
  }
  const recommendation: DecisionBenchmarkReport['recommendation'] =
    jevOn.authorityViolationCount === 0 && lowConfidence.authorityViolationCount === 0
    && jevOn.acceptancePassRate >= jevOff.acceptancePassRate
      ? 'keep_optional_jev'
      : 'default_deterministic_only';
  return {
    evidenceScope: 'controlled_offline_fixture',
    arms: [jevOff, jevOn, lowConfidence],
    jevOnVsOffDelta: {
      acceptancePassRateDelta: jevOn.acceptancePassRate - jevOff.acceptancePassRate,
      falsePositiveDelta: jevOn.falsePositiveEscalations - jevOff.falsePositiveEscalations,
      falseNegativeDelta: jevOn.falseNegativeMisses - jevOff.falseNegativeMisses,
      estimatedCostUsdDelta: jevOn.estimatedCostUsd - jevOff.estimatedCostUsd,
    },
    recommendation,
  };
}
