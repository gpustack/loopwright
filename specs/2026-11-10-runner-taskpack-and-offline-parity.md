# Spec: Runner taskpack and frozen offline parity

Status: Shipped
Type: Feature

## Summary

Add a private `@loopwright/taskpack-runner` workspace package that wraps the frozen GPUStack Runner Auto Sync domain
validators and publisher (`gpustack/runner` commit `9b422c8bdbd31414ada7df8c4b55070b04957f44`) behind Loopwright's
trusted configuration, authenticated `gate.v1` verification protocol, and controlled `pull_request` publication
boundary. Verify deterministic offline parity between legacy Runner entrypoints and Loopwright cycles across discovery,
maintainer `/auto-sync` comment revision, `pack-run-url` failure diagnosis, candidate patch and compatibility-group
validation, validation-to-repair feedback, managed pull-request convergence, and post-dispatch receipt reconciliation
without live GitHub mutations or remote pushes.

## Motivation

### Goals

`@loopwright/core`, `@loopwright/state`, `@loopwright/agent-pi`, `@loopwright/controller`, and `@loopwright/cli` now
provide a complete task-execution harness: immutable `TaskLock` contracts
([`packages/core/src/contracts.ts`](../packages/core/src/contracts.ts)), single-writer SQLite admissions and operation
journals ([`packages/state/src/store.ts`](../packages/state/src/store.ts)), isolated container-backed Pi roles
([`packages/agent-pi/src/index.ts`](../packages/agent-pi/src/index.ts)), bounded DAG scheduling and repair
([`packages/controller/src/controller.ts`](../packages/controller/src/controller.ts)), and HMAC-SHA256 authenticated
external gates, controlled `pull_request` publication, and explicit operator reconciliation
([`packages/controller/src/gate.ts`](../packages/controller/src/gate.ts),
[`packages/controller/src/publication.ts`](../packages/controller/src/publication.ts),
[`packages/controller/src/reconcile.ts`](../packages/controller/src/reconcile.ts)).

The first production workload targeted by Loopwright is GPUStack Runner Auto Sync
(`https://github.com/gpustack/runner/tree/9b422c8bdbd31414ada7df8c4b55070b04957f44`). Runner Auto Sync already
separates untrusted research from credential-free candidate validation and pre-publication revalidation:

1. `tools/auto_sync/discovery.py` evaluates fixed upstream release lists (`vllm-project/vllm`, `sgl-project/sglang`) and
   sourced Ascend compatibility pairs (`vllm-project/vllm-ascend`) against a frozen Runner checkout without executing
   builds or network calls inside the parser.
2. `tools/auto_sync/proposal.py`, `tools/auto_sync/assemble.py`, and `tools/auto_sync/check_draft.py` parse and validate
   structured analysis and proposal documents as data, rejecting duplicate JSON keys, non-finite numbers, path traversal
   or symlinked `patch_file` references, disallowed target paths, and unverified pre-releases.
3. `tools/auto_sync/checks.py` (`validate_candidate`, `verify_artifact`, `check_applied_group`) applies candidate patches
   inside disposable exact-source Git clones, checks compatibility groups and Dockerfile resolution helpers
   (`pack/resolve_dockerfile.sh`, `pack/expand_matrix.sh`, `pack/matrix.yaml`), and proves that an artifact digest
   identifies bytes without authenticating model assertions.
4. `tools/auto_sync/publish.py` re-runs `verify_artifact` and `validate_candidate` before any remote write, enforces
   managed pull-request identity, non-force branch updates, duplicate comment suppression, and human-head convergence.
5. `tools/auto_sync/run.py` supports scheduled/manual discovery, maintainer `/auto-sync` pull-request comment revision
   with strict guidance bounds (`40` lines, `2048` bytes, sentinel and contract-override rejection), and `pack-run-url`
   diagnostic log extraction (`4000` characters).

However, legacy Runner couples those sound domain validators to a monolithic Python orchestration loop (`agent.py`,
`model.py`, `run.py`) where:

- Validation runs in a separate downstream job with no bounded feedback edge back to an agent repair step.
- Token accounting (`20,000,000` reported tokens across analysis, proposal, and at most `2` repair rounds per stage
  within a `3300` second research deadline) is soft post-hoc tallying without persistent pre-send admission or
  crash-surviving unknown-charge reservations.
- Interrupted publication mutations rely on later convergence runs rather than an explicit journaled
  `reconcile_required` state and authenticated receipt workflow.

This specification delivers the Runner Auto Sync migration foundation:

1. Vendor and hash-pin the exact frozen Runner `9b422c8bdbd31414ada7df8c4b55070b04957f44` domain modules and offline
   fixtures inside `@loopwright/taskpack-runner` so parity never depends on an independently moving external checkout.
2. Wrap Runner's Python discovery, intake (`/auto-sync` comment revision and `pack-run-url` diagnosis), candidate
   validation, and mock-service publication behind a contained Python bridge and loopback `@loopwright/controller`
   gate/publisher service.
3. Compile Runner tasks into standard Loopwright `TrustedRegistry` and `ControllerConfiguration` documents, preserving
   Runner's writable path boundaries, `no_change` semantics, and compatibility-group checks while adding Loopwright's
   validation-to-repair feedback edge and `reconcile_required` publication safety.
4. Prove deterministic old-vs-new parity across a 14-scenario offline corpus and export a structured parity comparison
   report explaining every matching outcome and every intentional Loopwright safety improvement.

### Non-Goals

- Calling live GitHub REST/GraphQL APIs, creating real pull requests, pushing Git refs, or modifying `.github/workflows`.
- Running Docker image builds or GPU/NPU hardware compatibility tests inside Runner Auto Sync (in Runner, image
  production belongs to post-merge Pack workflows, not the Auto Sync proposal cycle).
- Implementing the `pack/llm-router` multi-upstream patch-stack taskpack or the `pack/mirrored-mooncake` target/hardware
  matrix taskpack (covered by subsequent taskpack specifications).
- Implementing reviewed persistent memory curation or hosted GitHub App webhook receivers and multi-tenant queues.
- Rewriting Runner's Python `discovery.py`, `proposal.py`, `checks.py`, or `publish.py` domain rules in TypeScript
  before establishing verified offline parity against the unmodified frozen Python validators.

