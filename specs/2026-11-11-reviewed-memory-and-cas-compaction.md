# Spec: Reviewed memory proposals, stale exclusion, and CAS compaction

Status: Shipped
Type: Feature

## Summary

Add a private `@loopwright/memory` workspace package (`packages/memory`) that manages repository-scoped active
knowledge under `.loopwright/memory/<taskpack>/`, generates and verifies post-run `MemoryProposal` artifacts across
all settled cycle outcomes without mutating primary `RunResult` verdicts, excludes expired or invalidated knowledge
from active prompt snapshots while preserving audit history, applies concurrent memory updates through optimistic
compare-and-swap (CAS) on a separate pull-request boundary, and enforces two-layer context compaction with
post-compaction memory snapshot refresh.

## Motivation

### Goals

`@loopwright/core`, `@loopwright/state`, `@loopwright/agent-pi`, `@loopwright/controller`, `@loopwright/cli`, and
`@loopwright/taskpack-runner` establish a verified task-execution loop:

1. Immutable `TaskContract` and `TaskLock` documents bind target repositories, base/source revisions, writable scopes,
   pinned `trustedContext.resources`, budgets, and required acceptance checks
   ([`packages/core/src/contracts.ts`](../packages/core/src/contracts.ts),
   [`packages/core/src/identity.ts`](../packages/core/src/identity.ts)).
2. `RunResult` already reserves a typed `memory: { status: 'not_requested' | 'pending' | 'proposed' | 'unavailable', reason: string | null }`
   observation field ([`packages/core/src/results.ts`](../packages/core/src/results.ts)), and `@loopwright/controller`
   records terminal observations and compaction attempts (`pi.compact.v1`) inside a bounded `Finalizer` budget
   ([`packages/controller/src/controller.ts`](../packages/controller/src/controller.ts),
   [`packages/controller/src/finalize.ts`](../packages/controller/src/finalize.ts),
   [`packages/controller/src/scheduler.ts`](../packages/controller/src/scheduler.ts)).
3. `@loopwright/taskpack-runner` executes full discovery, candidate validation, bounded repair, and pull-request
   publication cycles against frozen repository snapshots
   ([`packages/taskpack-runner/src/index.ts`](../packages/taskpack-runner/src/index.ts)).

However, long-running maintenance workloads require durable, verifiable cross-cycle memory and context compaction
controls that do not corrupt task contracts, leak secrets, or promote unverified model claims into facts:

- **Three-tier state separation**: Active task knowledge (`.loopwright/memory/<taskpack>/`), immutable run evidence
  (content-addressed artifacts in the run store), and mutable run execution state (`LocalRunStore` SQLite ledgers,
  leases, and private session captures) must remain strictly separated. Dumping raw chat transcripts or unverified
  summaries into a single `MEMORY.md` file pollutes future prompts with stale versions, unrun hardware claims, and
  prompt-injection payloads.
- **All settled outcomes must produce auditable observations without altering primary results**: Whether a cycle ends in
  `completed`, `no_change`, `failed`, `blocked`, `exhausted`, `expired`, `cancelled`, or `reconcile_required`, the
  memory finalizer must extract bounded observations without changing the primary `RunResult` or `VerificationResult`.
  When a cycle has no remaining model budget (`exhausted`, `expired`, or `onNoModelBudget: 'deterministic-observations-only'`),
  it must record deterministic observations and mark the proposal `pending` or `proposed` without issuing extra model
  requests or bypassing parent cycle budgets.
- **Two-phase curation and separate pull-request boundary**: Memory updates must first emit a structured
  `MemoryProposal` (`memory.json` and `memory.patch`), pass an independent deterministic verifier (`memory-schema`,
  `provenance`, `scope`, `redaction`, and `memory-review` conflict/supersession checks), and target a separate memory
  branch/pull-request payload so unreviewed knowledge is never bundled into a code candidate pull request.
- **Stale and unproven knowledge exclusion**: Expired entries (`nowMs >= expiresAtMs`), superseded entries, entries
  whose `validFor.codeFingerprint` or `validFor.upstreamVersions` no longer match the current workspace/upstream state,
  and claims backed only by `failed`, `blocked`, or `not_run` checks must be excluded from active prompt injection
  while remaining in the audit history so maintainers can trace and correct prior guidance.
- **Optimistic compare-and-swap (CAS) concurrency**: Concurrent cycles targeting the same repository memory store must
  bind to `(baseRevision, baseStoreDigest)`, rebase cleanly when entry changes are disjoint, and fail closed with
  `MEMORY_CAS_CONFLICT` when two proposals touch or supersede the same entry ID or claim key (never last-writer-wins).
- **Two-layer compaction and post-compaction memory refresh**: Context compaction must distinguish non-vetoable hard
  safety triggers (upcoming request exceeding the context window or active memory snapshot drift) from soft cost/wait
  triggers, refuse to split unpaired tool calls/results, produce a pinned 12-field structured summary, refresh active
  memory from verified non-stale entries, and restore execution state strictly from `LocalRunStore` and `ProgressStore`
  ledgers rather than natural-language summary text.

### Non-Goals

- Calling external LLM APIs, Jev decision services, or live GitHub REST/GraphQL endpoints during offline unit and
  integration tests.
- Modifying `.github/workflows` or pushing branches/pull requests to remote Git hosts.
- Allowing active memory entries or compaction summaries to expand `TaskContract.spec.scope.writable`, weaken
  `TaskContract.spec.acceptance.required`, or increase `TaskContract.spec.budgets`.
- Committing `LocalRunStore` SQLite files, owner leases, raw Pi session transcripts, or resolved credentials into
  `.loopwright/memory/`.

## Proposal

Create a workspace package `packages/memory` (`@loopwright/memory`) that implements repository-scoped memory storage,
stale/unverified knowledge exclusion, settled-run deterministic and curator-assisted `MemoryProposal` generation,
five-gate deterministic proposal verification, optimistic compare-and-swap (CAS) application on a separate pull-request
boundary, and two-layer context compaction policy evaluation with 12-field structured summaries and post-compaction
memory snapshot refresh.

### User Stories

#### Story 1

As a taskpack maintainer, I want every settled cycle (`completed`, `no_change`, `failed`, `blocked`, `exhausted`,
`expired`, `cancelled`, and `reconcile_required`) to produce a bounded `MemoryProposal` and `MemoryObservation` without
mutating the cycle's primary `RunResult` or spending exhausted model budgets, so that both successful patterns and
failure observations are captured safely across runs.

#### Story 2

As a security-conscious operator, I want every `MemoryProposal` to pass deterministic schema, provenance, writable-scope,
secret/injection redaction, and conflict/supersession checks before being applied via compare-and-swap to a separate
memory pull-request payload, so that hallucinated test passes, leaked tokens, prompt-injection sentinels, and silent
concurrent overwrites are rejected before reaching active memory.

#### Story 3

As an agent runtime operator, I want expired, superseded, fingerprint-drifted, or unproven memory entries excluded from
active prompt snapshots (including during post-compaction snapshot refresh) while preserving their audit trail, and I
want hard context-window or memory-drift conditions to trigger non-vetoable checkpointed compaction at safe tool-call
boundaries, so that agents never run with stale facts or overflow their context window.

