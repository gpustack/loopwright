# Loopwright

Private TypeScript contracts, evidence-bound acceptance, persistent local state and an isolated Pi adapter.
The core library validates data and evaluates caller-selected evidence. The state package adds shared admission,
fenced ownership, intent/receipt journals and checkpoints over retained local SQLite.
The Pi adapter connects admitted roles to pinned SDK sessions, contained tools and a host-owned request sender.

Tested environment: macOS arm64, Node v26.13.0, npm 11.20.0.

```sh
npm ci
npm run build
npm run typecheck
npm run lint
npm test
```

Tests need no credentials or live services after dependency installation.

Read [contracts](docs/contracts.md), [identity rules](docs/identity.md),
[evidence authority](docs/evidence.md), and [development](docs/development.md).
The [examples](examples/README.md) include satisfied, failed, missing-check, and unknown-usage results.
Read [persistent local state](docs/state.md) for the qualified SQLite/runtime profile and host protocol.
The [core specification](specs/2026-11-05-task-contracts-and-evidence.md) defines the exact alpha schema and limits.

The caller authenticates verifier observations and selects the expected admission lock.
The core keeps actor claims separate and recomputes acceptance during run construction.
The state package accounts for trusted host requests; adapters still authenticate evidence and enforce actual dispatch.
Core and state do not execute agents. The private [Pi adapter](docs/pi-adapter.md) adds local Docker execution;
it does not evaluate task acceptance or publish changes. Its default context mode refuses without a proven bound.
Explicit estimated mode retains context uncertainty and soft token accounting.

Read the [runtime evaluation](docs/pi-runtime-evaluation.md) for SDK/durable selection, optional-plugin disposition,
finite limits and measured local costs. Live-provider qualification is blocked without an explicit ready-token source.
Docker and live checks are separate commands; the normal test total does not imply either passed.
