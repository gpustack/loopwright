# Reviewed Memory and CAS Compaction

`@loopwright/memory` keeps repository-scoped active knowledge for a taskpack under
`<memoryRoot>/<taskpack>/` (default `.loopwright/memory/<taskpack>/` or a custom root like `.auto-sync/memory/<taskpack>/`).
It curates settled runs into verified proposals and controls two-layer agent session compaction.
The package never mutates a primary `RunResult`, never spends exhausted model budget, and never writes outside the taskpack memory directory.

## Contents

- [Three-tier separation](#three-tier-separation)
- [Entries](#entries)
- [Settled-outcome finalization](#settled-outcome-finalization)
- [Five-gate verification](#five-gate-verification)
- [Compare-and-swap application](#compare-and-swap-application)
- [Two-layer compaction](#two-layer-compaction)
- [Commands](#commands)
- [Crash recovery](#crash-recovery)

## Three-tier separation

Reviewed memory is an optional record of settled work, not authority to change a task result. Content-addressed blobs and their digests make retained evidence identifiable.

| Stage | Boundary |
| --- | --- |
| Propose | Deterministic entries or model-assisted suggestions use settled evidence. |
| Verify | Independent gates validate provenance, claims, scope, and redaction. |
| Select | Watched-file drift excludes stale entries from the active snapshot. |
| Apply | Compare-and-swap checks the reviewed base before a separate memory pull request. |

Three stores stay strictly apart:

1. **Active task knowledge** — `.loopwright/memory/<taskpack>/` in the target repository: `index.json`,
   one reviewable `entries/<id>.md` per entry, and an exclusive `.cas.lock` during applies.
2. **Immutable run evidence** — content-addressed artifacts of the run store; memory entries cite them,
   they never copy them.
3. **Mutable run execution state** — `LocalRunStore` SQLite ledgers, owner leases, and private session
   captures; memory never reads or writes them.

Symbolic links, `..` traversal, and `.sqlite`, `run.json`, `privateSession`, or `checkpoint*` artifact names
are refused anywhere inside `.loopwright/memory/`. The taskpack store accepts only `index.json`,
`entries/`, and `.cas.lock`, and `repository` fields always carry an `org/repo` slug, never a host path.
`readRegularFile` checks `fstat.size` before reading, capping each `entries/<id>.md` at `64 KiB` and `index.json` at `2 MiB`.

## Entries

A `MemoryEntry` (`version: 1`) binds a bounded claim (`1..2048` bytes) to a `claimKey`, a `kind` (`fact`, `failure_observation`, or `invariant`), the taskpack/repository/path scope, provenance (`runId`, `lockHash`, `candidateDigest`, `sourceDigest`), validity (`baseRevision`, `sourceRevision`, `codeFingerprint`, `upstreamVersions`), an expiry, prior ids it supersedes, and `1..16` evidence references that resolve against the run's authenticated `VerificationResult` and artifact inventory.

Each `entries/<id>.md` carries the canonical JSON entry between `---` fences plus the claim body. Active stores keep `index.retired: []`; retiring or superseding an entry removes it from `index.entries` and deletes `entries/<id>.md`.

`loadMemoryStore` still accepts legacy `index.json` (`version: 1`) files with non-empty `retired` arrays and purges legacy `retired` rows plus orphan `.md` files on the next applied proposal.

`checkCodeFingerprint` and `checkUpstreamVersions` default to `false`; when `currentCodeFingerprint` or `currentUpstreamVersions` is `null` or `undefined`, `selectActiveMemory` skips those exclusions. When non-null values are supplied, `selectActiveMemory` enforces `fingerprint_mismatch` and `upstream_version_changed`.

`selectActiveMemory` filters `ownExclusion` (including `targetMatrix`), `expired`, and `superseded` before applying `maxPromptEntries` (default `32`) and internal byte caps (`16_384` resource / `4_096` inline prompt). It keeps entries in priority order (`invariant` -> `failure_observation` -> `fact`, newest `verifiedAtMs` first) and sanitizes single-line claims.

Supersession requires a *valid* successor: an expired or drifted successor does not retire its predecessor. The snapshot digest covers store content only, not evaluation time, so drift detection compares meaningfully across calls.

`bindMemorySnapshotToResource` produces a `trustedContext.resources` descriptor for the current snapshot; `memorySnapshotBindingMatches` verifies a contract's pinned digest against it.

## Settled-outcome finalization

`finalizeRunMemory` accepts a retained run directory or an in-memory settled summary and handles every settled outcome: `completed`, `no_change`, `failed`, `blocked`, `exhausted`, `expired`, `cancelled`, and `reconcile_required`/`incident`.

Passing checks on `completed` runs become `fact` entries bound to authenticated evidence. Deterministic `no_change` runs skip routine `fact` synthesis so healthy scheduled sweeps emit `operations: []` with zero PR churn. Failing, blocked, or absent checks become `failure_observation` entries, normalizing `/tmp/loopwright-gate-...` paths to `<gate-workdir>`.

Default retention uses a `15`-day TTL (`DEFAULT_MEMORY_TTL_DAYS = 15`) and `128` active entries (`DEFAULT_MEMORY_MAX_ENTRIES = 128`). `targetMatrix` passes through from config into `MemoryEntry.scope.targetMatrix`.

Before capacity eviction, `finalizeRunMemory` eagerly emits `retire` operations for expired entries, drifted `upstreamVersions` (when `checkUpstreamVersions` is `true`), and healed `failure_observation` entries. Excess entries past `maxEntries` evict deterministically (`failure_observation` -> `fact` -> `invariant`, oldest `verifiedAtMs` first).

The finalizer treats the primary `RunResult`/`VerificationResult` as frozen inputs and confines every fault — including a curator throw, timeout, or invalid emission — to the returned `MemoryObservation` (`status: 'unavailable'`).

The curator port runs only when budget remains and the port is configured. With
`onNoModelBudget: 'deterministic-observations-only'`, an exhausted budget synthesizes deterministic entries without invoking the curator.
With `onNoModelBudget: 'skip'`, finalization returns `pending` (`no_model_budget_skipped`) and emits no proposal.
Emitted proposals carry the base store digest, revision, `memory.json`, and a unified `memory.patch` over `<memoryRoot>/<taskpack>/`.

## Five-gate verification

`verifyMemoryProposal` re-checks every proposal before any store update:

1. `memory-schema` — proposal and entry structure, bounds, and `verifiedAtMs < expiresAtMs`.
2. `provenance` — proposal and entry identity against the settled lock, run, candidate digest, and
   authenticated evidence; `fact`/`invariant` entries require a `completed`/`no_change` run with only
   `passed` citations.
3. `scope` — every target, added path, and deleted path (`+++ /dev/null`) stays inside `.loopwright/memory/<taskpack>/` and never touches
   contract scope patterns, `.github/**`, or `.loopwright/policies/**`; traversal is refused outright.
4. `redaction` — caller-supplied secret values, credential patterns, injection sentinels, and control
   characters never reach proposal text.
5. `memory-review` — superseded ids exist and are active, supersession cycles and duplicate targets are
   rejected, and an unresolved claim-key overlap is a `MEMORY_CONFLICT_UNRESOLVED`.

## Compare-and-swap application

`applyMemoryProposalCAS` re-verifies, then acquires `.cas.lock` (`O_CREAT | O_EXCL | O_NOFOLLOW`, `0o600`, removed in `finally`), and re-checks the store digest under the lock. It backs up prior bytes for modified and deleted `.md` files, unlinks retired `entries/<id>.md` files before renaming `index.json`, and restores unlinked `.md` files (`0o600`) on rollback.

Retiring or superseding an entry removes it from `index.entries`, leaves `index.retired: []`, and compacts any legacy `retired` rows. A matching `baseStoreDigest` and revision applies directly; a drifted store rebases only when disjoint and all five gates pass, otherwise failing with `MEMORY_CAS_CONFLICT`.

The result carries a `SeparateMemoryPullRequestSpec` with unified deletion diffs (`+++ /dev/null`) and `excludesCodeCandidatePaths: true`. `apply: separate-pull-request` opens cleanup PRs even when `no_change` runs only retire stale entries, while `local-only` and `disabled` skip remote memory PRs.

In `@loopwright/github-app`, `separate-pull-request` skips failed or incident runs by default (`publishOnFailure: false`) while `@loopwright/memory` and `local-only` still record `failure_observation` entries. Memory commits insert `[skip ci]` in the body before the `Signed-off-by:` trailer (`skipCi: true`) while keeping commit subjects and PR titles clean.

## Two-layer compaction

`evaluateCompactionPolicy` decides before each request:

- **Hard, non-vetoable** — `hard_context_window` (next request plus reserves exceeds the window) or
  `memory_snapshot_drift` (session snapshot digest differs from the active snapshot). An advisory
  decision cannot veto them. The persisted-checkpoint precondition, the unpaired-tool-call guard, and
  the post-compaction overflow guard run before every `compact_now`, hard or soft: any unpaired tool
  call blocks with `COMPACTION_UNSAFE_BOUNDARY`, a missing or invalid checkpoint reference blocks the
  same way, and an estimate that would still overflow blocks with `CONTEXT_OVERFLOW_BLOCKED`.
- **Soft, vetoable** — utilization above the threshold, repeated check failures (`repeat_failure`), or a
  long external wait after operation receipts persist, with positive `netTokenSavings`;
  `advisoryDecision: 'defer'` vetoes. Only structured telemetry is evaluated, never the transcript.

`buildCompactionSummary` constructs the canonical 12-field `CompactionCheckpointSummary` (goal and non-goals, contract hash, current node, check buckets, evidence refs, modified files, open issues, forbidden actions, pending external operations, budget ledger reference, refreshed active memory snapshot, next allowed actions) and its digest; the refresh re-runs `selectActiveMemory` so entries that expired or drifted are purged from the post-compaction context.

`restoreFromCompactionLedger` rebuilds execution state strictly from the persisted ledger and the snapshot, raising `COMPACTION_AUTHORITY_VIOLATION` when summary text would grant new writable paths, mark unverified checks as passed, drop pending external operations, increase budgets, or come from a foreign contract.

## Commands

```sh
npm run build
npm run typecheck
npm run lint
npm test
npm --workspace @loopwright/memory test
```

All behavior is local and deterministic; the suite needs no credentials, model, Docker, or network.

## Crash recovery

Staging temporaries (`index.json.tmp-<pid>-<nonce>`, `<id>.md.tmp-<pid>-<nonce>`) are recognized only while their `.cas.lock` names a structured payload (`version`, `pid`, 12-hex `nonce`, `touchedEntryIds`) whose writer process is still alive; in that window the loader returns the committed store, fills `entryFiles` with the committed `index.json` bytes for in-flight entries, and refuses staging names for untouched entries.

Once the lock is stale (writer dead), unstructured, or removed, every staging file, orphan entry file, or entry-file/index drift is refused, and manual recovery is to delete the stale `.cas.lock`, the leftover `.tmp-*` files, and any `entries/<id>.md` that has no index row, or to restore `index.json` and `entries/` from Git.


---

**See also** — [Decision Routing](../configuration/decision-routing.md) (advisory routing policy)

**Next** → [GitHub App Control Plane Internals](github-app-internals.md) — inspect webhook intake and taskpack compilation.
