# Documentation Conventions — Three-Zone Governance, Human-First Decomposition, Strict Pretty YAML, and Writing Rules

Every file under `docs/`, `README.md`, and `examples/*.md` is written for human engineers and repository operators first, routed cleanly across Loopwright's three documentation zones, and checked deterministically by `scripts/check-docs.mjs` and `scripts/site.mjs`.

## 1. Three-Zone Architecture & Human-First Decomposition

Loopwright splits `docs/` (`34` Markdown files: `docs/README.md` shared index + `33` zone pages) into three strict zones:

| Zone | Source Paths | Human Site (HTML / Sidebar / `index.json` / `sitemap.xml`) | `/llms.txt` Surface | Outbound Link Policy |
| --- | --- | --- | --- | --- |
| **Public Human Site** (`15` pages) | `docs/{getting-started,operations,walkthroughs,configuration}/*.md` | **Included** (`site/data/navigation.yaml`, `site/content/docs/_index.md`, `site/layouts/index.html`) | Topic `##` sections → `/docs/<group>/<slug>/index.md` | Public pages, `docs/assets/`, non-`docs/` repo files. **Never** `development.md`, `contribute/**`, or `references/**`. |
| **Flat LLM Reference** (`6` flat files) | `docs/references/*.md` (0 subdirectories) | **Excluded** (0 HTML, sidebar, `index.json`, or `sitemap.xml` entries) | `## Reference` → static `/references/<file>.md` (links rewritten before Hugo runs) | Sibling `references/*.md`, public pages, `docs/assets/`, repo & `Contribute` paths (rewritten to GitHub `blob/<sourceRef>`). |
| **Repo-Only `Contribute`** (`12` pages) | `docs/development.md`, `docs/contribute/**/*.md` | **Excluded** (0 HTML, sidebar, `index.json`, or `sitemap.xml` entries) | `## Optional` → GitHub `blob/<sourceRef>/docs/...` | Any repository path. |

Never dump dense implementation prose, raw TypeScript interfaces, or unannotated JSON schemas onto a human reader. Decompose every public concept, subsystem, or operational workflow into four progressive layers, and route exhaustive machine lookup tables to `docs/references/*.md`:

1. **Mental model (1–3 short sentences)**: State what the component or workflow does, what boundary it enforces, and when an operator uses it.
2. **Visual flow or lifecycle table**:
   - For 3 or more interacting stages or components, embed a committed SVG diagram (`docs/assets/diagrams/*.svg`) paired with a hidden `<!-- flowchart ... -->` comment immediately below.
   - For two-dimensional comparisons (modes, sandbox backends, error codes, failure outcomes), present a uniform 2D Markdown table.
3. **Macro view (Annotated Block-Style Pretty YAML)**: Show a copy-pasteable two-space block-style Pretty YAML configuration or manifest (`apiVersion`, `kind`, `metadata.name` when applicable, `spec`) with inline `#` comments marking `Optional` fields, defaults, and security constraints.
4. **Micro view (Constraint bullets + Focused domain tables)**: Beneath the Macro YAML block, list essential field rules as short bullets (`- **<Field>**: <Constraint in <= 20 words>.`) and group core enum choices in 2D Markdown tables (`### <Domain>`). Offload exhaustive field-by-field bound matrices, 44-input / 23-subcommand flag encyclopedias, and verbatim protocol scripts to `docs/references/*.md`. Never merge values from unrelated YAML fields or domains into a single generic `Value | Meaning | Constraints` table.

## 2. Sentence Discipline (80% ASD-STE100), Shared Glossary, and Plurality Rules

Apply controlled-English discipline across `README.md`, `docs/**/*.md`, and `examples/*.md`:

- **Sentence length bounds**:
  - **Procedural sentences**: `<= 20` words per sentence. One action per step.
  - **Conceptual / descriptive sentences**: `<= 25` words per sentence. One claim per sentence.
- **Active voice**: Name the actor and verb directly.
  - Write: `The controller rejects stale lease tokens before verification.`
  - Do not write: `Stale lease tokens are rejected by the controller prior to verification being executed.`
- **Imperative procedures**: Address operator actions with direct imperative verbs (`Create`, `Validate`, `Inspect`, `Run`). Number dependent steps as `Step N: <Action>`.
- **Zero self-referential page narration**: Never write `This page describes`, `This document describes`, `This section covers`, or `In this guide we will`. State the technical fact or operator instruction directly.

