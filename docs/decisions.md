# Decision routing (`@loopwright/decisions`)

`@loopwright/decisions` is the optional, policy-gated System-One decision layer of the harness. It answers
narrow, closed-world questions — capability tiering, cycle alignment, soft compaction advisories, and
candidate diff triage — through calibrated provider primitives, and never through full frontier-model
planning turns. Every call is disabled by default, redacted before send, hard-deadline supervised,
budget-reserved, and routed through a three-zone confidence gate with deterministic fallbacks.

## Opt-in policy and disclosure

Nothing leaves the repository until a taskpack sets `enabled: true` and an approved `disclosurePolicy`
(`repo-approved-redacted-evidence` or `public-metadata-only`). `validateDecisionPolicy` normalizes the
configuration and fails closed with `DECISION_POLICY_INVALID` on any out-of-range field;
`evaluateDecision` enforces a zero-call gate — a disabled or unapproved policy produces
`transportCalls: 0`, `source: 'deterministic_fallback'`, and `fallbackReason: 'policy_disabled'`.

`sanitizeDecisionState` rejects non-plain-object roots, circular references, non-finite numbers,
functions, symbols, bigints, depth over 16, serialized states over 65,536 bytes, prototype-pollution
keys (`__proto__`, `constructor`, `prototype`), forbidden raw-content keys (`rawFileContent`,
`fileBody`, `fullTranscript`, `rawTranscript`, `envDump`, `processEnv`, `privateKey`, `secret`, `token`,
`authorization`, `cookie`), and any string carrying credential-shaped material (provider API key names,
`ghs_`/`ghu_`/`ghp_`/`github_pat_` tokens, `Bearer` headers, PEM bodies, `${...}` secret templates, or
secrets registered on a structural scrubber — `{ scrub(value): string; containsSecret?(value): boolean }`
— so the core and GitHub App scrubbers both interoperate). The stricter `public-metadata-only` policy
additionally refuses diff hunk keys and any string over 512 characters. Image assets
(`png`/`jpeg`/`webp`, bounded base64) require `allowImages: true` under
`repo-approved-redacted-evidence`; anything else is a `DECISION_DISCLOSURE_VIOLATION`.

## Providers and wire dialects

Seven provider profiles share one canonical question domain across two wire dialects:

| Provider | Dialect | Default endpoint | Model | Key env |
| :--- | :--- | :--- | :--- | :--- |
| `typesafe-jev` | `systemone` | `https://api.typesafe.ai/v1/systemone` | `jev-latest` | `TYPESAFE_API_KEY` |
| `startlux-decision` | `systemone` | `https://api.bamboonode.dev/v1/systemone` | `startlux-decision-27b-autothink` | `STARTLUX_API_KEY` |
| `microsoft-decision` | `systemone` | `https://models.inference.ai.azure.com/v1/systemone` | `microsoft-decision-1` | `MICROSOFT_DECISION_API_KEY` (falls back to `AZURE_API_KEY`) |
| `perplexity-decider` | `systemone` | `https://api.perplexity.ai/v1/decisions` | `pplx-decider-v1.2` | `PERPLEXITY_API_KEY` |
| `cloudflare-clef` | `systemone` | `https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/run/@cf/cloudflare/clef` | `@cf/cloudflare/clef` | `CLOUDFLARE_API_TOKEN` |
| `liquid-d1` | `systemone` | `https://api.liquid.ai/decisions/v1/systemone` | `liquid/d1-ultra` | `LIQUID_API_KEY` |
| `openai-decisions` | `openai-decisions` | `https://api.openai.com/v1/decisions` | `gpt-6-luna` | `OPENAI_API_KEY` |

`formatProviderRequest` serializes the keyed `/v1/systemone` request (`questions` map keyed by id,
`assets`/`images` for multimodal input, StartLux deliberation controls) or the OpenAI positional request
(`predicate` binaries, 1-indexed `levels`). `parseAndValidateProviderResponse` accepts all three response
shapes — the keyed `answers` map, the OpenAI `answers` array, and the legacy positional `outputs` array —
and normalizes field aliases (`selected`, `distribution`, `expected_score`, `probability_distribution`,
`boolean` binaries, Cloudflare `{ result: ... }` envelopes, criteria-label-keyed score probabilities,
derived `confidence = max(probabilities)` when a score omits it).

