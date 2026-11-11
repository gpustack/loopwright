import { evaluateDecision, type DecisionRequestBase } from './router.js';
import { DecisionError, DECISION_ALLOWED_AUTHORITY_INTENTS, DECISION_FORBIDDEN_AUTHORITY_INTENTS } from './types.js';
import type {
  DecisionCapabilityResult, DecisionCapabilityTier, DecisionCycleAlignmentResult, DecisionCyclePrecheckInput,
  DecisionCycleRoute, DecisionDiffSummary, DecisionDiffTriageEscalation, DecisionDiffTriageResult,
  DecisionDiffTriageRule, DecisionQuestion, DecisionSoftCompactionAdvisoryResult, DecisionSource,
  DecisionTaskMetadata,
} from './types.js';

/**
 * Non-delegable authority invariant (AC-4.1): only the five node intents are legal; any forbidden intent
 * or unknown intent fails closed with `DECISION_AUTHORITY_VIOLATION` and `authorityViolation: true`.
 */
export function assertDecisionAuthorityBoundary(intent: string): void {
  if (DECISION_ALLOWED_AUTHORITY_INTENTS.includes(intent)) return;
  const forbidden = DECISION_FORBIDDEN_AUTHORITY_INTENTS.includes(intent)
    ? `forbidden non-delegable authority intent "${intent}"`
    : `unknown decision intent "${intent}"`;
  throw new DecisionError('DECISION_AUTHORITY_VIOLATION', `${forbidden} must never be evaluated by the decision layer`, true);
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).map(token => token.replace(/s$/, '')).filter(token => token.length > 0));
}

function matchingSkills(candidateSkills: readonly string[], taskTokens: ReadonlySet<string>): readonly string[] {
  return candidateSkills.filter(skill => {
    for (const token of tokens(skill)) {
      if (taskTokens.has(token)) return true;
    }
    return false;
  });
}

function taskTokensOf(task: DecisionTaskMetadata): ReadonlySet<string> {
  return tokens(`${task.taskId} ${task.taskKind}`);
}

/** AC-4.2 deterministic heuristic tiering used whenever Jev is unavailable, weak, or overruled. */
export function heuristicCapabilityTier(task: DecisionTaskMetadata): DecisionCapabilityTier {
  if (task.requiresArchitectureChange || task.estimatedFilesCount > 20) return 'strongest';
  if (task.hasFailingTests || task.estimatedFilesCount > 5) return 'balanced';
  return 'fast';
}

/** Per REVIEW-001/REVIEW-002: the Jev share of a capability request is 1 tier choice + up to 99 skill checks. */
export const DECISION_CAPABILITY_JEV_SKILL_CHECKS = 99;

export interface DecisionRouteCapabilityRequest extends DecisionRequestBase {
  readonly task: DecisionTaskMetadata;
}

/**
 * Node 1 (AC-4.2): a pinned tier or role short-circuits with `userOverridePreserved: true` and zero
 * transport calls; otherwise one speculative request carries the capability-tier `choice` plus up to 99
 * skill checks, and any remaining candidate skills (up to 255) resolve by deterministic keyword matching.
 * Disabled, timed-out, and low/medium-confidence answers fall back to heuristic tiering and matching.
 */