### Shared Glossary

Use one canonical name for each domain concept and avoid mechanical slang (`wiring`, `plumbing`, `knob`, `arm/leg`):

| Concept | Canonical Term | Avoid |
| --- | --- | --- |
| Work specification document | `task contract` (`TaskContract`) | job spec, task payload, work item |
| Monotonic SQLite admission lock | `lease fence` | lock token, session lock, DB mutex |
| Monotonic wall/monotonic time guard | `monotonic clock guard` | clock check, time skew guard |
| Cryptographic verification receipt token | `gate token` (`gate.v1`) | check signature, verification hash |
| Repository automation manifest | `taskpack` (`.loopwright/taskpack.yaml`, `Taskpack`) | repo workflow, automation config |
| Multi-domain suite manifest | `taskpack suite` (`.loopwright/suite.yaml`, `TaskpackSuite`) | multi-pack config, domain bundle |
| Out-of-repo approved handler catalog | `trusted registry` (`TrustedRegistry`) | plugin list, handler config |
| Bounded island optimization manifest | `evolution campaign` (`campaign.yaml`, `EvolutionCampaign`) | search job, genetic config |
| Calibrated System-One triage node | `decision router` (`@loopwright/decisions`, `DecisionPolicy`) | AI classifier, fast model router |
| Reviewed content-addressed memory | `reviewed memory` (`@loopwright/memory`) | agent memory, vector store |
| Qualification and failure ledger | `closure matrix` (`loopwright closure`) | readiness table, feature matrix |
| Uncertain external side effect | `unknown outcome` (`unknown`) | ambiguous failure, partial error |

### Menu, Sidebar, and Heading Plurality Rules

1. **Collections use plural nouns**: `Walkthroughs`, `Operations`, `Sandbox Backends` (collection of OS/container backends), `Coding Agents` (collection of external host agents).
2. **One capability, workflow, or resource kind uses a singular noun**: `Architecture`, `Installation`, `GitHub Action`, `GitHub App`, `CLI`, `Declarative Taskpack`, `Managed Controller`, `Evolutionary Campaign`, `Taskpack`, `Task Contract`, `Controller and Registry`, `Decision Routing`, `Evolution Campaign`.
3. **Siblings of one type share the same grammatical number**: Every workflow walkthrough under `Walkthroughs` is singular (`Declarative Taskpack`, `Managed Controller`, `Evolutionary Campaign` — never mixing singular siblings with plural `Evolutionary Campaigns`).

### Checked Kind-Plural Rules in Authored Prose

In authored prose across `docs/**/*.md` (including paragraphs, list items, headings, and table cells), keep the **singular PascalCase resource `kind` inside backticks** and place the plural `s` or an explicit plural noun outside. `scripts/check-docs.mjs` (`checkKindPlurals`) enforces this deterministically:

| Pattern | Kinds | Correct | Never Write (CI Fail) |
| --- | --- | --- | --- |
| **Regular kinds** | `Taskpack`, `TaskpackSuite`, `TaskContract`, `ControllerConfig`, `GitHubAppConfig`, `EvolutionCampaign`, `AttemptReceipt`, `VerificationProfile` | `` `Taskpack`s ``, `` `TaskpackSuite`s ``, `` `TaskContract`s ``, `` `ControllerConfig`s ``, `` `GitHubAppConfig`s ``, `` `EvolutionCampaign`s ``, `` `AttemptReceipt`s ``, `` `VerificationProfile`s `` | `` `Taskpacks` ``, `` `TaskpackSuites` ``, `` `TaskContracts` ``, `` `ControllerConfigs` ``, `` `GitHubAppConfigs` ``, `` `EvolutionCampaigns` ``, `` `AttemptReceipts` ``, `` `VerificationProfiles` `` |
| **Irregular `-y` kinds** | `TrustedRegistry`, `DecisionPolicy` | `` `TrustedRegistry` objects ``, `` `DecisionPolicy` objects `` (or `manifests` / `files`) | `` `TrustedRegistries` ``, `` `TrustedRegistry`s ``, `` `DecisionPolicies` ``, `` `DecisionPolicy`s `` |

