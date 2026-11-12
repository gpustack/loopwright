# Page Map — Canonical `docs/` Inventory, Site Publication Boundary, and Ownership

One page owns each technical fact or operational workflow. When multiple pages touch a subject, the owning page states the normative contract and every other page links to it.

## Public Site (`12` Pages Across `4` Groups) vs. Repository-Only (`12` Pages)

Loopwright maintains **24** Markdown pages under `docs/` (plus the index `docs/README.md`):

- **12 Public Pages (`Site Published: yes`)**: Built into the Hugo static site (`site/public/`) across 4 clean groups (`Getting Started`, `Operations`, `Walkthroughs`, `Configuration`), listed in `site/data/navigation.yaml`, and exported to `site/public/llms.txt`.
- **12 Repository-Only Pages (`Site Published: no (repo-only)`)**: `docs/development.md`, `docs/contribute/{internals,identity,evidence,state,pi-adapter,runner-taskpack,memory,github-app-internals,closure-matrix}.md`, and `docs/contribute/adr/{0001-local-state-authority,0002-isolated-pi-sdk}.md` remain in repository `docs/` and in `docs/README.md` (`## All pages`) for repository contributors and coding agents, but are excluded from `site/hugo.toml`, `site/data/navigation.yaml`, and `site/public/llms.txt`.
- **Hard Link Boundary**: None of the 12 public pages may link to `development.md` or `contribute/**`.

## Canonical 24-Page Inventory

Every public page (`Site Published: yes`) follows strict **1:1:1 alignment**: `docs/<slugify(group)>/<slugify(title)>.md`, with `Exact # H1 Title === docs/README.md Label === navigation.yaml Label`.