## Proposal

Create a private workspace package `packages/taskpack-runner` (`@loopwright/taskpack-runner`) that embeds the hash-pinned
frozen Runner `9b422c8bdbd31414ada7df8c4b55070b04957f44` Python domain files, compiles Runner intake contexts into
Loopwright controller configurations, serves an authenticated local loopback gate and publication bridge over the frozen
Python validators and publisher, and verifies side-by-side parity against legacy Runner entrypoints on fixed offline
inputs.

### User Stories

#### Story 1

As a release-automation operator, I want Runner Auto Sync discovery, `/auto-sync` maintainer comment revisions, and
`pack-run-url` failure diagnostics to compile into locked Loopwright configurations with Runner's exact writable-path
and guidance guards, so that unauthorized comments, prompt-sentinel injections, and failed upstream fetches are stopped
before model execution or publication.

#### Story 2

As a release-automation operator, I want Loopwright's `gate.v1` check step and `pull_request` publication boundary to
invoke the unmodified frozen Runner Python `checks.validate_candidate` and `publish.publish` logic over HMAC-authenticated
loopback endpoints, so that candidate group acceptance, disposable Git patch application, pre-publication revalidation,
managed PR convergence, and non-force branch rules match Runner's proven domain semantics while gaining bounded
validation-to-repair feedback and `reconcile_required` crash safety.

#### Story 3

As a release-automation maintainer, I want a deterministic offline parity harness that runs the frozen Runner Python
validators and Loopwright `@loopwright/taskpack-runner` cycles against identical fixed inputs and emits a structured
comparison report, so that every outcome (`completed`, `no_change`, `blocked`, `failed`, `reconcile_required`) and
accepted-group set is verified and any behavioral difference is explicitly accounted for before production cutover.

### Core Features & Acceptance Criteria

#### 1. Hash-Pinned Frozen Runner Corpus and Contained Python Bridge (`corpus.ts`, `python-bridge.ts`)

- `packages/taskpack-runner/vendor/runner-auto-sync/` contains the exact frozen files from `gpustack/runner` commit
  `9b422c8bdbd31414ada7df8c4b55070b04957f44` together with a committed `manifest.json` recording `sourceRepository`
  (`gpustack/runner`), `sourceRevision` (`9b422c8bdbd31414ada7df8c4b55070b04957f44`), and `{ path, sha256, bytes, executable }`
  for every vendored file:
  - Domain modules: `tools/auto_sync/{discovery,proposal,assemble,check_draft,checks,publish,summary,agent,model,progress}.py`,
    `tool-versions.json`, and `prompts/{analysis,proposal,repair}.md`. (The frozen upstream revision has no
    `tools/auto_sync/__init__.py`: Python 3 namespace packages resolve `tools.auto_sync` imports without it. The
    frozen `agent.py` is required at import time by the vendored reference unit checks, and `agent.py` itself
    imports `model.py` and `progress.py` at its top level, so all three join the manifest to keep the frozen
    module closure importable.)
  - Dockerfile/matrix helpers required by `checks.py`: `pack/resolve_dockerfile.sh` (`0o755`), `pack/expand_matrix.sh`
    (`0o755`), `pack/matrix.yaml`, `docs/supported-runners.md`, `docs/support-records.md`,
    `gpustack_runner/runner.py.json`, and `pyproject.toml`.
  - Offline parity fixtures and frozen unit tests: `tests/auto_sync/fixtures/discovery/legacy-support.md`,
    `tests/auto_sync/fixtures/proposals/{analysis,ready}.json`, `tests/auto_sync/fixtures/github/service.py`, and
    `tests/auto_sync/test_{discovery,proposal,assemble,check_draft,checks,publish,summary}.py`.
  - Frozen repository readme `README.md` (read by the vendored reference unit checks, which assert against its
    content at the repository root).
- `verifyFrozenCorpus(corpusRoot?)`:
  - Verifies every manifest entry is a regular non-symlink file with exact byte length, SHA-256 digest, and executable
    mode (`(mode & 0o111) !== 0` when `executable === true`).
  - Rejects missing files, extra unexpected `.py`/`.sh` files under `tools/auto_sync` or `pack`, symlinks, or digest
    mismatches with a typed `RunnerTaskpackError` (`CORPUS_TAMPERED` / `CORPUS_UNAVAILABLE`).
- `PythonBridge`:
  - Accepts an explicit `pythonExecutable` path (validated as an absolute regular or system-installed executable, never
    invoked via `shell: true`), verifies Python `>=3.10` plus `packaging`, `yaml`, and `requests` availability at
    preflight, and returns a structured `PYTHON_UNAVAILABLE` error if prerequisites are missing.
  - Executes helper invocations in a sanitized environment (`HOME` set to a private `0o700` scratch directory,
    `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=/usr/bin/false`,
    `PYTHONDONTWRITEBYTECODE=1`) with a `sitecustomize.py` socket-connect guard blocking non-loopback network connections,
    bounded stdin/stdout (`<= 1,048,576` bytes), and an explicit per-call timeout.

#### 2. Runner Intake, Discovery, Comment-Revise, and `pack-run-url` Preparation (`intake.ts`)

