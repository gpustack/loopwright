# Reviewed Memory and CAS Compaction

`@loopwright/memory` keeps repository-scoped active knowledge for a taskpack under
`.loopwright/memory/<taskpack>/`, curates it into verified proposals after a cycle settles, and controls the
two-layer context compaction of an agent session. The package never changes a primary `RunResult`, never
spends exhausted model budget, and never writes outside the taskpack memory directory.

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

Three stores stay strictly apart:

1. **Active task knowledge** — `.loopwright/memory/<taskpack>/` in the target repository: `index.json`,
   one reviewable `entries/<id>.md` per entry, and an exclusive `.cas.lock` during applies.
2. **Immutable run evidence** — content-addressed artifacts of the run store; memory entries cite them,
   they never copy them.
3. **Mutable run execution state** — `LocalRunStore` SQLite ledgers, owner leases, and private session
   captures; memory never reads or writes them.

Symbolic links, `..` traversal, and `.sqlite`, `run.json`, `privateSession`, or `checkpoint*` artifact names
are refused anywhere inside `.loopwright/memory/`; the taskpack store accepts only `index.json`,
`entries/`, and `.cas.lock`, and `repository` fields always carry an `org/repo` slug, never a host path.

## Entries

A `MemoryEntry` (`version: 1`) binds a bounded claim (`1..2048` bytes) to a `claimKey`, a `kind`
(`fact`, `failure_observation`, or `invariant`), the taskpack/repository/path scope, provenance
(`runId`, `lockHash`, `candidateDigest`, `sourceDigest`), validity (`baseRevision`, `sourceRevision`,
`codeFingerprint`, `upstreamVersions`), an expiry, prior ids it supersedes, and `1..16` evidence
references that resolve against the run's authenticated `VerificationResult` and artifact inventory.
Each `entries/<id>.md` carries the canonical JSON entry between `---` fences plus the claim body, so a
plain Git diff shows additions, replacements, and retirements.

`computeCodeFingerprint` hashes the sorted `{ path, sha256, byteLength }` manifest of the files matching
the entry's watched patterns; `selectActiveMemory` excludes an entry from the active snapshot when it is
`expired`, `superseded`, `fingerprint_mismatched`, `upstream_version_changed`, `scope_mismatched`,
`unverified_claim`, or `hardware_or_gate_unproven` — and records every exclusion with its reason while
keeping the audit trail in the index. Supersession requires a *valid* successor: an expired or drifted
successor does not retire its predecessor. A row in `index.retired` whose id also exists in
`index.entries` (a committed same-id replacement) stays active; only rows without a current entry are
reported as retired exclusions. The snapshot digest covers store content only, not evaluation time, so
drift detection compares meaningfully across calls. `bindMemorySnapshotToResource` produces a
`trustedContext.resources` descriptor for the current snapshot; `memorySnapshotBindingMatches` verifies
a contract's pinned digest against it.

## Settled-outcome finalization

`finalizeRunMemory` accepts a retained run directory or an in-memory settled summary and handles every
settled outcome: `completed`, `no_change`, `failed`, `blocked`, `exhausted`, `expired`, `cancelled`, and
`reconcile_required`/`incident`. Passing checks on positive runs become `fact` entries bound to the
authenticated evidence; failing, blocked, or absent checks on the other outcomes become
`failure_observation` entries; an incident becomes a failure observation with a `not_run` incident
reference. The finalizer treats the primary `RunResult`/`VerificationResult` as frozen inputs and
confines every fault — including a curator throw, timeout, or invalid emission — to the returned
`MemoryObservation` (`status: 'unavailable'`).

The curator port runs only when budget remains and the port is configured. With
`onNoModelBudget: 'deterministic-observations-only'`, an exhausted budget never invokes the curator:
entries are synthesized deterministically, and a requested-but-skipped curator pass archives the
proposal as `pending` with `no_model_budget_deterministic_only`. The emitted proposal carries the base
store digest and revision plus `memory.json` and a unified `memory.patch` over the memory directory.

## Five-gate verification

`verifyMemoryProposal` re-checks every proposal before any store update:

1. `memory-schema` — proposal and entry structure, bounds, and `verifiedAtMs < expiresAtMs`.
2. `provenance` — proposal and entry identity against the settled lock, run, candidate digest, and
   authenticated evidence; `fact`/`invariant` entries require a `completed`/`no_change` run with only
   `passed` citations.
3. `scope` — every target and patch path stays inside `.loopwright/memory/<taskpack>/` and never touches
   contract scope patterns, `.github/**`, or `.loopwright/policies/**`; traversal is refused outright.
4. `redaction` — caller-supplied secret values, credential patterns, injection sentinels, and control
   characters never reach proposal text.
5. `memory-review` — superseded ids exist and are active, supersession cycles and duplicate targets are
   rejected, and an unresolved claim-key overlap is a `MEMORY_CONFLICT_UNRESOLVED`.

## Compare-and-swap application

`applyMemoryProposalCAS` re-verifies, then acquires `.cas.lock` (`O_CREAT | O_EXCL | O_NOFOLLOW`,
`0o600`, removed in `finally`), re-checks the store digest under the lock, and applies by staging every
file as an atomic `0o600` temporary with `fsync`, renaming entry files into place first and
`index.json` last; a failure at any step restores the recorded prior bytes, removes the temporaries,
and releases the lock. Superseded entries move into `index.retired` with their successor recorded. A
matching `baseStoreDigest` and revision applies directly. A drifted store rebases only when the caller
retained the base store, the concurrent delta is disjoint from every touched entry id and claim key,
and the merged result re-passes all five gates; otherwise it refuses with `MEMORY_CAS_CONFLICT` and
performs zero writes. The result carries a `SeparateMemoryPullRequestSpec` — branch, title, body with
operation counts and cited evidence digests, `modifiedFiles` with content and SHA-256, a unified patch
that treats a new `index.json` as `--- /dev/null`, and `excludesCodeCandidatePaths: true` — so reviewed
memory travels on its own pull-request boundary, never inside a code candidate.

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

`buildCompactionSummary` constructs the canonical 12-field `CompactionCheckpointSummary` (goal and
non-goals, contract hash, current node, check buckets, evidence refs, modified files, open issues,
forbidden actions, pending external operations, budget ledger reference, refreshed active memory
snapshot, next allowed actions) and its digest; the refresh re-runs `selectActiveMemory` so entries that
expired or drifted are purged from the post-compaction context. `restoreFromCompactionLedger` rebuilds
execution state strictly from the persisted ledger and the snapshot, raising
`COMPACTION_AUTHORITY_VIOLATION` when summary text would grant new writable paths, mark unverified
checks as passed, drop pending external operations, increase budgets, or come from a foreign contract.

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

Staging temporaries (`index.json.tmp-<pid>-<nonce>`, `<id>.md.tmp-<pid>-<nonce>`) are recognized only
while their `.cas.lock` names a structured payload (`version`, `pid`, 12-hex `nonce`, `touchedEntryIds`)
whose writer process is still alive; in that window the loader returns the committed store, fills
`entryFiles` with the committed `index.json` bytes for in-flight entries, and refuses staging names for
untouched entries. Once the lock is stale (writer dead), unstructured, or removed, every staging file,
orphan entry file, or entry-file/index drift is refused, and manual recovery is to delete the stale
`.cas.lock`, the leftover `.tmp-*` files, and any `entries/<id>.md` that has no index row, or to restore
`index.json` and `entries/` from Git.

**See also**: [Documentation index](README.md)

**Next**: [Architecture](getting-started/architecture.md)