export async function routeTaskCapability(request: DecisionRouteCapabilityRequest): Promise<DecisionCapabilityResult> {
  assertDecisionAuthorityBoundary('route_capability_tier');
  const task = request.task;
  const taskTokens = taskTokensOf(task);
  const remainderSkills = matchingSkills(task.candidateSkills.slice(DECISION_CAPABILITY_JEV_SKILL_CHECKS), taskTokens);
  if (task.pinnedCapabilityTier !== undefined || task.pinnedRole !== undefined) {
    return {
      tier: task.pinnedCapabilityTier ?? heuristicCapabilityTier(task),
      role: task.pinnedRole ?? null,
      skills: matchingSkills(task.candidateSkills, taskTokens),
      source: 'user_override',
      zone: null,
      fallbackReason: null,
      transportCalls: 0,
      userOverridePreserved: true,
    };
  }
  const jevSkills = task.candidateSkills.slice(0, DECISION_CAPABILITY_JEV_SKILL_CHECKS);
  const questions: readonly DecisionQuestion[] = [
    { type: 'choice', id: 'capability-tier', prompt: `Which capability tier suits task ${task.taskId} of kind ${task.taskKind}?`, options: { fast: 'Fast', balanced: 'Balanced', strongest: 'Strongest' } },
    ...jevSkills.map(skill => ({ type: 'noul' as const, id: `skill:${skill}`, prompt: `Does the ${skill} skill apply to this ${task.taskKind} task?` })),
  ];
  const evaluation = await evaluateDecision({ ...request, questions, fallback: () => null });
  const tierOutcome = evaluation.outcomes.find(outcome => outcome.output.id === 'capability-tier');
  const tierAnswer = tierOutcome?.output;
  const deterministicTier = heuristicCapabilityTier(task);
  if (evaluation.mode !== 'jev' || tierAnswer === undefined || tierAnswer.type !== 'choice' || tierAnswer.choice === null) {
    return {
      tier: deterministicTier,
      role: null,
      skills: matchingSkills(task.candidateSkills, taskTokens),
      source: evaluation.fallbackReason === null ? 'deterministic_heuristic' : 'deterministic_fallback',
      zone: evaluation.aggregateZone,
      fallbackReason: evaluation.fallbackReason,
      transportCalls: evaluation.transportCalls,
      userOverridePreserved: false,
    };
  }
  const affirmativeSkills = jevSkills.filter(skill => {
    const outcome = evaluation.outcomes.find(entry => entry.output.id === `skill:${skill}`);
    return outcome !== undefined && outcome.zone === 'high' && outcome.output.type === 'noul' && outcome.output.affirmative;
  });
  return {
    tier: tierAnswer.choice as DecisionCapabilityTier,
    role: null,
    skills: [...affirmativeSkills, ...remainderSkills],
    source: 'jev',
    zone: evaluation.aggregateZone,
    fallbackReason: null,
    transportCalls: evaluation.transportCalls,
    userOverridePreserved: false,
  };
}

export interface DecisionCycleAlignmentRequest extends DecisionRequestBase {
  readonly cycle: DecisionCyclePrecheckInput;
}

/** AC-4.3 deterministic pre-checks, run before any transport call. */
export function evaluateCyclePrechecks(cycle: DecisionCyclePrecheckInput): { readonly passed: boolean; readonly route: DecisionCycleRoute | null } {
  if (cycle.contractHash.hex !== cycle.expectedContractHash.hex) return { passed: false, route: 'blocked' };
  if (cycle.baseRevision !== cycle.expectedBaseRevision) return { passed: false, route: 'blocked' };
  if (cycle.leaseEpoch !== cycle.expectedLeaseEpoch || cycle.leaseExpired) return { passed: false, route: 'blocked' };
  if (cycle.writableScopeViolations.length > 0) return { passed: false, route: 'needs_review' };
  if (!(cycle.remainingBudgetUsd > 0) || !(cycle.remainingCycles > 0)) return { passed: false, route: 'needs_review' };
  if (cycle.contextUtilization >= 0.8 || cycle.failedVerificationLoops >= 2) return { passed: false, route: 'blocked' };
  return { passed: true, route: null };
}

/**
 * Node 2a (AC-4.3): the six deterministic pre-checks run first — any failure returns `blocked` (or
 * `needs_review` for scope/budget exhaustion) with `precheckPassed: false` and zero transport calls.
 * Only a fully green cycle may reach Jev for the continue/revise/needs_review/blocked alignment choice;
 * low confidence ties break deterministically to `continue`.
 */
