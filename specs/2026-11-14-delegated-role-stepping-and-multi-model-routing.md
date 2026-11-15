# Spec: Delegated Role Stepping and Multi-Model Routing

Status: Shipped
Type: Feature

## Summary

Add a resumable coroutine step engine (`loopwright step`), a zero-credential `delegated` role adapter, and runtime per-role model binding overrides across Managed Controller and Declarative Taskpack modes. External OAuth coding agents (Antigravity, Claude Code, Codex, and Pi) pull leased role assignments, dispatch role-specific models, and submit candidate edits through Loopwright's deterministic verification and repair gates without configuring Loopwright provider API keys.

## Motivation

### Goals

- Let external OAuth coding agents drive `.loopwright/taskpack.yaml` and `controller.yaml` pipelines through deterministic CLI step commands with zero Loopwright LLM API tokens.
- Decouple logical task roles from concrete model selections so operators can assign distinct models per role (for example, `gemini-4-carbon` on Role A and `gemini-4-argon` on Role B) via configuration or `--role-model` CLI flags without rewriting `TrustedRegistry` SHA-256 digests.
- Support optional multi-role declarations in `Taskpack` (`spec.roles`, `1..4` roles) that compile into the same `ControllerConfig` DAG used by Managed Controller runs.
- Preserve SQLite WAL lease fencing, `scope.v1` blacklist-wins path enforcement, `json-artifact.v1`, `no-change.v1`, `gate.v1`, local `command.v1` verification, and bounded repair loops across coroutine step boundaries.
- Ship a thin, vendor-neutral repository skill (`.agents/skills/loopwright-step/SKILL.md`) and synchronized documentation so coding agents can adopt the workflow from local checkouts or `llms.txt`.

### Non-Goals

- Modifying public schemas or limits in [`packages/core/src/contracts.ts`](../packages/core/src/contracts.ts) or [`packages/state/src/index.ts`](../packages/state/src/index.ts), or altering the 23-row Capability Closure Matrix counts (`18` `closed_local`, `5` `unprovisioned_external`).
- Embedding vendor-specific Push CLI process spawners, interactive OAuth browser flows, or TUI folder-trust automation inside `@loopwright/controller`.
- Treating host-reported token counts from external OAuth sessions as provider-attested billing (`provenance` must never be `reported`).
- Enabling `adapter: delegated` inside unattended batch `loopwright run` or the GitHub Actions entrypoint without an external step driver.

## Proposal

Loopwright separates deterministic workflow authority from role execution. A run declares one or more roles using either `adapter: pi` (unattended HTTP token execution) or `adapter: delegated` (external host execution), with optional per-role model overrides supplied in `ControllerConfig` or on the CLI. When an external coding agent or orchestrator invokes `loopwright step next`, Loopwright advances all ready deterministic checks and yields a leased role work order whenever a `delegated` role is reached. The host agent executes that role in the materialized candidate directory using the assigned model, then calls `loopwright step submit` with the single-use lease token to capture the diff, run independent checks, and receive either the next role work order or the settled run result.

### User Stories

#### Story 1

As a repository maintainer, I want to run `.loopwright/taskpack.yaml` upstream discovery, candidate staging, and deterministic local checks (`scope.v1`, `json-artifact.v1`, `command.v1`) via `loopwright` CLI without configuring provider API keys, so that my local OAuth coding agent enforces the exact same gates as CI.

#### Story 2

As a workflow orchestrator, I want to decouple logical role slots (such as `role-a` and `role-b`) from concrete model bindings and assign distinct models per role (including mixing `delegated` OAuth models and `pi` token models), so that Managed Controller and multi-role Taskpack DAGs enforce budgets, independent checks, and bounded repairs across multi-model teams.

#### Story 3

As a Codex, Claude Code, Pi, or Antigravity user, I want a concise reusable skill that drives `loopwright step next` and `loopwright step submit`, so that my agent can execute single-role or multi-role Loopwright pipelines without custom glue scripts.

