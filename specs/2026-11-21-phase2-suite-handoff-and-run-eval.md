# Spec: Phase 2 multi-domain suites, compact handoffs, and deterministic run diagnostics

Status: Building
Type: Feature

## Summary

Extend Loopwright with four deterministic Phase 2 capabilities across `@loopwright/core`, `@loopwright/agent-pi`, `@loopwright/controller`, `@loopwright/taskpack`, `@loopwright/github-app`, `@loopwright/cli`, and `@loopwright/memory`. Add a declarative `.loopwright/suite.yaml` manifest (`kind: TaskpackSuite`) for multi-domain matrix resolution, pull-request comment routing, and stateless cross-cycle staged promotion. Add zero-LLM section-level role handoffs and signal-driven conditional rule loading across `TaskContract`, Pi preflight, and controller execution. Add deterministic post-run health diagnostics (`RunEval`), optional isolated 3-way baseline conflict pre-alignment, and trailing-newline formatting on all `@loopwright/memory` JSON writes.

## Motivation

### Goals

Post-PR-#32 Loopwright ([`2026-11-20-decouple-taskpack-and-cas-blob-pointers.md`](2026-11-20-decouple-taskpack-and-cas-blob-pointers.md)) decouples generic declarative `Taskpack` execution in [`packages/taskpack`](../packages/taskpack) from GitHub intake and publication in [`packages/github-app`](../packages/github-app). Four operational bottlenecks remain for multi-domain repositories and multi-role workflows:

1. **Multi-domain workflow glue and two-stage promotion hacks**:
   - [`packages/taskpack/src/schema.ts`](../packages/taskpack/src/schema.ts) and [`packages/github-app/src/action.ts`](../packages/github-app/src/action.ts) load one `taskpack.yaml` per invocation.
   - Repositories with multiple independent domains must maintain custom GitHub Actions YAML, shell matrix generators, and comment-routing scripts.
   - Two-stage promotions require Stage B to wait until Stage A merges and publishes an external release. Without stage readiness gates, workflows rely on synthetic `<version>+stage-b` version suffixes.

2. **Full-file prompt bloat across multi-role DAGs and static rule sets**:
   - [`packages/controller/src/controller.ts`](../packages/controller/src/controller.ts) and [`packages/controller/src/step.ts`](../packages/controller/src/step.ts) persist upstream `nodeSubmissions`, `stepVerdicts`, and CAS candidate files. Downstream roles still cannot request bounded Markdown-heading or JSON-pointer extracts with cryptographic provenance.
   - [`packages/taskpack/src/taskpack.ts`](../packages/taskpack/src/taskpack.ts) and [`packages/agent-pi/src/preflight.ts`](../packages/agent-pi/src/preflight.ts) mount every declared instruction and skill unconditionally. Roles spend prompt budget on unrelated rules even when changes touch one subsystem or one failure class.

3. **Opaque run loops and late merge-conflict discovery**:
   - [`packages/state/src/types.ts`](../packages/state/src/types.ts), [`packages/agent-pi/src/execution.ts`](../packages/agent-pi/src/execution.ts), and [`packages/controller/src/progress.ts`](../packages/controller/src/progress.ts) persist token usage, tool receipts, check verdicts, and monotonic timestamps. Yet [`packages/controller/src/inspect.ts`](../packages/controller/src/inspect.ts) and [`packages/controller/src/report.ts`](../packages/controller/src/report.ts) do not summarize `toolRepeats`, `pingPong` loops, repair convergence, or per-role/per-step breakdowns.
   - When `sourceRevision !== baseRevision`, [`packages/controller/src/source.ts`](../packages/controller/src/source.ts) and [`packages/taskpack/src/turnkey.ts`](../packages/taskpack/src/turnkey.ts) skip pre-session 3-way merge checks. In [`packages/taskpack/src/turnkey.ts`](../packages/taskpack/src/turnkey.ts), `computeAllowedSourceRevisionCarryDelta` copies whole `sourceRevision` blobs without 3-way merging. Stale `sourceRevision` files can overwrite newer `baseRevision` edits, or conflicts surface only after spending model turns.

4. **Missing trailing newline on committed memory JSON**:
   - [`packages/memory/src/schema.ts`](../packages/memory/src/schema.ts) terminates `entries/*.md` with `\n`. However, [`packages/memory/src/cas.ts`](../packages/memory/src/cas.ts) and [`packages/memory/src/finalizer.ts`](../packages/memory/src/finalizer.ts) write `index.json` without `\n`. In addition, `unifiedFileDiff` ignores EOF-newline-only transitions. Downstream `end-of-file-fixer` hooks fail on memory pull requests without custom exclusions.

Target users are multi-domain repository maintainers, declarative workflow authors, and CI operators. Success is measured by:
- Replacing multi-domain GitHub Actions routing glue and `<version>+stage-b` hacks with `.loopwright/suite.yaml` in CLI and Actions.
- Delivering SHA-256-verified section handoffs and signal-filtered rules in Pi and `loopwright step` runs while keeping `trustedContext.discovery: 'disabled'`.
- Surfacing deterministic `RunEval` reports in `loopwright inspect` and GitHub Step Summaries.
- Detecting 3-way baseline conflicts before model probes and terminating all `@loopwright/memory` JSON files with `\n` without changing `storeDigest`.

### Non-Goals

- Adding a centralized database server, hosted dashboard UI, or cross-run external state store.
- Mutating `taskpack.yaml`, `suite.yaml`, `controller.yaml`, or `registry.yaml` automatically from `RunEval` recommendations.
- Invoking any LLM to summarize role handoffs, select conditional rules, or compute `RunEval` metrics (existing `@loopwright/decisions` hooks remain separate and optional).
- Writing synthetic unreferenced merge commits into `.git` or mutating the host checkout working tree during baseline conflict pre-alignment.
- Weakening OS sandbox isolation, SQLite lease fencing, monotonic clock guards, secret scrubbing, or `.github/workflows/**` dual-key protection.
- Adding third-party runtime npm dependencies to any workspace package.

## Proposal

Add declarative multi-domain suites, deterministic section handoffs, signal-driven rule loading, `RunEval` diagnostics, and optional 3-way baseline conflict pre-alignment. Terminate all `@loopwright/memory` JSON files with a trailing newline and emit EOF-accurate unified diffs. Preserve Loopwright's YAML-first, Git-native, deterministic execution boundaries.

### User Stories

#### Story 1
As a maintainer of a multi-domain repository, I want a declarative `.loopwright/suite.yaml` manifest to resolve scheduled matrices, route `/loopwright` PR comments to the owning domain taskpack, and gate Stage B runs on Stage A external readiness, so that I eliminate custom GitHub Actions routing workflows and `<version>+stage-b` suffix hacks.

