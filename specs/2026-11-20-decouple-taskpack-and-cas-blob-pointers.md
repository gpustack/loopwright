# Spec: Decouple generic Taskpack execution and adopt content-addressable blob pointers

Status: Building
Type: Feature

## Summary

Extract Loopwright's generic declarative `Taskpack` engine out of [`packages/github-app`](../packages/github-app) into a dedicated `@loopwright/taskpack` workspace package (`packages/taskpack`) and replace inline base64 and whole-file memory transport with immutable Content-Addressable Storage (CAS) blob pointers across the full execution, acceptance, verification, inspection, and publication pipeline. Scope GitHub-specific policy rules (`spec.triggers`, pull-request `spec.publication`, `.github/workflows/**` dual-key host unlock, and multi-tenant GitHub App guards) strictly to GitHub entrypoints — durably bound to retained run metadata across `resume`, `reconcile`, and `step` continuations — while making local CLI and non-GitHub `Taskpack` execution ergonomic with optional `triggers`, `publication`, and `memory`, neutral repository-declared `scope.protected` (without hardcoded tool directories), and direct `loopwright run --taskpack` support. Preserve strict byte caps exclusively on small control documents parsed into memory while streaming large workspace artifacts and candidate overlays through `O_NOFOLLOW`, `nlink === 1`, SHA-256 verified read-only blob pointers.

## Motivation

### Goals

Audit of Taskpack 2.0 ([`specs/2026-11-19-taskpack-v2-orchestration-and-extensible-contracts.md`](2026-11-19-taskpack-v2-orchestration-and-extensible-contracts.md)) and its current implementation across [`packages/github-app`](../packages/github-app), [`packages/controller`](../packages/controller), [`packages/agent-pi`](../packages/agent-pi), [`packages/core`](../packages/core), [`packages/taskpack-runner`](../packages/taskpack-runner), and [`packages/cli`](../packages/cli) identifies two coupled structural bottlenecks:

1. **Tight coupling between generic `Taskpack` execution and the GitHub control plane**:
   - [`packages/github-app/src/index.ts`](../packages/github-app/src/index.ts) bundles generic declarative `Taskpack` parsing, digesting, preflight staging, upstream resolution, OS sandboxing, `TaskContract` compilation, local `command.v1` verification, and delegated step staging together with GitHub webhook intake, `InstallationTokenBroker`, `TenantAdmissionQueue`, and GitHub Pull Request publication.
   - [`packages/cli/src/main.ts`](../packages/cli/src/main.ts) must import `@loopwright/github-app` even for local `loopwright step` and `loopwright digest sync` operations, and offers no direct `loopwright run --taskpack` command for autonomous local Pi runs outside GitHub Actions.
   - [`packages/github-app/src/schema.ts`](../packages/github-app/src/schema.ts) forces every `taskpack.yaml` to declare `spec.triggers`, `spec.memory`, and `spec.publication` (including `targetBranch`, `headBranchPrefix`, and `titleTemplate` even when `publication.mode` is `'disabled'`).
   - Built-in mandatory protection lists in [`packages/github-app/src/types.ts`](../packages/github-app/src/types.ts) (`PROTECTED_AUTOMATION_PATHS`), [`packages/github-app/src/sandbox.ts`](../packages/github-app/src/sandbox.ts) (`ALWAYS_PROTECTED_WORKSPACE_SUBPATHS`), [`packages/controller/src/source.ts`](../packages/controller/src/source.ts) (`HOST_ALWAYS_PROTECTED_PATTERNS`), [`packages/taskpack-runner/src/compile-taskpack.ts`](../packages/taskpack-runner/src/compile-taskpack.ts) (`RUNNER_ALWAYS_PROTECTED_PATHS`), and [`packages/taskpack-runner/src/python-bridge.ts`](../packages/taskpack-runner/src/python-bridge.ts) hardcode tool-specific paths (`.claude`, `.codex`, `CLAUDE.md`, `AGENTS.md`) and apply GitHub-specific `.github/workflows/**` rules unconditionally to non-GitHub local runs.

2. **Artificial file-size walls from inlining file contents into JSON, base64, and V8 buffers**:
   - **Core acceptance and manifest resolution**: [`packages/core/src/artifacts.ts`](../packages/core/src/artifacts.ts) (`digestArtifact`, `resolveInventory`) and [`packages/core/src/acceptance.ts`](../packages/core/src/acceptance.ts) (`evaluateAcceptance`, `constructRunResult`) require full `Uint8Array` buffers in RAM capped at `64 MiB` per file and `128 MiB` aggregate ([`packages/core/src/limits.ts`](../packages/core/src/limits.ts)), preventing terminal `RunResult` construction for large overlays even if upstream capture succeeded.
   - **Delegated capture (`delegated-capture.v1`) and controller scheduling**: [`packages/controller/src/step.ts`](../packages/controller/src/step.ts) allocates a full `Buffer` for changed files, enforces `perFileMaxBytes` (`1 MiB` default, `32 MiB` max in [`packages/controller/src/source.ts`](../packages/controller/src/source.ts)), and base64-encodes every changed overlay file into one JSON blob in [`packages/controller/src/capture.ts`](../packages/controller/src/capture.ts), while [`packages/controller/src/budget-observations.ts`](../packages/controller/src/budget-observations.ts) copies every file under `64 MiB` / `256 MiB` caps and [`packages/controller/src/storage.ts`](../packages/controller/src/storage.ts) rejects `maximum > 100,663,296` bytes when `workspaceMaxBytes` scales with base64 overlay budgets.
   - **Pi checkpoint capture and preflight admission**: [`packages/agent-pi/src/capture.ts`](../packages/agent-pi/src/capture.ts), [`packages/agent-pi/src/decode-capture.ts`](../packages/agent-pi/src/decode-capture.ts), and [`packages/agent-pi/src/preflight.ts`](../packages/agent-pi/src/preflight.ts) split every candidate file into `32 KiB` base64 NDJSON rows and require full `Uint8Array` views under a `64 MiB` `fileBytes` / `256 MiB` `artifactBytes` ceiling ([`packages/agent-pi/src/policy.ts`](../packages/agent-pi/src/policy.ts)).
   - **Run inspection, `command.v1` gate staging, `taskpack-runner`, and PR publication**: [`packages/controller/src/inspect.ts`](../packages/controller/src/inspect.ts) serializes all candidate files as base64 inside `candidate.files.json`, hitting [`packages/controller/src/bundle.ts`](../packages/controller/src/bundle.ts) `PublicBundle` caps (`8 MiB` per entry, `16 MiB` total). `startLocalCommandGateServer` and `startNativePullRequestPublisherServer` in [`packages/github-app/src/turnkey.ts`](../packages/github-app/src/turnkey.ts) parse `candidate.files.json` into memory and pipe `Buffer` contents to disk or `git hash-object --stdin`, while [`packages/taskpack-runner/src/service.ts`](../packages/taskpack-runner/src/service.ts) base64-encodes `candidateFiles` over a `1 MiB` stdin stream and [`packages/github-app/src/preflight.ts`](../packages/github-app/src/preflight.ts) / `copyDirectoryTreeReadOnly` buffer whole staged files via `handle.readFile()`.

Success is measured by:
- Extracting `@loopwright/taskpack` cleanly as the tenth workspace package, keeping `@loopwright/github-app` focused on GitHub intake, App control plane, and PR publication (with backward-compatible `GitHubAppError` `instanceof` identity and symbol re-exports), and supporting `loopwright run --taskpack` in `@loopwright/cli`.
- Allowing minimal local `taskpack.yaml` manifests to omit `triggers`, `publication`, and `memory`, protecting only `<controlRoot>` (preserving the exact-file `spec.proposal.path` carve-out) and `.git` by default in local mode while enforcing `triggers`, PR `publication`, `.github/workflows/**` dual-key unlock, and multi-tenant host policies at GitHub entrypoints and across retained continuations.
- Driving `> 64 MiB` single files and `> 128 MiB` aggregate overlays end-to-end through `step` / `agent-pi` capture, `scope.v1`, `command.v1`, `inspectRun`, `evaluateControllerAcceptance` -> terminal `RunResult`, and native Git PR tree construction via immutable CAS blob pointers (`O_NOFOLLOW`, `nlink === 1`, streaming SHA-256) with bounded heap growth and zero base64 JSON inflation.
- Preserving strict byte limits on all in-memory control documents and passing all build, typecheck, lint, docs, site, test, and 23-row closure gates.

### Non-Goals

- Removing backward-compatible `@loopwright/github-app` re-exports of `@loopwright/taskpack` symbols in this iteration.
- Rewriting or invalidating frozen offline parity snapshots in [`packages/taskpack-runner/vendor/runner-auto-sync/manifest.json`](../packages/taskpack-runner/vendor/runner-auto-sync/manifest.json) (passive read-only decoding of legacy v1 base64 captures stays supported).
- Relaxing memory or byte caps on control-plane JSON/YAML documents parsed into memory (`taskpack.yaml`, `LOOPWRIGHT_PREFLIGHT_OUT`, `LOOPWRIGHT_CHECK_OUT`, SQLite metadata, `submission` / `StepVerdict`, `mount: 'prompt'` resources, or `verifier-worker` structured JSON/section guard targets).
- Making `loopwright inspect` export bundles self-contained copies of multi-GiB CAS blobs after a private run directory is deleted (export bundles carry `cas://sha256/<hex>` URIs and verified run-local `blobPath` references).

## Proposal

Introduce `@loopwright/taskpack` as Loopwright's standalone declarative execution package, separate `'local'` vs `'github'` policy profiles with durable run-level provenance, and upgrade core acceptance, candidate overlay capture, Pi snapshots, inspection, verification, workspace staging, and Git PR publication to operate on verified read-only CAS blob pointers rather than inline bytes.

### User Stories

#### Story 1
As a developer running Loopwright locally or on non-GitHub CI, I want to author a concise `taskpack.yaml` without `triggers`, PR `publication`, or `memory` boilerplate and run it directly via `loopwright run --taskpack` or `loopwright step` using `@loopwright/taskpack`, so that declarative workflows execute cleanly without GitHub Action shims or GitHub-specific config fields.

#### Story 2
As a repository maintainer using diverse coding agents and custom directory layouts, I want Loopwright's core engine and sandboxes to protect only `<controlRoot>` and `.git` by default in local mode and let `spec.scope.protected` declare repository-specific protected paths, while keeping `.github/workflows/**` dual-key protection and trigger/PR rules strictly enforced on GitHub Action and GitHub App entrypoints and across crash recovery.

#### Story 3
As a workflow author working with large lockfiles, vendor archives, binary assets, or generated build artifacts, I want candidate overlays, Pi and delegated checkpoints, `command.v1` verification, `loopwright inspect`, core acceptance (`RunResult`), PR publication, and `mount: 'workspace'` preflight resources to pass immutable CAS blob pointers verified by streaming SHA-256, so that large files never fail on base64 JSON caps or exhaust Node.js heap memory.

