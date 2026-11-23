import { evaluateDecision, type DecisionRequestBase } from './router.js';
import { isPlainObject } from './schema.js';
import {
  DECISION_ALLOWED_AUTHORITY_INTENTS,
  DECISION_CASCADE_DEFAULT_REGRESSION_TOLERANCE,
  DECISION_EVOLUTION_MAX_METRICS,
  DECISION_EVOLUTION_MAX_TRACKS,
  DECISION_FORBIDDEN_AUTHORITY_INTENTS,
  DECISION_NOVELTY_DEFAULT_SHINGLE_SIZE,
  DECISION_NOVELTY_DEFAULT_THRESHOLD,
  DECISION_NOVELTY_MAX_HISTORY_SLICES,
  DECISION_NOVELTY_MAX_SHINGLES,
  DECISION_NOVELTY_MAX_SLICE_BYTES,
  DecisionError,
} from './types.js';
import type {
  DecisionBoundPipeline, DecisionCapabilityResult, DecisionCapabilityTier, DecisionCascadeAction,
  DecisionCascadeEscalationInput, DecisionCascadeEscalationResult, DecisionCycleAlignmentResult,
  DecisionCyclePrecheckInput, DecisionCycleRoute, DecisionDiffSummary, DecisionDiffTriageEscalation,
  DecisionDiffTriageResult, DecisionDiffTriageRule, DecisionEvolutionMutationKind, DecisionEvolutionStrategyInput,
  DecisionEvolutionStrategyResult, DecisionHardwareDiagnostics, DecisionMutationNoveltyHistoryEntry,
  DecisionMutationNoveltyInput, DecisionMutationNoveltyResult, DecisionQuestion,
  DecisionSoftCompactionAdvisoryResult, DecisionSource, DecisionTaskMetadata,
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

// ---------------------------------------------------------------------------
// Evolutionary Inner-Loop Advisory Nodes (T3)
// ---------------------------------------------------------------------------

const FORBIDDEN_RECORD_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const BOUND_PIPELINES: ReadonlySet<DecisionBoundPipeline> = new Set([
  'hbm', 'l2', 'smem_lds_ub', 'tensor_cube', 'vector_valu', 'host_launch', 'comm', 'unknown',
]);

const MUTATION_KINDS: ReadonlySet<DecisionEvolutionMutationKind> = new Set([
  'diff_tune', 'full_rewrite', 'crossover',
]);

const CASCADE_ACTIONS: ReadonlySet<DecisionCascadeAction> = new Set([
  'prune', 'confirm', 'escalate',
]);

function failSchema(detail: string): never {
  throw new DecisionError('DECISION_SCHEMA_INVALID', detail);
}

function assertSafePlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) failSchema(`${label} must be a plain object`);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_RECORD_KEYS.has(key)) failSchema(`${label} contains forbidden key "${key}"`);
  }
  return value;
}

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertNonEmptyString(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== 'string' || hasLoneSurrogate(value) || value.trim().length === 0 || value.length > maxChars) {
    failSchema(`${label} must be a non-empty well-formed string of at most ${maxChars} characters`);
  }
  return value;
}

function assertFiniteNonNegZero(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0)) {
    failSchema(`${label} must be a finite number`);
  }
  return value;
}