### Core Features & Acceptance Criteria

1. **Delegated Role Profile & Per-Role Model Overrides**
   - `TrustedRegistry.spec.roleProfiles[]` in [`packages/controller/src/registry.ts`](../packages/controller/src/registry.ts) accepts optional `adapter: 'pi' | 'delegated'` (default `'pi'`).
   - When `adapter` is `'delegated'`, `providerCredentialRef` must be `null`, `runtimeRef` may be `null`, `mcp` may be `null`, `context` may be omitted (defaulting to a bounded `estimated_guard` descriptor), and `selection` (`provider`, `model`, `thinking`) accepts any valid `@loopwright/core` `label` (`1..128` non-whitespace characters) without requiring Pi catalog registration or Docker runtime paths. `compilePlan` rejects `pi.compact.v1` on `delegated` roles with `CAPABILITY_UNSUPPORTED`.
   - `ControllerConfig.spec.profiles.roles[]` in [`packages/controller/src/config.ts`](../packages/controller/src/config.ts) accepts optional `selection: { provider, model, thinking? }` overrides for bound roles.
   - CLI commands `check`, `run`, `resume`, and `step` accept up to 8 repeatable `--role-model <roleId>=<provider>/<model>[:<thinking>]` flags (`argv` ceiling `64`). Unknown `roleId` values or malformed specifications fail closed with `CONFIG_REFERENCE` or `CLI_USAGE`. For `adapter: 'pi'` roles, overrides still validate against [`packages/agent-pi/src/catalog.ts`](../packages/agent-pi/src/catalog.ts) and credential destinations.
   - Effective per-role `selection` overrides apply inside `loadConfiguration` before `admitTask` computes `TaskLock`, and persist inside `run.json` so subsequent `step submit`, `resume`, and `reconcile` invocations reconstruct the identical `planDigest` without re-passing `--role-model` or mutating `registry.yaml`.
   - Calling unattended `loopwright run` on a plan with an active `delegated` role, or calling `loopwright resume` while a run is parked at a `delegated` `awaiting_role`, fails closed with `CAPABILITY_UNSUPPORTED` (exit `3`).

2. **Declarative Taskpack Multi-Role (`1..4`) & Delegated Compilation**
   - `Taskpack` (`kind: Taskpack`) accepts optional `spec.roles[]` (`1..4` unique entries, bounded so [`packages/controller/src/compile.ts`](../packages/controller/src/compile.ts) checkpoint capacity `D <= 64` holds). Each entry declares `id` (disjoint from check IDs), optional `purpose: 'task' | 'review'` (default `'task'`), `provider`, `model`, optional `thinking` (default `'medium'`), optional `tools` subset of `['read', 'write', 'edit', 'bash', 'delete']`, and optional acyclic `dependsOn` over prior role IDs.
   - Sink roles of `spec.roles[]` wire into `checks[0].dependsOn`. Omitting `spec.roles` preserves existing single-`author` compilation from `spec.models`.
   - `compileDeclarativeTaskpack` in [`packages/github-app/src/taskpack.ts`](../packages/github-app/src/taskpack.ts) supports `executionMode: 'delegated'`, bypassing Pi catalog model lookups and provider secret requirements while preserving `scope.v1`, `json-artifact.v1`, `no-change.v1`, local `command.v1` check gates, upstream discovery inputs, and dynamic `controls.maxAttempts` within `D <= 64` (failing closed with `TASKPACK_MANIFEST_INVALID` if checks + roles + repairs exceed `64`).

