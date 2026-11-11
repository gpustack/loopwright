# AGENTS.md, Repository Skills, OpenCodeReview Rules, Connected User Documentation, and Hugo Site

- **Status**: Shipped
- **Date**: 2026-11-11
- **Owners**: `@loopwright/cli`, `docs/`, `site/`, `.agents/skills/`, `.opencodereview/`

## Motivation

Loopwright provides a complete nine-package TypeScript harness (`@loopwright/core`, `@loopwright/state`, `@loopwright/agent-pi`, `@loopwright/controller`, `@loopwright/taskpack-runner`, `@loopwright/memory`, `@loopwright/decisions`, `@loopwright/github-app`, and `@loopwright/cli`) plus a reusable GitHub Action entrypoint (`action.yml`). While individual package reference files exist under `docs/`, the repository currently lacks:

1. **Contributor and Agent Operating Infrastructure (`AGENTS.md`, `.agents/skills/*`, `.opencodereview/rule.json`)**:
   - A root `AGENTS.md` describing the monorepo layout, end-to-end execution and verification chain, module-map source routing, verification gates, and TypeScript/security/testing conventions.
   - Five repository-local skills under `.agents/skills/` (symlinked from `.claude/skills`): `loopwright-overview`, `loopwright-docs`, `loopwright-code-review`, `loopwright-issue-pr`, and `loopwright-release`.
   - Path-scoped automated pull-request review rules in `.opencodereview/rule.json` enforcing Loopwright's layer boundaries, contract compatibility, redaction/containment invariants, and documentation contract.
2. **Connected End-to-End Documentation (`README.md` and `docs/`)**:
   - A unified documentation index (`docs/README.md`) with reading paths, a structured `## Module map` (`ID`, `Use for`, `Aliases`, `Guides`, `Specs`, `Code`, `Related`, `Skills`), a `## Specs` table, and a complete `## All pages` table.
   - A concise (`<= 200` lines) front-door architecture overview (`docs/getting-started/architecture.md`) paired with an SVG architecture diagram (`docs/assets/diagrams/architecture-flow.svg`) and a hidden Mermaid flowgraph comment.
   - Dedicated operational runbooks explaining how to configure the **Loopwright GitHub Action** (`docs/operate/github-action.md`), how to configure and deploy the **Loopwright GitHub App** (`docs/operate/github-app.md`), how to operate the **Loopwright CLI** (`docs/operate/cli.md`), how to author a declarative `.loopwright/taskpack.yaml` end to end (`docs/walkthroughs/declarative-taskpack.md`), and how workspace internals and ADRs fit together (`docs/contribute/internals.md`).
   - Harmonized page shapes across all 21 `docs/` pages (`# Title`, short introductory paragraph, `## Contents` mirroring `##` headings, and a `**See also**` / `**Next**` footer).
3. **Hugo Documentation Site (`site/`) and Automated Documentation Gate (`npm run lint:docs` / `npm run site`)**:
   - A Hugo site (`site/hugo.toml`, `site/data/navigation.yaml`, `site/content/`, `site/layouts/`, `site/assets/`) that mounts `../docs` into `content/docs` and renders static HTML, a client-side search index (`/index.json`), an LLM documentation index (`/llms.txt` derived from `docs/README.md` `## All pages`), per-page Markdown exports (`/docs/.../index.md`), and version metadata (`/site-version.json`).
   - Deterministic Node.js verification and build scripts (`scripts/check-docs.mjs` and `scripts/site.mjs`) wired to `npm run lint:docs`, `npm run site`, and `npm run site:serve`.

## Goals

