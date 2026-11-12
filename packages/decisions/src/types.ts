import type { Digest } from '@loopwright/core';

/** Error codes for every fail-closed decision-layer refusal, per the spec's error taxonomy. */
export type DecisionErrorCode =
  | 'DECISION_POLICY_INVALID'
  | 'DECISION_DISCLOSURE_VIOLATION'
  | 'DECISION_STATE_TOO_LARGE'
  | 'DECISION_BATCH_SIZE_INVALID'
  | 'DECISION_PRIMITIVE_UNSUPPORTED'
  | 'DECISION_SCHEMA_INVALID'
  | 'DECISION_RESPONSE_INVALID'
  | 'DECISION_DEADLINE_EXCEEDED'
  | 'DECISION_TRANSPORT_ERROR'
  | 'DECISION_BUDGET_EXCEEDED'
  | 'DECISION_AUTHORITY_VIOLATION';

/** Fail-closed decision-layer error; `authorityViolation` is true only for authority refusals. */
export class DecisionError extends Error {
  readonly code: DecisionErrorCode;
  readonly authorityViolation: boolean;

  constructor(code: DecisionErrorCode, message: string, authorityViolation = false) {
    super(message);
    this.name = 'DecisionError';
    this.code = code;
    this.authorityViolation = authorityViolation;
  }
}

export type DecisionDisclosurePolicy = 'disabled' | 'repo-approved-redacted-evidence' | 'public-metadata-only';
export type DecisionFallbackUnavailableAction = 'blocked' | 'deterministic_default';

/** First-class System-One Decisions API provider profiles behind one canonical question domain (REVIEW-004). */
export type DecisionProviderKind =
  | 'typesafe-jev'
  | 'openai-decisions'
  | 'startlux-decision'
  | 'microsoft-decision'
  | 'perplexity-decider'
  | 'cloudflare-clef'
  | 'liquid-d1';

/** Wire protocol families: keyed map questions/answers (`systemone`) vs positional arrays (`openai-decisions`). */
export type DecisionWireDialect = 'systemone' | 'openai-decisions';

export function getProviderDialect(provider: DecisionProviderKind): DecisionWireDialect {
  return provider === 'openai-decisions' ? 'openai-decisions' : 'systemone';
}

export interface DecisionStartluxOptions {
  readonly thinkMode?: 'instant' | 'auto';
  readonly thinkBudget?: number;
  readonly gate?: number;
  readonly allowNone?: boolean;
  readonly noneCheck?: boolean;
  readonly noneProbabilityThreshold?: number;
}