export async function evaluateCycleAlignment(request: DecisionCycleAlignmentRequest): Promise<DecisionCycleAlignmentResult> {
  assertDecisionAuthorityBoundary('evaluate_cycle_alignment');
  const precheck = evaluateCyclePrechecks(request.cycle);
  if (!precheck.passed) {
    return {
      route: precheck.route as DecisionCycleRoute,
      precheckPassed: false,
      source: 'deterministic_heuristic',
      zone: null,
      fallbackReason: null,
      transportCalls: 0,
    };
  }
  const questions: readonly DecisionQuestion[] = [
    {
      type: 'choice', id: 'cycle-alignment', prompt: `Given green deterministic pre-checks, how should the cycle for ${request.cycle.baseRevision} proceed?`,
      options: { continue: 'Continue', revise: 'Revise', needs_review: 'Needs review', blocked: 'Block' },
    },
  ];
  const evaluation = await evaluateDecision({ ...request, questions, fallback: () => null });
  const answer = evaluation.outcomes.find(outcome => outcome.output.id === 'cycle-alignment')?.output;
  if (evaluation.mode !== 'jev' || answer === undefined || answer.type !== 'choice' || answer.choice === null) {
    return {
      route: 'continue',
      precheckPassed: true,
      source: evaluation.fallbackReason === null ? 'deterministic_heuristic' : 'deterministic_fallback',
      zone: evaluation.aggregateZone,
      fallbackReason: evaluation.fallbackReason,
      transportCalls: evaluation.transportCalls,
    };
  }
  return {
    route: answer.choice as DecisionCycleRoute,
    precheckPassed: true,
    source: 'jev',
    zone: evaluation.aggregateZone,
    fallbackReason: null,
    transportCalls: evaluation.transportCalls,
  };
}

export interface DecisionSoftCompactionRequest extends DecisionRequestBase {
  readonly compaction: { readonly contextUtilization: number; readonly failedVerificationLoops: number };
}

/**
 * Node 2b (AC-4.3): hard compaction triggers (`contextUtilization >= 0.80` or
 * `failedVerificationLoops >= 2`) force the `compact` advisory with `hardTriggerVetoRefused: true` and
 * zero transport calls; the soft zone (`0.60 <= utilization < 0.80`) may ask Jev for `compact` vs
 * `defer`, and the advisory feeds `CompactionPolicyInput.advisoryDecision` of `@loopwright/memory`.
 */
export async function evaluateSoftCompactionAdvisory(request: DecisionSoftCompactionRequest): Promise<DecisionSoftCompactionAdvisoryResult> {
  assertDecisionAuthorityBoundary('advise_soft_compaction');
  const { contextUtilization, failedVerificationLoops } = request.compaction;
  if (contextUtilization >= 0.8 || failedVerificationLoops >= 2) {
    return {
      advisoryDecision: 'compact',
      hardTriggerActive: true,
      hardTriggerVetoRefused: true,
      source: 'deterministic_heuristic',
      zone: null,
      fallbackReason: null,
      transportCalls: 0,
    };
  }
  if (contextUtilization < 0.6) {
    return {
      advisoryDecision: null,
      hardTriggerActive: false,
      hardTriggerVetoRefused: false,
      source: 'deterministic_heuristic',
      zone: null,
      fallbackReason: null,
      transportCalls: 0,
    };
  }
  const questions: readonly DecisionQuestion[] = [
    {
      type: 'choice', id: 'soft-compaction', prompt: `Context utilization is ${contextUtilization}. Should the next cycle compact first?`,
      options: { compact: 'Compact before the next cycle', defer: 'Defer compaction' },
    },
  ];
  const evaluation = await evaluateDecision({ ...request, questions, fallback: () => null });
  const answer = evaluation.outcomes.find(outcome => outcome.output.id === 'soft-compaction')?.output;
  if (evaluation.mode !== 'jev' || answer === undefined || answer.type !== 'choice' || answer.choice === null) {
    return {
      advisoryDecision: 'defer',
      hardTriggerActive: false,
      hardTriggerVetoRefused: false,
      source: evaluation.fallbackReason === null ? 'deterministic_heuristic' : 'deterministic_fallback',
      zone: evaluation.aggregateZone,
      fallbackReason: evaluation.fallbackReason,
      transportCalls: evaluation.transportCalls,
    };
  }
  return {
    advisoryDecision: answer.choice as 'compact' | 'defer',
    hardTriggerActive: false,
    hardTriggerVetoRefused: false,
    source: 'jev',
    zone: evaluation.aggregateZone,
    fallbackReason: null,
    transportCalls: evaluation.transportCalls,
  };
}

