# Spec: Taskpack 2.0 orchestration, trust modes, and extensible verification contracts

Status: Shipped
Type: Feature

## Summary

Upgrade Loopwright's declarative `Taskpack` surface and underlying `@loopwright/core`, `@loopwright/state`, `@loopwright/agent-pi`, `@loopwright/controller`, `@loopwright/decisions`, `@loopwright/github-app`, `@loopwright/taskpack-runner`, and `@loopwright/cli` contracts into **Taskpack 2.0**. Close the expressiveness gap between Declarative `Taskpack` and `Managed Controller` so repositories run unattended maintenance and multi-upstream synchronization without thousand-line external glue scripts. Introduce dual-key execution trust modes (`strict` by default and opt-in `privileged` requiring both manifest declaration and operator host unlock, with separate high-risk agent capability flags), automatic runtime SHA-256 digesting with optional `loopwright digest sync` lockfile pinning, authorized host `spec.preflight` with split `mount: 'prompt' | 'workspace'` read-only `stagedResources`, interleaved `spec.steps` (`agent`, `check`, `compact`) with structured `StepVerdict` and `rejectTo` targeted rework over raised 256-checkpoint bounds, directory-mounted `command.v1` with toolchain and read-only `.git` support, explicit `/**` directory and single-segment `*`/`?` glob `scope` plus built-in structural guards, and live `spec.decisions` wiring via `ControllerPorts.decisions`. Extend core contracts (`Evidence`, `EvaluatedCheck`, `ArtifactRef`, `target.matrix`, and HMAC-signed `gate_verdict` envelopes) to carry optional quantitative floating-point metrics, structured findings, and external artifact pointers so future long-horizon hardware optimization loops plug in additively.

## Motivation

### Goals

Audit of the current Declarative `Taskpack` compiler ([`packages/github-app/src/taskpack.ts`](../packages/github-app/src/taskpack.ts)), local verifier ([`packages/github-app/src/turnkey.ts`](../packages/github-app/src/turnkey.ts)), core contracts ([`packages/core/src/boundary.ts`](../packages/core/src/boundary.ts), [`packages/core/src/evidence.ts`](../packages/core/src/evidence.ts), [`packages/core/src/acceptance.ts`](../packages/core/src/acceptance.ts), [`packages/core/src/scope.ts`](../packages/core/src/scope.ts)), state store ([`packages/state/src/checkpoint.ts`](../packages/state/src/checkpoint.ts)), controller ([`packages/controller/src/compile.ts`](../packages/controller/src/compile.ts), [`packages/controller/src/progress.ts`](../packages/controller/src/progress.ts), [`packages/controller/src/gate.ts`](../packages/controller/src/gate.ts)), and repository dogfooding ([`.auto-sync/taskpack.yaml`](../.auto-sync/taskpack.yaml), [`scripts/prepare-self-upgrade.mjs`](../scripts/prepare-self-upgrade.mjs)) shows six structural limitations:

1. **Narrow declarative orchestration and checkpoint ceilings**: `Taskpack` caps `spec.roles` at four roles, omits `spec.steps`, forces all local checks into one tail chain after sink roles, disallows `pi.compact.v1`, requires `spec.proposal`, and hides `submission.path`. Meanwhile [`packages/state/src/checkpoint.ts`](../packages/state/src/checkpoint.ts) caps runs at `64` checkpoints and [`packages/controller/src/progress.ts`](../packages/controller/src/progress.ts) caps attempts at `16`, preventing 16-step pipelines or bounded rework loops from running.
2. **External glue script sprawl**: `Taskpack` lacks a declarative `spec.preflight` hook, read-only `stagedResources` separated from LLM prompt injection, atomic lockstep `upstreamGroups`, JSONPath extraction, SemVer downgrade protection, and per-upstream `held_back` status. As a result, [`scripts/prepare-self-upgrade.mjs`](../scripts/prepare-self-upgrade.mjs) spans 1,445 lines and smuggles staged `/tmp` paths through text fields, while multi-upstream repositories must fake `up_to_date` whenever one upstream is incompatible so sibling updates are not blocked.
3. **High-friction local verification and coarse scope**: `command.v1` copies only the single `script` file (breaking relative helper imports such as `lib.sh`), wipes `PATH`, omits `.git`, and runs from a random temp directory. `scope` rejects `*`/`?` globs, blindly appends `/**` to exact file paths outside control root, cannot distinguish bare directory names from extensionless files during memory-only parsing, hard-blocks `.agents/**`, and fixes candidate overlay caps at `128` files / `4 MiB` across core, agent-pi, and controller verifier packets.
4. **All-or-nothing sandbox friction and manual digest burden**: Trusted repositories and self-hosted CI runners lack an explicit operator-approved privileged execution mode for host toolchains and large generated trees. Requiring manual SHA-256 hash edits whenever a developer changes one line in a script adds heavy operational friction unless digests are computed automatically or maintained by a CLI tool.
5. **Unwired `spec.decisions` configuration**: [`packages/github-app/src/schema.ts`](../packages/github-app/src/schema.ts) validates `spec.decisions`, while runtime entrypoints ([`packages/github-app/src/action.ts`](../packages/github-app/src/action.ts), [`packages/controller/src/controller.ts`](../packages/controller/src/controller.ts)) never instantiate [`packages/decisions/src/nodes.ts`](../packages/decisions/src/nodes.ts). Because `@loopwright/decisions` already depends on `@loopwright/controller`, controller hooks must invert control through a zero-dependency port on `ControllerPorts`.
6. **Hard protocol blockers for future long-horizon quantitative workflows**: [`packages/core/src/boundary.ts`](../packages/core/src/boundary.ts) rejects all non-integer numbers in `snapshot()`, [`packages/core/src/evidence.ts`](../packages/core/src/evidence.ts) and [`packages/core/src/acceptance.ts`](../packages/core/src/acceptance.ts) reject metadata when `status === 'passed'`, [`packages/controller/src/gate.ts`](../packages/controller/src/gate.ts) strips details on `approved` verdicts, `ArtifactRef` has no external pointer fields, and [`packages/controller/src/compile.ts`](../packages/controller/src/compile.ts) refuses any non-null `target.matrix`. Future hardware kernel optimization and quantitative benchmark workflows cannot attach latency, speedup, or binary artifact references without breaking core schemas.

Success is measured by:
- Eliminating text-field path smuggling and cutting [`scripts/prepare-self-upgrade.mjs`](../scripts/prepare-self-upgrade.mjs) down to thin domain-specific logic under [`.auto-sync/taskpack.yaml`](../.auto-sync/taskpack.yaml).
- Running interleaved `agent` -> `check` -> `review` -> `rejectTo` rework loops with per-role instructions, skills, and MCP isolation under raised bounded checkpoints (`<= 256`).
- Supporting multi-upstream lockstep groups, per-upstream `held_back`, directory-mounted `command.v1` scripts with shared helpers, explicit `/**` and `*`/`?` glob `scope`, built-in structural guards, and live `spec.decisions` routing.
- Passing all repository build, typecheck, lint, test, closure, docs, and site gates with Taskpack 2.0 contracts and forward-compatible quantitative verification core schemas in place.

### Non-Goals

- Preserving backward compatibility with legacy Taskpack v1 YAML fields when a cleaner Taskpack 2.0 schema replaces them.
- Implementing multi-domain repository suite routing, cross-cycle stage promotion, Markdown heading compact handoff, or post-run `RunEval` recommendation reports (deferred to follow-up specification [`2026-11-21-multi-domain-suite-handoff-and-run-eval.md`](2026-11-21-multi-domain-suite-handoff-and-run-eval.md)).
- Implementing remote outbound GPU/hardware benchmark runners (`benchmark-gate.v1`), `'hardware_execution'` check execution, or outer multi-generation MCTS / MAP-Elites campaign controllers (deferred to follow-up specifications; hardware execution and `benchmark-gate.v1` are covered in [`2026-11-21-hardware-execution-benchmark-gate-and-remote-runner.md`](2026-11-21-hardware-execution-benchmark-gate-and-remote-runner.md)).
- Adding a centralized web service, database server, or host Docker socket passthrough into untrusted agent sandboxes.

## Proposal

Redesign Declarative `Taskpack` as **Taskpack 2.0** and extend `@loopwright/core`, `@loopwright/state`, `@loopwright/agent-pi`, `@loopwright/controller`, `@loopwright/decisions`, `@loopwright/github-app`, `@loopwright/taskpack-runner`, and `@loopwright/cli` so a single declarative manifest expresses authorized intake preflight, resilient multi-upstream resolution, dual-key execution trust modes, interleaved multi-role DAG execution with targeted rework, frictionless local and external verification, live advisory decision routing, and extensible quantitative evidence contracts.

