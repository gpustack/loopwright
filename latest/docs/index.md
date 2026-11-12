# Documentation

Loopwright supports two operating modes sharing one verification kernel: **Declarative Taskpack** (single-file automated repository sync via GitHub Action or App) and **Managed Controller** (fine-grained out-of-repo `TrustedRegistry` and `TaskContract` governance via the CLI).

## Getting Started

- [Architecture](/loopwright/latest/docs/getting-started/architecture/index.md) explains the four-stage execution chain, the two operating modes, and the runtime baseline.
- [Installation](/loopwright/latest/docs/getting-started/installation/index.md) installs `@gpustack/loopwright`, wires GitHub Actions, and provides `llms.txt` bootstrap prompts.

## Operations

- [GitHub Action](/loopwright/latest/docs/operations/github-action/index.md) configures the reusable Action and secret bindings in workflows.
- [GitHub App](/loopwright/latest/docs/operations/github-app/index.md) deploys the webhook and token-brokering control plane.
- [CLI](/loopwright/latest/docs/operations/cli/index.md) runs local compilation, execution, inspection, reconciliation, and closure audits.

## Walkthroughs

- [Declarative Taskpack](/loopwright/latest/docs/walkthroughs/declarative-taskpack/index.md) walks through simple single-file repository automation and automatic synchronized workflow migration.
- [Managed Controller](/loopwright/latest/docs/walkthroughs/managed-controller/index.md) walks through fine-grained out-of-repo `TrustedRegistry`, `ControllerConfig`, and CLI execution.

## Configuration

- [Taskpack](/loopwright/latest/docs/configuration/taskpack/index.md) documents every field and enum in `.loopwright/taskpack.yaml` (`Taskpack`).
- [Task Contract](/loopwright/latest/docs/configuration/task-contract/index.md) documents every field, budget, step, and evidence tier in `TaskContract`.
- [Controller and Registry](/loopwright/latest/docs/configuration/controller-and-registry/index.md) documents every handler, profile, credential, endpoint, and control in `TrustedRegistry` and `ControllerConfig`.
- [Sandbox Backends](/loopwright/latest/docs/configuration/sandbox-backends/index.md) covers native OS and container sandbox policies and capabilities.
- [Decision Routing](/loopwright/latest/docs/configuration/decision-routing/index.md) details System-One advisory confidence zones, providers, and disclosure policies.