- `prepareRunnerIntake(input)` accepts a frozen target repository snapshot (`repository`, `defaultSha`, `headSha`),
  upstream release fixtures (`releases`, `ascendPairs`, `sources`, and per-upstream acquisition status), and trigger
  descriptor (`mode: 'discover' | 'revise'`):
  - **Discovery (`mode: 'discover'`)**:
    - Invokes frozen `discovery.discover` against the repository snapshot and supplied release tables.
    - When one or more upstream feeds failed acquisition and zero valid candidates exist, returns intake disposition
      `blocked` (`reason: 'upstream_unavailable'`), preserving per-subscription errors instead of misreporting
      `no_change`.
    - When all feeds succeeded and zero subscriptions have updates (or an open managed PR already matches the exact
      discovered state with no action needed), returns intake disposition `no_change` (eligible for Loopwright
      `no-change.v1`).
    - When updates exist, returns intake disposition `ready` with frozen `identity`, `discovery`, `evidence`, and
      prerelease permissions (`engine_prereleases`, `prerelease_packages`).
  - **Maintainer Comment Revision (`mode: 'revise'`)**:
    - Validates commenter authorization: only `authorAssociation` in `['OWNER', 'MEMBER', 'COLLABORATOR']` (or an
      explicit operator collaborator allowlist) is accepted; unauthorized `/auto-sync` comments return intake
      disposition `blocked` (`reason: 'unauthorized_commenter'`) with zero model or publication eligibility.
    - Validates guidance text against Runner's exact contract guards: `<= 40` lines (`GUIDANCE_MAX_LINES`), `<= 2048`
      UTF-8 bytes (`GUIDANCE_MAX_BYTES`), no prompt sentinels matching `/=== .*? ===/`, and no lines starting with
      `REQUIRED:` or `NEVER:`. Violations fail closed with `blocked` (`reason: 'invalid_guidance'`).
    - Binds `identity` to `{ repository, default_sha, head_sha, mode: 'revise', pr_number, command_id, command_digest }`
      so any subsequent PR `head_sha` mutation or duplicate `command_id` is detected before publication.
  - **`pack-run-url` Failed Pack Run Diagnosis**:
    - Parses URLs matching `^https://github\.com/([^/]+/[^/]+)/actions/runs/([0-9]+)(?:/job/([0-9]+))?/?$`, rejects
      cross-repository URLs (`urlRepo !== identity.repository`), truncates fetched fixture job logs to `4000` characters
      (`JOB_LOG_LIMIT`), strips/rejects sentinel injection, and attaches the bounded diagnostic record as structured
      stage data.

#### 3. Loopwright Taskpack Compilation (`compile-taskpack.ts`)

- `compileRunnerTaskpack(options)` produces a validated `{ registry, config, registrySha256 }` bundle compatible with
  `loadTrustedConfiguration` and `compilePlan` in `@loopwright/controller`:
  - **Scope & Protected Paths**:
    - `task.spec.scope.writable` permits only Runner's allowed candidate paths (`pack`, `docs/supported-runners.md`,
      `docs/support-records.md`, `gpustack_runner/runner.py.json`, and `.autosync/proposal.json`).
    - `task.spec.scope.protected` protects `.github`, `tools/auto_sync`, `tests`, `.agents`, `.claude`, `AGENTS.md`, and
      `CLAUDE.md`.
  - **DAG & Acceptance Mapping**:
    - For `no_change` discovery runs: compiles a check-only or `no-change.v1`-eligible graph so `@loopwright/controller`
      settles `RunResult.spec.status === 'no_change'` with `publication` skipped (`externalEffects: 'none'`).
    - For candidate/revise runs: compiles steps referencing `runner-proposal-json` (`json-artifact.v1` on
      `.autosync/proposal.json`) and `runner-candidate-validation` (`gate.v1` targeting the loopback Runner Validation
      Gate with `allowedEvidenceLevels: ['external_service']`), plus `publication` (`mode: 'pull_request'`) targeting
      the loopback Runner Publication Endpoint.
    - Configures `budgets` (`maxFormatRepairs <= 2`, `maxImplementationRepairs <= 2`, bounded `wallTimeMs`,
      `totalTokens`, and `maxModelCalls`) and documents the mapping from Runner's stage budgets (`20,000,000` reported
      tokens / `3300`s research window) to Loopwright's pre-admitted controller caps.
    - Binds `gate` and `publisher` HMAC-SHA256 signing secrets exclusively through `TrustedRegistry.spec.credentialBindings`
      and `environmentBindings`; secrets never appear in `CompiledPlan` or run bundles.

#### 4. Authenticated Loopback Runner Validation Gate and Publication Service (`service.ts`)

- `startRunnerTaskpackService(options)` launches a loopback HTTP server (`http://127.0.0.1:<port>`) implementing
  `@loopwright/controller`'s exact wire protocols (`gate_request` -> `gate_verdict` and `publication_request` ->
  `publication_receipt`) signed with constant-time HMAC-SHA256 (`verifySignedPayload` / `signPayload`):
  - **Validation Gate (`POST /gate`)**:
    1. Authenticates `x-loopwright-signature` (`timingSafeEqual`) and validates `gate_request` bindings (`storeId`,
       `runId`, `lockHash`, `operationId`, `dispatchId`, `dispatchGeneration`, `gateId`, `checkId`, `candidateDigest`,
       `subject`).
    2. Reads the candidate `.autosync/proposal.json` and referenced workspace patch files from the bound candidate
       snapshot, runs frozen `assemble.assemble` + `proposal.validate_proposal`, and invokes frozen
       `checks.validate_candidate` in a disposable exact-source Git clone using the controller-held `identity`,
       `sources`, `ascendPairs`, `enginePrereleases`, and `prereleasePackages` (never trusting candidate-supplied
       identity or upstream commit claims).
    3. If `validate_candidate` succeeds with at least one accepted compatibility group (or valid `unchanged`/`blocked`
       disposition matching intake): caches the verified `checked` artifact keyed by
       `(storeId, runId, candidateDigest)` and returns a signed `gate_verdict` with `status: 'approved'` and fresh
       `expiresAtMs`.
    4. If `assemble`, `validate_proposal`, or `validate_candidate` rejects the candidate (`ProposalError`, disallowed
       path, symlink/mode injection, `git apply` conflict, tampered digest, or zero accepted groups when updates were
       claimed): returns a signed `gate_verdict` with `status: 'denied'` and bounded `reason` (`<= 256` chars) carrying
       the exact validator diagnostic so Loopwright's `implementationRepair` can repair the candidate and re-run full
       validation on the next generation.
  - **Publication Endpoint (`POST /publish`)**:
    1. Authenticates `x-loopwright-signature` and validates `publication_request` bindings (`storeId`, `runId`,
       `lockHash`, `operationId`, `dispatchId`, `dispatchGeneration`, `idempotencyKey`, `candidateDigest`,
       `baseRevision`, `sourceRevision`).
    2. Deduplicates by `idempotencyKey` so re-queries or operator reconciliation lookups never duplicate remote mutations.
    3. Looks up the gate-verified `checked` artifact for `(storeId, runId, candidateDigest)` and invokes frozen
       `publish.publish` against the injected GitHub service double (`tests/auto_sync/fixtures/github/service.py` in
       offline parity tests), which independently re-runs `checks.verify_artifact` and `checks.validate_candidate`
       (`revalidation.patch_digest === checked.patch_digest`).
    4. Maps `publish.publish` outcomes to signed `publication_receipt` documents:
       - `published` (or idempotent convergence where the managed PR already reflects the exact candidate commit/body)
         -> `outcome: 'succeeded'`, `externalUrl` set to the managed PR URL.
       - Pre-write refusal or safe non-mutation (`deferred` to concurrent PR, `skipped`, `head_sha` changed by human on
         PR branch, `default_sha` drifted, or pre-write `revalidation` failure where zero GitHub writes occurred) ->
         `outcome: 'not_executed'` with structured `reason`.
       - Mid-write transport/service failure after a branch or PR write may have occurred -> simulates connection drop
         or returns `outcome: 'failed'`, forcing `@loopwright/controller` into `reconcile_required` (`externalEffects: 'unknown'`)
         until settled via `reconcileCycle` from an operator receipt derived from remote PR state.

