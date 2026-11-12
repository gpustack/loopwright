# Documentation Conventions — Human-First Decomposition, Page Shape, and Writing Rules

Every page under `docs/`, `README.md`, and `examples/*.md` is written for human engineers and repository operators first, and checked deterministically by `scripts/check-docs.mjs` and `scripts/site.mjs`.

## 1. Human-First Decomposition Pattern

Never dump dense implementation prose, raw TypeScript interfaces, or unannotated JSON schemas onto a reader. Decompose every concept, subsystem, or operational workflow into four progressive layers:

1. **Mental model (1–3 short sentences)**: State what the component or workflow does, what boundary it enforces, and when an operator uses it.
2. **Visual flow or lifecycle table**:
   - For 3 or more interacting stages or components, embed a committed SVG diagram (`docs/assets/diagrams/*.svg`) paired with a hidden `<!-- flowchart ... -->` comment immediately below.
   - For two-dimensional comparisons (modes, sandbox backends, error codes, failure outcomes), present a uniform 2D Markdown table.
3. **Macro view (Complete Annotated Pretty YAML)**: Show a complete, copy-pasteable two-space Pretty YAML configuration or manifest (`apiVersion`, `kind`, `metadata`, `spec`) listing **every** schema field (required and optional) with inline `#` comments marking required fields, defaults, bounds, and security constraints.
4. **Micro view (Constraint bullets + Domain-grouped reference tables)**: Immediately beneath the Macro YAML block, list key field rules as short bullets (`- **<Field>**: <Constraint in <= 20 words>.`) and document **every schema field, numeric bound, and valid enum choice** (`kind`, `mode`, `provider`, `disclosurePolicy`, `preferredBackends`, `networkMode`, `requiredCapabilities`, `implementation`, `enforcement`) in **domain-grouped** 2D Markdown tables (`### <Domain>`). Never merge values from unrelated YAML fields or domains (for example, mixing provider names with numeric retry counts `1` / `2`) into a single generic `Value | Meaning | Constraints` table.

## 2. Sentence & Voice Discipline (80% ASD-STE100)

Apply controlled-English discipline across `README.md`, `docs/**/*.md`, and `examples/*.md`:

- **Sentence length bounds**:
  - **Procedural sentences**: `<= 20` words per sentence. One action per step.
  - **Conceptual / descriptive sentences**: `<= 25` words per sentence. One claim per sentence.
- **Active voice**: Name the actor and verb directly.
  - Write: `The controller rejects stale lease tokens before verification.`
  - Do not write: `Stale lease tokens are rejected by the controller prior to verification being executed.`
- **Imperative procedures**: Address operator actions with direct imperative verbs (`Create`, `Validate`, `Inspect`, `Run`). Number dependent steps as `Step N: <Action>`.
- **Zero self-referential page narration**: Never write `This page describes`, `This document describes`, `This section covers`, or `In this guide we will`. State the technical fact or operator instruction directly.
- **Consistent Loopwright terminology**: Use one canonical name for each domain concept:

| Concept | Canonical Term | Avoid |
| --- | --- | --- |
| Work specification document | `task contract` (`TaskContract`) | job spec, task payload, work item |
| Monotonic SQLite admission lock | `lease fence` | lock token, session lock, DB mutex |
| Monotonic wall/monotonic time guard | `monotonic clock guard` | clock check, time skew guard |
| Cryptographic verification receipt token | `gate token` (`gate.v1`) | check signature, verification hash |
| Repository automation manifest | `taskpack` (`.loopwright/taskpack.yaml`) | repo workflow, automation config |
| Calibrated System-One triage node | `decision router` (`@loopwright/decisions`) | AI classifier, fast model router |
| Reviewed content-addressed memory | `reviewed memory` (`@loopwright/memory`) | agent memory, vector store |
| Qualification and failure ledger | `closure matrix` (`loopwright closure`) | readiness table, feature matrix |
| Uncertain external side effect | `unknown outcome` (`unknown`) | ambiguous failure, partial error |