### User Stories

#### Story 1
As a repository maintainer, I want `taskpack.yaml` to run a host `preflight` step, auto-stage read-only artifacts with runtime-computed SHA-256 digests, group lockstep upstreams, and mark individual incompatible upstreams as `held_back` without blocking siblings, so that I eliminate thousand-line prep scripts and stop faking `up_to_date`.

#### Story 2
As a workflow author, I want `spec.steps` to interleave `agent`, `check`, and `compact` steps with per-role `instructions`, `skills`, and `mcpServers` allowlists, make `proposal.json` optional while exposing `submission.path`, and support structured verdicts (`pass | rework | fail | human` + `findings`) with `rejectTo` targeted rework, so that fast checks gate expensive reviews and reviewers return precise findings to the responsible upstream step.

#### Story 3
As a repository maintainer, I want `command.v1` to mount the check directory (preserving shared helpers like `lib.sh`), optionally expose read-only `.git` and declared toolchains, support exact-file and glob `scope` plus built-in structural guards (`json-keys-guard.v1`, `line-section-guard.v1`), and configure overlay limits, so that I stop writing fake `git init` and thousand-line `diff -U0` wrappers.

#### Story 4
As an operator running Loopwright on a trusted repository or CI runner, I want an explicit opt-in `privileged` execution mode alongside the `strict` default (gated by operator host flags and separate high-risk agent switches) and automatic runtime digesting (with optional CLI lockfile syncing), so that changing one line in a script runs immediately without manual SHA-256 editing.

#### Story 5
As a platform engineer preparing for long-horizon engineering governance and self-evolving inference kernel workflows, I want `spec.decisions` wired into live runs and `@loopwright/core` upgraded to support optional quantitative `metrics` on passing checks, extensible `ArtifactRef` pointers, and `target.matrix` metadata passthrough, so that future remote hardware gates and multi-generation optimization loops plug in additively.

### Core Features & Acceptance Criteria

#### 1. Dual-Key Execution Trust Modes and Zero-Friction Runtime Digesting (`@loopwright/github-app`, `@loopwright/controller`, `@loopwright/cli`, `action.yml`)
- Add `spec.execution` to `Taskpack` YAML:
  - `mode`: `'strict' | 'privileged'` (default `'strict'`).
  - `capabilities` (optional overrides):
    - `allowHostEnv`: boolean (default `false` in `strict`, `true` in `privileged`; applies to host `preflight` and `command.v1` checks, always stripping forbidden Loopwright/provider/GitHub-App credentials).
    - `allowHostPath`: boolean (default `false` in `strict`, `true` in `privileged`).
    - `mountReadOnlyGit`: boolean (default `false` in `strict`, `true` in `privileged`).
    - `allowCheckNetwork`: boolean (default `false` in `strict`, `true` in `privileged`).
    - `allowWorkflowWrites`: boolean (default `false` in **both** `strict` and `privileged`; only an explicit `true` unlocks agent writes under `.github/workflows/**`).
    - `allowAgentNetwork`: boolean (default `false` in **both** `strict` and `privileged`).
  - `digests`:
    - `pinDigests`: boolean (default `false`).
    - `lockfile`: optional repo-relative path (default `<controlRoot>/digests.lock.json` when `pinDigests: true`).
- Dual-key operator authorization: untrusted repository manifests must never self-grant privileged execution or workflow edits. Enabling `mode: privileged` requires both manifest declaration and an operator-controlled host input (`allow-privileged-execution: true` in [`action.yml`](../action.yml) or `--allow-privileged` in [`packages/cli/src/main.ts`](../packages/cli/src/main.ts)). Enabling `allowWorkflowWrites: true` requires both manifest declaration and `allow-workflow-writes: true` / `--allow-workflow-writes`. Multi-tenant webhook service runs ([`packages/github-app/src/service.ts`](../packages/github-app/src/service.ts)) refuse self-granted privileged capabilities with `TASKPACK_SCOPE_VIOLATION` / `TASKPACK_HOST_BINDING_INVALID`.
- Automatic runtime digesting: when `pinDigests` is `false`, Loopwright computes SHA-256 digests at run start for repository scripts, mounted check directories (deterministic whole-tree digest rejecting escaping symlinks), instructions, skills, and `preflight`-staged resources. Digests freeze mid-run integrity and receipts without requiring manual hash updates after code edits.
- Optional pinned lockfile + CLI helper: when `pinDigests` is `true`, intake fails closed if any tracked file or check-directory tree digest differs from the lockfile. Add `loopwright digest sync --taskpack <path>` (writes/updates the lockfile deterministically) and `loopwright digest sync --taskpack <path> --check` (verifies lockfile parity in CI) to [`packages/cli/src/main.ts`](../packages/cli/src/main.ts).
- **Acceptance criteria**:
  - Editing a local check or preflight script with default `pinDigests: false` runs immediately with fresh runtime SHA-256 digests recorded in run metadata.
  - Running `loopwright digest sync` produces a deterministic lockfile; altering a tracked script or sibling `./lib.sh` helper causes `pinDigests: true` runs to fail closed with a clear diagnostic.
  - A manifest declaring `mode: privileged` or `allowWorkflowWrites: true` without the matching operator host flag fails closed before running `preflight.script`.
  - With operator unlock, `mode: privileged` inherits host `PATH`/env (minus forbidden credentials) and read-only `.git` for host scripts while still blocking agent writes to `.github/workflows/**` unless `allowWorkflowWrites: true` is unlocked on both sides.
  - Secret scrubbing, SQLite lease fencing, non-delegable decision authority, and `unknown` external-effect accounting stay active in both `strict` and `privileged` modes.

#### 2. Authorized `spec.preflight`, Split Staged Resources, and Resilient Upstreams (`@loopwright/github-app`, `action.yml`)
- Add optional `spec.preflight` executed once on the host during intake, strictly **after** actor authorization and `SecretScrubber` initialization and **before** `TaskContract` compilation and controller admission:
  - Fields: `script` (repo-relative path), `timeoutSeconds` (integer, bounded), `env` (explicit allowlist in `strict`; inherits sanitized host env when `allowHostEnv` is `true`, always stripping `GITHUB_TOKEN`, `GITHUB_APP_PRIVATE_KEY`, `LOOPWRIGHT_*`, and provider API keys unless explicitly brokered).
  - Execution writes one bounded JSON document to the file path provided in `LOOPWRIGHT_PREFLIGHT_OUT`:
    - `disposition`: `'candidate' | 'no_change' | 'blocked'`
    - `reason`: optional string
    - `upstreams`: optional array of upstream records supporting `status: 'available' | 'up_to_date' | 'held_back' | 'blocked' | 'failed'`, `version`, `currentVersion`, `reason`, and bounded `metadata`
    - `stagedResources`: optional array of `{ id, kind: 'instruction' | 'skill' | 'document', path, mount?: 'prompt' | 'workspace', exposeToChecks?: boolean }`
  - Split staging semantics (preventing UTF-8 decode crashes and prompt bloat in [`packages/agent-pi/src/resources.ts`](../packages/agent-pi/src/resources.ts)):
    - `mount: 'prompt'` (default for `instruction`/`skill`): bounded UTF-8 text hashed and mounted into `TaskContract.spec.trustedContext.resources`.
    - `mount: 'workspace'` (default for `document` and mandatory for large or binary files such as `package-lock.json` or `.tgz` caches): hashed into a verified read-only staging directory exposed to agents by path manifest and to `command.v1` via `LOOPWRIGHT_STAGED_DIR` (when `exposeToChecks: true`), never decoded or concatenated into the LLM system prompt.
- Upstream discovery and grouping upgrades in [`packages/github-app/src/upstreams.ts`](../packages/github-app/src/upstreams.ts) and [`packages/github-app/src/taskpack.ts`](../packages/github-app/src/taskpack.ts):
  - Add `'held_back'` to `UpstreamAcquisitionStatus`. One or more `held_back` upstreams do not abort intake when sibling upstreams are `'available'`; `held_back` records appear in summaries and role prompts so agents skip them intentionally, and reviewed memory keys preserve `currentVersion` (never the skipped upstream target version).
  - Add `versionPath` (dot/bracket selector) and `monotonicSemver?: boolean` (default `true` for SemVer sources when `currentVersion` is known) to `http-json` upstreams to prevent accidental downgrades.
  - Wire `watchedPaths` into intake summaries and prompt context instead of ignoring the field.
  - Add `spec.upstreamGroups`: array of `{ id, members: string[], policy: 'lockstep' | 'independent' }`. Under `lockstep`, if members disagree on target version or any member is unavailable, the entire group resolves as `held_back` atomically without blocking unrelated groups.
  - Support proposal-optional baseline version resolution in `upstreams.ts` when `spec.proposal` is omitted.
