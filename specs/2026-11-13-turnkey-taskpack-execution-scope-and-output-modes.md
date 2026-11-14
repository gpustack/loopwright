# Spec: Turnkey Taskpack Execution, Orthogonal Scope Rules, Custom Control Roots, and Multi-Sink Output Modes

Status: Shipped
Type: Feature

## Summary

Upgrade Loopwright so a target repository can run an end-to-end declarative taskpack cycle directly from GitHub Actions without custom HTTP sidecars, container-in-VM sandboxing overhead, or scattered prompt scripts. This enhancement adds live upstream drift discovery, a turnkey controller execution delegate with native GitHub pull-request publication, custom managed control directories such as `.auto-sync/` with SHA-256-pinned instructions and local command verifiers, orthogonal whitelist and blacklist path scope rules where blacklist entries always win, zero-overhead `direct-dedicated` execution by default on ephemeral GitHub Actions runners, comma-separated multi-token pool propagation with estimated model cost accounting, and configurable output sinks including GitHub Step Summary reports.

## Motivation

### Goals

- Let downstream repositories consolidate all automation assets under one dedicated directory (such as `.loopwright/` or `.auto-sync/`) containing `taskpack.yaml`, protected domain instructions, protected static check scripts, and reviewed memory.
- Execute real end-to-end taskpack cycles inside `packages/github-app/src/action.ts` (`runActionCli`) when `dry-run` is `false`, covering upstream discovery, candidate authoring, verification, repair, and pull-request publication.
- Support orthogonal `writable` (whitelist) and `protected` (blacklist) path rules where `protected` always overrides `writable`, allowing broad writable trees (including patch directories) with targeted protected exclusions.
- Default `Taskpack` execution on ephemeral GitHub Actions runners (`GITHUB_ACTIONS=true`) to `direct-dedicated` process-tree isolation when `spec.sandbox` is omitted, avoiding nested container or namespace setup while preserving `scope.v1` verification.
- Propagate comma-separated provider API tokens end-to-end with health probing, rotation, secret scrubbing, and per-run USD cost reporting (`reported`, `estimated` from catalog or custom model pricing, or `unknown`).
- Provide configurable output modes (`json`, `github-step-summary`, `markdown`, `text`) across the reusable GitHub Action, `Taskpack` manifest, and CLI so CI runs emit human-readable summaries alongside machine-readable JSON.

### Non-Goals

- Changing `@loopwright/core` or `@loopwright/state` public schemas, `LIMITS` constants (`256` manifest regular files, `4 MiB` regular-file source inventory ceiling), lease-fencing invariants, or the 23-row Capability Closure Ledger counts (`18` `closed_local`, `5` `unprovisioned_external`).
- Treating locally estimated token cost as provider-attested billing (`live-provider-billing-and-effort-attestation` remains `unprovisioned_external`; estimated figures must carry `provenance: 'estimated'`).
- Allowing untrusted `Taskpack` manifests or model outputs to modify `.github/workflows/`, `.claude/`, `.agents/`, `AGENTS.md`, `CLAUDE.md`, or the active taskpack control directory's configuration, instructions, checks, or memory.
- Introducing interactive OAuth login flows or shell-evaluated `!command` credential resolvers.

## Proposal

A repository adopts Loopwright by committing one manifest (for example `.auto-sync/taskpack.yaml`), optional domain instructions (for example `.auto-sync/instructions.md`), and optional static verification scripts (for example `.auto-sync/checks/verify.sh`), then invoking `gpustack/loopwright` in a GitHub Actions workflow. On schedule, manual dispatch, release events, or pull-request comments (such as `/auto-sync revise` or bare `/auto-sync` followed by guidance lines), Loopwright discovers upstream updates, runs the author role in a host subprocess on the Actions runner using a healthy token from a comma-separated token pool, verifies file scope and static checks, opens or updates the target pull request via GitHub App or token credentials, and writes structured JSON plus a Markdown run summary with token and cost metrics to `$GITHUB_STEP_SUMMARY`.

### User Stories

#### Story 1
As a repository maintainer migrating legacy sync scripts to Loopwright, I want all taskpack configuration, domain instructions, verification scripts, and memory files to live under one protected `.auto-sync/` directory, so that I can delete bespoke Python orchestration code and inline Dockerfile prompt comments.

#### Story 2
As a build-matrix maintainer whose sync workflow updates Dockerfiles, scripts, and `patches/` subdirectories while keeping curated metadata files read-only, I want optional `writable` whitelist paths and higher-priority `protected` blacklist paths, so that I can express broad directory permissions with exact exclusions.

