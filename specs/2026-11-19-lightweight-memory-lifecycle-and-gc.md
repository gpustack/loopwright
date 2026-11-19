# Spec: Lightweight memory lifecycle, eager stale cleanup, and configurable GC

Status: Shipped
Type: Feature

## Summary

Simplify `@loopwright/memory` and `@loopwright/github-app` so reviewed memory stays small, loosely coupled, quiet on CI, and non-blocking. Retiring an entry deletes `entries/<id>.md` on disk and clears retired records from `index.json`. Code-fingerprint and upstream-version locking become opt-in (`checkCodeFingerprint: false` and `checkUpstreamVersions: false` by default). Settled runs eagerly delete expired entries, healed failure observations, and entries past `maxEntries` (`128` by default, `15`-day default TTL), while deterministic `no_change` runs stop emitting churn `fact` entries, separate memory PR publication skips failed/incident runs by default (`publishOnFailure: false`), and memory branch commits include `[skip ci]` in the commit body by default (`skipCi: true`). Internal file-size guards cap `entries/<id>.md` at `64 KiB` and `index.json` at `2 MiB`. `.loopwright/taskpack.yaml` exposes concise lifecycle controls—`apply` (`separate-pull-request | local-only | disabled`), `ttlDays`, `maxEntries`, `maxPromptEntries`, `checkCodeFingerprint`, `checkUpstreamVersions`, `publishOnFailure`, and `skipCi`—with complete documentation across `docs/` and `site/`.

## Motivation

### Goals

Existing reviewed memory ([`specs/2026-11-11-reviewed-memory-and-cas-compaction.md`](../specs/2026-11-11-reviewed-memory-and-cas-compaction.md)) guarantees provenance and compare-and-swap (CAS) safety, but carries five operational burdens in long-running repositories:

1. **Unbounded retired storage, missing read-size guards, and hard schema ceilings**: [`packages/memory/src/store.ts`](../packages/memory/src/store.ts) and [`packages/memory/src/cas.ts`](../packages/memory/src/cas.ts) keep `entries/<id>.md` on disk after retirement, read files without a prior `fstat` byte bound, and append every retired record to `index.json` (`retired`, capped at `1024` in [`packages/memory/src/schema.ts`](../packages/memory/src/schema.ts)). Once `entries` or `retired` reaches `1024`, future memory updates fail closed with `MEMORY_SCHEMA_INVALID`. Git history already preserves retired claims, so keeping retired `.md` files and growing `index.retired` adds repository noise without runtime value.
2. **Overly tight `codeFingerprint` and multi-upstream coupling**: [`packages/github-app/src/taskpack.ts`](../packages/github-app/src/taskpack.ts) and [`packages/memory/src/finalizer.ts`](../packages/memory/src/finalizer.ts) hash every file under `scope.writable` and exclude active memories whenever any writable file or any sibling upstream version changes. Routine commits or single-upstream bumps in multi-upstream taskpacks immediately invalidate useful operational lessons.
3. **Lingering stale memories and noisy `no_change` PR churn**: [`packages/memory/src/selector.ts`](../packages/memory/src/selector.ts) filters expired entries at read time, while [`packages/memory/src/finalizer.ts`](../packages/memory/src/finalizer.ts) leaves expired entries and healed `claim.incident.*` failure observations in `index.entries`. Worse, `finalizer.ts` synthesizes a new `Check no-change passed` `fact` entry on every `no_change` run, opening pointless `+1 / -1` memory PRs on every scheduled check. Stale memories carry high confusion cost while regenerating fresh deterministic memories is cheap—especially when System-One Decision routing (`spec.decisions`) handles routine classifications.
4. **Unbounded prompt recall order and missing `targetMatrix` passthrough**: [`packages/memory/src/selector.ts`](../packages/memory/src/selector.ts) renders all active entries up to a hard `262_144`-byte error cliff without prioritizing high-signal `failure_observation` lessons over routine `Check X passed` facts, and [`packages/memory/src/finalizer.ts`](../packages/memory/src/finalizer.ts) hardcodes `scope.targetMatrix: null` instead of forwarding optional matrix cell bindings.
5. **Missing YAML lifecycle controls and non-blocking guarantees**: [`packages/github-app/src/turnkey-memory.ts`](../packages/github-app/src/turnkey-memory.ts) hardcodes a 30-day TTL, [`packages/github-app/src/schema.ts`](../packages/github-app/src/schema.ts) requires `apply: separate-pull-request` with no `disabled` or `local-only` mode and no retention fields in `.loopwright/taskpack.yaml`, and `docs/` lacks user-facing lifecycle configuration guidance. Memory creation, modification, or retirement must never block primary task execution or completion.