| Path (`docs/`) | Group | Site Published | Exact `# H1` Title (`docs/README.md` Label) | `navigation.yaml` Label | Line Cap | Primary Audience | Owning Package / Spec |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `getting-started/architecture.md` | Getting Started | `yes` | `Architecture` | `Architecture` | `<= 200` | All readers & operators | All 9 packages; `specs/2026-11-12-governance-yaml-configuration-connected-docs-and-branded-site.md` |
| `getting-started/installation.md` | Getting Started | `yes` | `Installation` | `Installation` | `<= 400` | Operators & engineers | `@loopwright/cli`, `action.yml`, `scripts/pack-npm.mjs` |
| `operations/github-action.md` | Operations | `yes` | `GitHub Action` | `GitHub Action` | `<= 400` | Consumer repo operators | `action.yml`, `@loopwright/github-app` |
| `operations/github-app.md` | Operations | `yes` | `GitHub App` | `GitHub App` | `<= 400` | Platform & App operators | `@loopwright/github-app`; `specs/2026-11-11-github-app-control-plane-and-declarative-taskpack.md` |
| `operations/cli.md` | Operations | `yes` | `CLI` | `CLI` | `<= 400` | Local CLI operators | `@loopwright/cli`; `specs/2026-11-06-bounded-controller-and-trusted-config.md` |
| `walkthroughs/declarative-taskpack.md` | Walkthroughs | `yes` | `Declarative Taskpack` | `Declarative Taskpack` | `<= 400` | Repo maintainers | `@loopwright/github-app`, `@loopwright/taskpack-runner` |
| `walkthroughs/managed-controller.md` | Walkthroughs | `yes` | `Managed Controller` | `Managed Controller` | `<= 400` | Platform & CLI operators | `@loopwright/controller`, `@loopwright/cli`, `@loopwright/core` |
| `configuration/taskpack.md` | Configuration | `yes` | `Taskpack` | `Taskpack` | `<= 400` | Repo maintainers | `@loopwright/github-app`; `specs/2026-11-11-github-app-control-plane-and-declarative-taskpack.md` |
| `configuration/task-contract.md` | Configuration | `yes` | `Task Contract` | `Task Contract` | `<= 400` | Integrators & engineers | `@loopwright/core`; `specs/2026-11-05-task-contracts-and-evidence.md` |
| `configuration/controller-and-registry.md` | Configuration | `yes` | `Controller and Registry` | `Controller and Registry` | `<= 400` | Controller & CLI operators | `@loopwright/controller`; `specs/2026-11-06-bounded-controller-and-trusted-config.md` |
| `configuration/sandbox-backends.md` | Configuration | `yes` | `Sandbox Backends` | `Sandbox Backends` | `<= 400` | Platform & security engineers | `@loopwright/agent-pi`, `@loopwright/github-app`; `specs/2026-11-11-native-os-sandbox-execution-backends.md` |
| `configuration/decision-routing.md` | Configuration | `yes` | `Decision Routing` | `Decision Routing` | `<= 400` | Triage & policy operators | `@loopwright/decisions`; `specs/2026-11-11-jev-decision-routing-and-controlled-benchmark.md` |
| `development.md` | Contribute (Repo-Only) | `no (repo-only)` | `Development and Verification` | *(excluded from `site/`)* | `<= 400` | Repository contributors | Root workspace, `scripts/`, `.agents/skills/` |
| `contribute/internals.md` | Contribute (Repo-Only) | `no (repo-only)` | `Workspace Internals and Boundaries` | *(excluded from `site/`)* | `<= 400` | Repository contributors | All 9 packages, `.opencodereview/rule.json` |
| `contribute/identity.md` | Contribute (Repo-Only) | `no (repo-only)` | `Canonical Identity and Digests` | *(excluded from `site/`)* | `<= 400` | Security & core engineers | `@loopwright/core`; `specs/2026-11-05-task-contracts-and-evidence.md` |
| `contribute/evidence.md` | Contribute (Repo-Only) | `no (repo-only)` | `Verification Evidence and Authority` | *(excluded from `site/`)* | `<= 400` | Security & controller engineers | `@loopwright/core`, `@loopwright/controller`; `specs/2026-11-09-authenticated-gates-and-publication-boundaries.md` |
| `contribute/state.md` | Contribute (Repo-Only) | `no (repo-only)` | `Persistent Local State Store` | *(excluded from `site/`)* | `<= 400` | State & runtime engineers | `@loopwright/state`; `specs/2026-11-05-persistent-state-and-admission.md` |
| `contribute/pi-adapter.md` | Contribute (Repo-Only) | `no (repo-only)` | `Isolated Pi Runtime Adapter` | *(excluded from `site/`)* | `<= 400` | Runtime & sandbox engineers | `@loopwright/agent-pi`; `specs/2026-11-05-isolated-pi-adapter.md` |
| `contribute/runner-taskpack.md` | Contribute (Repo-Only) | `no (repo-only)` | `Runner Taskpack and Offline Parity` | *(excluded from `site/`)* | `<= 400` | Taskpack & parity engineers | `@loopwright/taskpack-runner`; `specs/2026-11-10-runner-taskpack-and-offline-parity.md` |
| `contribute/memory.md` | Contribute (Repo-Only) | `no (repo-only)` | `Reviewed Memory and CAS Compaction` | *(excluded from `site/`)* | `<= 400` | Memory & controller engineers | `@loopwright/memory`; `specs/2026-11-11-reviewed-memory-and-cas-compaction.md` |
| `contribute/github-app-internals.md` | Contribute (Repo-Only) | `no (repo-only)` | `GitHub App Control Plane Internals` | *(excluded from `site/`)* | `<= 400` | App & security engineers | `@loopwright/github-app`; `specs/2026-11-11-github-app-control-plane-and-declarative-taskpack.md` |
| `contribute/closure-matrix.md` | Contribute (Repo-Only) | `no (repo-only)` | `Capability Closure Matrix and Failure Semantics` | *(excluded from `site/`)* | `<= 400` | Release & audit operators | `@loopwright/cli`, `@loopwright/controller`; `specs/2026-11-11-capability-closure-matrix-and-failure-semantics.md` |
| `contribute/adr/0001-local-state-authority.md` | Contribute (Repo-Only) | `no (repo-only)` | `ADR 0001: Local State Authority` | *(excluded from `site/`)* | `<= 220` | Architects & auditors | `@loopwright/state`; `specs/2026-11-05-persistent-state-and-admission.md` |
| `contribute/adr/0002-isolated-pi-sdk.md` | Contribute (Repo-Only) | `no (repo-only)` | `ADR 0002: Isolated Pi SDK` | *(excluded from `site/`)* | `<= 220` | Architects & auditors | `@loopwright/agent-pi`; `specs/2026-11-05-isolated-pi-adapter.md` |

## Per-Page Scope & Boundary Rules

### `docs/README.md` (Shared Index)
- **Owns**: `## Reading paths`, `## Module map` (all 9 module IDs: `contracts`, `state`, `pi-adapter`, `controller`, `taskpacks`, `memory`, `github-app`, `decisions`, `development`), `## Specs`, and `## All pages` (all 24 pages grouped under `### Getting Started`, `### Operations`, `### Walkthroughs`, `### Configuration`, and `### Contribute`).
- **Must not absorb**: Narrative explanations or configuration snippets.

