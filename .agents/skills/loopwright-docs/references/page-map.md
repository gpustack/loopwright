# Page Map — Canonical Three-Zone `docs/` Inventory, Site Publication Boundary, and Ownership

One file owns each technical fact, schema dictionary, or operational workflow. When multiple pages touch a subject, the owning file states the normative contract and every other page links to it within allowed zone boundaries.

## Three-Zone Architecture (`34` Markdown Files Under `docs/`)

Loopwright maintains **`34` Markdown files** under `docs/`: **`1` shared index** (`docs/README.md`) plus **`33` zone pages** partitioned into three strict zones:

- **15 Public Human Site Pages (`Site Published: yes`)**: Built into the Hugo static site (`site/public/`) across `4` groups (`Getting Started`, `Operations`, `Walkthroughs`, `Configuration`), registered under `docs/README.md` `## All pages`, listed in `site/data/navigation.yaml`, `site/content/docs/_index.md`, and `site/layouts/index.html`, indexed in `index.json` and `sitemap.xml`, and exported to `site/public/llms.txt` topic sections.
- **6 Flat LLM Reference Pages (`Site Published: static /references/*.md`)**: Flat `docs/references/*.md` files (`README.md` hub + `5` topic references; `0` subdirectories) excluded from HTML navigation, `index.json`, and `sitemap.xml`, staged with rewritten links by `scripts/site.mjs` (`stageReferenceDocs()`) into `site/resources/references/` → `site/public/references/*.md`, and dynamically emitted under `## Reference` in `docs/README.md` and `site/public/llms.txt`.
- **12 Repo-Only `Contribute` Pages (`Site Published: no (repo-only)`)**: `docs/development.md`, `docs/contribute/{internals,identity,evidence,state,pi-adapter,runner-taskpack,memory,github-app-internals,closure-matrix}.md`, and `docs/contribute/adr/{0001-local-state-authority,0002-isolated-pi-sdk}.md` excluded from Hugo HTML, `index.json`, and `sitemap.xml`, registered under `docs/README.md` `## Contribute`, and emitted under `site/public/llms.txt` `## Optional` as GitHub `blob/<sourceRef>` URLs.
- **One-Way Public Link Isolation**: None of the `15` public `docs/` pages or `site/content/**` files may link to `development.md`, `contribute/**`, or `references/**` (via relative, root-relative, or same-origin URLs). `docs/references/*.md` and `docs/contribute/**` may freely link inward to public pages.

## Zone 1: Public Human Site Inventory (`15` Pages Across `4` Groups)

Every public page (`Site Published: yes`) obeys strict **1:1:1 alignment**: `docs/<slugify(group)>/<slugify(title)>.md`, with `Exact # H1 Title === docs/README.md All pages Label === navigation.yaml Label`, `<= 8` content `##` H2 sections, and both `**See also**` and `**Next**` reading footer lines.