/** Shared three-level rubric for `score`-kind triage rules; thresholds apply to `normalizedScore`. */
const TRIAGE_SCORE_CRITERIA: readonly string[] = ['absent', 'partial', 'present'];

export interface DecisionDiffTriageRequest extends DecisionRequestBase {
  readonly diff: { readonly summary: DecisionDiffSummary; readonly rules: readonly DecisionDiffTriageRule[] };
}

function staticRuleMatches(rule: DecisionDiffTriageRule, summary: DecisionDiffSummary): boolean {
  const diffTokens = tokens(`${summary.changedFiles.join(' ')} ${summary.touchedPackages.join(' ')} ${summary.redactedHunkSummaries.join(' ')}`);
  for (const token of tokens(rule.description)) {
    if (diffTokens.has(token)) return true;
  }
  return false;
}

/**
 * Node 3 (AC-4.4): batches up to 100 atomic `noul`/`score` review rules into one request and escalates
 * rules whose calibrated signal meets `rule.threshold ?? policy.minConfidence`. Jev is never allowed to
 * certify the diff: `verificationCertified` stays `false` and every escalation is `advisoryOnly: true`
 * for downstream controller verification. Disabled, failing, or weak answers fall back to deterministic
 * static diff matching.
 */
export async function triageCandidateDiff(request: DecisionDiffTriageRequest): Promise<DecisionDiffTriageResult> {
  assertDecisionAuthorityBoundary('triage_candidate_diff');
  const { summary, rules } = request.diff;
  if (rules.length < 1 || rules.length > 100) {
    throw new DecisionError('DECISION_BATCH_SIZE_INVALID', 'diff triage rules must number between 1 and 100');
  }
  const questions: readonly DecisionQuestion[] = rules.map(rule => rule.kind === 'noul'
    ? { type: 'noul' as const, id: `rule:${rule.id}`, prompt: `${rule.description} (severity ${rule.severity})` }
    : { type: 'score' as const, id: `rule:${rule.id}`, prompt: `${rule.description} (severity ${rule.severity})`, criteria: TRIAGE_SCORE_CRITERIA });
  const evaluation = await evaluateDecision({ ...request, questions, fallback: () => null });
  const jevUsable = evaluation.mode === 'jev' || evaluation.mode === 'confirm';
  const escalations: DecisionDiffTriageEscalation[] = [];
  for (const rule of rules) {
    let escalate: boolean;
    let source: 'jev' | DecisionSource;
    const outcome = jevUsable ? evaluation.outcomes.find(entry => entry.output.id === `rule:${rule.id}`) : undefined;
    if (outcome !== undefined && outcome.zone === 'high') {
      if (outcome.output.type === 'noul') {
        escalate = outcome.output.affirmative && outcome.output.noul >= (rule.threshold ?? request.policy.minConfidence);
      } else if (outcome.output.type === 'score') {
        escalate = outcome.output.normalizedScore >= (rule.threshold ?? request.policy.minConfidence);
      } else {
        escalate = false;
      }
      source = 'jev';
    } else {
      escalate = staticRuleMatches(rule, summary);
      source = 'deterministic_heuristic';
    }
    if (escalate) {
      escalations.push({ ruleId: rule.id, severity: rule.severity, source, advisoryOnly: true });
    }
  }
  return {
    escalated: escalations,
    verificationCertified: false,
    source: jevUsable ? 'jev' : evaluation.source,
    zone: evaluation.aggregateZone,
    fallbackReason: jevUsable ? null : evaluation.fallbackReason,
    transportCalls: evaluation.transportCalls,
  };
}