### Non-Goals

- Adding LLM-driven semantic garbage collection that spends extra model tokens when `onNoModelBudget` is exhausted or `skip`.
- Exposing low-level file-byte limits in `.loopwright/taskpack.yaml` (enforced internally instead).
- Bundling memory writes into the code candidate pull request or allowing memory paths to overlap `scope.writable` or `.github/workflows/**`.
- Breaking deterministic offline verification or capability closure scenarios in [`packages/cli/src/failure-matrix.ts`](../packages/cli/src/failure-matrix.ts).

## Proposal

Reshape reviewed memory around a lightweight active-only store with bounded file sizes (`64 KiB` per entry, `2 MiB` index), eager garbage collection, zero-noise `no_change` sweeps, loose fingerprint and upstream coupling by default, prioritized prompt selection, concise `.loopwright/taskpack.yaml` configuration, and strict non-blocking isolation across intake, execution, and post-run publication.

### User Stories

#### Story 1
As a repository maintainer, I want retiring or superseding a memory entry to delete its `entries/<id>.md` file and purge retired records from `index.json` while enforcing internal file-size ceilings, so that `.loopwright/memory/<taskpack>/` holds only bounded active entries (`<= 128` by default) and Git diffs show clean file deletions.

#### Story 2
As a taskpack author, I want memory validity decoupled from `scope.writable` file hashes and sibling upstream bumps by default (`checkCodeFingerprint: false`, `checkUpstreamVersions: false`), so that routine updates do not invalidate still-relevant operational facts or pay full-tree hashing costs.

#### Story 3
As an operator running scheduled, local-loop, or Decision-routed (`spec.decisions`) taskpacks, I want expired entries (`15` days default) and healed failure/incident observations deleted automatically, `no_change` runs to stay silent when nothing needs cleanup, failed runs to skip opening noisy standalone memory PRs by default (`publishOnFailure: false`), memory PR commits to skip heavy repository CI workflows by default (`skipCi: true`), and `memory.apply` to support `separate-pull-request`, `local-only`, or `disabled`—while guaranteeing that no memory fault ever blocks primary task completion.

#### Story 4
As a Loopwright user, I want clear `.loopwright/taskpack.yaml` fields (`apply`, `ttlDays`, `maxEntries`, `maxPromptEntries`, `checkCodeFingerprint`, `checkUpstreamVersions`, `publishOnFailure`, `skipCi`) documented in `docs/` and published on `site/`, so that I can tune or disable memory retention and PR behavior without reading source code.

### Core Features & Acceptance Criteria

#### 1. Direct Deletion on Retire, Active-Only Store Compaction, and Internal Byte Caps (`@loopwright/memory`)
- Enforce internal regular-file size bounds in [`packages/memory/src/store.ts`](../packages/memory/src/store.ts) (`readRegularFile` checks `fstat.size` before reading) and [`packages/github-app/src/turnkey-memory.ts`](../packages/github-app/src/turnkey-memory.ts):
  - `MAX_MEMORY_ENTRY_FILE_BYTES = 65_536` (`64 KiB` per `entries/<id>.md`).
  - `MAX_MEMORY_INDEX_FILE_BYTES = 2_097_152` (`2 MiB` for `index.json`).
- Retiring an entry—via `{ kind: 'retire', entryId, reason }`, `upsert.entry.supersedes`, eager staleness sweep, or capacity eviction—removes the entry from `index.entries`, leaves `index.retired` empty (`[]`), emits a unified deletion diff (`--- a/<dir>/entries/<id>.md` to `+++ /dev/null`), and unlinks `entries/<id>.md` on disk during `applyMemoryProposalCAS`.
- Backward compatibility on load: `loadMemoryStore` continues to accept legacy `index.json` files (`version: 1`) that carry non-empty `retired` arrays. It requires `entries/<id>.md` files only for active `index.entries`, tolerates leftover `entries/<retiredId>.md` files referenced by legacy `index.retired`, and purges both legacy `index.retired` rows and leftover retired `.md` files on the next applied proposal.
- Atomic CAS deletion and rollback: `applyMemoryProposalCAS` backs up prior bytes for every modified or deleted `.md` file under `.cas.lock`, unlinks deleted `entries/<id>.md` files before renaming `index.json`, and restores unlinked `.md` files (`0o600`) plus prior `index.json` bytes if any step or `faultInjectionHook` throws.
- `verifier.ts` (`scopeGate`) validates deleted patch paths (`--- a/<path>` paired with `+++ /dev/null`) against the same managed-directory and protected-path rules as added/modified files.