3. **Coroutine Step Engine (`loopwright step`)**
   - `loopwright step next|submit|cancel` (positional subaction or `--action`) emits standard v1 NDJSON `Envelope` records and preserves exit codes (`0`, `2..8`, `130`, `143`).
   - `step next` accepts either Managed Controller flags (`--config`, `--registry`, `--registry-sha256`) or turnkey Taskpack flags (`--taskpack`), plus `--repo`, `--run-root`, `--run-id`, optional repeatable `--role-model`, optional `--mode candidate|no-change`, optional `--reissue-lease`, and `--json`.
   - For `--taskpack`, `step next` stages `<runRoot>/.taskpack-<runId>/{config/controller.yaml,registry/registry.yaml,secrets.json}` (`0o700`, outside `<runDir>`), keeping a canonical loopback URL in `registry.yaml` so `registrySha256` stays constant across ticks while passing the live ephemeral `127.0.0.1` listener URL through internal `ControllerPorts.gateUrlOverrides`.
   - When the next ready node (or bounded `format` / `implementation` repair) binds an `adapter: delegated` role, `step next` records `role.<ordinal>.pre`, materializes `<runRoot>/workspaces/<runId>/<attemptId>/{candidate,context}` (`0o700`, outside `<runDir>`; `writable` baseline files `0o600`, `protected` files `0o400`), mints a single-use random `leaseToken` whose SHA-256 digest is persisted in run progress, suspends [`packages/controller/src/events.ts`](../packages/controller/src/events.ts) via `ControllerEvents.suspend()` without sealing `controller-events.open`, releases `ControllerOwner`, and returns `{ kind: 'step', status: 'awaiting_role', runId, attemptId, stepId, roleId, purpose, repair, selection, allowedTools, scope, candidateDir, contextFiles, prompt, submissionMode, leaseToken }` (exit `0`). Calling `step next` while already `awaiting_role` refuses with `OWNER_BUSY` (exit `7`) unless `--reissue-lease` rotates the lease digest without touching `candidateDir`.
   - `step submit` (`--run-root`, `--run-id`, `--lease <token>`, optional `--submission-file <path>`, optional `--status completed|no_change|failed|blocked`, optional `--reason <text>`, `--json`) verifies the single-use `leaseToken` (`AUTHORITY_REFUSED` exit `7` on stale/replayed tokens). Before mutating `LocalRunStore`, it validates `candidateDir` with `lstat` / `O_NOFOLLOW` (rejecting symlinks, hardlinks `nlink > 1`, non-regular files, invalid filenames, `> 128` overlay files, or `> 4 MiB` overlay bytes so recoverable workspace noise does not burn the lease) and refuses candidate digest mutations when `repair === 'format'` or `allowedTools` exclude mutating tools (`write`, `edit`, `delete`, `bash`).
   - Settled delegated attempts record `delegated-capture.v1` native checkpoints with `journal: { requestIds: [], operationIds: [] }` in `LocalRunStore` (zero `'reported'` tokens and `unresolvedRequests === 0`), while [`packages/controller/src/budget-observations.ts`](../packages/controller/src/budget-observations.ts) and [`packages/controller/src/controller.ts`](../packages/controller/src/controller.ts) enforce `maxModelCalls`, `maxFormatRepairs`, and `maxImplementationRepairs` across `ControllerProgress.attempts`. Unified capture decoding spans `capture.ts`, `controller.ts`, `recovery.ts`, and `inspect.ts`.
   - On `implementation` repair, downstream `agent` (`review`) nodes that depend on the repaired `task` node reset alongside `check` nodes so reviewers re-verify repaired code. If `wallTimeMs` expires while parked, the next `step` tick claims `LocalRunStore` in `'recovery'` mode for drain settlement and settles `status: 'expired'` (exit `6`).
   - `step cancel` (`--run-root`, `--run-id`, `--json`) removes any materialized workspace, records terminal `cancelled` state, releases run ownership, and exits `130`.

