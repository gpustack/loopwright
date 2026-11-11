# Loopwright Documentation

## Reading paths

- [GitHub Action](operate/github-action.md) and [taskpack walkthrough](walkthroughs/declarative-taskpack.md)
- [GitHub App deployment](operate/github-app.md)
- [CLI operations and closure](operate/cli.md)
- [SDK architecture](getting-started/architecture.md) and [decision routing](decisions.md)
- [Development](development.md) and [internals](contribute/internals.md)

## Module map

### Contracts and Evidence

- ID: contracts
- Use for: contracts and evidence
- Aliases: contracts
- Guides: [contracts.md](contracts.md), [identity.md](identity.md), [evidence.md](evidence.md)
- Specs: [Specification](../specs/2026-11-05-task-contracts-and-evidence.md)
- Code: [core](../packages/core/)
- Related: [state](#persistent-state-store), [controller](#bounded-controller-and-cli)
- Skills: [overview](../.agents/skills/loopwright-overview/SKILL.md)

### Persistent State Store

- ID: state
- Use for: persistent state store
- Aliases: state
- Guides: [state.md](state.md)
- Specs: [Specification](../specs/2026-11-05-persistent-state-and-admission.md)
- Code: [state](../packages/state/)
- Related: [contracts](#contracts-and-evidence), [pi-adapter](#isolated-pi-adapter)
- Skills: [overview](../.agents/skills/loopwright-overview/SKILL.md)

### Isolated Pi Adapter

- ID: pi-adapter
- Use for: isolated pi adapter
- Aliases: pi-adapter
- Guides: [pi-adapter.md](pi-adapter.md), [pi-runtime-evaluation.md](pi-runtime-evaluation.md)
- Specs: [Specification](../specs/2026-11-05-isolated-pi-adapter.md)
- Code: [agent-pi](../packages/agent-pi/)
- Related: [state](#persistent-state-store), [controller](#bounded-controller-and-cli)
- Skills: [overview](../.agents/skills/loopwright-overview/SKILL.md)

### Bounded Controller and CLI

- ID: controller
- Use for: bounded controller and cli
- Aliases: controller
- Guides: [controller.md](controller.md), [operate/cli.md](operate/cli.md), [closure-matrix.md](closure-matrix.md)
- Specs: [Specification](../specs/2026-11-06-bounded-controller-and-trusted-config.md)
- Code: [controller](../packages/controller/), [cli](../packages/cli/)
- Related: [contracts](#contracts-and-evidence), [state](#persistent-state-store)
- Skills: [overview](../.agents/skills/loopwright-overview/SKILL.md)

### Declarative Taskpacks and Runner Parity

- ID: taskpacks
- Use for: declarative taskpacks and runner parity
- Aliases: taskpacks
- Guides: [runner-taskpack.md](runner-taskpack.md), [walkthroughs/declarative-taskpack.md](walkthroughs/declarative-taskpack.md)
- Specs: [Specification](../specs/2026-11-10-runner-taskpack-and-offline-parity.md)
- Code: [taskpack-runner](../packages/taskpack-runner/)
- Related: [github-app](#github-app-and-action-control-plane), [controller](#bounded-controller-and-cli)
- Skills: [overview](../.agents/skills/loopwright-overview/SKILL.md)

### Reviewed Memory and Compaction

- ID: memory
- Use for: reviewed memory and compaction
- Aliases: memory
- Guides: [memory.md](memory.md)
- Specs: [Specification](../specs/2026-11-11-reviewed-memory-and-cas-compaction.md)
- Code: [memory](../packages/memory/)
- Related: [controller](#bounded-controller-and-cli), [decisions](#system-one-decision-routing)
- Skills: [overview](../.agents/skills/loopwright-overview/SKILL.md)

### GitHub App and Action Control Plane

- ID: github-app
- Use for: github app and action
- Aliases: github-app
- Guides: [github-app.md](github-app.md), [operate/github-app.md](operate/github-app.md), [operate/github-action.md](operate/github-action.md)
- Specs: [Specification](../specs/2026-11-11-github-app-control-plane-and-declarative-taskpack.md), [OS Sandbox Backends](../specs/2026-11-11-native-os-sandbox-execution-backends.md)
- Code: [github-app](../packages/github-app/)
- Related: [taskpacks](#declarative-taskpacks-and-runner-parity), [controller](#bounded-controller-and-cli)
- Skills: [overview](../.agents/skills/loopwright-overview/SKILL.md)

### System-One Decision Routing

- ID: decisions
- Use for: system-one decision routing
- Aliases: decisions
- Guides: [decisions.md](decisions.md)
- Specs: [Specification](../specs/2026-11-11-jev-decision-routing-and-controlled-benchmark.md)
- Code: [decisions](../packages/decisions/)
- Related: [memory](#reviewed-memory-and-compaction), [controller](#bounded-controller-and-cli)
- Skills: [overview](../.agents/skills/loopwright-overview/SKILL.md)

### Development and Release

- ID: development
- Use for: development and documentation
- Aliases: development
- Guides: [development.md](development.md), [contribute/internals.md](contribute/internals.md)
- Specs: [Specification](../specs/2026-11-11-agents-skills-connected-docs-and-hugo-site.md)
- Code: [cli](../packages/cli/)
- Related: [contracts](#contracts-and-evidence), [controller](#bounded-controller-and-cli)
- Skills: [overview](../.agents/skills/loopwright-overview/SKILL.md), [docs](../.agents/skills/loopwright-docs/SKILL.md), [code-review](../.agents/skills/loopwright-code-review/SKILL.md), [issue-pr](../.agents/skills/loopwright-issue-pr/SKILL.md), [release](../.agents/skills/loopwright-release/SKILL.md)

## Specs

| Specification | Scope |
| --- | --- |
| [2026-11-05-isolated-pi-adapter.md](../specs/2026-11-05-isolated-pi-adapter.md) | isolated pi adapter |
| [2026-11-05-persistent-state-and-admission.md](../specs/2026-11-05-persistent-state-and-admission.md) | persistent state and admission |
| [2026-11-05-task-contracts-and-evidence.md](../specs/2026-11-05-task-contracts-and-evidence.md) | task contracts and evidence |
| [2026-11-06-bounded-controller-and-trusted-config.md](../specs/2026-11-06-bounded-controller-and-trusted-config.md) | bounded controller and trusted config |
| [2026-11-09-authenticated-gates-and-publication-boundaries.md](../specs/2026-11-09-authenticated-gates-and-publication-boundaries.md) | authenticated gates and publication boundaries |
| [2026-11-10-runner-taskpack-and-offline-parity.md](../specs/2026-11-10-runner-taskpack-and-offline-parity.md) | runner taskpack and offline parity |
| [2026-11-11-agents-skills-connected-docs-and-hugo-site.md](../specs/2026-11-11-agents-skills-connected-docs-and-hugo-site.md) | agents skills connected docs and hugo site |
| [2026-11-11-capability-closure-matrix-and-failure-semantics.md](../specs/2026-11-11-capability-closure-matrix-and-failure-semantics.md) | capability closure matrix and failure semantics |
| [2026-11-11-github-app-control-plane-and-declarative-taskpack.md](../specs/2026-11-11-github-app-control-plane-and-declarative-taskpack.md) | github app control plane and declarative taskpack |
| [2026-11-11-jev-decision-routing-and-controlled-benchmark.md](../specs/2026-11-11-jev-decision-routing-and-controlled-benchmark.md) | jev decision routing and controlled benchmark |
| [2026-11-11-native-os-sandbox-execution-backends.md](../specs/2026-11-11-native-os-sandbox-execution-backends.md) | native os sandbox execution backends |
| [2026-11-11-reviewed-memory-and-cas-compaction.md](../specs/2026-11-11-reviewed-memory-and-cas-compaction.md) | reviewed memory and cas compaction |

## All pages

### Getting Started

| Page | Description |
| --- | --- |
| [Loopwright Architecture](getting-started/architecture.md) | Loopwright Architecture reference |

### Operations

| Page | Description |
| --- | --- |
| [GitHub Action Configuration](operate/github-action.md) | GitHub Action Configuration reference |
| [GitHub App Deployment](operate/github-app.md) | GitHub App Deployment reference |
| [CLI Operations](operate/cli.md) | CLI Operations reference |

### Walkthroughs

| Page | Description |
| --- | --- |
| [Declarative Taskpack Walkthrough](walkthroughs/declarative-taskpack.md) | Declarative Taskpack Walkthrough reference |

### Modules

| Page | Description |
| --- | --- |
| [Task Contracts and Schemas](contracts.md) | Task Contracts and Schemas reference |
| [Canonical Identity and Digests](identity.md) | Canonical Identity and Digests reference |
| [Verification Evidence and Authority](evidence.md) | Verification Evidence and Authority reference |
| [Persistent Local State Store](state.md) | Persistent Local State Store reference |
| [Isolated Pi Runtime Adapter](pi-adapter.md) | Isolated Pi Runtime Adapter reference |
| [Pi Runtime Evaluation](pi-runtime-evaluation.md) | Pi Runtime Evaluation reference |
| [Bounded Controller and Repair Loop](controller.md) | Bounded Controller and Repair Loop reference |
| [Runner Taskpack and Offline Parity](runner-taskpack.md) | Runner Taskpack and Offline Parity reference |
| [Reviewed Memory and CAS Compaction](memory.md) | Reviewed Memory and CAS Compaction reference |
| [GitHub App Control Plane and Taskpack Intake](github-app.md) | GitHub App Control Plane and Taskpack Intake reference |
| [System-One Decision Routing](decisions.md) | System-One Decision Routing reference |
| [Capability Closure Matrix and Failure Semantics](closure-matrix.md) | Capability Closure Matrix and Failure Semantics reference |

### Contribute

| Page | Description |
| --- | --- |
| [Development and Verification](development.md) | Development and Verification reference |
| [Workspace Internals and Boundaries](contribute/internals.md) | Workspace Internals and Boundaries reference |

### Architecture Decisions

| Page | Description |
| --- | --- |
| [ADR 0001: Local State Authority](adr/0001-local-state-authority.md) | ADR 0001: Local State Authority reference |
| [ADR 0002: Isolated Pi SDK](adr/0002-isolated-pi-sdk.md) | ADR 0002: Isolated Pi SDK reference |