- Add `mode: 'auto'` to [`action.yml`](../action.yml) and [`packages/github-app/src/action.ts`](../packages/github-app/src/action.ts): runs preflight/discovery, dispatches `candidate` when updates exist or `force` is `true`, and compiles a check-only `no-change` verification run (zero agent model calls) when disposition is `no_change`.
- **Acceptance criteria**:
  - An unauthorized `issue_comment` event never invokes `spec.preflight.script`.
  - A preflight returning `disposition: 'no_change'` short-circuits before allocating agent model turns and runs check-only `no-change` verification under `mode: 'auto'`.
  - A preflight staging a `>100 KiB` lockfile and binary `.tgz` cache with `mount: 'workspace'` never causes `agent-pi` UTF-8 decode failures and exposes flagged files via `LOOPWRIGHT_STAGED_DIR` without text-field path smuggling.
  - In a multi-upstream run where one lockstep group is `held_back` and another upstream is `available`, intake proceeds with `disposition: 'candidate'`, lists the held-back group explicitly, and keeps `currentVersion` in memory metadata.

#### 3. Interleaved `spec.steps` DAG, Per-Role Isolation, Optional Proposal, `rejectTo` Rework, and 256-Checkpoint Scaling (`@loopwright/core`, `@loopwright/state`, `@loopwright/agent-pi`, `@loopwright/controller`, `@loopwright/github-app`)
- Raise physical checkpoint ceilings cleanly: raise checkpoint sequence and count caps across [`packages/state/src/schema.ts`](../packages/state/src/schema.ts) (`CHECK(sequence BETWEEN 1 AND 256)`), [`packages/state/src/connection.ts`](../packages/state/src/connection.ts) (`LIMIT 257`), [`packages/state/src/boundary.ts`](../packages/state/src/boundary.ts) (`STATE_LIMITS.checkpoints: 256`), and [`packages/state/src/checkpoint.ts`](../packages/state/src/checkpoint.ts) from `64` to `256` directly (no legacy `1..64` SQLite store migration path), and scale [`packages/controller/src/compile.ts`](../packages/controller/src/compile.ts) and [`packages/controller/src/progress.ts`](../packages/controller/src/progress.ts) attempts/generations so `16` steps and `maxReworks: 1..8` never hit artificial `D > 64` or `16`-attempt failures.
- Add optional `spec.steps` to `Taskpack` (up to `16` roles and `16` steps, matching `Managed Controller`):
  - Step kinds: `'agent' | 'check' | 'compact'` (`compact` compiles to a `TaskContract` `agent` step bound to `pi.compact.v1`, with delegated-role compaction behavior explicitly validated at compile time).
  - Fields: `id`, `kind`, `role` (for `agent`/`compact`), `check` (for `check`), `dependsOn`, and optional `onRework: { rejectTo: string, maxReworks: number }`.
  - When `spec.steps` is omitted, compile a default ordered DAG from `spec.roles` followed by local checks and external gates.
  - Allow interleaving fast `check` steps and `pi.compact.v1` compaction steps between `agent` steps in any acyclic DAG.
- Per-role isolation on `spec.roles[]`:
  - Support per-role `instructions` (file list), `skills` (file list), `prompt` (optional inline prompt), `mcpServers` (explicit allowlist of declared `spec.mcp` server IDs; default `[]` for read-only `review` roles), and optional `models` fallback list (inheriting `spec.models` if omitted).
  - Add optional `resourceIds` to `TaskContract.spec.roles[]` so [`packages/controller/src/controller.ts`](../packages/controller/src/controller.ts) and [`packages/controller/src/step.ts`](../packages/controller/src/step.ts) inject only each role's bound resources.
  - Enforce per-role MCP tool allowlists inside `@loopwright/agent-pi` (`host-session.ts`) before `mcpRegistry.callTool`, and extend `stageTaskpackForStep` / `StepYield` so `loopwright step` honors `spec.mcp` and per-role `mcpServers` identically to GitHub Action mode.
- Optional `spec.proposal` and structured `spec.submission`:
  - Make `spec.proposal` optional so taskpacks without a proposal ledger compile, discover, verify, and publish cleanly.
  - Expose `spec.submission: { path: string, required?: boolean }` so agent steps can emit structured JSON deliverables verified by schema.
- Structured verdicts and `rejectTo` targeted rework:
  - Define `StructuredFinding = { title: string, severity: 'critical' | 'high' | 'medium' | 'low', path?: string | null, line?: number | null, evidence: string }` and `StepVerdict = { verdict: 'pass' | 'rework' | 'fail' | 'human', summary: string, findings: readonly StructuredFinding[] }`.
  - Separate per-node author `Submission` records from `StepVerdict` records in [`packages/controller/src/progress.ts`](../packages/controller/src/progress.ts), [`packages/controller/src/controller.ts`](../packages/controller/src/controller.ts), and [`packages/controller/src/step.ts`](../packages/controller/src/step.ts) so review verdicts never overwrite author check claims or fail `submission.v1` parsing.
  - Validate `rejectTo` at compile time: target step must be a strict ancestor of the current step in the DAG, and `maxReworks` must be bounded (`1..8`).
  - Index reworked node attempts and verifier checkpoints by rework epoch (rather than `candidateDigest`-only generation) so resetting `[rejectTo, ...descendants]` re-runs downstream task and check steps cleanly without duplicate-ordinary `RECOVERY_REQUIRED` or unchanged-digest phase collisions.
  - When `verdict === 'human'` or `reworkCount` exceeds `maxReworks`, halt deterministically with `blocked` status and preserve all findings in the run result.
- **Acceptance criteria**:
  - A pipeline (`plan -> implement -> docs -> fast-check -> review` with `review.onRework.rejectTo = 'implement'`) re-runs only `implement -> docs -> fast-check -> review` (never resetting `plan`) across both `controller.ts` and `loopwright step`, including when `implement` produces an unchanged `candidateDigest` and across simulated crash + `reconcile()`.
  - Exceeding `maxReworks` terminates cleanly as `blocked` with zero infinite loops.
  - A read-only `review` role with default `mcpServers: []` receives zero external write MCP tools and cannot invoke another role's MCP server even via crafted tool calls, in both Action and `loopwright step` modes.
  - A taskpack omitting `spec.proposal` compiles, verifies, and publishes cleanly.

#### 4. Frictionless `command.v1`, Explicit-Suffix Glob Scope, Built-In Structural Guards, and Wide Overlay Limits (`@loopwright/core`, `@loopwright/agent-pi`, `@loopwright/controller`, `@loopwright/github-app`, `@loopwright/taskpack-runner`)
- Upgrade `command.v1` in [`packages/github-app/src/turnkey.ts`](../packages/github-app/src/turnkey.ts):
  - Mount the entire parent directory containing `script` read-only (with whole-directory tree digest verification and escaping-symlink refusal) so relative helper scripts (such as `source ./lib.sh`) resolve safely.
  - Add `toolchainPaths?: readonly string[]` (ordered directories prepended to `PATH` in `strict` mode; host `PATH` inherited when `allowHostPath` is `true`).
  - Expose read-only `.git` metadata (when `mountReadOnlyGit` is `true`) and `LOOPWRIGHT_BASE_DIR` (read-only baseline snapshot path) for clean diff inspection.
  - Add `preserveRepoDirName?: boolean` allocating a collision-free nested directory `<tempParent>/<sanitizedRepoBasename>` when tools depend on directory basename.
  - Provide `LOOPWRIGHT_CHECK_OUT` path: if the script writes valid bounded JSON (`{ metrics?, findings?, detail? }`), pass it through HMAC-signed `gate_verdict` ([`packages/controller/src/gate.ts`](../packages/controller/src/gate.ts), [`packages/controller/src/reconcile.ts`](../packages/controller/src/reconcile.ts)) into the check's `Evidence` even on exit `0` (`passed`).
  - Support non-secret `${VAR}` interpolation via explicit `spec.vars`: replace raw-text `text.includes('${')` rejection in [`packages/github-app/src/schema.ts`](../packages/github-app/src/schema.ts) with post-parse AST validation that allows declared `spec.vars` keys only in permitted fields (`command.v1` `args`/`env`, `titleTemplate`, etc.) while continuing to refuse undeclared or ambient `${...}` expressions with `TASKPACK_UNTRUSTED_INTERPOLATION`.
