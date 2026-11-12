# Architecture

Loopwright runs bounded repository work inside isolated sandboxes and verifies every candidate against independent evidence. Choose between simple repository taskpack automation or fine-grained controller and registry governance.

## Contents

- [Execution chain](#execution-chain)
- [Operating modes](#operating-modes)
- [Configuration surfaces](#configuration-surfaces)
- [Runtime baseline](#runtime-baseline)
- [Trust boundaries](#trust-boundaries)

## Execution chain

![Loopwright architecture flow](/loopwright/main/docs/assets/diagrams/architecture-flow.svg)

<!-- flowchart LR
  Admit["1. Admit"] -> Execute["2. Execute"] -> Verify["3. Verify"] -> Publish["4. Publish & Remember"]
-->

1. **Admit**: Validate task boundaries and acquire a monotonic SQLite lease fence.
2. **Execute**: Run an isolated Pi role with trusted host bindings and optional decision routing.
3. **Verify**: Evaluate the candidate against independent checks and authenticated gate receipts.
4. **Publish & Remember**: Settle pull request publication and propose reviewed memory separately.

## Operating modes

Loopwright supports two distinct configuration and execution modes sharing one verification kernel:

| Dimension | Declarative taskpack | Managed controller |
| --- | --- | --- |
| Target user | Repository maintainers | Platform and security operators |
| Files authored | One `.loopwright/taskpack.yaml` in repo | Out-of-repo `registry.yaml` and `controller.yaml` |
| Digest pinning | Compiled automatically by host | Pinned manually via SHA-256 (`--registry-sha256`) |
| Execution graph | Single compiled author + check pipeline | Custom multi-step `agent` and `check` DAG |
| Credential wiring | Mapped from Action or App environment | Explicit `credentialBindings` and path templates |
| Key advantage | Zero boilerplate; turnkey triggers and PRs | Duty separation, custom gates/MCP, local CLI control |
| Walkthrough | [Declarative Taskpack](/loopwright/main/docs/walkthroughs/declarative-taskpack/index.md) | [Managed Controller](/loopwright/main/docs/walkthroughs/managed-controller/index.md) |

## Configuration surfaces

Every Loopwright document uses `apiVersion: loopwright.dev/v1alpha1` across declarative and managed configuration surfaces:

| Mode or scope | Document `kind` | Top-level keys | Reference guide |
| --- | --- | --- | --- |
| Declarative mode | `Taskpack` | `apiVersion`, `kind`, `metadata.name`, `spec` | [Taskpack](/loopwright/main/docs/configuration/taskpack/index.md) |
| Managed mode | `TrustedRegistry` | `apiVersion`, `kind`, `metadata.name`, `spec` | [Controller and Registry](/loopwright/main/docs/configuration/controller-and-registry/index.md) |
| Managed mode | `ControllerConfig` | `apiVersion`, `kind`, `spec` | [Controller and Registry](/loopwright/main/docs/configuration/controller-and-registry/index.md) |
| Managed mode | `TaskContract` | `apiVersion`, `kind`, `spec` | [Task Contract](/loopwright/main/docs/configuration/task-contract/index.md) |
| Shared policy | `spec.sandbox` | Nested under `Taskpack.spec` | [Sandbox Backends](/loopwright/main/docs/configuration/sandbox-backends/index.md) |
| Shared policy | `DecisionPolicy` | `apiVersion`, `kind`, `spec` | [Decision Routing](/loopwright/main/docs/configuration/decision-routing/index.md) |
| Entry points | Action or `GitHubAppConfig` | Workflow or `apiVersion`, `kind`, `spec` | [GitHub Action](/loopwright/main/docs/operations/github-action/index.md) · [GitHub App](/loopwright/main/docs/operations/github-app/index.md) |

## Runtime baseline

Deployment host qualification (`qualifyDeploymentHostProfile`) enforces these baseline prerequisites across Action, App, and CLI surfaces:

| Component | Baseline requirement | Enforcement scope |
| --- | --- | --- |
| Node runtime | Node.js `26.x` (built-in `node:sqlite`) | Required across Action, App, CLI, and workspace builds (`gpustack/loopwright` provisions it automatically) |
| Package manager | `npm 11.x` | Workspace dependency installation and builds |
| Host platform | `darwin/arm64`, `linux/arm64`, `linux/x64` | Unlisted OS or architecture targets fail closed |
| Storage and clock | Local POSIX filesystem; `<= 1000 ms` clock drift | Network mounts (`nfs`, `smb`, `fuse`, `sshfs`) and clock jumps fail closed |
| Sandbox backend | Seatbelt, bubblewrap, Landlock, or Docker | Negotiated against taskpack `spec.sandbox` policy |
| Optional tools | Python `3.11+` (runner bridge); Hugo extended `0.152.2+` (docs site) | Needed only when exercising runner helpers or building `site/` |

## Trust boundaries

Trusted hosts bind credentials, runtimes, handlers, and external services. Taskpacks and model output cannot grant authority. Local fixture proof never establishes live provider or production qualification, and unknown external effects remain unknown until reconciled.

---

**See also** — [Declarative Taskpack](/loopwright/main/docs/walkthroughs/declarative-taskpack/index.md) (simple single-file automation) · [Managed Controller](/loopwright/main/docs/walkthroughs/managed-controller/index.md) (fine-grained registry and contract control)

**Next** → [Installation](/loopwright/main/docs/getting-started/installation/index.md) — install the CLI on a laptop or wire the GitHub Action.