4. **Thin Skill & Connected Documentation**
   - Add `.agents/skills/loopwright-step/SKILL.md` (reachable via `.claude/skills/loopwright-step/SKILL.md`) instructing coding agents how to run `step next`, honor `selection` (`provider`/`model`/`thinking`) and `allowedTools` when dispatching native subagents or Orca workers, apply `jev` screening when available, and finish via `step submit` or `step cancel`.
   - Update [`docs/operations/cli.md`](../docs/operations/cli.md), [`docs/configuration/controller-and-registry.md`](../docs/configuration/controller-and-registry.md), [`docs/configuration/taskpack.md`](../docs/configuration/taskpack.md), [`docs/walkthroughs/declarative-taskpack.md`](../docs/walkthroughs/declarative-taskpack.md), [`docs/walkthroughs/managed-controller.md`](../docs/walkthroughs/managed-controller.md), [`docs/README.md`](../docs/README.md), and [`.agents/skills/loopwright-overview/SKILL.md`](../.agents/skills/loopwright-overview/SKILL.md), respecting [`scripts/check-docs.mjs`](../scripts/check-docs.mjs) caps (`<= 400` lines, `<= 10` H2s) and regenerating `site/`.

### Notes / Constraints / Caveats

- Keep strict ESM TypeScript (`NodeNext`) with zero `any`, null-prototype boundary validation, bounded reads (`O_NOFOLLOW`), and zero new runtime npm dependencies.
- Delegated candidate workspaces materialize in `<runRoot>/workspaces/<runId>/<attemptId>/` (`0o700`, sibling to `<runDir>` and outside `--repo`) so external host tools cannot traverse up into `<runDir>/state` or `secrets.json`, and the target repository working tree remains untouched unless explicit publication runs.

### Boundaries

- **Always:** Enforce `O_NOFOLLOW` non-symlink and `nlink === 1` checks when scanning `candidateDir`; run `scope.v1` and configured checks over every `step submit`; scrub secrets across logs, state, and reports; keep `.github/workflows/`, `.claude/`, `.agents/`, `AGENTS.md`, `CLAUDE.md`, and active taskpack control roots protected; sign all commits with DCO (`git commit -s`).
- **Ask first:** Changing any `@loopwright/core` or `@loopwright/state` public schema, adding runtime npm dependencies, or altering the 23-row Capability Closure Matrix counts.
- **Never:** Accept a `step submit` without a matching single-use `leaseToken`; mark unattested host token counts as `provenance: 'reported'`; mutate the target `--repo` checkout during `step next` or `step submit` when `publication.mode` is `disabled`; or use documentation-only agents to edit `specs/`.

### Risks and Mitigations

- **Risk:** Recording `provenance: 'unknown' | 'estimated'` model requests in [`packages/state/src/receipts.ts`](../packages/state/src/receipts.ts) sets `unresolvedRequests > 0` and blocks verification gates. → **Mitigation:** Record `journal: { requestIds: [], operationIds: [] }` for delegated attempts in `LocalRunStore` and enforce `maxModelCalls`, `maxFormatRepairs`, and `maxImplementationRepairs` from `ControllerProgress.attempts` in `budget-observations.ts` and `controller.ts`.
- **Risk:** Concurrent or replayed `step submit` calls corrupt `LocalRunStore` watermarks or clobber an active `candidateDir`. → **Mitigation:** Persist a SHA-256 `leaseToken` digest at `role.<ordinal>.pre`, acquire `ControllerOwner`, refuse duplicate `step next` with `OWNER_BUSY` unless `--reissue-lease` is set, and refuse stale or replayed tokens with `AUTHORITY_REFUSED` (exit `7`).
- **Risk:** External coding agents leave symlinks, hardlinks, `.DS_Store` noise, or edits during read-only/format steps. → **Mitigation:** Pre-validate `candidateDir` (`lstat`, `O_NOFOLLOW`, `nlink === 1`, file/byte ceilings, and candidate digest invariance for read-only/`format` steps) before mutating `LocalRunStore` or burning the lease.
- **Risk:** Ephemeral loopback ports for turnkey `--taskpack` `command.v1` checks change across separate `step` processes and invalidate `registrySha256`. → **Mitigation:** Stage `--taskpack` files in `<runRoot>/.taskpack-<runId>/` with a constant canonical URL in `registry.yaml`, persist `signingSecret` (`0o600`), and inject the per-tick `127.0.0.1` listener URL via `ControllerPorts.gateUrlOverrides`.
- **Risk:** `ControllerEvents` holds an active `ControllerOwner` handle across ticks, and `docs/configuration/controller-and-registry.md` (`394/400` lines) or `docs/configuration/taskpack.md` (`10/10` H2s) are near doc-linter ceilings. → **Mitigation:** Add `ControllerEvents.suspend()` to release activity locks cleanly without sealing `controller-events.open`, and consolidate existing prose/H3s during documentation updates so `npm run lint:docs` passes.