#### Story 3
As a CI operator running Loopwright on ephemeral GitHub Actions runners with a comma-separated `LLM_TOKEN` secret and GitHub App credentials, I want Loopwright to run without nested sandboxes, rotate exhausted API keys automatically, publish pull requests natively, and print token usage and USD cost to the GitHub Step Summary, so that every workflow run is self-contained and observable.

### Core Features & Acceptance Criteria

1. **Custom Managed Control Root & Protected Assets**
   - `loadDeclarativeTaskpack` rejects symlinked ancestor components on the manifest path and derives `controlRoot` from `dirname(relativeTaskpackPath)` when `dirname !== '.'`, defaulting to `.loopwright` when the manifest sits at repository root (`taskpack.yaml`) or is parsed from raw bytes.
   - Built-in `effectiveProtectedPaths` automatically include `.github`, `.claude`, `.agents`, `.loopwright/policies`, `<controlRoot>/policies`, `<controlRoot>/checks`, `<controlRoot>/memory`, `<controlRoot>/taskpack.yaml`, `<controlRoot>/taskpack.yml`, `<controlRoot>/taskpack.json`, the exact normalized `relativeTaskpackPath` (covering custom filenames such as `.auto-sync/sync.yaml` or root `taskpack.yaml`), `AGENTS.md`, `CLAUDE.md`, every path in `spec.instructions`, and every script in `command.v1` local checks.
   - `spec.memory.directory` is accepted under `<controlRoot>/memory` (either `<controlRoot>/memory` or `<controlRoot>/memory/<subpath>`) and rejected with `TASKPACK_SCOPE_VIOLATION` outside `<controlRoot>/memory`; because `<controlRoot>/memory` is in `effectiveProtectedPaths`, blacklist priority automatically excludes it from omitted `writable` (`['**']`) or ancestor `writable` trees.
   - Optional `spec.instructions` accepts a relative path or array of `1..16` relative paths to regular UTF-8 files (no symlinks on any ancestor or target, `<= 24576` aggregate UTF-8 bytes so total context stays within `65536`-byte `maxRequestBytes`), derives unique valid resource identifiers (`instruction-<index>-<slug>`), compiles each into SHA-256-pinned `TaskContract.spec.trustedContext.resources` (`kind: 'instruction'`) and `TrustedRegistry.spec.resources`, and stages intermediate directories with `0o700` and files with `0o600` inside `registry/` so `loadTrustedConfiguration` accepts them.

2. **Orthogonal Whitelist and Blacklist Scope Rules (Blacklist Wins)**
   - `spec.scope`, `spec.scope.writable`, and `spec.scope.protected` are optional in `Taskpack`.
   - Every path entry in `Taskpack` `spec.scope` must satisfy `@loopwright/core` relative path segment grammar (`^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$`, rejecting raw globs such as `**` or `docs/**`, spaces, `+`, and reserved device names at `validateTaskpackManifest` with `TASKPACK_MANIFEST_INVALID`).
   - Omitting `writable` compiles `TaskContract.spec.scope.writable` to `['**']` (unrestricted whitelist subject to `effectiveProtectedPaths`) and maps `SandboxExecutionPolicy.writablePaths` to `['.']` (with un-suffixed `effectiveProtectedPaths`). An explicit empty `writable: []` array remains a `TASKPACK_MANIFEST_INVALID` error (`1..128` items when present).
   - Declared relative scope entries `p` compile to `${p}/**` in `TaskContract.spec.scope` so `@loopwright/core` `isWritablePath` matches both exact file `p` and descendants `p/...`.
   - `writable` may contain an ancestor directory (such as `pack`) or be omitted (`['**']`) while `protected` carves out descendants (such as `pack/dependencies.json` or `pack/cann/patches/hixl`); any `writable` entry that is equal to or covered by an `effectiveProtectedPaths` entry (`pathCoveredBy(writableEntry, protectedEntry)`, such as `writable: ['.github/workflows']`) is refused with `TASKPACK_SCOPE_VIOLATION`, and `spec.proposal.path` must be writable after applying both `writable` and `effectiveProtectedPaths`.

