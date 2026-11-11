---
name: loopwright-overview
description: Route Loopwright architecture and source questions.
---

# Loopwright Overview

## Architecture in brief

The nine packages are [core](../../../packages/core/), [state](../../../packages/state/), [agent-pi](../../../packages/agent-pi/), [controller](../../../packages/controller/), [taskpack-runner](../../../packages/taskpack-runner/), [memory](../../../packages/memory/), [decisions](../../../packages/decisions/), [github-app](../../../packages/github-app/), [cli](../../../packages/cli/). Read [architecture](../../../docs/getting-started/architecture.md) for the execution and verification chain.

## Routing

Use the [module map](../../../docs/README.md#module-map): [contracts](../../../docs/README.md#contracts-and-evidence), [state](../../../docs/README.md#persistent-state-store), [pi-adapter](../../../docs/README.md#isolated-pi-adapter), [controller](../../../docs/README.md#bounded-controller-and-cli), [taskpacks](../../../docs/README.md#declarative-taskpacks-and-runner-parity), [memory](../../../docs/README.md#reviewed-memory-and-compaction), [github-app](../../../docs/README.md#github-app-and-action-control-plane), [decisions](../../../docs/README.md#system-one-decision-routing), and [development](../../../docs/README.md#development-and-release).

## Contributor invariants

Use strict ESM NodeNext and zero `any`; validate null-prototype boundaries. Preserve SQLite lease fencing and monotonic clock guards. System-One has three decision zones and six non-delegable intents; keep deterministic authority. Scrub secrets and keep zero `.github/workflows/` files in this repository.