## Primitives and confidence zones

`choice` questions carry `1..255` distinct options; `score` questions carry `2..10` ordered criteria
levels; `noul` (`predicate`/`boolean` aliases) is a binary probability with derived
`confidence = |2p − 1|`; `box` bounding-box questions require `allowImages` on a box-capable provider.
Provider answers must carry finite probabilities summing to `1.0 ± 1e-3`; score answers may be discrete
or continuous and normalize into `normalizedScore` in `[0, 1]`. A StartLux `none_probability` at or
above the fallback threshold (default `0.2`) or a `null` choice is out-of-distribution and routes to the
deterministic fallback regardless of confidence.

Every validated answer lands in one of three zones: `high` (`>= minConfidence`, default `0.80`) accepts
the Jev answer, `medium` (`>= confirmThreshold`, default `0.60`) returns it flagged
`confirm_or_fallback` for the caller's confirmation path, and `low` executes the deterministic fallback.

## Deadlines, retries, and budget

`DecisionClient` (exported with the `JevDecisionClient` alias) wraps every dispatch in an outer
`AbortController` timer of `policy.hardDeadlineMs` (default `5000ms`, range `100..30000`). Attempts
default to `1`; a second attempt happens only when at least 50ms of wall clock remain inside the same
deadline window — never a second timeout window and never an exponential backoff loop. HTTP errors,
unreadable bodies, and invalid payloads are post-dispatch failures and are never retried.
`DecisionBudgetTracker` reserves `ceil(bytes / 4)` estimated input tokens at `0.042` USD per Mtok before
send, refuses the call with `DECISION_BUDGET_EXCEEDED` when the budget is insufficient, settles exact
reported usage on success, and retains the reservation on any post-dispatch failure so unknown provider
consumption is never refunded. An in-process SDK adapter (`sdkAdapter`, `createSdkDecisionTransport`)
gets the identical guarantees and needs no raw HTTP `apiKey`.

## Authority boundary and nodes

`assertDecisionAuthorityBoundary` fails closed with `DECISION_AUTHORITY_VIOLATION` on any non-delegable
intent: granting execution authority, certifying verification evidence, skipping adversarial review,
approving external gates, overriding pinned models, or vetoing hard compaction. The nodes themselves are
the only legal callers:

- `routeTaskCapability` honors pinned tiers/roles immediately (`userOverridePreserved: true`) and sends
  one speculative request of at most 1 tier `choice` plus 99 skill checks; remaining candidates resolve
  by deterministic keyword matching, as do disabled, timed-out, or low/medium-confidence answers.
- `evaluateCycleAlignment` runs six deterministic pre-checks first (contract hash, base revision, lease
  epoch, writable scope, budget/cycles, hard compaction) and returns `blocked` or `needs_review` with
  zero transport calls on any failure.
- `evaluateSoftCompactionAdvisory` forces `compact` with `hardTriggerVetoRefused: true` whenever
  `contextUtilization >= 0.80` or `failedVerificationLoops >= 2`; the soft zone (`0.60..0.80`) may ask
  Jev, and the advisory feeds `CompactionPolicyInput.advisoryDecision` of `@loopwright/memory`, whose
  hard layer can never be vetoed by any advisory.
- `triageCandidateDiff` batches up to 100 `noul`/`score` review rules and escalates calibrated findings
  as `advisoryOnly: true`; `verificationCertified` is always `false`.

## Controlled benchmark

`runControlledDecisionBenchmark` runs `DEFAULT_DECISION_BENCHMARK_CORPUS` — capability routing, cycle
alignment, soft compaction, diff triage, timeout fallback, and authority rejection cases — across
`jev_off`, `jev_on`, and `low_confidence_fallback` arms under identical contracts and budgets using
deterministic fixture transports. The report carries per-arm pass rates, false-positive escalations,
false-negative misses, `authorityViolationCount`, fallback rates, token totals, unknown-usage counts,
estimated costs, and wall time, plus pairwise `jevOnVsOffDelta` values. The recommendation gate returns
`keep_optional_jev` only when both enabled arms report zero authority violations and
`jev_on.acceptancePassRate >= jev_off.acceptancePassRate`; otherwise it returns
`default_deterministic_only`. Every automated test and benchmark arm runs offline against in-memory
fixtures; live provider calls are never exercised.