#### 5. Deterministic Offline Parity Corpus and Comparison Report (`parity.ts`, `parity.test.ts`)

- Implement a deterministic offline parity harness (`runRunnerParitySuite`) that executes **14 canonical migration
  scenarios** against identical frozen inputs in both the legacy Python Runner modules and Loopwright
  (`@loopwright/taskpack-runner` + `@loopwright/controller`):
  1. `no_update`: upstream releases match current Runner support records -> legacy `unchanged` / no publish; Loopwright
     `no_change`, `externalEffects: 'none'`, zero PR writes.
  2. `candidate_single_group`: valid single-subscription upgrade patch -> legacy `ready` + `published` (`1` PR);
     Loopwright `completed`, `externalEffects: 'confirmed'`, identical `accepted_groups` and `patch_digest`, `1` PR.
  3. `candidate_partial_groups`: two proposed compatibility groups where group A applies cleanly and group B fails
     compatibility/patch check -> both legacy `validate_candidate` and Loopwright gate accept only group A, preserve
     group B's rejection record, and publish only group A's accepted patch.
  4. `upstream_acquisition_failed`: upstream release feed fails -> legacy discovery/prepare blocks; Loopwright intake
     blocks (`blocked`, `upstream_unavailable`), never misclassifying as `no_change`.
  5. `existing_managed_pr_convergence`: managed PR already exists for the target state -> `publish.py` converges
     idempotently without creating a duplicate PR or duplicate status comment.
  6. `authorized_comment_revise`: collaborator `/auto-sync` comment with valid guidance -> accepted, bound to PR
     `head_sha`, `command_id`, and `command_digest`, updates managed PR cleanly.
  7. `unauthorized_comment_revise`: non-collaborator `/auto-sync` comment -> rejected at intake (`blocked`,
     `unauthorized_commenter`) before any model or GitHub write.
  8. `guidance_sentinel_injection`: collaborator comment containing `=== STAGE INPUT (JSON) ===` or `NEVER:` override ->
     rejected at intake (`blocked`, `invalid_guidance`).
  9. `pack_run_url_diagnosis`: failed Pack job URL on the target repository with `> 4000` byte log -> accepted, log
     truncated to `4000` chars (`JOB_LOG_LIMIT`), cross-repo URL rejected.
  10. `malformed_or_traversal_draft`: proposal draft with `patch_file: "../outside.patch"` or both `patch` and
      `patch_file` -> rejected by `assemble` / `gate` (`denied` -> `failed`).
  11. `disallowed_path_or_symlink_patch`: candidate patch touching `.github/workflows/ci.yml` or introducing a `120000`
      symlink mode -> rejected by `scope.v1` and `checks.validate_candidate` (`failed`, zero PR writes).
  12. `validation_feedback_repair`: initial candidate fails `runner-candidate-validation` (`denied` with `ProposalError`
      detail), Loopwright's `implementationRepair` invokes one bounded repair turn via a deterministic fake Pi adapter
      port, repaired candidate passes full re-validation and publishes (`completed`, `externalEffects: 'confirmed'`) —
      demonstrating the intentional closed-loop improvement over legacy Runner's one-way validation job.
  13. `head_changed_before_publish`: target repository or managed PR `head_sha` advances before publication -> refused
      without force-overwriting human commits (`TARGET_MISMATCH` / `not_executed`, zero force-pushes).
  14. `publication_receipt_lost_then_reconciled`: network drop after `publish` creates the managed PR -> Loopwright
      enters `reconcile_required` (`externalEffects: 'unknown'`), `resumeCycle` refuses blind replay (`PR count === 1`),
      and `reconcileCycle` with an authenticated receipt derived from the fake GitHub service's landed PR state settles
      `completed` / `confirmed` with `publication.json` exported.
- `runRunnerParitySuite` returns a structured `RunnerParityReport` (`version: 1`, `sourceRevision`, `corpusDigest`,
  `cases`, `summary`) where every case records `legacyOutcome`, `loopwrightOutcome`, `acceptedGroupsMatch`,
  `patchDigestMatch`, `remoteWrites`, `classification: 'exact_match' | 'intentional_improvement'`, and `explanation`.
- Also include a test executing the vendored original Python unit checks (`discovery`, `proposal`, `assemble`,
  `check_draft`, `checks`, `publish`, `summary`) under the contained `PythonBridge`. Those frozen checks import
  `pytest`, so the suite runs in full when the configured interpreter provides `pytest`; otherwise the test executes
  module import self-checks on stock Python so `npm test` never requires a global `pytest` installation. This makes
  regressions in the vendored corpus impossible.

### Notes / Constraints / Caveats

- Node.js `>=26.13.0` and TypeScript strict ESM (`NodeNext`); no new third-party npm dependencies without explicit
  approval (`yaml` is already in `@loopwright/controller`, and Node built-in `node:http`, `node:crypto`,
  `node:child_process`, `node:fs` suffice).