- Upgrade `scope` matching across [`packages/core/src/scope.ts`](../packages/core/src/scope.ts), [`packages/github-app/src/taskpack.ts`](../packages/github-app/src/taskpack.ts), [`packages/github-app/src/sandbox.ts`](../packages/github-app/src/sandbox.ts), [`packages/controller/src/step.ts`](../packages/controller/src/step.ts), and [`packages/taskpack-runner/src/compile-taskpack.ts`](../packages/taskpack-runner/src/compile-taskpack.ts):
  - Eliminate lexical ambiguity during memory-only compilation: explicit `dir/**` matches a recursive directory subtree; paths without `/**` match exact files or bounded single-segment `*`/`?` globs (for example `packages/*/package.json`), rejecting `..`, absolute paths, and reserved names.
  - Translate `*`/`?` writable globs cleanly in [`packages/github-app/src/sandbox.ts`](../packages/github-app/src/sandbox.ts) (`bwrap`, Seatbelt, Landlock).
  - Remove the unconditional `.agents/**` block across `github-app`, `controller/step.ts`, and `taskpack-runner` so repositories can explicitly list `.agents/...` in `scope.writable` (while keeping `.claude/**` protected so tracked symlinks such as `.claude/skills -> ../.agents/skills` pass `freezeSource`), and keep `.github/workflows/**` protected unless dual-key `allowWorkflowWrites: true` is granted.
- Add two built-in deterministic check implementations in [`packages/controller/src/handlers.ts`](../packages/controller/src/handlers.ts), [`packages/controller/src/verifier-protocol.ts`](../packages/controller/src/verifier-protocol.ts), and [`packages/controller/src/verification.ts`](../packages/controller/src/verification.ts):
  - `json-keys-guard.v1`: verifies candidate edits to target JSON files against authenticated baseline proofs, failing if any key outside `allowedPointers` changed.
  - `line-section-guard.v1`: verifies candidate edits to shared text/code files against authenticated baseline proofs, failing if any line outside `startMarker` .. `endMarker` sections changed.
  - Keep module count well below `installedHandlerDigests()` 256-file cap and enforce explicit per-file packet size bounds cleanly.
- Add configurable `spec.limits.overlay: { maxFiles?: number, maxBytes?: number }` aligned end-to-end across `@loopwright/core` (`limits.ts`), `@loopwright/agent-pi` (`candidate.ts`), `@loopwright/controller` (`verifier-protocol.ts`, `verification.ts`, `capture.ts`, `step.ts`, avoiding `HEADER_BYTES` overflow on `json-artifact.v1`), and `@loopwright/github-app`, plus per-gate endpoint credentials (`signingCredentialRef`, `authCredentialRef`, `url`) on `spec.verification.externalGates[]`.
- **Acceptance criteria**:
  - A `command.v1` script sourcing `./lib.sh`, reading `LOOPWRIGHT_STAGED_DIR`, and writing floating-point metrics to `LOOPWRIGHT_CHECK_OUT` passes in both `strict` (with `toolchainPaths`) and `privileged` modes and survives crash `reconcile()`.
  - `scope.writable: ['package.json', 'packages/*/package.json', 'docs/**']` permits edits to those exact files and `docs/**` while rejecting `packages/core/src/index.ts`.
  - `json-keys-guard.v1` and `line-section-guard.v1` fail deterministically on out-of-region edits and pass on in-region edits.
  - A `spec.limits.overlay: { maxFiles: 512, maxBytes: 16_777_216 }` run succeeds through `candidate.ts`, `step submit`, and `json-artifact.v1` without hitting `OUTPUT_LIMIT`.