#### 2. Loose `codeFingerprint` and `upstreamVersions` Coupling by Default, plus `targetMatrix` Passthrough (`@loopwright/memory`, `@loopwright/github-app`)
- `MemoryFinalizerConfig` adds optional `checkCodeFingerprint?: boolean` (default `false`), optional `checkUpstreamVersions?: boolean` (default `false`), and optional `targetMatrix?: MemoryEntry['scope']['targetMatrix']` (default `null`). When `checkCodeFingerprint` is `false`, `finalizeRunMemory` skips `computeCodeFingerprint` directory walks and writes a deterministic zero sentinel digest (`'0'.repeat(64)`) into `validFor.codeFingerprint`. When `true`, it computes the SHA-256 manifest over `scope.writable` as before.
- `MemorySelectorInput.currentCodeFingerprint` accepts `Digest | null | undefined`, and `MemorySelectorInput.currentUpstreamVersions` accepts `Readonly<Record<string, string>> | null | undefined`. When `null` or `undefined` (the default in `compileDeclarativeTaskpack` when `checkCodeFingerprint` / `checkUpstreamVersions` are `false`), `selectActiveMemory` skips `fingerprint_mismatch` / `upstream_version_changed` exclusions so multi-upstream taskpacks do not wipe out sibling upgrade lessons when a single upstream bumps. When non-null values are supplied (when enabled in YAML or in [`packages/cli/src/failure-matrix.ts`](../packages/cli/src/failure-matrix.ts) and unit suites), `selectActiveMemory` enforces `fingerprint_mismatch` and `upstream_version_changed` unchanged.

#### 3. Eager Stale Cleanup, Silent `no_change` Sweeps, and `15`-Day / `128`-Entry Defaults (`@loopwright/memory`)
- Default retention constants update to `DEFAULT_MEMORY_TTL_DAYS = 15` (`1_296_000_000` ms), `DEFAULT_MEMORY_MAX_ENTRIES = 128` (`1..512`), `DEFAULT_MEMORY_MAX_PROMPT_ENTRIES = 32` (`1..128`), and internal `DEFAULT_MEMORY_MAX_PROMPT_BYTES = 16_384` (`4_096` inline prompt cap).
- Deterministic `no_change` runs do not synthesize routine `Check <id> passed` `fact` entries in `finalizeRunMemory` (an explicit `curator` port may still emit curated facts on `no_change`, and `verifier.ts` continues to accept `no_change` provenance). A `no_change` run with zero stale entries emits `operations: []` and triggers zero PR churn. Deterministic `failure_observation` claim formatting also normalizes ephemeral gate workdir paths (`/tmp/loopwright-gate-...` and `$TMPDIR/loopwright-gate-...`) to `<gate-workdir>`.
- During `finalizeRunMemory`, before capacity enforcement, the finalizer inspects `loaded.index.entries` and emits deterministic `retire` operations (sorted by `id`, bounded within the `256`-operation proposal cap) for active entries not already superseded in the current run when:
  1. **Expired**: `entry.expiresAtMs <= config.nowMs`.
  2. **Upstream version drifted (when `checkUpstreamVersions === true`)**: any key pinned in `entry.validFor.upstreamVersions` differs from `config.upstreamVersions[key]` (when that upstream key is present in `config.upstreamVersions`).
  3. **Healed failure or incident**: `entry.kind === 'failure_observation'` and either the settled run succeeded (`completed` or `no_change`), or the specific check cited by `claim.check.<checkId>` passed in the current `VerificationResult`.
- Capacity eviction: `MemoryFinalizerConfig` and `projectMemoryStore` enforce `maxEntries` (default `128`). If projected active entries exceed `maxEntries`, deterministic eviction removes excess entries in order: `failure_observation` (oldest `verifiedAtMs` first) -> `fact` (oldest `verifiedAtMs` first) -> `invariant` (oldest `verifiedAtMs` first), breaking ties by earliest `expiresAtMs` and lexicographical `id`.
- Prompt selection priority and byte truncation (`selectActiveMemory`):
  1. Filter `ownExclusion` (including `targetMatrix` matching), `expired`, and `superseded` **before** applying count or byte caps so out-of-scope entries never crowd out valid ones.
  2. When valid entries exceed `maxEntries` (`maxPromptEntries`, default `32` in Taskpack compilation) or internal `maxBytes` (default `16_384` resource / `4_096` inline prompt), retain entries in priority order: `invariant` -> `failure_observation` -> `fact` (within each kind, newest `verifiedAtMs` descending, then `id` ascending), truncating cleanly at whole-entry boundaries instead of throwing on byte overflow, while preserving `# Active memory: <taskpack>`, `## Verified Facts`, and `## Failure Observations` headings.
  3. Sanitize single-line rendered claims in `renderMarkdown` so embedded newlines or line-leading prompt sentinels (`=== `, `REQUIRED:`, `NEVER:`, `SYSTEM:`) never cross prompt section boundaries.