- **Explicit Kind-Plural Exemptions**: Fenced code blocks, 4-space/tab indented code blocks, HTML comments, CLI commands/flags (`--taskpacks`, `loopwright ...`), file/API paths (`packages/taskpack/...`), and YAML/property expressions (`spec.domains`) retain literal spelling.
- **Count nouns & units**: Match noun and verb to number (`1 island`, `2 islands`), keep units singular (`4 MiB`, `5000 ms`), and form abbreviation plurals with plain `s` (`GPUs`, `NPUs`, `PRs`, never `GPU's`).

### Banned AI Filler Phrases

`scripts/check-docs.mjs` rejects the following case-insensitively in `docs/**/*.md` prose:
`seamlessly`, `delve`, `tapestry`, `leverage`, `utilize`, `cutting-edge`, `empower`, `it is worth noting`, `in order to`, `this page describes`, `this document describes`, `comprehensive guide`. Also avoid figurative puffery (`robust`, `streamline`, `unlock`, `pivotal`, `crucial`) unless naming a literal identifier.

## 3. Page Shape, Flat Reference Contract, and Reading Footers

### Public (`15` Pages) & Contribute (`12` Pages) Shape

Every public and contributor page under `docs/**/*.md` follows this structure:

```markdown
# <Exact Page Title Matching docs/README.md Zone Table>

Short introductory paragraph (1 to 3 paragraphs, each <= 5 lines and <= 500 characters)
stating the component role, safety boundary, and operator entry point.

## Contents

- [Overview](#overview)
- [Taskpack](#taskpack)
- [Step 1: Generate draft files](#step-1-generate-draft-files)
- [Verification](#verification)

## Overview
...

---

**See also** — [Controller and Registry](../configuration/controller-and-registry.md) (draft configuration and handler digests) · [Sandbox Backends](../configuration/sandbox-backends.md) (native OS and container isolation)

**Next** → [Declarative Taskpack](../walkthroughs/declarative-taskpack.md) — author and verify a repository taskpack end to end.
```

### Flat `docs/references/*.md` Contract (`6` Flat Files)

Every file in `docs/references/` must be flat (zero nested subdirectories, zero symlinks) and obey:

1. **Opening `Evidence:` label line**: Declare `Evidence: contract.`, `Evidence: recorded capture.`, or `Evidence: synthetic simulation.` before the first `## ` heading.
2. **Hub vs. topic `## Contents`**: Topic files (`bootstrap-interview.md`, `taskpack-and-contract-schema.md`, `controller-and-registry-schema.md`, `cli-and-action-reference.md`, `coding-agent-protocol.md`) include synchronized `## Contents`; `docs/references/README.md` (`# Reference Hub`) is exempt from `## Contents` and must link every sibling `docs/references/*.md`.
3. **Reference reading footer (`**See also**` only, zero `**Next**`)**: Every `docs/references/*.md` file must end with `\n---\n\n**See also** — [Title](target.md) (description) · ...` and is **strictly forbidden** from including `**Next**`.

### 1:1:1 Group Directory, Filename Slug, Sidebar Label, and `# H1` Title Rule

Every public documentation page (all `15` pages published to `site/`) must obey strict **1:1:1 alignment**:

1. **Group directory matches navigation group**:
   - `Getting Started` → `docs/getting-started/`
   - `Operations` → `docs/operations/`
   - `Walkthroughs` → `docs/walkthroughs/`
   - `Configuration` → `docs/configuration/`
2. **Filename matches `# H1` slug**: `path.basename(file, '.md') === slugify(h1Title)` (e.g., `# Evolutionary Campaign` → `docs/walkthroughs/evolutionary-campaign.md`, `# Evolution Campaign` → `docs/configuration/evolution-campaign.md`).
3. **Exact label & index parity across all surfaces**: `site/data/navigation.yaml` `labels["/docs/<group>/<slug>/"]` === page `# H1` title === `docs/README.md` `## All pages` link label, and all `15` routes must be linked in both `site/content/docs/_index.md` and `site/layouts/index.html`.

### Enforced Page Shape Caps

