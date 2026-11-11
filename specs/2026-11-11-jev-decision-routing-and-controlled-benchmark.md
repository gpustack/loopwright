# Specification: Jev System-One Decision Routing, Deterministic Fallbacks, and Controlled Benchmark

- **Status:** Shipped
- **Type:** Feature
- **Author:** thxCode
- **Created:** 2026-11-11
- **Updated:** 2026-11-11
- **Packages:** `@loopwright/decisions` (`packages/decisions`)
- **Depends On:** `@loopwright/core` ([`packages/core/src/index.ts`](../packages/core/src/index.ts)), `@loopwright/controller` ([`packages/controller/src/index.ts`](../packages/controller/src/index.ts)), `@loopwright/memory` ([`packages/memory/src/index.ts`](../packages/memory/src/index.ts))

---

## Motivation

Loopwright's execution loops repeatedly face narrow, closed-world routing and classification decisions before or between full frontier-model reasoning turns:

1. **Pre-execution capability tier and skill selection**: Choosing whether a bounded task contract requires a `fast`, `balanced`, or `strongest` model tier and which narrow subset of registered skills applies, without paying a full frontier-model planning turn when no explicit contract/user model override is set.
2. **Inter-cycle alignment and soft context-compaction advisories**: Evaluating structured, redacted cycle telemetry (after deterministic state, lease, scope, and budget pre-checks pass) to advise whether the loop should `continue`, `revise`, `needs_review`, or `blocked`, and whether soft context compaction (`compact` vs `defer` in [`packages/memory/src/compaction.ts`](../packages/memory/src/compaction.ts)) should run before the next cycle.
3. **Semantic candidate diff triage**: Running speculative fan-out of up to `100` atomic binary (`noul`) or rubric (`score`) review checks in a single call over redacted candidate diff metadata to prioritize which findings warrant full adversarial verifier or reviewer inspection.

TypeSafe AI's System-One API (`POST https://api.typesafe.ai/v1/systemone`, the wire protocol StartLux-Decision also implements) provides calibrated System-One primitives (`choice`, `score`, `noul`, and GUI `box`) that evaluate `1..100` structured questions against a compact JSON `state` object in a single request and return calibrated probability distributions (`probabilities`, `confidence`) alongside token usage (`usage.input_tokens`, `usage.output_tokens`). The OpenAI Decisions API (`POST /v1/decisions`, `predicate`/`choice`/`score` with an `answers` array) and StartLux-Decision (`POST /v1/systemone` or `/v1/decisions` with keyed `answers`, `none_probability`, and bounded `think_budget`) expose compatible System-One surfaces behind the same policy gate.

However, integrating an external hosted decision service into an autonomous repository harness introduces five concrete failure modes that must be prevented by design:

1. **Silent repository disclosure**: Sending raw source files, unredacted agent transcripts, environment dumps, or secret material (`TYPESAFE_API_KEY`, `ghs_`, `ghu_`, `ghp_`, `github_pat_`, `Bearer` tokens, PEM keys, `${...}` secret templates) to an external decision API when repository policy has not opted in or when inputs are not scrubbed.
2. **Probabilistic authority escalation**: Allowing a probabilistic System-One classifier to grant tool or shell execution authority, certify verification evidence, skip adversarial `my-ship` review, approve external publication gates, veto hard context-compaction triggers (`contextUtilization >= 0.80` or `failedVerificationLoops >= 2`), or override a user-pinned model/role.
3. **Uncalibrated low-confidence routing**: Acting directly on a marginal top class when the calibrated probability sits below the high-confidence threshold (`minConfidence`, default `0.80`) or confirm threshold (`confirmThreshold`, default `0.60`), or accepting malformed provider payloads (`NaN`/`Infinity`, out-of-range indices, probability vectors that do not sum to `1.0`, or unsupported GUI `box` primitives in headless harness execution).
4. **Tail-latency hangs and retry amplification**: Allowing slow network responses or internal CLI/SDK retries (`3` retries with exponential backoff and `30s` timeouts) to stall the controller loop or multiply token spend when a decision exceeds the outer hard deadline (`hardDeadlineMs`, default `5000ms`), or refunding budget reservations when a request times out after dispatch and provider token consumption is unknown.
5. **Unmeasured routing efficacy**: Enabling System-One routing without an offline, reproducible A/B benchmark harness that compares `jev_on`, `jev_off` (deterministic baseline), and `low_confidence_fallback` under identical task contracts and model budgets.

`@loopwright/decisions` (`packages/decisions`) solves these problems by providing an optional, policy-gated, hard-deadline-supervised System-One decision layer with deterministic pre-checks, calibrated 3-zone confidence routing, strict authority boundaries, conservative budget settlement, and a controlled offline A/B benchmark harness.

---

## User Stories & Acceptance Criteria

### Story 1: Opt-In Mode Switch, Disclosure Policy Enforcement, and Pre-Send State Sanitization

As a repository operator, I want System-One decision calls to be disabled unless explicitly enabled with an approved disclosure policy and pre-send state sanitization so that no repository code, transcripts, or credentials ever leak to an external API.

#### Acceptance Criteria (`AC-1`)

- **`AC-1.1` (Decision Policy Configuration & Validation)**: `validateDecisionPolicy(input)` validates and normalizes `DecisionPolicyConfig`:
  - `enabled: boolean` (default `false`)
  - `disclosurePolicy: 'disabled' | 'repo-approved-redacted-evidence' | 'public-metadata-only'` (default `'disabled'`)
  - `minConfidence: number` (default `0.80`, finite number in `[0.50, 1.00]`)
  - `confirmThreshold: number` (default `0.60`, finite number in `[0.00, 1.00]` with `confirmThreshold <= minConfidence`)
  - `hardDeadlineMs: number` (default `5000`, integer in `[100, 30_000]`)
  - `maxAttempts: 1 | 2` (default `1`)
  - `fallbackRole: string | null` (default `'deterministic'`)
  - `onFallbackUnavailable: 'blocked' | 'deterministic_default'` (default `'blocked'`)
  - Invalid policy configurations fail closed with `DECISION_POLICY_INVALID`.
