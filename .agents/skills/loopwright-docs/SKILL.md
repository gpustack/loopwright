---
name: loopwright-docs
description: >-
  Write, update, or review Loopwright documentation under docs/, README.md, and examples/:
  route each fact to its owning page via references/page-map.md, enforce human-first
  decomposition, 80% ASD-STE100 sentence bounds, Macro + Micro Pretty YAML configuration
  blocks, SVG + hidden Mermaid diagrams, and keep docs/README.md, site/data/navigation.yaml,
  and scripts/check-docs.mjs in sync.
---

# Loopwright Documentation

Use the [module map](../../../docs/README.md#module-map) and [page map](references/page-map.md) to locate owning guides, specifications, code entry points, and related modules. [AGENTS.md](../../../AGENTS.md#finding-sources) defines the repository source hierarchy; this skill defines the authoring and verification procedure.

All documentation under `docs/` follows one page shape, one shared index (`docs/README.md`), and one public/contributor boundary. Detailed writing, heading, table, YAML, and diagram rules live in [references/conventions.md](references/conventions.md). Canonical page ownership and budgets live in [references/page-map.md](references/page-map.md).

## Triggers

Activate this skill whenever:

- Adding, editing, splitting, or reviewing any Markdown file under `docs/`, `README.md`, or `examples/*.md`.
- Documenting a new or changed configuration surface (`controller.draft.yaml`, `registry.draft.yaml`, `.loopwright/taskpack.yaml`, `github-app.yaml`, `decisions.yaml`, `examples/task.yaml`, or `action.yml`).
- Updating `docs/README.md`, `site/data/navigation.yaml`, or SVG diagrams under `docs/assets/diagrams/`.
- Auditing documentation compliance with `npm run lint:docs`, `node scripts/check-docs.mjs --report`, or `npm run site`.

## Step-by-Step Workflow

### Step 1: Route the change via `page-map.md`

1. Read [`docs/README.md`](../../../docs/README.md) and [`references/page-map.md`](references/page-map.md) to identify the single page that owns the concept, contract, or operational procedure.
2. State each normative fact once on its owning page; link to that page from every other guide or walkthrough.
3. Verify whether the target page is one of the **12 public site pages** (across 4 groups: `Getting Started`, `Operations`, `Walkthroughs`, `Configuration`) or one of the **12 repository-only pages** (`docs/development.md` and `docs/contribute/**/*.md`, including `docs/contribute/adr/*.md`).

### Step 2: Author with human-first decomposition (`conventions.md`)

Follow every rule in [`references/conventions.md`](references/conventions.md):

1. **Decompose for human readers first**:
   - Open every concept or capability with a plain-language mental model (1–3 short sentences), followed by a `gpustack`-style Blueprint SVG diagram (`docs/assets/diagrams/*.svg`, generated via `scripts/generate-diagrams.mjs`, paired with a hidden Mermaid comment) or lifecycle table, an annotated two-space Pretty YAML Macro block (listing every schema field), and Micro constraint bullets (`<= 20` words each) plus domain-grouped 2D Markdown tables listing every valid enum choice.
   - Never write bare `spec:` or headless YAML fragments: every ```` ```yaml ```` / ```` ```yml ```` block across `docs/`, `README.md`, and `examples/*.md` must include a Kubernetes-aligned top-level header envelope:
     - **Multi-instance referenced objects** (`Taskpack`, `TrustedRegistry`): `apiVersion`, `kind`, `metadata: { name: <slug> }` (`metadata.name` only — never `metadata.id` or `metadata.version`), and `spec`.
     - **One-off configurations** (`ControllerConfig`, `TaskContract`, `GitHubAppConfig`, `DecisionPolicy`): `apiVersion`, `kind`, and `spec` only.
     - **GitHub Actions workflows**: `name`, `on`, and `jobs`.
   - Annotate `Optional` fields only in YAML `#` comments (omit `# Required` and `# Conditional`), avoid `: ` inside inline `#` comments (which breaks Hugo Chroma comment highlighting), and write `hex: <hash>` (`imageDigest: sha256:<hash>`) instead of 64-character dummy hashes.
   - Keep every SVG card (`scripts/generate-diagrams.mjs`) to `<= 10` words in plain English, using the real Loopwright logo (`docs/assets/logo.png`) in header and middle hub badges, with zero `[]` / `{}` array/object syntax and zero `camelCase` / `snake_case` code clutter.
2. **Enforce 80% ASD-STE100 sentence discipline**:
   - Keep procedural sentences `<= 20` words and conceptual sentences `<= 25` words.
   - Use active voice (`Controller rejects stale leases`, not `Stale leases are rejected by the controller`) and imperative step headings (`Step 1: Generate draft configs`).
   - Eliminate all banned AI filler words and self-referential page narration (`seamlessly`, `delve`, `tapestry`, `leverage`, `utilize`, `cutting-edge`, `empower`, `it is worth noting`, `in order to`, `this page describes`, `this document describes`, `comprehensive guide`).
3. **Follow the 1:1:1 naming rule, page shape, heading, paragraph, table, and reading footer caps**:
   - **1:1:1 alignment for all 12 public pages**: Every public page must reside at `docs/<slugify(group)>/<slugify(title)>.md` across the 4 groups (`docs/getting-started/`, `docs/operations/`, `docs/walkthroughs/`, `docs/configuration/`), and its `site/data/navigation.yaml` label, `# H1` title, and `docs/README.md` `## All pages` label must match character for character.
   - Start with `# <Exact Title>` matching `docs/README.md` `## All pages` character for character.
   - Write 1–3 intro paragraphs (`<= 5` lines and `<= 500` chars per prose paragraph) before `## Contents`.
   - Keep `## Contents` synchronized in exact order with all subsequent `## ` H2 headings.
   - Keep each page to `<= 10` `##` sections (excluding `## Contents`) and within its line cap (`<= 200` lines for `docs/getting-started/architecture.md`, `<= 220` lines for `docs/contribute/adr/*.md`, and `<= 400` lines for all other non-index `docs/**/*.md` pages).
   - Keep every `##` / `###` / `####` heading to `<= 4` words and `<= 32` characters (`Step N: <Action>` allows `<= 4` words after the colon and `<= 38` total characters), with zero articles (`a`, `an`, `the`) and zero interrogative words (`what`, `where`, `when`, `how`, `which`, `why`, `who`, `whose`, `whom`). Name complete YAML schema sections directly after their resource `kind` (`## Taskpack`, `## TaskContract`, `## TrustedRegistry`, `## ControllerConfig`, `## DecisionPolicy`, `## GitHubAppConfig`).
   - Keep every table column header to `1–3` words and `<= 24` characters without articles (`a`, `an`, `the`), demonstratives (`this`, `that`, `these`, `those`), or interrogatives; keep uniform column counts across all rows and keep every table cell `<= 180` characters.
   - End every non-index page with a `\n---\n` reading footer: `**See also** — [Title](path.md) (short description) · ...` (required on all 24 pages) and `**Next** → [Title](path.md) — short description` (required on all 12 public site pages).

### Step 3: Align `docs/README.md` and `site/data/navigation.yaml`

When adding, renaming, or re-scoping a page or module boundary:

1. Update `docs/README.md` (`## Reading paths`, `## Module map`, `## Specs`, and `## All pages`) so every page's `# H1` title matches its `## All pages` link label character for character.
2. Update `site/data/navigation.yaml` so every public page lives at `/docs/<slugify(group)>/<slugify(title)>/` and its `labels` entry equals its `# H1` title character for character (1:1:1 alignment).
3. Keep `docs/development.md` and `docs/contribute/**` out of `site/data/navigation.yaml`.

### Step 4: Run verification gates

Run the documentation linter and static site generator before finishing:

```bash
node scripts/check-docs.mjs --report   # Non-blocking audit summary during authoring (exit 0)
npm run lint:docs                      # Strict documentation contract gate (exit 1 on any violation)
npm run site                           # Build Hugo site, export Markdown/llms.txt, verify 0 broken links
```

## Explicit Boundary Rules

1. **`specs/` are engineering records, never user docs**:
   - Design rationale, rejected alternatives, benchmark methodology, and historical task breakdowns belong in `specs/`.
   - Never rewrite files under `specs/` as user documentation, and never copy raw specification walls of text into `docs/`. User guides state the active operational contract and link to `specs/` only from `docs/README.md` or contributor guides when needed.
2. **Public site (`12` pages) vs. repository-only `Contribute` (`12` pages)**:
   - `docs/development.md` and `docs/contribute/**/*.md` (including `docs/contribute/adr/*.md`) remain in repository `docs/` (and in `docs/README.md`) for contributors and coding agents, but are excluded from `site/` (`site/hugo.toml`, `site/data/navigation.yaml`, `site/public/llms.txt`).
   - **Hard link boundary**: None of the 12 public `docs/` pages may link to `development.md` or `contribute/**` (directly or via relative path), because those targets do not exist on the published Hugo site. Repository-only pages may link to each other and to any public page.
3. **Keep the front door small (`docs/getting-started/architecture.md <= 200` lines)**:
   - `docs/getting-started/architecture.md` introduces Loopwright's four-stage execution chain (**1. Admit**, **2. Execute**, **3. Verify**, **4. Publish & Remember**), the `architecture-flow.svg` diagram with its hidden Mermaid comment, core vocabulary, and links to deep public configuration pages.
4. **Evidence and unknown-outcome honesty**:
   - Distinguish deterministic local/fixture verification from live provider, host sandbox, billing, or GitHub production qualification. Never claim an unverified capability is production-qualified, and preserve `unknown` external outcome semantics in operational examples.

## Where a Fact Belongs

| Topic | Owning Guide |
| --- | --- |
| End-to-end 4-stage execution flow, runtime baseline, vocabulary, and module overview | [Architecture](../../../docs/getting-started/architecture.md) |
| Laptop CLI installation (`@gpustack/loopwright` via `npm`/`pnpm`), release tarballs, and Action setup | [Installation](../../../docs/getting-started/installation.md) |
| Reusable GitHub Action (`action.yml`) inputs, permissions, and workflow setup | [GitHub Action](../../../docs/operations/github-action.md) |
| GitHub App deployment, `github-app.yaml`, webhook server, and installation tokens | [GitHub App](../../../docs/operations/github-app.md) |
| Local CLI subcommands (`init`, `check`, `run`, `inspect`, `reconcile`, `closure`) | [CLI](../../../docs/operations/cli.md) |
| End-to-end `.loopwright/taskpack.yaml` onboarding and prompt migration walkthrough | [Declarative Taskpack](../../../docs/walkthroughs/declarative-taskpack.md) |
| End-to-end out-of-repo `TrustedRegistry`, `ControllerConfig`, relationship topology SVG, and CLI governance | [Managed Controller](../../../docs/walkthroughs/managed-controller.md) |
| Complete `Taskpack` (`.loopwright/taskpack.yaml`) field and enum reference | [Taskpack](../../../docs/configuration/taskpack.md) |
| `TaskContract`, `VerificationProfile`, `AttemptReceipt`, and schema bounds | [Task Contract](../../../docs/configuration/task-contract.md) |
| Bounded controller loop, `ControllerConfig`, `TrustedRegistry`, and repair retries | [Controller and Registry](../../../docs/configuration/controller-and-registry.md) |
| Native OS sandboxes (`macos-seatbelt`, `linux-bwrap`, `linux-landlock`), Docker, and `spec.sandbox` | [Sandbox Backends](../../../docs/configuration/sandbox-backends.md) |
| System-One decision routing, `decisions.yaml`, `spec.decisions`, and 3-zone policy | [Decision Routing](../../../docs/configuration/decision-routing.md) |
| Canonical RFC 8785 JCS hashing, SHA-256 digests, and domain separation (repo-only) | [Identity](../../../docs/contribute/identity.md) |
| Independent verification hooks, HMAC `gate.v1` tokens, and receipt authority (repo-only) | [Evidence](../../../docs/contribute/evidence.md) |
| SQLite WAL state store, lease fencing, monotonic clock guards, and recovery (repo-only) | [State](../../../docs/contribute/state.md) |
| Isolated Pi runtime adapter, physical send admission, and secret scrubbing (repo-only) | [Pi Adapter](../../../docs/contribute/pi-adapter.md) |
| Offline runner parity, frozen taskpack corpus, and deterministic replay (repo-only) | [Runner Taskpack](../../../docs/contribute/runner-taskpack.md) |
| Reviewed memory proposals, CAS compaction, and retention bounds (repo-only) | [Memory](../../../docs/contribute/memory.md) |
| Webhook intake, collaborator permission gates, and taskpack compilation internals (repo-only) | [GitHub App Internals](../../../docs/contribute/github-app-internals.md) |
| Capability closure matrix, `blocked_external` evidence, and failure codes (repo-only) | [Closure Matrix](../../../docs/contribute/closure-matrix.md) |
| Architectural Decision Records (`0001` local state, `0002` isolated Pi SDK) (repo-only) | [ADR 0001](../../../docs/contribute/adr/0001-local-state-authority.md), [ADR 0002](../../../docs/contribute/adr/0002-isolated-pi-sdk.md) |
| Repository build, test, lint, site commands, and contributor workflow (repo-only) | [Development](../../../docs/development.md) |
| Package layer boundaries, security invariants, and workspace internals (repo-only) | [Internals](../../../docs/contribute/internals.md) |

## Sync Invariants

| Artifact | Pinned To | Verification Gate |
| --- | --- | --- |
| `docs/README.md` `## All pages` | All 24 `docs/**/*.md` files and their exact `# H1` titles | `npm run lint:docs` (`scripts/check-docs.mjs`) |
| `docs/README.md` `## Module map` | Nine module IDs, guides, specs, code paths, and skill consumers | `npm run lint:docs` (`scripts/check-docs.mjs`) |
| Each page's `## Contents` | Subsequent `## ` H2 headings in exact document order | `npm run lint:docs` (`scripts/check-docs.mjs`) |
| Public `docs/` links (`12` pages) | Zero links to `development.md` or `contribute/**` | `npm run lint:docs` and `npm run site` |
| `site/data/navigation.yaml` | The 12 public `docs/<group>/<slug>.md` pages with exact 1:1:1 group/filename/label/`# H1` parity | `npm run lint:docs` and `npm run site` |
| `site/public/llms.txt` | Generated from the 12 public pages during `npm run site` | `npm run site` (`scripts/site.mjs`) |

## Pre-Finish Checklist

- [ ] `node scripts/check-docs.mjs` passes with `0 error(s)`.
- [ ] `npm run site` passes with `0 broken link(s)` and exports all 12 public pages.
- [ ] Every public page satisfies 1:1:1 parity: `docs/<slugify(group)>/<slugify(title)>.md`, `navigation.yaml` label === `# H1` title === `docs/README.md` `## All pages` label.
- [ ] `docs/getting-started/architecture.md` is `<= 200` lines and embeds `architecture-flow.svg` plus its hidden Mermaid comment.
- [ ] All configuration blocks use complete two-space Pretty YAML with Kubernetes-aligned top-level header envelopes (`metadata: { name }` on `Taskpack` and `TrustedRegistry`; `apiVersion` + `kind` + `spec` only on `ControllerConfig`, `TaskContract`, `GitHubAppConfig`, and `DecisionPolicy`; or GitHub Actions `name`, `on`, `jobs` — zero bare `spec:` fragments), `Optional`-only inline `#` comments without `: `, `hex: <hash>` placeholders, `<= 20`-word Micro bullets, and uniform 2D enum tables.
- [ ] Every non-index `docs/**/*.md` page ends with `\n---\n\n**See also** — [Title](path.md) (desc) · ...` (and `**Next** → [Title](path.md) — desc` on all 12 public pages).
- [ ] Zero public pages link to `development.md` or `contribute/**`.
- [ ] Zero banned AI filler words, zero interrogative headings or table headers, and zero paragraphs over `5` lines or `500` characters.
