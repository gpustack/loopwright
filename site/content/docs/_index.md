---
title: Documentation
---

# Documentation

Loopwright supports two operating modes sharing one verification kernel: **Declarative Taskpack** (single-file automated repository sync via GitHub Action or App) and **Managed Controller** (fine-grained out-of-repo `TrustedRegistry` and `TaskContract` governance via the CLI).

## Getting Started

- [Architecture](getting-started/architecture/) explains the four-stage execution chain, the two operating modes, and the runtime baseline.
- [Installation](getting-started/installation/) installs `@gpustack/loopwright`, wires GitHub Actions, and provides `llms.txt` bootstrap prompts.

## Operations

- [GitHub Action](operations/github-action/) configures the reusable Action and secret bindings in workflows.
- [GitHub App](operations/github-app/) deploys the webhook and token-brokering control plane.
- [CLI](operations/cli/) runs local compilation, execution, inspection, reconciliation, and closure audits.

## Walkthroughs

- [Declarative Taskpack](walkthroughs/declarative-taskpack/) walks through simple single-file repository automation and automatic synchronized workflow migration.
- [Managed Controller](walkthroughs/managed-controller/) walks through fine-grained out-of-repo `TrustedRegistry`, `ControllerConfig`, and CLI execution.

## Configuration

- [Taskpack](configuration/taskpack/) documents every field and enum in `.loopwright/taskpack.yaml` (`Taskpack`).
- [Task Contract](configuration/task-contract/) documents every field, budget, step, and evidence tier in `TaskContract`.
- [Controller and Registry](configuration/controller-and-registry/) documents every handler, profile, credential, endpoint, and control in `TrustedRegistry` and `ControllerConfig`.
- [Sandbox Backends](configuration/sandbox-backends/) covers native OS and container sandbox policies and capabilities.
- [Decision Routing](configuration/decision-routing/) details System-One advisory confidence zones, providers, and disclosure policies.