#### 5. Live `spec.decisions` via `ControllerPorts.decisions` and Forward-Compatible Quantitative Verification Contracts (`@loopwright/core`, `@loopwright/controller`, `@loopwright/decisions`, `@loopwright/github-app`, `@loopwright/cli`)
- Wire `spec.decisions` without circular package dependencies:
  - Define zero-dependency `AdvisoryDecisionPort` on `ControllerPorts` in [`packages/controller/src/types.ts`](../packages/controller/src/types.ts) (preserving `@loopwright/controller`'s dependency set `{core, state, agent-pi}`).
  - Add optional `triageRules` to `spec.decisions` in [`packages/github-app/src/schema.ts`](../packages/github-app/src/schema.ts) (skipping `triageCandidateDiff` cleanly when empty instead of throwing `DECISION_BATCH_SIZE_INVALID`).
  - Instantiate `@loopwright/decisions` adapters in [`packages/github-app/src/action.ts`](../packages/github-app/src/action.ts) and [`packages/cli/src/main.ts`](../packages/cli/src/main.ts) and inject them into `ControllerPorts.decisions`, invoking the five existing allowed authority intents in [`packages/decisions/src/nodes.ts`](../packages/decisions/src/nodes.ts):
    1. `route_capability_tier` & `select_skills` during intake/role preparation (honoring pinned role models with `userOverridePreserved: true`).
    2. `evaluate_cycle_alignment` before repair/rework cycles.
    3. `advise_soft_compaction` prior to `pi.compact.v1` steps.
    4. `triage_candidate_diff` after candidate capture as an advisory pre-publication signal when `triageRules` are configured.
  - Enforce all six `DECISION_FORBIDDEN_AUTHORITY_INTENTS` strictly with deterministic fallback per `fallbackAction`.
- Forward-compatible quantitative verification upgrades in `@loopwright/core` and `@loopwright/controller`:
  - **Finite float admission + quantitative `metrics` & `findings`**: relax `snapshot()` in [`packages/core/src/boundary.ts`](../packages/core/src/boundary.ts) to accept finite floats (normalizing `-0` to `0`, refusing `NaN`/`Infinity`) while preserving `integer()` strictness on all existing integer fields. Add optional `metrics?: Readonly<Record<string, number | string | boolean>>` (bounded entry count and string lengths), `findings?: readonly StructuredFinding[]`, and optional `detail` on `Evidence` ([`packages/core/src/evidence.ts`](../packages/core/src/evidence.ts)), `SubmittedCheck`, and `EvaluatedCheck` ([`packages/core/src/acceptance.ts`](../packages/core/src/acceptance.ts)), allowed even when `status === 'passed'` (keeping `Evidence.spec.reason === null` on `passed`).
  - **Extensible `ArtifactRef`**: add optional `uri?: string | null` and `mediaType?: string | null` to `artifactRefSchema` in [`packages/core/src/contracts.ts`](../packages/core/src/contracts.ts), omitted from canonical serialization when unset so existing local CAS manifest digests stay identical.
  - **Unblock `target.matrix` metadata**: accept optional `spec.target.matrix` in `Taskpack`, allow non-null `task.spec.target.matrix` in [`packages/controller/src/compile.ts`](../packages/controller/src/compile.ts) whenever no check requires `'hardware_execution'`, and forward single-cell matrix bindings to `MemoryFinalizerConfig.targetMatrix` for platform-scoped memory isolation. Keep refusing `'hardware_execution'` check handlers with `CAPABILITY_UNSUPPORTED` and preserve the 23-row closure split (`18` `closedLocal`, `5` `unprovisionedExternal`).
  - **Unified verification result envelope**: standardize local check and external HMAC `gate.v1` outcomes around `{ status, reason, detail, metrics, findings, artifacts, retryablePreemption? }`, preparing for preemptible remote hardware benchmark queues.
- **Acceptance criteria**:
  - Passing `Evidence` and `VerificationResult` records carrying `metrics: { latency_us: 42.5, speedup: 1.18, delta: -0 }` normalize `-0` to `0`, reject `NaN`/`Infinity` with `VALUE_RANGE`, and round-trip cleanly through `gate.v1` -> `reconcile.ts` -> `evaluateValidated` -> `constructRunResult`.
  - A `Taskpack` declaring `spec.target.matrix` compiles cleanly when all checks use `local_execution` or `external_service`, forwards `targetMatrix` into memory finalization, and still refuses `'hardware_execution'` checks with `CAPABILITY_UNSUPPORTED`.
  - Enabling `spec.decisions` executes live decision nodes via `ControllerPorts.decisions` (and deterministic fallback when transport is unavailable) without introducing any package cycle or bypassing required verification gates.

#### 6. Repository Dogfooding Migration and Connected Documentation (`.auto-sync/`, `scripts/`, `docs/`, `site/`)
- Migrate [`.auto-sync/taskpack.yaml`](../.auto-sync/taskpack.yaml) to Taskpack 2.0 using `spec.preflight`, workspace-mounted `stagedResources` for lockfile and npm cache, `upstreamGroups` lockstep for `@earendil-works/pi-*`, directory-mounted `command.v1` with `toolchainPaths`, exact-file + explicit `/**` `scope`, and `mode: 'auto'`.
- Slim down [`scripts/prepare-self-upgrade.mjs`](../scripts/prepare-self-upgrade.mjs) by removing generic staging and `upstreamRecords.reason` path-smuggling glue now handled natively by Taskpack 2.0.
- Update [`docs/configuration/taskpack.md`](../docs/configuration/taskpack.md), [`docs/configuration/decision-routing.md`](../docs/configuration/decision-routing.md), [`docs/operations/github-action.md`](../docs/operations/github-action.md), [`docs/walkthroughs/declarative-taskpack.md`](../docs/walkthroughs/declarative-taskpack.md), and [`docs/README.md`](../docs/README.md), and rebuild `site/`.
- **Acceptance criteria**:
  - `npm run build`, `npm run typecheck`, `npm run lint`, `npm run lint:docs`, `npm run site`, `loopwright closure --verify-failures`, and `npm test` all pass cleanly.
  - Self-upgrade verification fixtures pass without smuggling filesystem paths through `upstreamRecords.reason`.

### Notes / Constraints / Caveats

- Strict ESM TypeScript (`NodeNext`), explicit exported public types, and zero `any` across all nine workspace packages.
- Validate all untrusted JSON/YAML inputs including null-prototype objects (`Object.create(null)`), enforce bounded `fstat` / `O_NOFOLLOW` file reads, and maintain deterministic serialization and sorting.
- Breaking legacy Taskpack v1 compatibility is explicitly accepted in favor of a clean Taskpack 2.0 contract; all in-repo fixtures, `taskpack-runner`, `failure-matrix.ts`, dogfooding files, and docs update in lockstep.
- Raising `@loopwright/state` checkpoint caps from `64` to `256` updates `schema.ts` (`CHECK(sequence BETWEEN 1 AND 256)`), `connection.ts` (`LIMIT 257`), `boundary.ts` (`checkpoints: 256`), and `checkpoint.ts` directly without a legacy `1..64` store migration path (approved by user).
- Keep `packages/memory` store and GC invariants intact (only pass `targetMatrix` through existing `MemoryFinalizerConfig` and keep `held_back` upstreams pinned to `currentVersion`).

### Boundaries

- **Always:**
  - Require dual-key authorization (manifest declaration + operator host/Action/CLI flag) for `mode: privileged` and `allowWorkflowWrites: true`.
  - Run `spec.preflight` strictly after actor authorization and `SecretScrubber` setup, stripping ambient Loopwright/provider/GitHub-App credentials.
  - Preserve SQLite lease fencing, monotonic clock guards, secret scrubbing, non-delegable decision authority, and `unknown` external-effect accounting across both `strict` and `privileged` modes.
  - Keep `.github/workflows/**` write-protected from agent sandboxes by default unless dual-key `allowWorkflowWrites: true` is granted.
  - Compute SHA-256 digests automatically at runtime (including whole-directory digests for directory-mounted `command.v1` checks) even when `pinDigests: false`.
  - Keep `npm run build`, `npm run typecheck`, `npm run lint`, `npm run lint:docs`, `npm run site`, and package test suites green.
- **Ask first:**
  - Before adding any new runtime npm dependency to any workspace package.
  - Before changing the 23-row capability closure split (`18` `closedLocal`, `5` `unprovisionedExternal`) in [`packages/cli/src/failure-matrix.ts`](../packages/cli/src/failure-matrix.ts) or `packages/cli/src/closure.ts`.
  - Before modifying SQLite table DDL in `packages/state` beyond the user-approved `checkpoints` `CHECK(sequence BETWEEN 1 AND 256)` ceiling update.
- **Never:**
  - Never allow `spec.decisions` to certify verification evidence, skip required reviews/gates, approve external gates, override pinned models, or grant execution authority.
  - Never import `@loopwright/decisions` inside `@loopwright/controller` (prevent workspace dependency cycle).
  - Never mount host `/var/run/docker.sock` or silently retry uncertain external publication side effects.
  - Never allow unbounded rework cycles or unvalidated path traversal/symlink escapes in `scope`, `preflight`, `command.v1`, or `stagedResources`.

### Risks and Mitigations

- **Self-granted privilege escalation from untrusted PR manifests** -> Mitigation: require dual-key operator unlock (`allow-privileged-execution`, `allow-workflow-writes` in Action/CLI) in addition to manifest opt-in; execute `preflight` strictly after actor authorization with forbidden credential env vars stripped.
- **Checkpoint and attempt exhaustion under 16-step or multi-rework pipelines** -> Mitigation: raise `@loopwright/state` checkpoint ceiling (`64 -> 256` across `schema.ts`, `connection.ts`, `boundary.ts`, `checkpoint.ts`), widen controller attempt/generation bounds, and index reworked verification phases by rework epoch.
- **Binary or large `stagedResources` crashing `agent-pi` UTF-8 system prompt loader** -> Mitigation: partition `stagedResources` into `mount: 'prompt'` (small UTF-8 text) vs `mount: 'workspace'` (hashed read-only disk artifacts, never concatenated into system prompts).
- **Overlay scaling overflowing `verifier-protocol.ts` `HEADER_BYTES` / `PACKET_BYTES`** -> Mitigation: align overlay bounds across `core/limits.ts`, `agent-pi/candidate.ts`, `controller/verifier-protocol.ts`, `controller/verification.ts`, `controller/capture.ts`, and `controller/step.ts`, and avoid embedding full manifests inside `HEADER_BYTES`.
- **Workspace circular dependency between `@loopwright/controller` and `@loopwright/decisions`** -> Mitigation: define zero-dependency `AdvisoryDecisionPort` on `ControllerPorts` and inject `@loopwright/decisions` adapters from `@loopwright/github-app` and `@loopwright/cli`.
- **Glob matching performance, lexical ambiguity, or OS sandbox incompatibilities** -> Mitigation: require explicit `/**` for recursive directories, restrict globs to single-segment `*`/`?`, pre-expand/translate globs cleanly in `sandbox.ts`, and test `.claude/skills -> ../.agents/skills` symlink preservation.
- **Existing test suite churn from non-backward-compatible Taskpack 2.0 fields** -> Mitigation: update shared fixtures in `github-app`, `taskpack-runner`, and `cli/failure-matrix.ts` at the start of each package task and verify every milestone green before moving on.

## Design Details

### Commands

**Confirmed build and test environment**: Local macOS (`Node v26.13.1`, `npm 11.20.0`, workspace root). Fresh Git worktrees must install dependencies (`npm ci`) before running build or test commands.

```bash
# Prerequisite in fresh worktrees without node_modules/
npm ci

# Build all nine workspace packages
npm run build

# Strict TypeScript check across source and tests
npm run typecheck

# ESLint check
npm run lint

# Documentation links, YAML examples, and Hugo site generation
npm run lint:docs
npm run site

# Compile tests and run targeted package suites
npx tsc -p tsconfig.test.json
node scripts/run-tests.mjs --pkg core
node scripts/run-tests.mjs --pkg state --concurrency 1
node scripts/run-tests.mjs --pkg agent-pi --concurrency 1
node scripts/run-tests.mjs --pkg controller
node scripts/run-tests.mjs --pkg decisions
node scripts/run-tests.mjs --pkg github-app
node scripts/run-tests.mjs --pkg taskpack-runner
node scripts/run-tests.mjs --pkg cli

# Full workspace test suite and 23-row closure verification
npm test
node packages/cli/dist/main.js closure --verify-failures --json
```

### Project Structure

```text
packages/
  core/src/
    boundary.ts           # Finite float admission (-0 -> 0, NaN/Infinity refused)
    contracts.ts          # TaskContract (+ role.resourceIds, step.onRework), ArtifactRef (+ uri/mediaType), StructuredFinding
    evidence.ts           # Evidence & SubmittedCheck (+ optional metrics/findings/detail on passed)
    acceptance.ts         # VerificationResult & EvaluatedCheck (+ metrics/findings/detail)
    scope.ts              # Exact-file, explicit /**, and bounded */? glob scope matching
    limits.ts             # Configurable overlay & schema ceilings
  state/src/
    schema.ts             # Raised checkpoints CHECK(sequence BETWEEN 1 AND 256)
    connection.ts         # Raised checkpoints load query LIMIT 257
    boundary.ts           # Raised STATE_LIMITS.checkpoints 64 -> 256
    checkpoint.ts         # Raised 64 -> 256 checkpoint sequence/count bounds
  agent-pi/src/
    host-session.ts       # Per-role MCP server/tool allowlist enforcement before callTool
    candidate.ts          # Configurable overlay maxFiles/maxBytes/manifest caps
    resources.ts          # Strict UTF-8 prompt-mounted resource loader
  controller/src/
    compile.ts            # Unblock target.matrix metadata, validate rejectTo DAG, 256-checkpoint scaling
    controller.ts         # Targeted subgraph rework execution, AdvisoryDecisionPort hooks, per-role resources
    step.ts               # Coroutine parity: StepVerdict, rework resets, StepYield MCP, overlay & scope alignment
    scheduler.ts          # Subgraph reset helpers and rework epoch scheduling
    progress.ts           # Per-node submissions, StepVerdict tracking, rework epochs, widened attempt caps
    submission.ts         # Separate StepVerdict parser alongside Submission v1
    verification.ts       # Unified verification envelope, wide overlay prep, json-keys-guard.v1, line-section-guard.v1
    verifier-protocol.ts  # Wide overlay inventory framing & built-in structural guard evaluation
    handlers.ts           # Built-in handler registry including json-keys-guard.v1 & line-section-guard.v1
    gate.ts               # HMAC-signed gate_verdict carrying metrics/findings/detail/retryablePreemption
    reconcile.ts          # Crash recovery preserving extended HMAC gate_verdict fields
    types.ts              # AdvisoryDecisionPort, StepVerdict, StructuredFinding, ReworkPolicy
  decisions/src/
    nodes.ts              # Five allowed authority-safe advisory decision nodes
    types.ts              # Allowed vs forbidden authority intent guards
  github-app/src/
    types.ts              # Taskpack 2.0 manifest, execution trust modes, preflight, steps, upstreamGroups, vars
    schema.ts             # Taskpack 2.0 YAML parser, dual-key validation, post-parse spec.vars AST interpolation
    digests.ts            # Runtime file/directory SHA-256 hashing & digests.lock.json read/write/verify
    preflight.ts          # Authorized host preflight runner, credential stripping, prompt/workspace staging
    upstreams.ts          # held_back status, JSONPath versionPath, monotonicSemver, upstreamGroups, proposal-optional
    taskpack.ts           # Taskpack 2.0 -> TaskContract compiler, per-role isolation, target.matrix -> memory
    turnkey.ts            # Directory-mounted command.v1, toolchainPaths, read-only .git, CHECK_OUT, step parity
    sandbox.ts            # */? glob expansion/translation for bwrap/Seatbelt/Landlock
    action.ts             # Dual-key host unlock, mode: auto, preflight dispatch, live spec.decisions wiring
    service.ts            # Multi-tenant refusal of self-granted privileged capabilities
  taskpack-runner/src/
    compile-taskpack.ts   # Taskpack 2.0 runner parity (explicit /** scopes, optional proposal, .agents opt-in)
  cli/src/
    main.ts               # loopwright digest sync [--check], --allow-privileged / --allow-workflow-writes, decisions wiring
    arguments.ts          # CLI argument parsing for digest sync & privilege flags
    failure-matrix.ts     # Updated Taskpack 2.0 scenarioThirteen + dual-key & spec.vars probes
action.yml                # mode: auto, allow-privileged-execution, allow-workflow-writes inputs
.auto-sync/
  taskpack.yaml           # Dogfooding self-upgrade migrated to Taskpack 2.0
scripts/
  prepare-self-upgrade.mjs # Slimmed domain-only preflight helper
docs/ & site/             # Updated Taskpack 2.0, decisions, and GitHub Action documentation
```

### Code Style

Follow strict ESM `NodeNext` TypeScript with explicit public boundary types, zero `any`, null-prototype validated objects, and deterministic error codes (excerpt style matching [`packages/core/src/evidence.ts`](../packages/core/src/evidence.ts)):

```ts
import {
  artifactRefSchema, arrayOf, checkStatus, document, evidenceLevel,
  identifier, nullable, record, text, type Infer,
} from './contracts.js';
import { fail } from './diagnostics.js';
import { unique } from './graph.js';
import { subjectSchema } from './identity.js';
import { LIMITS } from './limits.js';
import type { Json } from './boundary.js';

export type MetricValue = number | string | boolean;

const evidenceShape = document('Evidence', record({
  checkId: identifier,
  observedStatus: checkStatus,
  producerId: identifier,
  method: identifier,
  level: evidenceLevel,
  subject: subjectSchema,
  artifacts: arrayOf(artifactRefSchema, 0, LIMITS.manifest),
  reason: nullable(text()),
}));

export type Evidence = Infer<typeof evidenceShape>;
```

Key conventions:
- Validate every untrusted record with strict field allowlists and `Object.create(null)` outputs.
- Normalize `-0` to `0` and reject non-finite numbers (`NaN`, `Infinity`) in `snapshot()` and `metrics`; keep `integer()` strict on every integer schema field.
- Omit unset optional fields (`ArtifactRef.uri`, `ArtifactRef.mediaType`) from canonical JSON so local CAS manifest digests stay deterministic.
- Keep all file reads bounded with `fstat` checks and symlink rejection (`O_NOFOLLOW`) outside explicitly mounted workspace trees.
- Scrub all secrets from logs, diagnostics, findings, and step summaries before persistence or output.

### Implementation Plan

> Parallel execution waves (disjoint `Owns:`, runnable via `my-build <title> team`):
> - Wave 1: `T1 || T2`
> - Wave 2: `T3 || T6`
> - Wave 3: `T4 || T7`
> - Wave 4: `T5`
> - Wave 5: `T8`
> - Wave 6: `T9 || T10`
> - Wave 7: `T11`
> - Wave 8: `T12`

- [x] **T1 · `@loopwright/core` extensible contracts, finite float metrics, `ArtifactRef`, and glob `scope`**
      Blocked by: None
      Owns: `packages/core/src/**`, `packages/core/test/**`
      Gate: review
      Acceptance: `snapshot()` admits finite floats (`-0` normalized to `0`, `NaN`/`Infinity` refused) while keeping `integer()` strict on all integer fields; `Evidence`, `SubmittedCheck`, and `EvaluatedCheck` accept optional `metrics`, `findings`, and `detail` on `passed` outcomes while preserving `reason === null` on `Evidence`; `ArtifactRef` adds optional `uri` and `mediaType` omitted from canonical JSON when unset; `TaskContract` adds optional per-role `resourceIds` and per-step `onRework`; `scope.ts` supports exact paths, explicit `/**` directories, and bounded single-segment `*`/`?` globs; `limits.ts` supports configurable overlay ceilings.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg core`

- [x] **T2 · `@loopwright/state` checkpoint ceiling expansion (`64 -> 256`)**
      Blocked by: None
      Owns: `packages/state/src/**`, `packages/state/test/**`
      Gate: review
      Acceptance: `schema.ts` (`CHECK(sequence BETWEEN 1 AND 256)` and wide overlay `input_json`/`checkpoint_json` caps), `connection.ts` (`LIMIT 257`), `boundary.ts` (`checkpoints: 256` plus contract-scoped overlay bounds), and `checkpoint.ts` (forwarding `budgets.overlay` into `validateDocument(..., 'ArtifactManifest', ...)`) raise checkpoint ceilings from `64` to `256` (no legacy `1..64` migration path), persist `512`-file overlay `candidateManifest` checkpoints cleanly under lease fencing, and fail closed at `#257` with `LIMIT_EXCEEDED`.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg state --concurrency 1`

- [x] **T3 · `@loopwright/agent-pi` per-role MCP allowlist enforcement and configurable overlay limits**
      Blocked by: T1
      Owns: `packages/agent-pi/src/**`, `packages/agent-pi/test/**`
      Gate: review
      Acceptance: `host-session.ts` enforces per-role MCP server/tool allowlists before calling `mcpRegistry.callTool` (blocking unauthorized tool calls even if crafted by a read-only role); `candidate.ts` accepts configurable overlay `maxFiles`/`maxBytes`/manifest ceilings; `resources.ts` validates UTF-8 prompt-mounted resources cleanly without decoding workspace-staged binaries.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg agent-pi --concurrency 1`

- [x] **T4 · `@loopwright/controller` DAG orchestration, `target.matrix`, `rejectTo` rework, `StepVerdict`, and `AdvisoryDecisionPort`**
      Blocked by: T1, T2, T3
      Owns: `packages/controller/src/{compile,controller,step,scheduler,progress,submission,repair,capture,source,types,config,events,report,index}.ts`, `packages/controller/test/{compile,controller,step-engine,scheduling-budget,recovery}*.test.ts`
      Gate: review
      Acceptance: `compile.ts` allows non-null `target.matrix` when no check requires `hardware_execution`, validates `rejectTo` strict-ancestor edges and `maxReworks` (`1..8`), and scales checkpoint/attempt budgets up to 256 checkpoints; `controller.ts`, `step.ts`, and `progress.ts` separate per-node `Submission` from `StepVerdict` (`pass|rework|fail|human` + `findings`), reset only `[rejectTo, ...descendants]` with rework-epoch verifier phasing (handling unchanged `candidateDigest` cleanly), halt deterministically as `blocked` on `human` or `reworkCount > maxReworks`, filter resources per `role.resourceIds`, align `.agents/**` and host-gated `.github/workflows/**` protection, expose zero-dependency `AdvisoryDecisionPort` on `ControllerPorts`, and maintain full `loopwright step` parity (including `StepYield` MCP metadata).
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg controller`

- [x] **T5 · `@loopwright/controller` HMAC `gate_verdict` metrics/findings, wide overlay packets, and built-in structural guards**
      Blocked by: T1, T4
      Owns: `packages/controller/src/{verification,verifier-protocol,verifier-worker,handlers,gate,reconcile,acceptance,refusal-record}.ts`, `packages/controller/test/{verification,gate,reconcile,guards}*.test.ts`
      Gate: review
      Acceptance: `gate.ts` and `reconcile.ts` HMAC-sign and verify bounded `metrics`, `findings`, `detail`, and `retryablePreemption?` on `gate_verdict` (including `approved` verdicts) and propagate them into `Evidence` and `EvaluatedCheck`; `verifier-protocol.ts` and `verification.ts` handle large overlays (>128 files / >4 MiB up to configured ceiling) without overflowing `HEADER_BYTES` on `json-artifact.v1`; built-in `json-keys-guard.v1` and `line-section-guard.v1` verify candidate edits against authenticated baseline proofs inside isolated workers while keeping `installedHandlerDigests()` within file/byte caps.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg controller`

- [x] **T6 · `@loopwright/github-app` Taskpack 2.0 schema, trust modes, `spec.vars` AST interpolation, and digest lockfile helpers**
      Blocked by: T1
      Owns: `packages/github-app/src/{types,schema,digests}.ts`, `packages/github-app/test/{schema,digests}*.test.ts`
      Gate: review
      Acceptance: `schema.ts` validates Taskpack 2.0 (`spec.execution`, `spec.preflight`, `spec.upstreamGroups`, `spec.steps`, per-role assets/MCP/models, optional `spec.proposal`, `spec.submission`, `spec.target.matrix`, `spec.limits.overlay`, `spec.vars`, per-gate credentials, `spec.decisions.triageRules`); post-parse AST validation resolves declared `${VAR}` only in allowed fields and still refuses undeclared/secret `${...}` with `TASKPACK_UNTRUSTED_INTERPOLATION`; `digests.ts` computes deterministic SHA-256 digests for single files and mounted check directories (rejecting escaping symlinks) and reads/writes/verifies `digests.lock.json`.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node --test .test-build/packages/github-app/test/schema*.test.js .test-build/packages/github-app/test/digests*.test.js`

- [x] **T7 · `@loopwright/github-app` host `spec.preflight` runner and resilient `upstreams` / `upstreamGroups`**
      Blocked by: T6
      Owns: `packages/github-app/src/{upstreams,preflight}.ts`, `packages/github-app/test/{upstreams,preflight}*.test.ts`
      Gate: review
      Acceptance: `preflight.ts` executes repo-relative preflight scripts only after auth/scrubber setup, strips forbidden ambient credentials (`GITHUB_TOKEN`, `LOOPWRIGHT_*`, provider keys) even under `allowHostEnv`, parses bounded `LOOPWRIGHT_PREFLIGHT_OUT` JSON, hashes `stagedResources`, and partitions `mount: 'prompt'` vs `mount: 'workspace'`; `upstreams.ts` supports `'held_back'`, `http-json` `versionPath` + `monotonicSemver`, `watchedPaths`, atomic `lockstep` `upstreamGroups`, and proposal-optional baseline discovery.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node --test .test-build/packages/github-app/test/upstreams*.test.js .test-build/packages/github-app/test/preflight*.test.js`

- [x] **T8 · `@loopwright/github-app` Taskpack 2.0 compiler, directory-mounted `command.v1`, sandbox globs, and live `spec.decisions` / `action.yml`**
      Blocked by: T4, T5, T6, T7
      Owns: `packages/github-app/src/{taskpack,turnkey,action,sandbox,service,turnkey-memory,index}.ts`, `action.yml`, `packages/github-app/test/{taskpack-intake,control-plane-action,turnkey,mcp-repair-budgets}*.test.ts`
      Gate: review
      Acceptance: `taskpack.ts` compiles Taskpack 2.0 (`spec.steps`, per-role `resourceIds`/`mcpServers`/`models`, optional `proposal`, `submission.path`, `target.matrix` -> `MemoryFinalizerConfig.targetMatrix`, `held_back` memory key exclusion, check-only `no-change` contracts, structural guards); `action.yml`, `action.ts`, and `service.ts` enforce dual-key operator unlock (`allow-privileged-execution`, `allow-workflow-writes`), run `preflight` only after actor auth, and support `mode: 'auto'`; `turnkey.ts` mounts check script parent directories read-only with tree-digest verification, supports `toolchainPaths`/`allowHostPath`/`mountReadOnlyGit`/`LOOPWRIGHT_BASE_DIR`/`LOOPWRIGHT_STAGED_DIR`/`preserveRepoDirName` (nested `<tmp>/<sanitizedBasename>`), ingests `LOOPWRIGHT_CHECK_OUT` into signed `gate_verdict`, and achieves `loopwright step` parity; `sandbox.ts` translates `*`/`?` globs cleanly; `action.ts` wires live `@loopwright/decisions` adapters into `ControllerPorts.decisions` with deterministic fallback and non-delegable authority enforcement.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg github-app`

- [x] **T9 · `@loopwright/taskpack-runner` Taskpack 2.0 runner parity alignment**
      Blocked by: T5, T8
      Owns: `packages/taskpack-runner/src/**`, `packages/taskpack-runner/test/**`
      Acceptance: `compile-taskpack.ts` and runner tests align with Taskpack 2.0 explicit `/**` scopes, opt-in `.agents/**`, optional `spec.proposal`, and extensible `Evidence` metrics/findings with full offline runner parity.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg taskpack-runner`

- [x] **T10 · `@loopwright/cli` `digest sync`, host privilege flags, and 23-row closure / failure-matrix alignment**
      Blocked by: T8
      Owns: `packages/cli/src/**`, `packages/cli/test/**`
      Gate: review
      Acceptance: `loopwright digest sync --taskpack <path> [--check]` generates and verifies `digests.lock.json`; CLI supports `--allow-privileged` and `--allow-workflow-writes` opt-in flags and wires `ControllerPorts.decisions`; `failure-matrix.ts` updates `scenarioThirteen` to Taskpack 2.0 and adds dual-key privilege & `spec.vars` negative probes while `loopwright closure --verify-failures` passes with `18` `closedLocal` and `5` `unprovisionedExternal`.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg cli`

- [x] **T11 · Dogfooding migration (`.auto-sync/taskpack.yaml` and slim `scripts/prepare-self-upgrade.mjs`)**
      Blocked by: T8, T10
      Owns: `.auto-sync/**`, `.github/workflows/auto-sync.yml`, `scripts/prepare-self-upgrade.mjs`, `packages/github-app/test/self-upgrade-*.ts`
      Gate: review
      Acceptance: `.auto-sync/taskpack.yaml` uses Taskpack 2.0 (`spec.preflight`, workspace-mounted `stagedResources` for lockfile and npm cache, `upstreamGroups` lockstep for `@earendil-works/pi-*`, directory-mounted `command.v1` + `toolchainPaths`, exact-file + explicit `/**` scope, `mode: 'auto'`); `scripts/prepare-self-upgrade.mjs` removes staging/reason-smuggling glue; `.claude/skills -> ../.agents/skills` symlink passes `freezeSource`; all self-upgrade fixtures pass cleanly.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node --test .test-build/packages/github-app/test/self-upgrade-*.test.js`

- [x] **T12 · Connected documentation, Hugo site rebuild, and full workspace gate**
      Blocked by: T9, T10, T11
      Owns: `docs/**`, `site/**`, `README.md`
      Acceptance: `docs/configuration/taskpack.md`, `docs/configuration/decision-routing.md`, `docs/operations/github-action.md`, `docs/walkthroughs/declarative-taskpack.md`, and `docs/README.md` document Taskpack 2.0 following repository docs standards (80% ASD-STE100 and Macro + Micro Pretty YAML); `site/` rebuilds cleanly and the entire 9-package build, typecheck, lint, docs, site, and test suite passes.
      Verify: `npm run build && npm run typecheck && npm run lint && npm run lint:docs && npm run site && npm test`

### Test Plan
[ ] I/we understand the owners of the involved components may require updates to existing tests to make this
code solid enough prior to committing the changes necessary to implement this enhancement.

#### Prerequisite testing updates
- Install workspace dependencies in fresh worktrees (`npm ci`) before compiling TypeScript or running tests.
- Update shared v1 Taskpack fixtures and builders in `packages/github-app/test/`, `packages/taskpack-runner/test/`, and `packages/cli/src/failure-matrix.ts` (`scenarioThirteen`) to explicit `/**` directory scopes and Taskpack 2.0 schema fields before adding new behavioral tests.

#### Unit tests
- `@loopwright/core`: `2026-11-19` - target >= 90% on changed files (`boundary.ts` float `-0`/finite/NaN/Infinity, `evidence.ts` & `acceptance.ts` passing `metrics`/`findings`/`detail`, `contracts.ts` `ArtifactRef.uri` canonical omission & `onRework` schema, `scope.ts` exact paths, explicit `/**`, `*`/`?` globs, and traversal/reserved-name rejection).
- `@loopwright/state`: `2026-11-19` - target >= 90% on `schema.ts`/`connection.ts`/`boundary.ts`/`checkpoint.ts` (checkpoints #1–#256 persistence, lease fencing, reopen & append past #64, refusal at #257).
- `@loopwright/agent-pi`: `2026-11-19` - target >= 90% on `host-session.ts` (per-role MCP allowlist enforcement), `candidate.ts` (configurable overlay caps), and `resources.ts` (UTF-8 prompt resource guard).
- `@loopwright/controller`: `2026-11-19` - target >= 85% on changed files (`compile.ts` `target.matrix` unblock & `hardware_execution` refusal, `rejectTo` strict-ancestor validation; `scheduler.ts`/`progress.ts`/`controller.ts`/`step.ts` targeted subgraph resets, unchanged-digest rework epoch, `StepVerdict` vs `Submission` separation, `maxReworks` `blocked` stop; `gate.ts`/`reconcile.ts` signed `metrics`/`findings`/`detail`; `verifier-protocol.ts` wide overlays & `json-keys-guard.v1` / `line-section-guard.v1`).
- `@loopwright/github-app`: `2026-11-19` - target >= 85% on changed files (`schema.ts` dual-key trust modes & `spec.vars` AST interpolation vs `TASKPACK_UNTRUSTED_INTERPOLATION`; `digests.ts` file/tree hashing & symlink refusal; `preflight.ts` env stripping & `prompt`/`workspace` staging; `upstreams.ts` `held_back`, `versionPath`, `monotonicSemver`, `lockstep` `upstreamGroups`; `turnkey.ts` directory-mounted `command.v1`, `lib.sh`, `toolchainPaths`, `LOOPWRIGHT_CHECK_OUT`, `preserveRepoDirName`; `sandbox.ts` glob mounts; `action.ts` `mode: 'auto'` & live `spec.decisions` fallback).
- `@loopwright/taskpack-runner`: `2026-11-19` - target >= 85% on `compile-taskpack.ts` (Taskpack 2.0 offline runner parity).
- `@loopwright/cli`: `2026-11-19` - target >= 85% on `main.ts` (`digest sync [--check]`, `--allow-privileged`, `--allow-workflow-writes`) and `failure-matrix.ts`.

#### Integration tests
- **Untrusted manifest self-privilege refusal**: `taskpack.yaml` declaring `mode: privileged`, `allowWorkflowWrites: true`, or `spec.preflight` without operator host flags fails closed before running `preflight.script`; unauthorized `issue_comment` never runs `preflight`; ambient `GITHUB_TOKEN`/`LOOPWRIGHT_*` keys stay stripped even with `allowHostEnv: true`.
- **Preflight + binary/large `stagedResources` + lockstep `held_back`**: stage `>100 KiB` lockfile and binary `.tgz` via `mount: 'workspace'` and a text note via `mount: 'prompt'`; verify `agent-pi` never decodes binary files into `systemPrompt`, `command.v1` reads `LOOPWRIGHT_STAGED_DIR`, and one `held_back` lockstep group does not block sibling `available` upstreams or poison reviewed memory keys.
- **Interleaved DAG + `rejectTo` rework + crash recovery**: run `plan -> implement -> docs -> fast-check -> review (rejectTo: implement, maxReworks: 2)` across both `controller.ts` and `loopwright step`; verify `plan` never re-runs, `implement -> docs -> fast-check -> review` re-runs with injected findings (including unchanged-digest rework and simulated crash + `reconcile()`), and exceeding `maxReworks` halts as `blocked`.
- **Per-role MCP & instruction isolation**: Role A (`mcpServers: [srvA]`, `instructions: [a.md]`) and read-only Role B (`mcpServers: []`, `instructions: [b.md]`) across both GitHub Action and `loopwright step` confirm Role B never sees `a.md` and cannot invoke `mcp__srvA__*`.
- **Large overlay + built-in structural guards + `LOOPWRIGHT_CHECK_OUT`**: run `spec.limits.overlay: { maxFiles: 512, maxBytes: 16_777_216 }` through `candidate.ts`, `step submit`, `json-artifact.v1`, `json-keys-guard.v1`, `line-section-guard.v1`, and directory-mounted `command.v1` sourcing `./lib.sh` and emitting floating-point metrics via `LOOPWRIGHT_CHECK_OUT` through HMAC `gate.v1` -> `evaluateAcceptance` -> `constructRunResult`.
- **Live `spec.decisions` wiring & non-delegable authority**: verify `routeTaskCapability`, `evaluateCycleAlignment`, `adviseSoftCompaction`, and `triageCandidateDiff` execute via `ControllerPorts.decisions` (and fall back cleanly when transport fails) while `DECISION_FORBIDDEN_AUTHORITY_INTENTS` remain hard-refused.

#### e2e tests
- **Self-upgrade dogfooding e2e (`packages/github-app/test/self-upgrade-*.test.ts`)**: run `.auto-sync/taskpack.yaml` + slimmed `scripts/prepare-self-upgrade.mjs` under `mode: 'auto'` (both `candidate` with lockstep `@earendil-works/pi-*` staged resources and `no-change` check-only short-circuit) with `.claude/skills -> ../.agents/skills` symlink present and zero path smuggling in `upstreamRecords.reason`.
- **Capability closure & docs/site e2e**: execute `loopwright closure --verify-failures` (`18` `closedLocal`, `5` `unprovisionedExternal`, exit `0`), `npm run lint:docs`, `npm run site`, and `npm test`.

## Alternatives

1. **Modeling `preflight` as an ordinary `script` step inside `spec.steps`**:
   - *Rejected*: Preflight must determine run disposition (`candidate` vs `no_change` vs `blocked`), resolve `held_back` upstreams, and freeze read-only staged context *before* compiling an immutable `TaskContract` and allocating controller leases or model budgets. Keeping `preflight` in the intake phase preserves `TaskContract` immutability while mid-pipeline deterministic commands remain `check` steps in `spec.steps`.
2. **Allowing `taskpack.yaml` alone to self-grant `mode: privileged` or `allowWorkflowWrites`**:
   - *Rejected*: Treating untrusted PR/branch manifest edits as sufficient authority for host execution or `.github/workflows/**` writes creates severe supply-chain risk. Requiring dual-key unlock (manifest declaration + operator host/Action/CLI flag) removes daily friction in trusted repos while preserving zero-trust defaults.
3. **Importing `@loopwright/decisions` directly inside `@loopwright/controller`**:
   - *Rejected*: `@loopwright/decisions` already depends on `@loopwright/controller`, so importing it back creates a workspace build cycle and bloats `installedHandlerDigests()`. Injecting `@loopwright/decisions` adapters through `ControllerPorts.decisions` keeps package boundaries acyclic.
4. **Coalescing controller checkpoints instead of raising `@loopwright/state` `64 -> 256` cap**:
   - *Rejected*: Coalescing pre/post checkpoints blurs crash-recovery boundaries around external effects and tool execution. Raising the numeric ceiling across `schema.ts`/`connection.ts`/`boundary.ts`/`checkpoint.ts` (`64 -> 256`) preserves crash-recovery granularity cleanly.
5. **Flat attempt-level retries without `rejectTo` targeted rework**:
   - *Rejected*: Re-running the entire pipeline from the first role wastes tokens when a late review rejects an implementation step, and fails to deliver structured findings to the responsible role. Bounded subgraph resets via `onRework.rejectTo` give precise quality feedback with deterministic stopping bounds.
6. **Adding multi-generation `CampaignStore` SQLite tables and remote GPU runner stubs now**:
   - *Rejected*: Guessing remote queue schemas before hardware runner validation creates throwaway migration debt. Landing only stable data-plane contract extensions (`metrics`, `findings`, `ArtifactRef.uri`, `target.matrix`, unified verification envelope) now prepares future hardware runners and multi-generation campaign controllers cleanly with zero dead code.

## Open Questions

None. All architectural forks, package boundaries, security dual-key gates, checkpoint ceilings, and test targets are resolved for implementation.