#### 4. Taskpack YAML Schema, `local-only` / `disabled` Modes, Failure-PR Suppression, `[skip ci]`, and Non-Blocking Execution (`@loopwright/github-app`)
- Expand `spec.memory` in [`packages/github-app/src/types.ts`](../packages/github-app/src/types.ts) and [`packages/github-app/src/schema.ts`](../packages/github-app/src/schema.ts):
  - `directory`: required repo-relative path under `<controlRoot>/memory`.
  - `apply`: `'separate-pull-request' | 'local-only' | 'disabled'`.
  - `onNoModelBudget`: `'deterministic-observations-only' | 'skip'` (optional when `apply: 'disabled'`, defaulting to `'skip'`; required otherwise).
  - `ttlDays`: optional integer `1..365` (default `15`).
  - `maxEntries`: optional integer `1..512` (default `128`).
  - `maxPromptEntries`: optional integer `1..128` (default `32`).
  - `checkCodeFingerprint`: optional boolean (default `false`).
  - `checkUpstreamVersions`: optional boolean (default `false`).
  - `publishOnFailure`: optional boolean (default `false`).
  - `skipCi`: optional boolean (default `true`).
- Prompt injection in `compileDeclarativeTaskpack`: uses `selectActiveMemory` with priority-bounded byte sizing (`<= 4_096` for inline `<active_memory>` and `<= 16_384` for staged resource) so inline prompt clipping never drops `## Failure Observations` at the tail, and injects bounded `<active_memory>` into both `task` and `review` roles when wire headroom permits.
- Execution modes and PR noise controls:
  - `apply === 'disabled'`: `compileDeclarativeTaskpack` skips memory loading/injection; `finalizeAndPublishTurnkeyMemory` returns `{ status: 'skipped', reason: 'memory_apply_disabled', ... }` immediately.
  - `apply === 'local-only'`: `compileDeclarativeTaskpack` injects active memory normally; `finalizeAndPublishTurnkeyMemory` runs `finalizeRunMemory` + `applyMemoryProposalCAS` directly against `<repositoryRoot>/<memoryDirectory>` (preserving `failure_observation` recording locally and deleting retired `.md` files without touching remote branches or opening PRs) and returns `status: 'local_only'`.
  - `apply === 'separate-pull-request'`:
    - **Failure PR suppression (`publishOnFailure`, default `false`)**: `@loopwright/memory` (`finalizeRunMemory`) retains full `failure_observation` support unchanged. In `finalizeAndPublishTurnkeyMemory`, when `apply === 'separate-pull-request'` and `publishOnFailure !== true`, if the settled primary run is non-passing (`incident !== null`, `result === null`, or `result.spec.status` is neither `'completed'` nor `'no_change'`), it skips remote branch pushes and memory PR creation, returning `{ status: 'skipped', reason: 'failure_publication_disabled', ... }`. Setting `publishOnFailure: true` restores separate memory PR publication on failed/incident runs.
    - **CI suppression on memory commits (`skipCi`, default `true`)**: when `skipCi !== false`, the generated memory branch Git commit message places `[skip ci]` inside the commit body paragraph *before* the trailing `Signed-off-by: Name <email>` DCO trailer, while keeping the first-line Conventional Commit subject and PR title (`chore(memory): ...`) free of `[skip ci]` suffixes so Conventional Commit and DCO checks pass. Setting `skipCi: false` omits `[skip ci]`.
    - Opens/updates `loopwright/memory/<taskpack>/<targetBranch>` whenever `operations.length > 0` (including retire-only cleanup PRs on `no_change` runs) or legacy `index.retired` files are purged. `isSquashOrRebaseMergedMemoryBranch` treats deleted entries absent from `targetTipStore.entries` as landed.
- Non-blocking invariant: across `compileDeclarativeTaskpack`, `loopwright step`, `finalizeRunMemory`, `finalizeAndPublishTurnkeyMemory`, and `runGitHubActionEntrypoint`, any memory load warning, oversized/corrupt file, schema drift, CAS conflict, or GitHub PR error degrades gracefully to a scrubbed warning or `TurnkeyMemorySummary` status and never flips a passing `RunResult` or `delegateOutcome.ok` to failure.