3. **Protected Local Command Verifier (`command.v1`)**
   - `spec.verification.localChecks[].implementation` accepts `'command.v1'` alongside `'json-artifact.v1'`, `'scope.v1'`, and `'no-change.v1'`.
   - Each `command.v1` check requires `parameters.script` (a normalized relative regular file with no symlink ancestors inside `effectiveProtectedPaths`, `<= 262144` bytes, hashed with SHA-256 at compile time) and accepts optional `parameters.timeoutSeconds` (`1..55`, default `30`, fitting inside the controller's `60s` permit-lease poll clamp), `parameters.allowReadOnlyGitHubToken` (`boolean`, default `false`), and `parameters.env` (`0..16` safe uppercase environment variable names, explicitly rejecting `LOOPWRIGHT_*`, `INPUT_*`, `GITHUB_APP_*`, `GH_TOKEN`, `GITHUB_TOKEN`, `ACTIONS_*`, `BASH_ENV`, `ENV`, `NODE_OPTIONS`, `LD_*`, `DYLD_*`, and `GIT_*`).
   - `compileDeclarativeTaskpack` compiles `command.v1` checks into authenticated `gate.v1` verifier slots with strict `{ checkId, endpointRef: 'loopwright-local-command', gateId }` parameters (`gateId` `<= 128` chars), carries `{ gateId, checkId, script, scriptSha256, timeoutSeconds, allowReadOnlyGitHubToken, env }` on `CompiledTaskpack.localCommandGates`, and supports per-endpoint gate `credentialBindings` when combined with `externalGates`.
   - At verification time, the loopback handler re-verifies `scriptSha256` on disk (`O_NOFOLLOW`), inspects the retained candidate and verifies `bindSubject(lock, manifest).candidateDigest.hex === request.candidateDigest`, materializes candidate regular files into an ephemeral directory outside the checkout, runs the script with a scratch-built minimal environment (`PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `LOOPWRIGHT_CANDIDATE_DIR`, `LOOPWRIGHT_CHECK_ID`, plus validated `parameters.env`), and returns a signed `gate_verdict` (`approved` on exit `0`; `denied` with secret-scrubbed, `<= 256`-char diagnostic reason on non-zero exit).
   - When a `gate.v1` check returns `denied`, `Cycle.implementationRepair()` includes the bounded `verdict.reason` in the author role's repair findings while capping total serialized repair prompt bytes within `Math.min(16384, role.policy.limits.promptBytes)`.

4. **Turnkey GitHub Action Execution, Live Upstream Discovery, Bare Comment Prefix, and Native PR Publication**
   - `runActionCli` acquires `UpstreamDiscoveryRecord[]` for `github-release`, `git-tag`, `git-commit`, `http-json`, and `custom-table` upstreams (plus optional `INPUT_UPSTREAM-RECORDS` override) and queries open pull requests matching `headBranchPrefix` and `targetBranch` to populate `managedPrMatchesDiscoveredState` and reusable PR metadata.
   - `parseCommentCommand` accepts bare `<prefix>` on line 1 when followed by non-empty multiline guidance (`<prefix>\n<guidance>`) and maps it to `'revise'` whenever `'revise'` is enabled in `commentCommands`, while preserving `<prefix> retry`, `<prefix> revise`, and `<prefix> status`.
   - `freezeSource` (`packages/controller/src/source.ts`) skips `120000` git symlink entries strictly when covered by `task.spec.scope.protected` (such as `.claude/skills` in repositories with shared agent skill links) while continuing to refuse unprotected symlinks (`CAPABILITY_UNSUPPORTED`), submodules, `> 256` regular files, and `> 4 MiB` total regular-file bytes (`CONFIG_LIMIT`).
   - When `dry-run` is not `'true'`, `runActionCli` resolves `baseRevision` and `sourceRevision` to full 40-hex commit SHAs (fetching live PR head/base SHAs via `GET /repos/{owner}/{repo}/pulls/{number}` on `issue_comment` `revise` events), resolves positive `tenant.repositoryId` (`GITHUB_REPOSITORY_ID` or `GET /repos/{owner}/{repo}`), and runs `loadTrustedConfiguration` + `runCycleWithPorts` backed by `@loopwright/agent-pi/host-session`.
   - When `publication.mode === 'pull_request'` and `publication-endpoint-url` is omitted, the turnkey loopback publisher verifies `request.candidateDigest`, checks out `baseRevision` in a detached temporary `git worktree` (cleaned up in `finally` so checkout `HEAD` never moves), applies only the `source -> candidate` regular-file diff (preserving untouched protected git index entries), pushes to the existing open managed PR `head.ref` or deterministic `${headBranchPrefix}${targetBranch}` branch using `GIT_CONFIG_COUNT` HTTP `extraheader` credentials and `--force-with-lease=refs/heads/<branch>:<expectedRemoteOid>`, creates or updates the pull request via GitHub REST API, and returns a signed `publication_receipt` with `externalUrl`.

5. **Zero-Overhead Default Execution on GitHub Actions (`direct-dedicated`)**
   - When `GITHUB_ACTIONS === 'true'` and `manifest.spec.sandbox` is omitted, the Action runtime resolves the effective sandbox policy to `direct-dedicated` (`preferredBackends: ['direct-dedicated']`, `networkMode: 'allow-outbound'`, `requiredCapabilities: ['processTreeCleanup']`, `allowDirectDedicatedBackend: true`).
   - Standalone `negotiateSandboxBackend` keeps `DEFAULT_REQUIRED_SANDBOX_CAPABILITIES` unchanged when callers omit `requiredCapabilities`, preserving existing fail-closed refusal semantics outside GitHub Actions.
   - Explicit `manifest.spec.sandbox` declarations override the Actions default unchanged.

6. **Multi-Token Pool Propagation & Estimated Model Cost Accounting**
   - Comma-separated provider tokens in the configured token environment variable expand up to `16` candidates, register every token in `SecretScrubber`, probe readiness before execution, isolate per-attempt `runId`s (`runId` on attempt `0`, `${runId.slice(0, 56)}-a${attempt}` on retries so `createCycle` never hits `OWNER_BUSY`), rotate only when zero `external_write` dispatches occurred and retained diagnostics show a retryable provider quota/rate-limit/timeout/unavailable failure, and pass `LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN` only to the in-process `resolveCredential` callback (never inherited by `sdk-worker` or `bash` child processes).
   - `@loopwright/agent-pi/catalog`, `validateCustomProviderConfig` (`packages/agent-pi/src/policy.ts`), `models.json`, and `Taskpack` `spec.models[]` accept optional per-million-token USD pricing (`cost: { input, output, cacheRead?, cacheWrite? }`), populated automatically for built-in `@earendil-works/pi-ai` catalog models.
   - When a confirmed provider response omits explicit provider billing micro-USD and model pricing has at least one positive rate, `usage.ts` computes safe-integer `costMicrousd` with `provenance: 'estimated'` using provider-accurate cache accounting (OpenAI `uncachedInput = Math.max(0, promptTokens - cachedTokens)` plus `cachedTokens * cacheRead`; Anthropic separate uncached `input_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens`); provider-reported cost stays `provenance: 'reported'`, and unpriced models stay `provenance: 'unknown'`.

7. **Configurable Multi-Sink Output Modes**
   - Output sinks support `json` (default), `github-step-summary`, `markdown`, and `text`, configurable as a single value or comma-separated list via Action input `output`, CLI `--output-format`, or `Taskpack` `spec.output` (with CLI/Action input overriding `Taskpack` default).
   - A shared report formatter in `@loopwright/controller` renders deterministic, `SecretScrubber`-scrubbed, ANSI- and `::workflow-command::`-neutralized summaries (run status, discovery summary, check/gate verdicts, model + token rotation count, required Input / Output / Total token counts (`totalTokens`), optional deterministic 6-decimal USD cost `formatCostUsd` rendered when `reported` or `estimated` and omitted in human-readable summaries when `unknown`, elapsed wall time, and PR URL) consumed by both `@loopwright/cli` and `@loopwright/github-app`.
   - Selecting `github-step-summary` writes Markdown to `$GITHUB_STEP_SUMMARY` (or `--step-summary-file`); CLI `--json` / `json` stdout remains pure NDJSON when combined with file-backed `--step-summary-file`; `action.yml` exposes `result`, `pr-url`, `total-tokens`, and optional `cost-usd` step outputs.

### Notes / Constraints / Caveats

- Keep `@loopwright/agent-pi` root runtime exports in `packages/agent-pi/src/index.ts` strictly equal to `['decodePiCapture', 'describePiAdapterFiles', 'openPiAdapter', 'openPiAdapterV2']`; expose the non-Docker host subprocess adapter on subpath `@loopwright/agent-pi/host-session` (`exports["./host-session"]` in `packages/agent-pi/package.json`), using a non-Docker process-group lease + host `ToolProcessPort` (`darwin/arm64`, `linux/arm64`, `linux/x64`) and real host candidate/scratch directories while preserving logical `<cwd>\n/workspace/candidate\n</cwd>` prompt framing for `validateRequestResources` and keeping `bash` isolated in scratch so `Candidate` hash guards remain intact.
- Keep all TypeScript packages strict ESM (`NodeNext`) with zero `any`, bounded parsing (`O_NOFOLLOW` regular-file reads and ancestor symlink checks), null-prototype guards, and deterministic serialization.
- Repositories remain bounded by `@loopwright/core`'s `256` regular-file manifest ceiling and `4 MiB` regular-file inventory ceiling (`packages/core/src/limits.ts`).
- Preserve every existing CLI flag, NDJSON envelope, exit code, and all 23 rows / 14 failure scenarios in `packages/cli/src/closure.ts` and `packages/cli/src/failure-matrix.ts`.

### Boundaries

- **Always:** Scrub every token in comma-separated provider pools, GitHub App private keys, installation tokens, and ephemeral loopback HMAC secrets through `SecretScrubber`; construct child subprocess environments from scratch; keep `.github/workflows/`, `.claude/`, `.agents/`, `AGENTS.md`, `CLAUDE.md`, and `<controlRoot>` read-only to untrusted candidates; sign commits with DCO (`git commit -s`).
- **Ask first:** Changing any `@loopwright/core` or `@loopwright/state` schema contract, adding third-party runtime npm dependencies, or altering the 23-row Capability Closure Ledger dispositions.
- **Never:** Leak `LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN` or write tokens into `command.v1` or `bash` subprocesses; embed git credentials in remote URLs; force-push without `--force-with-lease` expected-head verification; mark estimated cost as `reported`; or allow documentation workers to edit `specs/`.

### Risks and Mitigations

- **Risk:** Broad or omitted `writable` scopes, root/custom manifest filenames, or symlinked `<controlRoot>` directories could expose automation configs or workflows to candidate edits. → **Mitigation:** Reject symlinked ancestor components, merge `.github`, `.claude`, `.agents`, `AGENTS.md`, `CLAUDE.md`, `<controlRoot>/{policies,checks,memory,taskpack.*}`, `relativeTaskpackPath`, `spec.instructions`, and `command.v1` scripts into `effectiveProtectedPaths`, and enforce blacklist-first `scope.v1` verification.
- **Risk:** Untrusted `command.v1` `parameters.env` or inherited `process.env` could leak `LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN` or hijack shell startup (`BASH_ENV`, `NODE_OPTIONS`, `LD_PRELOAD`). → **Mitigation:** Build subprocess environments from an explicit minimal allowlist and reject sensitive/loader variable prefixes at manifest validation.
- **Risk:** Mid-run token rotation or native PR publication could hit `OWNER_BUSY` `runId` collisions, `TARGET_MISMATCH` on checkout `HEAD`, or overwrite concurrent human PR commits. → **Mitigation:** Suffix retry attempt `runId`s (`-a1`, `-a2`), publish from a temporary detached `git worktree` using resolved 40-hex commit SHAs, reuse open managed PR `head.ref`, and push with `--force-with-lease`.
- **Risk:** Host-session execution without Docker could break `validateRequestResources` (`/workspace/candidate`), fail on `linux/x64` GitHub runners, or trip `Candidate` out-of-band mutation checks. → **Mitigation:** Keep logical `/workspace/candidate` system-prompt framing while mapping `read`/`write`/`edit` to `owned.candidate` and `bash` to isolated host scratch across `darwin/arm64` and `linux/{arm64,x64}`.

## Design Details

### Commands

Pinned build and verification environment: **Local workspace on macOS (`darwin/arm64`, Node.js `v26.13.0`, npm workspace root)**. Note: concurrent tasks must run in isolated git worktrees so `npm run build` and `.test-build/` outputs never collide.

```bash
# Full workspace build, typecheck, lint, docs check, and Hugo site generation
npm run build
npm run typecheck
npm run lint
npm run lint:docs
npm run site

# Fast parallel test runner across all nine packages + Python fixtures
npm test

# Focused single-package suite during TDD
npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/<pkg>/test/*.test.js

# Capability closure matrix and 14-scenario integrated failure harness
node packages/cli/dist/main.js closure --verify-failures
```

### Project Structure

```text
action.yml                                   # Composite GitHub Action inputs, outputs, and entrypoint invocation
packages/
  core/src/                                  # Unchanged kernel contracts, scope matcher, and Quantity/UsageSummary schemas
  state/src/                                 # Unchanged fenced SQLite run store and monotonic clock guards
  agent-pi/
    package.json                             # Add ./host-session subpath export alongside . and ./catalog
    src/catalog.ts                           # Read built-in model cost metadata from @earendil-works/pi-ai
    src/policy.ts                            # Allowlist optional custom model cost rates in validateCustomProviderConfig
    src/usage.ts                             # Compute provider-accurate provenance:'estimated' costMicrousd
    src/host-session.ts                      # New: non-Docker lease + host ToolProcessPort + scratch isolation on arm64/x64
  controller/
    src/source.ts                            # Skip protected 120000 git symlinks while refusing unprotected symlinks
    src/controller.ts                        # Propagate bounded gate denial reason (<= 16 KiB cap) into implementationRepair
    src/inspect.ts                           # Expose settled UsageSummary and publication externalUrl observations
    src/report.ts                            # New: shared scrubbed/neutralized json, github-step-summary, markdown, text formatter
  github-app/
    src/types.ts                             # Extended TaskpackManifest, command.v1, instructions, pricing, and output types
    src/schema.ts                            # Control-root-aware validation, strict path grammar, orthogonal scope, command.v1
    src/taskpack.ts                          # Compile ** / <path>/** scopes, instructions, per-endpoint gate bindings, bare prefix
    src/models-config.ts                     # Preserve custom model pricing and multi-token active env propagation
    src/upstreams.ts                         # New: live github-release, git-tag, git-commit, http-json, custom-table discovery
    src/turnkey.ts                           # New: HMAC loopback command.v1 gate server, host-session CycleDelegate, worktree PR publisher
    src/output-format.ts                     # New: Action sink writer wrapping @loopwright/controller report formatters
    src/action.ts                            # Wire discovery, Actions direct-dedicated default, per-attempt runId fallback, outputs
  cli/
    src/arguments.ts                         # Add --output-format and --step-summary-file options
    src/main.ts                              # Emit multi-sink formatted reports while keeping --json NDJSON & exit contracts
docs/                                        # Usage contracts for Taskpack, sandboxes, Pi models, CLI, and GitHub Action
```

### Code Style

Follow Loopwright's strict ESM `NodeNext`, explicit readonly types, bounded validation, and `GitHubAppError` / `Result` conventions (modeled on `packages/github-app/src/schema.ts` and `packages/core/src/scope.ts`):

```ts
export function compileScopePatterns(
  entries: readonly string[] | undefined,
  mode: 'writable' | 'protected',
): readonly string[] {
  if (entries === undefined) {
    return mode === 'writable' ? Object.freeze(['**']) : Object.freeze([]);
  }
  return Object.freeze(entries.map(entry => `${entry}/**`));
}
```

### Implementation Plan

- [x] **T1 · Model pricing catalog, estimated cost accounting, and non-Docker `@loopwright/agent-pi/host-session`**
      Blocked by: None
      Owns: `packages/agent-pi/**`
      Gate: review
      Acceptance: `@loopwright/agent-pi/catalog` and `validateCustomProviderConfig` support `cost` rates; `usage.ts` computes integer `costMicrousd` with `provenance: 'estimated'` (distinguishing OpenAI subset `cached_tokens` vs Anthropic additive cache tokens while preserving `reported` and `unknown`); `@loopwright/agent-pi/host-session` runs without Docker across `darwin/arm64` and `linux/{arm64,x64}` with scratch-built child envs, logical `/workspace/candidate` prompt parity, scratch `bash` isolation, and unchanged 4-symbol root exports in `src/index.ts`.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/agent-pi/test/*.test.js`

- [x] **T2 · Control-root derivation, orthogonal scope rules, `spec.instructions`, `command.v1`, and bare comment prefix**
      Blocked by: T1
      Owns: `packages/github-app/src/types.ts`, `packages/github-app/src/schema.ts`, `packages/github-app/src/taskpack.ts`, `packages/github-app/src/models-config.ts`, `packages/github-app/test/taskpack-intake.test.ts`, `packages/github-app/test/models-config.test.ts`
      Gate: review
      Acceptance: Non-symlink `controlRoot` derivation (defaulting root `taskpack.yaml` to `.loopwright` while protecting exact `relativeTaskpackPath`, `.claude`, `.agents`, `.github`, and `<controlRoot>`); strict `@loopwright/core` path grammar at manifest validation; omitted/combined `writable` and `protected` compile to `**` / `<path>/**` with blacklist priority on `proposal.path` and `memory.directory`; `spec.instructions` (`<= 24 KiB`) compiles to SHA-256-pinned trusted resources; `command.v1` (`timeoutSeconds` `1..55`, safe `env` allowlist) compiles to `{ checkId, endpointRef, gateId }` `gate.v1` slots plus `localCommandGates` metadata and per-endpoint gate credential bindings; bare `<prefix>\n<guidance>` parses as `revise`; `spec.models[]` / `models.json` preserve `cost` and `spec.output` validates sink names.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/github-app/test/taskpack-intake.test.js .test-build/packages/github-app/test/models-config.test.js`

- [x] **T3 · Controller protected-symlink source freeze, gate denial repair propagation, inspection, and shared report formatter**
      Blocked by: None
      Owns: `packages/controller/**`
      Gate: review
      Acceptance: `freezeSource` skips `120000` git symlinks strictly covered by `task.spec.scope.protected` while keeping existing refusals on unprotected symlinks, submodules, `> 256` files, and `> 4 MiB` bodies; `Cycle.implementationRepair()` includes bounded `verdict.reason` details within the `16 KiB` repair prompt ceiling; `inspectRun` exposes settled `UsageSummary` and publication `externalUrl`; `report.ts` exports shared `SecretScrubber`-, ANSI-, and `::workflow-command::`-safe `json` / `github-step-summary` / `markdown` / `text` formatters and 6-decimal `formatCostUsd`.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/controller/test/*.test.js`

- [x] **T4 · CLI multi-sink output modes (`json`, `github-step-summary`, `markdown`, `text`)**
      Blocked by: T3
      Owns: `packages/cli/**`
      Gate: None
      Acceptance: `loopwright run`, `resume`, and `reconcile` accept `--output-format` and `--step-summary-file` backed by `@loopwright/controller`'s shared formatter, preserving pure NDJSON stdout under `--json`, neutralizing workflow commands and control bytes on multi-line sinks, and keeping all existing CLI flags, exit codes, and the 23-row / 14-scenario closure matrix green.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/cli/test/*.test.js && node packages/cli/dist/main.js closure --verify-failures`

- [x] **T5 · Turnkey GitHub Action delegate, live upstream discovery, native PR publisher, `command.v1` bridge, and Actions `direct-dedicated` default**
      Blocked by: T1, T2, T3
      Owns: `packages/github-app/src/action.ts`, `packages/github-app/src/turnkey.ts`, `packages/github-app/src/upstreams.ts`, `packages/github-app/src/output-format.ts`, `packages/github-app/src/sandbox.ts`, `packages/github-app/src/index.ts`, `packages/github-app/test/control-plane-action.test.ts`, `packages/github-app/test/turnkey-action.test.ts`, `action.yml`
      Gate: review
      Acceptance: `runActionCli` performs live upstream discovery and open-PR lookup, resolves 40-hex `baseRevision`/`sourceRevision` and positive `repositoryId`, defaults omitted `spec.sandbox` on `GITHUB_ACTIONS=true` to `direct-dedicated` (`writablePaths: ['.']` when `writable` omitted) without altering `negotiateSandboxBackend` defaults, stages `0o700`/`0o600` instruction resources, runs `@loopwright/agent-pi/host-session` with per-attempt `runId` token fallback, executes SHA-256- and `candidateDigest`-verified `command.v1` scripts with `<= 256`-char scrubbed denial reasons, publishes diff-only commits from a temporary `git worktree` using HTTP `extraheader` auth and `--force-with-lease`, and writes configured `output` sinks plus `pr-url` and `cost-usd` outputs.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/github-app/test/*.test.js && node packages/cli/dist/main.js closure --verify-failures`

- [x] **T6 · Connected documentation, `Taskpack` & Action guides, and Hugo site sync**
      Blocked by: T2, T4, T5
      Owns: `docs/**`, `README.md`, `examples/**`, `site/**`, `scripts/check-docs.mjs`
      Gate: None
      Acceptance: Documentation pages under `docs/configuration/`, `docs/operations/`, `docs/walkthroughs/`, `examples/`, and `README.md` document custom control directories (`.auto-sync/`), `spec.instructions`, `command.v1`, orthogonal `writable`/`protected` rules, GitHub Actions `direct-dedicated` default, multi-token pools with estimated cost, native GitHub App/token PR publication, and `output` modes in compliant 80% ASD-STE100 prose; `npm run lint:docs` and `npm run site` pass with zero errors.
      Verify: `npm run lint:docs && npm run site && npm test`

### Test Plan

[x] I/we understand the owners of the involved components may require updates to existing tests to make this
code solid enough prior to committing the changes necessary to implement this enhancement.

#### Prerequisite testing updates
None. Existing multi-core test runner (`scripts/run-tests.mjs`) and package test suites are green on Node.js `v26.13.0`.

#### Unit tests
- `@loopwright/agent-pi`: `2026-11-13` - `>= 90%` on touched modules (`catalog.ts`, `policy.ts`, `usage.ts`, `host-session.ts`): built-in and custom `cost` validation, OpenAI (`cached_tokens` subset) vs Anthropic (additive cache tokens) `estimated` `costMicrousd` math, root export surface lock (`4` symbols), and `host-session` without Docker socket (`x64`/`arm64`, `/workspace/candidate` prompt parity, child env scrubbing of `LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN`, and out-of-band `owned.candidate` tamper refusal).
- `@loopwright/github-app`: `2026-11-13` - `>= 90%` on touched modules (`schema.ts`, `taskpack.ts`, `models-config.ts`, `upstreams.ts`, `turnkey.ts`, `output-format.ts`, `action.ts`): symlinked `<controlRoot>` refusal, root `taskpack.yaml` + custom `.auto-sync/custom.yaml` protection, `.claude`/`.agents` protection, explicit glob/invalid char refusal (`TASKPACK_MANIFEST_INVALID`), omitted `writable` + `proposal.path` + `memory.directory` + `sandbox.ts` (`writablePaths: ['.']`), nested `0o700`/`0o600` `spec.instructions` staging and `> 24 KiB` refusal, `command.v1` 64-char `checkId` + dangerous `env` refusal + mixed `externalGates` bindings + `> 256`-char stderr truncation, and bare `<prefix>\n<guidance>` parsing.
- `@loopwright/controller`: `2026-11-13` - `>= 90%` on touched modules (`source.ts`, `controller.ts`, `inspect.ts`, `report.ts`): protected `120000` symlink skip vs unprotected symlink `CAPABILITY_UNSUPPORTED`, `gate.v1` denial reason propagation within `16 KiB` prompt cap, settled `UsageSummary` + `externalUrl` inspection, and `formatCostUsd` / workflow-command neutralization.
- `@loopwright/cli`: `2026-11-13` - `>= 90%` on touched modules (`arguments.ts`, `main.ts`): `--output-format` and `--step-summary-file` across `run`/`resume`/`reconcile`, ANSI & `::error::`/`::add-mask::` neutralization without breaking `--json` NDJSON envelopes, and `closure --verify-failures` regression guard.

#### Integration tests
- End-to-end offline Action cycle (`packages/github-app/test/turnkey-action.test.ts`): temporary git repository containing a protected `.claude/skills` symlink, `.auto-sync/taskpack.yaml`, `.auto-sync/prompts/instructions.md`, `.auto-sync/checks/verify.sh`, omitted `spec.sandbox` under `GITHUB_ACTIONS=true`, `writable: ['pack', 'docs']` + `protected: ['pack/dependencies.json']`, and `LLM_TOKEN=bad_tok,good_tok` against local mock LLM SSE + mock GitHub REST/git remote servers → verifies mid-run HTTP 429 on attempt 0 rotates cleanly to attempt 1 (`-a1` `runId`, no `OWNER_BUSY`), `command.v1` 4 KiB stderr denial scrubs/truncates `reason <= 256` chars and triggers bounded repair, second candidate passes `scope.v1` + `json-artifact.v1` + `command.v1`, temporary `git worktree` publisher opens PR while leaving checkout `HEAD` and `.claude/skills` intact, and `output: json,github-step-summary` writes scrubbed JSON + Markdown summary with estimated USD cost and zero leaked secrets.
- Mutated remote PR head refusal (`packages/github-app/test/turnkey-action.test.ts`): concurrent commit on remote managed PR branch causes `--force-with-lease` push check to fail closed without overwriting remote commits.

#### e2e tests
Live GitHub Actions workflow execution with external GitHub App installation credentials and live LLM billing endpoints remains gated by deployed repository secrets outside offline CI (`deployed-github-app-and-webhook-ingress` and `live-provider-billing-and-effort-attestation` in `packages/cli/src/closure.ts`). All HTTP, git remote, subprocess, and SQLite state paths are exercised end-to-end against loopback servers and real local git repositories in `turnkey-action.test.ts`.

## Alternatives

- **Add a new `command.v1` kernel handler implementation to `@loopwright/controller` `installedHandlerDigests()`**: Rejected because `gate.v1` already implements signed intent-before-dispatch, monotonic lease clamping, checkpoint restore, and bounded implementation repair; bridging `Taskpack` `command.v1` (`timeoutSeconds <= 55`) through an ephemeral HMAC-signed loopback gate preserves `@loopwright/controller`'s frozen handler inventory while enforcing compile-time script SHA-256 verification and credential scrubbing.
- **Require Docker or Bubblewrap on GitHub Actions by default**: Rejected because standard GitHub-hosted Actions jobs already run inside single-use ephemeral VMs where unprivileged user namespaces (`bwrap`) are often restricted by AppArmor and nested Docker containers omit host toolchain binaries (`crane`, `yq`, `git`) needed by domain tasks; `direct-dedicated` with `scope.v1` post-verification provides zero-overhead execution while keeping explicit `spec.sandbox` available for self-hosted runners.
- **Keep external Python/Node sidecar scripts in each target repository for upstream discovery and PR creation**: Rejected because duplicating 1,500+ lines of HTTP daemon boilerplate per repository defeats Loopwright's purpose as a reusable harness.

## Open Questions

None.