/** Per-provider default endpoints, models, and API-key environment variable names (primary first). */
export const DECISION_PROVIDER_DEFAULTS: Readonly<Record<DecisionProviderKind, { readonly endpoint: string; readonly model: string }>> = Object.freeze({
  'typesafe-jev': { endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest' },
  'openai-decisions': { endpoint: 'https://api.openai.com/v1/decisions', model: 'gpt-6-luna' },
  'startlux-decision': { endpoint: 'https://api.bamboonode.dev/v1/systemone', model: 'startlux-decision-27b-autothink' },
  'microsoft-decision': { endpoint: 'https://models.inference.ai.azure.com/v1/systemone', model: 'microsoft-decision-1' },
  'perplexity-decider': { endpoint: 'https://api.perplexity.ai/v1/decisions', model: 'pplx-decider-v1.2' },
  'cloudflare-clef': { endpoint: 'https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/run/@cf/cloudflare/clef', model: '@cf/cloudflare/clef' },
  'liquid-d1': { endpoint: 'https://api.liquid.ai/decisions/v1/systemone', model: 'liquid/d1-ultra' },
});

export const DECISION_PROVIDER_API_KEY_ENV: Readonly<Record<DecisionProviderKind, readonly string[]>> = Object.freeze({
  'typesafe-jev': Object.freeze(['TYPESAFE_API_KEY']),
  'openai-decisions': Object.freeze(['OPENAI_API_KEY']),
  'startlux-decision': Object.freeze(['STARTLUX_API_KEY']),
  'microsoft-decision': Object.freeze(['MICROSOFT_DECISION_API_KEY', 'AZURE_API_KEY']),
  'perplexity-decider': Object.freeze(['PERPLEXITY_API_KEY']),
  'cloudflare-clef': Object.freeze(['CLOUDFLARE_API_TOKEN']),
  'liquid-d1': Object.freeze(['LIQUID_API_KEY']),
});

/** Repository operator's opt-in policy for System-One decision routing. */
export interface DecisionPolicyConfig {
  readonly enabled: boolean;
  readonly disclosurePolicy: DecisionDisclosurePolicy;
  readonly minConfidence: number;
  readonly confirmThreshold: number;
  readonly hardDeadlineMs: number;
  readonly maxAttempts: 1 | 2;
  readonly fallbackRole: string | null;
  readonly onFallbackUnavailable: DecisionFallbackUnavailableAction;
  readonly provider: DecisionProviderKind;
  readonly endpoint: string;
  readonly model: string;
  readonly startluxOptions: DecisionStartluxOptions | null;
  readonly allowImages: boolean;
}

export const DEFAULT_DECISION_POLICY: DecisionPolicyConfig = Object.freeze({
  enabled: false,
  disclosurePolicy: 'disabled',
  minConfidence: 0.8,
  confirmThreshold: 0.6,
  hardDeadlineMs: 5000,
  maxAttempts: 1,
  fallbackRole: 'deterministic',
  onFallbackUnavailable: 'blocked',
  provider: 'typesafe-jev',
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  model: 'jev-latest',
  startluxOptions: null,
  allowImages: false,
});

export const DECISION_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const DECISION_POLICY_DOCUMENT_API_VERSION = 'loopwright.dev/v1alpha1' as const;
export const DECISION_POLICY_MAX_BYTES = 65_536;
export const DECISION_MAX_QUESTIONS = 100;
export const DECISION_MAX_OPTIONS = 255;
export const DECISION_MIN_CRITERIA = 2;
export const DECISION_MAX_CRITERIA = 10;
export const DECISION_MAX_STATE_DEPTH = 16;
export const DECISION_MAX_STATE_BYTES = 65_536;
export const DECISION_MAX_PUBLIC_METADATA_CHARS = 512;
export const DECISION_INPUT_COST_PER_MTOK_USD = 0.042;
export const DECISION_OUTPUT_COST_PER_MTOK_USD = 0;
export const DECISION_MAX_IMAGE_BASE64_CHARS = 6_777_216; // ~5 MiB decoded per asset
export const DECISION_MAX_IMAGES = 8;
export const DECISION_IMAGE_MEDIA_TYPES: readonly string[] = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);

/** Redacted image input for multimodal decisions; only usable under `allowImages` with approved disclosure. */
export interface DecisionImageAsset {
  readonly id: string;
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  readonly data: string;
}

/** Structured question for the `choice` primitive; options are normalized to key-to-description records. */
export interface DecisionChoiceQuestion {
  readonly type: 'choice';
  readonly id: string;
  readonly prompt: string;
  readonly options: Readonly<Record<string, string>>;
  readonly allowNone?: boolean;
}

/** Structured question for the `score` primitive; criteria run lowest (0) to highest (n - 1). */
export interface DecisionScoreQuestion {
  readonly type: 'score';
  readonly id: string;
  readonly prompt: string;
  readonly criteria: readonly string[];
}

/** Structured binary question for the `noul` primitive (`predicate` is accepted as an input alias);
 * `threshold` defaults to `policy.minConfidence`. */
export interface DecisionNoulQuestion {
  readonly type: 'noul';
  readonly id: string;
  readonly prompt: string;
  readonly threshold?: number;
}

/** Structured bounding-box question; only valid under `allowImages` with a box-capable provider. */
export interface DecisionBoxQuestion {
  readonly type: 'box';
  readonly id: string;
  readonly prompt: string;
}

export type DecisionQuestion = DecisionChoiceQuestion | DecisionScoreQuestion | DecisionNoulQuestion | DecisionBoxQuestion;

/** Provider usage report (snake_case mirrors the wire payload). */
export interface DecisionProviderUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