#### 5. Documentation and Branded Site Guidance (`docs/`, `site/`)
- Update [`docs/configuration/taskpack.md`](../docs/configuration/taskpack.md) (`Taskpack` Macro YAML block, `## Publication and memory` field table, Micro constraint bullets, and enum tables) to document `apply` (`separate-pull-request`, `local-only`, `disabled`), `ttlDays` (`15`), `maxEntries` (`128`), `maxPromptEntries` (`32`), `checkCodeFingerprint` (`false`), `checkUpstreamVersions` (`false`), `publishOnFailure` (`false`), and `skipCi` (`true`), including guidance on pairing `spec.decisions` with lightweight or `disabled` memory.
- Update [`docs/walkthroughs/declarative-taskpack.md`](../docs/walkthroughs/declarative-taskpack.md), [`docs/operations/github-action.md`](../docs/operations/github-action.md), and [`docs/contribute/memory.md`](../docs/contribute/memory.md) to reflect direct `.md` deletion on retirement, active-only `index.json`, `64 KiB` / `2 MiB` internal file bounds, silent `no_change` sweeps, `publishOnFailure: false` and `skipCi: true` defaults, loose fingerprint/upstream defaults, and non-blocking behavior.
- Update [`docs/README.md`](../docs/README.md) (`## Specs` table) and pass `npm run lint:docs` and `npm run site` with zero errors and zero broken links.

### Notes / Constraints / Caveats

- Strict ESM NodeNext TypeScript (`no any`, null-prototype safe object validation, bounded arrays/strings, deterministic sorting).
- All timestamps (`nowMs`, `verifiedAtMs`, `expiresAtMs`) remain explicit caller-supplied inputs in `@loopwright/memory` so tests and CAS digests stay 100% deterministic.
- Proposal `operations` schema bound remains `0..256`; if a legacy store holds more than `256` stale entries at once, each run retires up to the remaining operation budget deterministically without failing schema validation.

### Boundaries

- **Always:** Preserve `.cas.lock` exclusivity, `O_NOFOLLOW` symlink refusal, `fstat` byte bounds (`64 KiB` per entry, `2 MiB` index), secret scrubbing, separate memory PR isolation (`excludesCodeCandidatePaths: true` when `apply: 'separate-pull-request'`), and non-blocking primary run verdicts. Run `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run lint:docs`, and `npm run site`.
- **Ask first:** Changing `MemoryEntry` or `MemoryStoreIndex` `version` past `1`, adding new CLI subcommands, or modifying `.github/workflows/**`.
- **Never:** Allow memory faults or CAS conflicts to fail a primary `TaskContract` / Turnkey run, write outside `<memoryRoot>/<taskpack>/`, or silently force-push over an unpinned remote branch.

### Risks and Mitigations

- **Legacy repositories contain non-empty `index.retired` arrays or orphan retired `.md` files** → Keep `retired` valid in `memoryStoreIndexSchema` (`version: 1`), skip requiring `.md` files for `index.retired` rows in `loadMemoryStore`, tolerate `.md` files belonging to `index.retired`, and purge both `index.retired` (`[]`) and unreferenced `.md` files on the next CAS apply.
- **Oversized or corrupted file committed into `<memoryRoot>/<taskpack>/`** → Reject files exceeding `64 KiB` (`entries/*.md`) or `2 MiB` (`index.json`) before `readFile()` in `store.ts`; callers catch `MemoryDiagnosticError` and emit a scrubbed warning without failing task compilation or execution.
- **Crash mid-apply after unlinking a retired `entries/<id>.md` file** → Buffer prior bytes of every deleted `.md` file into the `rollback` map before unlinking; restore `0o600` files from memory if `faultInjectionHook` or `index.json` rename throws; tolerate in-flight deleted IDs listed in `.cas.lock` (`touchedEntryIds`).
- **Squash-merged cleanup PR leaves remote `loopwright/memory/<taskpack>/<targetBranch>` branch with fewer entries than `branchBaseStore`** → Update `isSquashOrRebaseMergedMemoryBranch` in [`packages/github-app/src/turnkey-memory.ts`](../packages/github-app/src/turnkey-memory.ts) to detect deleted entries (`branchBaseStore.entries` minus `remoteMemStore.entries`) and verify they are also absent (or replaced) on `targetTipStore`.
- **Loosening `codeFingerprint` breaks `loopwright closure --verify-failures`** → Keep `fingerprint_mismatch` active whenever `MemorySelectorInput.currentCodeFingerprint` is passed as a non-null `Digest`, preserving [`packages/cli/src/failure-matrix.ts`](../packages/cli/src/failure-matrix.ts) scenario `stale_memory_source_exclusion`.