| Rule | Limit | Scope |
| --- | --- | --- |
| Zone registration & `# H1` parity | Exact `# H1` match in `docs/README.md` (`## All pages` `15`, `## Reference` `6`, `## Contribute` `12`) | All `33` non-index `docs/**/*.md` pages |
| Heading depth ceiling | Hard **`H1`–`H3` max** (`####`, `#####`, `######` forbidden) | All `34` `docs/**/*.md` files |
| `##` section count | **`<= 8`** on public pages; **`<= 10`** on `Contribute` pages (excluding `## Contents`) | `15` Public + `12` `Contribute` pages (`docs/README.md` & `docs/references/*` exempt) |
| Intro & `## Contents` | 1–3 intro paragraphs + exact `## Contents` sync | All non-index `docs/**/*.md` except `docs/references/README.md` |
| Prose paragraph size | `<= 5` lines and `<= 500` characters | All `docs/**/*.md` pages (excluding trailing `\n---\n` footer) |
| Architecture line budget | `<= 200` lines | `docs/getting-started/architecture.md` |
| ADR line budget | `<= 220` lines | `docs/contribute/adr/*.md` |
| Reference line backstop | `<= 800` lines | `docs/references/*.md` |
| Standard page line budget | `<= 400` lines | All other non-index `docs/**/*.md` pages (`14` Public + `10` `Contribute`) |
| Reading footer | `\n---\n\n**See also** — [Title](path) (desc)` required; `**Next** →` required on `15` public pages and **forbidden** on `docs/references/*.md` | All `33` non-index `docs/**/*.md` pages |
| One-way public link isolation | `0` links to `development.md`, `contribute/**`, or `references/**` | All `15` public `docs/` pages + `site/content/**` |

### Prose Paragraph Measurement Rules

`scripts/check-docs.mjs` strips the trailing `\n---\n` reading footer block first, then measures contiguous prose paragraphs outside fenced code blocks, HTML comments, Markdown tables (`|`), blockquotes (`>`), list items (`- `, `* `, `+ `, `1. `), headings (`#`–`###`), standalone images (`![...](...)`), and footer lines (`**See also**`, `**Next**`). Split any paragraph over `5` lines or `500` characters into focused paragraphs, `<= 20`-word bullets, or a uniform 2D table.

## 4. Heading Rules (`H1`–`H3` Ceiling & Zero Container Nouns)

Every heading across `docs/**/*.md` must obey:

1. **Hard `H1`–`H3` depth ceiling**: `H4`, `H5`, and `H6` (`####`, `#####`, `######`, including blockquoted `> ####`) are forbidden across all `docs/**/*.md` files. Express sub-items under `###` using bold lead-in bullets (`- **<Item>**: ...`) or 2D tables.
2. **Standard `##` and `###` headings**: At most **4 words** and at most **32 characters** (`<= 4` words, `<= 32` chars) on non-index pages.
3. **Procedural step headings (`Step N: <Action>`)**: Match `^Step [0-9]+: <Action>$` with at most **4 words after the colon** and at most **38 total characters** (`<= 38` chars total). Capitalize the first word after the colon and use sentence case for the rest (`## Step 1: Generate draft configs`).
4. **Zero articles, zero interrogatives, and zero layout-container nouns**:
   - Omit articles (`a`, `an`, `the`) in `##` and `###` headings across non-index `docs/**/*.md`.
   - Never use interrogative words (`what`, `where`, `when`, `how`, `which`, `why`, `who`, `whose`, `whom`) in any heading across `README.md` or `docs/**/*.md`.
   - Never use layout-container nouns (`row`, `rows`, `table`, `tables`, `column`, `columns`, `guide`, `guides`, `entries`, `section`, `sections`) in headings across non-index `docs/**/*.md`. Name the domain concept directly (`## Memory records` instead of `## Entries`; `## Installation surfaces` instead of `## Guide table`).
5. **Canonical section names and `## <Kind>` resource headings**: Prefer short section names (`Overview`, `Prerequisites`, `Verification`, `Troubleshooting`, `Limitations`, `Decision`, `Context`, `Consequences`), and name complete configuration YAML sections directly after their resource `kind` (`## Taskpack`, `## TaskpackSuite`, `## TaskContract`, `## TrustedRegistry`, `## ControllerConfig`, `## DecisionPolicy`, `## GitHubAppConfig`, `## EvolutionCampaign`).

## 5. Table Header & Cell Rules

Every Markdown table in `docs/**/*.md` must obey:

1. **Header word and character cap**: Every column header cell must contain **1 to 3 words** and at most **24 characters** (`1–3` words, `<= 24` chars) after stripping inline formatting.
2. **Banned header words**: Column headers must never contain articles (`a`, `an`, `the`), demonstratives (`this`, `that`, `these`, `those`), or interrogatives (`what`, `where`, `when`, `how`, `which`, `why`, `who`, `whose`, `whom`).
3. **Uniform column counts**: Separator (`| --- | --- |`) and body rows must match the header column count.
4. **Cell length cap**: Every table cell must be at most **180 characters** (`<= 180` chars).
5. **Three-zone tables in `docs/README.md`**: Keep `| Specification | Scope |` under `## Specs` and `| Page | Description |` under top-level `## All pages`, `## Reference`, and `## Contribute` (never nest `### Contribute` or `### Reference` inside `## All pages`).