#### Story 4
As a security and platform engineer, I want strict memory and parser ceilings preserved on every control document parsed into RAM alongside `O_NOFOLLOW`, `nlink === 1`, read-only (`0o400` / `0o444`), crash-safe atomic CAS commit ordering, and derived-form sliding-window secret-scrub invariants on streamed CAS blobs, so that decoupling large-file transport never weakens containment, secret scrubbing, or deterministic evidence binding.

### Core Features & Acceptance Criteria

#### 1. Extract `@loopwright/taskpack` Package and Add `loopwright run --taskpack` (`packages/taskpack`, `@loopwright/github-app`, `@loopwright/cli`, `scripts/`)
- Create `packages/taskpack` (`@loopwright/taskpack`) as the tenth workspace package depending on `@loopwright/core`, `@loopwright/state`, `@loopwright/agent-pi`, `@loopwright/controller`, `@loopwright/decisions`, `@loopwright/memory`, and `yaml`:
  - Move generic Taskpack contracts and runtime modules into `packages/taskpack/src/`:
    - Manifest, sandbox, upstream, preflight, digest, model, and local execution types (`types.ts`). Define `TaskpackError` carrying the unified error code union and export `TaskpackError as GitHubAppError` from `@loopwright/github-app` so `error instanceof TaskpackError` and `error instanceof GitHubAppError` both evaluate to `true` across all callers.
    - Deterministic YAML 1.2 core parser and Pretty YAML serializer (`yaml.ts`).
    - Manifest parser, `spec.vars` AST interpolator, scope validator (preserving the exact-file `canCarveOutControlRootProposal` / `isControlRootProposalWritableAllowed` carve-out and sibling protection), and execution authority validator (`schema.ts`).
    - Runtime file/directory SHA-256 hashing and `digests.lock.json` management (`digests.ts`, appending an actionable `Run "loopwright digest sync --taskpack <path> --repo ." to refresh the lockfile.` remediation hint to `verifyDigestLockfile` / `assertDigestLockfileVerified` failure reasons).
    - Authorized host preflight runner and staged resource manifest formatter (`preflight.ts`).
    - Generic upstream discovery (`http-json`, `git-tag`, `git-commit`, `custom-table`, `github-release` with injectable auth header/token resolver), `upstreamGroups`, `held_back` resolution, and git revision helpers (`upstreams.ts`).
    - Model candidate configuration and health probing (`models-config.ts`).
    - OS and container sandbox policy compiler and command runner (`sandbox.ts`) plus host clock/storage qualification (`qualification.ts`).
    - Secret scrubber and sliding-window stream scrubber (`scrubber.ts`).
    - Declarative `Taskpack` loader, `TaskContract` / `TrustedRegistry` compiler (auto-scaling role `fileBytes`/`artifactBytes` when `spec.limits.overlay.maxBytes` exceeds defaults), and advisory decision port factory (`taskpack.ts`).
    - Generic report formatting (`output-format.ts`), host-session progress log formatting (`formatHostSessionProgressLog`), local `command.v1` loopback gate server (preserving `entriesDigest` base-tree cache keys and OS network-isolation `onLog` warnings), `stageTaskpackForStep`, `openStagedTaskpackStepGate`, local turnkey cycle runner (`executeTurnkeyCycle`, preserving `LOOPWRIGHT_MAX_TURNS` / `LOOPWRIGHT_MAX_REPAIR_TURNS` circuit-breaker options and inline secret-scrub hooks), and `local-only` / `disabled` memory finalization (`turnkey.ts`, `turnkey-memory.ts`).
- Narrow `@loopwright/github-app` to GitHub-specific responsibilities while re-exporting `@loopwright/taskpack` public APIs from [`packages/github-app/src/index.ts`](../packages/github-app/src/index.ts):
  - Retain `action.ts` (`runGitHubActionEntrypoint`, `runActionCli`, GitHub Action inputs/outputs, PR comment intake), `webhook.ts`, `service.ts` (`startGitHubAppControlPlane`, `MULTI_TENANT_HOST_POLICY`), `config.ts` (`github-app.yaml`), `tenant-queue.ts`, `token-broker.ts` (`InstallationTokenBroker`, GitHub App JWT), GitHub PR lookup/publication (`startNativePullRequestPublisherServer`, `buildNativePullRequestBody`), and `separate-pull-request` memory publication.
- Upgrade `@loopwright/cli` ([`packages/cli/src/main.ts`](../packages/cli/src/main.ts), [`packages/cli/src/arguments.ts`](../packages/cli/src/arguments.ts)):
  - Import Taskpack operations directly from `@loopwright/taskpack` and load `@loopwright/github-app` lazily only when `app-serve` executes.
  - Add `loopwright run --taskpack <FILE> --repo <DIR> --run-root <DIR> --run-id <ID>` (mutually exclusive with `--config`/`--registry`/`--registry-sha256`; supporting `--mode candidate|no-change|auto`, `--role-model`, `--allow-privileged`, `--allow-workflow-writes`, side-effect-free `--dry-run`, `--json`, `--output-format`, and `--step-summary-file`). Under local CLI execution without a PR publisher, `mode: 'auto'` defaults to `'candidate'` when neither `preflight` nor `upstreams` is declared, and `publication.mode: 'pull_request'` or `memory.apply: 'separate-pull-request'` fails closed with `TASKPACK_HOST_BINDING_INVALID`.
- Register `packages/taskpack` across [`package.json`](../package.json), `package-lock.json`, [`tsconfig.test.json`](../tsconfig.test.json), [`.opencodereview/rule.json`](../.opencodereview/rule.json), [`scripts/build.mjs`](../scripts/build.mjs), [`scripts/run-tests.mjs`](../scripts/run-tests.mjs), [`scripts/pack-npm.mjs`](../scripts/pack-npm.mjs), [`scripts/check-docs.mjs`](../scripts/check-docs.mjs), [`scripts/prepare-self-upgrade.mjs`](../scripts/prepare-self-upgrade.mjs), [`.auto-sync/checks/verify.sh`](../.auto-sync/checks/verify.sh), and [`packages/cli/src/closure.ts`](../packages/cli/src/closure.ts) (updating `OWNER_PACKAGES` and moved `qualification.ts` / `sandbox.ts` paths on both `qualified-host-clock-and-storage-profile` and `interactive-mcp-oauth-browser-flow`, preserving `18` `closedLocal` / `5` `unprovisionedExternal`).
- **Acceptance criteria**:
  - `@loopwright/taskpack` builds and passes tests with zero imports from `@loopwright/github-app`.
  - Errors thrown by `@loopwright/taskpack` satisfy both `instanceof TaskpackError` and `instanceof GitHubAppError`.
  - `loopwright run --taskpack <path> --repo <dir> --run-root <dir> --run-id <id>` executes a local Taskpack end-to-end without `GITHUB_*` variables, and `--dry-run` compiles and validates without invoking `preflight`, `memory`, or `publication`.
  - `loopwright closure --verify-failures` passes with `18` `closedLocal` and `5` `unprovisionedExternal` rows.

#### 2. Scoped GitHub Policy Enforcement, Durable Run Provenance, and Neutral Scope (`@loopwright/taskpack`, `@loopwright/github-app`, `@loopwright/controller`, `@loopwright/taskpack-runner`, `.auto-sync/`)
- Introduce explicit policy profiles (`policyProfile: 'local' | 'github'`, defaulting to `'local'` in `@loopwright/taskpack` and `'github'` in `@loopwright/github-app` entrypoints):
  - **Optional manifest sections in generic `Taskpack`**:
    - `spec.triggers`: optional; defaults to `{ schedule: false, workflowDispatch: false, releasePublished: false, commentCommands: [], commentPrefixes: [] }`. On GitHub Action (`runGitHubActionEntrypoint`) and Webhook/App (`startGitHubAppControlPlane`) entrypoints, validate event eligibility against the manifest's declared `spec.triggers` strictly **before** running `spec.preflight` or enqueuing execution items (so omitted/all-`false` triggers refuse undeclared `schedule`, `workflow_dispatch`, `release`, `repository_dispatch`, and comment commands, while installation lifecycle webhooks remain handled).
    - `spec.publication`: optional; defaults to `{ mode: 'disabled' }`. When `mode === 'disabled'`, `targetBranch`, `headBranchPrefix`, and `titleTemplate` are optional. When `mode === 'pull_request'`, `targetBranch`, `headBranchPrefix`, and `titleTemplate` remain required and validated.
    - `spec.memory`: optional; defaults to `{ directory: '<controlRoot>/memory/default', apply: 'disabled', onNoModelBudget: 'skip' }` resolved relative to the manifest's active `controlRoot`.
- **Remove hardcoded tool-specific protected paths across all packages**:
  - Remove `.claude`, `.codex`, `CLAUDE.md`, and `AGENTS.md` from built-in mandatory arrays in `@loopwright/taskpack` (`schema.ts`, `sandbox.ts`), [`packages/controller/src/source.ts`](../packages/controller/src/source.ts) (`HOST_ALWAYS_PROTECTED_PATTERNS`), [`packages/taskpack-runner/src/compile-taskpack.ts`](../packages/taskpack-runner/src/compile-taskpack.ts) (`RUNNER_ALWAYS_PROTECTED_PATHS` / `RUNNER_PROTECTED_PATHS`), and [`packages/taskpack-runner/src/python-bridge.ts`](../packages/taskpack-runner/src/python-bridge.ts).
  - Preserve tracked protected symlink/gitlink handling in `freezeSource` ([`packages/controller/src/source.ts`](../packages/controller/src/source.ts)): tracked `120000`/`160000` entries covered by `task.spec.scope.protected` are skipped (never copied, followed, or `chmod`ded), while unprotected symlinks/gitlinks continue to fail closed with `CAPABILITY_UNSUPPORTED`. Update [`.auto-sync/taskpack.yaml`](../.auto-sync/taskpack.yaml) to declare `.claude/**`, `CLAUDE.md`, and `AGENTS.md` in `spec.scope.protected`.
- **Durable run-level binding of `policyProfile` and `allowWorkflowWrites`**:
  - Under `policyProfile: 'local'`, built-in mandatory protection covers only `.git` and `<controlRoot>` (preserving the exact-file `spec.proposal.path` carve-out and sibling protection, plus manifest-referenced scripts, instructions, skills, lockfiles, toolchains, and `spec.scope.protected`).
  - Under `policyProfile: 'github'`, `.github` is protected by default, unlocking `.github/workflows/**` requires intersection of manifest `allowWorkflowWrites: true` AND operator `allow-workflow-writes: true` (keeping all existing and new non-workflow `.github/**` paths protected), and `MULTI_TENANT_HOST_POLICY` denies all self-granted privileged capabilities.
  - Persist `hostPolicy: { policyProfile: 'local' | 'github', allowWorkflowWrites: boolean }` in `run.json` ([`packages/controller/src/retained.ts`](../packages/controller/src/retained.ts)), `step-meta.json` ([`packages/controller/src/step.ts`](../packages/controller/src/step.ts)), and staged `secrets.json`. On `resumeCycle`, `reconcileCycle` (both variants in [`packages/controller/src/reconcile.ts`](../packages/controller/src/reconcile.ts)), `stepNext`, and `stepSubmit`, reload and enforce the persisted `hostPolicy` (legacy `run.json` descriptors without `hostPolicy` default conservatively to `{ policyProfile: 'github', allowWorkflowWrites: false }`, refusing any caller mismatch with `RECOVERY_REQUIRED`).