## Design Details

### Commands

Execution environment: **local macOS workspace** (Node.js + `npm`, zero network or live credentials required).

```bash
npm run build
npm run typecheck
npm run lint
npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/memory/test/*.test.js
npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/github-app/test/turnkey-memory*.test.js .test-build/packages/github-app/test/taskpack-intake.test.js
npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/cli/test/docs-and-site.test.js .test-build/packages/cli/test/closure-and-failure-matrix.test.js
npm run lint:docs
npm run site
npm test
```

### Project Structure

- `packages/memory/src/`: `types.ts`, `schema.ts`, `store.ts`, `selector.ts`, `finalizer.ts`, `verifier.ts`, `cas.ts`, `index.ts` — `64 KiB` / `2 MiB` file bounds, lightweight active-only projection, `.md` deletion diffs and atomic rollback, optional fingerprint/upstream checking, `targetMatrix` passthrough, silent `no_change` sweeps, eager stale/healed retirement, prioritized byte-bounded prompt selection, and `15`-day / `128`-entry defaults.
- `packages/memory/test/`: unit, concurrency, crash-rollback, custom-root, and PR-formatting suites updated and expanded for deletion-on-retire, file-size bounds, silent `no_change` sweeps, and eager GC.
- `packages/github-app/src/`: `types.ts`, `schema.ts`, `taskpack.ts`, `turnkey-memory.ts` — `spec.memory` YAML lifecycle fields (`apply: separate-pull-request | local-only | disabled`, `ttlDays`, `maxEntries`, `maxPromptEntries`, `checkCodeFingerprint`, `checkUpstreamVersions`), retire-only cleanup PRs, squash-merge detection for deletions, and non-blocking guarantees.
- `packages/github-app/test/`: `taskpack-intake.test.ts`, `turnkey-memory.test.ts`, `turnkey-memory-budget.test.ts`, `turnkey-memory-cas-guards.test.ts` — schema bounds, `apply: disabled` and `local-only`, retire-only cleanup PRs, and fault isolation tests.
- `docs/` & `site/`: `docs/configuration/taskpack.md`, `docs/walkthroughs/declarative-taskpack.md`, `docs/operations/github-action.md`, `docs/contribute/memory.md`, `docs/README.md`, and generated `site/` output.

### Code Style

Follow strict ESM NodeNext, `Object.freeze` immutable outputs, bounded parsing, and explicit error diagnostics ([`packages/memory/src/store.ts`](../packages/memory/src/store.ts)):

```ts
export const DEFAULT_MEMORY_TTL_DAYS = 15;
export const DEFAULT_MEMORY_TTL_MS = DEFAULT_MEMORY_TTL_DAYS * 24 * 60 * 60 * 1000;
export const DEFAULT_MEMORY_MAX_ENTRIES = 128;
export const DEFAULT_MEMORY_MAX_PROMPT_ENTRIES = 32;
export const MAX_MEMORY_ENTRY_FILE_BYTES = 65_536;
export const MAX_MEMORY_INDEX_FILE_BYTES = 2_097_152;
```

### Implementation Plan

- [x] **T1 · Lightweight `@loopwright/memory` deletion-on-retire, byte bounds, loose coupling, and eager GC**
      Blocked by: None
      Owns: `packages/memory/src/**`, `packages/memory/test/**`
      Gate: review
      Acceptance: `readRegularFile` enforces `64 KiB` (`entries/*.md`) and `2 MiB` (`index.json`) `fstat` caps; retiring/superseding/evicting removes entries from `index.entries`, writes `index.retired: []`, emits unified file deletion diffs (`+++ /dev/null`), and unlinks `entries/<id>.md` atomically under `.cas.lock` with full rollback on fault; legacy stores with non-empty `index.retired` load cleanly and compact on next apply; `checkCodeFingerprint` and `checkUpstreamVersions` default to `false` and `targetMatrix` passes through in `finalizeRunMemory`; deterministic `no_change` runs skip routine `fact` churn while still running eager `retire` sweeps (expired, upstream-drifted when enabled, healed `failure_observation` / `claim.incident.*`) and normalizing `/tmp/loopwright-gate-...` paths; `projectMemoryStore` enforces `maxEntries` (default `128`, TTL default `15` days); `selectActiveMemory` filters before truncating, prioritizes `invariant -> failure_observation -> fact`, and enforces `maxEntries` / `maxBytes` without throwing.
      Verify: `npm run build && npm run typecheck && npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/memory/test/*.test.js .test-build/packages/cli/test/closure-and-failure-matrix.test.js`