1. Author root `AGENTS.md`, `.opencodereview/rule.json`, and five repository skills under `.agents/skills/loopwright-{overview,docs,code-review,issue-pr,release}/SKILL.md` (with `.claude/skills -> ../.agents/skills` symlink).
2. Author connected user documentation across `README.md`, `docs/README.md`, `docs/getting-started/architecture.md` (+ `docs/assets/diagrams/architecture-flow.svg`), `docs/operate/{github-action,github-app,cli}.md`, `docs/walkthroughs/declarative-taskpack.md`, `docs/contribute/internals.md`, and harmonize all 15 existing `docs/*.md` and `docs/adr/*.md` pages to the uniform page contract without breaking any path pinned by `CLOSURE_CAPABILITY_LEDGER`.
3. Build the Hugo documentation site under `site/` (`hugo.toml`, `data/navigation.yaml`, `content/`, `layouts/`, `assets/`) and deterministic verification/build scripts (`scripts/check-docs.mjs`, `scripts/site.mjs`) plus an offline verification test suite (`packages/cli/test/docs-and-site.test.ts`).

## Non-Goals

- Adding any `.github/workflows/` CI/CD files inside the Loopwright repository (the repository's zero-workflow invariant remains strictly enforced; GitHub Action usage examples for consumer repositories live inside fenced YAML blocks in documentation).
- Modifying runtime behavior or public TypeScript APIs in `packages/core`, `packages/state`, `packages/agent-pi`, `packages/controller`, `packages/taskpack-runner`, `packages/memory`, `packages/decisions`, or `packages/github-app`.

## User Stories

1. **As a consumer repository maintainer**, I can read `README.md`, `docs/operate/github-action.md`, `docs/operate/github-app.md`, and `docs/walkthroughs/declarative-taskpack.md` to configure `.loopwright/taskpack.yaml`, wire the Loopwright GitHub Action or GitHub App, configure optional System-One decision routing, and run `loopwright closure --verify-failures`.
2. **As a contributor or coding agent**, I can read `AGENTS.md`, load `.agents/skills/loopwright-overview/SKILL.md`, and use `docs/README.md#module-map` to jump directly to the owning guide, specification, source files, and verification commands for any subsystem.
3. **As a documentation maintainer or LLM consumer**, I can run `npm run lint:docs` and `npm run site` to validate every Markdown page shape, module-map route, relative link, HTML anchor, `/llms.txt` entry, and exported Markdown page.

## Proposed Design

### 1. Canonical 21-Page Documentation Inventory & Page Shape Contract

Every page under `docs/` (except the index `docs/README.md`) MUST follow a uniform structure:

1. **H1 Title (`# <Title>`)**: Matches its label in `docs/README.md` (`## All pages`) character for character.
2. **Introduction**: 1–3 concise paragraphs before `## Contents` stating what the page covers and its boundary.
3. **Table of Contents (`## Contents`)**: Bullet list (`- [<Heading>](#<anchor>)`) mirroring every `## ` H2 section on the page (excluding `## Contents` itself) in exact order.
4. **Body Sections (`## ...`)**: Concise headings (`<= 6` words, no interrogative words `what`, `where`, `when`, `how`, `which`, `why`, `who`, `whose`, `whom`). Ordered procedures use `Step N: <Imperative>`. Configuration blocks use annotated two-space Pretty YAML (macro view) followed by concise constraint bullets and tables (micro view).
5. **Footer**: Ends with `**See also**: ...` (required on all pages) and `**Next**: ...` (recommended wherever a natural next step exists).

The 21 canonical pages under `docs/` (excluding `docs/README.md`) are frozen as follows:

| Group | Relative Path under `docs/` | Exact H1 (`# ...`) and `All pages` Label | `site/data/navigation.yaml` Label |
| --- | --- | --- | --- |
| `Getting Started` | `getting-started/architecture.md` | `Loopwright Architecture` | `Architecture` |
| `Operations` | `operate/github-action.md` | `GitHub Action Configuration` | `GitHub Action` |
| `Operations` | `operate/github-app.md` | `GitHub App Deployment` | `GitHub App` |
| `Operations` | `operate/cli.md` | `CLI Operations` | `CLI Operations` |
| `Walkthroughs` | `walkthroughs/declarative-taskpack.md` | `Declarative Taskpack Walkthrough` | `Declarative Taskpack` |
| `Modules` | `contracts.md` | `Task Contracts and Schemas` | `Contracts` |
| `Modules` | `identity.md` | `Canonical Identity and Digests` | `Identity` |
| `Modules` | `evidence.md` | `Verification Evidence and Authority` | `Evidence` |
| `Modules` | `state.md` | `Persistent Local State Store` | `State Store` |
| `Modules` | `pi-adapter.md` | `Isolated Pi Runtime Adapter` | `Pi Adapter` |
| `Modules` | `pi-runtime-evaluation.md` | `Pi Runtime Evaluation` | `Runtime Evaluation` |
| `Modules` | `controller.md` | `Bounded Controller and Repair Loop` | `Controller` |
| `Modules` | `runner-taskpack.md` | `Runner Taskpack and Offline Parity` | `Runner Taskpack` |
| `Modules` | `memory.md` | `Reviewed Memory and CAS Compaction` | `Memory` |
| `Modules` | `github-app.md` | `GitHub App Control Plane and Taskpack Intake` | `Control Plane` |
| `Modules` | `decisions.md` | `System-One Decision Routing` | `Decision Routing` |
| `Modules` | `closure-matrix.md` | `Capability Closure Matrix and Failure Semantics` | `Closure Matrix` |
| `Contribute` | `development.md` | `Development and Verification` | `Development` |
| `Contribute` | `contribute/internals.md` | `Workspace Internals and Boundaries` | `Internals` |
| `Architecture Decisions` | `adr/0001-local-state-authority.md` | `ADR 0001: Local State Authority` | `ADR 0001: Local State` |
| `Architecture Decisions` | `adr/0002-isolated-pi-sdk.md` | `ADR 0002: Isolated Pi SDK` | `ADR 0002: Isolated Pi SDK` |

### 2. Shared Index (`docs/README.md`) & Module Map

`docs/README.md` MUST contain four top-level H2 sections:
1. `## Reading paths`: Task-oriented entry points for (a) running Loopwright in GitHub Actions, (b) deploying the GitHub App control plane, (c) running the local CLI and closure audit, (d) integrating the TypeScript SDK and System-One decision router, and (e) contributing code or documentation.
2. `## Module map`: Nine `### <Module Name>` entries covering every workspace capability and shared task:
   - `### Contracts and Evidence` (`ID: contracts`)
   - `### Persistent State Store` (`ID: state`)
   - `### Isolated Pi Adapter` (`ID: pi-adapter`)
   - `### Bounded Controller and CLI` (`ID: controller`)
   - `### Declarative Taskpacks and Runner Parity` (`ID: taskpacks`)
   - `### Reviewed Memory and Compaction` (`ID: memory`)
   - `### GitHub App and Action Control Plane` (`ID: github-app`)
   - `### System-One Decision Routing` (`ID: decisions`)
   - `### Development and Release` (`ID: development`)
   Each entry MUST carry single-line `- ID:`, `- Use for:`, `- Aliases:`, `- Guides:`, `- Specs:`, `- Code:`, `- Related:`, and `- Skills:` fields whose relative links resolve to existing files in the repository.
3. `## Specs`: Table mapping committed specifications under `specs/` to their scope.
4. `## All pages`: Subsections (`### Getting Started`, `### Operations`, `### Walkthroughs`, `### Modules`, `### Contribute`, `### Architecture Decisions`) with `| Page | Description |` tables listing all 21 pages in navigation order.

### 3. `AGENTS.md`, `.agents/skills/*`, and `.opencodereview/rule.json`

1. **`AGENTS.md`**:
   - Documents `## Project Structure`, `## Architecture`, `## Finding sources`, and `## Development` (including `npm run build`, `npm run typecheck`, `npm run lint`, `npm run lint:docs`, `npm run site`, and explicit skill triggers), followed by `### TypeScript conventions`, `### Authority and security conventions`, and `### Testing conventions`.
2. **Repository Skills (`.agents/skills/` + `.claude/skills -> ../.agents/skills`)**:
   - `loopwright-overview/SKILL.md`: Architecture tour across the 9 packages, module-map routing, and contributor invariants.
   - `loopwright-docs/SKILL.md` + `loopwright-docs/references/conventions.md`: Documentation routing table, `docs/getting-started/architecture.md` `<= 200`-line rule, Pretty YAML macro/micro rules, page shape rules, sync invariants, and `npm run lint:docs` / `npm run site` verification procedure.
   - `loopwright-code-review/SKILL.md`: Two-axis (`Standards` and `Spec`) PR review procedure, 5 implementation review axes, hard repository invariants, over-engineering pass (`delete:`, `reuse:`, `stdlib:`, `native:`, `yagni:`, `merge:`, `shrink:`), and OpenCodeReview severity table.
   - `loopwright-issue-pr/SKILL.md`: Six issue prefixes (`bug: `, `enhancement: `, `support: `, `docs: `, `cleanup: `, `todo: `), `<= 80` character issue title rule, Conventional Commit PR title grammar, `Signed-off-by` requirement, and issue-linking verbs (`Fixes #<n>`, `Addresses #<n>`, `Relates #<n>`).
   - `loopwright-release/SKILL.md`: End-to-end release workflow (`vX.Y.Z` / `vX.Y.Z-rcN`), preflight gates (`loopwright closure --verify-failures`, `npm run build`, `npm run typecheck`, `npm run lint`, `npm run lint:docs`, `npm run site`), release-note drafting, tag creation, and promotion.
3. **`.opencodereview/rule.json`**:
   - Valid JSON configuration with `include`, `exclude`, and path-scoped `rules` for `packages/core/**/*.ts`, `packages/state/**/*.ts`, `packages/agent-pi/**/*.ts`, `packages/controller/**/*.ts`, `packages/taskpack-runner/**/*.ts`, `packages/memory/**/*.ts`, `packages/decisions/**/*.ts`, `packages/github-app/**/*.ts`, `packages/cli/**/*.ts`, `action.yml`, `docs/**/*.md`, and `README.md`.

### 4. Hugo Site (`site/`) and Verification Scripts (`scripts/check-docs.mjs`, `scripts/site.mjs`)

1. **`site/hugo.toml`**:
   - Mounts `content` -> `content`, `../docs` -> `content/docs` (`excludeFiles = ["README.md", "assets/**"]`), `../docs/assets` -> `static/docs/assets`, `layouts` -> `layouts`, `assets` -> `assets`, `data` -> `data`, and `../docs` (`includeFiles = ["README.md"]`) -> `assets/doc-index`.
   - Outputs `["HTML", "JSON", "LLMS", "Markdown", "Version"]` for `home` and `["HTML", "Markdown"]` for `page` and `section`.
2. **`site/data/navigation.yaml`, `site/content/`, `site/layouts/`, `site/assets/`**:
   - Renders clean HTML pages with sidebar navigation, breadcrumbs, table of contents, light/dark theme toggle, client-side search (`/index.json`), `/llms.txt` listing all 21 `docs/` pages from `docs/README.md`, raw Markdown exports (`index.md`) preserving page prose and code blocks, and `/site-version.json`.
3. **`scripts/check-docs.mjs` and `scripts/site.mjs`**:
   - `scripts/check-docs.mjs`: Validates `docs/README.md` (`## Module map` fields and links, `## All pages` completeness and exact H1 title match, skill consumers), validates every `docs/**/*.md` page (`<= 200` lines for `docs/getting-started/architecture.md`, `# Title`, `## Contents` matching H2 headings, `**See also**` footer, no interrogative words in headings, raw HTML restricted to `<br>`/`<br/>` and safe HTML comments without `-->` inside comment bodies), and validates relative Markdown links across `README.md`, `AGENTS.md`, `docs/**`, and `.agents/skills/**`.
   - `scripts/site.mjs`: Resolves the Hugo binary (`HUGO_BIN`, `.sbin/hugo`, sibling reference `.sbin/hugo`, or `hugo` on `PATH`), builds `site/` to `site/public`, runs `check-docs.mjs`, verifies all internal HTML links and `#anchor` IDs in `site/public`, verifies `/llms.txt` and `/site-version.json`, and verifies all 21 Markdown exports under `site/public/docs/**/index.md`.

## Acceptance Criteria

- **`AC-1` (`AGENTS.md`, `.agents/skills/*`, `.claude/skills`, and `.opencodereview/rule.json`)**:
  - `AGENTS.md` exists at repository root and links to [docs/README.md#module-map](../docs/README.md#module-map), [docs/getting-started/architecture.md](../docs/getting-started/architecture.md), and [docs/development.md](../docs/development.md).
  - `.agents/skills/loopwright-{overview,docs,code-review,issue-pr,release}/SKILL.md` exist with valid YAML frontmatter (`name`, `description`), `.claude/skills` is a symlink to `../.agents/skills`, and `.opencodereview/rule.json` parses as valid JSON with `include`, `exclude`, and path-scoped `rules` covering all 9 packages, `action.yml`, `docs/**/*.md`, and `README.md`.
- **`AC-2` (Connected User Documentation & 21-Page Shape Compliance)**:
  - `README.md` and `docs/README.md` connect all four usage modes (GitHub Action, GitHub App, CLI, TypeScript SDK & System-One Decisions).
  - All 21 pages under `docs/` exist, match their exact H1 titles in `docs/README.md` (`## All pages`), include `## Contents` matching their H2 headings and a `**See also**` footer, keep `docs/getting-started/architecture.md` `<= 200` lines with `docs/assets/diagrams/architecture-flow.svg` + hidden Mermaid flowgraph comment, and pass `node scripts/check-docs.mjs` (`npm run lint:docs`) with `0` errors.
  - `loopwright closure --verify-failures` continues to exit `0` with all 23 capability rows and 14 failure-matrix scenarios passing.
- **`AC-3` (Hugo Documentation Site Build, `/llms.txt`, Markdown Exports, and Link Verification)**:
  - `npm run site` (`node scripts/site.mjs build`) builds `site/` with Hugo into `site/public`, produces `/llms.txt`, `/site-version.json`, `/index.json`, and all 21 `/docs/.../index.md` Markdown exports, and verifies `0` broken internal HTML links or anchors.
- **`AC-4` (Workspace Hygiene & Automated Test Coverage)**:
  - `packages/cli/test/docs-and-site.test.ts` tests `check-docs.mjs`, `.opencodereview/rule.json`, `.agents/skills/*`, `.claude/skills`, and `site.mjs` build/verification.
  - `npm run build`, `npm run typecheck`, `npm run lint`, `npm run lint:docs`, and `npm run site` exit `0`, `.github/workflows` remains absent, and zero forbidden host paths or internal shorthand identifiers appear in tracked files.

## Implementation Plan

- **Stage 1 (`T1` — `codex` Documentation & Skills Authoring)**:
  - Author `AGENTS.md`, `.opencodereview/rule.json`, `.agents/skills/loopwright-{overview,docs,code-review,issue-pr,release}/**`, `.claude/skills` symlink, `README.md`, `docs/README.md`, `docs/getting-started/architecture.md`, `docs/assets/diagrams/architecture-flow.svg`, `docs/operate/{github-action,github-app,cli}.md`, `docs/walkthroughs/declarative-taskpack.md`, `docs/contribute/internals.md`, and harmonize the 15 existing `docs/*.md` and `docs/adr/*.md` files to the exact 21-page contract.
- **Stage 2 (`T2` — `antigravity` Hugo Site & Verification Pipeline)**:
  - Author `site/hugo.toml`, `site/data/navigation.yaml`, `site/content/**`, `site/layouts/**`, `site/assets/**`, `scripts/check-docs.mjs`, `scripts/site.mjs`, `packages/cli/test/docs-and-site.test.ts`, and update root `package.json` (`lint:docs`, `site`, `site:serve`) and `.gitignore`.

## Test Plan

- Run `npm run lint:docs` (`node scripts/check-docs.mjs`) and `npm run site` (`node scripts/site.mjs build`).
- Run `npm run build && npm run typecheck && npm run lint`.
- Run `npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/cli/test/*.test.js` (including `docs-and-site.test.ts` and `closure-and-failure-matrix.test.ts`).