- **`AC-1.2` (Zero-Call Gate When Disabled or Unapproved)**: Before constructing or dispatching any transport request, `evaluateDecision` checks `policy.enabled === true` and `policy.disclosurePolicy !== 'disabled'`. When `enabled === false` or `disclosurePolicy === 'disabled'`, `evaluateDecision` makes **zero** transport calls (`transportCalls === 0`) and immediately returns the caller's deterministic fallback with `mode: 'disabled'`, `source: 'deterministic_fallback'`, and `fallbackReason: 'policy_disabled'`.
- **`AC-1.3` (Pre-Send State Sanitization & Secret Refusal)**: `sanitizeDecisionState(state, policy, scrubber?)` validates the JSON `state` payload before any transport call:
  - Rejects non-plain-object roots, circular references, non-finite numbers (`NaN`, `Infinity`, `-Infinity`), functions/symbols/bigints, nesting depth `> 16`, or serialized UTF-8 byte length `> 65_536` (`DECISION_STATE_TOO_LARGE` for size violations; `DECISION_SCHEMA_INVALID` for structural violations).
  - Rejects prototype-pollution keys (`__proto__`, `constructor`, `prototype`) at any depth with `DECISION_DISCLOSURE_VIOLATION`.
  - Rejects forbidden raw-content keys (`rawFileContent`, `fileBody`, `fullTranscript`, `rawTranscript`, `envDump`, `processEnv`, `privateKey`, `secret`, `token`, `authorization`, `cookie`) and any string value matching secret/credential patterns (`TYPESAFE_API_KEY`, `ghs_`, `ghu_`, `ghp_`, `github_pat_`, `github_app_`, `Bearer `, `-----BEGIN `, `AWS_SECRET_ACCESS_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `${...}` secret template expressions, or registered `SecretScrubber` secrets from `@loopwright/core`) with `DECISION_DISCLOSURE_VIOLATION`.
  - Under `disclosurePolicy: 'public-metadata-only'`, additionally rejects diff hunk bodies or evidence snippets (`diffPatch`, `rawDiff`, `patchBody`, `stdout`, `stderr`, or string values exceeding `512` characters) with `DECISION_DISCLOSURE_VIOLATION`.

---

### Story 2: Typed System-One Primitives (`choice`, `score`, `noul`), 3-Zone Confidence Routing, and Speculative Fan-Out

As a harness engineer, I want strict schema validation and 3-zone confidence gating over `choice`, `score`, and `noul` primitives — plus single-call speculative fan-out of up to `100` atomic questions — so that Loopwright only acts directly on high-confidence calibrated answers and safely routes uncertain answers to confirmation or deterministic fallback.

#### Acceptance Criteria (`AC-2`)

- **`AC-2.1` (Primitive Request Validation)**: `validateDecisionQuestions(questions, policy?)` enforces:
  - Question array length in `1..100` (`DECISION_BATCH_SIZE_INVALID` if `< 1` or `> 100`).
  - Unique non-empty `id` (`string`, `1..128` chars) and non-empty `prompt` (`string`, `1..2048` chars) per question.
  - **`choice` primitive**: `options` is a plain object (`Record<string, string>`) or non-empty string array with `1..255` distinct option keys and non-empty descriptions (`DECISION_SCHEMA_INVALID` if `< 1` or `> 255` options or empty key/label).
  - **`score` primitive**: `criteria` is an ordered array of `2..10` non-empty level descriptions from lowest (`0`) to highest (`n - 1`) (`DECISION_SCHEMA_INVALID` if `< 2` or `> 10` levels).
  - **`noul` primitive**: binary yes/no question with optional `threshold` in `(0, 1)` (default `policy.minConfidence`).
  - **`box` primitive gate**: `type: 'box'` questions require an image-capable policy (`allowImages: true` on a box-capable provider: `typesafe-jev`, `startlux-decision`) and are rejected pre-send with `DECISION_PRIMITIVE_UNSUPPORTED` in headless text/JSON mode or on `openai-decisions`.
  - **Binary alias**: OpenAI-style `type: 'predicate'` questions are accepted and canonicalized to `noul`.
  - **Image assets**: `DecisionImageAsset` inputs (`png`/`jpeg`/`webp`, bounded base64) require `allowImages: true` under `repo-approved-redacted-evidence`; anything else is a `DECISION_DISCLOSURE_VIOLATION`.
- **`AC-2.2` (Provider Response Validation & Normalization)**: `parseAndValidateProviderResponse(questions, rawResponse, policy)` validates the provider's `outputs` array:
  - `outputs.length` must equal `questions.length`; any mismatch fails closed with `DECISION_RESPONSE_INVALID`.
  - For **`choice`**: verifies `choice` is one of the declared option keys, `confidence` is a finite number in `[0, 1]`, and `probabilities` contains finite numbers in `[0, 1]` for declared keys whose sum is within `1.0 ± 1e-3`.
  - For **`score`**: verifies integer `score` in `[0, criteria.length - 1]`, computes `normalizedScore = score / (criteria.length - 1)` in `[0, 1]`, verifies `confidence` in `[0, 1]`, and verifies `probabilities` is an array of length `criteria.length` of finite numbers in `[0, 1]` summing to `1.0 ± 1e-3`.
  - For **`noul`**: verifies `noul` is a finite number in `[0, 1]`, derives `confidence = Math.abs(2 * noul - 1)` in `[0, 1]`, and computes boolean `affirmative = noul >= (question.threshold ?? policy.minConfidence)`.
- **`AC-2.3` (3-Zone Calibrated Confidence Gating)**: Every validated question output and aggregate decision is classified into one of three confidence zones:
  - **`high` (`confidence >= policy.minConfidence`)**: Direct execution of the selected route (`zone: 'high'`, `action: 'accept_jev'`).
  - **`medium` (`policy.confirmThreshold <= confidence < policy.minConfidence`)**: Routes to confirmation or deterministic tie-breaker (`zone: 'medium'`, `action: 'confirm_or_fallback'`).
  - **`low` (`confidence < policy.confirmThreshold`)**: Rejects the probabilistic choice and executes the deterministic fallback (`zone: 'low'`, `action: 'fallback'`).
- **`AC-2.4` (Speculative Fan-Out Evaluation)**: `evaluateSpeculativeFanOut(input)` batches up to `100` independent or branch-dependent `choice`/`score`/`noul` questions into a single transport request, resolves only the active branch path selected by upstream answers (ignoring unused speculative branch outputs without extra network calls), and records `totalQuestions`, `evaluatedBranchIds`, and `ignoredBranchIds`.

---

### Story 3: Hard-Deadline Supervisor, Retry Amplification Prevention, and Conservative Budget Settlement

As a controller owner, I want every Jev call wrapped in an outer hard-deadline supervisor with retry amplification disabled and conservative token-budget settlement so that slow or failing provider calls never stall the loop or under-report budget spend.

#### Acceptance Criteria (`AC-3`)

- **`AC-3.1` (Outer Hard-Deadline Supervisor via `AbortController`)**: Every transport invocation in `JevDecisionClient` is governed by an outer `AbortController` timer set to `policy.hardDeadlineMs` (default `5000ms`). If the transport does not resolve before `hardDeadlineMs`, the client aborts the in-flight signal immediately, records error code `DECISION_DEADLINE_EXCEEDED`, and routes cleanly to the deterministic fallback (`source: 'deterministic_fallback'`, `fallbackReason: 'deadline_exceeded'`) when fallback is available, or throws `DecisionError('DECISION_DEADLINE_EXCEEDED')` when `onFallbackUnavailable: 'blocked'` and no fallback handler is provided.
- **`AC-3.2` (No Retry Amplification)**: `JevDecisionClient` defaults to `maxAttempts: 1` (and rejects `maxAttempts > 2`). When `maxAttempts === 2`, a retry is permitted only on pre-dispatch/transient transport failure if the remaining wall-clock budget inside the **same** outer `hardDeadlineMs` window is at least `50ms`; it never spawns a second `30s` timeout window or exponential backoff loop.
- **`AC-3.3` (Conservative Budget Reservation & Unknown-Usage Retention)**:
  - Before dispatching a request, `DecisionBudgetTracker` estimates input tokens from the serialized payload (`Math.ceil(byteLength / 4)` or explicit estimate), reserves the token/cost budget (`inputCostPerMtokUsd = 0.042`, `outputCostPerMtokUsd = 0`), and refuses the call pre-send with `DECISION_BUDGET_EXCEEDED` (routing to deterministic fallback) if remaining budget is insufficient.
  - On a valid response with `usage: { input_tokens, output_tokens }`, the tracker settles the reservation to exact reported `input_tokens` and `output_tokens` (`unknownUsageRetained: false`).
  - If a request fails **after** dispatch (`dispatched: true` — e.g. `DECISION_DEADLINE_EXCEEDED`, HTTP `5xx`, or malformed response body), the tracker **retains** the reserved input token/cost charge (`unknownUsageRetained: true`, `unknownUsageCount` incremented) and never refunds unknown provider consumption.

---

### Story 4: Deterministic Authority Boundary and Loopwright Decision Nodes

As a security architect, I want strict authority boundaries and deterministic pre-checks around every Loopwright decision node so that Jev can optimize routing, soft compaction, and diff triage without ever weakening safety invariants or overriding user/contract constraints.

#### Acceptance Criteria (`AC-4`)

- **`AC-4.1` (Non-Delegable Authority Invariant Enforcement)**: `assertDecisionAuthorityBoundary(intent)` and all Loopwright decision nodes reject any attempt to use `@loopwright/decisions` to:
  1. Grant tool, shell, filesystem, or network execution authority (`grant_execution_authority`)
  2. Certify verification evidence or mark failing tests/checks as passed (`certify_verification_evidence`)
  3. Skip or auto-approve adversarial `my-ship` review (`skip_adversarial_review`)
  4. Approve external publication, PR creation, deployment, or merge gates (`approve_external_gate`)
  5. Override an explicit user-pinned or contract-pinned model/role (`override_pinned_model`)
  6. Veto a hard context-compaction trigger (`veto_hard_compaction`)
  - Any such attempt fails closed with `DECISION_AUTHORITY_VIOLATION` (`authorityViolation: true`).
- **`AC-4.2` (Node 1 — `routeTaskCapability`)**:
  - Accepts redacted task metadata (`taskId`, `taskKind`, `estimatedFilesCount`, `hasFailingTests`, `requiresArchitectureChange`, `candidateSkills` up to `255` items, optional `pinnedCapabilityTier`, optional `pinnedRole`).
  - If `pinnedCapabilityTier` or `pinnedRole` is present, immediately returns the pinned tier/role (`userOverridePreserved: true`, `transportCalls: 0`) without calling Jev.
  - Otherwise, queries Jev with a `choice` question for capability tier (`fast | balanced | strongest`) and up to `255` `noul` or `choice` skill-selection checks in a single speculative request, falling back to deterministic heuristic tiering and keyword/tag skill matching when Jev is disabled, times out, or returns `low`/`medium` confidence.
- **`AC-4.3` (Node 2 — `evaluateCycleAlignment` & `evaluateSoftCompactionAdvisory`)**:
  - Runs **deterministic pre-checks first** on `CyclePrecheckInput`:
    1. `contractHash === expectedContractHash`
    2. `baseRevision === expectedBaseRevision`
    3. `leaseEpoch === expectedLeaseEpoch && leaseExpired === false`
    4. `writableScopeViolations.length === 0`
    5. `remainingBudgetUsd > 0 && remainingCycles > 0`
    6. Hard compaction invariant check (`contextUtilization >= 0.80` or `failedVerificationLoops >= 2` from `@loopwright/memory`)
  - If any deterministic pre-check fails, `evaluateCycleAlignment` immediately returns `route: 'blocked'` (or `needs_review` for scope/budget exhaustion) with `precheckPassed: false` and `transportCalls: 0`.
  - If a hard compaction trigger (`contextUtilization >= 0.80` or `failedVerificationLoops >= 2`) is active, `evaluateSoftCompactionAdvisory` immediately returns `advisoryDecision: 'compact'` (`hardTriggerActive: true`, `hardTriggerVetoRefused: true`, `transportCalls: 0`), interoperating directly with `CompactionPolicyInput.advisoryDecision` in [`packages/memory/src/types.ts`](../packages/memory/src/types.ts) and `evaluateCompactionPolicy` in [`packages/memory/src/compaction.ts`](../packages/memory/src/compaction.ts).
  - Only when all deterministic pre-checks pass and no hard compaction trigger is active may Jev evaluate soft-zone (`0.60 <= contextUtilization < 0.80`) compaction (`compact` vs `defer`) and cycle alignment (`continue | revise | needs_review | blocked`).
- **`AC-4.4` (Node 3 — `triageCandidateDiff`)**:
  - Accepts redacted diff summary metadata (`changedFiles`, `addedLines`, `deletedLines`, `touchedPackages`, `redactedHunkSummaries`) and `1..100` atomic semantic rules (`id`, `description`, `severity: 'blocking' | 'important' | 'nit'`, `kind: 'noul' | 'score'`).
  - Executes a single batched Jev request over all rules, escalates rules whose calibrated probability/score meets or exceeds `rule.threshold ?? policy.minConfidence`, and falls back to deterministic static diff matching when Jev is disabled, fails, or returns low confidence.
  - Never certifies the diff as shippable (`verificationCertified: false`); escalated findings are marked `advisoryOnly: true` for downstream `@loopwright/controller` verifier or reviewer confirmation.

---

### Story 5: Controlled Offline A/B Benchmark Harness (`runControlledDecisionBenchmark`)

As a harness maintainer, I want a deterministic offline A/B benchmark harness that compares `jev_on`, `jev_off` (deterministic baseline), and `low_confidence_fallback` across a fixed corpus of routing, cycle-alignment, soft-compaction, and diff-triage scenarios under identical contracts and budgets so that we can verify decision quality, latency, and cost before enabling Jev in production.

#### Acceptance Criteria (`AC-5`)

- **`AC-5.1` (Controlled Multi-Arm Execution)**: `runControlledDecisionBenchmark(options)` executes a fixed corpus of benchmark cases (`DecisionBenchmarkCase[]`, with a built-in default corpus `DEFAULT_DECISION_BENCHMARK_CORPUS` covering capability routing, cycle alignment, soft compaction, diff triage, timeout fallback, and authority-boundary rejection) across three arms under identical task contracts and budgets:
  1. `jev_off`: policy disabled (`enabled: false`), pure deterministic baseline
  2. `jev_on`: policy enabled (`enabled: true`) with deterministic fixture transport responses
  3. `low_confidence_fallback`: policy enabled (`enabled: true`) with marginal/low-confidence and timeout fixture responses verifying safe fallback routing
- **`AC-5.2` (Benchmark Metrics & Comparison Report)**: For each arm and the overall comparison, `runControlledDecisionBenchmark` computes and returns `DecisionBenchmarkReport`:
  - `evidenceScope: 'controlled_offline_fixture'`
  - Per-arm metrics (`DecisionBenchmarkArmSummary`): `arm`, `totalCases`, `passedCases`, `acceptancePassRate` (`0..1`), `falsePositiveEscalations`, `falseNegativeMisses`, `authorityViolationCount` (must be `0`), `fallbackCount`, `fallbackRate` (`0..1`), `totalInputTokens`, `totalOutputTokens`, `unknownUsageCount`, `estimatedCostUsd`, `wallTimeMs`
  - Pairwise deltas (`jevOnVsOffDelta`): `acceptancePassRateDelta`, `falsePositiveDelta`, `falseNegativeDelta`, `estimatedCostUsdDelta`
  - Explicit recommendation gate (`recommendation: 'keep_optional_jev' | 'default_deterministic_only'`) that requires `jev_on.authorityViolationCount === 0`, `low_confidence_fallback.authorityViolationCount === 0`, and `jev_on.acceptancePassRate >= jev_off.acceptancePassRate`.

---

## Scope & Non-Goals

### In Scope

- New workspace package `@loopwright/decisions` at `packages/decisions` (`packages/decisions/package.json`, `packages/decisions/tsconfig.json`, `packages/decisions/src/{types,schema,redaction,primitives,client,router,nodes,benchmark,index}.ts`, `packages/decisions/test/*.test.ts`).
- Policy validation (`validateDecisionPolicy`), pre-send state sanitization and secret/disclosure enforcement (`sanitizeDecisionState`), and typed `DecisionError` codes.
- Provider-agnostic multi-provider support per REVIEW-002 (`DecisionProviderKind`: `typesafe-jev`, `openai-decisions`, `startlux-decision`): per-provider policy defaults (`endpoint`, `model`, StartLux deliberation controls), per-provider wire-format codecs (`formatProviderRequest`, provider-shaped `parseAndValidateProviderResponse`), `predicate` as an accepted binary-question alias canonicalized to `noul`, StartLux `none_probability` fallback classification (threshold default `0.2`), array or keyed-object score probabilities with discrete and continuous score normalization, and `DecisionClient` exported with the `JevDecisionClient` alias.
- Full decision-ecosystem support per REVIEW-004: seven provider profiles across two wire dialects (`getProviderDialect` → `systemone` for `typesafe-jev`, `startlux-decision`, `microsoft-decision`, `perplexity-decider`, `cloudflare-clef`, `liquid-d1`; `openai-decisions` for `openai-decisions`), response field-alias normalization (Cloudflare `result` envelope unwrap, `selected`/`distribution`, `expected_score`/`probability_distribution`, `probability` binary alias, criteria-label-keyed score probabilities, derived `confidence = max(probabilities)` when a score omits it), and a first-class SDK adapter bridge (`DecisionSdkAdapter`, `createSdkDecisionTransport`, `sdkAdapter` client option) that keeps every pre-send, budget, deadline, and validation guarantee without requiring a raw HTTP `apiKey`.
- Canonical TypeSafe endpoint and image inputs per REVIEW-003: `https://api.typesafe.ai/v1/systemone` with model `jev-latest` under the shared keyed `/v1/systemone` protocol, `allowImages` policy gating for `DecisionImageAsset` multimodal inputs (`assets` map plus `TypeSafe-Danger-Zone-Images: true` transport header, StartLux/Liquid `images: string[]`, OpenAI multimodal input), and validated `box` answers (`[0, 1]` coordinates with `top <= bottom`, `left <= right`).
- Primitive schema validation and response normalization for `choice` (`<= 255` options), `score` (`2..10` criteria levels), and `noul` (`0..1` probability), plus explicit refusal of `box` in headless mode.
- `JevDecisionClient` with pluggable `DecisionTransport` (plus built-in HTTP `fetch` transport for `https://api.typesafe.ai/v0/jev`), outer `AbortController` `hardDeadlineMs` supervisor, retry amplification cap (`maxAttempts: 1` by default, max `2`), and `DecisionBudgetTracker` with conservative unknown-usage retention.
- 3-zone confidence router (`evaluateDecision`, `evaluateSpeculativeFanOut`) and three concrete Loopwright decision nodes (`routeTaskCapability`, `evaluateCycleAlignment`, `evaluateSoftCompactionAdvisory`, `triageCandidateDiff`) interoperating with `@loopwright/memory` compaction advisories.
- Controlled offline A/B benchmark harness (`runControlledDecisionBenchmark`, `DEFAULT_DECISION_BENCHMARK_CORPUS`).
- Architecture documentation in `docs/decisions.md`.

### Out of Scope (Non-Goals)

- Live network calls during unit or integration tests (all automated tests must use deterministic in-memory `DecisionTransport` fixtures).
- GUI bounding-box (`box`) grounding for desktop computer-use agents.
- Replacing `@loopwright/controller` deterministic verification pipelines or authority checks with probabilistic Jev outputs.
- Automatic enabling of Jev in repositories that have not explicitly configured `enabled: true` and an approved `disclosurePolicy`.

---

## System Architecture & Module Boundaries

```
packages/decisions/
├── package.json
├── tsconfig.json
├── src/
│   ├── types.ts        # DecisionPolicyConfig, primitives, transport, budget, node, and benchmark types + DecisionError
│   ├── schema.ts       # Provider-aware policy validation, question batch validation (predicate alias), and bounds
│   ├── redaction.ts    # Pre-send state sanitization, disclosure policy checks, and structural scrubber integration
│   ├── primitives.ts   # Per-provider wire-format codecs, normalization, and 3-zone confidence classification
│   ├── client.ts       # DecisionClient (JevDecisionClient alias), AbortController deadline supervisor, DecisionBudgetTracker, HTTP transports
│   ├── router.ts       # evaluateDecision & evaluateSpeculativeFanOut with deterministic fallback orchestration
│   ├── nodes.ts        # assertDecisionAuthorityBoundary, routeTaskCapability, evaluateCycleAlignment, evaluateSoftCompactionAdvisory, triageCandidateDiff
│   ├── benchmark.ts    # DEFAULT_DECISION_BENCHMARK_CORPUS and runControlledDecisionBenchmark (jev_off vs jev_on vs low_confidence_fallback)
│   └── index.ts        # Public package barrel exports
└── test/
    └── *.test.ts       # Unit, adversarial boundary, deadline/budget, memory-compaction interop, and benchmark tests
```

### Error Taxonomy (`DecisionErrorCode`)

| Error Code | Trigger Condition |
| :--- | :--- |
| `DECISION_POLICY_INVALID` | Invalid `DecisionPolicyConfig` (`minConfidence`, `confirmThreshold`, `hardDeadlineMs`, `maxAttempts`, or `disclosurePolicy`). |
| `DECISION_DISCLOSURE_VIOLATION` | Forbidden raw file/transcript/env keys, secret token patterns, prototype-pollution keys, or `public-metadata-only` policy violations in `state`. |
| `DECISION_STATE_TOO_LARGE` | Serialized `state` exceeds `65_536` UTF-8 bytes. |
| `DECISION_BATCH_SIZE_INVALID` | Questions batch length is `< 1` or `> 100`. |
| `DECISION_PRIMITIVE_UNSUPPORTED` | Question requests GUI `box` primitive or an unknown primitive type in headless harness mode. |
| `DECISION_SCHEMA_INVALID` | Malformed `state` structure (depth `> 16`, non-finite numbers) or invalid `choice`/`score`/`noul` question definition. |
| `DECISION_RESPONSE_INVALID` | Provider response has mismatched `outputs.length`, invalid option key, out-of-range score index, non-finite values, or probabilities not summing to `1.0 ± 1e-3`. |
| `DECISION_DEADLINE_EXCEEDED` | Transport call exceeded `policy.hardDeadlineMs` and was aborted by the outer `AbortController`. |
| `DECISION_TRANSPORT_ERROR` | Transport threw a network/HTTP error or lacked an API key when dispatching a live request. |
| `DECISION_BUDGET_EXCEEDED` | Estimated input token cost exceeds remaining budget in `DecisionBudgetTracker`. |
| `DECISION_AUTHORITY_VIOLATION` | Caller or output attempted a non-delegable authority action (granting execution authority, certifying verification, skipping review, approving external gates, overriding pinned model, or vetoing hard compaction). |

---

## Implementation Plan

Environment and commands, grounded in the root `package.json`; every command runs locally in this worktree,
offline, no remote services:

- Toolchain: Node `26.x`, npm `11.x`, TypeScript `6.0.3` (`NodeNext`, `strict`, `exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`), ESLint flat config with `typescript-eslint` recommended.
- Full gate: `npm run build && npm test && npm run lint` — `build` compiles each workspace package with `tsc`
  (core first), `test` compiles `tsconfig.test.json` into `.test-build/` and runs `node --test
  --test-concurrency=1`, `lint` runs `eslint`.
- Focused gate (per task): `npm run build && tsc -p tsconfig.test.json && node --test --test-concurrency=1
  .test-build/packages/decisions/test/<suite>.test.js`.
- Code style follows the existing packages: ESM with explicit `.js` import specifiers, `readonly` interfaces,
  no default exports, `node:test` `describe`/`it` with `node:assert/strict`, frozen fixture builders, and
  error-code assertions.
- Integration points from re-grounding: the root `tsconfig.json` carries no per-package lists, so the new
  package is wired only through the root `package.json` (`workspaces`, `build`/`test` scripts) and the
  `tsconfig.test.json` include list. `@loopwright/core` does not yet export a `SecretScrubber` (the existing
  implementation lives in `packages/github-app/src/token-broker.ts` and is coupled to GitHub App error
  codes), so T1 adds a minimal, decision-neutral core primitive first; the GitHub App keeps its own copy and
  a later spec may migrate it.

Task DAG; every task leaves the full suite green, and task ids are stable handles for `my-build`:

- [x] **T1 · Foundation: core SecretScrubber primitive, decisions package scaffold, policy and state trust boundary**
      Blocked by: None
      Owns: `packages/core/src/scrubber.ts`, `packages/core/src/index.ts`, `packages/core/test/scrubber.test.ts`, `packages/decisions/**`, root `package.json`, `tsconfig.test.json`
      Gate: review
      Acceptance: After `npm install` links the workspace, `@loopwright/core` exports a minimal `SecretScrubber` (`register`, `scrub`, and a boolean `containsSecret` check over raw, JSON-escaped, URL-encoded, and base64 forms plus generic token patterns; it throws nothing and stays decision-neutral). `packages/decisions` exists as a workspace package (`package.json` depending on `@loopwright/core`, `@loopwright/controller`, `@loopwright/memory`; `tsconfig.json` extending the root config with `declaration` and `dist` output) wired into the root `workspaces`, `build`/`test` scripts (build step after `memory`), and the `tsconfig.test.json` include list. `src/types.ts` defines `DecisionPolicyConfig`, `DecisionErrorCode`, `DecisionError`, the `choice`/`score`/`noul` question and response unions, transport, budget, router, node, and benchmark types. `src/schema.ts` provides `validateDecisionPolicy` (defaults and ranges per AC-1.1, fail-closed with `DECISION_POLICY_INVALID`) and `validateDecisionQuestions` (AC-2.1, including the `box` refusal with `DECISION_PRIMITIVE_UNSUPPORTED`). `src/redaction.ts` provides `sanitizeDecisionState` (AC-1.3: plain-object roots only, circular references, non-finite numbers, functions/symbols/bigints, depth `16`, `65_536`-byte cap as `DECISION_STATE_TOO_LARGE`, structural violations as `DECISION_SCHEMA_INVALID`, prototype-pollution keys, forbidden raw-content keys, secret/token patterns, registered `SecretScrubber` secrets, and `public-metadata-only` extra denials including strings over `512` characters, all as `DECISION_DISCLOSURE_VIOLATION`). `packages/core/test/scrubber.test.ts` and `packages/decisions/test/policy-and-redaction.test.ts` cover every error code introduced here. Per REVIEW-001, `sanitizeDecisionState` accepts any structural scrubber `{ scrub(value: string): string; containsSecret?(value: string): boolean }` so core and GitHub App scrubbers interoperate. Per REVIEW-002, the policy carries `provider`/`endpoint`/`model`/`startluxOptions` with per-provider defaults and validation (`thinkBudget` capped at `4096`, `noneProbabilityThreshold` in `(0, 1)`), `validateDecisionQuestions` canonicalizes the OpenAI `predicate` alias to `noul` and validates choice `allowNone`, and the `OPENAI_API_KEY`/`STARTLUX_API_KEY` names join the forbidden secret patterns.
      Verify: `npm run build && tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/core/test/scrubber.test.js .test-build/packages/decisions/test/policy-and-redaction.test.js`

- [x] **T2 · System-One primitives: choice, score, and noul normalization with 3-zone confidence classification**
      Blocked by: T1
      Owns: `packages/decisions/src/primitives.ts`, `packages/decisions/test/primitives.test.ts`
      Acceptance: `primitives.ts` normalizes validated questions and provider outputs per AC-2.2: `choice` with `1..255` distinct options and declared-key validation; `score` with `2..10` ordered criteria levels and `normalizedScore = score / (criteria.length - 1)`; `noul` with finite `[0, 1]` probability, derived `confidence = Math.abs(2 * noul - 1)`, and `affirmative = noul >= (threshold ?? policy.minConfidence)`; probability vectors of finite `[0, 1]` numbers summing to `1.0 ± 1e-3`; `parseAndValidateProviderResponse` fails closed with `DECISION_RESPONSE_INVALID` on outputs-length mismatch, unknown option keys, out-of-range score indices, and non-finite values; a defense-in-depth `box` refusal throws `DECISION_PRIMITIVE_UNSUPPORTED`; `classifyConfidenceZone` maps every validated output into `high` / `medium` / `low` zones with actions `accept_jev` / `confirm_or_fallback` / `fallback` per AC-2.3. `primitives.test.ts` covers each rule including boundary values (`1` and `255` options, `2` and `10` levels, `0`/`1` confidence, probability-sum tolerance edges). Per REVIEW-002 and REVIEW-003: `formatProviderRequest` serializes the shared keyed `/v1/systemone` request (model, state, questions map, `assets`/`images`, StartLux deliberation controls) and the openai-decisions request (`predicate` binaries, 1-indexed `levels`, multimodal input); `parseAndValidateProviderResponse` accepts all three response shapes (keyed answers map, openai answers array, legacy positional outputs) with keyed-object or array score probabilities, discrete and continuous score normalization, `none_probability`/`null` choices classified into the `low` zone at or above the fallback threshold (default `0.2`), `predicate` mapped to derived-confidence `noul` answers, and `box` coordinate validation (`[0, 1]` with `top <= bottom`, `left <= right`); `providerRequestHeaders` emits `TypeSafe-Danger-Zone-Images: true` for image or `box` requests.
      Verify: `npm run build && tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/decisions/test/primitives.test.js`

- [x] **T3 · JevDecisionClient: hard-deadline supervisor, pluggable transport, and conservative budget settlement**
      Blocked by: T2
      Owns: `packages/decisions/src/client.ts`, `packages/decisions/test/client-and-budget.test.ts`
      Acceptance: `DecisionTransport` is pluggable; the built-in HTTP transport POSTs to `https://api.typesafe.ai/v0/jev` with a bearer credential and fails pre-send with `DECISION_TRANSPORT_ERROR` when no API key is configured. `JevDecisionClient` wraps every transport invocation in an outer `AbortController` timer of `policy.hardDeadlineMs`; on expiry it aborts the in-flight signal, records `DECISION_DEADLINE_EXCEEDED`, and returns a fallback result (`fallbackReason: 'deadline_exceeded'`) when a fallback handler exists, otherwise throws `DecisionError` under `onFallbackUnavailable: 'blocked'` (AC-3.1). Attempts default to `1`, values above `2` are rejected, and a single retry happens only when the remaining wall-clock inside the same deadline window is at least `50ms`; it never opens a second timeout window or a backoff loop (AC-3.2). `DecisionBudgetTracker` reserves `Math.ceil(byteLength / 4)` estimated input tokens at `0.042` USD per Mtok (output priced `0`), refuses pre-send with `DECISION_BUDGET_EXCEEDED`, settles to the exact reported `usage` on success (`unknownUsageRetained: false`), and retains the reservation with `unknownUsageRetained: true` and an incremented `unknownUsageCount` on any post-dispatch failure (AC-3.3). Deadline and budget tests use injected clocks and `node:test` mock timers with immediate-resolve and never-resolve transports; no real network and no sleeps. Per REVIEW-002 the class exports as `DecisionClient` with the `JevDecisionClient` alias and resolves provider API keys from the environment (`TYPESAFE_API_KEY`, with `MICROSOFT_DECISION_API_KEY` falling back to `AZURE_API_KEY` per REVIEW-004). Per REVIEW-004 an in-process `sdkAdapter` gets the exact same pre-send reservation, outer deadline supervisor, retry cap, and response validation without any raw HTTP `apiKey`, and `createSdkDecisionTransport` bridges the same adapter behind the `DecisionTransport` interface (keyless via the SDK-transport brand).
      Verify: `npm run build && tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/decisions/test/client-and-budget.test.js`

- [x] **T4 · Decision router: zero-call gate, 3-zone routing, and speculative fan-out**
      Blocked by: T3
      Owns: `packages/decisions/src/router.ts`, `packages/decisions/test/router-and-fanout.test.ts`
      Acceptance: `evaluateDecision` enforces the zero-call gate (AC-1.2: when `enabled === false` or `disclosurePolicy === 'disabled'` it constructs no transport, reports `transportCalls: 0`, `mode: 'disabled'`, `source: 'deterministic_fallback'`, `fallbackReason: 'policy_disabled'`), sanitizes state pre-send, dispatches through `JevDecisionClient`, and routes validated answers by zone: `high` accepts the Jev answer, `medium` returns `confirm_or_fallback` for the caller's confirmation path, `low` executes the deterministic fallback (AC-2.3). Fallback results carry `source: 'deterministic_fallback'` with reasons distinguishing policy, deadline, transport, budget, and confidence paths. `evaluateSpeculativeFanOut` batches `1..100` questions into exactly one transport call, resolves only the active branch path selected by upstream answers, ignores unused branch outputs without extra calls, and reports `totalQuestions`, `evaluatedBranchIds`, and `ignoredBranchIds` (AC-2.4). `router-and-fanout.test.ts` asserts the `transportCalls` count on every path, including disabled, deadline, budget-refusal, and branch-pruning scenarios. Per REVIEW-002 the router drives `DecisionClient` through either an HTTP transport or the in-process `sdkAdapter` (counting both as transport calls), and disclosure violations in state or unapproved image assets route to the fallback with `fallbackReason: 'disclosure_violation'` and zero transport calls.
      Verify: `npm run build && tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/decisions/test/router-and-fanout.test.js`

- [x] **T5 · Decision nodes: authority boundary, capability routing, cycle alignment, soft compaction, and diff triage**
      Blocked by: T4
      Owns: `packages/decisions/src/nodes.ts`, `packages/decisions/test/nodes-and-memory-interop.test.ts`
      Gate: review
      Acceptance: `assertDecisionAuthorityBoundary` rejects all six non-delegable intents (execution authority, verification certification, adversarial-review skip, external gates, pinned-model override, hard-compaction veto) with `DECISION_AUTHORITY_VIOLATION` and `authorityViolation: true` (AC-4.1). `routeTaskCapability` returns a pinned tier/role immediately with `userOverridePreserved: true` and `transportCalls: 0`; otherwise it sends one speculative request whose Jev share is capped at `100` questions (provider limit, AC-2.1) taken from the highest-priority candidates, with remaining skills — and any low/medium-confidence or failed answers — resolved by deterministic keyword/tag matching (AC-4.2). `evaluateCycleAlignment` runs the six deterministic pre-checks first and returns `blocked` (or `needs_review` for scope/budget exhaustion) with `precheckPassed: false` and `transportCalls: 0` on any failure (AC-4.3). `evaluateSoftCompactionAdvisory` returns `compact` with `hardTriggerActive: true`, `hardTriggerVetoRefused: true`, and zero transport calls whenever `contextUtilization >= 0.80` or `failedVerificationLoops >= 2`; in the soft zone (`0.60 <= contextUtilization < 0.80`) it may advise `compact` or `defer` via Jev, and its advisory feeds `CompactionPolicyInput.advisoryDecision` of `@loopwright/memory` — the interop suite asserts against the real `evaluateCompactionPolicy` that a hard-layer outcome is never vetoed by the advisory while a soft `defer` advice vetoes soft compaction (AC-4.3). `triageCandidateDiff` batches `1..100` `noul`/`score` rules into one request, escalates rules meeting `rule.threshold ?? policy.minConfidence`, falls back to deterministic static diff matching when Jev is disabled, failing, or low-confidence, and always reports `verificationCertified: false` with `advisoryOnly: true` escalations (AC-4.4). The interop suite runs the real `evaluateCompactionPolicy` from `@loopwright/memory` with the node's advisory in `CompactionPolicyInput.advisoryDecision`, proving a hard-layer outcome is never vetoed while a soft `defer` advice vetoes soft compaction (AC-4.3). Unknown authority intents fail closed alongside the six forbidden ones, and scope or budget pre-check failures route to `needs_review` per AC-4.3.
      Verify: `npm run build && tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/decisions/test/nodes-and-memory-interop.test.js`

- [x] **T6 · Controlled offline A/B benchmark, public barrel, and architecture documentation**
      Blocked by: T5
      Owns: `packages/decisions/src/benchmark.ts`, `packages/decisions/src/index.ts`, `packages/decisions/test/benchmark.test.ts`, `docs/decisions.md`
      Acceptance: `DEFAULT_DECISION_BENCHMARK_CORPUS` fixes cases covering capability routing, cycle alignment, soft compaction, diff triage, timeout fallback, and authority-boundary rejection. `runControlledDecisionBenchmark` runs the `jev_off`, `jev_on`, and `low_confidence_fallback` arms under identical task contracts and budgets using deterministic fixture transports, and returns a `DecisionBenchmarkReport` with `evidenceScope: 'controlled_offline_fixture'`, per-arm metrics (acceptance pass rate, false-positive escalations, false-negative misses, `authorityViolationCount`, fallback rate, token totals, `unknownUsageCount`, `estimatedCostUsd`, wall time), pairwise `jevOnVsOffDelta` values, and the recommendation gate: `keep_optional_jev` only when both enabled arms report zero authority violations and `jev_on.acceptancePassRate >= jev_off.acceptancePassRate` (AC-5.1, AC-5.2). `src/index.ts` becomes the public barrel exporting the validated surface, and `docs/decisions.md` documents the policy model, disclosure enforcement, authority invariants, deadline/budget behavior, and benchmark usage in the style of the existing package docs. The full workspace gate is green.
      Verify: `npm run build && npm test && npm run lint`

Risks and mitigations:

- AC-4.2 reads as up to `255` skill checks in one request, while the provider batch limit is `1..100`
  questions (AC-2.1) → mitigation: `routeTaskCapability` caps its Jev batch at the `100` highest-priority
  skill checks and resolves the remainder deterministically; revisit the AC wording if the discrepancy
  matters in practice.
- `SecretScrubber` lives in `packages/github-app` today, not in `@loopwright/core` as AC-1.3 assumes →
  mitigation: T1 adds a minimal decision-neutral primitive to core (expand-only, nothing migrates) and the
  GitHub App copy stays untouched.
- Deadline tests can flake on real timers → mitigation: inject clocks and use `node:test` mock timers with
  immediate-resolve and never-resolve transports; no network and no sleeps in any suite.

---

## Test Plan

[x] I/we understand the owners of the involved components may require updates to existing tests to make this
code solid enough prior to committing the changes necessary to implement this enhancement.

#### Prerequisite testing updates

None — `@loopwright/decisions` is a new package and no existing suite changes behavior. T1 extends the root
`package.json` test plumbing (workspaces, build/test scripts, `tsconfig.test.json` include list) and adds
`packages/core/test/scrubber.test.ts` for the new core primitive; all existing suites stay untouched and
must stay green at every task boundary.

#### Unit tests

Every added unit carries unit coverage in `packages/decisions/test/*.test.ts` (workspace convention:
`node --test` suites compiled by `tsconfig.test.json`), measured with `node --experimental-test-coverage`
after `tsc -p tsconfig.test.json`:

- `@loopwright/core`: `2026-11-11` - `>= 95%` line coverage on the new `src/scrubber.ts` (suite
  `scrubber.test.ts`).
- `@loopwright/decisions`: `2026-11-11` - `>= 95%` line coverage across all value-bearing `src/` modules
  (`schema.ts`, `redaction.ts`, `primitives.ts`, `client.ts`, `router.ts`, `nodes.ts`, `benchmark.ts`;
  `types.ts` is types-only and `index.ts` is the barrel), with every `DecisionErrorCode` value exercised by
  at least one negative test. Suite-to-task mapping: `policy-and-redaction.test.ts` (T1),
  `primitives.test.ts` (T2), `client-and-budget.test.ts` (T3), `router-and-fanout.test.ts` (T4),
  `nodes-and-memory-interop.test.ts` (T5), `benchmark.test.ts` (T6).

#### Integration tests

No separate integration tier exists in this repository; `node --test` suites under `packages/*/test/` are
the integration surface, so the cross-package scenarios live there:

- Memory interop (`nodes-and-memory-interop.test.ts`): `evaluateSoftCompactionAdvisory` output feeds
  `CompactionPolicyInput.advisoryDecision` into the real `evaluateCompactionPolicy` from
  `@loopwright/memory`; asserts hard-trigger outcomes ignore the advisory (no veto), a soft-zone `defer`
  advice vetoes soft compaction, and a soft-zone `compact` advice participates only with positive net token
  savings.
- Client-router-node path (`client-and-budget.test.ts`, `router-and-fanout.test.ts`): deadline abort,
  retry-within-window, budget reservation/settlement/retention, and branch pruning verified across the
  composed layers over deterministic in-memory transports.

#### e2e tests

None — `@loopwright/decisions` is an in-process harness library with no CLI surface, and live network calls
in tests are an explicit non-goal; every suite runs offline against deterministic fixture transports. Real
provider behavior is represented by the fixture distributions exercised in `benchmark.test.ts`.