### Public `site/` Pages (`12` Pages Across `4` Groups)
- **`docs/getting-started/architecture.md` (`<= 200` lines)**: 4-stage execution lifecycle (**1. Admit**, **2. Execute**, **3. Verify**, **4. Publish & Remember**), side-by-side comparison of the two operating modes (`Declarative Taskpack` vs. `Managed Controller`), `architecture-flow.svg` + hidden Mermaid flowgraph comment, canonical runtime baseline, and routing links to public configuration pages.
- **`docs/getting-started/installation.md` (`<= 400` lines)**: Choosing between zero-install GitHub Action (`uses: gpustack/loopwright@main`), laptop CLI installation from `npmjs.com` (`@gpustack/loopwright` via `npm` or `pnpm --ignore-scripts`), GitHub Release tarballs, source checkouts (`npm link`), and `llms.txt` interactive bootstrap prompts.
- **`docs/operations/github-action.md` (`<= 400` lines)**: Reusable `action.yml` workflow integration in consumer repositories, all 17 Action inputs and 6 outputs, required GitHub token permissions, secret environment bindings, and Pretty YAML consumer workflow examples.
- **`docs/operations/github-app.md` (`<= 400` lines)**: Deploying the GitHub App server, complete `github-app.yaml` (`GitHubAppConfig`) Macro + Micro Pretty YAML configuration, webhook secret/private key environment binding, and host wiring notes.
- **`docs/operations/cli.md` (`<= 400` lines)**: `@loopwright/cli` commands (`init`, `check`, `run`, `resume`, `status`, `inspect`, `reconcile`, `closure`, `app-serve`), exit code semantics, and recovery discipline.
- **`docs/walkthroughs/declarative-taskpack.md` (`<= 400` lines)**: End-to-end walkthrough of Loopwright's simple automated mode (`.loopwright/taskpack.yaml` + GitHub Action/App + `llms.txt` prompt migration).
- **`docs/walkthroughs/managed-controller.md` (`<= 400` lines)**: End-to-end walkthrough of Loopwright's fine-grained governance mode, including the `managed-controller-relations.svg` containment and cross-reference relationship topology (`ControllerConfig` embedding `TaskContract` and referencing `TrustedRegistry` `metadata.name` + SHA-256 + `${ENV}`), `loopwright init`, `check`, `run`, `inspect`, and `reconcile`.
- **`docs/configuration/taskpack.md` (`<= 400` lines)**: Complete `Taskpack` (`.loopwright/taskpack.yaml`) Pretty YAML schema (`metadata.name`), automatic compilation model, and field-by-field reference tables.
- **`docs/configuration/task-contract.md` (`<= 400` lines)**: Complete `TaskContract` (`apiVersion` + `kind` + `spec`), `VerificationProfile`, and `AttemptReceipt` YAML schemas, field constraints, and enum tables (`roles[].thinking`, `roles[].tools`, `steps[].kind`, `budgets.enforcement.*`, `allowedEvidenceLevels`).
- **`docs/configuration/controller-and-registry.md` (`<= 400` lines)**: Complete `ControllerConfig` (`controller.draft.yaml`, `spec.registry.name`), `TrustedRegistry` (`registry.draft.yaml`, `metadata.name`), handler implementations, `${NAME}` environment variable interpolation (`environmentBindings`), and bounded repair controls.
- **`docs/configuration/sandbox-backends.md` (`<= 400` lines)**: Native OS and container sandbox execution backends (`macos-seatbelt`, `linux-bwrap`, `linux-landlock`, `docker`, `direct-dedicated`), `spec.sandbox` YAML configuration, and capability matrix.
- **`docs/configuration/decision-routing.md` (`<= 400` lines)**: Complete `DecisionPolicy` (`decisions.yaml`, `apiVersion` + `kind` + `spec`) and `spec.decisions` YAML schemas, all 7 provider kinds, disclosure policies, Startlux options, and 3-zone confidence routing (`act`, `confirm`, `escalate`).

### Repository-Only `Contribute` Pages (`12` Pages)
- **`docs/development.md` & `docs/contribute/internals.md` (`<= 400` lines each)**: Workspace build/test/lint/site commands, package dependency order, `.agents/skills/*` routing, and `.opencodereview/rule.json` invariants.
- **`docs/contribute/{identity,evidence,state,pi-adapter,runner-taskpack,memory,github-app-internals,closure-matrix}.md` (`<= 400` lines each)**: Deep subsystem implementation guides for RFC 8785 JCS digests, HMAC `gate.v1` verification authority, SQLite WAL state fencing, isolated Pi subprocess protocol, offline runner parity, reviewed memory CAS compaction, GitHub App webhook/intake internals, and the 23-row capability closure ledger.
- **`docs/contribute/adr/0001-local-state-authority.md` & `docs/contribute/adr/0002-isolated-pi-sdk.md` (`<= 220` lines each)**: Architectural Decision Records for local SQLite authority and isolated Pi subprocess boundaries.