- **Banned AI filler words and phrases**: `scripts/check-docs.mjs` rejects the following case-insensitively in `docs/**/*.md` prose:
  - `seamlessly`
  - `delve`
  - `tapestry`
  - `leverage`
  - `utilize`
  - `cutting-edge`
  - `empower`
  - `it is worth noting`
  - `in order to`
  - `this page describes`
  - `this document describes`
  - `comprehensive guide`
  - Also avoid figurative puffery such as `robust`, `streamline`, `unlock`, `pivotal`, or `crucial` unless naming a literal identifier.

## 3. Page Shape & `gpustack`-Style Reading Footer Contract

Every page under `docs/**/*.md` (except the index `docs/README.md`) must follow this exact structure:

```markdown
# <Exact Page Title Matching docs/README.md All pages>

Short introductory paragraph (1 to 3 paragraphs, each <= 5 lines and <= 500 characters)
stating the component role, safety boundary, and operator entry point.

## Contents

- [Overview](#overview)
- [Configuration](#configuration)
- [Step 1: Generate draft files](#step-1-generate-draft-files)
- [Verification](#verification)
- [Troubleshooting](#troubleshooting)

## Overview

...

## Configuration

...

## Step 1: Generate draft files

...

## Verification

...

## Troubleshooting

...

---

**See also** — [Controller and Registry](../configuration/controller-and-registry.md) (draft configuration and handler digests) · [Sandbox Backends](../configuration/sandbox-backends.md) (native OS and container isolation)

**Next** → [Declarative Taskpack](../walkthroughs/declarative-taskpack.md) — author and verify a repository taskpack end to end.
```

### 1:1:1 Group Directory, Filename Slug, Sidebar Label, and `# H1` Title Rule

Every public documentation page (all 12 pages published to `site/`) must obey strict **1:1:1 alignment**:

1. **Group directory matches navigation group**: Public pages reside inside one of the 4 group-matching directories under `docs/`:
   - `Getting Started` → `docs/getting-started/`
   - `Operations` → `docs/operations/`
   - `Walkthroughs` → `docs/walkthroughs/`
   - `Configuration` → `docs/configuration/`
2. **Filename matches `# H1` slug**: `path.basename(file, '.md') === slugify(h1Title)` (for example, `# Controller and Registry` → `docs/configuration/controller-and-registry.md`, `# Task Contract` → `docs/configuration/task-contract.md`, `# CLI` → `docs/operations/cli.md`).
3. **Exact label equality across all surfaces**: `site/data/navigation.yaml` `labels["/docs/<group>/<slug>/"]` === page `# H1` title === `docs/README.md` `## All pages` link label. Never mix `Taskpack Manifest` in the sidebar with `# Taskpack Manifest Reference` in the article or `Task Contracts` with `# Task Contracts and Schemas`.

### Reading Footer Format (`\n---\n`)

`site/layouts/partials/article-content.html` splits page content on `\n---\n` and renders the trailing `**See also**` / `**Next**` block into `<nav class="reading-footer">`:

1. **Trailing `\n---\n` separator**: Every non-index `docs/**/*.md` page must end with a `\n---\n` horizontal rule followed by `**See also** — `.
2. **Descriptive `See also` items**: Separate multiple items with ` · ` (middle dot). Every item must include a Markdown link `[Title](target.md)` followed by a parenthetical description `(short phrase explaining why to read it)`.
3. **Descriptive `Next` pointer**: Every public `site/` page (all 12 pages) must include a `**Next** → [Title](target.md) — <short description>` line after `**See also**`. Whenever `**Next**` appears on any repository-only page, it must follow the same `**Next** → [Title](target.md) — <description>` format.

### Enforced Page Shape Caps

