---
name: loopwright-code-review
description: >-
  Review Loopwright pull-request and branch diffs on two independent axes —
  Standards (repository conventions, five engineering axes, over-engineering tags)
  and Spec (acceptance criteria and contract completeness) — with OpenCodeReview
  severity mapping (Critical/High/Medium/Low to Blocking/Important/Nit), Jev
  review-diff screening, and explicit honesty and noise rules.
---

# Loopwright Code Review

Use the [module map](../../../docs/README.md#module-map) and [architecture overview](../../../docs/getting-started/architecture.md) to locate owning packages, usage contracts (`docs/`), and rationale records (`specs/`). [AGENTS.md](../../../AGENTS.md) and [`.opencodereview/rule.json`](../../../.opencodereview/rule.json) define repository invariants; this skill defines the review procedure and reporting structure.

Always report findings under two separate top-level sections — **`## Standards`** and **`## Spec`** — and never merge or rerank them together.

## Standards

Evaluate repository conventions, package boundary rules, runtime safety invariants, and code simplicity independently of whether the task prompt asked for them.

## Spec

Evaluate whether the diff completely and accurately implements the approved specification (`specs/*.md`), linked GitHub issue, or PR description, including negative paths, edge cases, and acceptance criteria.

## 6-Step Deterministic Review Procedure

### 1. Pin the diff, scope, and owning specification

- Inspect `git diff <base>...<head>` (and `git status --short` for untracked files). If the diff is empty, stop and report that no changes exist.
- Load [`AGENTS.md`](../../../AGENTS.md), [`.opencodereview/rule.json`](../../../.opencodereview/rule.json), the relevant `docs/` guide via the [module map](../../../docs/README.md#module-map), and the governing specification under `specs/` (or linked issue / PR description).
- Trace callers, callees, and public TypeScript exports across all nine workspace packages (`packages/{core,state,agent-pi,controller,taskpack-runner,memory,decisions,github-app,cli}`).

### 2. Run Jev `review-diff` fast screen (when available)

- When the `jev` skill and `TYPESAFE_API_KEY` are available, run a fast System-One diff screen against the base branch (`--git-diff <base-branch-or-sha>` or `--base <base-branch-or-sha>`):
  ```bash
  python3 ~/.agents/skills/jev/scripts/jev_cli.py review-diff --git-diff <base-branch-or-sha>
  ```
- Treat Jev flags as candidate leads: verify every flagged location directly in the source files and only report findings backed by concrete code evidence. Deliberate deeply when Jev's output diverges from your initial read or returns confidence `< 0.80`.

### 3. Inspect the 5 Loopwright engineering axes

Evaluate every changed file against these five Loopwright-specific axes:

1. **Package & Layer Boundaries**:
   - Dependency DAG: `core -> state -> agent-pi -> controller -> {taskpack-runner, memory, decisions, github-app} -> cli`. Flag any reverse or circular package dependency.
   - Frozen package guard: When a specification or task freezes lower-level packages (for example, `packages/core`, `packages/state`, `packages/agent-pi`, `packages/controller`, or `examples/*.json`), flag any modification to those paths as `Critical` (`Blocking`).
   - Strict ESM NodeNext discipline: explicit `.js` relative import specifiers, explicit public return and parameter types, and zero `any` or unsafe type assertions.
2. **Public Contract & YAML/JSON Schema Safety**:
   - Validate all untrusted inputs (including `Object.create(null)` null-prototype records) before property access.
   - Enforce strict YAML 1.2 core schema and JSON parsing bounds: reject YAML anchors (`&`), aliases (`*`), merge keys (`<<:`), custom tags (`!`), duplicate keys, tab indentation, and `__proto__` / `constructor` / `prototype` keys.
   - Enforce deterministic byte caps (e.g., `<= 64 KiB` on config/policy manifests) and verify that Pretty YAML serialization round-trips losslessly through `loadTrustedConfiguration` with matching SHA-256 registry digests.
3. **Authority, Lease Fencing, Monotonic Clock, OS Sandbox & Secret Scrubbing**:
   - **Lease fencing & monotonic clocks**: Preserve SQLite WAL atomic transactions, monotonic lease token verification on every state write, and monotonic clock skew guards (`@loopwright/state`).
   - **Symlink & file safety**: Require `O_NOFOLLOW` and regular-file checks when loading local configuration, taskpacks, policies, or workspace proposals; prevent path traversal (`..`) outside `spec.scope.writable`.
   - **OS & container sandboxes**: Preserve isolation profiles (`macos-seatbelt`, `linux-bwrap`, `linux-landlock`, `docker`, `direct-dedicated`) and physical send admission (`@loopwright/agent-pi`).
   - **Non-delegable authority**: Verify that HMAC `gate.v1` verification receipts come only from independent base-checkout verification hooks (`@loopwright/controller`) and that System-One routing (`@loopwright/decisions`) never overrides the six non-delegable safety intents or three-zone confidence floors (`act`, `confirm`, `escalate`).
   - **Secret scrubbing**: Ensure `${ENV}` interpolation resolves secrets only in memory, never persists raw credentials to SQLite or disk artifacts with loose permissions (require `0o600` for runtime config files), and scrubs tokens from logs, errors, and evidence bundles.
4. **Unknown-Outcome & Diagnostic Discipline**:
   - **Never silently retry uncertain external effects**: If a process crash, timeout, or network failure occurs after an external mutation may have started (such as GitHub PR creation or external API dispatch), record the outcome as `unknown` and require explicit reconciliation (`loopwright reconcile`).
   - **Deterministic error codes**: Every failure path must emit its canonical typed error code (`TASKPACK_MANIFEST_INVALID`, `GITHUB_APP_CONFIG_INVALID`, `DECISION_POLICY_INVALID`, etc.) with actionable diagnostic context and zero swallowed exceptions.
5. **Test, Documentation, & Closure Parity**:
   - Verify unit and negative-path tests cover new schemas, boundary limits, duplicate keys, symlink rejection, and error codes.
   - Verify documentation updates obey `loopwright-docs` (`npm run lint:docs` and `npm run site`), keep the 12 public `docs/` pages free of links to `development.md` or `contribute/**`, and keep `.github/workflows/` under least-privilege `permissions` and strictly protected against untrusted taskpack/sandbox writes.
   - Verify capability closure claims in `@loopwright/cli` (`loopwright closure --verify-failures`) honestly separate local/fixture verification from `blocked_external` live qualification.

### 4. Check hard repository invariants (`.opencodereview/rule.json`)

Cross-check every rule in [`.opencodereview/rule.json`](../../../.opencodereview/rule.json) and [`AGENTS.md`](../../../AGENTS.md):

- `.github/workflows/` maintains least-privilege `permissions` and remains strictly protected against untrusted taskpack and sandbox writes.
- Zero host filesystem paths, agent scratch paths, or internal wave/task tags in tracked files.
- `docs/README.md` `## Module map` and `## All pages` stay synchronized with `docs/**/*.md` and `.agents/skills/*/SKILL.md`.

### 5. Run the over-engineering pass

Sweep changed implementation code separately for unnecessary complexity. Format each simplification as a single line with `file:line`, tag, what to cut, and the direct replacement:

- `delete:` — Dead code, unused options, or speculative scaffolding. Replacement: nothing.
- `reuse:` — Duplicates an existing helper or validator in the workspace (name the existing path and function).
- `stdlib:` — Re-implements functionality built into Node.js (`node:fs`, `node:path`, `node:crypto`, `node:util`) or the TypeScript standard library.
- `native:` — Re-implements behavior already enforced by SQLite constraints, strict YAML/JSON schema loaders, or Hugo built-in templates.
- `yagni:` — Single-caller abstraction layer, premature generic parameter, or unused configuration knob. Inline until a second caller exists.
- `merge:` — Near-duplicate functions or test helpers that must change in lockstep.
- `shrink:` — Equivalent deterministic logic expressible in fewer, clearer lines.

End the over-engineering pass with `net: -N lines possible`, or `Lean already.` when nothing should be cut. Never flag negative-path security tests or required doc comments for deletion.

### 6. Aggregate and label under `## Standards` and `## Spec`

Label every finding using the OpenCodeReview severity mapping table below:

| OpenCodeReview Severity | Review Gate Level | Meaning & Examples |
| --- | --- | --- |
| `Critical` | `Blocking` | Security vulnerability, secret leak, broken lease fence, silent retry of `unknown` external effect, modification of frozen packages, or relaxing `.github/workflows/` least-privilege `permissions` or untrusted taskpack/sandbox write protections. |
| `High` | `Blocking` | Material correctness bug, broken public contract/YAML round-trip, missing `O_NOFOLLOW`/symlink check, broken build/test/docs gate, or unfulfilled spec acceptance criterion. |
| `Medium` | `Important` | Scoped behavioral edge case, missing negative-path test, documentation convention violation (`check-docs.mjs`), or actionable `reuse:` / `yagni:` / `delete:` finding. |
| `Low` | `Nit` | Minor naming, readability, or `shrink:` improvement that does not affect runtime correctness, authority, or contracts. |

Format each finding as:
`- **[<Critical|High|Medium|Low> / <Blocking|Important|Nit>]** \`path/to/file.ts:line\` — <Concrete scenario, root cause, and exact fix>.`

## Honesty Rules

1. **Cite exact `file:line` and concrete failure scenario**: Never report vague concerns. Trace the exact input or call sequence that triggers the defect.
2. **Separate verified defects from hypotheses**: If a question depends on an external system not visible in the repository, label it explicitly as a verification question rather than a fabricated bug.
3. **Never rubber-stamp or invent filler findings**: If both `## Standards` and `## Spec` have zero defects after thorough inspection, state `No findings.` under each section and summarize the verified test and gate evidence.
4. **Preserve evidence boundaries**: Never ask an author to claim live cloud/GitHub production qualification when only local deterministic fixtures were executed.

## Named Noise Exclusions (Do Not Flag)

Omit these known false positives unless a diff actively breaks them:

- **Pinned YAML 1.2 core-schema parser**: All YAML parsing uses the pinned yaml@2.9.0 package with version: '1.2', schema: 'core', uniqueKeys: true, merge: false, strict: true, customTags: [], and explicit alias/anchor/tag rejection; do not ask for a hand-rolled YAML parser.
- **Preserved `examples/*.json` fixtures**: Keeping `examples/*.json` alongside `examples/task.yaml` is required for `@loopwright/core` fixture compatibility; do not flag `examples/*.json` for conversion or removal.
- **Repository-only `Contribute` docs (including `contribute/adr/`)**: `docs/development.md` and `docs/contribute/**` are intentionally excluded from `site/` while remaining in `docs/README.md`; do not flag their absence from `site/data/navigation.yaml`.
- **Formatter/linter rules already enforced by `npm run lint` and `npm run typecheck`**: Do not manually nitpick formatting when `eslint` and `tsc --noEmit` pass.