### Core Features & Acceptance Criteria

#### 1. Three-Tier Memory Store and Entry Schema (`types.ts`, `schema.ts`, `store.ts`)

- Define the canonical `MemoryEntry` document schema (`version: 1`) stored under `.loopwright/memory/<taskpack>/`:
  - `id`: lower-case identifier (`^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$`, max `128` chars).
  - `claimKey`: stable topic key within the taskpack scope (identifier, max `128` chars) used for conflict and
    supersession detection.
  - `claim`: bounded UTF-8 text statement (`1..2048` bytes, no control characters or prompt sentinels).
  - `kind`: `'fact' | 'failure_observation' | 'invariant'`:
    - `'fact'` represents a verified positive finding backed by at least one `passed` check in `evidenceRefs`.
    - `'failure_observation'` records a verified failure pattern and its applicability conditions; a failure observation
      can never be typed or injected as a confirmed `'fact'`.
    - `'invariant'` represents a verified deterministic constraint bound to a repository file fingerprint.
  - `scope`:
    - `taskpack`: identifier matching `TaskContract.spec.taskpack`.
    - `repository`: repository slug matching `TaskContract.spec.target.repository`.
    - `paths`: non-empty sorted array of repo-relative scope patterns (`1..32` items).
    - `targetMatrix`: `null` or `{ id: string, platform: string, variant: string }`.
  - `sourceRef`: `{ runId: string, lockHash: Digest, candidateDigest: Digest }`.
  - `sourceDigest`: `Digest` (SHA-256 of the source or candidate manifest that produced the observation).
  - `verifiedAtMs`: non-negative safe integer timestamp.
  - `validFor`:
    - `baseRevision`: Git revision string.
    - `sourceRevision`: Git revision string.
    - `codeFingerprint`: `Digest` (deterministic SHA-256 over the sorted `{ path, sha256, byteLength }` manifest of the
      entry's watched `scope.paths` in the target repository).
    - `upstreamVersions`: sorted map `Readonly<Record<string, string>>` pinning upstream package/release versions for
      which the entry is valid.
  - `expiresAtMs`: positive safe integer timestamp strictly greater than `verifiedAtMs` (`expiresAtMs > verifiedAtMs`).
  - `supersedes`: sorted unique array of prior `MemoryEntry['id']` strings (`0..32` items) that this entry replaces.
  - `evidenceRefs`: non-empty array (`1..16` items) of
    `{ evidenceId: string, checkId: string, level: EvidenceLevel, observedStatus: CheckStatus, artifact: ArtifactRef }`.
- Repository layout under `<repository>/.loopwright/memory/<taskpack>/`:
  - `index.json`: canonical JSON index (`version: 1`, `taskpack`, `repository`, `updatedAtMs`, `entries: readonly MemoryEntry[]`,
    `retired: readonly RetiredMemoryEntry[]`, `storeDigest: Digest`).
  - `entries/<id>.md`: human-reviewable Markdown file with deterministic YAML/JSON metadata header and claim summary so
    standard Git diffs show additions, replacements, and retirements clearly.
  - Reject symlinks (`O_NOFOLLOW`), path traversal (`..`), files outside `.loopwright/memory/<taskpack>/`, and any
    attempt to store `.sqlite`, `run.json`, or `privateSession` artifacts inside `.loopwright/memory/`.

#### 2. Stale, Drifted, and Unproven Knowledge Exclusion (`selector.ts`)

- `selectActiveMemory(input)` evaluates a loaded memory store against `{ contract, nowMs, currentCodeFingerprint, currentUpstreamVersions, targetCell }`:
  - Excludes any entry from active injection when any of the following hold, recording `{ entryId, claimKey, reason, detail }`
    in `excludedEntries`:
    1. `expired`: `nowMs >= entry.expiresAtMs`.
    2. `superseded`: another valid active entry in the store lists `entry.id` in its `supersedes` array, or the entry
       already resides in `index.retired`.
    3. `fingerprint_mismatch`: `entry.validFor.codeFingerprint.hex !== currentCodeFingerprint.hex` (for the entry's
       `scope.paths`).
    4. `upstream_version_changed`: any key in `entry.validFor.upstreamVersions` differs from `currentUpstreamVersions[key]`.
    5. `scope_mismatch`: `entry.scope.taskpack !== contract.spec.taskpack`,
       `entry.scope.repository !== contract.spec.target.repository`, or `entry.scope.targetMatrix` does not match
       `targetCell` when non-null.
    6. `unverified_claim`: `entry.kind === 'fact'` or `'invariant'` and `entry.evidenceRefs` does not contain at least
       one `observedStatus === 'passed'` reference, or contains any `failed` reference.
    7. `hardware_or_gate_unproven`: `entry.kind === 'fact'` claims compatibility for a check whose `observedStatus` is
       `'not_run'` or `'blocked'` (for example, unexecuted CUDA/CANN/ROCm hardware cells or timed-out external gates).
  - Returns an immutable `ActiveMemorySnapshot`:
    - `version: 1`, `taskpack`, `repository`, `evaluatedAtMs`, `activeEntries` (sorted deterministically by `id`),
      `excludedEntries` (preserving full audit visibility of why each stale/invalidated entry was excluded),
      `renderedMarkdown` (bounded prompt-ready Markdown distinguishing `Verified Facts` from `Failure Observations`),
      and `snapshotDigest: Digest` (SHA-256 of the canonical snapshot).
  - Provides `bindMemorySnapshotToResource(snapshot, relativePath)` producing a `TaskContract['spec']['trustedContext']['resources'][number]`
    descriptor (`kind: 'document'`, `path`, `digest: snapshot.snapshotDigest`) and verifying that an existing contract's
    pinned memory resource digest matches the current snapshot digest.

#### 3. Settled-Outcome Memory Finalizer and `onNoModelBudget` Enforcement (`finalizer.ts`)

- `finalizeRunMemory(input)` accepts a settled cycle context (either a retained run directory `{ runRoot, runId, repository }`
  or an in-memory settled `SettledRunSummary` carrying `lock`, `result` or `incident`, `verification`, `observations`,
  `ledger`, `candidateManifest`, and `artifacts`) plus memory configuration
  `{ taskpack, memoryWritable: readonly string[], onNoModelBudget: 'deterministic-observations-only', curator?: MemoryCuratorPort | null, nowMs, ttlMs, upstreamVersions }`:
  - **Handles every settled outcome**: `completed`, `no_change`, `failed`, `blocked`, `exhausted`, `expired`,
    `cancelled`, and `reconcile_required` / `incident`.
  - **Primary outcome immutability**: `finalizeRunMemory` never mutates `RunResult.spec.status`,
    `RunResult.spec.verification`, `RunResult.spec.externalEffects`, or any checkpointed controller state. Even if a
    supplied `curator` port throws, times out, or emits invalid data, `finalizeRunMemory` catches the fault, preserves
    the primary `RunResult` byte-for-byte, and reports the failure only in the returned `MemoryFinalizerOutcome`.
  - **Budget and `onNoModelBudget: 'deterministic-observations-only'` enforcement**:
    - Inspects settled budget state (`status === 'exhausted' | 'expired' | 'cancelled' | 'reconcile_required'`, or
      `remainingTokens <= 0`, or `remainingModelCalls <= 0`, or `remainingWallMs <= 0`).
    - When no model budget remains (or no `curator` port is configured), **never invokes the `curator` port**. Instead,
      synthesizes deterministic candidate entries directly from authenticated `VerificationResult` checks and failure
      signatures:
      - Passing checks on `completed` or `no_change` runs produce `kind: 'fact'` entries bound to the check's
        authenticated `Evidence` artifact.
      - Failing or blocked checks on `failed`, `blocked`, `exhausted`, `expired`, or `cancelled` runs produce
        `kind: 'failure_observation'` entries recording the failure reason, check ID, and candidate digest.
      - When a `curator` was requested (`requireCuratorReview: true`) but skipped due to exhausted model budget, archives
        the deterministic `MemoryProposal` as `status: 'pending'` with `reason: 'no_model_budget_deterministic_only'`.
      - Otherwise emits `MemoryObservation` `{ status: 'proposed', reason: null }` along with `memory.json`
        (`MemoryProposal`) and `memory.patch` (unified diff over `.loopwright/memory/<taskpack>/`).

#### 4. Five-Gate Deterministic Memory Proposal Verifier (`verifier.ts`)

- `verifyMemoryProposal(input)` validates a `MemoryProposal` against the base `MemoryStore`, the settled run's
  `TaskLock`, `RunResult`, `VerificationResult`, resolved evidence `ArtifactRef` inventory, and secret/redaction rules
  across all five required gates (`required: ['memory-schema', 'provenance', 'scope', 'redaction', 'memory-review']`):
  1. **`memory-schema`**:
     - Validates `MemoryProposal` structure (`version: 1`, `proposalId`, `taskpack`, `repository`, `baseRevision`,
       `baseStoreDigest`, `createdAtMs`, `runId`, `lockHash`, `operations: readonly MemoryOperation[]` where each
       operation is `upsert` or `retire`), entry field bounds, and `verifiedAtMs < expiresAtMs`.
  2. **`provenance`**:
     - Verifies `proposal.runId === lock.spec.runId` and `proposal.lockHash.hex === lock.spec.lockHash.hex`.
     - Verifies every `entry.sourceRef` matches the settled run's `runId`, `lockHash`, and `candidateDigest`.
     - Verifies every `evidenceRef` in `entry.evidenceRefs` exists in the run's authenticated `VerificationResult` and
       artifact inventory with matching `checkId`, `observedStatus`, `level`, and `artifact` SHA-256 digest.
     - Rejects any `kind: 'fact'` or `'invariant'` entry when the run status is not `'completed'` or `'no_change'`, or
       when any cited check has `observedStatus !== 'passed'` (preventing failed, `blocked`, or `not_run` hardware/gate
       checks from ever being recorded as verified facts).
  3. **`scope`**:
     - Verifies all target paths in `MemoryProposal` (`index.json` and `entries/<id>.md`) and every `---`/`+++` path in
       `memory.patch` resolve strictly within `.loopwright/memory/<taskpack>/**` (`memoryWritable`) and never touch
       `TaskContract.spec.scope.writable`, `TaskContract.spec.scope.protected`, `.github/**`, or `.loopwright/policies/**`.
  4. **`redaction`**:
     - Rejects any `claim`, `reason`, or rendered Markdown containing:
       - Any caller-supplied secret value from `secretValues: readonly string[]`.
       - High-confidence credential patterns (`ghp_[A-Za-z0-9]{20,}`, `ghs_[A-Za-z0-9]{20,}`,
         `github_pat_[A-Za-z0-9_]{20,}`, `sk-[A-Za-z0-9_-]{20,}`, `Bearer [A-Za-z0-9._~+/=-]{16,}`,
         `-----BEGIN [A-Z ]*PRIVATE KEY-----`, `AKIA[0-9A-Z]{16}`).
       - Prompt-injection and contract-override markers (`/=== .*? ===/`, line-initial `REQUIRED:`, `NEVER:`,
         `SYSTEM:`, `<system>`, `</system>`, `AGENTS.override.md`, `CLAUDE.md`).
       - Disallowed control characters (`[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]`).
  5. **`memory-review` (conflict & supersession consistency)**:
     - Verifies every ID in `entry.supersedes` exists in the base `MemoryStore`'s active entries.
     - Rejects supersession cycles or duplicate operation targets within the same proposal.
     - Rejects any `upsert` whose `claimKey` and overlapping `scope` + `validFor` already exist in an active base entry
       with a different `id` unless the new entry explicitly includes that existing `id` in `entry.supersedes`
       (`MEMORY_CONFLICT_UNRESOLVED`).
- Returns a structured `MemoryVerificationReport` containing per-gate statuses
  (`'passed' | 'failed'`), diagnostic codes (`MEMORY_SCHEMA_INVALID`, `MEMORY_PROVENANCE_INVALID`,
  `MEMORY_SCOPE_VIOLATION`, `MEMORY_SECRET_LEAK`, `MEMORY_INJECTION_DETECTED`, `MEMORY_CONFLICT_UNRESOLVED`), and
  `satisfied: boolean`.

#### 5. Compare-and-Swap (CAS) Store Update and Separate Pull-Request Payload (`cas.ts`)

- `applyMemoryProposalCAS(input)` applies a verified `MemoryProposal` to `<repository>/.loopwright/memory/<taskpack>/`
  and prepares a separate pull-request payload (`apply: 'separate_pull_request'`):
  - Re-runs `verifyMemoryProposal` before acquiring or mutating store files; any failed verification gate refuses with
    zero filesystem writes.
  - Acquires an exclusive lockfile `.loopwright/memory/<taskpack>/.cas.lock` (`O_CREAT | O_EXCL | O_NOFOLLOW`, mode
    `0o600`) to prevent intra-host concurrent corruption, and always removes the lockfile in `finally`.
  - Compares the current on-disk `baseStoreDigest` and `baseRevision` against `proposal.baseStoreDigest` and
    `proposal.baseRevision`:
    - **Fast-path CAS match (`currentStoreDigest === proposal.baseStoreDigest`)**:
      - Applies `upsert` and `retire` operations, moves superseded/retired entries into `index.retired` with
        `{ entry, retiredAtMs, retiredByProposalId, supersededByEntryId }`, writes `entries/<id>.md` and `index.json`
        via atomic `0o600` temporary files + `fsync` + `rename`, and syncs the parent directory.
    - **Concurrent update detected (`currentStoreDigest !== proposal.baseStoreDigest`)**:
      - Computes the delta between the expected base store and the current store on disk.
      - If the concurrent changes touch a **disjoint** set of `entry.id` and `entry.claimKey` values, rebases the
        proposal onto the current store state, re-runs full `verifyMemoryProposal` on the merged result, and commits
        atomically with `rebased: true`.
      - If both the current store delta and the incoming proposal modify, retire, or supersede the same `entry.id` or
        `entry.claimKey` (or if `allowRebase === false`), refuses with `MEMORY_CAS_CONFLICT` and performs **zero writes**
        to `index.json` or `entries/` (preventing silent last-writer-wins overwrites).
  - Returns `MemoryCASResult` containing `applied: true`, `rebased: boolean`, `storeDigestBefore`, `storeDigestAfter`,
    and a `SeparateMemoryPullRequestSpec`:
    - `mode: 'separate_pull_request'`
    - `branchName: 'loopwright/memory/' + taskpack + '/' + proposal.proposalId`
    - `targetBranch` (e.g. `'main'`)
    - `baseRevision`
    - `title` and `body` summarizing verified additions, replacements, and retirements with evidence digests
    - `modifiedFiles: readonly { path: string, content: string, sha256: string }[]` (confined to `.loopwright/memory/<taskpack>/**`)
    - `patch: string` (unified Git diff matching `modifiedFiles`)
    - `excludesCodeCandidatePaths: true` (proving zero overlap with code candidate paths).

#### 6. Two-Layer Context Compaction Policy and Post-Compaction Memory Refresh (`compaction.ts`)

- `evaluateCompactionPolicy(input)` evaluates whether an agent session must or should compact before the next request:
  - **Hard conditions (`disposition: 'compact_now'`, `layer: 'hard'`, `vetoable: false`)**:
    1. `hard_context_window`: `nextRequestInputTokens + toolResultReserveTokens + maxOutputTokens > contextWindowTokens`.
    2. `memory_snapshot_drift`: `sessionMemorySnapshotDigest.hex !== activeMemorySnapshot.snapshotDigest.hex` (the
       active memory snapshot changed or a previously injected entry expired/drifted).
    - Hard compactions can **never** be overridden or deferred by an advisory decision hook (`advisoryDecision` is
      ignored when `layer === 'hard'`).
    - If `unpairedToolCallIds.length > 0` (a tool call has been dispatched whose tool result has not yet been paired),
      refuses immediate truncation with `disposition: 'blocked'`, `code: 'COMPACTION_UNSAFE_BOUNDARY'` so an in-flight
      tool call/result pair is never split.
    - Requires a persisted pre-compaction checkpoint (`checkpointId`, `pendingOperationIds`) before compaction executes,
      and verifies post-compaction headroom (`postCompactionEstimatedTokens + toolResultReserveTokens + maxOutputTokens <= contextWindowTokens`,
      otherwise returns `disposition: 'blocked'`, `code: 'CONTEXT_OVERFLOW_BLOCKED'`).
  - **Soft conditions (`layer: 'soft'`, `vetoable: true`)**:
    - Evaluates structured telemetry only (never resending the full conversation transcript):
      `utilizationRatio = currentContextTokens / contextWindowTokens`, `softUtilizationThreshold`,
      `recentRepeatFailureCount`, `upcomingExternalWaitMs`, and estimated net savings
      `netTokenSavings = expectedReplaySavingsTokens - summaryCostTokens - cacheRebuildCostTokens`.
    - Returns `disposition: 'compact_now'` when utilization exceeds `softUtilizationThreshold` (or during a long
      external wait after operation receipts are persisted) and `netTokenSavings > 0` (unless an optional
      `advisoryDecision === 'defer'` vetoes the soft trigger); otherwise returns `disposition: 'defer'`.
- `buildCompactionSummary(input)` and `restoreFromCompactionLedger(input)`:
  - Constructs a canonical `CompactionCheckpointSummary` (`version: 1`) containing all 12 required fields:
    1. `goal`: `{ goal: string, nonGoals: readonly string[] }`
    2. `contractHash`: `Digest` (`lock.spec.lockHash`)
    3. `currentNodeId`: `string`
    4. `checks`: `{ passed: readonly string[], failed: readonly string[], blocked: readonly string[], notRun: readonly string[] }`
    5. `evidenceRefs`: `readonly ArtifactRef[]`
    6. `modifiedFiles`: `readonly { path: string, digest: Digest }[]`
    7. `openIssues`: `readonly string[]`
    8. `forbiddenActions`: `readonly string[]`
    9. `pendingExternalOperations`: `readonly { operationId: string, kind: 'gate' | 'publication' | 'mcp', state: string }[]`
    10. `budgetLedgerRef`: `{ revision: number, remainingTokens: number, remainingModelCalls: number, remainingWallMs: number }`
    11. `activeMemorySnapshot`: `{ snapshotDigest: Digest, activeEntryIds: readonly string[], excludedEntryIds: readonly string[] }`
        (refreshed via `selectActiveMemory` at compaction time so any entry that expired or drifted is purged from the
        post-compaction prompt context)
    12. `nextAllowedActions`: `readonly string[]`
  - `restoreFromCompactionLedger` proves that after compaction (or after releasing a worker during an external wait),
    authoritative execution state (`lockHash`, `writableScope`, `remainingTokens`, `remainingModelCalls`, `nodes`, and
    `pendingExternalOperations`) is loaded strictly from the persisted ledger state (`LocalRunStore` / `ProgressStore`)
    and `ActiveMemorySnapshot`, rejecting any attempt by summary text to grant new writable paths, mark unverified
    checks as `passed`, drop pending external operation IDs, or increase remaining budgets (`COMPACTION_AUTHORITY_VIOLATION`).

### Notes / Constraints / Caveats

- Node.js `>=26.13.0` and TypeScript strict ESM (`NodeNext`); zero new third-party npm dependencies.
- Keep `packages/core`, `packages/state`, `packages/agent-pi`, `packages/controller`, `packages/cli`, and
  `packages/taskpack-runner` backwards-compatible. Placing the implementation in `packages/memory`
  (`@loopwright/memory`) preserves `@loopwright/controller`'s `installedHandlerDigests` byte inventory while cleanly
  consuming `@loopwright/core`, `@loopwright/state`, and `@loopwright/controller` types.
- All source and test filenames must use clean domain-descriptive `kebab-case` names (`types.ts`, `schema.ts`,
  `store.ts`, `selector.ts`, `finalizer.ts`, `verifier.ts`, `cas.ts`, `compaction.ts`, `index.ts`). Never use internal
  phase or ticket prefixes in filenames.

### Boundaries

- **Always:**
  - Validate every `MemoryEntry` and `MemoryProposal` through deterministic schema, provenance, scope, redaction, and
    conflict checks before any store update.
  - Exclude expired, superseded, fingerprint-mismatched, upstream-drifted, and unproven claims from active memory
    snapshots while keeping retired/excluded history auditable.
  - Keep primary `RunResult` and `VerificationResult` immutable regardless of memory finalizer success or failure.
  - Enforce `onNoModelBudget: 'deterministic-observations-only'` when cycle model budget is exhausted.
  - Use exclusive lockfiles + compare-and-swap (`baseStoreDigest`) + atomic temp-file rename (`0o600`, `O_NOFOLLOW`)
    for all memory store mutations.
- **Ask first:**
  - Changing any public type or runtime behavior in `@loopwright/core`, `@loopwright/state`, `@loopwright/agent-pi`, or
    `@loopwright/controller`.
  - Adding any third-party npm dependency.
- **Never:**
  - Bundle memory file updates into a code candidate pull request or allow memory curator operations to write outside
    `.loopwright/memory/<taskpack>/**`.
  - Promote a failed, blocked, or `not_run` check (including unexecuted hardware or external gate matrix cells) into a
    `kind: 'fact'` memory entry.
  - Write secrets, bearer tokens, private keys, raw Pi session transcripts, or SQLite state files into
    `.loopwright/memory/`.
  - Allow an advisory decision to veto a hard context-window or memory-snapshot-drift compaction, or split an unpaired
    tool call/result during compaction.
  - Parse authority, budgets, or check completion status back from natural-language compaction summary text.

### Risks and Mitigations

- **Unverified or failed run observations pollute future prompts as facts** -> `verifyMemoryProposal` cross-checks every
  `evidenceRef` against the settled `VerificationResult` and refuses any `kind: 'fact'` entry unless its cited check
  status is `'passed'` on a `'completed'` or `'no_change'` run; failures can only be recorded as
  `kind: 'failure_observation'`.
- **Stale memory survives after code or upstream release changes** -> Every `MemoryEntry` binds `validFor.codeFingerprint`
  and `validFor.upstreamVersions` plus `expiresAtMs`; `selectActiveMemory` and post-compaction refresh automatically
  exclude mismatched or expired entries.
- **Concurrent runs overwrite each other's memory updates (last-writer-wins)** -> `applyMemoryProposalCAS` verifies
  `baseStoreDigest` under `.cas.lock`, rebases only when entry IDs and `claimKey`s are disjoint, and fails closed with
  `MEMORY_CAS_CONFLICT` on any overlapping entry or claim key.
- **Memory finalizer failure corrupts or downgrades a completed code run** -> `finalizeRunMemory` treats the settled
  `RunResult` as a frozen input and confines any finalizer error to `MemoryObservation` (`status: 'unavailable'`).
- **Prompt injection or credential leak via repository memory files** -> `verifyMemoryProposal` scans all claims and
  Markdown content for caller-provided secret values, token regexes, prompt-sentinel headers (`/=== .*? ===/`,
  `REQUIRED:`, `NEVER:`), and control characters before any file is written.

## Design Details

### Commands

```bash
npm run build
npm run typecheck
npm run lint
npm test
npm --workspace @loopwright/memory test
```

### Project Structure

```text
packages/
  memory/
    package.json
    tsconfig.json
    src/
      types.ts                  # Public TypeScript interfaces for entries, proposals, CAS, and compaction
      schema.ts                 # Canonical JSON serialization, SHA-256 hashing, and strict schema validators
      store.ts                  # Repository .loopwright/memory/<taskpack>/ reader, code fingerprint, and digest helpers
      selector.ts               # Active memory selector, stale/unproven exclusion, and trustedContext binding
      finalizer.ts              # Settled-outcome memory finalizer and onNoModelBudget deterministic extractor
      verifier.ts               # Five-gate deterministic MemoryProposal verifier (schema, provenance, scope, redaction, conflict)
      cas.ts                    # Optimistic compare-and-swap (CAS) writer and separate-PR payload builder
      compaction.ts             # Two-layer compaction policy, 12-field summary builder, and ledger-only restore guard
      index.ts                  # Package barrel exports
    test/
      store-selector.test.ts    # Store layout, code fingerprinting, TTL/supersedes/drift/unproven exclusion tests
      finalizer-verifier.test.ts # All settled outcomes, onNoModelBudget, primary immutability, and 5-gate verifier tests
      cas-concurrency.test.ts   # Fast-path CAS, disjoint rebase, overlapping conflict refusal, and separate-PR boundary tests
      compaction.test.ts        # Hard/soft triggers, non-vetoable hard rule, unpaired tool guard, 12-field summary & refresh tests
docs/
  memory.md                     # Architecture and usage documentation for reviewed memory and compaction
```

### Code Style

Follow the repository's strict TypeScript ESM (`NodeNext`) conventions (`exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `noImplicitOverride`, deterministic canonical JSON hashing, and explicit error codes):

```ts
import type { ArtifactRef, CheckStatus, Digest, EvidenceLevel } from '@loopwright/core';

export type MemoryEntryKind = 'fact' | 'failure_observation' | 'invariant';

export interface MemoryEvidenceRef {
  readonly evidenceId: string;
  readonly checkId: string;
  readonly level: EvidenceLevel;
  readonly observedStatus: CheckStatus;
  readonly artifact: ArtifactRef;
}

export interface MemoryEntry {
  readonly version: 1;
  readonly id: string;
  readonly claimKey: string;
  readonly claim: string;
  readonly kind: MemoryEntryKind;
  readonly scope: {
    readonly taskpack: string;
    readonly repository: string;
    readonly paths: readonly string[];
    readonly targetMatrix: null | {
      readonly id: string;
      readonly platform: string;
      readonly variant: string;
    };
  };
  readonly sourceRef: {
    readonly runId: string;
    readonly lockHash: Digest;
    readonly candidateDigest: Digest;
  };
  readonly sourceDigest: Digest;
  readonly verifiedAtMs: number;
  readonly validFor: {
    readonly baseRevision: string;
    readonly sourceRevision: string;
    readonly codeFingerprint: Digest;
    readonly upstreamVersions: Readonly<Record<string, string>>;
  };
  readonly expiresAtMs: number;
  readonly supersedes: readonly string[];
  readonly evidenceRefs: readonly MemoryEvidenceRef[];
}
```

### Implementation Plan

Environment: local and offline (macOS arm64, Node v26.13.0, npm 11.20.0, Node's built-in test runner). Every task
keeps the full workspace build, typecheck, lint, and test suite green before its commit. No third-party dependency
is added. No public type or runtime behavior of `@loopwright/core`, `@loopwright/state`, `@loopwright/agent-pi`, or
`@loopwright/controller` changes. Where `@loopwright/core` does not export helpers the memory package needs
(pattern matching, canonical serialization, the schema-builder toolkit), `@loopwright/memory` implements equivalent
local helpers in `schema.ts` and `store.ts` in the same fail-fast style with its own diagnostic codes, so core
stays untouched. Dependencies of `@loopwright/memory`: `@loopwright/core`, `@loopwright/state`, and
`@loopwright/controller` types only.

- [x] **T1 · Memory workspace wiring, public types, and canonical schema layer**
      Blocked by: None
      Owns: root `package.json` (workspaces, `build` script), `tsconfig.test.json`,
      `packages/memory/package.json`, `packages/memory/tsconfig.json`, `packages/memory/src/types.ts`,
      `packages/memory/src/schema.ts`
      Acceptance: `@loopwright/memory` resolves in the npm workspace and compiles; `tsconfig.test.json` includes
      its sources; package conventions mirror `@loopwright/taskpack-runner` (private, `type: module`, engines
      `node: 26.13.0`, `dist` exports, workspace dependencies at `0.0.0`). `src/types.ts` declares the complete
      public surface used by every later task: `MemoryEntryKind`, `MemoryEvidenceRef`, `MemoryEntry`,
      `RetiredMemoryEntry`, `MemoryStoreIndex`, `MemoryOperation` (`upsert` | `retire`), `MemoryProposal`,
      `MemoryVerificationReport` with per-gate statuses and diagnostic codes (`MEMORY_SCHEMA_INVALID`,
      `MEMORY_PROVENANCE_INVALID`, `MEMORY_SCOPE_VIOLATION`, `MEMORY_SECRET_LEAK`, `MEMORY_INJECTION_DETECTED`,
      `MEMORY_CONFLICT_UNRESOLVED`), the seven `MemoryExclusionReason` values, `ActiveMemorySnapshot`,
      finalizer types (`SettledRunSummary`, `MemoryFinalizerConfig` with
      `onNoModelBudget: 'deterministic-observations-only'`, `MemoryCuratorPort`, `MemoryFinalizerOutcome`),
      `MemoryCASResult`, `SeparateMemoryPullRequestSpec`, and compaction types (`CompactionPolicyInput`,
      `CompactionDecision`, `CompactionCheckpointSummary` with all 12 fields, `CompactionLedgerState`).
      `src/schema.ts` provides canonical JSON serialization, SHA-256 `Digest` helpers, and strict validators for
      `MemoryEntry`, `MemoryStoreIndex`, and `MemoryProposal` enforcing the field bounds (identifier regex and
      128-char cap for `id`/`claimKey`, claim 1..2048 bytes with no control characters, sorted `paths` 1..32,
      `evidenceRefs` 1..16, sorted unique `supersedes` 0..32, `verifiedAtMs < expiresAtMs`), each rejection
      carrying a memory diagnostic code and path.
      Verify: `npm run build && npm run typecheck && npm run lint`

- [x] **T2 · Store layout, code fingerprint, and active-memory selector**
      Blocked by: T1
      Owns: `packages/memory/src/store.ts`, `packages/memory/src/selector.ts`,
      `packages/memory/test/store-selector.test.ts`, root `package.json` (appends the memory test glob to `test`)
      Acceptance: `store.ts` implements the three-tier store reader under
      `<repository>/.loopwright/memory/<taskpack>/`: `loadMemoryStore` parses `index.json` and `entries/<id>.md`
      (canonical JSON metadata between `---` fences plus the claim body), rejects symlinks (`O_NOFOLLOW`), `..`
      traversal, paths escaping the taskpack memory directory, and any `.sqlite`, `run.json`, or
      `privateSession` artifact name; `computeCodeFingerprint(repositoryRoot, paths)` returns a `Digest` over the
      sorted `{ path, sha256, byteLength }` manifest of the matched files (local matcher following the core scope
      pattern grammar); `storeDigest(index)` hashes the canonical index. `selector.ts` implements
      `selectActiveMemory`, evaluating in order and recording `{ entryId, claimKey, reason, detail }` in
      `excludedEntries`: `expired`, `superseded` (active successor or `index.retired` presence),
      `fingerprint_mismatch`, `upstream_version_changed`, `scope_mismatch` (taskpack, repository, or
      `targetMatrix` vs `targetCell`), `unverified_claim` (fact/invariant without a `passed` evidenceRef or with
      any `failed` one), and `hardware_or_gate_unproven` (fact citing only `not_run`/`blocked` checks); it
      returns the immutable `ActiveMemorySnapshot` with `id`-sorted `activeEntries`, bounded `renderedMarkdown`
      separating `Verified Facts` from `Failure Observations`, and canonical `snapshotDigest`;
      `bindMemorySnapshotToResource(snapshot, relativePath)` produces the `trustedContext.resources` descriptor
      (`kind: 'document'`, deterministic `memory.<taskpack>` id within the 64-character core identifier bound,
      `digest: snapshotDigest`) plus a check that an existing contract's pinned digest matches the current
      snapshot digest.
      Verify: `npm --workspace @loopwright/memory test`

- [x] **T3 · Settled-outcome memory finalizer and five-gate proposal verifier**
      Blocked by: T2
      Owns: `packages/memory/src/finalizer.ts`, `packages/memory/src/verifier.ts`,
      `packages/memory/test/finalizer-verifier.test.ts`
      Acceptance: `finalizer.ts` implements `finalizeRunMemory` for every settled outcome — `completed`,
      `no_change`, `failed`, `blocked`, `exhausted`, `expired`, `cancelled`, and `reconcile_required`/`incident`
      (from either a retained run directory `{ runRoot, runId, repository }` or an in-memory `SettledRunSummary`):
      passing checks on `completed`/`no_change` runs synthesize `kind: 'fact'` entries bound to the
      authenticated `Evidence` artifact; failing, blocked, or not-run checks on the other outcomes synthesize
      `kind: 'failure_observation'` entries recording the failure reason, check ID, and candidate digest;
      incidents synthesize a failure observation from the incident reference. Budget inspection
      (`status ∈ exhausted|expired|cancelled|reconcile_required`, or any remaining token/model-call/wall-ms
      budget at or below zero) or a missing curator port never invokes the curator: entries are deterministic
      only, and a requested-but-skipped curator pass archives the proposal as `status: 'pending'` with
      `reason: 'no_model_budget_deterministic_only'`; otherwise the outcome is `status: 'proposed'`,
      `reason: null`. The curator runs only with remaining budget and a configured port; a curator throw,
      timeout, or invalid emission is caught, the primary `RunResult`/`VerificationResult` stay byte-for-byte
      identical, and the failure surfaces only as `MemoryObservation` `status: 'unavailable'` with a reason.
      The emitted proposal carries `baseRevision`/`baseStoreDigest` read via `store.ts` plus `memory.json` and
      `memory.patch` (unified diff over `.loopwright/memory/<taskpack>/`). `verifier.ts` implements
      `verifyMemoryProposal` running the five gates: `memory-schema` (proposal structure, entry bounds,
      `verifiedAtMs < expiresAtMs`), `provenance` (`runId`/`lockHash` match the settled lock; every `sourceRef`
      matches run, lock, and candidate digest; every `evidenceRef` resolves in the authenticated
      `VerificationResult` and artifact inventory with matching `checkId`, `observedStatus`, `level`, and
      artifact digest; `fact`/`invariant` refused unless the run is `completed`/`no_change` and every cited
      check is `passed`), `scope` (all `index.json`, `entries/<id>.md`, and patch paths strictly inside
      `.loopwright/memory/<taskpack>/`, never touching `scope.writable`, `scope.protected`, `.github/**`, or
      `.loopwright/policies/**`), `redaction` (caller-supplied secret values; credential patterns
      `ghp_`/`ghs_`/`github_pat_`/`sk-`/`Bearer`/private-key headers/`AKIA`; injection sentinels
      `/=== .*? ===/`, line-initial `REQUIRED:`/`NEVER:`/`SYSTEM:`, `<system>`/`</system>`,
      `AGENTS.override.md`, `CLAUDE.md`; disallowed control characters), and `memory-review` (every superseded
      ID exists and is active, no supersession cycles or duplicate operation targets, and an upsert whose
      `claimKey` plus overlapping scope/validFor hits an active entry with a different ID is refused as
      `MEMORY_CONFLICT_UNRESOLVED` unless that ID appears in `supersedes`) — returning the
      `MemoryVerificationReport` with per-gate statuses and `satisfied`.
      Verify: `npm --workspace @loopwright/memory test`

- [x] **T4 · CAS store update and separate pull-request payload**
      Blocked by: T3
      Gate: review
      Owns: `packages/memory/src/cas.ts`, `packages/memory/test/cas-concurrency.test.ts`
      Acceptance: `cas.ts` implements `applyMemoryProposalCAS`: it re-runs `verifyMemoryProposal` before any
      mutation (any failed gate → refusal with zero filesystem writes), acquires
      `.loopwright/memory/<taskpack>/.cas.lock` with `O_CREAT | O_EXCL | O_NOFOLLOW` mode `0o600` (an existing
      lock refuses with `MEMORY_CAS_CONFLICT` and zero writes), and always removes the lockfile in `finally`.
      Fast path (`currentStoreDigest === proposal.baseStoreDigest` and matching `baseRevision`): applies
      `upsert`/`retire` operations, moves superseded/retired entries into `index.retired` with
      `{ entry, retiredAtMs, retiredByProposalId, supersededByEntryId }`, and writes `entries/<id>.md` and
      `index.json` via atomic `0o600` temporary files with `fsync` + `rename` plus parent-directory sync. Slow
      path: computes the delta between the expected base store and the current on-disk store; disjoint
      entry-ID and claim-key sets rebase the proposal onto the current store, re-run the full verifier on the
      merged result, and commit with `rebased: true`; any shared entry ID or claim key (or
      `allowRebase === false`) refuses with `MEMORY_CAS_CONFLICT` leaving `index.json` and `entries/`
      untouched. The returned `MemoryCASResult` carries `applied`, `rebased`, `storeDigestBefore`,
      `storeDigestAfter`, and a `SeparateMemoryPullRequestSpec` with `mode: 'separate_pull_request'`,
      `branchName: 'loopwright/memory/<taskpack>/<proposalId>'`, `targetBranch`, `baseRevision`, a title and
      body summarizing verified additions/replacements/retirements with evidence digests, `modifiedFiles`
      (path, content, sha256) confined to `.loopwright/memory/<taskpack>/**`, a unified patch matching
      `modifiedFiles` exactly, and `excludesCodeCandidatePaths: true`.
      Verify: `npm --workspace @loopwright/memory test`

- [x] **T5 · Two-layer compaction policy, 12-field summary, and ledger-only restore**
      Blocked by: T2
      Gate: review
      Owns: `packages/memory/src/compaction.ts`, `packages/memory/test/compaction.test.ts`
      Acceptance: `compaction.ts` implements `evaluateCompactionPolicy`: the hard layer (`vetoable: false`,
      `advisoryDecision` ignored) fires `hard_context_window`
      (`nextRequestInputTokens + toolResultReserveTokens + maxOutputTokens > contextWindowTokens`) and
      `memory_snapshot_drift` (`sessionMemorySnapshotDigest.hex !== activeMemorySnapshot.snapshotDigest.hex`)
      with `disposition: 'compact_now'`; with any unpaired tool call ID it refuses with `disposition: 'blocked'`,
      `code: 'COMPACTION_UNSAFE_BOUNDARY'` so an in-flight tool call/result pair is never split; it requires the
      persisted checkpoint reference (`checkpointId`, `pendingOperationIds`) as validated input and returns
      `disposition: 'blocked'`, `code: 'CONTEXT_OVERFLOW_BLOCKED'` unless
      `postCompactionEstimatedTokens + toolResultReserveTokens + maxOutputTokens <= contextWindowTokens`. The
      soft layer (`vetoable: true`) consumes structured telemetry only — `utilizationRatio`,
      `softUtilizationThreshold`, `recentRepeatFailureCount`, `upcomingExternalWaitMs` once operation receipts
      are persisted, and `netTokenSavings = expectedReplaySavingsTokens - summaryCostTokens -
      cacheRebuildCostTokens` — returning `compact_now` on threshold breach or long external wait with positive
      net savings unless `advisoryDecision === 'defer'`, else `defer`. `buildCompactionSummary` constructs the
      canonical `CompactionCheckpointSummary` with all 12 fields (goal/nonGoals, `contractHash` =
      `lock.spec.lockHash`, `currentNodeId`, check buckets `passed`/`failed`/`blocked`/`notRun`, `evidenceRefs`,
      `modifiedFiles`, `openIssues`, `forbiddenActions`, `pendingExternalOperations`, `budgetLedgerRef` with
      revision and remaining token/model-call/wall budgets, `activeMemorySnapshot` refreshed through
      `selectActiveMemory`, `nextAllowedActions`) plus its digest. `restoreFromCompactionLedger` rebuilds
      execution state (`lockHash`, writable scope, remaining budgets, nodes, pending external operations)
      strictly from the persisted ledger view plus `ActiveMemorySnapshot` and raises
      `COMPACTION_AUTHORITY_VIOLATION` when summary text would grant a new writable path, mark an unverified
      check `passed`, drop a pending external operation ID, or increase a remaining budget.
      Verify: `npm --workspace @loopwright/memory test`

- [x] **T6 · Barrel exports, architecture documentation, and full workspace verification**
      Blocked by: T3, T4, T5
      Owns: `packages/memory/src/index.ts`, `docs/memory.md`
      Acceptance: `index.ts` exports the public API — `computeCodeFingerprint`, `loadMemoryStore`,
      `selectActiveMemory`, `bindMemorySnapshotToResource`, `finalizeRunMemory`, `verifyMemoryProposal`,
      `applyMemoryProposalCAS`, `evaluateCompactionPolicy`, `buildCompactionSummary`,
      `restoreFromCompactionLedger` — with all public types. `docs/memory.md` documents the three-tier
      separation, entry schema and exclusion rules, settled-outcome finalization and `onNoModelBudget`
      behavior, the five verifier gates, CAS concurrency with the separate pull-request boundary, and
      two-layer compaction with ledger-only restore. The full workspace suite is green.
      Verify: `npm run build && npm run typecheck && npm run lint && npm test`

### Test Plan
[x] I/we understand the owners of the involved components may require updates to existing tests to make this
code solid enough prior to committing the changes necessary to implement this enhancement.

#### Prerequisite testing updates
None. The `@loopwright/core`, `@loopwright/state`, `@loopwright/agent-pi`, `@loopwright/controller`,
`@loopwright/cli`, and `@loopwright/taskpack-runner` suites stay untouched; the root `test` script only gains the
`.test-build/packages/memory/test/*.test.js` glob, appended by T2 when the first memory test file lands, so the
glob never matches an empty directory.

#### Unit tests
`@loopwright/memory`: `2026-11-11` - every exported function carries at least one positive and one negative
assertion; the project runs no coverage instrumentation, so coverage is pinned by the assertion matrix below
instead of a percentage.

`test/store-selector.test.ts`:
- Store layout: `index.json` + `entries/<id>.md` round trip; entry markdown header is canonical JSON between
  `---` fences and diffs deterministically; unknown file names under `.loopwright/memory/<taskpack>/` rejected.
- Store rejection: `..` traversal; absolute path; symlinked entry file and symlinked directory (`O_NOFOLLOW`);
  `.sqlite`, `run.json`, `privateSession` names refused.
- `computeCodeFingerprint`: stable across identical trees; sensitive to a one-byte content change; sensitive to
  a path-set change; independent of insertion order; defined digest over an empty match set.
- `selectActiveMemory`: one positive and one negative case per exclusion reason (`expired`, `superseded` via
  successor and via `retired` presence, `fingerprint_mismatch`, `upstream_version_changed`, `scope_mismatch`
  for taskpack/repository/targetMatrix, `unverified_claim`, `hardware_or_gate_unproven`); exclusion record
  shape `{ entryId, claimKey, reason, detail }`; `activeEntries` sorted by `id`; `snapshotDigest` canonical and
  stable; `renderedMarkdown` bounded and split into `Verified Facts` / `Failure Observations` with failure
  observations never rendered as facts.
- `bindMemorySnapshotToResource`: descriptor shape (`kind: 'document'`, path, digest); digest binding matches an
  unchanged snapshot and rejects a drifted one; id stays within the core identifier bound.

`test/finalizer-verifier.test.ts`:
- Finalizer outcomes: deterministic entries for `completed`, `no_change` (facts from passed checks), `failed`,
  `blocked`, `exhausted`, `expired`, `cancelled`, `reconcile_required`, and an incident input (failure
  observations carrying check ID, reason, candidate digest).
- `onNoModelBudget: 'deterministic-observations-only'`: curator port present with exhausted/expired budget or
  non-positive remaining tokens/calls/wall-ms → curator never invoked (invocation spy); with
  `requireCuratorReview` the proposal is archived `pending` with `no_model_budget_deterministic_only`; without
  a curator request the outcome is `proposed`.
- Curator path: invoked only with remaining budget and configuration; valid emission produces the proposal;
  thrown, timed-out, or invalid emission keeps the primary `RunResult`/`VerificationResult` byte-identical
  (deep equality against a structured clone taken before the call) and reports `MemoryObservation`
  `unavailable` with a reason.
- Verifier gates: one passing proposal crosses all five gates; targeted rejections per diagnostic code —
  bound violations and `verifiedAtMs >= expiresAtMs` (`MEMORY_SCHEMA_INVALID`); mismatched `runId`/`lockHash`/
  `sourceRef`, forged evidence digest, unknown check reference, `fact` on a failed run or citing a non-`passed`
  check (`MEMORY_PROVENANCE_INVALID`); patch path escaping the memory directory, `.github/**` touch,
  `scope.protected` touch (`MEMORY_SCOPE_VIOLATION`); pasted token, private-key header, `AKIA` key, caller
  secret value, `REQUIRED:` sentinel, `<system>` tag, control character (`MEMORY_SECRET_LEAK`,
  `MEMORY_INJECTION_DETECTED`); unknown `supersedes` ID, supersession cycle, duplicate operation target,
  overlapping claimKey without explicit supersession (`MEMORY_CONFLICT_UNRESOLVED`); `satisfied` is false on
  every failure.

`test/cas-concurrency.test.ts`:
- Fast path: proposal applies under a matching `baseStoreDigest`; `entries/<id>.md` and `index.json` written;
  retired rows carry `retiredAtMs`/`retiredByProposalId`/`supersededByEntryId`; `storeDigestAfter` matches the
  reloaded store.
- Refusals with zero writes: failed verification gate; pre-existing `.cas.lock`; overlapping concurrent
  change; `allowRebase: false`; on-disk `index.json` and `entries/` byte-identical after each refusal.
- Rebase: concurrent disjoint proposal → `rebased: true`, both entries present, merged store re-verified.
- Lock hygiene: lockfile removed after success, after refusal, and when the apply throws mid-way.
- Atomicity: `0o600` modes on written files; no leftover temporary files after success and failure; a simulated
  mid-write failure leaves the prior store intact.
- Separate PR payload: branch-name pattern; `modifiedFiles` confined to `.loopwright/memory/<taskpack>/`;
  unified patch matches `modifiedFiles` exactly (exact-string fixture); `excludesCodeCandidatePaths: true`;
  title/body carry evidence digests.

`test/compaction.test.ts`:
- Hard triggers: window overflow fires with `vetoable: false`; snapshot drift fires; both ignore
  `advisoryDecision: 'defer'`.
- Unsafe boundary: any unpaired tool call ID → `blocked` + `COMPACTION_UNSAFE_BOUNDARY`; empty list → never
  blocked for that reason.
- Overflow guard: post-compaction estimate exceeding headroom → `blocked` + `CONTEXT_OVERFLOW_BLOCKED`.
- Soft layer: utilization above threshold with positive net savings → `compact_now`; negative net savings →
  `defer`; utilization below threshold → `defer`; long external wait with persisted receipts → `compact_now`;
  `advisoryDecision: 'defer'` vetoes soft only; the evaluation consumes no conversation transcript.
- `buildCompactionSummary`: all 12 fields present and correctly sourced; canonical serialization deterministic;
  refreshed `activeMemorySnapshot` matches a fresh `selectActiveMemory` evaluation with a newly expired entry
  purged.
- `restoreFromCompactionLedger`: restores lock hash, writable scope, remaining budgets, nodes, and pending
  operations from the ledger fixture; one assertion each for the four summary-granted violations
  (`COMPACTION_AUTHORITY_VIOLATION`).

#### Integration tests
The four memory suites double as cross-module integration coverage; no separate suite is added:
- Finalize → verify → CAS apply → reload → select: `cas-concurrency.test.ts` re-loads the applied store through
  `store.ts` and evaluates it through `selectActiveMemory`.
- Settled summary → proposal → gates: `finalizer-verifier.test.ts` feeds finalizer output directly into
  `verifyMemoryProposal`, including its rejection paths.
- Compaction summary → refresh → restore: `compaction.test.ts` feeds `selectActiveMemory` output into the
  summary and restore paths.
- Controller/state integration (checkpoint schedule, SQLite ledgers) remains the existing controller
  qualification boundary; `@loopwright/memory` consumes only types from those packages.

#### e2e tests
None. All accepted behavior is local and deterministic (file system, hashing, pure policy evaluation); the spec's
non-goals exclude external LLM, GitHub, and hardware surfaces, and no browser or network UI exists. The offline
full-suite gate (`npm test`) is the end-to-end boundary for this feature.

## Alternatives

- **Single mutable `MEMORY.md` updated in-place by the coding agent during code generation**: Rejected because it mixes
  unreviewed model assertions into the code candidate pull request, lacks per-entry provenance or TTL/fingerprint
  invalidation, and allows failed or unrun checks to persist as facts.
- **Last-writer-wins file overwrites for concurrent memory runs**: Rejected because concurrent taskpack runs on the
  same repository would silently clobber each other's verified observations without conflict detection or re-validation.
- **Modifying `@loopwright/controller` internal checkpoint schedule to add model-driven finalizer turns**: Rejected
  because `Finalizer` in [`packages/controller/src/finalize.ts`](../packages/controller/src/finalize.ts) is intentionally
  bounded (`<= 5000ms`, `<= 1 MiB`, no extra model allowance) so memory curation can never destabilize or rewrite the
  settled primary `RunResult`. Placing the two-phase memory finalizer, verifier, and CAS applier in `@loopwright/memory`
  preserves `@loopwright/controller`'s deterministic checkpoint schedule and handler digest inventory.

## Open Questions

None.