| Rule | Limit | Scope |
| --- | --- | --- |
| H1 title & 1:1:1 parity | Exact match with `docs/README.md` `## All pages` label; on public pages, also matches `navigation.yaml` label and `docs/<group>/<slug>.md` | All 24 `docs/**/*.md` pages |
| Intro before `## Contents` | 1–3 paragraphs (`<= 5` lines, `<= 500` chars each) | All non-index `docs/**/*.md` pages |
| `## Contents` | Exact match and order for all subsequent `## ` headings | All non-index `docs/**/*.md` pages |
| `##` section count | `<= 10` `##` headings (excluding `## Contents`) | All non-index `docs/**/*.md` pages |
| Prose paragraph size | `<= 5` lines and `<= 500` characters | All `docs/**/*.md` pages (excluding trailing `\n---\n` footer) |
| Architecture line budget | `<= 200` lines | `docs/getting-started/architecture.md` |
| ADR line budget | `<= 220` lines | `docs/contribute/adr/*.md` |
| Standard page line budget | `<= 400` lines | All other non-index `docs/**/*.md` pages |
| Reading footer | `\n---\n\n**See also** — [Title](path) (desc)` required; `**Next** → [Title](path) — desc` required on public pages | All non-index `docs/**/*.md` pages |
| Public-to-Contribute link ban | `0` links to `development.md` or `contribute/**` | All 12 site-published `docs/` pages |

### Prose Paragraph Measurement Rules