#### Story 2
As a multi-role workflow author, I want downstream roles to receive deterministic Markdown-heading and JSON-pointer extracts from upstream role artifacts and submissions with SHA-256 provenance and byte caps, so that downstream prompts stay focused without losing auditability or read-only isolation.

#### Story 3
As a repository maintainer, I want instructions and skills to load conditionally from deterministic path globs, file extensions, and check failure signals within pre-hashed trusted budgets, so that roles avoid irrelevant prompt noise during authoring and repair turns.

#### Story 4
As an operator diagnosing automation runs, I want deterministic `RunEval` telemetry (`toolRepeats`, `pingPong`, repair convergence, per-role/per-step token and wall-time breakdown, and human-reviewed tuning hints) in `loopwright inspect` and GitHub Step Summaries, plus optional pre-run base-branch conflict detection, so that I spot loop pathologies quickly and avoid burning model tokens on conflicted branches.

#### Story 5
As a maintainer enforcing POSIX `end-of-file-fixer` hooks, I want all JSON files written by `@loopwright/memory` (including committed `index.json` files) to end with a trailing newline, so that memory pull requests pass formatting checks without custom exclusions.

### Core Features & Acceptance Criteria

#### 1. Multi-Domain `TaskpackSuite` and Stateless Staged Promotion (`@loopwright/taskpack`, `@loopwright/github-app`, `@loopwright/cli`, `action.yml`)
- Define `kind: TaskpackSuite` (`apiVersion: loopwright.dev/v1alpha1`, default path `.loopwright/suite.yaml`, capped at `65,536` bytes) in `@loopwright/taskpack` with zero imports from `@loopwright/github-app`:
  - `metadata.name`: lowercase identifier.
  - `spec.domains[]` (`1..32` entries): `{ id, taskpack, enabled?, schedules?, stage?, matrix? }`.
  - Validate every domain `taskpack` path via `O_NOFOLLOW`, `!isSymbolicLink()`, and `nlink === 1` checks under `repositoryRoot`. Require unique `domain.id`, unique `taskpack` paths, and unique loaded `manifest.metadata.name` across the suite.
  - Compute the suite-wide mandatory protected path union across `.loopwright/suite.yaml` and all peer domains' control-plane files. Enforce this union across every domain's scope validation, verification, and publication. Fail closed with `TASKPACK_MANIFEST_INVALID` if the union exceeds `128` patterns or overlaps `writable` paths.
  - When multiple domains publish pull requests to the same `targetBranch`, require pairwise prefix-disjoint `spec.publication.headBranchPrefix` values (`A` must neither equal nor prefix `B`). Fail closed with `TASKPACK_MANIFEST_INVALID` on any collision.
  - `spec.stages[]` (`0..16` entries, acyclic DAG): `{ id, dependsOn?: string[], readiness?: SuiteStageReadinessProbe[] }`.
- Stateless stage readiness evaluation in `@loopwright/taskpack`:
  - Derive stage promotion eligibility from the resolved `baseRevision` Git tree and readiness probes (`github-release`, `http-json`, `git-tag`, `git-commit`). Read Stage A's committed version blob from `baseRevision` (`<= 1 MiB`) via `versionFrom: { domain, path, jsonPointer }`. Scrub all probe outputs with `SecretScrubber`.
  - When an upstream stage has pending updates, an open PR, or a confirmed unready probe (`404` or version mismatch), resolve as `disposition: 'deferred'` (`reason: 'stage_not_ready'`). Fail closed as `blocked` on probe transport, authentication, `5xx`, or PR pagination errors. Do not write suite state files to Git.
- Pull-request comment routing and GitHub Action/App integration in `@loopwright/github-app` and [`action.yml`](../action.yml):
  - Support explicit domain commands (`/loopwright <domainId> retry|revise|status [guidance]` or domain `commentPrefixes`) and automatic `(targetBranch, headBranchPrefix)` matching.
  - On `issue_comment` payloads lacking branch metadata, fetch the pull request via the authenticated GitHub API. Require same-repository `head.repo.full_name`, matching `base.ref`, and verified `head.ref` / `head.sha`, refusing cross-fork pull requests.
  - If `<domainId>` conflicts with the pull request's owning `(targetBranch, headBranchPrefix)`, fail closed as `blocked` (`TASKPACK_SCOPE_VIOLATION`). If an untargeted comment matches zero domain prefixes, ignore or block and list valid domain IDs.
  - Bind matrix cells to `(domainId, taskpackPath, baseRevision)` and revalidate eligibility before running each matrix job. Support optional `suite` binding in [`packages/github-app/src/service.ts`](../packages/github-app/src/service.ts) with per-domain manifest digests and single-delivery fan-out deduplication.
  - Add optional `suite-path`, `domain`, and `resolve-suite-only` inputs plus `matrix` JSON output to [`action.yml`](../action.yml) and [`packages/github-app/src/action.ts`](../packages/github-app/src/action.ts).
  - Add `loopwright suite check --suite <FILE> [--repo <DIR>] [--json]` and `loopwright suite resolve --suite <FILE> [--repo <DIR>] [--event <NAME>] [--schedule <KEY>] [--comment-body <TEXT>] [--pr-head-ref <REF>] [--pr-base-ref <REF>] [--json]` in [`packages/cli/src/arguments.ts`](../packages/cli/src/arguments.ts) and [`packages/cli/src/main.ts`](../packages/cli/src/main.ts).
- **Acceptance criteria**:
  - `@loopwright/taskpack` validates `suite.yaml` with zero `@loopwright/github-app` imports. It rejects stage cycles, cross-domain control-path overlaps, and `headBranchPrefix` collisions.
  - Stage B resolves as `eligible` once Stage A merges on `baseRevision` and its readiness probe matches. Confirmed unready probes resolve as `deferred` (exit `0`), whereas probe auth or transport failures exit non-zero as `blocked`.
  - `/loopwright retry` on branch `loopwright/docs/main` routes strictly to `docs`. `/loopwright runtime revise` on `loopwright/docs/main` and cross-fork PR comments fail closed as `blocked`.