- **Acceptance criteria**:
  - Minimal local `taskpack.yaml` manifests omitting `triggers`, `publication`, and `memory` run to terminal `completed` via `loopwright run --taskpack` and `loopwright step`.
  - GitHub Action and App entrypoints reject undeclared triggers before `preflight` or queue admission, and a `'github'` run interrupted mid-cycle continues to block unapproved `.github/workflows/**` mutations across `resumeCycle` and `reconcileCycle` even if caller `ports` are omitted.

#### 3. Content-Addressable Blob Store, Crash-Safe Commit Order, and Verified Core Acceptance (`@loopwright/core`, `@loopwright/controller`)
- Extend `@loopwright/core` ([`packages/core/src/artifacts.ts`](../packages/core/src/artifacts.ts), [`packages/core/src/acceptance.ts`](../packages/core/src/acceptance.ts), [`packages/core/src/limits.ts`](../packages/core/src/limits.ts), [`packages/core/src/boundary.ts`](../packages/core/src/boundary.ts)) and `@loopwright/state` ([`packages/state/src/boundary.ts`](../packages/state/src/boundary.ts)):
  - Add `digestArtifactFromMetadata(name, metadata: { digest: Digest; byteLength: number; uri?: string | null; mediaType?: string | null })` validating `name`, lowercase 64-hex SHA-256 `digest`, safe non-negative integer `byteLength` (`0..Number.MAX_SAFE_INTEGER`), and optional `uri`/`mediaType` (omitted when unset so `ArtifactManifest` JCS digests stay bit-for-bit identical).
  - Extend `resolveInventory`, `evaluateAcceptance`, and `constructRunResult` to accept `ResolvedArtifactInput = ResolvedArtifact | VerifiedArtifactDescriptor` (`{ readonly name: string; readonly byteLength: number; readonly digest: Digest }`) alongside raw `{ name, bytes }` items: raw `Uint8Array` entries still enforce `LIMITS.artifactBytes` (`64 MiB`) and `LIMITS.resolvedBytes` (`128 MiB`), while `VerifiedArtifactDescriptor` entries supplied by trusted host controllers after physical CAS verification scale up to `OVERLAY_LIMITS.maxMaxBytes` (`17_179_869_184` = `16 GiB`) and `OVERLAY_LIMITS.maxMaxFiles` (`16_384` files, raised 4x from `4_096`, still strictly below `LIMITS.baselineEntries` `65_536`). Raise `STATE_LIMITS.wideCheckpointBytes` to `8_388_608` (`8 MiB`) so `16_384`-entry checkpoint manifests settle cleanly in `@loopwright/state`.
- Implement crash-safe CAS blob storage and CoW-first read-only projections in [`packages/controller/src/storage.ts`](../packages/controller/src/storage.ts), [`packages/controller/src/files.ts`](../packages/controller/src/files.ts), and [`packages/controller/src/credentials.ts`](../packages/controller/src/credentials.ts):
  - Store blobs under `<artifactsDir>/blobs/sha256/<hex>` using a strict commit order:
    1. Stream `1 MiB` (`1_048_576`-byte) chunks from an `O_RDONLY | O_NOFOLLOW` source (`!isSymbolicLink()`, `isFile()`, `nlink === 1`, stable `dev`/`ino`/`size`/`mtimeMs`/`ctimeMs` before and after read) into `<artifactsDir>/blobs/sha256/.tmp-<rand>` (`O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW`, `0o600`).
    2. Run a stateful sliding-window secret check on every ingestion (including CAS dedup hits under updated credential sets) whose byte overlap is dynamically sized to `max(16_384, maxDerivedSecretBytes)` across all derived forms (`raw`, JSON-escaped, URL-encoded, `base64`, and generic token patterns) and UTF-8 multi-byte boundaries across `1 MiB` chunk boundaries.
    3. Seal `.tmp-<rand>` (`fchmod(0o400)` + `fsync` + `close`), publish collision-safely (`link` to final `<hex>` then `unlink` temp; on `EEXIST`, verify existing `<hex>` via streaming SHA-256 and never overwrite in place), and `fsync` the `sha256/` directory **before** writing any referencing checkpoint or capture JSON.
    4. Retain committed CAS blobs for the run's lifetime; clean only unreferenced `.tmp-*` files under active `ControllerOwner`.
  - When projecting CAS blobs or verified source files into read-only staging or candidate trees (`copyVerifiedFileReadOnly`, `streamCopyVerifiedBlob`, `preflight.ts`, `turnkey.ts`), attempt Copy-on-Write reflink first (`fs.copyFile` with `COPYFILE_FICLONE | COPYFILE_EXCL`, creating an independent inode preserving `nlink === 1` and verifying `O_NOFOLLOW` + SHA-256 + `fstat` stability), falling back seamlessly to `1 MiB` (`1_048_576`-byte) chunk streaming when CoW reflink is unsupported (`ENOTSUP`, `EXDEV`, `EINVAL`, `ENOSYS`).
  - Resolve `cas://sha256/<hex>` URIs strictly beneath `<runRoot>/<runId>/artifacts/blobs/sha256/<hex>` (`canonicalComponents`, rejecting cross-run paths, symlinks, and `nlink !== 1`), treating any exported `blobPath` solely as a cross-checked hint.
- **Acceptance criteria**:
  - `evaluateControllerAcceptance` and `constructRunResult` settle a `completed` `RunResult` for a `> 64 MiB` single file, `> 128 MiB` aggregate candidate overlay, and up to `16_384` overlay entries using `VerifiedArtifactDescriptor` entries backed by verified CAS blobs.
  - Raw, JSON-escaped, URL-encoded, and base64 secrets spanning a `1 MiB` (`1_048_576`-byte) chunk boundary are refused before CAS publication, leaving zero `.tmp-*` or `<hex>` files behind, and read-only projections preserve `nlink === 1` on both CoW reflink and `1 MiB` streaming fallback paths.

#### 4. End-to-End Pointer Pipeline Across Controller, Pi Adapter, Inspection, Verification, Runner, and Publisher (`@loopwright/controller`, `@loopwright/agent-pi`, `@loopwright/taskpack`, `@loopwright/github-app`, `@loopwright/taskpack-runner`)
- **Controller capture, step, scheduling, triage, and `16,384`-file metadata budgets**:
  - Emit `delegated-capture.v2` (`overlay: [{ name, mode, sha256, byteLength, blobRef }]`, zero `bodyBase64`) while keeping bounded read-only decoding for `delegated-capture.v1` (updating `resolveCurrentFileModes` in `step.ts` to read modes from both v1 and v2).
  - Scale metadata budgets in `source.ts`, `parser.ts`, and `verifier-protocol.ts` for `OVERLAY_LIMITS.maxMaxFiles = 16_384`: decouple `v2WorkspaceJsonMaxBytes` (`<= 32 MiB`, well below `storage.ts` / `parser.ts` `96 MiB` JSON ceiling) from `overlay.maxBytes`, scale `manifestMaxBytes` (`<= 80 MiB`), `checkpointInputMaxBytes` (`<= 8 MiB`), `parsePrivateJson` `collectionLimit` (`<= 65_536`) and dynamic `nodeLimit`, and `verifier-protocol.ts` `overlayProtocolBounds` (`overlay.maxFiles <= 16_384`, `overlay.maxBytes <= 16 GiB`).
  - Upgrade `scanCandidateDirectory` (`step.ts`) to hash opened descriptors (`O_RDONLY | O_NOFOLLOW`) in `1 MiB` (`1_048_576`-byte) chunks (`entriesSeen` ceiling `>= 131_072`) and verify post-read `fstat` identity even on equal-size unchanged baseline files (zero CAS writes for unchanged files), streaming only changed files into CAS blobs.
  - Upgrade `schedulingSnapshot` ([`packages/controller/src/budget-observations.ts`](../packages/controller/src/budget-observations.ts)), `ByteInventory` ([`packages/controller/src/verification.ts`](../packages/controller/src/verification.ts)), `triageCandidateDiff` (`controller.ts`, emitting digest/size summaries instead of decoding oversized/binary blobs), and `submission.ts` (reading only the selected `submission.path` `<= 1 MiB`) to operate on CAS pointers without whole-overlay RAM copies. `scope.v1` and `no-change.v1` perform zero file reads; `json-artifact.v1`, `json-keys-guard.v1`, and `line-section-guard.v1` read only their single targeted baseline/candidate file under `JSON_FILE_BYTES` (`1,032,184`), so an unrelated `100 MiB` binary in the overlay never blocks a small `proposal.json` check.
- **Pi adapter zero-cycle CAS support (`@loopwright/agent-pi`)**:
  - Without importing `@loopwright/controller`, allow `PiOpenInput.candidate.artifacts` (`preflight.ts`, `candidate.ts`) to accept up to `16_384` verified CAS file descriptors (`{ name, byteLength, digest, blobPath }`) materialized via CoW reflink (`COPYFILE_FICLONE`) with `1 MiB` streaming fallback (`nlink === 1`), emit `{ type: 'blob_ref', ref, blobRef }` rows in `.workspace.ndjson` during `captureCheckpoint` (`1 MiB` `CAS_CHUNK_BYTES`, retaining read-only `{ type: 'chunk' }` v1 decoding and rejecting mixed/duplicate rows), and raise `MAX_LIMITS.candidateEntries` to `16_384` and `MAX_LIMITS.fileBytes` / `MAX_LIMITS.artifactBytes` (`policy.ts`, `host-session.ts`, `tool-worker.ts`) to `16 GiB` while keeping `promptBytes` (`1 MiB`), `toolArgsBytes` (`4 MiB`), `toolResultBytes` (`4 MiB`), and `sessionBytes` (`64 MiB`) strictly capped.
