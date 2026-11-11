---
title: Documentation
---

# Documentation

Run Loopwright in GitHub Actions, deploy the GitHub App control plane, run CLI closure audits, or integrate the TypeScript SDK.

## Getting started

- [Architecture](getting-started/architecture/) explains the execution chain and core vocabulary.

## Operations and walkthroughs

- [GitHub Action](operate/github-action/) configures the reusable Action in workflows.
- [GitHub App](operate/github-app/) deploys the webhook and intake control plane.
- [CLI Operations](operate/cli/) runs local inspection, qualification and closure verification.
- [Declarative Taskpack](walkthroughs/declarative-taskpack/) configures declarative taskpacks end to end.

## Modules

- [Contracts](contracts/) describes task contracts and schema definitions.
- [Identity](identity/) covers canonical identities and content hashing.
- [Evidence](evidence/) details verification evidence and non-delegable authority.
- [State Store](state/) explains fenced SQLite persistence.
- [Pi Adapter](pi-adapter/) covers isolated coding-agent runtime boundaries.
- [Runtime Evaluation](pi-runtime-evaluation/) describes runtime qualification.
- [Controller](controller/) explains the repair loop and bounded control.
- [Runner Taskpack](runner-taskpack/) covers runner intake and offline parity.
- [Memory](memory/) details reviewed memory and CAS compaction.
- [Control Plane](github-app/) describes the intake gate and GitHub App service.
- [Decision Routing](decisions/) details System-One advisory routing.
- [Closure Matrix](closure-matrix/) documents demonstrated capabilities and failure semantics.

## Contribute and decisions

- [Development](development/) outlines building, testing and verifying the harness.
- [Internals](contribute/internals/) details package structure and boundary invariants.
- [ADR 0001: Local State](adr/0001-local-state-authority/) records local state authority decisions.
- [ADR 0002: Isolated Pi SDK](adr/0002-isolated-pi-sdk/) records isolated Pi SDK decisions.