| Path (`docs/`) | Group | Site Published | Exact `# H1` Title (`docs/README.md` Label) | `navigation.yaml` Label | Line Cap | Primary Audience | Owning Package / Spec |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `getting-started/architecture.md` | Getting Started | `yes` | `Architecture` | `Architecture` | `<= 200` | All readers & operators | All workspace packages; `specs/2026-11-12-governance-yaml-configuration-connected-docs-and-branded-site.md` |
| `getting-started/installation.md` | Getting Started | `yes` | `Installation` | `Installation` | `<= 400` | Operators & engineers | `@loopwright/cli`, `action.yml`, `scripts/pack-npm.mjs` |
| `operations/github-action.md` | Operations | `yes` | `GitHub Action` | `GitHub Action` | `<= 400` | Consumer repo operators | `action.yml`, `@loopwright/github-app`, `@loopwright/taskpack` |
| `operations/github-app.md` | Operations | `yes` | `GitHub App` | `GitHub App` | `<= 400` | Platform & App operators | `@loopwright/github-app`; `specs/2026-11-11-github-app-control-plane-and-declarative-taskpack.md` |
| `operations/cli.md` | Operations | `yes` | `CLI` | `CLI` | `<= 400` | Local CLI operators | `@loopwright/cli`, `@loopwright/taskpack`; `specs/2026-11-06-bounded-controller-and-trusted-config.md` |
| `operations/coding-agents.md` | Operations | `yes` | `Coding Agents` | `Coding Agents` | `<= 400` | Host coding agent operators | `@loopwright/controller`, `@loopwright/cli`, `@loopwright/taskpack`; `specs/2026-11-14-delegated-role-stepping-and-multi-model-routing.md` |
| `walkthroughs/declarative-taskpack.md` | Walkthroughs | `yes` | `Declarative Taskpack` | `Declarative Taskpack` | `<= 400` | Repo maintainers | `@loopwright/taskpack`, `@loopwright/github-app`, `@loopwright/taskpack-runner` |
| `walkthroughs/managed-controller.md` | Walkthroughs | `yes` | `Managed Controller` | `Managed Controller` | `<= 400` | Platform & CLI operators | `@loopwright/controller`, `@loopwright/cli`, `@loopwright/core` |
| `walkthroughs/evolutionary-campaign.md` | Walkthroughs | `yes` | `Evolutionary Campaign` | `Evolutionary Campaign` | `<= 400` | Kernel & optimization engineers | `@loopwright/evolution`, `@loopwright/hardware-runner`, `@loopwright/cli` |
| `configuration/taskpack.md` | Configuration | `yes` | `Taskpack` | `Taskpack` | `<= 400` | Repo maintainers | `@loopwright/taskpack`; `specs/2026-11-20-decouple-taskpack-and-cas-blob-pointers.md` |
| `configuration/task-contract.md` | Configuration | `yes` | `Task Contract` | `Task Contract` | `<= 400` | Integrators & engineers | `@loopwright/core`; `specs/2026-11-05-task-contracts-and-evidence.md` |
| `configuration/controller-and-registry.md` | Configuration | `yes` | `Controller and Registry` | `Controller and Registry` | `<= 400` | Controller & CLI operators | `@loopwright/controller`; `specs/2026-11-06-bounded-controller-and-trusted-config.md` |
| `configuration/sandbox-backends.md` | Configuration | `yes` | `Sandbox Backends` | `Sandbox Backends` | `<= 400` | Platform & security engineers | `@loopwright/agent-pi`, `@loopwright/taskpack`; `specs/2026-11-11-native-os-sandbox-execution-backends.md` |
| `configuration/decision-routing.md` | Configuration | `yes` | `Decision Routing` | `Decision Routing` | `<= 400` | Triage & policy operators | `@loopwright/decisions`; `specs/2026-11-11-jev-decision-routing-and-controlled-benchmark.md` |
| `configuration/evolution-campaign.md` | Configuration | `yes` | `Evolution Campaign` | `Evolution Campaign` | `<= 400` | Kernel & optimization engineers | `@loopwright/evolution`; `specs/2026-11-23-evolutionary-campaigns-pareto-archive-and-bundle-export.md` |

## Zone 2: Flat LLM Reference Inventory (`6` Flat `docs/references/*.md` Files)

Every flat reference file opens with `Evidence: contract.`, ends with `**See also**` (`0` `**Next**` lines), stays within `<= 800` lines (exempt from the H2 section cap), and is registered in `docs/README.md` `## Reference`.