- **Inspection, `command.v1` gate, hybrid `mountReadOnlyGit`, `mount: 'workspace'` views, `taskpack-runner`, and single-fd Git PR publication**:
  - Upgrade `inspectRun` (`inspect.ts`, `bundle.ts`) to emit `candidate.files.json` (`version: 2`) containing `{ name, mode, sha256, byteLength, uri, blobPath }` only after verifying all referenced CAS blobs exist and match metadata (sizing `PublicBundle` up to `32 MiB` per entry / `64 MiB` total for `16,384`-file overlays, marking `candidate.files.json` absent if any blob is missing/corrupt).
  - Upgrade `startLocalCommandGateServer` (`turnkey.ts`) to resolve canonical `cas://sha256/<hex>` blobs under `<runRoot>/<runId>/artifacts/blobs/sha256/<hex>`, project them into a private staging directory via CoW reflink (`COPYFILE_FICLONE`) or `1 MiB` streaming copy with `O_NOFOLLOW` + `nlink === 1` + SHA-256 verification before exposing `candidateDir`, and stream `copyDirectoryTreeReadOnly` with CoW reflink / `1 MiB` fallback (`1 GiB` toolchain cap).
  - Upgrade `mountReadOnlyGit` (`turnkey.ts`, `sandbox.ts`) to a **hybrid sanitized-skeleton + zero-copy `.git/objects` architecture** (never `--ro-bind` the raw `.git` directory, preventing leakage of `.git/config` `GITHUB_TOKEN` headers/URLs, `credentials`, `config.worktree`, and `hooks/`): `stageSanitizedReadOnlyGitDir` copies only the lightweight sanitized skeleton (excluding `config`, `config.worktree`, `hooks`, `credentials`, and `objects`) and writes `SANITIZED_READ_ONLY_GIT_CONFIG`; after verifying `<repo>/.git/objects` contains zero symlinks, Linux `bwrap` / `docker` mount-namespace sandboxes mount `--ro-bind <repo>/.git/objects <candidateDir>/.git/objects` (`:ro`), whereas macOS Seatbelt / Linux Landlock (no mount namespace) clone `<repo>/.git/objects` files via CoW reflink (`COPYFILE_FICLONE`) first and fall back to `1 MiB` streaming copies across filesystems.
  - Keep `mount: 'workspace'` visibility strictly partitioned (`preflight.ts`, `turnkey.ts`): project verified files via CoW reflink (`COPYFILE_FICLONE`) with `1 MiB` streaming fallback (`nlink === 1`, no hardlinks) into separate read-only directory projections (`workspaceStagedDir` for all workspace resources vs `checkStagedDir` containing **only** `exposeToChecks: true` resources).
  - Upgrade `startNativePullRequestPublisherServer` (`@loopwright/github-app`) to open each canonical CAS blob **once** (`O_RDONLY | O_NOFOLLOW`, `nlink === 1`), stream its `1 MiB` (`1_048_576`-byte) chunks into `git hash-object -w --stdin` while simultaneously computing SHA-256 and expected Git blob OID, verify post-read `fstat` stability, and assert the returned Git OID equals the computed Git blob OID before staging in `GIT_INDEX_FILE` (eliminating pathname reopen TOCTOU and `Buffer` stdin buffering while preserving baseline/overlay file mode rules).
  - Upgrade [`packages/taskpack-runner/src/service.ts`](../packages/taskpack-runner/src/service.ts) to decode both `blob_ref` and `chunk` checkpoint rows in `1 MiB` chunks, pass a bounded pointer-index file path to `GATE_DRIVER` instead of inline `candidateFilesB64` over the `1 MiB` `PythonBridge` stdin pipe, and read `proposal.json` under its control-document cap.
- **Strict control-document byte limits preserved**:
  - Preserve exact byte caps on `taskpack.yaml` (`64 KiB`), `github-app.yaml` (`64 KiB`), `LOOPWRIGHT_PREFLIGHT_OUT` (`512 KiB`), `LOOPWRIGHT_CHECK_OUT` (`64 KiB`), `submission` / `StepVerdict` (`64 KiB`–`1 MiB`), `gate_verdict` (`64 KiB`), SQLite WAL state pages, `mount: 'prompt'` (`64 KiB` / `256 KiB`), and `verifier-worker` structured JSON/guard targets (`1,032,184` bytes).
- **Acceptance criteria**:
  - Delegated and Pi runs with one `> 64 MiB` binary and two files totaling `> 128 MiB` (plus an unchanged large baseline file, a same-size modified file, a deleted file, and a small `proposal.json` checked by `json-artifact.v1`) complete capture, restart/recovery, `scope.v1`, `json-artifact.v1`, `command.v1`, `inspectRun`, `RunResult`, and native Git commit-tree creation with zero CAS writes for the unchanged baseline file and bounded RSS/ArrayBuffer usage.
  - A `command.v1` check with one `exposeToChecks: true` and one `exposeToChecks: false` workspace resource can read only the `exposeToChecks: true` file, including after restart and preflight temp cleanup.

### Notes / Constraints / Caveats

- Strict ESM TypeScript (`NodeNext`), explicit public types, and zero `any` across all ten workspace packages.
- Validate all untrusted JSON/YAML inputs including null-prototype objects (`Object.create(null)`), enforce `O_NOFOLLOW` and `nlink === 1` on every file read/write boundary, and maintain deterministic RFC 8785 JCS canonical serialization.
- `@loopwright/github-app` re-exports `TaskpackError as GitHubAppError` and all `@loopwright/taskpack` symbols so `instanceof` checks and imports remain 100% compatible.
- Keep `ArtifactManifest.spec.entries` free of `uri` fields so `Subject.candidateDigest` hashes stay identical across v1 and v2 captures; carry `uri: "cas://sha256/<hex>"` on CAS `blobRef` pointers and staged/evidence artifact descriptors.
- Keep tests lean, neutral, and focused on real public boundaries, invariants, negative paths, limits, and uncertainty (no bloated, mock-heavy, text/version-scraping, or change-coupled ad-hoc tests).
- Keep the 23-row capability closure split (`18` `closedLocal`, `5` `unprovisionedExternal`) intact in [`packages/cli/src/closure.ts`](../packages/cli/src/closure.ts).

### Boundaries

- **Always:**
  - Stream large files in `1 MiB` (`1_048_576`-byte) chunks with `O_NOFOLLOW`, `!isSymbolicLink()`, `isFile()`, `nlink === 1`, dev/ino/size/mtime stability checks, crash-safe `.tmp` -> `0o400` `fsync` -> `link` -> parent `fsync` commit ordering, derived-form sliding-window secret scrubbing across `1 MiB` chunk boundaries, and CoW reflink (`COPYFILE_FICLONE`, keeping `nlink === 1`) with `1 MiB` streaming fallback for read-only projections.
  - Stage `mountReadOnlyGit` via sanitized `.git` skeleton (excluding `config`, `config.worktree`, `hooks`, `credentials`, and `objects` + `SANITIZED_READ_ONLY_GIT_CONFIG`) combined with `--ro-bind <repo>/.git/objects` on Linux `bwrap`/`docker` or CoW reflink (`COPYFILE_FICLONE`) + `1 MiB` fallback on macOS Seatbelt / Linux Landlock — never bind-mount raw `.git` directly.
  - Persist `hostPolicy` (`policyProfile` + `allowWorkflowWrites`) in run metadata and enforce `spec.triggers`, PR `spec.publication`, `.github/workflows/**` dual-key unlock, and `MULTI_TENANT_HOST_POLICY` on all GitHub entrypoints and their continuations.
  - Keep `.git` and `<controlRoot>` (with exact-file `spec.proposal.path` carve-out and sibling protections, plus manifest control assets and `spec.scope.protected`) write-protected in both `'local'` and `'github'` profiles.
  - Keep strict memory/byte limits on `taskpack.yaml`, `LOOPWRIGHT_PREFLIGHT_OUT`, `LOOPWRIGHT_CHECK_OUT`, SQLite state, `mount: 'prompt'`, and `verifier-worker` structured JSON/guard files.
- **Ask first:**
  - Before adding any new third-party runtime npm dependency to any workspace package.
  - Before changing the 23-row capability closure split (`18` `closedLocal`, `5` `unprovisionedExternal`) or modifying SQLite table DDL in `@loopwright/state`.
  - Before removing `@loopwright/github-app` compatibility re-exports of `@loopwright/taskpack`.
- **Never:**
  - Never hardcode agent-specific or vendor-specific dot-directories (`.claude`, `.codex`, `CLAUDE.md`, `AGENTS.md`) inside `@loopwright/core`, `@loopwright/controller`, `@loopwright/taskpack`, or `@loopwright/taskpack-runner` built-in mandatory protection lists.
  - Never import `@loopwright/github-app` inside `@loopwright/taskpack`, `@loopwright/controller`, `@loopwright/agent-pi`, `@loopwright/core`, or `@loopwright/state`, and never import `@loopwright/controller` inside `@loopwright/agent-pi`.
  - Never inline candidate overlay file bytes as base64 in `delegated-capture.v2`, `.workspace.ndjson` v2 `blob_ref` rows, or `candidate.files.json` v2.
  - Never silently retry uncertain external effects or broaden authority when reopening legacy run descriptors lacking `hostPolicy`.

### Risks and Mitigations

- **Authority loss on `resumeCycle` / `reconcileCycle` / `step` restart if `policyProfile` is only an in-memory port** -> Mitigation: persist `hostPolicy: { policyProfile, allowWorkflowWrites }` in `run.json`, `step-meta.json`, and staged `secrets.json`, defaulting legacy descriptors without `hostPolicy` conservatively to `{ policyProfile: 'github', allowWorkflowWrites: false }`.
- **TOCTOU pathname reopen between CAS verification and `git hash-object` during PR publication** -> Mitigation: resolve canonical `cas://sha256/<hex>` beneath `<runRoot>/<runId>/artifacts/blobs/sha256/<hex>`, open the descriptor once with `O_RDONLY | O_NOFOLLOW`, stream chunks to `git hash-object -w --stdin` while hashing SHA-256 and Git blob OID, re-verify `fstat`, and assert the returned Git OID matches the computed Git OID.
- **Final `RunResult` refusal (`LIMIT_ARTIFACT_BYTES` / `LIMIT_RESOLVED_BYTES`) or `storage.ts` `96 MiB` JSON reader refusal under wide `overlay.maxBytes`** -> Mitigation: accept `VerifiedArtifactDescriptor` in `@loopwright/core` `resolveInventory` / `evaluateAcceptance` / `constructRunResult` for controller-verified CAS entries, decouple metadata-only `v2WorkspaceJsonMaxBytes` (`<= 16 MiB`) from `overlay.maxBytes`, and update `schedulingSnapshot` and `verifier-protocol.ts` to validate pointer metadata without whole-file `Uint8Array` copies.
- **Crash leaving partial CAS files, hardlink aliases, or dangling pointers** -> Mitigation: enforce `.tmp` write -> secret scrub -> `fchmod(0o400)` -> `fsync` -> collision-safe `link`/`unlink` -> directory `fsync` strictly before writing referencing checkpoints, retain committed blobs for run lifetime, and keep separate `nlink === 1` projections for `workspaceStagedDir` vs `checkStagedDir` (`exposeToChecks`).
- **Secret leakage across `1 MiB` chunk boundaries across encoded forms** -> Mitigation: size sliding-window byte overlap to `max(16_384, maxDerivedSecretBytes)` across raw, JSON-escaped, URL-encoded, and base64 forms plus UTF-8 boundaries, and scrub on every ingestion including CAS dedup hits.
- **Credential or hook leakage from raw `.git` mounting under `mountReadOnlyGit`** -> Mitigation: never `--ro-bind` the top-level `.git` directory; copy only the sanitized skeleton (excluding `config`, `config.worktree`, `hooks`, `credentials`, and `objects`) with `SANITIZED_READ_ONLY_GIT_CONFIG`, verify `.git/objects` has no symlinks, and expose `.git/objects` via `--ro-bind` on Linux `bwrap`/`docker` or `COPYFILE_FICLONE` CoW reflink (with `1 MiB` streaming fallback) on Seatbelt/Landlock.
- **`instanceof GitHubAppError` mismatch or workspace/dogfooding drift across 10 packages** -> Mitigation: export `TaskpackError as GitHubAppError` so runtime `instanceof` identity is shared, declare `.claude/**` explicitly in [`.auto-sync/taskpack.yaml`](../.auto-sync/taskpack.yaml), and update `package.json`, `package-lock.json`, [`.opencodereview/rule.json`](../.opencodereview/rule.json), `scripts/{build,run-tests,pack-npm,prepare-self-upgrade}.mjs`, [`.auto-sync/checks/verify.sh`](../.auto-sync/checks/verify.sh), `closure.ts` (rows `149` and `185`), and `docs/README.md` in lockstep.