`scripts/check-docs.mjs` strips the trailing `\n---\n` reading footer block first, then measures contiguous prose paragraphs outside:
- Fenced code blocks (```` ``` ```` or `~~~`)
- HTML comments (`<!-- ... -->`)
- Markdown tables (lines starting with `|`)
- Blockquotes (lines starting with `>`)
- Bullet or numbered list items (lines starting with `- `, `* `, `+ `, or `1. `)
- Headings (`#` through `######`)
- Standalone image lines (`![...](...)`)
- Footer lines starting with `**See also**` or `**Next**`

If a prose paragraph exceeds `5` lines or `500` characters, split it into focused paragraphs or convert enumerable facts into `<= 20`-word bullets or a uniform 2D table.

## 4. Heading Rules

Every `##`, `###`, and `####` heading on `docs/**/*.md` (excluding `docs/README.md`) must obey:

1. **Standard headings**: At most **4 words** and at most **32 characters** (`<= 4` words, `<= 32` chars).
2. **Procedural step headings (`Step N: <Action>`)**: Match `^Step [0-9]+: <Action>$` with at most **4 words after the colon** and at most **38 total characters** (`<= 38` chars total). Capitalize the first word after the colon and use sentence case for the rest (for example, `## Step 1: Generate draft configs`).
3. **Zero articles and zero interrogatives**: Never use articles (`a`, `an`, `the`) in `##` / `###` / `####` section headings across `docs/**/*.md` (excluding `docs/README.md`), and never use interrogative words (`what`, `where`, `when`, `how`, `which`, `why`, `who`, `whose`, or `whom`, case-insensitive) in any heading across `README.md` or `docs/**/*.md`. Keep headings abstract, concise, and immediately scannable.
4. **Canonical section names and `## <Kind>` resource headings**: Prefer consistent, short section headings (`Overview`, `Prerequisites`, `Verification`, `Troubleshooting`, `Limitations`, `Decision`, `Context`, `Consequences`), and name complete configuration YAML sections directly after their resource `kind` (`## Taskpack`, `## TaskContract`, `## TrustedRegistry`, `## ControllerConfig`, `## DecisionPolicy`, `## GitHubAppConfig`).

## 5. Table Header & Cell Rules

Markdown tables present two-dimensional comparisons, field references, and failure matrices. Every table in `docs/**/*.md` must obey:

1. **Header word and character cap**: Every column header cell must contain **1 to 3 words** and at most **24 characters** (`1–3` words, `<= 24` chars) after stripping inline code backticks or links.
2. **Banned header words**: Column headers must never contain:
   - Articles: `a`, `an`, `the`
   - Demonstratives: `this`, `that`, `these`, `those`
   - Interrogatives: `what`, `where`, `when`, `how`, `which`, `why`, `who`, `whose`, `whom`
3. **Uniform column counts**: The separator row (`| --- | --- |`) and every body row in a table must have the exact same number of columns as the header row.
4. **Cell length cap**: Every table cell must be at most **180 characters** (`<= 180` chars). Keep cells scannable; move multi-sentence explanations out of table cells.
5. **Compatibility with `docs/README.md`**: In `docs/README.md`, keep `| Specification | Scope |` under `## Specs` and `| Page | Description |` under `## All pages`.

## 6. Pretty YAML & Kubernetes-Aligned Envelope Rules

YAML is Loopwright's primary human configuration format across all operator and contributor surfaces:

- `controller.draft.yaml` (`kind: ControllerConfig` — `apiVersion`, `kind`, `spec` only)
- `registry.draft.yaml` (`kind: TrustedRegistry` — referenced by `ControllerConfig.spec.registry.name`, requires `metadata.name`)
- `.loopwright/taskpack.yaml` (`kind: Taskpack` — multi-instance repository manifest, requires `metadata.name`)
- `github-app.yaml` (`kind: GitHubAppConfig` — `apiVersion`, `kind`, `spec` only)
- `decisions.yaml` (`kind: DecisionPolicy` — `apiVersion`, `kind`, `spec` only)
- `examples/task.yaml` (`kind: TaskContract` — standalone or embedded at `ControllerConfig.spec.task`, `apiVersion`, `kind`, `spec` only)
- Consumer GitHub Action workflow files (`.github/workflows/*.yml` in consumer repositories)

Every ```` ```yaml ```` or ```` ```yml ```` fenced block in `README.md`, `docs/**/*.md`, and `examples/*.md` must obey:

1. **Kubernetes-aligned top-level header envelope (zero bare `spec:` fragments, strict per-`kind` `metadata` rule)**: Every YAML block must declare its complete document header so readers always know which `kind` or workflow owns the fields:
   - **Multi-instance / cross-referenced Loopwright objects (`Taskpack`, `TrustedRegistry`)**: Always include top-level `apiVersion`, `kind`, `metadata: { name: <slug> }`, and `spec`. Following Kubernetes conventions, `metadata` contains `name` **only** (`[a-z0-9]` slug) — never `metadata.id` and never `metadata.version`.
   - **One-off Loopwright configurations (`ControllerConfig`, `TaskContract`, `GitHubAppConfig`, `DecisionPolicy`)**: Always include top-level `apiVersion`, `kind`, and `spec` only. Even when illustrating a focused subsection (such as `spec.sandbox` or `spec.decisions`), include the owning `apiVersion` and `kind` (plus `metadata.name` when the owning kind is `Taskpack` or `TrustedRegistry`) and note omitted sibling sections with an inline `#` comment inside `spec:`. Never write awkward `"no metadata"` / `"without metadata"` phrasing in prose, YAML comments, or diagrams.
   - **GitHub Actions workflows**: Always include top-level `name`, `on`, and `jobs` (never a bare `- uses:` step list without its enclosing workflow header).
2. **Two-space indentation**: Use 2 spaces per indentation level. Never use tab characters (`\t`) inside YAML blocks.
3. **No embedded multi-line JSON blobs**: Never embed multi-line JSON objects inside YAML block scalars (`config: |\n  { ... }`). Express structured configuration natively in YAML mappings and sequences (`examples/controller.md` must also contain zero ```` ```json ```` configuration blocks).
4. **`Optional`-only inline `#` comments, Hugo Chroma comment safety, and `<hash>` placeholders**: Show every top-level and nested schema key in the Macro YAML block. Annotate **only `Optional` fields** in `#` comments (never add noisy `# Required` or `# Conditional` comments — unmarked keys are required), never put `: ` (colon + space) inside an inline `#` comment (and use double quotes `"..."` for string scalars containing `: `) so Hugo's Chroma YAML lexer renders all comments in uniform gray, and write `hex: <hash>` (`imageDigest: sha256:<hash>`) instead of 64-character dummy hashes. Follow with domain-grouped 2D tables of every valid enum choice.
5. **Secret safety**: Reference credentials exclusively via environment variable names or `${ENV_VAR}` placeholders (`webhookSecretEnv: LOOPWRIGHT_WEBHOOK_SECRET`, `template: ${PROVIDER_TOKEN}`). Never include live tokens, private keys, or unredacted secrets.
6. **Strict YAML 1.2 core schema compatibility**: Do not use YAML anchors (`&`), aliases (`*`), merge keys (`<<:`), custom tags (`!`), or duplicate keys, because Loopwright's configuration loaders reject them fail-closed.

## 7. `gpustack`-Style Blueprint SVG Diagrams & Hidden Mermaid Parity

Visual diagrams clarify multi-stage execution, configuration containment/cross-reference relationships, admission fences, sandbox isolation, and GitHub App/Action control flows:

1. **Location, generator & embedding**: Maintain diagram definitions in `scripts/generate-diagrams.mjs`, emit SVG files to `docs/assets/diagrams/*.svg` (copying `architecture-flow.svg` to `site/assets/images/architecture-flow.svg`), and embed them with standard Markdown image syntax (`![Diagram description](../../assets/diagrams/architecture-flow.svg)`).
2. **`gpustack` Blueprint engineering-grid aesthetic & Loopwright brand palette**:
   - **Canvas & Grid**: Use a `1200`-px wide `viewBox` (`0 0 1200 <height>`) with a `rx="20"` outer frame (`class="canvas"`) and a `40x40` `<pattern id="grid">` engineering grid overlay.
   - **Adaptive Light / Dark CSS Variables**: Declare `color-scheme: light dark;` with `@media (prefers-color-scheme: dark)` overrides and preserve Loopwright's three signature hues across strokes, left-accent bars, and badges:
     - **Indigo-Violet**: `#5B4B9E` (primary control plane, admission, contracts)
     - **Teal-Cyan**: `#3B8EA5` (isolated runtime, sandboxes, decision routing)
     - **Warm Amber-Gold**: `#D89B48` (verification gates, receipts, publication, memory)
   - **Header & Brand Logo Badge**: Include an uppercase `.kicker` (`LOOPWRIGHT / ...`), bold `29px` `.title`, `.sub` subtitle, and embed the original Loopwright logo (`docs/assets/logo.png` via `<symbol id="lw-logo">`) in both the top-right header badge and any middle control-plane hub badge (never a placeholder `L` circle).
   - **Hierarchical Containers, Concise `<= 10`-Word Cards, Animated Wires & Takeaway Pills**: Group trust or lifecycle zones in `.box` / `.tint` containers, style individual nodes as cards with `4px` rounded left-accent bars and vector icons, connect stages or cross-references with dashed `.wire` paths and `<circle class="dot"><animateMotion .../></circle>` (`@media (prefers-reduced-motion: reduce) { .dot { display: none; } }`), and finish with 3 bottom emerald bullseye takeaway pills.
   - **Strict SVG Card Text Hygiene (`<= 10` words, zero code punctuation)**: Every SVG card must contain **at most 10 words** in crisp, plain-English concepts — **zero `[]` or `{}`** array/object syntax, **zero `camelCase` or `snake_case`** field identifiers (`handlers[]`, `roleProfiles`, `envBindings`, `wallTimeMs`), and zero CLI `--flags`.
3. **Readability bounds**: Include an explicit `viewBox`, keep stages scannable with generous padding, and keep body/mono label font sizes readable (`>= 11px` mono metadata, `>= 12px` labels).
4. **Hidden Mermaid comment parity**: Immediately below every SVG image embed, include a hidden HTML comment containing the matching `flowchart LR` or `flowchart TD` graph using `->` and `..>` instead of `-->` and `-.->` (since `-->` closes an HTML comment early):

```markdown
![Loopwright four-stage execution flow](../../assets/diagrams/architecture-flow.svg)

<!--
flowchart LR
  Admit[1. Admit & Fence] -> Execute[2. Isolated Pi & Router]
  Execute -> Verify[3. Independent Gate Verify]
  Verify -> Publish[4. Publish & CAS Memory]
-->
```

## 8. Raw HTML & Link Discipline

- **Raw HTML ban in prose**: Outside fenced code blocks and HTML comments, the only permitted raw HTML tag in `docs/**/*.md` is an attribute-free `<br>` or `<br/>`.
- **Relative links**: Use relative repository paths (`../operations/cli.md`, `./task-contract.md#schema-bounds`) for internal links so both repository readers and `scripts/site.mjs` resolve them deterministically.
- **Public vs. Contributor link boundary**: The 12 public pages published to `site/` must never link to `docs/development.md` or `docs/contribute/**`.
