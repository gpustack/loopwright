---
name: loopwright-docs
description: >-
  Write, update, or review Loopwright documentation under docs/, README.md, and examples/:
  route each fact across the three documentation zones via references/page-map.md, enforce
  human-first decomposition, 80% ASD-STE100 sentence bounds, Strict Pretty Block-Style YAML
  configuration blocks, kind-plural and H1-H3 heading rules, SVG + hidden Mermaid diagrams,
  and keep docs/README.md, docs/references/README.md, site/data/navigation.yaml,
  site/content/docs/_index.md, site/layouts/index.html, and scripts/check-docs.mjs in sync.
---

# Loopwright Documentation

Use the [module map](../../../docs/README.md#module-map) and [page map](references/page-map.md) to locate owning guides, flat machine references, specifications, code entry points, and related modules. [AGENTS.md](../../../AGENTS.md#finding-sources) defines the repository source hierarchy; this skill defines the three-zone authoring and verification procedure.

All documentation under `docs/` (`34` Markdown files: `docs/README.md` shared index + `15` Public Human Site pages + `6` Flat LLM Reference `docs/references/*.md` files + `12` Repo-only `Contribute` pages) follows strict zone governance, one shared index (`docs/README.md`), and one-way public link isolation. Detailed writing, plurality, heading, table, Pretty YAML, and diagram rules live in [references/conventions.md](references/conventions.md). Canonical page ownership and budgets live in [references/page-map.md](references/page-map.md).

## Triggers

Activate this skill whenever:

- Adding, editing, splitting, or reviewing any Markdown file under `docs/`, `README.md`, or `examples/*.md`.
- Documenting a new or changed configuration surface (`controller.draft.yaml`, `registry.draft.yaml`, `.loopwright/taskpack.yaml`, `.loopwright/suite.yaml`, `campaign.yaml`, `github-app.yaml`, `decisions.yaml`, `examples/task.yaml`, or `action.yml`).
- Updating `docs/README.md`, `docs/references/README.md`, `site/data/navigation.yaml`, `site/content/docs/_index.md`, `site/layouts/index.html`, or SVG diagrams under `docs/assets/diagrams/`.
- Auditing documentation compliance with `npm run lint:docs`, `node scripts/check-docs.mjs --report`, or `npm run site`.

## Step-by-Step Workflow

### Step 1: Route the change across the Three Zones (`page-map.md`)

1. Read [`docs/README.md`](../../../docs/README.md), [`docs/references/README.md`](../../../docs/references/README.md), and [`references/page-map.md`](references/page-map.md) to identify the single file that owns the concept, contract, schema dictionary, or operational procedure.
2. State each normative fact once on its owning page; link to that page from other guides within allowed zone boundaries.
3. Classify the target into one of Loopwright's **three documentation zones**:
   - **Public Human Site (`15` pages across `4` groups: `Getting Started`, `Operations`, `Walkthroughs`, `Configuration`)**: Concise human-first mental models, task workflows, annotated block-style Pretty YAML Macro examples, Micro constraint bullets, and core enum tables.
   - **Flat LLM Reference (`docs/references/*.md`, `6` flat files: `README.md` hub + `5` topic files)**: Exhaustive field/bound/flag/exit-code lookup tables, `StepYield` and overlay-apply protocol contracts, and interactive bootstrap interview procedures exported as static `/references/*.md` via `llms.txt`.
   - **Repo-only `Contribute` (`12` pages: `docs/development.md` and `docs/contribute/**/*.md`, including `docs/contribute/adr/*.md`)**: Internal subsystem architecture, cryptographic/SQLite/Pi runtime invariants, and ADRs linked under `llms.txt` `## Optional` as GitHub `blob/<sourceRef>` URLs.

### Step 2: Author with human-first decomposition & strict formatting (`conventions.md`)

Follow every rule in [`references/conventions.md`](references/conventions.md):

1. **Decompose for human readers first & keep YAML strictly block-style**:
   - Open every public concept or capability with a plain-language mental model (1–3 short sentences), followed by a `gpustack`-style Blueprint SVG diagram (`docs/assets/diagrams/*.svg`, generated via `scripts/generate-diagrams.mjs`, paired with a hidden Mermaid comment) or lifecycle table, an annotated two-space Pretty YAML Macro block, and Micro constraint bullets (`<= 20` words each) plus domain-grouped 2D Markdown tables. Offload exhaustive bound/flag/error-code dictionaries to `docs/references/*.md` rather than packing mega-bullets into public pages.
   - **Strict Pretty Block-Style YAML (mandatory)**: Every ```` ```yaml ```` / ```` ```yml ```` block across `docs/`, `README.md`, and `examples/*.md` MUST use multi-line 2-space block style — **zero non-empty flow mappings (`{ k: v }`) and zero non-empty flow sequences (`[a, b]`, `[{ ... }]`)**, allowing only explicit empty `{}` and `[]`. Reject YAML anchors (`&`), aliases (`*`), merge keys (`<<`), custom tags (`!`), and duplicate keys. Never compress YAML into inline flow syntax to game page line caps; trim duplicate subfields to `docs/references/` while keeping every shown YAML block strictly 2-space block-style Pretty YAML.
   - Never write bare `spec:` or headless YAML fragments: every YAML block must declare its complete Kubernetes-aligned top-level header envelope:
     - **Named multi-instance / cross-referenced objects** (`Taskpack`, `TaskpackSuite`, `TrustedRegistry`, `EvolutionCampaign`): `apiVersion`, `kind`, `metadata` with 2-space nested `name: <slug>` (`metadata.name` only — never `metadata.id` or `metadata.version`), and `spec`.
     - **One-off / standalone objects** (`ControllerConfig`, `TaskContract`, `GitHubAppConfig`, `DecisionPolicy`, `VerificationProfile`, `AttemptReceipt`): `apiVersion`, `kind`, and `spec` only.
     - **GitHub Actions workflows**: `name`, `on`, and `jobs`.
   - Annotate `Optional` fields only in YAML `#` comments (omit `# Required` and `# Conditional`), avoid `: ` inside inline `#` comments (which breaks Hugo Chroma comment highlighting), and write `hex: <hash>` (`imageDigest: sha256:<hash>`) instead of 64-character dummy hashes.
   - Keep every SVG card (`scripts/generate-diagrams.mjs`) to `<= 10` words in plain English, using the real Loopwright logo (`docs/assets/logo.png`) in header and middle hub badges, with zero `[]` / `{}` array/object syntax and zero `camelCase` / `snake_case` code clutter.
2. **Enforce 80% ASD-STE100 sentence & plurality discipline**:
   - Keep procedural sentences `<= 20` words and conceptual sentences `<= 25` words, in active voice (`Controller rejects stale leases`) with imperative step headings (`Step 1: Generate draft configs`).
   - **Menu & heading grammatical-number parity**: Use plural nouns for collections (`Walkthroughs`, `Operations`, `Sandbox Backends`, `Coding Agents`), singular nouns for single workflows or resource kinds (`Declarative Taskpack`, `Managed Controller`, `Evolutionary Campaign`, `Taskpack`, `Task Contract`, `Evolution Campaign`), and keep siblings of one type in the same grammatical number.
   - **Checked Kind-Plural rule in authored prose**: Keep the singular resource kind inside backticks and place `s` or an explicit plural noun outside (write `` `Taskpack`s ``, `` `TaskpackSuite`s ``, `` `TaskContract`s ``, `` `TrustedRegistry` objects ``, `` `ControllerConfig`s ``, `` `GitHubAppConfig`s ``, `` `DecisionPolicy` objects ``, `` `EvolutionCampaign`s ``, `` `AttemptReceipt`s `` — never `` `Taskpacks` ``, `` `TrustedRegistries` ``, `` `DecisionPolicies` ``, or `` `TrustedRegistry`s ``).
   - Eliminate all banned AI filler words and self-referential page narration (`seamlessly`, `delve`, `tapestry`, `leverage`, `utilize`, `cutting-edge`, `empower`, `it is worth noting`, `in order to`, `this page describes`, `this document describes`, `comprehensive guide`).
3. **Follow the 1:1:1 naming rule, heading ceiling, section/line caps, and zone footers**:
   - **1:1:1 alignment for all 15 public pages**: Every public page resides at `docs/<slugify(group)>/<slugify(title)>.md` across the 4 groups (`docs/getting-started/`, `docs/operations/`, `docs/walkthroughs/`, `docs/configuration/`), with exact character-for-character equality across its `site/data/navigation.yaml` label, `# H1` title, and `docs/README.md` `## All pages` label.
   - **Hard `H1`–`H3` heading depth ceiling**: Never use `####`, `#####`, or `######` (`H4+` forbidden across all `docs/**/*.md`). Use bold lead-in bullets or 2D tables under `###` subsections instead.
   - **Heading wording & caps**: Keep every `##` / `###` heading to `<= 4` words and `<= 32` characters (`Step N: <Action>` allows `<= 4` words after the colon and `<= 38` total characters), with zero articles (`a`, `an`, `the`), zero interrogatives (`what`, `where`, `when`, `how`, `which`, `why`, `who`, `whose`, `whom`), and zero layout-container heading nouns (`row`, `rows`, `table`, `tables`, `column`, `columns`, `guide`, `guides`, `entries`, `section`, `sections`). Name complete YAML schema sections directly after their resource `kind` (`## Taskpack`, `## TaskpackSuite`, `## TaskContract`, `## TrustedRegistry`, `## ControllerConfig`, `## DecisionPolicy`, `## GitHubAppConfig`, `## EvolutionCampaign`).
   - **Section & line caps**: Keep content `##` H2 sections (excluding `## Contents`) to `<= 8` on the 15 public pages and `<= 10` on the 12 `Contribute` pages (`docs/README.md` and `docs/references/*.md` are exempt from the H2 cap). Keep line counts within `<= 200` (`docs/getting-started/architecture.md`), `<= 220` (`docs/contribute/adr/*.md`), `<= 800` (`docs/references/*.md`), and `<= 400` (all other non-index `docs/**/*.md` pages).
   - **Contents & prose caps**: Write 1–3 intro paragraphs (`<= 5` lines and `<= 500` chars per prose paragraph) before `## Contents` and keep `## Contents` synchronized in exact order with subsequent `## ` H2 headings (`docs/references/README.md` is exempt from `## Contents`).
   - **Table caps**: Keep column headers to `1–3` words and `<= 24` chars without articles, demonstratives, or interrogatives; maintain uniform column counts and keep cells `<= 180` chars.
   - **Zone-specific headers & footers**:
     - Every flat `docs/references/*.md` file must declare `Evidence: contract | recorded capture | synthetic simulation.` before its first `## ` heading, end with `\n---\n\n**See also** — [Title](path.md) (desc) · ...`, and **never** include `**Next**`.
     - Every public site page (15) must end with `\n---\n\n**See also** — ...` followed by `**Next** → [Title](path.md) — short description`.
     - Every repo-only `Contribute` page (12) must end with `\n---\n\n**See also** — ...` (optional `**Next**` if present must match `**Next** → [Title](path.md) — desc`).

### Step 3: Synchronize Indexes, Reference Hub, and Site Surfaces

When adding, renaming, or re-scoping a page or reference:

1. Update `docs/README.md` across its three top-level zone tables — `## All pages` (`15` public pages only; never nest `### Contribute` inside `## All pages`), `## Reference` (all flat `docs/references/*.md` files), and `## Contribute` (`12` repo-only pages) — with exact `# H1` label equality, plus `## Reading paths`, `## Module map`, and `## Specs`.
2. Update `docs/references/README.md` whenever flat `docs/references/*.md` files or anchored symbols change; ensure `docs/references/` contains zero subdirectories and `docs/references/README.md` links every sibling `docs/references/*.md`.
3. Update `site/data/navigation.yaml`, `site/content/docs/_index.md`, and `site/layouts/index.html` in lockstep so all three link to the exact 15 public pages (`check-docs.mjs` enforces 15-of-15 parity across all three).

### Step 4: Run verification gates

Run the documentation linter and static site generator before finishing:

```bash
node scripts/check-docs.mjs --report   # Non-blocking audit summary during authoring (exit 0)
npm run lint:docs                      # Strict documentation contract gate (exit 1 on any violation)
npm run site                           # Stage references, build Hugo site, verify llms.txt/sitemap/index.json/links
```

## Explicit Boundary Rules

1. **`specs/` are engineering records, never user docs**:
   - Design rationale, rejected alternatives, benchmark methodology, and historical task breakdowns belong in `specs/`.
   - Never rewrite files under `specs/` as user documentation, and never copy raw specification walls of text into `docs/`.
2. **Three-Zone Governance & One-Way Public Link Isolation**:
   - **Public Human Site (`15` pages)** renders to HTML, Markdown (`/docs/<group>/<slug>/index.md`), `index.json`, `sitemap.xml`, and `llms.txt` topic sections.
   - **Flat LLM Reference (`docs/references/*.md`, `6` flat files)** is excluded from HTML navigation, `index.json`, and `sitemap.xml`; `scripts/site.mjs` (`stageReferenceDocs()`) rewrites relative links before Hugo runs into `/references/*.md` and exposes them under `llms.txt` `## Reference`.
   - **Repo-only `Contribute` (`12` pages)** is excluded from Hugo HTML, `index.json`, and `sitemap.xml`, and exposed under `llms.txt` `## Optional` as GitHub `blob/<sourceRef>` URLs.
   - **Hard one-way link isolation**: None of the 15 public `docs/` pages or `site/content/**` files may link to `development.md`, `contribute/**`, or `references/**` — via relative paths, root-relative paths (`/references/...`, `/docs/references/...`, `/docs/contribute/...`, `/docs/development/...`), or same-origin/GitHub blob URLs. (Literal copy-paste URLs inside fenced prompt code blocks are permitted.) `docs/references/*.md` and `docs/contribute/**` may freely link inward to public pages.
3. **Keep the front door small (`docs/getting-started/architecture.md <= 200` lines)**:
   - `docs/getting-started/architecture.md` introduces Loopwright's four-stage execution chain (**1. Admit**, **2. Execute**, **3. Verify**, **4. Publish & Remember**), `architecture-flow.svg` with its hidden Mermaid comment, operating modes, and routing links to public guides.
4. **Evidence and unknown-outcome honesty**:
   - Distinguish deterministic local/fixture verification from live provider, host sandbox, billing, or GitHub production qualification. Never claim an unverified capability is production-qualified, and preserve `unknown` external outcome semantics in operational examples.

## Where a Fact Belongs

| Topic | Zone | Owning File |
| --- | --- | --- |
| End-to-end 4-stage execution flow, runtime baseline, vocabulary, and module overview | Public | [Architecture](../../../docs/getting-started/architecture.md) |
| Laptop CLI installation (`@gpustack/loopwright` via `npm`/`pnpm`), release tarballs, Action setup, and bootstrap prompts | Public | [Installation](../../../docs/getting-started/installation.md) |
| Reusable GitHub Action (`action.yml`) workflow setup, permissions, and common inputs | Public | [GitHub Action](../../../docs/operations/github-action.md) |
| GitHub App deployment, `github-app.yaml` overview, webhook server, and installation tokens | Public | [GitHub App](../../../docs/operations/github-app.md) |
| Local CLI workflows (`init`, `check`, `run`, `suite`, `runner`, `evolve`, `inspect`, `reconcile`, `closure`) | Public | [CLI](../../../docs/operations/cli.md) |
| Zero-secret OAuth coding agent operation (`loopwright step`), `--role-model` routing, and overlay workflow | Public | [Coding Agents](../../../docs/operations/coding-agents.md) |
| End-to-end `.loopwright/taskpack.yaml` onboarding and prompt migration walkthrough | Public | [Declarative Taskpack](../../../docs/walkthroughs/declarative-taskpack.md) |
| End-to-end out-of-repo `TrustedRegistry`, `ControllerConfig`, relationship topology SVG, and CLI governance | Public | [Managed Controller](../../../docs/walkthroughs/managed-controller.md) |
| End-to-end evolutionary campaign setup (`EVOLVE-BLOCK`, `runner relay\|worker`, `loopwright evolve`, bundle export) | Public | [Evolutionary Campaign](../../../docs/walkthroughs/evolutionary-campaign.md) |
| Core `Taskpack` (`.loopwright/taskpack.yaml`) and `TaskpackSuite` (`.loopwright/suite.yaml`) mental model and YAML | Public | [Taskpack](../../../docs/configuration/taskpack.md) |
| Core `TaskContract`, `VerificationProfile`, and `AttemptReceipt` mental model, budgets, and evidence tiers | Public | [Task Contract](../../../docs/configuration/task-contract.md) |
| Bounded controller loop, `ControllerConfig`, `TrustedRegistry`, and repair retry controls | Public | [Controller and Registry](../../../docs/configuration/controller-and-registry.md) |
| Native OS sandboxes (`macos-seatbelt`, `linux-bwrap`, `linux-landlock`), Docker, and `spec.sandbox` | Public | [Sandbox Backends](../../../docs/configuration/sandbox-backends.md) |
| System-One decision routing, `decisions.yaml`, `spec.decisions`, and 3-zone policy | Public | [Decision Routing](../../../docs/configuration/decision-routing.md) |
| `EvolutionCampaign` (`campaign.yaml`) islands, stages, `teamEvolution`, and `evolution-bundle.v1` overview | Public | [Evolution Campaign](../../../docs/configuration/evolution-campaign.md) |
| Task routing, exact resource/CLI aliases, and reference evidence labels | Reference | [Reference Hub](../../../docs/references/README.md) |
| Interactive agent interview protocol for Mode 1, Mode 2, and Mode 3 repository onboarding | Reference | [Bootstrap Interview Reference](../../../docs/references/bootstrap-interview.md) |
| Exhaustive `Taskpack`, `TaskpackSuite`, `TaskContract`, `AttemptReceipt`, and `EvolutionCampaign` bounds | Reference | [Taskpack and Contract Reference](../../../docs/references/taskpack-and-contract-schema.md) |
| Exhaustive `TrustedRegistry`, `ControllerConfig`, `DecisionPolicy`, and `AdvisoryDecisionPort` tables | Reference | [Controller and Registry Reference](../../../docs/references/controller-and-registry-schema.md) |
| Exhaustive 44 `action.yml` inputs, 23 CLI subcommand actions, exit codes, and `GitHubAppConfig` bounds | Reference | [CLI and Action Reference](../../../docs/references/cli-and-action-reference.md) |
| `StepYield` JSON schema, lease diagnostics, exit codes, and verified `node -e` overlay-apply script | Reference | [Coding Agent Protocol Reference](../../../docs/references/coding-agent-protocol.md) |
| Repository build, test, lint, site commands, and contributor workflow | Contribute | [Development](../../../docs/development.md) |
| Package layer boundaries, security invariants, and workspace internals | Contribute | [Internals](../../../docs/contribute/internals.md) |
| Canonical RFC 8785 JCS hashing, SHA-256 digests, and domain separation | Contribute | [Identity](../../../docs/contribute/identity.md) |
| Independent verification hooks, HMAC `gate.v1` tokens, and receipt authority | Contribute | [Evidence](../../../docs/contribute/evidence.md) |
| SQLite WAL state store, lease fencing, monotonic clock guards, and recovery | Contribute | [State](../../../docs/contribute/state.md) |
| Isolated Pi runtime adapter, physical send admission, and secret scrubbing | Contribute | [Pi Adapter](../../../docs/contribute/pi-adapter.md) |
| Offline runner parity, frozen taskpack corpus, and deterministic replay | Contribute | [Runner Taskpack](../../../docs/contribute/runner-taskpack.md) |
| Reviewed memory proposals, CAS compaction, and retention bounds | Contribute | [Memory](../../../docs/contribute/memory.md) |
| Webhook intake, collaborator permission gates, and taskpack compilation internals | Contribute | [GitHub App Internals](../../../docs/contribute/github-app-internals.md) |
| Capability closure matrix, `blocked_external` evidence, and failure codes | Contribute | [Closure Matrix](../../../docs/contribute/closure-matrix.md) |
| Architectural Decision Records (`0001` local state, `0002` isolated Pi SDK) | Contribute | [ADR 0001](../../../docs/contribute/adr/0001-local-state-authority.md), [ADR 0002](../../../docs/contribute/adr/0002-isolated-pi-sdk.md) |

## Sync Invariants

| Artifact | Pinned To | Verification Gate |
| --- | --- | --- |
| `docs/README.md` (`## All pages`, `## Reference`, `## Contribute`) | `15` public pages, all flat `docs/references/*.md` (`6`), and `12` `Contribute` pages with exact `# H1` titles | `npm run lint:docs` and `npm run site` |
| `docs/references/README.md` | Flat `docs/references/` (0 subdirectories) linking every sibling `docs/references/*.md` | `npm run lint:docs` (`scripts/check-docs.mjs`) |
| `docs/README.md` `## Module map` | Nine module IDs, guides, specs, code paths, and skill consumers | `npm run lint:docs` (`scripts/check-docs.mjs`) |
| Each page's `## Contents` | Subsequent `## ` H2 headings in exact order (`docs/references/README.md` exempt) | `npm run lint:docs` (`scripts/check-docs.mjs`) |
| Public `docs/` (`15`) + `site/content/**` links | Zero links to `development.md`, `contribute/**`, or `references/**` (relative, root-relative, or same-origin) | `npm run lint:docs` and `npm run site` |
| `site/data/navigation.yaml`, `site/content/docs/_index.md`, `site/layouts/index.html` | Exact 15 public `docs/<group>/<slug>.md` pages with 1:1:1 group/filename/label/`# H1` parity | `npm run lint:docs` and `npm run site` |
| `site/public/llms.txt` & `site/public/references/*.md` | All 3 zones (`15` Public + `6` rewritten `/references/*.md` + `12` GitHub `Optional` Contribute links) and 0 leaks in `index.json`/`sitemap.xml` | `npm run site` (`scripts/site.mjs`) |

## Pre-Finish Checklist

- [ ] `node scripts/check-docs.mjs` passes with `0 error(s)` across all `34` `docs/**/*.md` files.
- [ ] `npm run site` passes with `0 broken link(s)`, exports all `15` public pages + `6` rewritten `references/*.md` files, and emits zero excluded-zone entries in `index.json` or `sitemap.xml`.
- [ ] Every public page satisfies 1:1:1 parity (`docs/<slugify(group)>/<slugify(title)>.md`, `navigation.yaml` label === `# H1` title === `docs/README.md` `## All pages` label) and is linked in both `site/content/docs/_index.md` and `site/layouts/index.html`.
- [ ] `docs/getting-started/architecture.md` is `<= 200` lines and embeds `architecture-flow.svg` plus its hidden Mermaid comment; public pages have `<= 8` content `##` H2s (`<= 400` lines); `Contribute` pages have `<= 10` content `##` H2s (`<= 400` lines, ADRs `<= 220`); `docs/references/*.md` are flat (`<= 800` lines), open with `Evidence:`, and omit `**Next**`.
- [ ] Zero `H4`–`H6` (`####+`) headings, zero layout-container heading nouns, and zero malformed kind-plurals (such as `` `Taskpacks` `` or `` `TrustedRegistry`s ``) appear in `docs/**/*.md`.
- [ ] All YAML blocks use strict 2-space block-style Pretty YAML (zero non-empty `{ ... }` flow mappings and zero non-empty `[ ... ]` flow sequences; `metadata.name` on `Taskpack`, `TaskpackSuite`, `TrustedRegistry`, and `EvolutionCampaign`; `apiVersion` + `kind` + `spec` only on `ControllerConfig`, `TaskContract`, `GitHubAppConfig`, `DecisionPolicy`, `VerificationProfile`, and `AttemptReceipt`; or GitHub Actions `name`, `on`, `jobs`), `Optional`-only `#` comments without `: `, and `hex: <hash>` placeholders.
- [ ] Zero public pages or `site/content/**` files link to `development.md`, `contribute/**`, or `references/**`.
- [ ] Zero banned AI filler words, zero interrogative headings or table headers, and zero paragraphs over `5` lines or `500` characters.
