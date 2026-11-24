# Reference Hub

Evidence: contract.

Flat machine-readable reference hub for Loopwright schemas, CLI flags, Action inputs, delegated stepping, and bootstrap interviews. Every file below is published as static Markdown for coding agents and linked from `llms.txt`.

## Task routing

| Operator task | Flat reference | Public owner |
| --- | --- | --- |
| Bootstrap or migrate repository automation | [Bootstrap Interview Reference](bootstrap-interview.md) | [Installation](../docs/getting-started/installation/index.md) |
| Author `Taskpack` and `TaskpackSuite` bounds | [Taskpack and Contract Reference](taskpack-and-contract-schema.md#taskpack-bounds) | [Taskpack](../docs/configuration/taskpack/index.md) |
| Author `TaskContract`, receipts, and hardware cells | [Taskpack and Contract Reference](taskpack-and-contract-schema.md#taskcontract-bounds) | [Task Contract](../docs/configuration/task-contract/index.md) |
| Author `EvolutionCampaign` and bundle exports | [Taskpack and Contract Reference](taskpack-and-contract-schema.md#evolutioncampaign-bounds) | [Evolution Campaign](../docs/configuration/evolution-campaign/index.md) |
| Author `TrustedRegistry` and `ControllerConfig` | [Controller and Registry Reference](controller-and-registry-schema.md#registry-and-handlers) | [Controller and Registry](../docs/configuration/controller-and-registry/index.md) |
| Configure `DecisionPolicy` providers and hooks | [Controller and Registry Reference](controller-and-registry-schema.md#decisionpolicy-schema) | [Decision Routing](../docs/configuration/decision-routing/index.md) |
| Look up GitHub Action inputs and outputs | [CLI and Action Reference](cli-and-action-reference.md#github-action-inputs) | [GitHub Action](../docs/operations/github-action/index.md) |
| Look up CLI subcommands, flags, and exits | [CLI and Action Reference](cli-and-action-reference.md#cli-subcommands) | [CLI](../docs/operations/cli/index.md) |
| Configure `GitHubAppConfig` webhook listener | [CLI and Action Reference](cli-and-action-reference.md#githubappconfig) | [GitHub App](../docs/operations/github-app/index.md) |
| Drive `loopwright step` and apply overlays | [Coding Agent Protocol Reference](coding-agent-protocol.md) | [Coding Agents](../docs/operations/coding-agents/index.md) |

## Exact aliases

| Symbol or alias | Category | Reference target |
| --- | --- | --- |
| `Taskpack` | Resource kind | [Taskpack and Contract Reference](taskpack-and-contract-schema.md#taskpack-bounds) |
| `TaskpackSuite` | Resource kind | [Taskpack and Contract Reference](taskpack-and-contract-schema.md#taskpacksuite-bounds) |
| `TaskContract` | Resource kind | [Taskpack and Contract Reference](taskpack-and-contract-schema.md#taskcontract-bounds) |
| `VerificationProfile` | Resource kind | [Taskpack and Contract Reference](taskpack-and-contract-schema.md#receipts-and-evidence) |
| `AttemptReceipt` | Resource kind | [Taskpack and Contract Reference](taskpack-and-contract-schema.md#receipts-and-evidence) |
| `ArtifactManifest` | Contract schema | [Taskpack and Contract Reference](taskpack-and-contract-schema.md#receipts-and-evidence) |
| `EvolutionCampaign` | Resource kind | [Taskpack and Contract Reference](taskpack-and-contract-schema.md#evolutioncampaign-bounds) |
| `evolution-bundle.v1` | Export format | [Taskpack and Contract Reference](taskpack-and-contract-schema.md#evolutioncampaign-bounds) |
| `TrustedRegistry` | Resource kind | [Controller and Registry Reference](controller-and-registry-schema.md#registry-and-handlers) |
| `ControllerConfig` | Resource kind | [Controller and Registry Reference](controller-and-registry-schema.md#controllerconfig-bounds) |
| `DecisionPolicy` | Resource kind | [Controller and Registry Reference](controller-and-registry-schema.md#decisionpolicy-schema) |
| `AdvisoryDecisionPort` | Port interface | [Controller and Registry Reference](controller-and-registry-schema.md#advisory-port-hooks) |
| `GitHubAppConfig` | Resource kind | [CLI and Action Reference](cli-and-action-reference.md#githubappconfig) |
| `action.yml` | GitHub Action | [CLI and Action Reference](cli-and-action-reference.md#github-action-inputs) |
| `loopwright init\|check\|run\|resume` | CLI commands | [CLI and Action Reference](cli-and-action-reference.md#cli-subcommands) |
| `loopwright suite\|digest\|runner\|evolve` | CLI commands | [CLI and Action Reference](cli-and-action-reference.md#cli-subcommands) |
| `loopwright step next\|submit\|cancel` | CLI coroutine | [Coding Agent Protocol Reference](coding-agent-protocol.md#stepyield-schema) |
| `StepYield` | JSON envelope | [Coding Agent Protocol Reference](coding-agent-protocol.md#stepyield-schema) |
| `candidate.files.json` | Inspect bundle | [Coding Agent Protocol Reference](coding-agent-protocol.md#overlay-apply-script) |
| `command.v1` / `benchmark-gate.v1` | Check handlers | [Taskpack and Contract Reference](taskpack-and-contract-schema.md#verifiers-and-mounts) |
| `environmentBindings` | Env allowlist | [Controller and Registry Reference](controller-and-registry-schema.md#credentials-and-interpolation) |
| `DECISION_FORBIDDEN_AUTHORITY_INTENTS` | Guard list | [Controller and Registry Reference](controller-and-registry-schema.md#advisory-port-hooks) |

## Evidence labels

| Reference file | Evidence | Scope |
| --- | --- | --- |
| [Bootstrap Interview Reference](bootstrap-interview.md) | `contract` | Interactive Mode 1, Mode 2, and Mode 3 onboarding protocol |
| [Taskpack and Contract Reference](taskpack-and-contract-schema.md) | `contract` | Exhaustive `Taskpack`, `TaskpackSuite`, `TaskContract`, and `EvolutionCampaign` bounds |
| [Controller and Registry Reference](controller-and-registry-schema.md) | `contract` | Complete `TrustedRegistry`, `ControllerConfig`, and `DecisionPolicy` dictionaries |
| [CLI and Action Reference](cli-and-action-reference.md) | `contract` | Complete `action.yml` inputs, CLI subcommand flags, exit codes, and `GitHubAppConfig` |
| [Coding Agent Protocol Reference](coding-agent-protocol.md) | `contract` | `StepYield` JSON schema, lease errors, exit codes, and verified overlay-apply script |

---

**See also** — [Architecture](../docs/getting-started/architecture/index.md) (execution chain and trust boundaries) · [Installation](../docs/getting-started/installation/index.md) (CLI installation and prompt bootstrap) · [Taskpack](../docs/configuration/taskpack/index.md) (declarative manifest overview) · [Controller and Registry](../docs/configuration/controller-and-registry/index.md) (managed authority separation)