- Local macOS `python3` (`3.11.x`) provides `packaging`, `PyYAML`, and `requests` in standard library / site-packages;
  `PythonBridge` must never install pip packages globally or access the internet.
- All source and test filenames must use clean domain-descriptive `kebab-case` names (`corpus.ts`, `python-bridge.ts`,
  `intake.ts`, `compile-taskpack.ts`, `service.ts`, `parity.ts`, `parity.test.ts`). Never put internal phase or ticket
  IDs in filenames.
- Keep existing public signatures in `@loopwright/core`, `@loopwright/state`, `@loopwright/agent-pi`,
  `@loopwright/controller`, and `@loopwright/cli` backwards-compatible. If `@loopwright/taskpack-runner` needs
  `runCycleWithPorts` for deterministic fake-adapter repair testing (`validation_feedback_repair`), expose only a
  minimal typed entrypoint or test helper without weakening public CLI/configuration boundaries.

### Boundaries

- **Always:**
  - Verify the SHA-256 manifest of `vendor/runner-auto-sync/` before executing any Python domain helper.
  - Enforce `no-shell` (`execFile`), sanitized `HOME`/`GIT_*` environment variables, and non-loopback socket blocking
    inside `PythonBridge`.
  - Authenticate every `/gate` and `/publish` request and response with constant-time HMAC-SHA256 (`timingSafeEqual`).
  - Re-run full `checks.validate_candidate` on every repaired candidate generation and inside `publish.publish` before
    any simulated remote write.
- **Ask first:**
  - Changing any public type or behavior in `@loopwright/core`, `@loopwright/state`, or `@loopwright/agent-pi`.
  - Adding any third-party npm dependency.
- **Never:**
  - Read from an unpinned external Runner checkout path at runtime or test time.
  - Contact `github.com`, `api.github.com`, PyPI, or Docker registries, or run `git push`.
  - Modify `.github/` workflows or execute Docker image builds in Runner Auto Sync parity tests.
  - Upgrade unverified model claims or artifact digests into compatibility facts without `checks.validate_candidate`.

### Risks and Mitigations

- **External Runner repository moves independently of parity baseline** -> Vendor the exact frozen blobs from
  `9b422c8bdbd31414ada7df8c4b55070b04957f44` with a SHA-256 `manifest.json` verified on every bridge startup.
- **Python subprocess leaks host git/SSH credentials or makes accidental network calls** -> Run `execFile` with an
  isolated scratch `HOME`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, and a `sitecustomize.py` socket guard that
  blocks all non-loopback `connect` calls.
- **`pack/resolve_dockerfile.sh` fails with exit `127` when executable permissions or `bash`/`jq`/`yq` PATH entries are
  missing** -> Check executable mode bits in `verifyFrozenCorpus` and pass an explicit allowlisted tool `PATH`
  (`/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`) into `PythonBridge`.
- **Candidate passes `json-artifact.v1` syntax check while modifying protected paths or failing `git apply`** -> Require
  both implicit `controller.scope` (`scope.v1`) and external `runner-candidate-validation` (`gate.v1` backed by
  `checks.validate_candidate` in a disposable exact-source Git clone) in `task.spec.acceptance.required`.
- **Adding controller files shifts `installedHandlerDigests` across existing tests** -> Keep `@loopwright/taskpack-runner`
  in its own `packages/taskpack-runner` workspace package so `@loopwright/controller`'s dist inventory stays untouched
  unless a narrow export is strictly required.

## Design Details

### Commands

All verification runs locally on the development host (macOS arm64, Node `26.x`, npm `11.x`, system `python3`
`3.11.x` providing `packaging`, PyYAML, and `requests`); no remote host, container farm, or network service
participates in build, test, lint, or parity runs.

```bash
npm run build
npm run typecheck
npm run lint
npm test
npm --workspace @loopwright/taskpack-runner test
```

### Project Structure

```text
packages/
  taskpack-runner/
    package.json
    tsconfig.json
    vendor/
      runner-auto-sync/
        manifest.json           # SHA-256 inventory of frozen Runner 9b422c8b files
        tools/auto_sync/        # Frozen discovery, proposal, assemble, check_draft, checks, publish, summary, prompts
        pack/                   # Frozen resolve_dockerfile.sh, expand_matrix.sh, matrix.yaml
        docs/                   # Frozen supported-runners.md, support-records.md
        gpustack_runner/        # Frozen runner.py.json metadata
        tests/auto_sync/        # Frozen fixtures and reference unit tests
    src/
      corpus.ts                 # Frozen manifest & file-mode verifier
      python-bridge.ts          # Contained Python subprocess runner with loopback-only socket guard
      intake.ts                 # Discovery, /auto-sync revise auth/guidance guard, and pack-run-url preparation
      compile-taskpack.ts       # Emit Loopwright TrustedRegistry + ControllerConfiguration for Runner tasks
      service.ts                # HMAC-signed loopback /gate and /publish adapter over checks.py and publish.py
      parity.ts                 # 14-scenario legacy-vs-Loopwright offline parity runner and report builder
      types.ts                  # Public TypeScript interfaces for intake, service, and parity reports
      index.ts                  # Package barrel exports
    test/
      corpus-intake.test.ts     # Corpus tamper checks, revise auth/guidance/sentinel guards, pack-run-url bounds
      python-bridge.test.ts     # Interpreter preflight, sanitized environment, socket guard, bounded IO
      service-compile.test.ts   # Compiled config/registry validation, /gate and /publish HMAC & revalidation tests
      fake-adapter.ts           # Deterministic fake Pi adapter port for cycle-driven parity scenarios
      parity.test.ts            # Full 14-scenario offline parity matrix + frozen Python validator suite check
docs/
  runner-taskpack.md            # Operator & parity documentation for @loopwright/taskpack-runner
```

### Code Style

Follow the workspace's strict TypeScript ESM (`NodeNext`) conventions: immutable `readonly` interfaces, explicit error
codes, constant-time HMAC verification via `@loopwright/controller` (`verifySignedPayload` / `signPayload`), and zero
`any` casts.

