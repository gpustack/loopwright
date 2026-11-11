# Agent Guide

Loopwright is a nine-package TypeScript harness and GitHub Action/App control plane for bounded, verified repository work.

## Project Structure

- `packages/core`: contracts, identity, evidence; `packages/state`: fenced SQLite state.
- `packages/agent-pi`: isolated runtime; `packages/controller`: orchestration and verification.
- `packages/taskpack-runner`: runner parity; `packages/memory`: reviewed memory.
- `packages/decisions`: advisory routing; `packages/github-app`: intake and App; `packages/cli`: local operations.
- `action.yml`: reusable Action; `docs/`: usage contracts; `site/`: generated documentation site; `specs/`: rationale; `scripts/`: automation.

## Architecture

Intake and TaskContract → fenced SQLite StateStore → isolated Pi adapter and System-One decision router → independent verification → authenticated gates and receipts → publication and reviewed memory compaction → capability closure matrix. See [architecture](docs/getting-started/architecture.md) and the [module map](docs/README.md#module-map).

## Finding sources

Start with the [module map](docs/README.md#module-map). `docs/` owns usage contracts, `specs/` owns rationale and measurements, and `packages/` is current implementation. Update the index and run `npm run lint:docs` and `npm run site` when pages or module boundaries change.

## Development

Run `npm run build`, `npm run typecheck`, `npm run lint`, `npm run lint:docs`, and `npm run site`. Focus a package suite with `npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/<pkg>/test/*.test.js`. See [development](docs/development.md).

Use `loopwright-overview` for architecture routing, `loopwright-docs` for documentation changes, `loopwright-code-review` for reviews, `loopwright-issue-pr` for issue or PR preparation, and `loopwright-release` for releases.

### TypeScript conventions

Use strict ESM NodeNext, explicit public boundaries and no `any`. Validate untrusted records including null-prototype objects; keep bounded parsing and deterministic behavior.

### Authority and security conventions

Preserve lease fencing and monotonic clock guards, secret scrubbing, least privilege, non-delegable authority, and unknown outcomes. Never silently retry uncertain external effects. Do not add repository `.github/workflows/` files.

### Testing conventions

Exercise public boundaries, negative paths, limits and uncertainty. Distinguish fixture and local evidence from live provider, host, billing and production qualification.