## Design Details

### Commands

Pinned build and verification environment: **Local workspace on macOS (`darwin/arm64`, Node.js `v26`, npm workspaces)**. Parallel workers must use isolated Orca git worktrees or disjoint `Owns:` paths so `dist/` and `.test-build/` never collide.

```bash
# Install (fresh worktree), build, typecheck, lint, docs check, and Hugo site generation
npm ci
npm run build
npm run typecheck
npm run lint
npm run lint:docs
npm run site

# Full test suite across all nine workspace packages
npm test

# Focused single-package test suite during TDD
npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/<pkg>/test/*.test.js

# Capability closure matrix and 14-scenario integrated failure suite
node packages/cli/dist/main.js closure --verify-failures
```

### Project Structure

```text
packages/
  core/src/                         # Unchanged TaskContract, ArtifactManifest, and scope schemas
  state/src/                        # Unchanged SQLite WAL LocalRunStore and lease fencing
  controller/
    src/types.ts                    # RoleAdapterKind ('pi' | 'delegated'), RoleSelectionOverride, StepYield, and gateUrlOverrides
    src/registry.ts                 # Validate adapter:'delegated' roleProfiles without Pi catalog or Docker requirements
    src/config.ts                   # Parse profiles.roles[].selection and apply CLI roleModelOverrides before TaskLock
    src/compile.ts                  # Compile mixed pi + delegated DAGs and reject pi.compact.v1 on delegated roles
    src/capture.ts                  # Unified delegated-capture.v1 and pi-capture.v1 workspace/checkpoint codec
    src/controller.ts               # Guard unattended run, enforce delegated repair bounds, and reset downstream review nodes
    src/recovery.ts                 # Restore delegated captures, bind active adapters, and persist roleModelOverrides in run.json
    src/inspect.ts                  # Decode candidateFiles across both pi and delegated native captures
    src/reconcile.ts                # Bind active adapters and preserve roleModelOverrides during reconciliation
    src/events.ts                   # Add ControllerEvents.suspend() for cross-process coroutine ticks
    src/gate.ts                     # Support validated loopback gateUrlOverrides for ephemeral command.v1 listeners
    src/budget-observations.ts      # Count delegated attempts and format/implementation repairs toward hard budgets
    src/step.ts                     # New: resumable stepNext / stepSubmit / stepCancel coroutine driver and single-use leases
    src/index.ts                    # Export step APIs and types
  github-app/
    src/types.ts                    # Optional Taskpack spec.roles[] (1..4) and executionMode:'delegated' types
    src/schema.ts                   # Validate Taskpack spec.roles[] uniqueness, bounds, tools, and acyclic dependsOn
    src/taskpack.ts                 # Compile single-role and multi-role Taskpacks in zero-secret delegated mode within D <= 64
    src/turnkey.ts                  # Export .taskpack-<runId> staging and reusable ephemeral loopback command.v1 gate helper
    src/index.ts                    # Export delegated taskpack compilation and local step gate helpers
  cli/
    src/arguments.ts                # Add step subcommand (next|submit|cancel) and repeatable --role-model parser (argv <= 64)
    src/main.ts                     # Wire loopwright step envelopes, exit codes, and --config / --taskpack execution
.agents/skills/
  loopwright-step/SKILL.md          # New: thin vendor-neutral skill for OAuth coding agents and multi-model crews
  loopwright-overview/SKILL.md      # Route delegated stepping and multi-model routing to loopwright-step
docs/                               # Updated CLI, Taskpack, Controller/Registry, walkthroughs, and module map within caps
```