/** Validated provider answer for a `choice` question; `choice: null` or a high `noneProbability` routes low. */
export interface DecisionChoiceOutput {
  readonly type: 'choice';
  readonly id: string;
  readonly choice: string | null;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly noneProbability?: number;
}

/** Validated provider answer for a `score` question. */
export interface DecisionScoreOutput {
  readonly type: 'score';
  readonly id: string;
  readonly score: number;
  readonly normalizedScore: number;
  readonly confidence: number;
  readonly probabilities: readonly number[];
}

/** Validated provider answer for a `noul` question with derived confidence and affirmative boolean. */
export interface DecisionNoulOutput {
  readonly type: 'noul';
  readonly id: string;
  readonly noul: number;
  readonly confidence: number;
  readonly threshold: number;
  readonly affirmative: boolean;
}

export interface DecisionBoxCoordinates {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

/** Validated provider answer for a `box` question with bounded [0, 1] coordinates. */
export interface DecisionBoxOutput {
  readonly type: 'box';
  readonly id: string;
  readonly box: DecisionBoxCoordinates;
  readonly confidence: number;
}

export type DecisionQuestionOutput = DecisionChoiceOutput | DecisionScoreOutput | DecisionNoulOutput | DecisionBoxOutput;

export type DecisionConfidenceZone = 'high' | 'medium' | 'low';
export type DecisionZoneAction = 'accept_jev' | 'confirm_or_fallback' | 'fallback';

/** Where an accepted decision came from; heuristic results are computed without any transport call. */
export type DecisionSource = 'jev' | 'deterministic_fallback' | 'deterministic_heuristic' | 'user_override';

export type DecisionFallbackReason =
  | 'policy_disabled'
  | 'deadline_exceeded'
  | 'transport_error'
  | 'budget_exceeded'
  | 'invalid_state'
  | 'disclosure_violation'
  | 'invalid_response'
  | 'unsupported_primitive'
  | 'low_confidence'
  | null;

export type DecisionMode = 'disabled' | 'jev' | 'confirm' | 'fallback';

export interface DecisionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** One validated question answer plus its 3-zone classification. */
export interface DecisionQuestionOutcome {
  readonly question: DecisionQuestion;
  readonly output: DecisionQuestionOutput;
  readonly zone: DecisionConfidenceZone;
  readonly action: DecisionZoneAction;
}

/** Result of `evaluateDecision`: validated outcomes with the aggregate 3-zone routing decision. */
export interface DecisionEvaluation {
  readonly mode: DecisionMode;
  readonly source: DecisionSource;
  readonly aggregateZone: DecisionConfidenceZone | null;
  readonly aggregateAction: DecisionZoneAction | null;
  readonly outcomes: readonly DecisionQuestionOutcome[];
  readonly fallbackReason: DecisionFallbackReason;
  readonly transportCalls: number;
  readonly usage: DecisionUsage | null;
}

/** One speculative fan-out branch: a question plus its optional activation dependency. */
export interface DecisionFanOutBranch {
  readonly branchId: string;
  readonly question: DecisionQuestion;
  readonly dependsOn: { readonly questionId: string; readonly value: string } | null;
}

/** Result of `evaluateSpeculativeFanOut`: active-path outcomes plus pruned-branch bookkeeping. */
export interface DecisionFanOutEvaluation extends DecisionEvaluation {
  readonly totalQuestions: number;
  readonly evaluatedBranchIds: readonly string[];
  readonly ignoredBranchIds: readonly string[];
}

/** Pluggable transport request; `apiKey` is resolved and non-empty when the client dispatches. `headers`
 * carries provider danger-zone flags such as `TypeSafe-Danger-Zone-Images: true`. */
export interface DecisionTransportRequest {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly body: string;
  readonly signal: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface DecisionTransportResponse {
  readonly status: number;
  readonly body: string;
}

export interface DecisionTransport {
  send(request: DecisionTransportRequest): Promise<DecisionTransportResponse>;
}

export interface DecisionClientOptions {
  readonly policy: DecisionPolicyConfig;
  readonly transport?: DecisionTransport;
  readonly sdkAdapter?: DecisionSdkAdapter;
  readonly apiKey?: string;
  readonly endpoint?: string;
  readonly now?: () => number;
}

/** Structured request handed to an in-process provider SDK adapter (REVIEW-004). */
export interface DecisionSdkRequest {
  readonly provider: DecisionProviderKind;
  readonly dialect: DecisionWireDialect;
  readonly model: string;
  readonly endpoint: string;
  readonly state: Record<string, unknown>;
  readonly questions: readonly DecisionQuestion[];
  readonly images?: readonly DecisionImageAsset[];
  readonly wirePayload: Record<string, unknown>;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

/** In-process bridge to an official provider SDK (`@typesafe-ai/sdk`, Vercel `experimental_decide`, `env.AI.run`, ...). */
export interface DecisionSdkAdapter {
  evaluate(request: DecisionSdkRequest): Promise<unknown>;
}

export interface DecisionBudgetOptions {
  readonly inputCostPerMtokUsd?: number;
  readonly outputCostPerMtokUsd?: number;
  readonly maxInputTokens?: number;
  readonly maxCostUsd?: number;
}

export interface DecisionBudgetSnapshot {
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly unknownUsageCount: number;
  readonly unknownUsageRetained: boolean;
  readonly estimatedCostUsd: number;
}

/** Non-delegable authority intents that the decision layer must always refuse. */
export const DECISION_FORBIDDEN_AUTHORITY_INTENTS: readonly string[] = Object.freeze([
  'grant_execution_authority',
  'certify_verification_evidence',
  'skip_adversarial_review',
  'approve_external_gate',
  'override_pinned_model',
  'veto_hard_compaction',
]);

/** The only intents a Loopwright decision node may evaluate. */
export const DECISION_ALLOWED_AUTHORITY_INTENTS: readonly string[] = Object.freeze([
  'route_capability_tier',
  'select_skills',
  'evaluate_cycle_alignment',
  'advise_soft_compaction',
  'triage_candidate_diff',
]);

export type DecisionCapabilityTier = 'fast' | 'balanced' | 'strongest';

export interface DecisionTaskMetadata {
  readonly taskId: string;
  readonly taskKind: string;
  readonly estimatedFilesCount: number;
  readonly hasFailingTests: boolean;
  readonly requiresArchitectureChange: boolean;
  readonly candidateSkills: readonly string[];
  readonly pinnedCapabilityTier?: DecisionCapabilityTier;
  readonly pinnedRole?: string;
}

export interface DecisionCapabilityResult {
  readonly tier: DecisionCapabilityTier;
  readonly role: string | null;
  readonly skills: readonly string[];
  readonly source: DecisionSource;
  readonly zone: DecisionConfidenceZone | null;
  readonly fallbackReason: DecisionFallbackReason;
  readonly transportCalls: number;
  readonly userOverridePreserved: boolean;
}

export interface DecisionCyclePrecheckInput {
  readonly contractHash: Digest;
  readonly expectedContractHash: Digest;
  readonly baseRevision: string;
  readonly expectedBaseRevision: string;
  readonly leaseEpoch: string;
  readonly expectedLeaseEpoch: string;
  readonly leaseExpired: boolean;
  readonly writableScopeViolations: readonly string[];
  readonly remainingBudgetUsd: number;
  readonly remainingCycles: number;
  readonly contextUtilization: number;
  readonly failedVerificationLoops: number;
}

export type DecisionCycleRoute = 'continue' | 'revise' | 'needs_review' | 'blocked';

export interface DecisionCycleAlignmentResult {
  readonly route: DecisionCycleRoute;
  readonly precheckPassed: boolean;
  readonly source: DecisionSource;
  readonly zone: DecisionConfidenceZone | null;
  readonly fallbackReason: DecisionFallbackReason;
  readonly transportCalls: number;
}

export interface DecisionSoftCompactionAdvisoryResult {
  readonly advisoryDecision: 'compact' | 'defer' | null;
  readonly hardTriggerActive: boolean;
  readonly hardTriggerVetoRefused: boolean;
  readonly source: DecisionSource;
  readonly zone: DecisionConfidenceZone | null;
  readonly fallbackReason: DecisionFallbackReason;
  readonly transportCalls: number;
}

export type DecisionDiffTriageSeverity = 'blocking' | 'important' | 'nit';
export type DecisionDiffTriageRuleKind = 'noul' | 'score';

export interface DecisionDiffTriageRule {
  readonly id: string;
  readonly description: string;
  readonly severity: DecisionDiffTriageSeverity;
  readonly kind: DecisionDiffTriageRuleKind;
  readonly threshold?: number;
}

export interface DecisionDiffSummary {
  readonly changedFiles: readonly string[];
  readonly addedLines: number;
  readonly deletedLines: number;
  readonly touchedPackages: readonly string[];
  readonly redactedHunkSummaries: readonly string[];
}

export interface DecisionDiffTriageEscalation {
  readonly ruleId: string;
  readonly severity: DecisionDiffTriageSeverity;
  readonly source: DecisionSource;
  readonly advisoryOnly: true;
}

export interface DecisionDiffTriageResult {
  readonly escalated: readonly DecisionDiffTriageEscalation[];
  readonly verificationCertified: false;
  readonly source: DecisionSource;
  readonly zone: DecisionConfidenceZone | null;
  readonly fallbackReason: DecisionFallbackReason;
  readonly transportCalls: number;
}

export type DecisionBenchmarkArm = 'jev_off' | 'jev_on' | 'low_confidence_fallback';
export type DecisionBenchmarkCaseKind =
  | 'capability_routing'
  | 'cycle_alignment'
  | 'soft_compaction'
  | 'diff_triage'
  | 'timeout_fallback'
  | 'authority_boundary';

/** Deterministic fixture answer for one benchmark question; `timeout` and `httpStatus` simulate failures. */
export type DecisionBenchmarkFixture =
  | { readonly choice?: string; readonly noul?: number; readonly score?: number; readonly confidence?: number; readonly noneProbability?: number }
  | { readonly timeout: true }
  | { readonly httpStatus: number };

export interface DecisionBenchmarkCase {
  readonly id: string;
  readonly kind: DecisionBenchmarkCaseKind;
  readonly description: string;
  readonly forbiddenAuthorityIntent?: string;
  readonly task?: DecisionTaskMetadata;
  readonly cycle?: DecisionCyclePrecheckInput;
  readonly compaction?: { readonly contextUtilization: number; readonly failedVerificationLoops: number };
  readonly diff?: { readonly summary: DecisionDiffSummary; readonly rules: readonly DecisionDiffTriageRule[] };
  readonly expected: {
    readonly tier?: DecisionCapabilityTier;
    readonly skills?: readonly string[];
    readonly route?: DecisionCycleRoute;
    readonly advisoryDecision?: 'compact' | 'defer' | null;
    readonly escalatedRuleIds?: readonly string[];
  };
  readonly jevOnFixtures: Readonly<Record<string, DecisionBenchmarkFixture>>;
  readonly fallbackFixtures: Readonly<Record<string, DecisionBenchmarkFixture>>;
}

export interface DecisionBenchmarkArmSummary {
  readonly arm: DecisionBenchmarkArm;
  readonly totalCases: number;
  readonly passedCases: number;
  readonly acceptancePassRate: number;
  readonly falsePositiveEscalations: number;
  readonly falseNegativeMisses: number;
  readonly authorityViolationCount: number;
  readonly fallbackCount: number;
  readonly fallbackRate: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly unknownUsageCount: number;
  readonly estimatedCostUsd: number;
  readonly wallTimeMs: number;
}

export interface DecisionBenchmarkReport {
  readonly evidenceScope: 'controlled_offline_fixture';
  readonly arms: readonly DecisionBenchmarkArmSummary[];
  readonly jevOnVsOffDelta: {
    readonly acceptancePassRateDelta: number;
    readonly falsePositiveDelta: number;
    readonly falseNegativeDelta: number;
    readonly estimatedCostUsdDelta: number;
  };
  readonly recommendation: 'keep_optional_jev' | 'default_deterministic_only';
}