- [x] **T2 · Taskpack YAML `spec.memory` lifecycle config, `disabled`/`local-only` modes, and Turnkey GC PRs**
      Blocked by: T1
      Owns: `packages/github-app/src/**`, `packages/github-app/test/**`
      Gate: review
      Acceptance: `validateTaskpackManifest` parses optional `ttlDays` (`1..365`, default `15`), `maxEntries` (`1..512`, default `128`), `maxPromptEntries` (`1..128`, default `32`), `checkCodeFingerprint` (`boolean`, default `false`), `checkUpstreamVersions` (`boolean`, default `false`), and `apply: 'separate-pull-request' | 'local-only' | 'disabled'` (with `onNoModelBudget` optional and defaulting to `'skip'` when `apply: 'disabled'`); `compileDeclarativeTaskpack` skips memory when `apply === 'disabled'`, passes `currentCodeFingerprint: null` / `currentUpstreamVersions: null` by default, uses priority-bounded `selectActiveMemory` (`<= 4096` inline / `<= 16384` resource) across `task` and `review` roles, and never blocks on memory warnings; `finalizeAndPublishTurnkeyMemory` enforces `64 KiB` / `2 MiB` blob caps, supports `disabled`, `local-only` (in-place local CAS + `.md` cleanup), and `separate-pull-request` (including retire-only cleanup PRs on `no_change` runs and squash-merge deletion checks), and never blocks `runGitHubActionEntrypoint` completion.
      Verify: `npm run build && npm run typecheck && npm run lint && npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/github-app/test/taskpack-intake.test.js .test-build/packages/github-app/test/turnkey-memory*.test.js .test-build/packages/github-app/test/turnkey-action.test.js`

- [x] **T3 · Documentation, YAML guides, contributor internals, and Hugo site sync**
      Blocked by: T2
      Owns: `docs/**`, `site/**`, `packages/cli/test/docs-and-site.test.ts`
      Acceptance: `docs/configuration/taskpack.md`, `docs/walkthroughs/declarative-taskpack.md`, `docs/operations/github-action.md`, `docs/contribute/memory.md`, and `docs/README.md` document the new `spec.memory` YAML fields, `15`-day / `128`-entry defaults, `64 KiB` / `2 MiB` internal file bounds, `apply: separate-pull-request | local-only | disabled` + `spec.decisions` guidance, silent `no_change` sweeps, direct `.md` deletion on retire, and non-blocking behavior in 80% ASD-STE100 style; `docs-and-site.test.ts`, `npm run lint:docs`, and `npm run site` pass with 0 errors and 0 broken links.
      Verify: `npm run lint:docs && npm run site && npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/cli/test/docs-and-site.test.js`

- [x] **T4 · Independent read-only Spec & Standards review**
      Blocked by: T2, T3
      Owns: None (read-only)
      Gate: review
      Acceptance: Independent read-only review (`loopwright-code-review` + `spec-reviewer`) audits the full diff against all 5 Spec features, CAS rollback safety, file-size bounds, non-blocking invariants, and documentation rules, reporting zero Blocking/Important findings (or escalating concrete fixes to the coordinator before final gate).
      Verify: `npm run build && npm run typecheck && npm run lint && npm run lint:docs && npm run site && npm test`

- [x] **T5 · Resolve T4 review findings (`targetMatrix` scope, `$TMPDIR` gate path, strict fingerprint, and DRY cleanup)**
      Blocked by: T4
      Owns: `packages/memory/{src,test}/**`, `packages/github-app/{src,test}/**`, `docs/contribute/memory.md`
      Acceptance: Resolves all 4 Important and 3 Nit findings from T4 with TDD and passes build, typecheck, lint, `lint:docs`, `site`, and full `memory`, `github-app`, and `cli` test suites.
      Verify: `npm run build && npm run typecheck && npm run lint && npm run lint:docs && npm run site`