## Design Details

### Commands

**Confirmed build and test environment**: Local macOS (`Node v26.13.1`, `npm 11.20.0`, workspace root, executed locally without SSH or remote containers). Fresh Git worktrees must sync workspace links and install dependencies before running build or test commands.

```bash
# Sync workspace links in package-lock.json when adding packages/taskpack, then install cleanly
npm install --package-lock-only && npm ci

# Build all ten workspace packages via composite tsc -b
npm run build

# Strict TypeScript check across source and tests
npm run typecheck

# ESLint check across all ten packages and scripts
npm run lint

# Documentation links, module map, YAML examples, and Hugo site generation
npm run lint:docs
npm run site

# Compile tests and run targeted package suites
npx tsc -p tsconfig.test.json
node scripts/run-tests.mjs --pkg core
node scripts/run-tests.mjs --pkg state --concurrency 1
node scripts/run-tests.mjs --pkg agent-pi --concurrency 1
node scripts/run-tests.mjs --pkg controller
node scripts/run-tests.mjs --pkg decisions
node scripts/run-tests.mjs --pkg memory
node scripts/run-tests.mjs --pkg taskpack
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
    artifacts.ts          # + digestArtifactFromMetadata(), VerifiedArtifactDescriptor in resolveInventory()
    acceptance.ts         # evaluateAcceptance() & constructRunResult() accepting VerifiedArtifactDescriptor
    limits.ts             # Raised OVERLAY_LIMITS.maxMaxBytes (16 GiB) & maxMaxFiles (16,384); preserved 1 MiB inputBytes & 64/128 MiB raw buffer caps
  state/src/
    boundary.ts           # Raised wideCheckpointBytes (8 MiB) for 16,384-entry overlay checkpoints
  agent-pi/src/
    preflight.ts          # Accept up to 16,384 verified CAS descriptor entries on PiOpenInput.candidate.artifacts
    candidate.ts          # CoW reflink / 1 MiB streaming CAS candidate materialization & >64 MiB overlay tracking
    capture.ts            # Crash-safe 1 MiB CAS blob writer & blob_ref rows in .workspace.ndjson
    decode-capture.ts     # Streaming blob_ref verification (+ v1 base64 chunk read fallback, mixed-row refusal)
    recovery.ts           # CAS blob_ref snapshot recovery (+ v1 chunk fallback)
    policy.ts             # Raised MAX_LIMITS.candidateEntries (16,384) & fileBytes / artifactBytes (16 GiB); preserved prompt/tool/session caps
    host-session.ts       # Align fileBytes validation with 16 GiB MAX_LIMITS while preserving 4 MiB tool I/O, circuit breaker, & scrub hooks
    progress-summary.ts   # Preserve 64 KiB tool-arg progress summary cap & secret redaction
    tool-worker.ts        # Align worker fileBytes ceiling with 16 GiB MAX_LIMITS
  controller/src/
    storage.ts            # Atomic CAS blob store (<artifactsDir>/blobs/sha256/<hex>), canonical URI resolver, sliding-window scrub
    files.ts              # 1 MiB single-fd streaming O_NOFOLLOW + nlink===1 reader/hasher + COPYFILE_FICLONE CoW projection helper
    credentials.ts        # Derived-form stateful sliding-window secret matcher across 1 MiB chunk boundaries
    source.ts             # Neutral scope protection, opt-in GitHub workflow guard, 16,384-file metadata budgets
    parser.ts             # Dynamic nodeLimit & 65,536 collectionLimit on parsePrivateJson for 16,384-entry overlays
    verifier-protocol.ts  # Accept 16 GiB / 16,384-entry overlay bounds in header while preserving JSON_FILE_BYTES (1,032,184)
    retained.ts           # Persist & validate hostPolicy ({ policyProfile, allowWorkflowWrites }) in run.json
    capture.ts            # delegated-capture.v2 CAS pointer payload (+ bounded v1 read compatibility)
    step.ts               # Zero-unchanged-write 1 MiB streaming scanCandidateDirectory, v1+v2 mode loader, CAS workspace materializer
    budget-observations.ts # Pointer-aware schedulingSnapshot() without 64/256 MiB buffer copies
    verification.ts       # Metadata-only scope.v1/no-change.v1; target-only bounded reads for JSON/section guards
    acceptance.ts         # Pass controller-verified VerifiedArtifactDescriptor entries into core acceptance
    inspect.ts            # candidate.files.json v2 emitting verified CAS URIs and run-local blobPaths
    bundle.ts             # Scale metadata-only candidate.files.json capacity (32 MiB / 64 MiB) for 16,384-entry overlays
  taskpack/               # NEW tenth workspace package (@loopwright/taskpack)
    package.json          # Depends on core, state, agent-pi, controller, decisions, memory, yaml
    tsconfig.json         # Composite NodeNext build config
    src/
      index.ts            # Public @loopwright/taskpack exports
      types.ts            # TaskpackManifest (optional triggers/publication/memory), PolicyProfile, TaskpackError
      yaml.ts             # Deterministic YAML 1.2 core parser & Pretty YAML serializer
      schema.ts           # 'local' vs 'github' profile validation, 16,384 candidateEntries/maxFiles, preserved proposal carve-out
      digests.ts          # 1 MiB streaming SHA-256 file & directory tree digests + digests.lock.json
      preflight.ts        # CoW reflink / 1 MiB streaming mount: 'workspace' staging with partitioned exposeToChecks projections
      upstreams.ts        # Generic upstream discovery (injectable auth), upstreamGroups, held_back, git revision helpers
      models-config.ts    # Model candidate resolution & health probes
      sandbox.ts          # Neutral Seatbelt / Bubblewrap / Landlock / Docker sandbox policy & readOnlyBindMounts
      qualification.ts    # Host clock, filesystem, and MCP auth qualification
      scrubber.ts         # SecretScrubber + derived-form sliding-window stream scrubber
      taskpack.ts         # loadDeclarativeTaskpack, compileDeclarativeTaskpack (auto-scaled fileBytes & candidateEntries), decision port
      output-format.ts    # json / markdown / text / github-step-summary report formatters
      turnkey.ts          # CAS-streamed startLocalCommandGateServer, hybrid mountReadOnlyGit, CoW/1 MiB tree copier, executeTurnkeyCycle
      turnkey-memory.ts   # local-only & disabled memory finalizer
  github-app/src/
    index.ts              # Re-exports @loopwright/taskpack (TaskpackError as GitHubAppError) + GitHub control plane APIs
    action.ts             # Pre-preflight trigger gate, policyProfile: 'github', Action inputs/outputs
    publisher.ts          # Single-fd streamed git hash-object -w --stdin + Git-OID-verified PR publisher & body formatter
    turnkey-memory.ts     # separate-pull-request GitHub memory publication
    webhook.ts            # Webhook signature, installation lifecycle, and comment guidance intake
    service.ts            # Pre-enqueue manifest trigger gate & MULTI_TENANT_HOST_POLICY HTTP control plane
    config.ts             # github-app.yaml loader
    tenant-queue.ts       # Per-tenant fenced admission queue
    token-broker.ts       # GitHub App JWT & installation token broker
  taskpack-runner/src/
    compile-taskpack.ts   # Neutral protected paths (no hardcoded .claude/CLAUDE.md/AGENTS.md)
    python-bridge.ts      # Neutral sandbox mask paths aligned with compile-taskpack.ts
    service.ts            # v1+v2 checkpoint reader & pointer-index file transport to GATE_DRIVER
  cli/src/
    arguments.ts          # Mutually exclusive loopwright run --taskpack <FILE> argument grammar
    main.ts               # Direct @loopwright/taskpack integration, lazy app-serve, side-effect-free --dry-run
    closure.ts            # 10-package OWNER_PACKAGES + updated @loopwright/taskpack evidence paths on rows 149 & 185
    failure-matrix.ts     # Scenario 13 verifies GitHub entrypoint policyProfile: 'github' & instanceof GitHubAppError
```

### Code Style

