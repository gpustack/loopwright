# Persistent Local State Store

`@loopwright/state` stores one admitted run in one retained local directory. It supplies ownership,
shared token admission, an intent/receipt journal and checkpoint references. It executes no requests or effects.
The public types are in [types.ts](../../packages/state/src/types.ts); the complete contract and transition rules
are in the [state specification](../../specs/2026-11-05-persistent-state-and-admission.md).

## Contents

- [Supported storage and clock](#supported-storage-and-clock)
- [Host protocol](#host-protocol)
- [Accounting and uncertainty](#accounting-and-uncertainty)
- [Errors and bounded storage](#errors-and-bounded-storage)
- [Evidence boundary](#evidence-boundary)

## Supported storage and clock

The qualified profile covers macOS arm64 and Linux arm64 or x64 on Node 26.x with bundled SQLite 3.x, local storage, and processes on the same host and boot. Each store records its exact host and runtime tuple on creation and rejects other platform, architecture, Node or SQLite profiles. Use an absolute canonical directory on a filesystem that honors SQLite locking. The trusted host owns the path, access permissions and `clockEpoch`, which must identify this boot and monotonic clock domain.

Do not copy an old store into a new authority, roll it back to a snapshot, replace its file, use a network filesystem, or reuse the clock epoch after reboot. These actions are outside the qualified profile.

The database uses 4 KiB pages, DELETE rollback journals, synchronous EXTRA, fullfsync and checkpoint_fullfsync, normal locking, foreign keys, trusted_schema off, a 250 ms busy timeout, a 2 MiB cache and mmap disabled. The main database is capped at 65,536 pages (256 MiB); allow extra local space for the rollback journal. Each write uses BEGIN IMMEDIATE through one commit boundary.

The store verifies schema, identity, row hashes, links, counts and the recomputed ledger on load. Hashes detect inconsistency; they do not authenticate a hostile host.

The immutable creation sample binds civil and monotonic time. Admission and lease decisions use monotonic milliseconds; civil timestamps are display values. Adjacent rollback or more than 1,000 ms adjacent or cumulative civil/monotonic drift blocks authority. Renew, reopen and checkpoints preserve the original task deadline.

The local clock tests use private injected samples; real child processes also check the measured shared clock domain. This does not qualify suspension, reboot, power loss or host loss.

## Host protocol

State serializes authority changes with SQLite transactions. It uses a DELETE rollback journal, not WAL; opening a store with a different journal mode is refused.

| Stage | Guard |
| --- | --- |
| Acquire | The current owner receives a generation and nonce. |
| Reserve | State records request allowance before physical send. |
| Dispatch | A one-use permit binds the operation to the current fence. |
| Recover | Uncertain effects stay unresolved until trusted evidence settles them. |

A stale owner cannot mutate after a newer lease fence takes authority. The monotonic clock guard rejects untrusted time as `CLOCK_UNTRUSTED`; renewal does not extend the original task deadline.

1. Obtain a validated core `TaskLock`. Freeze a `LocalRunIdentity` with its lock, store ID, state policy,
   compatibility binding and directory. `createLocalRun(identity)` explicitly initializes it; an identical
   create retry returns the existing run. `reopenLocalRun(identity)` requires that same authoritative state.
   Missing or corrupt data is an error, never a fresh allowance.
2. Call `claim` with the currently inspected generation and revision. Securely distribute its `Authority`
   only to trusted callers. Every mutation rechecks current owner ID, nonce and generation in the write
   transaction. Renew before expiry; renewal cannot revive an expired token. A takeover leaves old work intact.
3. Call `reserveRequest` with a stable request ID, exact digest/target, purpose, repair/retry relationship,
   conservative input/output/total bounds and a matching adapter capability. The same transaction checks
   authority and all parent/child caps, creates the model intent and charges counters, tokens and a slot.
4. Call `authorizeRequestDispatch` immediately before initiating the provider attempt. Only a newly committed
   `new_dispatch` returns a one-time permit. The host checks the permit's generation and monotonic expiry at
   its actual dispatch boundary. An `existing` result is a lookup and provides no replay permission.
5. Normalize and authenticate provider evidence outside this package, then call `observeRequest`. For an old
   dispatch or unresolved usage, use explicit `reconcileRequest` with the current owner and definitive evidence.
   Timeout, cancellation and a dead local process alone do not prove non-execution.
6. For independent effects, use `putIntent`, `authorizeOperationDispatch`, then `recordOperationReceipt`.
   After an uncertain outcome or owner replacement, use `reconcileOperation`. Generic operation methods
   cannot bypass the model request ledger. Reads never replay an effect.
7. Publish checkpoints with the exact current `expectedRevision`, candidate manifest and artifact references.
   `recoveryView` checks current authority and required reference identities, then returns both historical
   checkpoint and current ledger facts. It does not fetch/verify artifact bytes or restore a workspace/session.
8. Check every `StateResult` and close the handle. `close` does not cancel provider work or release ownership.
   Use `release` for an intentional fenced relinquishment; callers still need to reconcile uncertain work.

An authority is a trusted local capability. Public types, hashes, saved request IDs, receipt labels and checkpoint
references do not authenticate a caller or producer. External sinks and adapters must enforce their own execution
boundary; a fenced store cannot stop a still-running old process from writing elsewhere.

## Accounting and uncertainty

| Fact | Token charge | Live slot |
| --- | --- | --- |
| Reserved, never dispatched | Full reservation | Held |
| Dispatched; termination unknown | At least reservation and any known token subtotal | Held |
| Termination confirmed; usage incomplete or estimated | At least reservation and known subtotal | Released |
| Termination confirmed; all token usage reported | Exact reported total | Released |
| Trusted proof of non-execution | Zero | Released |
| Guarded release before dispatch | Zero | Released |

Lifetime call, repair and retry counters are never refunded. Every purpose shares the parent allowance. A declared `soft_only` capability may reserve against local caps, but it makes no hard provider-bound promise. Reported and estimated usage/cost remain separate; unknown values remain unknown. Monetary cost is observe-only, with no hard price cap.

Large totals use exact decimal strings and `safeValue: null` when a JavaScript number would be unsafe. Over-reservation, parent overage and usage overflow persist observations and block new work; reconciliation does not silently erase a recorded violation.

Identical mutations are no-ops where the transition allows a retry. Reusing IDs with different immutable payloads
fails; conflicting receipts cannot replace known outcomes. Never-dispatched release and dispatch serialize against
each other. An old checkpoint cannot reset current counters, deadlines or unresolved work.

## Errors and bounded storage

Errors have a stable `code`, `path`, `retryable`, `commit` and diagnostics. Only STORE_BUSY and REVISION_CONFLICT
are flagged retryable; retry with the same identity after inspecting the current facts. STORE_BUSY is lock contention,
BUDGET_EXHAUSTED is a cap refusal, and STORE_FULL/STORE_UNAVAILABLE are storage failures. STALE_OWNER rejects an old
capability; OWNER_EXPIRED requires a new guarded claim. CLOCK_UNTRUSTED requires host diagnosis.

COMMIT_UNKNOWN poisons/closes that handle and returns no permit. Reopen the same store to inspect whether the
intent/marker/receipt committed. A saved dispatch marker still cannot yield a permit, so ambiguity requires
reconciliation rather than a blind resend. There is no automatic schema migration or import fallback.
See [errors.ts](../../packages/state/src/errors.ts) for the full closed code vocabulary.

| Limit | Bound |
| --- | --- |
| Retained requests / operations / checkpoints | 1,024 / 2,048 / 64 |
| Mutation input / request or operation row / checkpoint JSON | 64 KiB / 16 KiB / 64 KiB |
| Page | At most 100 items and 128 KiB |
| Boundary depth / nodes / properties / array items | 32 / 8,192 / 128 / 128 |

Pages bind store, run, collection and current revision; a concurrent mutation invalidates the cursor.
No rows are pruned, including unresolved work. At the cap, new records fail while valid settlement/reconciliation
can still update retained records. Keep stores until the host's retention policy can safely archive the entire run.

## Evidence boundary

The acceptance suite uses real SQLite files, independent IPC-coordinated child processes, recorded SIGKILL exits, lock contention and a local effect marker. It covers the seven specified crash windows, last-call/token/slot races, duplicate/conflicting identities, every stale-owner mutation family, and a restored production-fence mutation.

Synthetic trusted receipts, private clock samples, quota setup and native fault injection isolate software boundaries. They do not establish provider billing, producer authenticity, external exactly-once execution, host-loss durability, OS containment or deployment qualification. Future adapters, executors, publishers and services must prove those paths.


---

**See also** — [ADR 0001: Local State Authority](adr/0001-local-state-authority.md) (local state authority decision)

**Next** → [Isolated Pi Runtime Adapter](pi-adapter.md) — follow admitted execution across the runtime boundary.