### Code Style

Follow strict ESM (`NodeNext`), explicit readonly boundary interfaces, null-prototype record checks, and `ControllerDiagnostic` refusal codes without `any` (from [`packages/controller/src/compile.ts`](../packages/controller/src/compile.ts)):

```ts
export function compilePlan(loaded: LoadedConfiguration) {
  return result(async (): Promise<CompiledPlan> => {
    const state = approvedState(loaded), config = loaded.configuration, task = config.spec.task, registry = loaded.registry.spec;
    if (task.spec.steps.length > 16 || task.spec.roles.length > 16 || task.spec.target.matrix !== null) refuse('CAPABILITY_UNSUPPORTED', '/spec/task', 'compile');
    if (registry.resourceVersion !== task.spec.trustedContext.revision) refuse('CONFIG_REFERENCE', '/spec/task/spec/trustedContext', 'compile');
```

### Implementation Plan

- [x] **T1 · Delegated role profiles, runtime per-role model overrides, and mixed plan compilation**
      Blocked by: None
      Owns: `packages/controller/src/types.ts`, `packages/controller/src/errors.ts`, `packages/controller/src/registry.ts`, `packages/controller/src/config.ts`, `packages/controller/src/compile.ts`, `packages/controller/test/delegated-compile.test.ts`
      Gate: review
      Acceptance: `TrustedRegistry` accepts `adapter: 'delegated'` (`providerCredentialRef: null`, `runtimeRef: null`, `mcp: null`, optional `context`, arbitrary valid `label` selections); `ControllerConfig.spec.profiles.roles[].selection` and `LoadConfigurationInput.roleModelOverrides` apply before `TaskLock` computation while keeping catalog/credential checks on `adapter: 'pi'`; `compilePlan` rejects `pi.compact.v1` on `delegated` roles and compiles mixed `pi` + `delegated` DAGs cleanly.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/controller/test/delegated-compile.test.js`

- [x] **T2 · Coroutine step engine, single-use lease tokens, `ControllerEvents.suspend`, and unified capture/recovery/inspect**
      Blocked by: T1
      Owns: `packages/controller/src/step.ts`, `packages/controller/src/capture.ts`, `packages/controller/src/config.ts`, `packages/controller/src/controller.ts`, `packages/controller/src/errors.ts`, `packages/controller/src/recovery.ts`, `packages/controller/src/retained.ts`, `packages/controller/src/progress.ts`, `packages/controller/src/inspect.ts`, `packages/controller/src/reconcile.ts`, `packages/controller/src/events.ts`, `packages/controller/src/gate.ts`, `packages/controller/src/budget-observations.ts`, `packages/controller/src/schema.ts`, `packages/controller/src/source.ts`, `packages/controller/src/index.ts`, `packages/controller/test/delegated-compile.test.ts`, `packages/controller/test/step-engine.test.ts`
      Gate: review
      Acceptance: `stepNext`, `stepSubmit`, and `stepCancel` advance ready checks and `pi` roles, materialize `<runRoot>/workspaces/<runId>/<attemptId>/{candidate,context}` (`0o600` writable, `0o400` protected), enforce single-use lease digests (`AUTHORITY_REFUSED` on replay, `OWNER_BUSY` on duplicate `step next` unless `--reissue-lease`), pre-validate `O_NOFOLLOW` regular files (`nlink === 1`) and read-only/`format` candidate invariance before mutating state, enforce zero-request delegated budgets and `implementation` repair downstream `review` resets, persist `roleModelOverrides` in `run.json`, support loopback `gateUrlOverrides`, handle expired `wallTimeMs` via `'recovery'`-mode drain settlement, and refuse unattended `run`/`resume` on active/parked `delegated` roles with `CAPABILITY_UNSUPPORTED`.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/controller/test/*.test.js`