## 6. Strict Pretty Block-Style YAML & Kubernetes-Aligned Envelope Rules

YAML is Loopwright's human configuration format across all operator and contributor surfaces:

- `.loopwright/taskpack.yaml` (`kind: Taskpack` — requires `metadata.name`)
- `.loopwright/suite.yaml` (`kind: TaskpackSuite` — requires `metadata.name`)
- `registry.draft.yaml` (`kind: TrustedRegistry` — referenced by `ControllerConfig.spec.registry.name`, requires `metadata.name`)
- `campaign.yaml` (`kind: EvolutionCampaign` — requires `metadata.name`)
- `controller.draft.yaml` (`kind: ControllerConfig` — `apiVersion`, `kind`, `spec` only)
- `examples/task.yaml` (`kind: TaskContract` — `apiVersion`, `kind`, `spec` only)
- `github-app.yaml` (`kind: GitHubAppConfig` — `apiVersion`, `kind`, `spec` only)
- `decisions.yaml` (`kind: DecisionPolicy` — `apiVersion`, `kind`, `spec` only)
- `VerificationProfile` & `AttemptReceipt` (`apiVersion`, `kind`, `spec` only)
- Consumer GitHub Actions workflow files (`.github/workflows/*.yml` — `name`, `on`, `jobs`)

Every ```` ```yaml ```` or ```` ```yml ```` fenced block in `README.md`, `docs/**/*.md`, and `examples/*.md` is parsed via `parseDocument(..., { version: "1.2", schema: "core", uniqueKeys: true })` in `scripts/check-docs.mjs` (`checkPrettyYamlBlocks`) and must obey:

1. **Strict Multi-Line 2-Space Block Style (Zero Non-Empty Flow Syntax)**:
   - **Forbidden**: Any non-empty flow mapping (`{ key: value }`, `- { id: a, kind: agent }`) or non-empty flow sequence (`[read, write]`, `[{ id: a }]`).
   - **Allowed**: Only explicit empty mappings (`{}`) and explicit empty sequences (`[]`), such as `spec: {}`, `parameters: {}`, or `externalGates: []`.
   - **Never game line caps with flow YAML**: Never compress block mappings or sequences onto single flow lines to squeeze under the `400`-line page cap. Instead, trim non-essential duplicate subfields from walkthroughs/overviews and route exhaustive schema dictionaries to `docs/references/*.md`, keeping every YAML example strictly 2-space block-style Pretty YAML.

   **Bad (rejected by `check-docs.mjs`)**:

   ```text
   apiVersion: loopwright.dev/v1alpha1
   kind: Taskpack
   metadata: { name: docs-sync }
   spec:
     digest: { algorithm: sha256, hex: <hash> }
     tools: [read, write]
     steps: [{ id: author, kind: agent }]
   ```

   **Good (strict 2-space block-style Pretty YAML)**:

   ```yaml
   apiVersion: loopwright.dev/v1alpha1
   kind: Taskpack
   metadata:
     name: docs-sync
   spec:
     digest:
       algorithm: sha256
       hex: <hash>
     tools:
       - read
       - write
     steps:
       - id: author
         kind: agent
     externalGates: []
   ```

2. **Kubernetes-aligned top-level header envelope (zero bare `spec:` fragments, strict per-`kind` `metadata` rule)**:
   - **Named multi-instance / cross-referenced objects (`Taskpack`, `TaskpackSuite`, `TrustedRegistry`, `EvolutionCampaign`)**: Always include top-level `apiVersion`, `kind`, 2-space block `metadata` with `name: <slug>` **only** (never `metadata.id` or `metadata.version`), and `spec`.
   - **One-off / standalone objects (`ControllerConfig`, `TaskContract`, `GitHubAppConfig`, `DecisionPolicy`, `VerificationProfile`, `AttemptReceipt`)**: Always include top-level `apiVersion`, `kind`, and `spec` only. Never write awkward `"no metadata"` / `"without metadata"` phrasing in prose, YAML comments, or diagrams.
   - **GitHub Actions workflows**: Always include top-level `name`, `on`, and `jobs`.
