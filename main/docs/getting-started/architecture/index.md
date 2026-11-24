# Architecture

Loopwright runs bounded repository work inside isolated sandboxes and verifies every candidate against independent evidence. Choose declarative taskpacks, out-of-repo managed controllers, or multi-generation evolutionary campaigns on one verification kernel.

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
2. **Execute**: Run an isolated Pi or delegated role with trusted bindings and optional decision routing.
3. **Verify**: Evaluate the candidate against independent checks and authenticated gate receipts.
4. **Publish & Remember**: Settle pull request publication and propose reviewed memory separately.

## Operating modes

Loopwright supports three operating modes sharing one fenced verification kernel:

| Dimension | Declarative taskpack | Managed controller | Evolutionary campaign |
| --- | --- | --- | --- |
| Target user | Repo maintainers and CLI users | Platform and security operators | Kernel and benchmark engineers |
| Files authored | `.loopwright/taskpack.yaml` | Out-of-repo `registry.yaml` + `controller.yaml` | `.loopwright/taskpack.yaml` + `campaign.yaml` |
| Digest pinning | Compiled automatically by host | Pinned manually (`--registry-sha256`) | Compiled per isolated child run |
| Execution model | Compiled author + check pipeline | Custom multi-step `agent` and `check` DAG | Island Pareto search over `EVOLVE-BLOCK` spans |
| Credential wiring | Mapped from CLI, Action, or App env | Explicit `credentialBindings` templates | Relay HMAC and provider env secrets |
| Walkthrough | [Declarative Taskpack](/loopwright/main/docs/walkthroughs/declarative-taskpack/index.md) | [Managed Controller](/loopwright/main/docs/walkthroughs/managed-controller/index.md) | [Evolutionary Campaign](/loopwright/main/docs/walkthroughs/evolutionary-campaign/index.md) |

## Configuration surfaces

Every Loopwright document uses `apiVersion: loopwright.dev/v1alpha1` across all configuration surfaces:

| Mode or scope | Document `kind` | Top-level keys | Owning page |
| --- | --- | --- | --- |
| Declarative mode | `Taskpack` / `TaskpackSuite` | `apiVersion`, `kind`, `metadata.name`, `spec` | [Taskpack](/loopwright/main/docs/configuration/taskpack/index.md) |
| Managed mode | `TrustedRegistry` | `apiVersion`, `kind`, `metadata.name`, `spec` | [Controller and Registry](/loopwright/main/docs/configuration/controller-and-registry/index.md) |
| Managed mode | `ControllerConfig` | `apiVersion`, `kind`, `spec` | [Controller and Registry](/loopwright/main/docs/configuration/controller-and-registry/index.md) |
| Managed mode | `TaskContract` | `apiVersion`, `kind`, `spec` | [Task Contract](/loopwright/main/docs/configuration/task-contract/index.md) |
| Shared policy | `spec.sandbox` | Nested under `Taskpack.spec` | [Sandbox Backends](/loopwright/main/docs/configuration/sandbox-backends/index.md) |
| Shared policy | `DecisionPolicy` | `apiVersion`, `kind`, `spec` | [Decision Routing](/loopwright/main/docs/configuration/decision-routing/index.md) |
| Evolution mode | `EvolutionCampaign` | `apiVersion`, `kind`, `metadata.name`, `spec` | [Evolution Campaign](/loopwright/main/docs/configuration/evolution-campaign/index.md) |
| Entry points | Action or `GitHubAppConfig` | Workflow or `apiVersion`, `kind`, `spec` | [GitHub Action](/loopwright/main/docs/operations/github-action/index.md) · [GitHub App](/loopwright/main/docs/operations/github-app/index.md) |

## Runtime baseline

Deployment host qualification (`qualifyDeploymentHostProfile`) enforces these baseline prerequisites across Action, App, and CLI surfaces:

| Component | Baseline requirement | Enforcement scope |
| --- | --- | --- |
| Node runtime | Node.js `26.x` (built-in `node:sqlite`) | Required across Action, App, CLI, and workspace builds |
| Package manager | `npm 11.x` | Workspace dependency installation and builds |
| Host platform | `darwin/arm64`, `linux/arm64`, `linux/x64` | Unlisted OS or architecture targets fail closed |
| Storage and clock | Local POSIX filesystem; `<= 1000 ms` drift | Network mounts (`nfs`, `smb`, `fuse`, `sshfs`) and clock jumps fail closed |
| Sandbox backend | Seatbelt, bubblewrap, Landlock, or Docker | Negotiated against taskpack `spec.sandbox` policy |
| Optional tools | Python `3.11+` (runner); Hugo `0.170.1+` | Needed only for runner helpers or site builds |

## Trust boundaries

Trusted hosts bind credentials, runtimes, handlers, and external services. `Taskpack`s and model output cannot grant authority. Local runs protect `.git` and `<controlRoot>` while GitHub entrypoints enforce triggers, PR publication, and `.github/workflows/**` dual-key locks.

Large overlays stream through SHA-256 verified CAS blob pointers (`1 MiB` chunks, up to `16,384` files and `16 GiB`) instead of inline base64 buffers. Local fixture proof never establishes live provider qualification, and unknown external effects stay unknown until reconciled.

---

**See also** — [Declarative Taskpack](/loopwright/main/docs/walkthroughs/declarative-taskpack/index.md) (single-file automation) · [Managed Controller](/loopwright/main/docs/walkthroughs/managed-controller/index.md) (out-of-repo governance) · [Evolutionary Campaign](/loopwright/main/docs/walkthroughs/evolutionary-campaign/index.md) (multi-generation optimization)

**Next** → [Installation](/loopwright/main/docs/getting-started/installation/index.md) — install the CLI on a laptop or wire the GitHub Action.