- [x] **T3 · Declarative Taskpack `spec.roles` (`1..4`), zero-secret delegated compilation, and turnkey step gate helper**
      Blocked by: T1
      Owns: `packages/github-app/src/types.ts`, `packages/github-app/src/schema.ts`, `packages/github-app/src/taskpack.ts`, `packages/github-app/src/turnkey.ts`, `packages/github-app/src/action.ts`, `packages/github-app/src/index.ts`, `packages/github-app/test/delegated-taskpack.test.ts`
      Gate: review
      Acceptance: `Taskpack` validates optional `spec.roles` (`1..4` unique acyclic entries, disjoint from check IDs, sink roles wired into `checks[0].dependsOn`); `compileDeclarativeTaskpack` supports `executionMode: 'delegated'` with zero provider secrets, bypasses Pi catalog lookup, and computes `controls.maxAttempts` dynamically within `D <= 64` (refusing excess capacity with `TASKPACK_MANIFEST_INVALID`); `turnkey.ts` exports `<runRoot>/.taskpack-<runId>/` staging with persisted `signingSecret` and a reusable ephemeral loopback `command.v1` gate helper.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/github-app/test/*.test.js`

- [x] **T4 · CLI `step` subcommand (`next | submit | cancel`) and repeatable `--role-model` flag wiring**
      Blocked by: T2, T3
      Owns: `packages/cli/src/arguments.ts`, `packages/cli/src/main.ts`, `packages/cli/test/step-cli.test.ts`
      Gate: review
      Acceptance: CLI parses `loopwright step next|submit|cancel` (positional or `--action`) and up to 8 repeatable `--role-model <roleId>=<provider>/<model>[:<thinking>]` flags (`argv` ceiling `64`) across `check`, `run`, `resume`, and `step`, drives both `--config`/`--registry` and `--taskpack` step flows with loopback `command.v1` `gateUrlOverrides`, emits standard v1 NDJSON `Envelope` records, and exits `0`, `2..8`, `130` (`step cancel`), or `143`.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/cli/test/*.test.js`

- [x] **T5 · Vendor-neutral `loopwright-step` skill and overview routing**
      Blocked by: T4
      Owns: `.agents/skills/loopwright-step/**`, `.agents/skills/loopwright-overview/SKILL.md`
      Acceptance: `.agents/skills/loopwright-step/SKILL.md` (resolved identically via `.claude/skills/loopwright-step/SKILL.md`) documents the pull loop (`step next` → per-role model/tool dispatch + optional `jev` fast screening → `step submit` / `step cancel`), and `.agents/skills/loopwright-overview/SKILL.md` routes delegated stepping and multi-model workflows to `loopwright-step`.
      Verify: `npm run build && npm run typecheck && npm run lint && node packages/cli/dist/main.js --help`

- [x] **T6 · Connected documentation, module-map registration, line/H2 budget trim, and Hugo site sync**
      Blocked by: T4, T5
      Owns: `docs/operations/cli.md`, `docs/configuration/controller-and-registry.md`, `docs/configuration/taskpack.md`, `docs/walkthroughs/declarative-taskpack.md`, `docs/walkthroughs/managed-controller.md`, `docs/README.md`, `site/**`
      Acceptance: Docs cover `loopwright step`, `adapter: delegated`, `--role-model`, and `Taskpack.spec.roles` (`1..4`), register `loopwright-step` under `controller` and `taskpacks` in `docs/README.md`, trim/consolidate prose and H3s so every page stays within `scripts/check-docs.mjs` limits (`<= 400` lines, `<= 10` H2s), and regenerate `site/` cleanly without editing `specs/`.
      Verify: `npm run lint:docs && npm run site && npm test && node packages/cli/dist/main.js closure --verify-failures`

### Test Plan

[x] I/we understand the owners of the involved components may require updates to existing tests to make this
code solid enough prior to committing the changes necessary to implement this enhancement.

#### Prerequisite testing updates

None. Existing nine-package unit/integration suites and the 23-row Capability Closure Matrix pass cleanly on `main`.

#### Unit tests

- `@loopwright/controller`: `2026-11-14` - `>= 90%` branch coverage on new/updated delegated compilation and step modules (`delegated-compile.test.ts`, `step-engine.test.ts`), covering `adapter: 'delegated'` registry validation, `--role-model` overrides and `run.json` persistence, `delegated-capture.v1` round-trips across `capture`/`recovery`/`inspect`, `ControllerEvents.suspend()`, single-use `leaseToken` replay/concurrency refusals (`AUTHORITY_REFUSED`, `OWNER_BUSY`, `--reissue-lease`), pre-commit `O_NOFOLLOW` symlink/hardlink rejection, read-only and `format` candidate invariance, zero-request delegated budget accounting, expired `wallTimeMs` `'recovery'`-mode drain settlement, and `CAPABILITY_UNSUPPORTED` guards on `run`/`resume`.
- `@loopwright/github-app`: `2026-11-14` - `>= 90%` branch coverage on new multi-role and delegated taskpack compilation (`delegated-taskpack.test.ts`), covering `spec.roles` (`1..4`) DAG validation, sink-role check wiring, `D <= 64` capacity bounds, zero-secret `executionMode: 'delegated'` compilation, and `.taskpack-<runId>` staging with ephemeral loopback `command.v1` port rebinding.
- `@loopwright/cli`: `2026-11-14` - `>= 90%` branch coverage on `step` argument parsing, repeatable `--role-model` flags (`<= 8` entries, `argv <= 64`), NDJSON `Envelope` output, and exit code mapping (`step-cli.test.ts`).

#### Integration tests

- Multi-role two-model delegated Managed Controller pipeline (`author` `gemini-4-carbon` + read-only `review` `gemini-4-argon`), covering a `scope.v1` protected-path violation, bounded `implementation` repair, downstream `review` node reset/re-approval, and clean target `--repo` verification.
- Zero-secret `--taskpack` turnkey step lifecycle across separate `step next` and `step submit` invocations with live loopback `command.v1` check execution and dynamic port rebinding.
- `--mode no-change` delegated submission (`status: 'no_change'`) verifying `no-change.v1` acceptance and zero `reported` token provenance.
- Mixed `adapter: 'pi'` (local stub) + `adapter: 'delegated'` two-role pipeline verifying seamless handoff and unified `candidateFiles` inspection.
- Capability Closure Matrix regression check (`node packages/cli/dist/main.js closure --verify-failures`) confirming `18` `closed_local` and `5` `unprovisioned_external` remain unchanged.

#### e2e tests

Subprocess CLI end-to-end tests in `packages/cli/test/step-cli.test.ts` execute `node packages/cli/dist/main.js step next`, `step submit`, and `step cancel` against temporary Git repositories for both Managed Controller and Declarative Taskpack workflows. Live interactive third-party OAuth browser logins are excluded from automated suites by boundary policy.

## Alternatives

- **Built-in Push CLI spawners inside `@loopwright/controller`:** Rejected because each external agent CLI (`agy`, `codex`, `claude`, `pi`) uses distinct flags, interactive folder-trust prompts, and TUI framing. Keeping external process orchestration outside the controller avoids 3x ongoing adapter maintenance and works inside GUI/IDE agent sessions.
- **Pure Markdown skill without `loopwright step` CLI enforcement:** Rejected because prompt-only instructions cannot enforce DAG topological order, `repeatFailureLimit` circuit breakers, `O_NOFOLLOW` candidate hygiene, or authenticated `scope.v1` / `command.v1` receipts across multi-role workflows.
- **Mutating `@loopwright/core` `TaskContract` schema fields:** Rejected because `TaskContract.spec.roles[]` already types `adapter`, `provider`, `model`, and `thinking` as open `label` strings; keeping `@loopwright/core` unchanged preserves all existing canonical digests and the 23-row closure ledger.

## Open Questions

None.