- [x] **T6 · Suppress failure-only Memory PRs (`publishOnFailure: false`) and add `[skip ci]` on memory commits (`skipCi: true`)**
      Blocked by: T5
      Owns: `packages/github-app/{src,test}/**`, `docs/**`, `site/**`, `packages/cli/test/docs-and-site.test.ts`
      Gate: review
      Acceptance: `@loopwright/memory` remains unchanged; `validateTaskpackManifest` parses optional `publishOnFailure` (`boolean`, default `false`) and `skipCi` (`boolean`, default `true`) in `spec.memory`; when `apply === 'separate-pull-request'` and `publishOnFailure !== true`, failed or incident runs skip remote memory branch/PR publication (`status: 'skipped'`, `reason: 'failure_publication_disabled'`) while `publishOnFailure: true` and `apply: 'local-only'` still apply failure observations; when `skipCi !== false`, memory branch commit messages include `[skip ci]` in the commit body before `Signed-off-by:` while keeping commit subject and PR title clean (`skipCi: false` omits `[skip ci]`); `docs/` and `site/` document both fields and pass `lint:docs`, `site`, and all test suites.
      Verify: `npm run build && npm run typecheck && npm run lint && npm run lint:docs && npm run site && npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/memory/test/*.test.js .test-build/packages/github-app/test/*.test.js .test-build/packages/cli/test/closure-and-failure-matrix.test.js .test-build/packages/cli/test/docs-and-site.test.js`

### Test Plan

[x] I/we understand the owners of the involved components may require updates to existing tests to make this
code solid enough prior to committing the changes necessary to implement this enhancement.

#### Prerequisite testing updates
Update existing assertions in `packages/memory/test/cas-concurrency.test.ts`, `packages/memory/test/finalizer-verifier.test.ts` (including the deterministic `no_change` test), `packages/github-app/test/turnkey-memory.test.ts`, `packages/github-app/test/turnkey-memory-budget.test.ts`, and `packages/github-app/test/turnkey-memory-cas-guards.test.ts` that previously expected retired entries to remain in `index.retired`/`entries/<id>.md` or expected `no_change` runs to emit routine `fact` entries.

#### Unit tests
- `@loopwright/memory`: `2026-11-19` - `>= 90%` over new lifecycle/GC paths (`store-selector.test.ts`, `finalizer-verifier.test.ts`, `cas-concurrency.test.ts`, `pr-formatting.test.ts`: `64 KiB` / `2 MiB` `fstat` rejection, direct `.md` unlink + deletion diff, `faultInjectionHook` rollback of unlinked `.md`, legacy `index.retired` load & purge, loose fingerprint/upstream default vs strict opt-in, silent `no_change` with zero stale entries vs `no_change` with stale retirements, eager expiry/incident retirement, `maxEntries = 128` eviction, `invariant -> failure_observation -> fact` prompt truncation and `maxBytes` cap).
- `@loopwright/github-app`: `2026-11-19` - `>= 90%` over new YAML schema and Turnkey GC paths (`taskpack-intake.test.ts`, `turnkey-memory.test.ts`: `ttlDays`/`maxEntries`/`maxPromptEntries`/`checkCodeFingerprint`/`checkUpstreamVersions` bounds, `apply: disabled` and `apply: local-only`, retire-only cleanup PR on `no_change`, squash-merged deletion branch detection, non-blocking primary outcome on memory failure or oversized file).

#### Integration tests
- Integrated failure matrix (`packages/cli/test/closure-and-failure-matrix.test.ts`): verify `stale_memory_source_exclusion` and `compaction_pending_operation_preservation` pass unchanged.
- Documentation and site contract (`packages/cli/test/docs-and-site.test.ts`): verify `docs/configuration/taskpack.md` Macro YAML validates via `validateTaskpackManifest` and `npm run lint:docs` + `npm run site` pass.

#### e2e tests
Local bare-remote Git + mock GitHub REST API Turnkey cycles in `packages/github-app/test/turnkey-memory.test.ts` exercise end-to-end Run 1 (failure/incident memory PR) -> merge -> Run 2 (`no_change` / `completed` healing & deleting stale `.md` files in a separate cleanup PR) -> squash-merge -> Run 3 (`no_change` silent zero-PR sweep). Live GitHub production qualification is out of scope for offline CI.

## Alternatives

- **Expose `maxEntryBytes` / `maxPromptBytes` in `.loopwright/taskpack.yaml`**: Rejected because enforcing `64 KiB` per entry file, `2 MiB` for `index.json`, and `4 KiB` / `16 KiB` prompt caps internally prevents memory bloat without adding low-level byte math to user configuration.
- **Retain `retired/` directory or keep `index.retired` with a separate physical `prune` operation**: Rejected because Git commit history already stores full diffs of deleted `entries/<id>.md` files; two-stage retirement (`active -> retired -> pruned`) doubles state complexity and leaves dead `.md` files in the repository tree.
- **Bump `MemoryStoreIndex` to `version: 2` and remove the `retired` JSON property**: Rejected because keeping `version: 1` with `retired: []` achieves the exact same empty-index footprint while preserving backward-compatible loading of existing v1 stores without dual-version digest schemas.

## Open Questions

None.