function mergeDecisionState(baseState: unknown, key: string, payload: Record<string, unknown>): unknown {
  if (!isPlainObject(baseState)) return baseState;
  const merged = Object.create(null) as Record<string, unknown>;
  for (const existingKey of Object.keys(baseState)) {
    Object.defineProperty(merged, existingKey, {
      value: baseState[existingKey],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  Object.defineProperty(merged, key, {
    value: payload,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return merged;
}

/**
 * Normalize an `EVOLVE-BLOCK` source slice by stripping `//`, `/* ... *\/`, and `#` comments
 * (preserving string literals) and collapsing all whitespace to single spaces.
 */
export function normalizeEvolveBlockSource(source: string): string {
  let out = '';
  let i = 0;
  const len = source.length;
  while (i < len) {
    const ch = source.charAt(i);
    const next = i + 1 < len ? source.charAt(i + 1) : '';
    if (ch === '"' || ch === '\'') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < len) {
        const cur = source.charAt(i);
        out += cur;
        i += 1;
        if (cur === '\\' && i < len) {
          out += source.charAt(i);
          i += 1;
        } else if (cur === quote) {
          break;
        }
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < len && source.charAt(i) !== '\n') i += 1;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < len && !(source.charAt(i) === '*' && i + 1 < len && source.charAt(i + 1) === '/')) i += 1;
      i += 2;
      out += ' ';
      continue;
    }
    if (ch === '#') {
      i += 1;
      while (i < len && source.charAt(i) !== '\n') i += 1;
      out += ' ';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function tokenizeNormalizedSource(normalized: string): readonly string[] {
  const matched = normalized.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g);
  return matched === null ? [] : matched;
}

function buildTokenShingles(normalized: string, shingleSize: number): ReadonlySet<string> {
  const tokenList = tokenizeNormalizedSource(normalized);
  const shingles = new Set<string>();
  if (tokenList.length === 0) return shingles;
  if (tokenList.length <= shingleSize) {
    shingles.add(tokenList.join('\u001f'));
    return shingles;
  }
  const limit = tokenList.length - shingleSize + 1;
  for (let i = 0; i < limit && shingles.size < DECISION_NOVELTY_MAX_SHINGLES; i += 1) {
    shingles.add(tokenList.slice(i, i + shingleSize).join('\u001f'));
  }
  return shingles;
}

function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of smaller) {
    if (larger.has(item)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/** Deterministic whitespace/comment-normalized token-shingle Jaccard similarity in `[0, 1]`. */
export function computeTokenShingleJaccard(
  sourceA: string,
  sourceB: string,
  shingleSize: number = DECISION_NOVELTY_DEFAULT_SHINGLE_SIZE,
): number {
  if (!Number.isInteger(shingleSize) || shingleSize < 1 || shingleSize > 8) {
    failSchema('shingleSize must be an integer in [1, 8]');
  }
  const normA = normalizeEvolveBlockSource(sourceA);
  const normB = normalizeEvolveBlockSource(sourceB);
  return jaccardSimilarity(buildTokenShingles(normA, shingleSize), buildTokenShingles(normB, shingleSize));
}

function validateMutationNoveltyInput(raw: unknown): {
  readonly candidateId: string;
  readonly candidateSlice: string;
  readonly historySlices: readonly DecisionMutationNoveltyHistoryEntry[];
  readonly noveltyThreshold: number;
  readonly shingleSize: number;
} {
  const obj = assertSafePlainObject(raw, 'novelty');
  const candidateId = assertNonEmptyString(obj['candidateId'], 'novelty.candidateId', 128);
  const candidateSlice = obj['candidateSlice'];
  if (typeof candidateSlice !== 'string' || hasLoneSurrogate(candidateSlice)
    || Buffer.byteLength(candidateSlice, 'utf8') > DECISION_NOVELTY_MAX_SLICE_BYTES) {
    failSchema(`novelty.candidateSlice must be a well-formed string of at most ${DECISION_NOVELTY_MAX_SLICE_BYTES} UTF-8 bytes`);
  }
  const rawHistory = obj['historySlices'];
  if (!Array.isArray(rawHistory) || rawHistory.length > DECISION_NOVELTY_MAX_HISTORY_SLICES) {
    failSchema(`novelty.historySlices must be an array of at most ${DECISION_NOVELTY_MAX_HISTORY_SLICES} entries`);
  }
  const historySlices: DecisionMutationNoveltyHistoryEntry[] = rawHistory.map((entry, idx) => {
    const entryObj = assertSafePlainObject(entry, `novelty.historySlices[${idx}]`);
    const id = assertNonEmptyString(entryObj['id'], `novelty.historySlices[${idx}].id`, 128);
    const sourceSlice = entryObj['sourceSlice'];
    if (typeof sourceSlice !== 'string' || hasLoneSurrogate(sourceSlice)
      || Buffer.byteLength(sourceSlice, 'utf8') > DECISION_NOVELTY_MAX_SLICE_BYTES) {
      failSchema(`novelty.historySlices[${idx}].sourceSlice must be a well-formed string of at most ${DECISION_NOVELTY_MAX_SLICE_BYTES} UTF-8 bytes`);
    }
    return { id, sourceSlice };
  });
  const rawThreshold = obj['noveltyThreshold'] ?? DECISION_NOVELTY_DEFAULT_THRESHOLD;
  const noveltyThreshold = assertFiniteNonNegZero(rawThreshold, 'novelty.noveltyThreshold');
  if (noveltyThreshold <= 0 || noveltyThreshold > 1) {
    failSchema('novelty.noveltyThreshold must be a finite number in (0, 1]');
  }
  const rawShingleSize = obj['shingleSize'] ?? DECISION_NOVELTY_DEFAULT_SHINGLE_SIZE;
  const shingleSize = assertFiniteNonNegZero(rawShingleSize, 'novelty.shingleSize');
  if (!Number.isInteger(shingleSize) || shingleSize < 1 || shingleSize > 8) {
    failSchema('novelty.shingleSize must be an integer in [1, 8]');
  }
  return { candidateId, candidateSlice, historySlices, noveltyThreshold, shingleSize };
}

export interface DecisionMutationNoveltyRequest extends DecisionRequestBase {
  readonly novelty: DecisionMutationNoveltyInput;
}

/**
 * Advisory inner-loop mutation novelty filter:
 * 1. Normalizes `EVOLVE-BLOCK` slices and computes bounded token-shingle Jaccard similarity.
 * 2. Rejects exact normalized clones (`maxSimilarity === 1`) immediately with 0 transport calls.
 * 3. Accepts clearly novel candidates (`maxSimilarity < noveltyThreshold`) with 0 transport calls.
 * 4. Queries System-One (`noul`) in `[noveltyThreshold, 1)` under `disclosurePolicy` to catch cosmetic
 *    variable renames or constant-folding clones, falling back deterministically to `accept`.
 */
export async function evaluateMutationNovelty(
  request: DecisionMutationNoveltyRequest,
): Promise<DecisionMutationNoveltyResult> {
  assertDecisionAuthorityBoundary('advise_mutation_novelty');
  const validated = validateMutationNoveltyInput(request.novelty);
  const normalizedCandidate = normalizeEvolveBlockSource(validated.candidateSlice);
  const candidateShingles = buildTokenShingles(normalizedCandidate, validated.shingleSize);

  let maxSimilarity = 0;
  let matchedHistoryId: string | null = null;
  let matchedNormalized = '';
  for (const entry of validated.historySlices) {
    const normalizedHistory = normalizeEvolveBlockSource(entry.sourceSlice);
    const similarity = jaccardSimilarity(candidateShingles, buildTokenShingles(normalizedHistory, validated.shingleSize));
    if (matchedHistoryId === null || similarity > maxSimilarity) {
      maxSimilarity = similarity;
      matchedHistoryId = entry.id;
      matchedNormalized = normalizedHistory;
    }
    if (maxSimilarity === 1) break;
  }

  const noveltyScore = Math.max(0, Math.min(1, 1 - maxSimilarity));

  if (maxSimilarity === 1) {
    return {
      action: 'reject_resample',
      noveltyScore: 0,
      maxSimilarity: 1,
      matchedHistoryId,
      advisoryOnly: true,
      verificationCertified: false,
      source: 'deterministic_heuristic',
      zone: null,
      fallbackReason: null,
      transportCalls: 0,
    };
  }

  if (maxSimilarity < validated.noveltyThreshold) {
    return {
      action: 'accept',
      noveltyScore,
      maxSimilarity,
      matchedHistoryId,
      advisoryOnly: true,
      verificationCertified: false,
      source: 'deterministic_heuristic',
      zone: null,
      fallbackReason: null,
      transportCalls: 0,
    };
  }

  const questions: readonly DecisionQuestion[] = [
    {
      type: 'noul',
      id: 'mutation-cosmetic-clone',
      prompt: `Is candidate ${validated.candidateId} a cosmetic variable rename or constant-folding clone of ${matchedHistoryId ?? 'prior history'} (Jaccard ${maxSimilarity.toFixed(4)}) with no structural algorithmic change?`,
    },
  ];
  const state = mergeDecisionState(request.state, 'mutationNovelty', {
    candidateId: validated.candidateId,
    matchedHistoryId,
    maxSimilarity,
    normalizedCandidateSlice: normalizedCandidate.slice(0, 24_576),
    normalizedMatchedSlice: matchedNormalized.slice(0, 24_576),
  });
  const evaluation = await evaluateDecision({ ...request, state, questions, fallback: () => null });
  const outcome = evaluation.outcomes.find(entry => entry.output.id === 'mutation-cosmetic-clone');
  if (evaluation.mode === 'jev' && outcome !== undefined && outcome.output.type === 'noul') {
    return {
      action: outcome.output.affirmative ? 'reject_resample' : 'accept',
      noveltyScore,
      maxSimilarity,
      matchedHistoryId,
      advisoryOnly: true,
      verificationCertified: false,
      source: 'jev',
      zone: evaluation.aggregateZone,
      fallbackReason: null,
      transportCalls: evaluation.transportCalls,
    };
  }

  return {
    action: 'accept',
    noveltyScore,
    maxSimilarity,
    matchedHistoryId,
    advisoryOnly: true,
    verificationCertified: false,
    source: evaluation.fallbackReason === null ? 'deterministic_heuristic' : 'deterministic_fallback',
    zone: evaluation.aggregateZone,
    fallbackReason: evaluation.fallbackReason,
    transportCalls: evaluation.transportCalls,
  };
}

function validateHardwareDiagnostics(raw: unknown): DecisionHardwareDiagnostics {
  const obj = assertSafePlainObject(raw, 'strategy.hardwareDiagnostics');
  const boundPipeline = obj['boundPipeline'];
  if (typeof boundPipeline !== 'string' || !BOUND_PIPELINES.has(boundPipeline as DecisionBoundPipeline)) {
    failSchema('strategy.hardwareDiagnostics.boundPipeline must be a valid boundPipeline enum value');
  }
  const optionalNonNeg = ['rooflineHeadroom', 'arithmeticIntensity', 'registerCount', 'sharedMemBytes', 'localSpillBytes'] as const;
  const optionalPct = ['achievedSolPct', 'occupancyPct', 'l2HitPct', 'bankConflictPct'] as const;
  const result: Record<string, unknown> = { boundPipeline };
  for (const key of optionalNonNeg) {
    if (Object.hasOwn(obj, key) && obj[key] !== undefined) {
      const value = assertFiniteNonNegZero(obj[key], `strategy.hardwareDiagnostics.${key}`);
      if (value < 0) failSchema(`strategy.hardwareDiagnostics.${key} must be non-negative`);
      result[key] = value;
    }
  }
  for (const key of optionalPct) {
    if (Object.hasOwn(obj, key) && obj[key] !== undefined) {
      const value = assertFiniteNonNegZero(obj[key], `strategy.hardwareDiagnostics.${key}`);
      if (value < 0 || value > 100) failSchema(`strategy.hardwareDiagnostics.${key} must be in [0, 100]`);
      result[key] = value;
    }
  }
  return result as unknown as DecisionHardwareDiagnostics;
}

function validateEvolutionStrategyInput(raw: unknown): DecisionEvolutionStrategyInput {
  const obj = assertSafePlainObject(raw, 'strategy');
  const operatorKind = assertNonEmptyString(obj['operatorKind'], 'strategy.operatorKind', 128);
  const tensorRank = assertFiniteNonNegZero(obj['tensorRank'], 'strategy.tensorRank');
  if (!Number.isInteger(tensorRank) || tensorRank < 0 || tensorRank > 16) {
    failSchema('strategy.tensorRank must be an integer in [0, 16]');
  }
  const dtype = assertNonEmptyString(obj['dtype'], 'strategy.dtype', 64);
  if (obj['isReduction'] !== undefined && typeof obj['isReduction'] !== 'boolean') {
    failSchema('strategy.isReduction must be a boolean');
  }
  if (obj['isCausal'] !== undefined && typeof obj['isCausal'] !== 'boolean') {
    failSchema('strategy.isCausal must be a boolean');
  }
  const rawTracks = obj['declaredTracks'];
  if (!Array.isArray(rawTracks) || rawTracks.length < 1 || rawTracks.length > DECISION_EVOLUTION_MAX_TRACKS) {
    failSchema(`strategy.declaredTracks must declare between 1 and ${DECISION_EVOLUTION_MAX_TRACKS} tracks`);
  }
  const seenTracks = new Set<string>();
  const declaredTracks: string[] = rawTracks.map((entry, idx) => {
    const track = assertNonEmptyString(entry, `strategy.declaredTracks[${idx}]`, 128);
    if (seenTracks.has(track)) failSchema(`duplicate track "${track}" in strategy.declaredTracks`);
    seenTracks.add(track);
    return track;
  });
  const rawKinds = obj['allowedMutationKinds'];
  if (!Array.isArray(rawKinds) || rawKinds.length < 1 || rawKinds.length > 3) {
    failSchema('strategy.allowedMutationKinds must declare between 1 and 3 mutation kinds');
  }
  const seenKinds = new Set<string>();
  const allowedMutationKinds: DecisionEvolutionMutationKind[] = rawKinds.map((entry, idx) => {
    if (typeof entry !== 'string' || !MUTATION_KINDS.has(entry as DecisionEvolutionMutationKind)) {
      failSchema(`strategy.allowedMutationKinds[${idx}] must be diff_tune, full_rewrite, or crossover`);
    }
    if (seenKinds.has(entry)) failSchema(`duplicate mutation kind "${entry}" in strategy.allowedMutationKinds`);
    seenKinds.add(entry);
    return entry as DecisionEvolutionMutationKind;
  });
  let stalledGenerations: number | undefined;
  if (obj['stalledGenerations'] !== undefined) {
    const val = assertFiniteNonNegZero(obj['stalledGenerations'], 'strategy.stalledGenerations');
    if (!Number.isInteger(val) || val < 0 || val > 10_000) {
      failSchema('strategy.stalledGenerations must be an integer in [0, 10000]');
    }
    stalledGenerations = val;
  }
  const hardwareDiagnostics = obj['hardwareDiagnostics'] === undefined
    ? undefined
    : validateHardwareDiagnostics(obj['hardwareDiagnostics']);
  return {
    operatorKind,
    tensorRank,
    dtype,
    ...(obj['isReduction'] !== undefined ? { isReduction: obj['isReduction'] as boolean } : {}),
    ...(obj['isCausal'] !== undefined ? { isCausal: obj['isCausal'] as boolean } : {}),
    declaredTracks,
    allowedMutationKinds,
    ...(stalledGenerations !== undefined ? { stalledGenerations } : {}),
    ...(hardwareDiagnostics !== undefined ? { hardwareDiagnostics } : {}),
  };
}

function pickDeclaredTrack(declaredTracks: readonly string[], preferredSubstrings: readonly string[]): string {
  for (const hint of preferredSubstrings) {
    const match = declaredTracks.find(track => track.toLowerCase().includes(hint));
    if (match !== undefined) return match;
  }
  return declaredTracks[0] as string;
}

function pickAllowedMutation(
  allowed: readonly DecisionEvolutionMutationKind[],
  preferred: readonly DecisionEvolutionMutationKind[],
): DecisionEvolutionMutationKind {
  for (const kind of preferred) {
    if (allowed.includes(kind)) return kind;
  }
  return allowed[0] as DecisionEvolutionMutationKind;
}

/** Deterministic Roofline fallback for `routeEvolutionStrategy`, always selecting from declared tracks and mutation kinds. */
export function heuristicEvolutionStrategy(
  strategy: DecisionEvolutionStrategyInput,
): { readonly trackId: string; readonly mutationKind: DecisionEvolutionMutationKind } {
  const diag = strategy.hardwareDiagnostics;
  const bound = diag?.boundPipeline ?? 'unknown';
  const highSpills = (diag?.localSpillBytes ?? 0) > 0;
  const lowOccupancy = diag?.occupancyPct !== undefined && diag.occupancyPct < 35;
  const highHeadroom = diag?.rooflineHeadroom !== undefined && diag.rooflineHeadroom > 1.5;
  const stalled = (strategy.stalledGenerations ?? 0) >= 3;

  let mutationKind: DecisionEvolutionMutationKind;
  if (highSpills) {
    mutationKind = pickAllowedMutation(strategy.allowedMutationKinds, ['diff_tune', 'full_rewrite', 'crossover']);
  } else if (stalled) {
    mutationKind = pickAllowedMutation(strategy.allowedMutationKinds, ['full_rewrite', 'crossover', 'diff_tune']);
  } else if (bound === 'smem_lds_ub' || bound === 'hbm') {
    mutationKind = lowOccupancy || highHeadroom
      ? pickAllowedMutation(strategy.allowedMutationKinds, ['full_rewrite', 'crossover', 'diff_tune'])
      : pickAllowedMutation(strategy.allowedMutationKinds, ['diff_tune', 'full_rewrite', 'crossover']);
  } else if (bound === 'tensor_cube' || bound === 'vector_valu') {
    const tightHeadroom = diag?.rooflineHeadroom !== undefined && diag.rooflineHeadroom <= 1.15;
    mutationKind = tightHeadroom
      ? pickAllowedMutation(strategy.allowedMutationKinds, ['diff_tune', 'crossover', 'full_rewrite'])
      : pickAllowedMutation(strategy.allowedMutationKinds, ['crossover', 'diff_tune', 'full_rewrite']);
  } else {
    mutationKind = pickAllowedMutation(strategy.allowedMutationKinds, ['diff_tune', 'crossover', 'full_rewrite']);
  }

  let trackId: string;
  if (highSpills || bound === 'smem_lds_ub' || bound === 'hbm' || lowOccupancy) {
    trackId = pickDeclaredTrack(strategy.declaredTracks, ['cute', 'cuda_raw', 'ascend_tile', 'ascend_regbase', 'triton', 'ascend_simt']);
  } else if (bound === 'tensor_cube') {
    trackId = pickDeclaredTrack(strategy.declaredTracks, ['cute', 'ascend_tile', 'triton', 'cuda_raw', 'ascend_regbase']);
  } else if (bound === 'vector_valu' || strategy.isReduction === true) {
    trackId = pickDeclaredTrack(strategy.declaredTracks, ['triton', 'ascend_simt', 'ascend_regbase', 'cuda_raw', 'cute']);
  } else {
    trackId = strategy.declaredTracks[0] as string;
  }

  return { trackId, mutationKind };
}

export interface DecisionRouteEvolutionStrategyRequest extends DecisionRequestBase {
  readonly strategy: DecisionEvolutionStrategyInput;
}

/**
 * Advisory strategy track router: chooses `{ trackId, mutationKind }` strictly from the campaign's
 * declared track and mutation sets, falling back to deterministic Roofline rules when System-One is
 * disabled, offline, disclosure-blocked, low-confidence, or returns an undeclared option.
 */
export async function routeEvolutionStrategy(
  request: DecisionRouteEvolutionStrategyRequest,
): Promise<DecisionEvolutionStrategyResult> {
  assertDecisionAuthorityBoundary('route_evolution_strategy');
  const validated = validateEvolutionStrategyInput(request.strategy);
  const trackOptions: Record<string, string> = {};
  for (const track of validated.declaredTracks) trackOptions[track] = `Use declared evolution track ${track}`;
  const mutationOptions: Record<string, string> = {};
  for (const kind of validated.allowedMutationKinds) mutationOptions[kind] = `Apply ${kind} mutation`;

  const questions: readonly DecisionQuestion[] = [
    {
      type: 'choice',
      id: 'evolution-track',
      prompt: `Select the best declared evolution track for ${validated.operatorKind} (rank ${validated.tensorRank}, ${validated.dtype}).`,
      options: trackOptions,
    },
    {
      type: 'choice',
      id: 'evolution-mutation-kind',
      prompt: `Select the best allowed mutation kind for ${validated.operatorKind} given current hardware diagnostics.`,
      options: mutationOptions,
    },
  ];
  const state = mergeDecisionState(request.state, 'evolutionStrategy', {
    operatorKind: validated.operatorKind,
    tensorRank: validated.tensorRank,
    dtype: validated.dtype,
    isReduction: validated.isReduction ?? false,
    isCausal: validated.isCausal ?? false,
    declaredTracks: validated.declaredTracks,
    allowedMutationKinds: validated.allowedMutationKinds,
    ...(validated.stalledGenerations !== undefined ? { stalledGenerations: validated.stalledGenerations } : {}),
    ...(validated.hardwareDiagnostics !== undefined ? { hardwareDiagnostics: validated.hardwareDiagnostics } : {}),
  });

  const evaluation = await evaluateDecision({ ...request, state, questions, fallback: () => null });
  const trackAnswer = evaluation.outcomes.find(entry => entry.output.id === 'evolution-track')?.output;
  const mutationAnswer = evaluation.outcomes.find(entry => entry.output.id === 'evolution-mutation-kind')?.output;

  const validJevTrack = trackAnswer !== undefined
    && trackAnswer.type === 'choice'
    && trackAnswer.choice !== null
    && validated.declaredTracks.includes(trackAnswer.choice);
  const validJevMutation = mutationAnswer !== undefined
    && mutationAnswer.type === 'choice'
    && mutationAnswer.choice !== null
    && validated.allowedMutationKinds.includes(mutationAnswer.choice as DecisionEvolutionMutationKind);

  if (evaluation.mode === 'jev' && validJevTrack && validJevMutation) {
    return {
      trackId: trackAnswer.choice as string,
      mutationKind: mutationAnswer.choice as DecisionEvolutionMutationKind,
      advisoryOnly: true,
      verificationCertified: false,
      source: 'jev',
      zone: evaluation.aggregateZone,
      fallbackReason: null,
      transportCalls: evaluation.transportCalls,
    };
  }

  const fallback = heuristicEvolutionStrategy(validated);
  return {
    trackId: fallback.trackId,
    mutationKind: fallback.mutationKind,
    advisoryOnly: true,
    verificationCertified: false,
    source: evaluation.fallbackReason === null && evaluation.mode !== 'jev' ? 'deterministic_heuristic' : 'deterministic_fallback',
    zone: evaluation.aggregateZone,
    fallbackReason: evaluation.fallbackReason ?? (evaluation.mode === 'jev' ? 'invalid_response' : 'low_confidence'),
    transportCalls: evaluation.transportCalls,
  };
}

function validateMetricsMap(raw: unknown, label: string, minKeys: number): Readonly<Record<string, number>> {
  const obj = assertSafePlainObject(raw, label);
  const keys = Object.keys(obj);
  if (keys.length < minKeys || keys.length > DECISION_EVOLUTION_MAX_METRICS) {
    failSchema(`${label} must have between ${minKeys} and ${DECISION_EVOLUTION_MAX_METRICS} numeric entries`);
  }
  const normalized: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const key of keys) {
    assertNonEmptyString(key, `${label} key`, 128);
    normalized[key] = assertFiniteNonNegZero(obj[key], `${label}.${key}`);
  }
  return normalized;
}

function validateCascadeEscalationInput(raw: unknown): DecisionCascadeEscalationInput {
  const obj = assertSafePlainObject(raw, 'cascade');
  const candidateId = assertNonEmptyString(obj['candidateId'], 'cascade.candidateId', 128);
  if (typeof obj['smokeCorrectnessPassed'] !== 'boolean') {
    failSchema('cascade.smokeCorrectnessPassed must be a boolean');
  }
  const smokeMetrics = validateMetricsMap(obj['smokeMetrics'], 'cascade.smokeMetrics', 1);
  const referenceMetrics = validateMetricsMap(obj['referenceMetrics'], 'cascade.referenceMetrics', 0);
  const primaryMetric = assertNonEmptyString(obj['primaryMetric'], 'cascade.primaryMetric', 128);
  if (!Object.hasOwn(smokeMetrics, primaryMetric)) {
    failSchema(`cascade.primaryMetric "${primaryMetric}" must exist in cascade.smokeMetrics`);
  }
  const direction = obj['direction'];
  if (direction !== 'minimize' && direction !== 'maximize') {
    failSchema('cascade.direction must be minimize or maximize');
  }
  const remainingBudgetRatio = assertFiniteNonNegZero(obj['remainingBudgetRatio'], 'cascade.remainingBudgetRatio');
  if (remainingBudgetRatio < 0 || remainingBudgetRatio > 1) {
    failSchema('cascade.remainingBudgetRatio must be in [0, 1]');
  }
  let regressionToleranceRatio: number | undefined;
  if (obj['regressionToleranceRatio'] !== undefined) {
    const tol = assertFiniteNonNegZero(obj['regressionToleranceRatio'], 'cascade.regressionToleranceRatio');
    if (tol < 0 || tol > 1) failSchema('cascade.regressionToleranceRatio must be in [0, 1]');
    regressionToleranceRatio = tol;
  }
  return {
    candidateId,
    smokeCorrectnessPassed: obj['smokeCorrectnessPassed'] as boolean,
    smokeMetrics,
    referenceMetrics,
    primaryMetric,
    direction,
    remainingBudgetRatio,
    ...(regressionToleranceRatio !== undefined ? { regressionToleranceRatio } : {}),
  };
}

/** Deterministic fallback for `evaluateCascadeEscalation`. */
export function heuristicCascadeEscalation(cascade: DecisionCascadeEscalationInput): DecisionCascadeAction {
  if (!cascade.smokeCorrectnessPassed) return 'prune';
  const smokeVal = cascade.smokeMetrics[cascade.primaryMetric];
  const refVal = cascade.referenceMetrics[cascade.primaryMetric];
  if (smokeVal === undefined) return 'prune';
  if (refVal === undefined || refVal === 0) {
    return cascade.remainingBudgetRatio > 0.2 ? 'escalate' : 'confirm';
  }
  const gain = cascade.direction === 'minimize'
    ? (refVal - smokeVal) / Math.abs(refVal)
    : (smokeVal - refVal) / Math.abs(refVal);
  if (gain > 0) return 'escalate';
  const tolerance = cascade.regressionToleranceRatio ?? DECISION_CASCADE_DEFAULT_REGRESSION_TOLERANCE;
  if (gain >= -tolerance && cascade.remainingBudgetRatio >= 0.25) return 'confirm';
  return 'prune';
}

export interface DecisionCascadeEscalationRequest extends DecisionRequestBase {
  readonly cascade: DecisionCascadeEscalationInput;
}

/**
 * Advisory cascade escalation filter: if smoke correctness failed, deterministically returns `'prune'`
 * with 0 transport calls. Otherwise queries System-One for `'prune' | 'confirm' | 'escalate'` to the
 * full multi-bucket benchmark gate, never certifying verification (`verificationCertified: false`).
 */
export async function evaluateCascadeEscalation(
  request: DecisionCascadeEscalationRequest,
): Promise<DecisionCascadeEscalationResult> {
  assertDecisionAuthorityBoundary('advise_cascade_escalation');
  const validated = validateCascadeEscalationInput(request.cascade);
  if (!validated.smokeCorrectnessPassed) {
    return {
      action: 'prune',
      smokeCorrectnessPassed: false,
      advisoryOnly: true,
      verificationCertified: false,
      source: 'deterministic_heuristic',
      zone: null,
      fallbackReason: null,
      transportCalls: 0,
    };
  }

  const questions: readonly DecisionQuestion[] = [
    {
      type: 'choice',
      id: 'cascade-escalation',
      prompt: `Smoke correctness passed for ${validated.candidateId} (primary metric ${validated.primaryMetric}, ${validated.direction}). Should this candidate prune, confirm, or escalate to full benchmark verification?`,
      options: {
        prune: 'Prune candidate before full benchmark gate',
        confirm: 'Run a confirmation check before full escalation',
        escalate: 'Escalate candidate to full multi-bucket benchmark gate',
      },
    },
  ];
  const state = mergeDecisionState(request.state, 'cascadeEscalation', {
    candidateId: validated.candidateId,
    smokeCorrectnessPassed: true,
    smokeMetrics: { ...validated.smokeMetrics },
    referenceMetrics: { ...validated.referenceMetrics },
    primaryMetric: validated.primaryMetric,
    direction: validated.direction,
    remainingBudgetRatio: validated.remainingBudgetRatio,
  });

  const evaluation = await evaluateDecision({ ...request, state, questions, fallback: () => null });
  const answer = evaluation.outcomes.find(entry => entry.output.id === 'cascade-escalation')?.output;
  if (
    evaluation.mode === 'jev'
    && answer !== undefined
    && answer.type === 'choice'
    && answer.choice !== null
    && CASCADE_ACTIONS.has(answer.choice as DecisionCascadeAction)
  ) {
    return {
      action: answer.choice as DecisionCascadeAction,
      smokeCorrectnessPassed: true,
      advisoryOnly: true,
      verificationCertified: false,
      source: 'jev',
      zone: evaluation.aggregateZone,
      fallbackReason: null,
      transportCalls: evaluation.transportCalls,
    };
  }

  return {
    action: heuristicCascadeEscalation(validated),
    smokeCorrectnessPassed: true,
    advisoryOnly: true,
    verificationCertified: false,
    source: evaluation.fallbackReason === null && evaluation.mode !== 'jev' ? 'deterministic_heuristic' : 'deterministic_fallback',
    zone: evaluation.aggregateZone,
    fallbackReason: evaluation.fallbackReason ?? (evaluation.mode === 'jev' ? 'invalid_response' : 'low_confidence'),
    transportCalls: evaluation.transportCalls,
  };
}
