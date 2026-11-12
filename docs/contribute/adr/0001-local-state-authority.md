# ADR 0001: Local State Authority

Date: 2026-11-05
Status: Accepted

## Contents

- [Context](#context)
- [Decision](#decision)
- [Alternatives](#alternatives)
- [Consequences](#consequences)
- [Verification](#verification)

## Context

A task run needs one shared allowance, stable operation identities and honest recovery after a host process exits.
The first storage format must keep authority, reservations and operation intents together without adding a separate
service. Available acceptance resources are one macOS arm64 host, Node v26.13.0, local storage and owned subprocesses.

## Decision

Use Node's bundled SQLite 3.54.1 in a separate private state package. One retained database contains one immutable run identity. BEGIN IMMEDIATE serializes current-owner checks, ledger updates and related intents or receipts. DELETE journaling with synchronous EXTRA and fullfsync is the frozen local profile. Every mutation fences current owner ID, generation and a random nonce.

A committed dispatch marker grants a permit only on its first acknowledgement; reopening it exposes uncertainty. Checkpoints reference the current authority and cannot reset a live ledger. An immutable creation clock basis prevents gradual tolerated drift, reopen or lease renewal from extending the task.

## Alternatives

- In-memory state cannot retain charges or uncertainty across process exit.
- Separate JSON files would require a new atomic multi-record commit and locking protocol.
- A remote database/service would need unavailable deployment and host-loss acceptance resources.
- A third-party SQLite native binding would add install/build/upgrade work while this exact Node includes SQLite.
- The earlier durable-agent prototype did not provide the required duplicate-owner and interrupted-usage guarantees;
  adopting it would not discharge the store's authority/accounting obligations.

## Consequences

No new external runtime or native-build dependency is required. SQLite/profile upgrades and format migration need
explicit future qualification. Only the measured darwin/arm64 Node/SQLite profile is accepted, so a runtime upgrade
currently requires deliberate integration work. Bounded whole-run verification favors simple invariant checking over
throughput; requests, operations, checkpoints and pages have finite caps, and unresolved rows are never pruned.

The trusted host still owns canonical paths, boot identity, receipt authentication and actual dispatch enforcement.
Local SIGKILL tests qualify process recovery with retained storage. They establish no host/power-loss durability,
external exactly-once effect, provider-internal billing or OS containment guarantee.

## Verification

Local tests and retained qualification evidence cover the stated host and runtime profile. They do not establish live provider, host-loss, or production acceptance.


---

**See also** — [Persistent Local State Store](../state.md) (lease fencing and recovery rules)

**Next** → [ADR 0002: Isolated Pi SDK](0002-isolated-pi-sdk.md) — review the isolated runtime boundary decision.