```ts
export interface RunnerParityCaseResult {
  readonly scenario: RunnerParityScenario;
  readonly legacyStatus: string;
  readonly legacyReason: string | null;
  readonly legacyNormalized: string;
  readonly loopwrightOutcome: string | null;
  readonly acceptedGroupsMatch: boolean | null;
  readonly patchDigestMatch: boolean | null;
  readonly remoteWrites: number;
  readonly legacyRemoteWrites?: number;
  readonly classification: 'exact_match' | 'intentional_improvement' | 'mismatch';
  readonly explanation: string;
}
```

### Implementation Plan

Prefactor note: the only change to an existing package is a narrow additive export set in
`packages/controller/src/index.ts` (the constant-time HMAC pair plus the port-injected cycle entrypoints and their
ports type). Everything else lands inside the new `packages/taskpack-runner` workspace package, keeping every other
package's public surface untouched. Tasks may run in parallel whenever their `Blocked by:` edges allow; shared test
files are serialized by explicit edges.

- [x] **T1 · Controller seam expansion (narrow additive exports)**
      Blocked by: None
      Owns: `packages/controller/src/index.ts`
      Gate: review
      Acceptance: The `@loopwright/controller` public entry additionally exports `signPayload` and
        `verifySignedPayload` (the existing constant-time HMAC-SHA256 pair), `runCycleWithPorts`,
        `resumeCycleWithPorts`, and the `ControllerPorts` type. No existing export, signature, or behavior changes;
        `installedHandlerDigests` recomputes installed handler digests at runtime so the full existing suite stays green.
      Verify: `npm run build && npm test`

