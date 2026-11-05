# Loopwright

Private TypeScript contracts and evidence-bound acceptance for a future task host.
The core library validates data and evaluates caller-selected evidence.

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
The [specification](specs/2026-11-05-task-contracts-and-evidence.md) defines the exact alpha schema and limits.

The caller authenticates verifier observations and selects the expected admission lock.
The library keeps actor claims separate and recomputes acceptance during run construction.
It does not execute agents, provide process isolation, settle budgets, or publish changes.