```ts
// Crash-safe single-descriptor CAS verification & streaming reader (O_NOFOLLOW, nlink === 1)
export interface CasBlobPointer {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly blobRef: ArtifactRef;
}

export async function streamVerifiedCasBlob(
  artifactsRoot: string,
  pointer: CasBlobPointer,
  onChunk: (chunk: Uint8Array) => Promise<void> | void,
): Promise<void> {
  const canonicalBlobPath = join(artifactsRoot, 'blobs', 'sha256', pointer.sha256);
  if (pointer.path !== canonicalBlobPath || pointer.blobRef.uri !== `cas://sha256/${pointer.sha256}`) {
    refuse('ARTIFACT_INVALID', pointer.blobRef.name, 'verification');
  }
  await canonicalComponents(canonicalBlobPath, true);
  const before = await lstat(canonicalBlobPath);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size !== pointer.byteLength) {
    refuse('ARTIFACT_INVALID', pointer.blobRef.name, 'verification');
  }
  const handle = await open(canonicalBlobPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.dev !== before.dev || info.ino !== before.ino || info.size !== pointer.byteLength) {
      refuse('ARTIFACT_INVALID', pointer.blobRef.name, 'verification');
    }
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(1_048_576);
    let offset = 0;
    while (offset < info.size) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.byteLength, info.size - offset), offset);
      if (bytesRead <= 0) break;
      const slice = chunk.subarray(0, bytesRead);
      hash.update(slice);
      await onChunk(slice);
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      offset !== pointer.byteLength
      || after.size !== info.size
      || after.mtimeMs !== info.mtimeMs
      || after.ctimeMs !== info.ctimeMs
      || hash.digest('hex') !== pointer.sha256
    ) {
      refuse('ARTIFACT_INVALID', pointer.blobRef.name, 'verification');
    }
  } finally {
    await handle.close();
  }
}
```

Key conventions:
- Resolve CAS blobs exclusively from canonical `<artifactsRoot>/blobs/sha256/<hex>` and stream from the verified open descriptor (`O_NOFOLLOW`, `nlink === 1`) rather than reopening paths after verification.
- Keep `Object.create(null)` / `Object.hasOwn` guards on every parsed JSON and YAML boundary.
- Persist `hostPolicy` (`policyProfile` + `allowWorkflowWrites`) in run metadata so recovery never guesses ambient authority.

### Implementation Plan

> Parallel execution waves (disjoint `Owns:`, runnable via `my-build decouple-taskpack-and-cas-blob-pointers team` onto `origin/main` `6d28102`):
> - Wave 1: `T1` (`gemini-4-hydrogen`, `high`) `||` `T2` (`gemini-4-neon`, `high`)
> - Wave 2: `T3` (`gemini-4-neon`, `high`) `||` `T4` (`gemini-4-carbon`, `high`) `||` `T6` (`gemini-4-neon`, `high`)
> - Wave 3: `T5` (`gemini-4-carbon`, `high`)
> - Wave 3.5: `T5b` (`gemini-4-carbon`, `high`)
> - Wave 4: `T7` (`gemini-4-carbon`, `high`) `||` `T8` (`gemini-4-neon`, `high`)
> - Wave 5: `T9` (`gemini-4-carbon`, `high`)
> - Wave 6: `T10` (`gemini-4-neon`, `high`) `||` `T11` (`gemini-4-hydrogen`, `high`)
> - Wave 7: `T12` (`gemini-4-neon`, `high`)

- [x] **T1 · Workspace 10-package prefactor and `@loopwright/taskpack` scaffold**
      Blocked by: None
      Owns: `package.json`, `package-lock.json`, `tsconfig.test.json`, `.opencodereview/rule.json`, `scripts/{build,run-tests,pack-npm}.mjs`, `packages/taskpack/package.json`, `packages/taskpack/tsconfig.json`, `packages/taskpack/src/index.ts`, `packages/taskpack/test/scaffold.test.ts`
      Acceptance: Registers `packages/taskpack` (`@loopwright/taskpack`, `private: true`) across root `package.json`, `package-lock.json`, `tsconfig.test.json`, `.opencodereview/rule.json`, and `scripts/{build,run-tests,pack-npm}.mjs` (adding `packages/taskpack/tsconfig.json` to `tsc -b` targets in `scripts/build.mjs` so `npm run build` compiles `packages/taskpack` immediately before `packages/cli` references it in `T10`); composite build, `tsconfig.test.json`, and `node scripts/run-tests.mjs --pkg taskpack` succeed cleanly.
      Verify: `npm install --package-lock-only && npm ci && npm run build && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg taskpack`

- [x] **T2 · `@loopwright/core` streaming `ArtifactRef`, `VerifiedArtifactDescriptor` acceptance, and `16 GiB` overlay ceilings**
      Blocked by: None
      Owns: `packages/core/src/**`, `packages/core/test/**`
      Acceptance: Adds `digestArtifactFromMetadata(name, { digest, byteLength, uri?, mediaType? })` in `artifacts.ts` (omitting unset `uri`/`mediaType` from JCS so `ArtifactManifest` digests stay unchanged); extends `resolveInventory`, `evaluateAcceptance`, and `constructRunResult` (`artifacts.ts`, `acceptance.ts`, `index.ts`) to accept `VerifiedArtifactDescriptor` (`{ name, byteLength, digest }`) alongside raw `{ name, bytes }` so verified `> 64 MiB` / `> 128 MiB` overlays settle terminal `RunResult` documents while preserving `64 MiB` / `128 MiB` caps on raw in-memory `Uint8Array` inputs; raises `OVERLAY_LIMITS.maxMaxBytes` in `limits.ts` to `17_179_869_184` (`16 GiB`) while keeping `LIMITS.inputBytes` (`1 MiB`) strict.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg core`

- [x] **T3 · `@loopwright/agent-pi` zero-cycle CAS `blob_ref` checkpoints, descriptor input, and `16 GiB` overlay limits**
      Blocked by: T2
      Owns: `packages/agent-pi/src/**`, `packages/agent-pi/test/**`, `packages/taskpack-runner/src/parity.ts`, `packages/github-app/test/fast-turnkey-adapter.ts`, `packages/controller/test/{advisory-decisions,reconcile,rework,step-engine}.test.ts`
      Acceptance: Without importing `@loopwright/controller`, `captureCheckpoint` (`capture.ts`) writes candidate overlay files via crash-safe `.tmp` -> `0o400` `fsync` -> collision-safe `link` -> dir `fsync` into `<host.artifactsDirectory>/blobs/sha256/<hex>` and emits `{ type: 'blob_ref', ref, blobRef }` rows (`uri: "cas://sha256/<hex>"`) in `.workspace.ndjson`; `decodePiCapture` (`decode-capture.ts`) and `recoverSnapshot` (`recovery.ts`) verify `blob_ref` pointers via streaming SHA-256 while retaining passive read-only decoding for legacy `{ type: 'chunk' }` rows and refusing mixed/duplicate rows; `preflight.ts` and `candidate.ts` accept verified CAS file descriptors on `PiOpenInput.candidate.artifacts`; `policy.ts`, `host-session.ts`, and `tool-worker.ts` raise `MAX_LIMITS.fileBytes` and `MAX_LIMITS.artifactBytes` to `16 GiB` while keeping `promptBytes` (`1 MiB`), `toolArgsBytes` (`4 MiB`), `toolResultBytes` (`4 MiB`), `sessionBytes` (`64 MiB`), `progress-summary.ts` (`64 KiB` tool-arg summary cap), and `host-session.ts` circuit-breaker/`scrub` hooks intact.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg agent-pi --concurrency 1`

- [x] **T4 · `@loopwright/controller` crash-safe CAS blob store, derived-form stream scrubber, and neutral source scope**
      Blocked by: T2
      Owns: `packages/controller/src/{storage,files,credentials,source,verifier-protocol}.ts`, `packages/controller/test/{storage-cas,progress-storage,progress-source,tree-overlay,report-and-t3,verification-protocol,verification-v2-bounds}*.test.ts`
      Acceptance: `storage.ts`, `files.ts`, and `credentials.ts` implement `CasBlobPointer` (`{ path, sha256, byteLength, blobRef }`) with crash-safe `.tmp` -> derived-form sliding-window secret check (`overlap >= max(16_384, maxDerivedSecretBytes)`, enforced even on dedup hits) -> `0o400` `fsync` -> `link` -> dir `fsync` ingestion and canonical `<artifactsDir>/blobs/sha256/<hex>` single-fd streaming verification; `source.ts` removes `.claude/**`, `CLAUDE.md`, and `AGENTS.md` from `HOST_ALWAYS_PROTECTED_PATTERNS` (preserving startup `validateScopePattern` checks and fail-closed `matchesHostProtectedPattern`), scopes `.github/workflows/**` host protection to `enforceGitHubWorkflowProtection: true`, preserves tracked protected symlink skip vs unprotected symlink refusal in `freezeSource`, decouples metadata-only `v2WorkspaceJsonMaxBytes` (`<= 16 MiB`) from `overlay.maxBytes`, and removes the `32 MiB` `perFileMaxBytes` ceiling; `verifier-protocol.ts` accepts `overlay.maxBytes` up to `OVERLAY_LIMITS.maxMaxBytes` (`16 GiB`) while keeping `JSON_FILE_BYTES = 1_032_184`.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg controller`

- [x] **T5 · `@loopwright/controller` `delegated-capture.v2`, durable `hostPolicy`, pointer `ByteInventory`/acceptance, and `inspect` v2**
      Blocked by: T3, T4
      Owns: `packages/controller/src/{retained,capture,step,budget-observations,verification,acceptance,submission,inspect,bundle,recovery,reconcile,controller,types,index}.ts`, `packages/controller/test/**`
      Acceptance: `retained.ts`, `step.ts`, and `reconcile.ts` persist and enforce `hostPolicy: { policyProfile, allowWorkflowWrites }` across `runCycle`, `resumeCycle`, `reconcileCycle`, `stepNext`, and `stepSubmit` (defaulting legacy `run.json` without `hostPolicy` conservatively to `{ policyProfile: 'github', allowWorkflowWrites: false }`); `capture.ts` emits `delegated-capture.v2` pointers while retaining bounded v1 decode (`resolveCurrentFileModes` supports v1+v2); `step.ts` hashes opened candidate descriptors with post-read `fstat` verification and zero CAS writes on unchanged baseline files, streaming only changed files into CAS; `budget-observations.ts`, `verification.ts`, `acceptance.ts`, `controller.ts` (`triageCandidateDiff`), and `submission.ts` operate on CAS pointers without whole-overlay `Uint8Array` buffering (`scope.v1`/`no-change.v1` do zero file reads; guards read only their target file `<= JSON_FILE_BYTES`; `evaluateControllerAcceptance` passes verified `VerifiedArtifactDescriptor` items to `@loopwright/core` so `> 64 MiB` / `> 128 MiB` overlays produce terminal `RunResult`); `inspect.ts` and `bundle.ts` emit verified `candidate.files.json` v2 pointer indexes up to `4,096` entries.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg controller`

- [x] **T6 · `@loopwright/taskpack` schema (`'local' | 'github'` profiles), digests, upstreams, models, and neutral sandboxes**
      Blocked by: T1, T2
      Owns: `packages/taskpack/src/{types,yaml,schema,digests,upstreams,models-config,sandbox,qualification,scrubber}.ts`, `packages/taskpack/test/{schema,digests,upstreams,models-config,sandbox,qualification,scrubber}*.test.ts`
      Acceptance: Implements standalone `TaskpackError`, YAML 1.2 parser/serializer, `schema.ts` with `policyProfile: 'local' | 'github'` (`'local'` default makes `triggers`, `publication`, and `memory` optional, makes branch/title optional when `publication.mode === 'disabled'`, allows `roleLimits.fileBytes` up to `OVERLAY_LIMITS.maxMaxBytes` (`16 GiB`), preserves exact-file `spec.proposal.path` control-root carve-out and sibling protection, and protects only `.git` + `<controlRoot>` + control assets + `spec.scope.protected`; `'github'` enforces triggers, PR publication fields, and dual-key `.github/workflows/**`), removes `.claude`, `.codex`, `CLAUDE.md`, and `AGENTS.md` from `schema.ts` and `sandbox.ts` (preserving Seatbelt newline rejection and `"` regex escaping), and extracts `digests.ts`, injectable-auth `upstreams.ts`, `models-config.ts`, `qualification.ts`, and derived-form stream-capable `scrubber.ts` with zero `@loopwright/github-app` imports.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg taskpack`

- [x] **T5b · Cross-package `1 MiB` streaming chunks, CoW reflink (`COPYFILE_FICLONE`) projections, `16,384`-file overlay scaling, and digest lockfile remediation hint**
      Blocked by: T5, T6
      Owns: `packages/core/src/{limits,boundary}.ts`, `packages/core/test/**`, `packages/state/src/boundary.ts`, `packages/state/test/**`, `packages/agent-pi/src/{cas,policy,preflight}.ts`, `packages/agent-pi/test/**`, `packages/controller/src/{files,source,parser,verifier-protocol,capture,step,inspect,bundle}.ts`, `packages/controller/test/**`, `packages/taskpack/src/{types,schema,digests,sandbox}.ts`, `packages/taskpack/test/{schema,digests,sandbox,scrubber}*.test.ts`
      Acceptance: Raises streaming chunk size to `1_048_576` (`1 MiB`) across `controller/files.ts` (`STREAM_CHUNK_BYTES`), `controller/verifier-protocol.ts`, `agent-pi/cas.ts` (`CAS_CHUNK_BYTES`), and `taskpack/digests.ts` while preserving multi-form sliding-window secret scrubbing and updating cross-chunk boundary tests to straddle `1 MiB` offsets; appends a newline-separated remediation hint (`Run "loopwright digest sync --taskpack <manifestPath|<taskpack.yaml>> --repo ." to refresh the lockfile.`) to `verifyDigestLockfile` / `assertDigestLockfileVerified` failure reasons in `packages/taskpack/src/digests.ts` (covered in `packages/taskpack/test/digests.test.ts`); adds CoW reflink-first projection (`fs.copyFile` + `COPYFILE_FICLONE | COPYFILE_EXCL`, keeping `nlink === 1`, `O_NOFOLLOW`, and SHA-256 verification) with seamless `1 MiB` streaming fallback in `controller/files.ts` (`copyVerifiedFileReadOnly`) and `agent-pi/cas.ts` (`streamCopyVerifiedBlob`); raises `OVERLAY_LIMITS.maxMaxFiles` 4x from `4_096` to `16_384` (`< LIMITS.baselineEntries` `65_536`) and updates `core/boundary.ts`, `state/boundary.ts` (`wideCheckpointBytes = 8 MiB`), `agent-pi/{policy,preflight}.ts` (`candidateEntries = 16_384`), `controller/{source,parser,verifier-protocol,capture,step,inspect,bundle}.ts` (`manifestMaxBytes <= 80 MiB`, `v2WorkspaceJsonMaxBytes <= 32 MiB`, `checkpointInputMaxBytes <= 8 MiB`, `parsePrivateJson` `collectionLimit <= 65_536` & dynamic `nodeLimit`, `PublicBundle` `32 MiB`/`64 MiB` for `16,384`-entry `candidate.files.json` v2), and `taskpack/{types,schema,sandbox}.ts` (`candidateEntries <= 16_384`, `MAX_GLOB_EXPANDED_PATHS = 16_384`, and `readOnlyBindMounts` support on `SandboxPolicyInput` for sub-mounts like `.git/objects`).
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg core && node scripts/run-tests.mjs --pkg state --concurrency 1 && node scripts/run-tests.mjs --pkg agent-pi --concurrency 1 && node scripts/run-tests.mjs --pkg controller && node scripts/run-tests.mjs --pkg taskpack`

- [x] **T7 · `@loopwright/taskpack` compiler, CoW/streaming `preflight`, hybrid `mountReadOnlyGit`, and CAS-streamed `turnkey` gate/step runner**
      Blocked by: T5b
      Owns: `packages/taskpack/src/{preflight,taskpack,output-format,turnkey,turnkey-memory,index}.ts`, `packages/taskpack/test/{preflight,taskpack,turnkey,turnkey-progress,delegated}*.test.ts`
      Acceptance: `taskpack.ts` compiles `'local'` and `'github'` manifests and auto-scales role `fileBytes`, `artifactBytes`, and `candidateEntries` (up to `16_384`) with `spec.limits.overlay`; `preflight.ts` and `turnkey.ts` project `mount: 'workspace'` resources and `copyDirectoryTreeReadOnly` via CoW reflink (`COPYFILE_FICLONE | COPYFILE_EXCL`) with `1 MiB` (`1_048_576`-byte) streaming fallback (`O_NOFOLLOW`, `nlink === 1`, `cas://sha256/<hex>` URIs, zero `handle.readFile()`) while maintaining strict directory projection isolation between `workspaceStagedDir` and `checkStagedDir` (`exposeToChecks: true` only); `mountReadOnlyGit` implements the hybrid sanitized-skeleton + zero-copy `.git/objects` strategy (`stageSanitizedReadOnlyGitDir` excludes `config`, `config.worktree`, `hooks`, `credentials`, and `objects` and writes `SANITIZED_READ_ONLY_GIT_CONFIG`; symlink-verified `<repo>/.git/objects` is mounted via `--ro-bind` under Linux `bwrap`/`docker` and cloned via `COPYFILE_FICLONE` CoW reflink with `1 MiB` streaming fallback under macOS Seatbelt / Linux Landlock); `startLocalCommandGateServer` resolves canonical run-local CAS URIs into private verified staging directories (preserving `entriesDigest` base-tree cache keys and `command.v1` network-isolation `onLog` warnings); `executeTurnkeyCycle`, `formatHostSessionProgressLog`, `LOOPWRIGHT_MAX_TURNS` / `LOOPWRIGHT_MAX_REPAIR_TURNS` circuit-breaker options, inline `scrub` hooks, `stageTaskpackForStep`, `openStagedTaskpackStepGate`, and `local-only`/`disabled` `turnkey-memory.ts` run end-to-end without GitHub dependencies while preserving `64 KiB` `taskpack.yaml`, `512 KiB` `LOOPWRIGHT_PREFLIGHT_OUT`, `64 KiB` `LOOPWRIGHT_CHECK_OUT`, and `64 KiB`/`256 KiB` `mount: 'prompt'` caps.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg taskpack`

- [x] **T8 · `@loopwright/taskpack-runner` neutral protected paths, v1+v2 checkpoint reader, and pointer-index `GATE_DRIVER`**
      Blocked by: T5b
      Owns: `packages/taskpack-runner/src/**`, `packages/taskpack-runner/test/**`
      Acceptance: Removes hardcoded `.claude/**`, `CLAUDE.md`, and `AGENTS.md` from both `compile-taskpack.ts` and `python-bridge.ts` (scoping `.github/workflows/**` to optional GitHub workflow protection while preserving `proposal.path` writable/protected scope validation); upgrades `service.ts` to decode both `blob_ref` and `chunk` `.workspace.ndjson` rows (`1 MiB` streaming verification, up to `16,384` overlay entries), pass a verified pointer-index file path to `GATE_DRIVER` instead of inline `candidateFilesB64` over the `1 MiB` `PythonBridge` stdin limit, and read `proposal.json` boundedly while keeping all frozen offline corpus parity suites green.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg taskpack-runner`

- [ ] **T9 · `@loopwright/github-app` GitHub control-plane focus, `GitHubAppError` parity re-exports, and single-fd Git PR publisher**
      Blocked by: T7
      Owns: `packages/github-app/package.json`, `packages/github-app/tsconfig.json`, `packages/github-app/src/**`, `packages/github-app/test/{control-plane-action,delegated-taskpack,digests,mcp-*,models-config,pr-body-formatting,preflight,sandbox,schema-v2,site-gh-pages,taskpack-intake,taskpack-v2-runtime,tenant-queue,token-broker-qualification,turnkey-*,upstreams-v2,webhook-delivery}*.ts`, `packages/github-app/test/*fixtures.ts`
      Acceptance: `@loopwright/github-app` depends on `@loopwright/taskpack` and re-exports its full public surface (including `TaskpackError as GitHubAppError` and `formatHostSessionProgressLog` so `instanceof` checks and imports hold across both packages); `action.ts` and `service.ts` enforce `policyProfile: 'github'` and validate manifest `spec.triggers` strictly before `preflight` or queue admission (preserving installation lifecycle webhooks, `MULTI_TENANT_HOST_POLICY`, `pinnedManifestCanonical`, and `taskpackId` tenant checks); `startNativePullRequestPublisherServer` opens each canonical CAS blob once (`O_RDONLY | O_NOFOLLOW`, `nlink === 1`), streams `1 MiB` (`1_048_576`-byte) chunks into `git hash-object -w --stdin` while verifying SHA-256, `fstat` stability, and returned Git blob OID equality before index staging, and retains `separate-pull-request` memory publication.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg github-app`

- [ ] **T10 · `@loopwright/cli` `loopwright run --taskpack`, lazy `app-serve`, and 10-package closure/governance alignment**
      Blocked by: T8, T9
      Owns: `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/src/**`, `packages/cli/test/{arguments,build-incremental,closure-and-failure-matrix,digest-and-trust-cli,npm-pack,run-tests-sharding,step-cli*}*.ts`
      Acceptance: `packages/cli` imports Taskpack execution from `@loopwright/taskpack` and lazy-loads `@loopwright/github-app` only in `app-serve`; adds mutually-exclusive `loopwright run --taskpack <FILE>` with side-effect-free `--dry-run`, `candidate|no-change|auto` modes, and clean refusal of unbound `pull_request` / `separate-pull-request`; updates `closure.ts` (`OWNER_PACKAGES` + moved `packages/taskpack/...` evidence paths on both `qualified-host-clock-and-storage-profile` and `interactive-mcp-oauth-browser-flow`, preserving `18` `closedLocal` / `5` `unprovisionedExternal`), `failure-matrix.ts` (`scenarioThirteen` testing `policyProfile: 'github'` refusals and `instanceof GitHubAppError`), `build-incremental.test.ts` (10 packages), and `npm-pack.test.ts` (`bundledDependencies.length === 10`).
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node --test .test-build/packages/cli/test/arguments.test.js .test-build/packages/cli/test/build-incremental.test.js .test-build/packages/cli/test/closure-and-failure-matrix.test.js .test-build/packages/cli/test/digest-and-trust-cli.test.js .test-build/packages/cli/test/npm-pack.test.js .test-build/packages/cli/test/run-tests-sharding.test.js .test-build/packages/cli/test/step-cli.test.js .test-build/packages/cli/test/step-cli-fencing.test.js`

- [ ] **T11 · Repository self-upgrade dogfooding alignment (`.auto-sync/` and `scripts/prepare-self-upgrade.mjs`)**
      Blocked by: T9
      Owns: `.auto-sync/**`, `scripts/prepare-self-upgrade.mjs`, `packages/github-app/test/self-upgrade-*.ts`
      Acceptance: `.auto-sync/taskpack.yaml` declares `.claude/**`, `CLAUDE.md`, and `AGENTS.md` explicitly in `spec.scope.protected` (preserving `.claude/skills -> ../.agents/skills` under `freezeSource` and exact-file `.auto-sync/proposal.json` carve-out) and adds `packages/taskpack/**` / `packages/taskpack/package.json` to `scope.writable` and `yaml` `watchedPaths`; `.auto-sync/checks/verify.sh` (`YAML_WORKSPACES`), `.auto-sync/instructions.md`, `scripts/prepare-self-upgrade.mjs` (`YAML_WORKSPACES`, `expectedPackagesMap`, and `@loopwright/taskpack` import), and `self-upgrade-fixtures.ts` include `packages/taskpack`; `.auto-sync/digests.lock.json` is re-synced via `loopwright digest sync --taskpack .auto-sync/taskpack.yaml --check`.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node --test .test-build/packages/github-app/test/self-upgrade-*.test.js`

- [ ] **T12 · Connected documentation, repository skills, Hugo site rebuild, and full 10-package verification**
      Blocked by: T10, T11
      Owns: `docs/**`, `site/**`, `README.md`, `AGENTS.md`, `.agents/skills/loopwright-overview/SKILL.md`, `packages/cli/test/{check-docs-rules,docs-and-site}.test.ts`
      Acceptance: Updates `docs/README.md` (`taskpacks` code links + new spec entry), `docs/getting-started/architecture.md`, `docs/configuration/taskpack.md`, `docs/operations/cli.md`, `docs/operations/coding-agents.md` (migrating local `inspect` apply guidance to v2 `blobPath` with v1 `body` fallback), `docs/operations/github-action.md`, `docs/walkthroughs/declarative-taskpack.md`, `docs/contribute/github-app-internals.md`, `README.md`, `AGENTS.md` (updating nine -> ten packages while preserving lean-testing guidance), and `.agents/skills/loopwright-overview/SKILL.md` (preserving Stage 2/5/6 updates in `docs/references/bootstrap-interview.md`); rebuilds `site/`; passes all 10 package suites, `lint:docs`, `site`, and `closure --verify-failures`.
      Verify: `npm run build && npm run typecheck && npm run lint && npm run lint:docs && npm run site && npm test && node packages/cli/dist/main.js closure --verify-failures --json`

### Test Plan
[ ] I/we understand the owners of the involved components may require updates to existing tests to make this
code solid enough prior to committing the changes necessary to implement this enhancement.

#### Prerequisite testing updates
- Sync workspace links in `package-lock.json` and install dependencies (`npm install --package-lock-only && npm ci`) in `T1` so TypeScript, ESLint, and Node test runners resolve `@loopwright/taskpack`.
- Update existing tests in `packages/controller/test/`, `packages/github-app/test/`, and `packages/taskpack-runner/test/` that relied on implicit `.claude/**` / `CLAUDE.md` engine hardcoding or untested legacy `run.json` `hostPolicy` defaults.

#### Unit tests
- `@loopwright/core` & `@loopwright/state`: `2026-11-20` - target >= 90% on changed files (`digestArtifactFromMetadata` 0-byte and `> 4 GiB` safe-integer lengths, JCS omission of unset `uri`/`mediaType`; `resolveInventory`, `evaluateAcceptance`, and `constructRunResult` with `VerifiedArtifactDescriptor` vs `64 MiB`/`128 MiB` raw `Uint8Array` limits; `16 GiB` `OVERLAY_LIMITS.maxMaxBytes`, `16,384` `OVERLAY_LIMITS.maxMaxFiles`, and `8 MiB` `wideCheckpointBytes`).
- `@loopwright/agent-pi`: `2026-11-20` - target >= 90% on changed files (crash-safe `1 MiB` CAS `blob_ref` checkpoint capture, streaming SHA-256 decode/restore, mixed `blob_ref`+`chunk` / duplicate-row refusal, v1 `chunk` read fallback, CoW reflink + `1 MiB` fallback CAS descriptor `PiOpenInput`, `16,384` `candidateEntries`, `16 GiB` `fileBytes` vs preserved `4 MiB` `toolArgsBytes`/`toolResultBytes`).
- `@loopwright/controller`: `2026-11-20` - target >= 90% on changed files (`storage.ts`/`files.ts`/`credentials.ts` `.tmp` -> `0o400` -> `link` commit order, concurrent identical writers, symlink/hardlink/TOCTOU/cross-run path refusals, CoW reflink `COPYFILE_FICLONE` + `1 MiB` stream fallback keeping `nlink === 1`, derived-form raw/JSON/URL/base64 secret detection across `1 MiB` chunk boundaries including dedup hits; `retained.ts` durable `hostPolicy` & conservative `'github'` fallback on legacy `run.json`; `step.ts` zero-CAS-write unchanged same-size baseline scan & v1+v2 mode loader; `v2WorkspaceJsonMaxBytes` & `manifestMaxBytes` under `16,384` `maxFiles` & `16 GiB` `overlay.maxBytes`; `inspect.ts` & `bundle.ts` `16,384`-entry v2 pointer index).
- `@loopwright/taskpack`: `2026-11-20` - target >= 85% on package modules (`'local'` vs `'github'` policy profiles, optional `triggers`/`publication`/`memory` resolved against custom `controlRoot`, `16,384` `candidateEntries`/`maxFiles`, preserved exact-file `proposal.path` carve-out, neutral sandbox masks, CoW reflink / `1 MiB` streaming `mount: 'workspace'` with strict `exposeToChecks` directory isolation after restart, hybrid `mountReadOnlyGit` sanitized skeleton + `--ro-bind` / CoW reflink `.git/objects`, and exact/limit+1 tests on `taskpack.yaml`, `LOOPWRIGHT_PREFLIGHT_OUT`, `LOOPWRIGHT_CHECK_OUT`, and `mount: 'prompt'`).
- `@loopwright/github-app`: `2026-11-20` - target >= 85% on GitHub control-plane modules (`TaskpackError`/`GitHubAppError` `instanceof` parity, pre-preflight & pre-enqueue trigger refusals, installation lifecycle handling, single-fd streaming `git hash-object -w --stdin` + Git-OID verification).
- `@loopwright/taskpack-runner`: `2026-11-20` - target >= 85% on `compile-taskpack.ts`, `python-bridge.ts`, and `service.ts` (neutral protected paths, v1+v2 checkpoint decoding, pointer-index `GATE_DRIVER` exceeding `1 MiB` overlay).
- `@loopwright/cli`: `2026-11-20` - target >= 85% on `arguments.ts`, `main.ts` (`loopwright run --taskpack`, `--dry-run`, mutually exclusive flags), `closure.ts`, and `failure-matrix.ts`.

#### Integration tests
- **Full-pipeline `> 64 MiB` / `> 128 MiB` terminal `RunResult` & memory bound**: drive both `loopwright step` and `agent-pi` runs containing a `> 64 MiB` binary, two files totaling `> 128 MiB`, an unchanged large baseline file, a same-size modified file, a deleted file, and a small `proposal.json` checked by `json-artifact.v1` all the way through `scope.v1`, `json-artifact.v1`, `command.v1`, `inspectRun`, `evaluateControllerAcceptance` -> terminal `RunResult`, and local native Git commit-tree creation; verify zero CAS writes for the unchanged file, exact Git OIDs/modes, and bounded subprocess RSS/ArrayBuffer growth.
- **GitHub authority persistence across restart, `resume`, and `reconcile`**: verify all four `(manifest allowWorkflowWrites) x (operator allowWorkflowWrites)` combinations plus `MULTI_TENANT_HOST_POLICY`, missing triggers (zero `preflight` or queue executions), and interrupted `'github'` runs resumed/reconciled without caller `ports` still blocking `.github/workflows/**` and non-workflow `.github/**` sibling writes/deletes.
- **Local CLI ergonomics & side-effect-free `--dry-run`**: run minimal V2 manifests (non-default `controlRoot`, omitted `triggers`/`publication`/`memory`, writable `.claude/**` and `.github/workflows/**` when unprotected, protected `.claude/skills` symlink skipped cleanly) via `loopwright run --taskpack` (`candidate`, `no-change`, `auto`, `local-only` memory, `--role-model`) and confirm `--dry-run` invokes zero `preflight`, `memory`, or `publication` handlers.
- **Mixed-visibility `exposeToChecks` & crash/fault-injected CAS recovery**: verify a `command.v1` check sees `exposeToChecks: true` workspace resources and cannot open `exposeToChecks: false` resources after preflight scratch cleanup and step restart; inject truncated/hardlinked/rebound CAS blobs and interrupted `.tmp` writes to confirm fail-closed `ARTIFACT_INVALID` / `RECOVERY_REQUIRED` behavior while legacy v1 `delegated-capture.v1` and `.workspace.ndjson` `chunk` snapshots still recover and inspect cleanly.

#### e2e tests
- **Self-upgrade dogfooding e2e (`packages/github-app/test/self-upgrade-*.test.ts`)**: run `.auto-sync/taskpack.yaml` + `.auto-sync/checks/verify.sh` (with explicit `.claude/**` protection, exact `.auto-sync/proposal.json` carve-out, and `packages/taskpack` included) under `mode: 'auto'` across both `candidate` and `no-change` dispositions.
- **Installed tarball, closure matrix, and docs/site e2e**: build and install the packed `@gpustack/loopwright` tarball in an isolated prefix (`npm-pack.test.ts` with 10 bundled packages, verifying both `@loopwright/taskpack` standalone import and `@loopwright/github-app` compatibility exports), run `loopwright closure --verify-failures` (`18` `closedLocal`, `5` `unprovisionedExternal`, exit `0`), `npm run lint:docs`, `npm run site`, and `npm test`.

## Alternatives

1. **Keep declarative `Taskpack` inside `@loopwright/github-app` and only make `triggers` / `publication` optional**:
   - Rejected because `@loopwright/cli` and non-GitHub runners would continue pulling in GitHub App webhook, JWT, installation token, and PR publisher code, blurring module ownership and keeping GitHub-specific assumptions entangled with generic `Taskpack` compilation.
2. **Make `GitHubAppError` a subclass of `TaskpackError` rather than sharing constructor identity**:
   - Rejected because existing callers catch errors thrown by schema/intake helpers and check `error instanceof GitHubAppError` ([`packages/cli/src/failure-matrix.ts`](../packages/cli/src/failure-matrix.ts)); sharing class identity (`export { TaskpackError as GitHubAppError }`) guarantees `instanceof` compatibility across both packages.
3. **Keep `.github/workflows/**` dual-key blocked even in local non-GitHub mode, or pass `policyProfile` only as a transient runtime port**:
   - Rejected because local non-GitHub runs should be governed by `<controlRoot>`, `.git`, and repository `spec.scope`, whereas transient-only ports would lose `'github'` workflow protection across `resumeCycle` / `reconcileCycle`; persisting `hostPolicy` in `run.json` (with conservative `'github'` fallback on legacy runs) gives ergonomic local mode without weakening GitHub continuations.
4. **Merely raise `MAX_REQUEST_BODY_BYTES`, `PublicBundle`, and `delegated-capture.v1` JSON limits to hundreds of MiB, or reopen CAS paths by pathname for `git hash-object`**:
   - Rejected because base64-in-JSON inflates payloads by 33% and hits V8 string/heap walls, while reopening a verified file by pathname introduces a TOCTOU window. Streaming from a single verified `O_NOFOLLOW` descriptor into CAS and `git hash-object -w --stdin` eliminates both O(file_size) heap growth and pathname races.

## Open Questions

None. All package boundaries, durable policy profile bindings, CAS commit/verification invariants, core acceptance descriptors, and closure matrix updates are resolved.