#### 2. Deterministic Section-Level Compact Handoff (`@loopwright/core`, `@loopwright/controller`, `@loopwright/taskpack`)
- Extend `TaskContract.spec.steps[]` in [`packages/core/src/contracts.ts`](../packages/core/src/contracts.ts) and `Taskpack` `spec.steps[]` / `spec.roles[]` in `@loopwright/taskpack` with optional `handoffs?: readonly StepHandoffSelector[]` (`1..16` entries on non-compaction `agent` steps):
  - Validate `fromStep` as a strict DAG ancestor of the consumer step.
  - Support three `source` kinds: `{ kind: 'artifact', path }`, `{ kind: 'submission' }`, and `{ kind: 'verdict' }`. Read artifact files (`<= 1 MiB` UTF-8) from `fromStep`'s captured epoch snapshot (`nodeCandidates[fromStep]`). Read submissions and verdicts from `fromStep` in the current `reworkEpoch`.
  - Support deterministic zero-LLM `select` modes:
    - `markdown_heading`: ATX `#`..`######` parser ignoring fenced code blocks (`` ``` `` and `~~~`). Require whitespace before closing `#` runs (`## C#` matches `C#`), match the first heading occurrence, and include subheadings unless `includeSubheadings: false`.
    - `json_pointer`: `1..32` RFC 6901 JSON Pointers (decoding `~1` / `~0` and rejecting `__proto__`, `constructor`, and `prototype`), rendered deterministically.
    - `full`: bounded UTF-8 slice.
  - Enforce per-selector `maxBytes` (`64..65,536`, default `8,192`) and per-step aggregate handoff cap (`<= 65,536` bytes). Truncate on clean UTF-8 boundaries when capped and set `truncated: true`.
  - If `required !== false` and the upstream artifact, heading, or pointer is missing, fail closed with a deterministic diagnostic. If `required === false`, emit an explicit omitted provenance record.
- Materialize verified handoff extracts identically in [`packages/controller/src/controller.ts`](../packages/controller/src/controller.ts) and [`packages/controller/src/step.ts`](../packages/controller/src/step.ts):
  - Stamp each extract with `fromAttemptId`, `reworkEpoch`, `sourceSha256`, and `extractSha256`, and scrub via `vault.assertClean`. Persist CAS-backed `handoffExtracts` metadata on `ControllerAttempt` at `role_pre` while keeping `ControllerProgress` `version: 2` backward-compatible.
  - Mount each extract as a read-only (`0o400`) context file outside the writable candidate overlay (`<= 64` total `contextFiles`). Reconstruct `contextFiles` from CAS during `resume` or `step next --reissue-lease`. Verify the base handler prompt's `[private command sha256:<hex>]` digest first, then append a bounded extract block on non-`format` dispatches.
- **Acceptance criteria**:
  - In `plan -> implement -> review`, `implement` receives only `## File Changes` and `/constraints` from `plan`'s captured snapshot. Sibling branch edits do not alter `plan`'s snapshot. Code-fenced `#` lines are ignored, `## C#` preserves `#`, and `0o400` provenance survives `--reissue-lease` recovery.
  - Declaring `fromStep` on a non-ancestor step fails schema validation with `GRAPH_CYCLE` / `REFERENCE_UNKNOWN`.

#### 3. Signal-Driven Conditional Rule Loading (`@loopwright/core`, `@loopwright/agent-pi`, `@loopwright/controller`, `@loopwright/taskpack`)
- Extend `TaskContract.spec.trustedContext.resources[]` in [`packages/core/src/contracts.ts`](../packages/core/src/contracts.ts) with optional `when?: ResourceActivationRule`:
  - Supported deterministic predicates: `changedPaths` (validated non-empty scope globs), `extensions` (normalized `.ext` suffixes), `phases` (`'author' | 'review' | 'repair' | 'rework'`), `failedChecks` (check IDs), and `failureCodes` (check/verifier reason codes).
  - Combine specified fields within `when` via logical `AND`, and combine items within each list field via logical `OR`. Resources without `when` remain unconditional.
  - Allow `Taskpack` `spec.instructions`, `spec.skills`, and `spec.roles[].instructions` / `skills` to accept plain path strings or `{ path, when }` objects. Reject conflicting `when` predicates declared for the same normalized `path` across a manifest with `TASKPACK_MANIFEST_INVALID`.
- Preserve compile-time integrity, Pi snapshot recovery, and budget bounds:
  - Normalize `{ path, when }` entries in `digests.lock.json` (`collectTaskpackDigestTargets`) and mandatory protected-path sets. Pre-hash every conditional resource into `TaskContract.spec.trustedContext.resources` at compile time (`trustedContext.discovery` stays `'disabled'`). Validate worst-case aggregate byte ceilings (`256 KiB`) at compile time.
  - Keep `PlannedRole['policy']['resources']` pinned to the full 4-field `ResourceIdentity` list (stripping `when`). This preserves `nativeSessionId` and `recoverSnapshot` digests in [`packages/agent-pi/src/recovery.ts`](../packages/agent-pi/src/recovery.ts) across `implementation` repairs and `compaction`.
  - Update [`packages/agent-pi/src/preflight.ts`](../packages/agent-pi/src/preflight.ts) and [`packages/controller/src/config.ts`](../packages/controller/src/config.ts) to strip `when` during `ResourceIdentity` matching. Allow `PiOpenInput.resources` to pass an ordered verified subset for `systemPrompt` rendering while preserving `maxRequestBytes` checks.
  - Evaluate `when` deterministically in [`packages/controller/src/controller.ts`](../packages/controller/src/controller.ts) and [`packages/controller/src/step.ts`](../packages/controller/src/step.ts) before each non-`format` dispatch. Phase precedence is: `format` mounts zero conditional rules; `implementation` -> `'repair'`; active rework -> `'rework'`; reviewer -> `'review'`; else `'author'`. Match candidate changed/deleted paths (or initial `watchedPaths`) and failed check receipts, and persist `activatedResourceIds` at `role_pre`.
- **Acceptance criteria**:
  - Conditional rules stay unmounted on unrelated initial turns. They mount automatically during `implementation` repair when matching paths or failed checks appear, without breaking Pi `recoverSnapshot` restoration.
  - Altering an inactive conditional rule file on disk after `pinDigests: true` lockfile sync fails closed at intake before execution.

#### 4. Deterministic `RunEval` Diagnostics and Optional Baseline Conflict Pre-Alignment (`@loopwright/controller`, `@loopwright/taskpack`, `@loopwright/github-app`, `@loopwright/cli`)
- Implement deterministic zero-LLM `evaluateRunHealth` (`RunEvalReport`) in `@loopwright/controller`:
  - Read from one consistent `journal(store)` revision, `ControllerProgress`, `native-outcome` records, and `events.jsonl`. Bound tool receipt reads to `<= 4 KiB` (`local-tool-v1`), `<= 64 KiB` per artifact, and `<= 2 MiB` total:
    - `toolRepeats`: repeated failing tool calls keyed by `(roleId, stepId, tool, target)` (`count >= 2`) and circuit-breaker status (`'none' | 'max_turns' | 'consecutive_tool_errors' | 'no_progress' | 'unavailable'`). Mark `adapter: 'delegated'` attempts explicitly as `toolTelemetry: 'delegated_unavailable'`.
    - `pingPong`: check signature oscillations ($S_1 \to S_2 \to S_1$), repeated identical failures, digest cycles ($D_a \to D_b \to D_a$), and repeated reworks.
    - `repairConvergence`: ordinary, `format`, `implementation`, and `rework` attempt counts, unchanged-digest repair count, failing-check delta, and `converged: boolean | null` (`null` while in progress).
    - `breakdown`: per-step and per-role tokens, `costMicrousd` (preserving `complete` vs `partial` provenance), model/tool counts, and monotonic `elapsedMs` from `CheckpointRecord.clockSample.monotonicMs` (`null` if incomplete).
    - `suggestions`: `0..8` deterministic, human-reviewed tuning hints (`autoApplied: false`), scrubbed of secrets and control bytes.
  - Export `run-eval.json` in `inspectRun` ([`packages/controller/src/inspect.ts`](../packages/controller/src/inspect.ts)) and return `runEval` on `InspectRunValue`. Render a sanitized `Run Health` section in `formatRunReport` ([`packages/controller/src/report.ts`](../packages/controller/src/report.ts)). Wire `inspected.runEval` into [`packages/cli/src/main.ts`](../packages/cli/src/main.ts) and turnkey Action reports (`turnkey.ts` / `action.ts`).
- Implement optional isolated 3-way baseline conflict pre-alignment (`@loopwright/taskpack`, `@loopwright/github-app`, `@loopwright/cli`):
  - Add `spec.baselineAlignment?: { policy: 'off' | 'fail-fast' | 'extract-context', maxConflictFiles?: number, maxConflictBytes?: number }` (default `policy: 'off'`, `maxConflictFiles` `1..64` default `16`, `maxConflictBytes` `1,024..262,144` default `65,536`). Support CLI `--baseline-alignment` and Action `baseline-alignment` overrides.
  - Run baseline alignment **before** model candidate health probes when `sourceRevision !== baseRevision`. Execute `git merge-tree --write-tree` (with isolated index fallback) using a private writable `GIT_OBJECT_DIRECTORY` and read-only `GIT_ALTERNATE_OBJECT_DIRECTORIES`. Disable hooks (`core.hooksPath=/dev/null`) and renames (`merge.renames=false`) so zero objects, refs, or working-tree files mutate in the host repository:
    - Under `fail-fast`, any 3-way conflict halts immediately as `blocked` (`reason: 'baseline_merge_conflict'`) before any provider probe or model call.
    - Under `extract-context`, verify that all conflicted paths satisfy `isAllowedCandidateWrite` and stay within `maxConflictFiles` and `maxConflictBytes`. Stage scrubbed conflict hunks (`baseSha256`, `targetSha256`, `sourceSha256`, bounded conflict blocks) as a read-only resource; otherwise halt as `blocked`. Verification and publication require every extracted conflict path to be updated or deleted without residual conflict markers.
  - Keep `TaskContract.spec.target.sourceRevision` pinned to the real commit SHA. Share verified 3-way merged writable carry blobs across [`packages/taskpack/src/turnkey.ts`](../packages/taskpack/src/turnkey.ts) and [`packages/github-app/src/publisher.ts`](../packages/github-app/src/publisher.ts). Disjoint same-file edits on `baseRevision` and `sourceRevision` merge cleanly without losing `baseRevision` lines. Unmerged file conflicts fail closed before publication even when `policy: 'off'`.
- **Acceptance criteria**:
  - `loopwright inspect --json`, CLI `--output-format`, and GitHub Step Summaries emit `RunEval` metrics, per-role/per-step breakdowns, and `autoApplied: false` suggestions with zero model or network calls.
  - Under `fail-fast`, conflicted runs halt as `blocked` with zero provider probes and zero new objects in `.git/objects`. Under `extract-context`, scrubbed writable conflict hunks stage cleanly, unresolved or protected conflicts block, and disjoint same-file 3-way merges preserve both sides' edits.

#### 5. `@loopwright/memory` Trailing-Newline and LF-Aware Diff Hygiene (`@loopwright/memory`)
- Update JSON serialization and unified diff generation in [`packages/memory/src/schema.ts`](../packages/memory/src/schema.ts), [`packages/memory/src/cas.ts`](../packages/memory/src/cas.ts), and [`packages/memory/src/finalizer.ts`](../packages/memory/src/finalizer.ts):
  - Append a single trailing `\n` to `<memoryRoot>/<taskpack>/index.json` (on-disk staged writes, `MemoryModifiedFile.content`, and unified diff postimages) and `.cas.lock` while enforcing `MAX_MEMORY_INDEX_BLOB_BYTES` on the `\n`-terminated byte length.
  - Read actual bounded on-disk `index.json` preimage bytes in `cas.ts` and `finalizer.ts`. Update `unifiedFileDiff` to preserve EOF-newline state and emit `\ No newline at end of file` when migrating no-LF files.
  - Keep `storeDigestOf` and `hashDomain` in [`packages/memory/src/schema.ts`](../packages/memory/src/schema.ts) hashing JCS `canonical(...)` without `\n` so existing `storeDigest` and `proposalDigest` values remain unchanged.
  - Keep [`packages/memory/src/store.ts`](../packages/memory/src/store.ts) (`loadMemoryStore`) accepting existing `index.json` files both with and without a trailing `\n`.
- **Acceptance criteria**:
  - Every `index.json` and `.cas.lock` written by `@loopwright/memory` (and every `index.json` blob committed by separate memory pull requests) ends with `\n` (`0x0a`).
  - Legacy `index.json` files lacking `\n` load without `storeDigest` mismatch. Applying a proposal emits a `git apply`-compatible diff with `\ No newline at end of file` and rolls back byte-identically on conflict.

### Notes / Constraints / Caveats

- Enforce strict ESM TypeScript (`NodeNext`), explicit public return and parameter types, and zero `any` across all 10 workspace packages.
- Validate all untrusted JSON and YAML records including null-prototype objects (`Object.create(null)`) with `Object.hasOwn` checks and bounded collection/byte limits.
- Maintain zero imports from `@loopwright/github-app` inside `@loopwright/taskpack`, `@loopwright/controller`, `@loopwright/agent-pi`, `@loopwright/core`, `@loopwright/state`, and `@loopwright/memory`. Re-export new `@loopwright/taskpack` suite types and helpers from `@loopwright/github-app` for compatibility.
- Preserve the 23-row capability closure matrix split (`18` `closedLocal`, `5` `unprovisionedExternal`) in [`packages/cli/src/closure.ts`](../packages/cli/src/closure.ts).
- Keep all specifications, documentation, code comments, and commit messages self-contained and tool-neutral.

### Boundaries

- **Always:**
  - Validate `O_NOFOLLOW`, `!isSymbolicLink()`, `isFile()`, `nlink === 1`, and `SecretScrubber` cleanliness on every suite, handoff, rule, `RunEval`, and conflict artifact.
  - Protect `.loopwright/suite.yaml` and every peer domain's control-plane files across the entire `TaskpackSuite`.
  - Pre-register and SHA-256-pin all conditional `instructions` and `skills` in `TaskContract.spec.trustedContext.resources` at compile time (`discovery: 'disabled'`).
  - Keep `role.policy.resources` pinned to full 4-field `ResourceIdentity` entries and persist per-attempt `activatedResourceIds` and CAS `handoffExtracts` in `role_pre` checkpoints.
  - Verify the base handler prompt's `[private command sha256:<hex>]` digest before appending deterministic runtime handoff or rework sections.
  - Run baseline 3-way merge probes in a private temporary Git object directory with hooks and renames disabled before model candidate probes.
- **Ask first:**
  - Before adding any third-party runtime npm dependency to any workspace package.
  - Before changing SQLite table DDL in `@loopwright/state` or altering the `18` `closedLocal` / `5` `unprovisionedExternal` closure split.
  - Before changing `storeDigest` canonicalization domains in `@loopwright/memory`.
- **Never:**
  - Never commit or mutate a suite promotion ledger file inside target repositories or reintroduce `<version>+stage-b` version-suffix hacks.
  - Never allow `RunEval` or conditional rules to rewrite YAML manifests, bypass checks, or unlock `.github/workflows/**` without dual-key authorization.
  - Never write unreferenced synthetic merge commits to `.git` or expose conflict hunks from protected paths.
  - Never reference off-repo local files or external proprietary systems in specs, docs, code, or tests.

### Risks and Mitigations

- **Cross-domain control-path tampering** -> Mitigation: enforce the suite-wide mandatory protected path union across all domains. Refuse suites whose protected union exceeds `128` patterns.
- **Cross-domain or cross-fork PR comment hijacking** -> Mitigation: require pairwise prefix-disjoint `headBranchPrefix` per `targetBranch`. Fetch missing `issue_comment` PR branch metadata via GitHub API, require same-repo `head.repo.full_name`, and block `<domainId>` mismatches.
- **Silent promotion deferral on broken readiness probes** -> Mitigation: read `versionFrom` blobs strictly from `baseRevision` in Git. Defer only on confirmed unready states (`404` or version mismatch) and block on auth, transport, `5xx`, or pagination errors.
- **Pi `RESOURCE_MISMATCH` or snapshot `restore` `BINDING_MISMATCH` on conditional rules** -> Mitigation: keep `role.policy.resources` pinned to full 4-field `ResourceIdentity` entries. Admit ordered verified `PiOpenInput.resources` subsets in `@loopwright/agent-pi` preflight.
- **Lost handoff `contextFiles` after a crash between `role_pre` and `step-lease.json`** -> Mitigation: persist `fromAttemptId`, `nodeCandidates`, `activatedResourceIds`, and CAS `handoffExtracts` in `role_pre` progress. Reconstruct `contextFiles` from CAS during `resume` and `--reissue-lease`.
- **Markdown heading false positives or stripped trailing `#` characters** -> Mitigation: ignore lines inside `` ``` `` / `~~~` fences, require whitespace before closing `#` runs, and stamp `sourceSha256` and `extractSha256`.
- **Target line loss or `.git/objects` writes during 3-way merge** -> Mitigation: run `git merge-tree --write-tree` in a private temporary `GIT_OBJECT_DIRECTORY` before model probes. Share verified 3-way merged carry blobs across verification and publication, and require explicit conflict resolution.
- **Empty unified diffs on no-LF `index.json` migrations** -> Mitigation: read actual on-disk `index.json` preimage bytes and emit `\ No newline at end of file` in `unifiedFileDiff`.

## Design Details

### Commands

**Confirmed local environment**: macOS (`Node v26.13.1`, `npm 11.20.0`, `git 2.54.0` with `git merge-tree --write-tree`, local repository root). Run `npm ci` once in fresh worktrees before building or running tests. No remote host or external cluster is required.

```bash
# Install workspace dependencies in a fresh worktree
npm ci

# Build all 10 workspace packages
npm run build

# Run strict TypeScript checks, ESLint, docs checks, and Hugo site generation
npm run typecheck
npm run lint
npm run lint:docs
npm run site

# Compile tests and run targeted package test suites
npx tsc -p tsconfig.test.json
node scripts/run-tests.mjs --pkg core
node scripts/run-tests.mjs --pkg agent-pi --concurrency 1
node scripts/run-tests.mjs --pkg controller
node scripts/run-tests.mjs --pkg memory
node scripts/run-tests.mjs --pkg taskpack
node scripts/run-tests.mjs --pkg github-app
node scripts/run-tests.mjs --pkg taskpack-runner
node scripts/run-tests.mjs --pkg cli

# Full workspace test suite and 23-row closure verification
npm test
node packages/cli/dist/main.js closure --verify-failures --json
```

### Project Structure

```text
packages/
  core/src/
    contracts.ts          # + StepHandoffSelector on steps[], ResourceActivationRule (when) on trustedContext.resources[]
    limits.ts             # + Handoff selector, conditional rule, and suite/conflict ceiling constants
  agent-pi/src/
    preflight.ts          # Strip optional `when` for ResourceIdentity matching; admit ordered verified resource subsets
  controller/src/
    handoff.ts            # Deterministic Markdown-heading & RFC 6901 JSON-pointer extractor with SHA-256 provenance
    rules.ts              # Deterministic ResourceActivationRule evaluator over changed paths, extensions, and failed checks
    run-eval.ts           # Zero-LLM RunEval analyzer (toolRepeats, pingPong, repairConvergence, step/role breakdown, hints)
    config.ts             # Strip `when` when matching TaskContract trustedContext.resources against TrustedRegistry
    controller.ts         # Per-attempt rule filtering, CAS handoff mounting, nodeCandidates tracking, and prompt digest guard
    step.ts               # Delegated step parity and CAS-backed --reissue-lease recovery for handoffs and filtered rules
    progress.ts           # Validate optional nodeCandidates, activatedResourceIds, and handoffExtracts on version-2 progress
    inspect.ts            # Export run-eval.json in PublicBundle and attach runEval to InspectRunValue
    report.ts             # Render sanitized RunEval health summary across json, github-step-summary, markdown, and text
    types.ts              # HandoffProvenance, AttemptHandoffExtract, and per-attempt activatedResourceIds types
  memory/src/
    schema.ts             # Preserve EOF-newline transitions (`\ No newline at end of file`) in unifiedFileDiff
    cas.ts                # Append trailing '\n' to staged index.json, .cas.lock, and actual-preimage unified diff output
    finalizer.ts          # Append trailing '\n' to projected index.json diff output against actual on-disk preimage
  taskpack/src/
    suite.ts              # TaskpackSuite schema, suite-wide protected union, schedule/comment router, and stage readiness
    baseline-align.ts     # Private-object-dir 3-way merge probe, 3-way carry blobs, and scrubbed conflict hunk extractor
    schema.ts             # Parse handoffs, conditional rule objects, suite protected union, and spec.baselineAlignment
    digests.ts            # Normalize conditional `{ path, when }` rules in collectTaskpackDigestTargets
    taskpack.ts           # Compile handoffs & conditional resources into TaskContract; stage conflict hunks when enabled
    turnkey.ts            # Pre-probe baseline alignment, shared 3-way carry tree, conflict-resolution guard, RunEval wiring
    types.ts              # TaskpackSuiteManifest, SuiteResolutionResult, BaselineAlignmentConfig, and handoff/rule types
    index.ts              # Export suite and baseline-alignment APIs
  github-app/src/
    action.ts             # suite-path / domain / resolve-suite-only / baseline-alignment inputs, API PR lookup, matrix output
    publisher.ts          # Consume shared 3-way merged carry blobs and enforce conflict resolution before PR publication
    service.ts            # Multi-domain suite webhook routing, manifest digest lease binding, and fan-out deduplication
    index.ts              # Re-export @loopwright/taskpack suite and alignment symbols
  cli/src/
    arguments.ts          # Add `loopwright suite check|resolve` and `--baseline-alignment` CLI grammar
    main.ts               # Wire suite commands, pre-probe baseline alignment, and inspected RunEval in CLI reports
action.yml                # Optional suite-path, domain, resolve-suite-only, and baseline-alignment inputs + matrix output
docs/                     # Updated configuration and operations guides + docs/README.md + generated site/
```

### Code Style

```ts
// Deterministic CommonMark-fence-aware ATX Markdown section extractor with SHA-256 provenance
export interface ExtractedSection {
  readonly content: string;
  readonly sourceSha256: string;
  readonly extractSha256: string;
  readonly byteLength: number;
  readonly truncated: boolean;
}

function stripOptionalClosingHashes(raw: string): string {
  const trimmed = raw.replace(/[ \t]+$/, '');
  if (/^#+$/.test(trimmed)) return '';
  return trimmed.replace(/[ \t]+#+$/, '').trim();
}

export function extractMarkdownHeadingSection(
  rawUtf8: Uint8Array,
  targetHeading: string,
  options: { readonly includeSubheadings?: boolean; readonly maxBytes: number },
): ExtractedSection | null {
  const sourceSha256 = createHash('sha256').update(rawUtf8).digest('hex');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(rawUtf8).replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const explicitLevelMatch = /^(#{1,6})(?:[ \t]+(.*))?$/.exec(targetHeading.trim());
  const requiredLevel = explicitLevelMatch ? explicitLevelMatch[1]!.length : null;
  const normalizedTarget = explicitLevelMatch
    ? stripOptionalClosingHashes(explicitLevelMatch[2] ?? '')
    : targetHeading.trim();

  let fence: { readonly char: '`' | '~'; readonly length: number } | null = null;
  let startLine = -1;
  let startLevel = 0;
  let endLine = lines.length;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1]!;
      const char = marker[0] as '`' | '~';
      if (fence === null) {
        if (char === '~' || !fenceMatch[2]!.includes('`')) fence = { char, length: marker.length };
      } else if (fence.char === char && marker.length >= fence.length && fenceMatch[2]!.trim() === '') {
        fence = null;
      }
      continue;
    }
    if (fence !== null) continue;

    const headingMatch = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
    if (headingMatch === null) continue;
    const level = headingMatch[1]!.length;
    const title = stripOptionalClosingHashes(headingMatch[2] ?? '');

    if (startLine === -1) {
      if (title === normalizedTarget && (requiredLevel === null || level === requiredLevel)) {
        startLine = i;
        startLevel = level;
      }
    } else {
      const stop = options.includeSubheadings === false ? true : level <= startLevel;
      if (stop) {
        endLine = i;
        break;
      }
    }
  }

  if (startLine === -1) return null;
  const sectionText = `${lines.slice(startLine, endLine).join('\n').trimEnd()}\n`;
  const fullBytes = Buffer.from(sectionText, 'utf8');
  if (fullBytes.byteLength <= options.maxBytes) {
    return Object.freeze({
      content: sectionText,
      sourceSha256,
      extractSha256: createHash('sha256').update(fullBytes).digest('hex'),
      byteLength: fullBytes.byteLength,
      truncated: false,
    });
  }
  let cut = options.maxBytes;
  while (cut > 0 && (fullBytes[cut]! & 0xc0) === 0x80) cut -= 1;
  const sliced = fullBytes.subarray(0, cut);
  return Object.freeze({
    content: sliced.toString('utf8'),
    sourceSha256,
    extractSha256: createHash('sha256').update(sliced).digest('hex'),
    byteLength: sliced.byteLength,
    truncated: true,
  });
}
```

Key conventions:
- Validate every untrusted parsed record with `Object.hasOwn` and null-prototype-safe helpers, zero `any`, and explicit byte bounds.
- Hash both the upstream source artifact and the exact bounded slice so downstream roles and `loopwright inspect` retain complete provenance.
- Keep `controller.ts` and `step.ts` behavior symmetric across autonomous Pi sessions and `loopwright step` delegated sessions.

### Implementation Plan

Tasks are vertical tracer bullets across five waves. Tasks without a transitive `Blocked by:` path own strictly disjoint globs and can run in parallel.

- [x] **T1 · Memory JSON trailing-newline and LF-aware diff hygiene**
      Blocked by: None
      Owns: `packages/memory/**`
      Gate: review
      Acceptance: `cas.ts` and `finalizer.ts` terminate `index.json` and `.cas.lock` with `\n` within `MAX_MEMORY_INDEX_BLOB_BYTES`. `unifiedFileDiff` emits `\ No newline at end of file` against actual on-disk preimages while JCS `storeDigest` stays unchanged.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg memory`

- [x] **T2 · Core contracts for compact handoffs and conditional rule activation**
      Blocked by: None
      Owns: `packages/core/**`
      Gate: review
      Acceptance: `TaskContract` validates `steps[].handoffs` (`1..16` selectors, strict ancestor `fromStep`, decoded RFC 6901 prototype-key rejection, `maxBytes` `64..65,536`). `trustedContext.resources[].when` validates deterministic predicates while keeping `discovery: 'disabled'`.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg core`

- [x] **T3 · Controller RunEval diagnostics, inspect bundle, and report formatting**
      Blocked by: None
      Owns: `packages/controller/src/run-eval.ts`, `packages/controller/src/inspect.ts`, `packages/controller/src/report.ts`, `packages/controller/src/index.ts`, `packages/controller/test/run-eval.test.ts`
      Gate: review
      Acceptance: `evaluateRunHealth` computes `toolRepeats`, `pingPong`, `repairConvergence`, per-step/role breakdowns, and `0..8` scrubbed `autoApplied: false` hints from one `journal(store)` revision. `inspectRun` writes `run-eval.json` and `formatRunReport` renders `Run Health` across all four formats.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg controller`

- [x] **T4 · Multi-domain TaskpackSuite schema, router, and stateless stage promotion**
      Blocked by: None
      Owns: `packages/taskpack/src/suite.ts`, `packages/taskpack/src/schema.ts`, `packages/taskpack/src/types.ts`, `packages/taskpack/src/index.ts`, `packages/taskpack/test/suite.test.ts`
      Gate: review
      Acceptance: `@loopwright/taskpack` validates `TaskpackSuite` (`1..32` `O_NOFOLLOW` domains, acyclic stages, prefix-disjoint `headBranchPrefix`, and suite-wide protected union `<= 128`) with zero `@loopwright/github-app` imports. Schedule, comment, and `baseRevision` stage probes return `eligible`, `deferred`, or `blocked` deterministically.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg taskpack`

- [x] **T5 · Pi adapter subset resource preflight and snapshot restore compatibility**
      Blocked by: T2
      Owns: `packages/agent-pi/**`
      Gate: review
      Acceptance: `preflight.ts` strips optional `when` during `ResourceIdentity` matching and admits ordered verified `PiOpenInput.resources` subsets within `maxRequestBytes`. Duplicate or tampered resources fail with `RESOURCE_MISMATCH`, and `recoverSnapshot` digests stay invariant across repairs and compaction.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg agent-pi --concurrency 1`

- [x] **T6 · Controller compact handoffs and per-attempt conditional rule filtering**
      Blocked by: T2, T5
      Owns: `packages/controller/src/handoff.ts`, `packages/controller/src/rules.ts`, `packages/controller/src/config.ts`, `packages/controller/src/compile.ts`, `packages/controller/src/controller.ts`, `packages/controller/src/step.ts`, `packages/controller/src/progress.ts`, `packages/controller/src/errors.ts`, `packages/controller/src/types.ts`, `packages/controller/test/handoff-and-rules.test.ts`
      Gate: review
      Acceptance: `controller.ts` and `step.ts` filter `when` rules and extract ATX Markdown (`## C#`-safe) and JSON-pointer handoffs from `fromStep`'s epoch snapshot. `role_pre` persists `activatedResourceIds` and CAS `handoffExtracts` (`<= 64` `contextFiles`), preserving prompt-hash checks and `--reissue-lease` recovery.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg controller`

- [x] **T7 · Taskpack isolated 3-way baseline conflict alignment, merged carry tree, and RunEval sink wiring**
      Blocked by: T3, T4
      Owns: `packages/taskpack/src/baseline-align.ts`, `packages/taskpack/src/schema.ts`, `packages/taskpack/src/taskpack.ts`, `packages/taskpack/src/turnkey.ts`, `packages/taskpack/src/types.ts`, `packages/taskpack/src/index.ts`, `packages/taskpack/test/baseline-align.test.ts`
      Gate: review
      Acceptance: `baseline-align.ts` runs `git merge-tree --write-tree` in a private `GIT_OBJECT_DIRECTORY` before model probes. `fail-fast` blocks with zero provider calls, `extract-context` stages scrubbed conflict hunks and enforces conflict resolution, 3-way carry blobs preserve disjoint same-file edits, and `turnkey.ts` forwards `runEval`.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg taskpack`

- [x] **T8 · Taskpack compilation and lockfile digests for handoffs and conditional rules**
      Blocked by: T6, T7
      Owns: `packages/taskpack/src/schema.ts`, `packages/taskpack/src/digests.ts`, `packages/taskpack/src/taskpack.ts`, `packages/taskpack/src/types.ts`, `packages/taskpack/src/index.ts`, `packages/taskpack/test/handoff-and-rules.test.ts`
      Gate: review
      Acceptance: `taskpack.yaml` compiles `handoffs` and `{ path, when }` rules into `TaskContract` within the `256 KiB` ceiling while rejecting conflicting same-path `when` rules. `digests.lock.json` (`pinDigests: true`) and protected-path sets cover all conditional rules across turnkey Pi and `step` runs.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg taskpack`

- [x] **T9 · GitHub Action and App suite routing, PR ownership lookup, and 3-way publisher**
      Blocked by: T1, T8
      Owns: `packages/github-app/**`, `action.yml`
      Gate: review
      Acceptance: `action.yml` and `action.ts` support `suite-path`, `domain`, `resolve-suite-only`, `baseline-alignment`, and `matrix` output, and verify `issue_comment` PR branch ownership via GitHub API. `service.ts` deduplicates suite webhook fan-out, `publisher.ts` consumes shared 3-way carry blobs, and memory PRs commit `\n`-terminated `index.json`.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg github-app`

- [x] **T10 · CLI suite commands, baseline-alignment flag, RunEval report wiring, and runner parity**
      Blocked by: T8
      Owns: `packages/cli/src/**`, `packages/cli/test/arguments.test.ts`, `packages/cli/test/suite-and-eval.test.ts`, `packages/cli/test/closure-and-failure-matrix.test.ts`, `packages/cli/test/npm-pack.test.ts`, `packages/taskpack-runner/test/**`
      Gate: review
      Acceptance: `loopwright suite check|resolve` and `--baseline-alignment` parse strictly with deterministic exit codes (`0` `eligible`/`deferred`, `2` usage/manifest, `3` blocked). `emitOutcomeReports` forwards `inspected.runEval`, `@loopwright/taskpack-runner` parity stays green, and `closure --verify-failures` preserves `18` `closedLocal` / `5` `unprovisionedExternal`.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg taskpack-runner && node scripts/run-tests.mjs --pkg cli && node packages/cli/dist/main.js closure --verify-failures --json`

- [ ] **T11 · Connected documentation, Hugo site sync, and workspace verification**
      Blocked by: T9, T10
      Owns: `docs/**`, `site/**`, `README.md`, `.agents/skills/**`, `packages/cli/test/check-docs-rules.test.ts`, `packages/cli/test/docs-and-site.test.ts`
      Acceptance: Owning `docs/configuration/**`, `docs/operations/**`, `docs/contribute/**`, `docs/README.md`, `README.md`, and `.agents/skills/**` pages document Phase 2 contracts within line and STE100 limits. `npm run lint:docs`, `npm run site`, `npm test`, `npm run typecheck`, and `npm run lint` pass cleanly.
      Verify: `npm run build && npm run typecheck && npm run lint && npm run lint:docs && npm run site && npm test && node packages/cli/dist/main.js closure --verify-failures --json`

### Test Plan
[ ] I/we understand the owners of the involved components may require updates to existing tests to make this
code solid enough prior to committing the changes necessary to implement this enhancement.

#### Prerequisite testing updates
- Keep legacy no-LF `index.json` preimage fixtures in `packages/memory/test/{cas-concurrency,store-selector,finalizer-verifier}.test.ts` and `packages/github-app/test/turnkey-memory*.test.ts`. Assert `\ No newline at end of file` migration diffs and trailing `\n` (`0x0a`) on all post-apply `index.json` and `.cas.lock` outputs.

#### Unit tests
- `@loopwright/memory`: `2026-11-21` - `>= 90%` line coverage on touched `schema.ts`, `cas.ts`, and `finalizer.ts` paths. Cover trailing `\n` on `index.json` and `.cas.lock`, no-LF -> LF `unifiedFileDiff` markers, unchanged `storeDigest`, `MAX_MEMORY_INDEX_BLOB_BYTES` inclusive of `\n`, and byte-exact rollback.
- `@loopwright/core`: `2026-11-21` - `>= 95%` line coverage on `StepHandoffSelector` and `ResourceActivationRule` validation. Cover diamond-DAG strict ancestors, invalid `check`/compaction steps, `16`/`17` selector and `32`/`33` pointer bounds, decoded RFC 6901 prototype-key refusals, and null-prototype records.
- `@loopwright/agent-pi`: `2026-11-21` - `>= 90%` line coverage on `preflight.ts` subset resource validation. Cover `when` stripping, ordered `PiOpenInput.resources` subset admission, `maxRequestBytes` checks, duplicate/tampered `RESOURCE_MISMATCH` refusals, and `recoverSnapshot` invariance across repair and compaction.
- `@loopwright/controller`: `2026-11-21` - `>= 90%` line coverage on `handoff.ts`, `rules.ts`, and `run-eval.ts`. Cover code-fence `#` ignoring, `## C#` closing-hash handling, multi-byte UTF-8 truncation, epoch-pinned `nodeCandidates` isolation, phase precedence, `<= 64` `contextFiles`, and `RunEval` loop/cost metrics.
- `@loopwright/taskpack`: `2026-11-21` - `>= 90%` line coverage on `suite.ts`, `baseline-align.ts`, `digests.ts`, and `schema.ts`. Cover `32`/`33` domains, stage cycles, suite protected-union overflow, `headBranchPrefix` collisions, `baseRevision` `versionFrom` reads, `deferred` vs `blocked` probes, inactive rule lockfile tampering, and private-object-dir 3-way merges.
- `@loopwright/github-app`: `2026-11-21` - `>= 90%` line coverage on suite Action/App routing and 3-way publisher. Cover `issue_comment` API branch lookup, cross-fork PR refusal, `<domainId>` mismatch blocking, single-delivery webhook fan-out deduplication, pre-probe `fail-fast`, and unresolved conflict refusal.
- `@loopwright/cli`: `2026-11-21` - `>= 90%` line coverage on `suite check|resolve` grammar, `--baseline-alignment` overrides, exit codes, and `RunEval` report output.

#### Integration tests
- Multi-domain suite staged promotion (`packages/github-app/test/suite-action-and-service.test.ts`): schedule -> matrix output -> Stage B `deferred` while Stage A PR is open -> Stage B `eligible` once Stage A merges and probe matches -> comment routing enforcement.
- Multi-role DAG handoffs, conditional rules, and crash recovery (`packages/controller/test/handoff-and-rules.test.ts` and `packages/taskpack/test/handoff-and-rules.test.ts`): `plan -> implement -> review` rework, inactive-to-active repair mounting with Pi `recoverSnapshot`, and `role_pre` `--reissue-lease` recovery without `step-lease.json`.
- Isolated 3-way baseline alignment and tree parity (`packages/taskpack/test/baseline-align.test.ts` and `packages/github-app/test/suite-action-and-service.test.ts`): byte-identical verified vs published trees on disjoint same-file 3-way merges, zero provider probes and zero `.git/objects` writes under `fail-fast`, and conflict-resolution enforcement under `extract-context`.
- End-to-end `RunEval` and memory PR newline hygiene (`packages/controller/test/run-eval.test.ts`, `packages/cli/test/suite-and-eval.test.ts`, and `packages/github-app/test/turnkey-memory.test.ts`): `run-eval.json` + Step Summary output and `\n`-terminated `index.json` blobs on separate memory PRs.

#### e2e tests
- None required against live external GitHub or live billing LLM endpoints in automated CI. Local git bare remotes, loopback GitHub REST/GraphQL/App servers, OS sandboxes, and mock Pi/step adapters cover full CLI/Action/App flows, matching the 23-row closure matrix (`18` `closedLocal`, `5` `unprovisionedExternal`).

## Alternatives

1. **Commit a suite promotion state file (such as `.loopwright/suite-state.json`) to track Stage A -> Stage B transitions**:
   - Rejected because committed state files create extra pull requests, cause cross-domain merge conflicts, and drift after manual reverts. Stateless evaluation from `baseRevision` plus external readiness probes self-heals and behaves identically in CLI and GitHub Actions.
2. **Evaluate conditional rules and handoffs only once at `@loopwright/taskpack` compile time**:
   - Rejected because static pre-compilation cannot observe mid-DAG file edits or check failure categories during `repair` and `rework` loops. It would also omit `Managed Controller` and `loopwright step`. Pre-hashing resources in `TaskContract` and evaluating predicates per attempt in `@loopwright/controller` preserves `discovery: 'disabled'` across all modes.
3. **Write a synthetic unreferenced merge commit to `.git` and rewrite `TaskContract.spec.target.sourceRevision`**:
   - Rejected because unreferenced commits are vulnerable to `git gc` across `resume`, `reconcile`, and `loopwright step` (`TARGET_MISMATCH`). Conflicted trees also cannot form a clean commit. An isolated 3-way merge probe plus shared 3-way merged carry blobs preserves commit provenance, target lines, and recovery safety.

## Open Questions

None. All user stories, package boundaries, stateless stage promotion rules, handoff and rule contracts, `RunEval` boundaries, and 3-way baseline alignment policies are confirmed.
