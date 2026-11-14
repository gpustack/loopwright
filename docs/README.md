# Loopwright Documentation

## Reading paths

- [Installation](getting-started/installation.md) and [Architecture](getting-started/architecture.md)
- [Declarative Taskpack](walkthroughs/declarative-taskpack.md), [Taskpack](configuration/taskpack.md), and [GitHub Action](operations/github-action.md)
- [Managed Controller](walkthroughs/managed-controller.md), [Task Contract](configuration/task-contract.md), and [Controller and Registry](configuration/controller-and-registry.md)
- [GitHub App](operations/github-app.md) and [CLI](operations/cli.md)
- [Sandbox Backends](configuration/sandbox-backends.md) and [Decision Routing](configuration/decision-routing.md)
- [Development](development.md) and [Internals](contribute/internals.md)

## Module map

### Contracts and Evidence

- ID: contracts
- Use for: author task contracts and bind verification evidence
- Aliases: contracts
- Guides: [configuration/task-contract.md](configuration/task-contract.md), [contribute/identity.md](contribute/identity.md), [contribute/evidence.md](contribute/evidence.md)
- Specs: [Specification](../specs/2026-11-05-task-contracts-and-evidence.md)
- Code: [core](../packages/core/)
- Related: [state](#persistent-state-store), [controller](#bounded-controller-and-cli)
- Skills: [overview](../.agents/skills/loopwright-overview/SKILL.md)

### Persistent State Store

- ID: state
- Use for: retain fenced authority, budgets, and recovery state
- Aliases: state
- Guides: [contribute/state.md](contribute/state.md)
- Specs: [Specification](../specs/2026-11-05-persistent-state-and-admission.md)
- Code: [state](../packages/state/)
- Related: [contracts](#contracts-and-evidence), [pi-adapter](#isolated-pi-adapter)
- Skills: [overview](../.agents/skills/loopwright-overview/SKILL.md)

### Isolated Pi Adapter

- ID: pi-adapter
- Use for: run admitted Pi roles under isolation
- Aliases: pi-adapter
- Guides: [configuration/sandbox-backends.md](configuration/sandbox-backends.md), [contribute/pi-adapter.md](contribute/pi-adapter.md)
- Specs: [Specification](../specs/2026-11-05-isolated-pi-adapter.md)
- Code: [agent-pi](../packages/agent-pi/)
- Related: [state](#persistent-state-store), [controller](#bounded-controller-and-cli)
- Skills: [overview](../.agents/skills/loopwright-overview/SKILL.md)

### Bounded Controller and CLI

- ID: controller
- Use for: compile trusted configuration and coordinate bounded runs
- Aliases: controller
- Guides: [getting-started/installation.md](getting-started/installation.md), [walkthroughs/managed-controller.md](walkthroughs/managed-controller.md), [configuration/controller-and-registry.md](configuration/controller-and-registry.md), [operations/cli.md](operations/cli.md), [contribute/closure-matrix.md](contribute/closure-matrix.md)
- Specs: [Specification](../specs/2026-11-06-bounded-controller-and-trusted-config.md)
- Code: [controller](../packages/controller/), [cli](../packages/cli/)
- Related: [contracts](#contracts-and-evidence), [state](#persistent-state-store)
- Skills: [overview](../.agents/skills/loopwright-overview/SKILL.md)

### Declarative Taskpacks and Runner Parity

- ID: taskpacks
- Use for: author taskpacks and assess offline runner parity
- Aliases: taskpacks
- Guides: [walkthroughs/declarative-taskpack.md](walkthroughs/declarative-taskpack.md), [configuration/taskpack.md](configuration/taskpack.md), [contribute/runner-taskpack.md](contribute/runner-taskpack.md)
- Specs: [Specification](../specs/2026-11-10-runner-taskpack-and-offline-parity.md)
- Code: [taskpack-runner](../packages/taskpack-runner/)
- Related: [github-app](#github-app-and-action-control-plane), [controller](#bounded-controller-and-cli)
- Skills: [overview](../.agents/skills/loopwright-overview/SKILL.md)

### Reviewed Memory and Compaction

- ID: memory
- Use for: review memory proposals and compact retained context
- Aliases: memory
- Guides: [contribute/memory.md](contribute/memory.md)
- Specs: [Specification](../specs/2026-11-11-reviewed-memory-and-cas-compaction.md)
- Code: [memory](../packages/memory/)
- Related: [controller](#bounded-controller-and-cli), [decisions](#system-one-decision-routing)
- Skills: [overview](../.agents/skills/loopwright-overview/SKILL.md)

### GitHub App and Action Control Plane

- ID: github-app
- Use for: configure App intake, Action execution, and sandboxes
- Aliases: github-app
- Guides: [operations/github-action.md](operations/github-action.md), [operations/github-app.md](operations/github-app.md), [contribute/github-app-internals.md](contribute/github-app-internals.md)
- Specs: [Specification](../specs/2026-11-11-github-app-control-plane-and-declarative-taskpack.md), [OS Sandbox Backends](../specs/2026-11-11-native-os-sandbox-execution-backends.md), [Turnkey Execution](../specs/2026-11-13-turnkey-taskpack-execution-scope-and-output-modes.md)
- Code: [github-app](../packages/github-app/)
- Related: [taskpacks](#declarative-taskpacks-and-runner-parity), [controller](#bounded-controller-and-cli)
- Skills: [overview](../.agents/skills/loopwright-overview/SKILL.md)

### System-One Decision Routing

- ID: decisions
- Use for: route bounded advisory decisions
- Aliases: decisions
- Guides: [configuration/decision-routing.md](configuration/decision-routing.md)
- Specs: [Specification](../specs/2026-11-11-jev-decision-routing-and-controlled-benchmark.md)
- Code: [decisions](../packages/decisions/)
- Related: [memory](#reviewed-memory-and-compaction), [controller](#bounded-controller-and-cli)
- Skills: [overview](../.agents/skills/loopwright-overview/SKILL.md)

### Development and Release

- ID: development
- Use for: build, verify, document, and release the workspace
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
| [2026-11-12-governance-yaml-configuration-connected-docs-and-branded-site.md](../specs/2026-11-12-governance-yaml-configuration-connected-docs-and-branded-site.md) | YAML configuration, connected guides, and branded site |
| [2026-11-13-tree-overlay-manifest-and-candidate-delete.md](../specs/2026-11-13-tree-overlay-manifest-and-candidate-delete.md) | tree overlay manifests and candidate deletion |
| [2026-11-13-turnkey-taskpack-execution-scope-and-output-modes.md](../specs/2026-11-13-turnkey-taskpack-execution-scope-and-output-modes.md) | Turnkey execution, scope, and output modes |

## All pages

### Getting Started

| Page | Description |
| --- | --- |
| [Architecture](getting-started/architecture.md) | Execution stages, trust boundaries, and configuration map |
| [Installation](getting-started/installation.md) | Install the CLI on a laptop or wire the GitHub Action |

### Operations

| Page | Description |
| --- | --- |
| [GitHub Action](operations/github-action.md) | Configure and run the reusable GitHub Action |
| [GitHub App](operations/github-app.md) | Deploy and configure the GitHub App control plane |
| [CLI](operations/cli.md) | Generate drafts, inspect runs, reconcile, and audit closure |

### Walkthroughs

| Page | Description |
| --- | --- |
| [Declarative Taskpack](walkthroughs/declarative-taskpack.md) | Author or migrate a single-file repository taskpack |
| [Managed Controller](walkthroughs/managed-controller.md) | Configure out-of-repo registries, contracts, and CLI runs |

### Configuration

| Page | Description |
| --- | --- |
| [Taskpack](configuration/taskpack.md) | Configure every field and enum in .loopwright/taskpack.yaml |
| [Task Contract](configuration/task-contract.md) | Configure task goals, scope, roles, budgets, DAGs, and evidence |
| [Controller and Registry](configuration/controller-and-registry.md) | Configure approved handlers, profiles, credentials, and controls |
| [Sandbox Backends](configuration/sandbox-backends.md) | Select OS or container sandboxes and required capabilities |
| [Decision Routing](configuration/decision-routing.md) | Configure advisory routing policies, providers, and thresholds |

### Contribute

| Page | Description |
| --- | --- |
| [Development and Verification](development.md) | Build, test, lint, and verify workspace changes |
| [Workspace Internals and Boundaries](contribute/internals.md) | Navigate package layers, code ownership, and invariants |
| [Canonical Identity and Digests](contribute/identity.md) | Implement RFC 8785 JCS canonicalization and SHA-256 digests |
| [Verification Evidence and Authority](contribute/evidence.md) | Implement independent check hooks and HMAC gate receipts |
| [Persistent Local State Store](contribute/state.md) | Implement SQLite WAL lease fencing and monotonic clock guards |
| [Isolated Pi Runtime Adapter](contribute/pi-adapter.md) | Implement isolated Pi sessions, brokers, and secret scrubbing |
| [Runner Taskpack and Offline Parity](contribute/runner-taskpack.md) | Maintain runner parity and frozen taskpack fixtures |
| [Reviewed Memory and CAS Compaction](contribute/memory.md) | Implement CAS reviewed memory proposals and compaction |
| [GitHub App Control Plane Internals](contribute/github-app-internals.md) | Implement webhook verification, intake gates, and compilation |
| [Capability Closure Matrix and Failure Semantics](contribute/closure-matrix.md) | Maintain capability closure ledger and failure injection suites |
| [ADR 0001: Local State Authority](contribute/adr/0001-local-state-authority.md) | Record the fenced local SQLite authority decision |
| [ADR 0002: Isolated Pi SDK](contribute/adr/0002-isolated-pi-sdk.md) | Record the isolated Pi runtime boundary decision |