| Path (`docs/`) | Site Published | Exact `# H1` Title (`docs/README.md` `## Reference` Label) | Line Cap | Public Owner(s) | Scope |
| --- | --- | --- | --- | --- | --- |
| `references/README.md` | `static (/references/README.md)` | `Reference Hub` | `<= 800` | `getting-started/{architecture,installation}.md` | Task routing table, exact symbol/CLI aliases, and evidence labels; links every sibling `references/*.md` (exempt from `## Contents`) |
| `references/bootstrap-interview.md` | `static (/references/bootstrap-interview.md)` | `Bootstrap Interview Reference` | `<= 800` | `getting-started/installation.md`, `walkthroughs/*.md` | 6-stage interactive agent onboarding protocol for Mode 1 (`Taskpack` / `TaskpackSuite`), Mode 2 (`Managed Controller`), and Mode 3 (`Evolutionary Campaign`) |
| `references/taskpack-and-contract-schema.md` | `static (/references/taskpack-and-contract-schema.md)` | `Taskpack and Contract Reference` | `<= 800` | `configuration/{taskpack,task-contract,evolution-campaign}.md` | Exhaustive field, numeric bound, mount, receipt, hardware cell, and enum dictionaries for `Taskpack`, `TaskpackSuite`, `TaskContract`, `VerificationProfile`, `AttemptReceipt`, and `EvolutionCampaign` |
| `references/controller-and-registry-schema.md` | `static (/references/controller-and-registry-schema.md)` | `Controller and Registry Reference` | `<= 800` | `configuration/{controller-and-registry,decision-routing}.md` | Exhaustive handler/profile/MCP/interpolation bounds for `TrustedRegistry` and `ControllerConfig`, plus `DecisionPolicy`, `AdvisoryDecisionPort`, and `DECISION_FORBIDDEN_AUTHORITY_INTENTS` |
| `references/cli-and-action-reference.md` | `static (/references/cli-and-action-reference.md)` | `CLI and Action Reference` | `<= 800` | `operations/{github-action,cli,github-app}.md` | Complete 44 `action.yml` inputs and 6 outputs, all 23 `@gpustack/loopwright` CLI subcommand actions and flags, CLI exit codes, and `GitHubAppConfig` bounds |
| `references/coding-agent-protocol.md` | `static (/references/coding-agent-protocol.md)` | `Coding Agent Protocol Reference` | `<= 800` | `operations/coding-agents.md` | `StepYield` NDJSON schema, lease/confinement error codes, exit codes, and the verified `node -e` `candidate.files.json` overlay-apply script (kept identical to `loopwright-step/SKILL.md`) |

## Zone 3: Repo-Only `Contribute` Inventory (`12` Pages)

Every contributor page (`Site Published: no (repo-only)`) is registered in `docs/README.md` `## Contribute` (`<= 10` content `##` H2 sections) and emitted under `llms.txt` `## Optional` as a GitHub `blob/<sourceRef>` URL.

| Path (`docs/`) | Group | Site Published | Exact `# H1` Title (`docs/README.md` `## Contribute` Label) | `navigation.yaml` Label | Line Cap | Primary Audience | Owning Package / Spec |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `development.md` | Contribute (Repo-Only) | `no (repo-only)` | `Development and Verification` | *(excluded from `site/`)* | `<= 400` | Repository contributors | Root workspace, `scripts/`, `.agents/skills/` |
| `contribute/internals.md` | Contribute (Repo-Only) | `no (repo-only)` | `Workspace Internals and Boundaries` | *(excluded from `site/`)* | `<= 400` | Repository contributors | All workspace packages, `.opencodereview/rule.json` |
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

## Per-Zone Scope & Boundary Rules

### `docs/README.md` (Shared Three-Zone Index)
- **Owns**: `## Reading paths`, `## Module map` (all `9` module IDs: `contracts`, `state`, `pi-adapter`, `controller`, `taskpacks`, `memory`, `github-app`, `decisions`, `development`), `## Specs`, and three top-level zone tables:
  - `## All pages` (`15` public pages grouped under `### Getting Started`, `### Operations`, `### Walkthroughs`, and `### Configuration` — never nesting `### Contribute` or `### Reference`).
  - `## Reference` (all flat `docs/references/*.md` files dynamically verified against disk).
  - `## Contribute` (all `12` repo-only contributor pages).
- **Must not absorb**: Narrative explanations or configuration snippets.

