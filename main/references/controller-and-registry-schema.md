# Controller and Registry Reference

Evidence: contract.

Machine-readable field, bound, enum, interpolation, and hook dictionary for `TrustedRegistry`, `ControllerConfig`, and `DecisionPolicy` documents (`apiVersion: loopwright.dev/v1alpha1`).

## Contents

- [Registry and handlers](#registry-and-handlers)
- [Profiles and MCP bounds](#profiles-and-mcp-bounds)
- [Credentials and interpolation](#credentials-and-interpolation)
- [ControllerConfig bounds](#controllerconfig-bounds)
- [Hardware gate settlement](#hardware-gate-settlement)
- [DecisionPolicy schema](#decisionpolicy-schema)
- [Advisory port hooks](#advisory-port-hooks)

## Registry and handlers

Store `TrustedRegistry` (`registry.yaml`, `metadata.name` `1..64` chars) outside `cwd`, outside `dirname(controller.yaml)`, and outside `--repo` (`REGISTRY_UNTRUSTED` otherwise). Top-level `spec` requires `version: 1`, `resourceVersion`, `handlers`, `roleProfiles`, `resources`, `runtimeProfiles`, `credentialBindings`, and `environmentBindings`; `gateEndpoints` and `publicationEndpoints` are optional (`0..16` items).

| Implementation | `kind` | Required `capabilities` | Required `parameters` keys |
| --- | --- | --- | --- |
| `pi.agent.v1` | `agent` | `['pi']` | `prompt` (string), `purpose` (`'task'` or `'review'`) |
| `pi.compact.v1` | `agent` | `['pi', 'compaction']` | `{}` (empty mapping; cannot target delegated roles) |
| `scope.v1` | `check` | `['inert_bytes', 'read_only']` | `checkId` (identifier or `null` for implicit guard) |
| `json-artifact.v1` | `check` | `['inert_bytes', 'read_only']` | `checkId`, `path`, `required` (key list), `equals` (scalar map) |
| `json-keys-guard.v1` | `check` | `['inert_bytes', 'read_only']` | `checkId`, `path`, `allowedPointers` (JSON pointer list) |
| `line-section-guard.v1` | `check` | `['inert_bytes', 'read_only']` | `checkId`, `path`, `startMarker`, `endMarker` |
| `no-change.v1` | `check` | `['inert_bytes', 'read_only']` | `checkId` (identifier or `null` for implicit comparison) |
| `gate.v1` | `check` | `['external_service', 'read_only']` | `checkId`, `endpointRef` (`gateEndpoints[].id`), `gateId` |
| `benchmark-gate.v1` | `check` | `['hardware_execution', 'read_only']` | `checkId`, `endpointRef`, `gateId`, `heldOutWorkloadId`, optional `maxPreemptions` (`0..16`) |

## Profiles and MCP bounds

### Role and runtime fields

`roleProfiles[]` accepts `adapter: 'pi'` or `'delegated'`. Secret-free delegated profiles set `runtimeRef: null`, `providerCredentialRef: null`, and `mcp: null`, defaulting `context` to `DEFAULT_DELEGATED_CONTEXT`. Unattended `run`/`resume` refuse active or parked delegated roles (`CAPABILITY_UNSUPPORTED`). `ControllerConfig.spec.profiles.roles[]` accepts optional `selection` (`provider`, `model`, `thinking`); CLI `--role-model` takes precedence and persists in `run.json`.

| Field path | Required | Values and bounds | Meaning |
| --- | --- | --- | --- |
| `roleProfiles[].id` | Yes | Identifier (`1..64` chars) | Unique role profile ID referenced by `ControllerConfig` |
| `roleProfiles[].selection` | Yes | `{ provider, model, thinking, api, customProvider? }` | `thinking`: `off..max`; `api`: `anthropic-messages`, `openai-completions`, `openai-responses` |
| `roleProfiles[].tools` | Yes | Subset of `read`, `write`, `edit`, `bash`, `codemode`, `mcp__workspace__read_file` | Host-approved tool ceiling for bound task roles |
| `roleProfiles[].runtimeRef` | Yes | `runtimeProfiles[].id` or `null` for delegated | Binds a Pi role to a verified runtime identity |
| `roleProfiles[].providerCredentialRef` | Yes | `credentialBindings[].id` or `null` | Selects the `provider` credential injected into the broker |
| `roleProfiles[].limits` | No | Positive integer map | Optional `promptBytes`, `responseBytes`, `toolArgsBytes`, `toolResultBytes`, `sessionBytes`, `fileBytes`, `candidateEntries`, `toolWallMs` |
| `runtimeProfiles[].id` | Yes | Identifier (`1..64` chars) | Unique runtime profile ID |
| `runtimeProfiles[].dockerExecutable` / `dockerSocket` | Yes | Absolute host paths | Verified container binary and UNIX socket paths |
| `runtimeProfiles[].identity` | Yes | `sdkIntegrity`, `graphDigest`, `imageDigest`, `configDigest`, `profile: 'linux/arm64'` | Cryptographic runtime lock from `describePiAdapterFiles()` and `package-lock.json` SHA-256 |

### Context and MCP fields

| Field path | Required | Values and bounds | Meaning |
| --- | --- | --- | --- |
| `context.mode` | No | `'proven_bound'` (default) or `'estimated_guard'` | Strict pre-send byte proof vs. estimated window guard |
| `context.estimator` | Yes | `'lw-pi-final-json-bytes-v1'` | Deterministic JSON request byte estimator |
| `context.proofId` / `version` / `evidence` | Yes | `proofId: null`, `version: 1`, `evidence: 'estimated'` | Estimator protocol metadata required by Pi adapter |
| `context.workingWindowCeiling` / `maxRequestBytes` | Yes | Integer `1 .. 16777216` bytes | Retained window and outbound HTTP request byte ceilings |
| `context.serviceMargin` / `toolReserve` | Yes | `>= 32768` bytes / `>= 16384` bytes | Reserved framing and tool result margins |
| `context.maxOutputTokens` | Yes | Integer `1 .. 262144` tokens | Per-call output token ceiling enforced by the adapter |
| `mcp` (local script mode) | Conditional | `serverId: 'workspace'`, `scriptDigest`, `names`, `effects`, `idleTimeoutSeconds: 1..2`, `absoluteTimeoutSeconds: idle..10` | Verifies local MCP helper against `localMcpScriptDigest` |
| `mcp` (remote HTTP mode) | Conditional | Replaces `scriptDigest` with `transport: 'sessionless-http-json-v1'`, `destinationRef`, `endpoint`, `approvedAddresses` (`1..4` IPs), `credentialRef` | Requires `https://<hostname>/mcp` or `http://127.0.0.1:<port>/mcp` with pinned IPs |

## Credentials and interpolation

Secrets resolve in memory into a `CredentialVault` (`vault.assertClean` aborts if raw secret bytes appear in serialized config or state). `${NAME}` (`[A-Za-z_][A-Za-z0-9_]*`) expands in a single pass (`<= 16 KiB` per string) before `TaskContract` validation:

- **Escape & non-execution**: Write `$$` for a literal `$` (`$${NAME}` stays `${NAME}`). Shell `$(...)`, `!command`, and `${NAME:-default}` never execute (`CONFIG_ENV_SYNTAX`).
- **JSON Pointer allowlist**: Every `${NAME}` must match `TrustedRegistry.spec.environmentBindings[]` at that exact JSON Pointer (`CONFIG_ENV_DENIED` if unlisted, `CONFIG_ENV_MISSING` if unset). `credential` is restricted to `/spec/credentials/<n>/template`; `nonsecret` injects values such as `/spec/task/spec/target/sourceRevision`.

| Field path | Required | Values and bounds | Meaning |
| --- | --- | --- | --- |
| `credentialBindings[].id` | Yes | Identifier (`1..64` chars) | Unique credential ID referenced by profiles or endpoints |
| `credentialBindings[].consumer` | Yes | `'provider'` \| `'mcp'` \| `'gate'` \| `'publisher'` | Subsystem restriction for resolved secret |
| `credentialBindings[].destinationRef` | Yes | Identifier (`1..64` chars) | Target service identifier bound to the credential |
| `credentialBindings[].environmentNames` | Yes | Env var list (`[A-Za-z_][A-Za-z0-9_]*`) | Host environment variables permitted inside `template` |
| `credentialBindings[].template` | Yes | Template string (`${ENV_VAR}`) | Secret assembly pattern matched identically in `ControllerConfig.spec.credentials` |
| `environmentBindings[].name` / `classification` | Yes | Env var name / `'credential'` \| `'nonsecret'` | Approved host variable and scrubbing classification |
| `environmentBindings[].paths` | Yes | JSON pointer list | Exact `ControllerConfig` paths allowed to reference `name` |
| `gateEndpoints[]` (`0..16`) | No | `id`, `url`, `signingCredentialRef` (`gate`), `authCredentialRef \| null` | `https://` or loopback URL without credentials/queries/`#`; `timeoutMs`/`maxPollMs` `1000..3600000`, `pollInitialMs` `100..30000`, `jitter` `0..1000` |
| `publicationEndpoints[]` (`0..16`) | No | `id`, `url`, `signingCredentialRef` (`publisher`), `authCredentialRef \| null`, `timeoutMs: 1000..300000` | HTTP PR publication service binding |

## ControllerConfig bounds

| Field path | Required | Bounds and values | Meaning |
| --- | --- | --- | --- |
| `spec.task` | Yes | Complete `TaskContract` object | Embedded task contract JCS-hashed into run lock |
| `spec.registry.name` / `digest` | Yes | Registry `metadata.name` + 64-char SHA-256 | Must match `registry.yaml` bytes and `--registry-sha256` |
| `spec.profiles.roles` / `steps` | Yes | `0..16` `{ roleId, profileRef, selection? }` / `{ stepId, handlerRef }` | Bridges `TaskContract` roles and steps to `TrustedRegistry` |
| `spec.credentials` | Yes | `{ ref, template }` list (`[]` if none) | Credential templates interpolated from approved env vars |
| `controls.drainReserveMs` | Yes | `5000 .. 600000` ms (`< budgets.wallTimeMs`) | Time reserved before `wallTimeMs` to drain and persist state |
| `controls.maxAttempts` / `repeatFailureLimit` | Yes | `1 .. 64` / `2` | Execution/repair ceiling and identical-signature stop bound |
| `controls.submission` | Yes | `mode: 'artifact_or_assistant'`, `path: null \| relative` | Candidate output source rule |
| `spec.publication` | No | Default `{ mode: 'disabled' }`; or `pull_request` with `endpointRef`, `targetBranch`, `headBranchPrefix`, `titleTemplate` | Publication target configuration |

## Hardware gate settlement

- **Bidirectional hardware binding**: `compilePlan` requires `hardware_execution` checks to bind `benchmark-gate.v1` with a hardware `targetCellId`, and `benchmark-gate.v1` slots to target `hardware_execution` (`CAPABILITY_UNSUPPORTED` or `CONFIG_SCHEMA`).
- **CAS staging & ingestion**: Controller stages candidate blobs (`PUT /v1/benchmark/jobs/:operationId/blobs/:sha256`), verifies HMAC verdicts, and pulls `.loopwright-verifier/<slotId>/*` blobs (`O_NOFOLLOW`, `nlink === 1`, `0o400`, binary `SecretScrubber` reject).
- **Preemption vs failure**: Threshold misses settle `failed` (allowing repair). Exhausted preemption or poll expiry on a preempted job settles `BENCHMARK_PREEMPTED` as `blocked` (non-preempted poll expiry settles `GATE_TIMEOUT`) with zero `implementationRepair` or `onRework`.
- **Reconciliation**: `loopwright reconcile` verifies local or pulled CAS blobs and settles a signed `benchmark_verdict` receipt only before `resumeCycle` settles timeout.

## DecisionPolicy schema

Standalone `DecisionPolicy` (`decisions.yaml`) requires `apiVersion`, `kind`, `spec` while all `spec.*` keys default cleanly (`disclosurePolicy` defaults `'disabled'`). Nested `Taskpack` `spec.decisions` requires `enabled` and defaults `disclosurePolicy` to `'public-metadata-only'`. Policies with `confirmThreshold > minConfidence` fail `DECISION_POLICY_INVALID`.

### Policy fields and zones

| Field path | Default | Bounds and scope |
| --- | --- | --- |
| `spec.enabled` | `false` | Required in `Taskpack` `spec.decisions`; optional in standalone `decisions.yaml` |
| `spec.disclosurePolicy` | `'disabled'` / `'public-metadata-only'` | `'disabled'` (`0` B), `'public-metadata-only'` (`<= 512` chars), `'repo-approved-redacted-evidence'` (`<= 64 KiB`) |
| `spec.provider` | `'typesafe-jev'` | Target provider adapter and wire dialect |
| `spec.minConfidence` / `confirmThreshold` | `0.8` / `0.6` | `minConfidence` in `0.5..1.0`; `confirmThreshold` in `0.0..1.0` (`<= minConfidence`); zones: `act` (`>= minConfidence`), `confirm`, `escalate` (`< confirmThreshold`) |
| `spec.hardDeadlineMs` / `maxAttempts` | `5000` / `1` | `100..30000` ms shared deadline; `1` or `2` attempts |
| `spec.allowImages` | `false` | Permits image inputs and `box` primitive (`choice <= 255` options, `score 2..10` criteria, `noul 0.0..1.0`) |
| `spec.triageRules` | Unset | `Taskpack` `spec.decisions` only: `0..100` `{ id, description, severity, kind, threshold? }` |
| `spec.endpoint` / `spec.model` | Provider default | Standalone `DecisionPolicy` only: custom `http(s)://` URL and model override |
| `spec.fallbackRole` / `onFallbackUnavailable` | `null` / `'blocked'` | Standalone only: fallback role ID and `'blocked' \| 'deterministic_default'` |
| `spec.startluxOptions` | `null` | Standalone only: `{ thinkMode, thinkBudget, gate, allowNone }` tuning |

### Providers

| Provider | Wire dialect | Default model | Secret variable |
| --- | --- | --- | --- |
| `typesafe-jev` | `systemone` | `jev-latest` | `TYPESAFE_API_KEY` |
| `openai-decisions` | `openai-decisions` | `gpt-6-luna` | `OPENAI_API_KEY` |
| `startlux-decision` | `systemone` | `startlux-decision-27b-autothink` | `STARTLUX_API_KEY` |
| `microsoft-decision` | `systemone` | `microsoft-decision-1` | `MICROSOFT_DECISION_API_KEY` |
| `perplexity-decider` | `systemone` | `pplx-decider-v1.2` | `PERPLEXITY_API_KEY` |
| `cloudflare-clef` | `systemone` | `@cf/cloudflare/clef` | `CLOUDFLARE_API_TOKEN` |
| `liquid-d1` | `systemone` | `liquid/d1-ultra` | `LIQUID_API_KEY` |

## Advisory port hooks

`ControllerPorts.decisions` exposes `AdvisoryDecisionPort`. Every result stamps `advisoryOnly: true` and `verificationCertified: false`, falling back deterministically (`source: 'deterministic_fallback'` or `'deterministic_heuristic'`) on missing credentials or timeouts:

| Port hook | Lifecycle point | Safety guarantee |
| --- | --- | --- |
| `routeCapabilityTier` | Role preparation | Preserves pinned role models (`userOverridePreserved: true`) |
| `evaluateCycleAlignment` | Before repair or `rejectTo` rework | Advisory route (`continue`, `revise`, `needs_review`, `blocked`) |
| `adviseSoftCompaction` | Prior to `pi.compact.v1` steps | Cannot veto active hard-compaction triggers |
| `triageCandidateDiff` | Post-capture pre-publication | Skips cleanly when `triageRules` is empty; `verificationCertified: false` |
| `advise_mutation_novelty` | Pre-compile evolution mutation | Rejects `Jaccard === 1.0` clones offline (`0` network calls); Jev `noul` in soft band |
| `route_evolution_strategy` | Pre-mutation evolution track choice | Routes `(trackId, mutationKind)` with deterministic Roofline fallback |
| `advise_cascade_escalation` | Post-smoke benchmark triage | Returns `prune`, `confirm`, or `escalate`; never bypasses multi-bucket verification |

- **Forbidden authority intents (`DECISION_FORBIDDEN_AUTHORITY_INTENTS`)**: `grant_execution_authority`, `certify_verification_evidence`, `skip_adversarial_review`, `approve_external_gate`, `override_pinned_model`, and `veto_hard_compaction` throw `DecisionError('DECISION_AUTHORITY_VIOLATION')` with `authorityViolation: true`.

---

**See also** — [Reference Hub](README.md) (flat reference routing and exact aliases) · [Controller and Registry](../docs/configuration/controller-and-registry/index.md) (human-first registry and controller guide) · [Decision Routing](../docs/configuration/decision-routing/index.md) (human-first advisory routing guide)