- [x] **T2 · Package scaffold, vendored frozen corpus, and manifest verifier**
      Blocked by: None
      Owns: `packages/taskpack-runner/{package.json,tsconfig.json}`, `packages/taskpack-runner/vendor/**`,
        `packages/taskpack-runner/src/{index.ts,corpus.ts,types.ts}`,
        `packages/taskpack-runner/test/corpus-intake.test.ts`, root `package.json`, root `tsconfig.test.json`
      Acceptance: The workspace package is registered (root workspaces list, build chain, root test glob, test
        tsconfig include, workspace-internal test script). `vendor/runner-auto-sync/` contains exactly the Feature 1
        file list, each file byte-identical to the pinned upstream revision (verified at vendor time against the
        pinned revision's git object read in read-only mode), with a committed `manifest.json` recording
        `sourceRepository`, `sourceRevision`, and `{ path, sha256, bytes, executable }` per file.
        `verifyFrozenCorpus` passes on the pristine corpus and rejects missing files, digest mismatches, byte-length
        mismatches, executable-bit mismatches, symlink substitution, and unlisted `.py`/`.sh` files under the frozen
        tool and pack trees with typed `RunnerTaskpackError` (`CORPUS_TAMPERED` / `CORPUS_UNAVAILABLE`).
      Verify: `npm run build && node --test .test-build/packages/taskpack-runner/test/corpus-intake.test.js`

- [x] **T3 · Contained Python bridge and frozen unit-check execution**
      Blocked by: T2
      Owns: `packages/taskpack-runner/src/python-bridge.ts`, `packages/taskpack-runner/test/python-bridge.test.ts`
      Acceptance: Preflight validates the configured interpreter (absolute path or PATH-resolved `python3`, invoked
        via `execFile`, never a shell), Python `>= 3.10`, and `packaging`/`yaml`/`requests` importability, returning
        a structured `PYTHON_UNAVAILABLE` error otherwise. Every invocation runs with the sanitized environment
        (private `0o700` scratch `HOME`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`,
        `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=/usr/bin/false`, `PYTHONDONTWRITEBYTECODE=1`, allowlisted tool
        `PATH`), a `sitecustomize.py` socket guard that raises on any non-loopback `socket.connect`, bounded
        stdin/stdout (`<= 1,048,576` bytes), and a per-call timeout. The vendored frozen unit checks execute under
        the bridge: the full frozen suite when the configured interpreter provides `pytest`, otherwise module import
        self-checks on stock Python, with `npm test` passing either way.
      Verify: `npm run build && node --test .test-build/packages/taskpack-runner/test/python-bridge.test.js`

- [x] **T4 · Runner intake: discovery, comment revision, and pack-run-url preparation**
      Blocked by: T3
      Owns: `packages/taskpack-runner/src/intake.ts`, intake sections of
        `packages/taskpack-runner/test/corpus-intake.test.ts`
      Acceptance: `prepareRunnerIntake` implements discovery mode (bridge invocation of frozen `discover`;
        `blocked`/`upstream_unavailable` when feeds failed and zero valid candidates exist with per-subscription
        errors preserved; `no_change` when nothing needs doing; `ready` with frozen identity, discovery, evidence,
        and prerelease permissions otherwise), revise mode (authorization restricted to `OWNER`/`MEMBER`/
        `COLLABORATOR` association or an explicit operator allowlist; guidance guards at exactly 40 lines, 2048
        UTF-8 bytes, the `=== .*? ===` sentinel pattern, and `REQUIRED:`/`NEVER:` prefixes, all failing closed;
        identity binding with `pr_number`, `command_id`, and `command_digest` so head mutations and duplicate
        commands are detected), and pack-run-url diagnosis (strict URL regex, cross-repository rejection, 4000-
        character truncation, sentinel stripping/rejection) with typed dispositions.
      Verify: `npm run build && node --test .test-build/packages/taskpack-runner/test/corpus-intake.test.js`

- [x] **T5 · Loopwright taskpack compiler**
      Blocked by: T2
      Owns: `packages/taskpack-runner/src/compile-taskpack.ts`, compiler sections of
        `packages/taskpack-runner/test/service-compile.test.ts`
      Acceptance: `compileRunnerTaskpack` emits a `TrustedRegistry` + `ControllerConfiguration` + `registrySha256`
        bundle that passes `loadTrustedConfiguration` and `compilePlan`: writable scope limited to Runner candidate
        paths; protected scope covering `.github`, frozen tooling, tests, and agent instruction files; a check-only
        or no-change-eligible graph for `no_change` discovery runs (publication skipped, external effects none);
        candidate/revise graphs referencing `runner-proposal-json` (`json-artifact.v1` on `.autosync/proposal.json`),
        `runner-candidate-validation` (`gate.v1` with `allowedEvidenceLevels: ['external_service']`), and
        `publication` (`pull_request` mode targeting the loopback publication endpoint); budgets capped
        (`maxFormatRepairs <= 2`, `maxImplementationRepairs <= 2`, bounded wall time, total tokens, and model calls)
        with the documented mapping from Runner stage budgets to controller caps; gate and publisher signing secrets
        bound exclusively through credential/environment bindings and absent from compiled plans and run bundles.
      Verify: `npm run build && node --test .test-build/packages/taskpack-runner/test/service-compile.test.js`

- [x] **T6 · Authenticated loopback validation gate and publication service**
      Blocked by: T1, T2, T3, T5
      Owns: `packages/taskpack-runner/src/service.ts`, service sections of
        `packages/taskpack-runner/test/service-compile.test.ts`
      Acceptance: `startRunnerTaskpackService` serves loopback-only HTTP implementing the controller wire
        protocols. `/gate` authenticates `x-loopwright-signature` constant-time, validates complete `gate_request`
        bindings, runs frozen `assemble` + `validate_proposal` + `validate_candidate` in a disposable exact-source
        git clone using controller-held trusted context (identity, sources, ascend pairs, prerelease permissions
        never read from candidate data), caches the verified checked artifact keyed by
        `(storeId, runId, candidateDigest)`, and returns signed verdicts (`approved` with a fresh `expiresAtMs`;
        `denied` with a reason of at most 256 characters carrying the validator diagnostic).
        `/publish` validates complete `publication_request` bindings, deduplicates by `idempotencyKey`, requires the
        gate-verified checked artifact for the same key, runs frozen `publish` against the vendored GitHub service
        double with independent pre-write revalidation, and maps outcomes to signed receipts (`succeeded`;
        `not_executed` with a structured reason for safe non-mutations; `failed` or a simulated connection drop
        driving `reconcile_required`). Unsigned, tampered, cross-bound, and replayed requests are rejected without
        state mutation.
      Verify: `npm run build && node --test .test-build/packages/taskpack-runner/test/service-compile.test.js`

- [x] **T7 · Parity harness core and legacy-side execution**
      Blocked by: T3
      Owns: parity report types in `packages/taskpack-runner/src/types.ts`, legacy-side sections of
        `packages/taskpack-runner/src/parity.ts`, legacy and frozen-suite sections of
        `packages/taskpack-runner/test/parity.test.ts`
      Acceptance: `RunnerParityReport` types and builder (`version: 1`, `sourceRevision`, `corpusDigest`, per-case
        `legacyOutcome`, `loopwrightOutcome`, `acceptedGroupsMatch`, `patchDigestMatch`, `remoteWrites`,
        `classification`, `explanation`, plus summary). A deterministic legacy-side executor drives the vendored
        frozen functions through the bridge on fixed corpus inputs (release tables, proposal drafts, disposable
        exact-source git fixtures, the vendored GitHub service double), recording dispositions for all 14 scenarios.
        Where a legacy disposition belongs to the frozen orchestrator rather than a vendored module (guidance bounds
        and job-log truncation), the legacy reference semantics are pinned by that orchestrator's published
        constants (40 lines, 2048 bytes, the sentinel pattern, the `REQUIRED:`/`NEVER:` prefixes, 4000 characters)
        recorded as corpus fixtures, and the report explanation states the derivation. The vendored frozen
        unit-check suite execution is reported (pytest-conditional per T3).
      Verify: `npm run build && node --test .test-build/packages/taskpack-runner/test/parity.test.js`

- [x] **T8 · Loopwright-side cycle execution with deterministic fake adapter (core scenarios)**
      Completed per the review ruling without widening any public surface: the adapter encodes the capture
      snapshot locally (session envelope, per-file chunk indices, outer attempt counter for repairs) and all six
      core scenarios match the legacy dispositions with correct remote-write counts.
      Blocked by: T6, T7
      Owns: `packages/taskpack-runner/test/fake-adapter.ts`, loopwright-side sections of
        `packages/taskpack-runner/src/parity.ts`, comparison sections of
        `packages/taskpack-runner/test/parity.test.ts` for `no_update`, `candidate_single_group`,
        `candidate_partial_groups`, `upstream_acquisition_failed`, `existing_managed_pr_convergence`,
        `head_changed_before_publish`
      Acceptance: A deterministic fake Pi adapter port (via the T1 seam) produces candidate submissions without
        Docker, model calls, or network; disposable local git target repositories and upstream source fixtures are
        created per case. Full port-injected cycles against the loopback service match the legacy dispositions:
        identical accepted-group sets and patch digests, `no_change` runs settling with no external effects and
        zero pull-request writes, idempotent convergence without duplicate pull requests, and head-advance refusal
        never force-overwriting human commits.
      Verify: `npm run build && node --test .test-build/packages/taskpack-runner/test/parity.test.js`

- [x] **T9 · Safety and repair scenarios, receipt reconciliation, full parity report**
      Blocked by: T4, T8
      Owns: remaining sections of `packages/taskpack-runner/src/parity.ts` and
        `packages/taskpack-runner/test/parity.test.ts` for `authorized_comment_revise`,
        `unauthorized_comment_revise`, `guidance_sentinel_injection`, `pack_run_url_diagnosis`,
        `malformed_or_traversal_draft`, `disallowed_path_or_symlink_patch`, `validation_feedback_repair`,
        `publication_receipt_lost_then_reconciled`
      Acceptance: Revise scenarios exercise intake authorization and guidance guards end-to-end (rejected at
        intake before any model eligibility or remote write). Path-traversal, symlink-mode, and disallowed-path
        drafts are denied by scope plus gate with zero pull-request writes. `validation_feedback_repair`
        demonstrates the bounded implementation-repair loop: a denied diagnostic leads to one fake-adapter repair
        generation, full re-validation of the repaired candidate, and confirmed publication.
        `publication_receipt_lost_then_reconciled` drives an unresolved publication (`reconcile_required`, unknown
        external effects), proves resume refuses blind replay with exactly one pull request, and settles via
        operator reconciliation with an authenticated receipt derived from the service double's landed pull-request
        state. The final report covers all 14 cases with classifications and explanations.
      Verify: `npm run build && node --test .test-build/packages/taskpack-runner/test/parity.test.js`

- [x] **T10 · Operator documentation and full verification sweep**
      Blocked by: T9
      Owns: `docs/runner-taskpack.md`
      Acceptance: Operator documentation covering corpus verification, bridge containment, intake guards, the
        compiled configuration mapping, service endpoints, and the parity report format. The full root verification
        suite is green, including targeted taskpack-runner tests; the parity report is asserted in tests rather
        than committed as a build artifact.
      Verify: `npm run build && npm run typecheck && npm run lint && npm test`

Checkpoint discipline: every task leaves the full root verification green before the next dependent task starts.
T1+T2 run first (disjoint files, parallelizable); T3+T5 run next (disjoint branches); T4 and T7 follow T3 on their
own branches; T6 integrates T5's documents with T1's exports and T3's bridge; T8/T9 build the parity matrix
incrementally; T10 closes with documentation and the full sweep.

### Test Plan
[ ] I/we understand the owners of the involved components may require updates to existing tests to make this
code solid enough prior to committing the changes necessary to implement this enhancement.

#### Prerequisite testing updates
- T1 changes controller distribution bytes, which shifts every installed handler digest. Existing fixtures recompute
  those digests at runtime, so the only prerequisite is re-running the full controller suite green before dependent
  tasks start (that is T1's gate); no existing test requires a permanent update.
- Baseline at planning time: full root verification (`npm run build`, `npm run typecheck`, `npm run lint`,
  `npm test` with 545 tests) is green locally with no taskpack-runner code present.

#### Unit tests
- `@loopwright/taskpack-runner` corpus verification (`corpus.ts`): 2026-11-10 - pristine manifest verification plus
  a tamper matrix (missing file, digest flip, byte-length flip, executable-bit flip, symlink substitution, unlisted
  `.py`/`.sh` under the frozen tool and pack trees) and `CORPUS_UNAVAILABLE` on an absent corpus root.
- `@loopwright/taskpack-runner` Python bridge (`python-bridge.ts`): 2026-11-10 - interpreter preflight (version
  floor, `packaging`/`yaml`/`requests` presence, structured `PYTHON_UNAVAILABLE`), sanitized-environment assertions,
  a live socket-guard probe (outbound connection attempt blocked, loopback permitted), stdin/stdout bounds, and
  per-call timeout enforcement.
- `@loopwright/taskpack-runner` intake (`intake.ts`): 2026-11-10 - discovery dispositions (`blocked`,
  `no_change`, `ready`, per-subscription error preservation), revise authorization matrix, guidance bounds (each
  guard at its limit and one over), identity binding (head mutation and duplicate command detection), and
  pack-run-url regex, truncation, and cross-repository rejection.
- `@loopwright/taskpack-runner` compiler (`compile-taskpack.ts`): 2026-11-10 - document validation through
  `loadTrustedConfiguration` + `compilePlan`, scope and protected-path mapping, budget caps, secret-binding
  containment (no secret material in compiled plans or run bundles), publication-mode mapping.
- `@loopwright/taskpack-runner` service (`service.ts`): 2026-11-10 - HMAC authentication in both directions
  (tampered signatures, replays, wrong bindings), gate approval and denial paths against real frozen validators,
  checked-artifact caching, publication outcome mapping including idempotent dedup, pre-write refusal, simulated
  connection drop, and operator receipt derivation and verification.
- Coverage expectation: every exported function in the new package is covered, with typed-error assertions on every
  rejection path; target `>= 90%` statement coverage for `corpus.ts`, `python-bridge.ts`, `intake.ts`,
  `compile-taskpack.ts`, and `service.ts`.

#### Integration tests
- Full 14-scenario offline parity matrix (`parity.test.ts`): each case asserts legacy and Loopwright dispositions,
  accepted-group equality, patch-digest equality, remote-write counts, and the classification with explanation,
  including the vendored frozen unit-check suite execution (pytest-conditional).
- Controller round-trip cases: loopback service with port-injected cycles, resume refusal of blind replay, and
  operator reconciliation settlement against disposable git fixtures.

#### e2e tests
- No live-network e2e: the specification's boundary forbids contacting GitHub, PyPI, or container registries. The
  14-scenario parity suite driving complete controller cycles against the loopback service and the vendored GitHub
  service double is the end-to-end equivalent within that boundary; live GitHub App delivery and hosted queues are
  deferred to a later specification.

## Alternatives

1. **Rewrite `discovery.py`, `proposal.py`, `checks.py`, and `publish.py` in TypeScript immediately**: Rejected because
   translating ~3,500 lines of subtle PEP 440 version parsing, Ascend variant aliasing, Dockerfile matrix expansion, and
   GitHub PR convergence simultaneously with orchestrator replacement would confound translation bugs with harness
   parity. Wrapping the exact frozen Python modules first establishes a provable baseline.
2. **Import Runner Python modules from an external sibling checkout path at test time**: Rejected because external
   checkouts drift across commits and make the repository non-self-contained for other readers and CI runners.
   Vendoring the `9b422c8bdbd31414ada7df8c4b55070b04957f44` domain subset (~380 KB) with a SHA-256 manifest guarantees
   bit-exact reproducibility.
3. **Add a custom Runner-only handler implementation inside `@loopwright/controller`**: Rejected because `@loopwright/controller`
   already provides general-purpose `json-artifact.v1`, `no-change.v1`, `scope.v1`, `gate.v1`, and `pull_request`
   publication primitives. Driving Runner validation and publication through `@loopwright/controller`'s standard signed
   HTTP gate and publication boundaries proves that the controller's external-effect architecture handles a real
   production taskpack cleanly without special-case controller hooks.

## Open Questions

None for offline parity scope. Live GitHub App webhook delivery, installation token minting, and multi-tenant queueing
are intentionally deferred to the GitHub App integration specification.