3. **Two-space indentation & no embedded JSON blobs**: Use 2 spaces per indentation level (zero `\t` tabs), and never embed multi-line JSON objects inside YAML block scalars (`config: |\n  { ... }`). `examples/controller.md` must also contain zero ```` ```json ```` configuration blocks.
4. **`Optional`-only inline `#` comments, Hugo Chroma comment safety, and `<hash>` placeholders**: Annotate **only `Optional` fields** in `#` comments (omit `# Required` and `# Conditional`), never put `: ` (colon + space) inside an inline `#` comment (and double-quote string scalars containing `: `), and write `hex: <hash>` (`imageDigest: sha256:<hash>`) instead of 64-character dummy hashes.
5. **Secret safety & YAML 1.2 core schema**: Reference credentials only via environment variable names or `${ENV_VAR}` placeholders. Never use YAML anchors (`&`), aliases (`*`), merge keys (`<<`), custom/non-core tags (`!`), or duplicate keys.

## 7. `gpustack`-Style Blueprint SVG Diagrams & Hidden Mermaid Parity

Visual diagrams clarify multi-stage execution, configuration containment/cross-reference relationships, admission fences, sandbox isolation, and GitHub App/Action control flows:

1. **Location, generator & embedding**: Maintain diagram definitions in `scripts/generate-diagrams.mjs`, emit SVG files to `docs/assets/diagrams/*.svg` (copying `architecture-flow.svg` to `site/assets/images/architecture-flow.svg`), and embed them with standard Markdown image syntax (`![Diagram description](../assets/diagrams/architecture-flow.svg)`).
2. **`gpustack` Blueprint engineering-grid aesthetic & Loopwright brand palette**:
   - **Canvas & Grid**: `1200`-px wide `viewBox` (`0 0 1200 <height>`) with `rx="20"` outer frame and `40x40` `<pattern id="grid">` engineering grid overlay.
   - **Adaptive Light / Dark CSS Variables**: Declare `color-scheme: light dark;` with `@media (prefers-color-scheme: dark)` overrides and preserve Loopwright's three signature hues:
     - **Indigo-Violet**: `#5B4B9E` (primary control plane, admission, contracts)
     - **Teal-Cyan**: `#3B8EA5` (isolated runtime, sandboxes, decision routing)
     - **Warm Amber-Gold**: `#D89B48` (verification gates, receipts, publication, memory)
   - **Header & Brand Logo Badge**: Embed the original Loopwright logo (`docs/assets/logo.png` via `<symbol id="lw-logo">`) in header and middle control-plane hub badges.
   - **Strict SVG Card Text Hygiene (`<= 10` words, zero code punctuation)**: Every SVG card must contain **at most 10 words** in plain English — **zero `[]` or `{}`** array/object syntax, **zero `camelCase` or `snake_case`** field identifiers, and zero CLI `--flags`.
3. **Hidden Mermaid comment parity**: Immediately below every SVG image embed, include a hidden HTML comment containing the matching `flowchart LR` or `flowchart TD` graph using `->` and `..>` instead of `-->` and `-.->` (since `-->` closes an HTML comment early).

## 8. Raw HTML & One-Way Public Link Isolation

- **Raw HTML ban in prose**: Outside fenced code blocks and HTML comments, the only permitted raw HTML tag in `docs/**/*.md` is an attribute-free `<br>` or `<br/>`.
- **Relative links**: Use relative repository paths (`../operations/cli.md`, `./task-contract.md#schema-bounds`) for internal links so repository readers, `scripts/check-docs.mjs`, and `scripts/site.mjs` (`stageReferenceDocs()` and Hugo render hooks) resolve them deterministically.
- **One-way public link isolation**: Links may point **into** the 15 public pages from `docs/references/*.md` and `docs/contribute/**`, **never** outward from the 15 public `docs/` pages or `site/content/**` into `development.md`, `contribute/**`, or `references/**` — across relative paths, root-relative paths (`/references/...`, `/docs/references/...`, `/docs/contribute/...`, `/docs/development/...`), and same-origin (`gpustack.github.io/loopwright/...`, `docs.gpustack.ai/loopwright/...`) or GitHub blob URLs. Literal URLs inside fenced code blocks (such as copy-paste `llms.txt` bootstrap prompts) are permitted.