### Public `site/` Pages (`15` Pages Across `4` Groups, `<= 8` H2s)
- **`docs/getting-started/architecture.md` (`<= 200` lines)**: 4-stage execution lifecycle, operating modes, `architecture-flow.svg` + hidden Mermaid flowgraph comment, runtime baseline, and routing links to public guides.
- **`docs/getting-started/installation.md` (`<= 400` lines)**: Choosing between GitHub Action, `@gpustack/loopwright` CLI (`npm`/`pnpm --ignore-scripts`), release tarballs, source checkouts, and `llms.txt` bootstrap prompts.
- **`docs/operations/github-action.md` (`<= 400` lines)**: Reusable `action.yml` workflow setup, permissions, secret bindings, and common inputs (exhaustive 44-input catalog lives in `docs/references/cli-and-action-reference.md`).
- **`docs/operations/github-app.md` (`<= 400` lines)**: Deploying the GitHub App server, `GitHubAppConfig` Pretty YAML Macro example, webhook admission, and token brokering.
- **`docs/operations/cli.md` (`<= 400` lines)**: Task-oriented `@loopwright/cli` workflows (`init`, `check`, `run`, `step`, `suite`, `runner`, `evolve`, `inspect`, `reconcile`, `closure`) and exit recovery (23-subcommand flag dictionary lives in `docs/references/cli-and-action-reference.md`).
- **`docs/operations/coding-agents.md` (`<= 400` lines)**: Human-first `loopwright step` workflow, multi-role `--role-model` routing, and 5-invariant overlay checklist (full `StepYield` schema and `node -e` overlay-apply script live in `docs/references/coding-agent-protocol.md`).
- **`docs/walkthroughs/declarative-taskpack.md` (`<= 400` lines)**: End-to-end walkthrough of `.loopwright/taskpack.yaml` + GitHub Action/App + prompt migration.
- **`docs/walkthroughs/managed-controller.md` (`<= 400` lines)**: End-to-end walkthrough of out-of-repo `TrustedRegistry` + `ControllerConfig` (`managed-controller-relations.svg`) and CLI governance.
- **`docs/walkthroughs/evolutionary-campaign.md` (`<= 400` lines)**: End-to-end walkthrough of evolutionary campaign mode (`EVOLVE-BLOCK`, `evolve-block-guard.v1`, `benchmark-gate.v1`, `runner relay|worker`, and `loopwright evolve`).
- **`docs/configuration/{taskpack,task-contract,controller-and-registry,sandbox-backends,decision-routing,evolution-campaign}.md` (`<= 400` lines each)**: Human-first mental models, strict block-style Pretty YAML Macro manifests (`Taskpack`, `TaskpackSuite`, `TaskContract`, `ControllerConfig`, `TrustedRegistry`, `DecisionPolicy`, `EvolutionCampaign`), and focused Micro constraints (exhaustive field/bound dictionaries live in `docs/references/{taskpack-and-contract-schema,controller-and-registry-schema}.md`).

### Flat LLM `docs/references/*.md` Pages (`6` Files, `<= 800` Lines)
- **`docs/references/README.md`**: Task routing (pairing every reference lookup with its public owner), exact resource/CLI symbol aliases, and evidence labels (`contract`, `recorded capture`, `synthetic simulation`).
- **`docs/references/{bootstrap-interview,taskpack-and-contract-schema,controller-and-registry-schema,cli-and-action-reference,coding-agent-protocol}.md`**: Machine-oriented interview protocols, complete schema/flag/exit-code tables, and verified protocol scripts fetched by coding agents via `llms.txt`.

### Repo-Only `Contribute` Pages (`12` Pages, `<= 10` H2s)
- **`docs/development.md` & `docs/contribute/internals.md` (`<= 400` lines each)**: Workspace build/test/lint/site commands, package dependency order, `.agents/skills/*` routing, and `.opencodereview/rule.json` invariants.
- **`docs/contribute/{identity,evidence,state,pi-adapter,runner-taskpack,memory,github-app-internals,closure-matrix}.md` (`<= 400` lines each)**: Subsystem implementation guides for JCS digests, HMAC `gate.v1` receipts, SQLite WAL fencing, isolated Pi sessions, runner parity, reviewed memory CAS compaction, GitHub App internals, and capability closure.
- **`docs/contribute/adr/{0001-local-state-authority,0002-isolated-pi-sdk}.md` (`<= 220` lines each)**: Architectural Decision Records.
