# Bootstrap Interview Reference

Use this protocol when a maintainer asks a coding agent to initialize or migrate Loopwright automation. Inspect the repository first, interview the maintainer one question at a time with repository-grounded defaults, and obtain approval on the summary before editing files.

## Contents

- [Interview rules](#interview-rules)
- [Stage 1: Inventory](#stage-1-inventory)
- [Stage 2: Upstream policy](#stage-2-upstream-policy)
- [Stage 3: Bounded execution](#stage-3-bounded-execution)
- [Stage 4: Workflow governance](#stage-4-workflow-governance)
- [Stage 5: Summary gate](#stage-5-summary-gate)
- [Stage 6: Tiered qualification](#stage-6-tiered-qualification)
- [Managed Controller mode](#managed-controller-mode)
- [Evolutionary campaign mode](#evolutionary-campaign-mode)

## Interview rules

Follow five rules throughout the bootstrap session:

1. **Read before asking**: Scan manifests, scripts, Dockerfiles, and workflows before posing the first question.
2. **One question at once**: Ask one focused question per turn and wait for the reply before continuing.
3. **Propose a default**: Include one `(Recommended)` option grounded in repository evidence on every question.
4. **Defer all writes**: Never write or modify repository or controller files before Stage 5 summary approval.
5. **Select operating mode**: Confirm Mode 1 (Declarative Taskpack), Mode 2 (Managed Controller), or Mode 3 (Evolutionary Campaign) in Stage 1.

## Stage 1: Inventory

Scan existing sync scripts, Dockerfiles, dependency manifests (`go.mod`, `package.json`, `pyproject.toml`), Helm charts, version tables, kernel or benchmark build scripts, and `.github/workflows/` files before asking questions.

### Operating mode selection

Confirm whether the repository needs Mode 1 (`.loopwright/taskpack.yaml` or a multi-domain `TaskpackSuite` under `.auto-sync/suite.yaml` with Action or App), Mode 2 (out-of-repo `TrustedRegistry` and `ControllerConfig`), or Mode 3 (bounded multi-generation optimization via `EvolutionCampaign`, `evolve-block-guard.v1`, and `loopwright evolve`). Jump to [Managed Controller mode](#managed-controller-mode) for Mode 2, or [Evolutionary campaign mode](#evolutionary-campaign-mode) for Mode 3, after Stage 1.

### Modular domain decomposition

Non-trivial repositories mix independent toolchains, release cadences, and ownership boundaries. Split automation into independent domains with mutually exclusive `scope.writable` `/**` directories instead of one monolith taskpack.

Single-taskpack repositories omit `suite.yaml`. For `2..32` domains, place domain manifests under `.auto-sync/<domain>-taskpack.yaml` (or `.loopwright/<domain>/taskpack.yaml`) and declare one `TaskpackSuite` manifest (`.auto-sync/suite.yaml` or `.loopwright/suite.yaml`).

`TaskpackSuite` enforces the suite-wide protected-path union (`<= 128` patterns), pairwise prefix-disjoint `headBranchPrefix` values per `targetBranch`, and collision-free carved-out `spec.proposal.path` files (for example `.auto-sync/proposals/<domain>.json`).

| Repository shape | Recommended layout | Example domains |
| --- | --- | --- |
| Single-purpose repo | Single `.loopwright/taskpack.yaml` | `docs-sync` or `catalog-sync` |
| Multi-component repo | `.auto-sync/suite.yaml` + `.auto-sync/<domain>-taskpack.yaml` | `charts`, `router`, `kv-transfer`, `k8s-deps`, `priors` |

```yaml
apiVersion: loopwright.dev/v1alpha1
kind: TaskpackSuite
metadata:
  name: repo-auto-sync
spec:
  domains:
    - id: charts
      taskpack: .auto-sync/charts-taskpack.yaml
      schedules: # Optional cron keys matching workflow on.schedule
        - "0 2 * * 3"
    - id: router
      taskpack: .auto-sync/router-taskpack.yaml
      stage: stage-a # Optional stage reference
      schedules: # Optional
        - "0 3 * * 2"
  stages: # Optional 0..16 acyclic promotion stages
    - id: stage-a
    - id: stage-b
      dependsOn:
        - stage-a
      readiness:
        - id: router-release # Optional
          kind: github-release
          source: octocat/router
          versionFrom: # Optional committed baseRevision version lookup
            domain: router
            path: .auto-sync/proposals/router.json
            jsonPointer: /version
```

Ask one question at a time to confirm:

1. **Automation boundary**: Which discovered components to automate and which to exclude (for example vendored forks or manual releases).
2. **Domain split**: Whether the proposed mutually exclusive `scope.writable` directories match maintainer ownership.
3. **Schedule cadence**: Per-domain cadence such as weekly (`0 3 * * 1`), monthly or bimonthly, or `workflow_dispatch`-only.

## Stage 2: Upstream policy

Map each automated domain to explicit `spec.upstreams[]` entries, `spec.upstreamGroups[]`, and version promotion rules.

### Upstream source kinds

| Upstream kind | Use case | Guardrail |
| --- | --- | --- |
| `github-release` | GitHub repositories publishing Releases | Set `allowPrerelease: false`; avoids archive or branch git tags |
| `git-tag` | Repositories without Releases | Filter non-SemVer tags deterministically in `spec.preflight` |
| `git-commit` | Path-scoped source synchronization | Set `watchedPaths`; Taskpack 2.0 wires `watchedPaths` into intake summaries and prompts |
| `http-json` | JSON catalogs, OCI registries, PyPI, npm | Use native `versionPath` selector and `monotonicSemver: true` (default) to block downgrades |
| `custom-table` | Repository-local version matrix | Keep source table outside `scope.writable` |

Prefer `github-release` with `allowPrerelease: false` over `git-tag` whenever an upstream repository carries non-SemVer branch or archive tags. Sort non-prerelease `vX.Y.Z` releases by numeric SemVer tuple so older-branch patch releases never downgrade newer minor releases. For `http-json` feeds, configure `versionPath` and `monotonicSemver` natively instead of custom parser glue.

### Version policy and promotion

Confirm three version guardrails one question at a time:

1. **Lockstep constraints**: Declare `spec.upstreamGroups[]` (`{ id, policy: lockstep | independent, members }`) so mismatched or partial lockstep releases resolve atomically as `held_back` without blocking sibling upstreams.
2. **Two-stage promotion**: Use declarative `TaskpackSuite` `spec.stages[]` readiness probes (`github-release`, `http-json`, `git-tag`, `git-commit` with `versionFrom`) when Stage B waits on an upstream release, tag, commit, or JSON feed without Git state ledgers. Keep multi-arch OCI manifest probing (such as `crane manifest` checking `linux/amd64` and `linux/arm64`) and explicit `target_tag` overrides in `spec.preflight` when registry-level multi-arch checks are required, draining un-held Stage B promotions before starting new Stage A syncs.
3. **Setting-image holds**: Whether to keep a protected hold list (for example `.auto-sync/setting-image-holds.json` outside `scope.writable`) or use native `held_back` status so newer base images publish ahead of runtime default bumps.

## Stage 3: Bounded execution

Separate authorized host preflight from offline sandboxed agent steps and directory-mounted independent checks.

```text
Host Preflight (post-auth, $LOOPWRIGHT_PREFLIGHT_OUT, $LOOPWRIGHT_STAGING_DIR)
  -> Split stagedResources (mount: prompt vs mount: workspace + exposeToChecks)
  -> Isolated Agent (networkMode: none, explicit /** & */? writable scope)
  -> Independent Verifiers (directory-mounted command.v1, built-in guards)
```

### Host preflight responsibilities

Declare `spec.preflight` (`script` under a protected path such as `scripts/**` or `.auto-sync/**`) so Loopwright runs it post-auth and pre-compilation:

- **Disposition and upstreams**: Emit `{ disposition: 'candidate' | 'no_change' | 'blocked', upstreams, stagedResources }` to `$LOOPWRIGHT_PREFLIGHT_OUT`, using native `held_back` status without smuggling paths in `reason`.
- **Split staged resources**: Use `mount: 'prompt'` (`<= 64 KiB` UTF-8 per file, `<= 256 KiB` total) for `trustedContext.resources` text, and `mount: 'workspace'` (`<= 128 MiB`, `<= 256 MiB` total, projected via single-descriptor `1 MiB` streaming) plus `exposeToChecks: true` for large lockfiles or `.tgz` offline caches exposed via `$LOOPWRIGHT_STAGED_DIR` (single-link regular files only; pack directories such as `npm-cache` as `.tgz`).
- **Clean baselines**: Keep `repo_root` clean and hydrate LFS or vendor caches inside ephemeral verifier directories.

### Scope and verifier contract

Use explicit `dir/**` for recursive directories, exact paths without `/**` for single files, and single-segment `*`/`?` globs (`packages/*/package.json`). Protected paths always override writable ancestors.

Local runs protect only `.git` and `<controlRoot>` (preserving the exact-file `spec.proposal.path` carve-out) plus `digests.lock.json` without hardcoded tool directories; declare repo-specific paths (such as `.claude/**`, `CLAUDE.md`, `AGENTS.md`) explicitly in `spec.scope.protected`. GitHub entrypoints also protect `.github`, requiring dual-key `allowWorkflowWrites` for `.github/workflows/**`.

Configure `verification.localChecks` with `json-artifact.v1`, `json-keys-guard.v1`, `line-section-guard.v1`, and directory-mounted `command.v1` scripts:

- **Directory-mounted checks**: `command.v1` mounts the script's parent directory read-only (whole-tree SHA-256 digest so `./lib.sh` works), mounts the disposable `$LOOPWRIGHT_CANDIDATE_DIR` writable (discarded after exit), mounts declared `parameters.env` host stage directories (and safe direct child symlink targets) read-only, supports `toolchainPaths`, and exports `$LOOPWRIGHT_BASE_DIR`, `$LOOPWRIGHT_STAGED_DIR`, and `$LOOPWRIGHT_CHECK_OUT` (strict JSON keys `{ detail?, metrics?, findings? }` only — never emit `passed` or `summary`).
- **Inner sandboxes and host mounts**: Checks running inner OS sandboxes (such as macOS `sandbox-exec`) should opt into `allowCheckNetwork: true` under dual-key `allow-privileged-execution` to prevent nested Seatbelt `EPERM`. Checks requiring host sockets, files, or directories (such as `docker` / `docker buildx` over `/var/run/docker.sock`) declare `parameters.mounts: [{ source: /var/run/docker.sock, mode: rw }]` on the `command.v1` check plus workflow `allow-privileged-execution: 'true'` and `allow-host-mounts: /var/run/docker.sock`.
- **Conditional rules and handoffs**: Split large instruction sets with conditional `{ path, when }` rules (`changedPaths`, `extensions`, `phases`, `failedChecks`, `failureCodes`) and use `spec.steps[].handoffs` (`markdown_heading`, `json_pointer`, `full`) in multi-step DAGs to bound prompt size.
- **Baseline conflict alignment**: Enable `spec.baselineAlignment: { policy: extract-context }` (or `fail-fast`) for comment-revised PRs or detached `source_revision` preflight commits to detect 3-way conflicts in an isolated object store before spending model turns.

## Stage 4: Workflow governance

Standardize trust modes, model declarations, GitHub Actions inputs, slash commands, memory mode, and repository secrets.

### Model and trust config

Declare model pools exclusively inside `*taskpack.yaml` (`spec.models`) using unified `apiKeyEnv: LOOPWRIGHT_PROVIDER_TOKEN`. Never generate model-specific helper scripts and never hardcode vendor names in workflows or scripts.

For local CLI manifests (`loopwright run --taskpack` / `loopwright step`), `spec.triggers`, `spec.publication`, and `spec.memory` are optional; GitHub workflows require explicit `spec.triggers` (enforced pre-preflight) and PR `spec.publication` fields. Keep `spec.execution.mode: strict` unless host toolchains require dual-key privileged unlock (`allow-privileged-execution: 'true'` or `--allow-privileged`):

```yaml
apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: charts-sync
spec:
  goal:
    candidate: Sync Helm chart dependencies from upstream releases and pass checks.
    noChange: Confirm chart versions match upstream releases and settle cleanly.
  execution:
    mode: strict
    digests:
      pinDigests: false
  preflight:
    script: .auto-sync/preflight.mjs
    timeoutSeconds: 120
  scope:
    writable:
      - charts/**
    protected:
      - .auto-sync/**
  upstreams:
    - id: engine
      kind: github-release
      source: octocat/engine
      watchedPaths: []
      allowPrerelease: false
  proposal:
    path: charts/proposal.json
    requiredFields:
      - schema_version
      - candidates
    schemaVersion: 1
  verification:
    localChecks:
      - id: proposal-check
        implementation: json-artifact.v1
    externalGates: []
  publication:
    mode: pull_request
    targetBranch: main
    headBranchPrefix: auto-sync-charts-
    titleTemplate: "chore(charts) - sync upstream versions"
  memory:
    directory: .auto-sync/memory/charts-sync
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands:
      - retry
      - revise
      - status
    commentPrefixes:
      - /auto-sync
  baselineAlignment: # Optional isolated 3-way conflict check
    policy: extract-context # Optional (off, fail-fast, or extract-context)
  models:
    - provider: zai
      id: glm-5.3
      thinking: high
      apiKeyEnv: LOOPWRIGHT_PROVIDER_TOKEN
  sandbox:
    networkMode: none
```

### Standard workflow panel

Use `mode: auto` in `.github/workflows/loopwright.yml` so Loopwright dispatches `candidate` or check-only `no-change` runs from preflight without external bash mode-resolution glue. Add `domain` for multi-domain repos and `target_tag` when Stage B promotion is enabled:

| Input | Type | Values or default | Purpose |
| --- | --- | --- | --- |
| `domain` | `choice` | Domain slugs | Selects target domain in multi-domain repositories |
| `runner_profile` | `choice` | `normal`, `4x`, `8x` | Maps runner size label cleanly |
| `dry-run` | `boolean` | `false` | Compiles and checks preflight without model calls or PR writes |
| `force` | `boolean` | `false` | Bypasses `no_change` and open-PR deduplication on dispatch |
| `target_tag` | `string` | `""` | Optional Stage B container image tag override |

Follow four operational rules when authoring `.github/workflows/loopwright.yml`:

- **Suite matrix and comment routing**: For multi-domain repositories, run a `resolve-domains` job with `suite-path: .auto-sync/suite.yaml` and `resolve-suite-only: 'true'` to emit `outputs.matrix` (verifying PR ownership and blocking cross-fork comments automatically), then pass `suite-path` and `domain: ${{ matrix.domainId }}` in each matrix job.
- **Staggered schedule parity**: When one workflow file carries staggered per-domain crons in `on.schedule`, mirror those cron strings in `suite.yaml` `domains[].schedules` and verify exact set parity in CI; omit `schedules` when domains share one cron or use separate trigger workflows.
- **Revise checkout**: Check out `refs/heads/main` with `fetch-depth: 0` and `persist-credentials: false`. Fetch `+refs/pull/<number>/head` into `.git/objects` without checking it out so `/auto-sync revise` can materialize the PR head commit.
- **Action auth and diagnostics**: Prefer `github-app-id` and `github-app-private-key` (or explicit `with: github-token:`), enable `allow-privileged-execution: 'true'` or `allow-workflow-writes: 'true'` only when needed, and preserve `Run Health` (`run-eval.json`) diagnostics in step summaries or uploaded artifacts.

### Memory and secrets

Ask the maintainer to confirm `spec.memory.apply`:

- `inline-with-candidate` (recommended for low-noise PR workflows; appends a host-signed memory-only commit onto the published candidate PR branch with zero shadow memory PRs and `skipCi: false` by default)
- `separate-pull-request` (dedicated `loopwright/memory/**` PRs including stale-entry cleanup; `@loopwright/memory` terminates `index.json` with a trailing `\n`)
- `local-only` (updates memory locally without opening remote PRs)
- `disabled` (stateless runs)

List required GitHub Secrets before leaving Stage 4: `LOOPWRIGHT_APP_ID`, `LOOPWRIGHT_APP_PRIVATE_KEY`, `LOOPWRIGHT_PROVIDER_TOKEN`, and optional `LOOPWRIGHT_GATE_SIGNING_SECRET` / `LOOPWRIGHT_PUBLICATION_SIGNING_SECRET` when external endpoints are used.

## Stage 5: Summary gate

Present a concise architecture summary table covering every confirmed decision and stop for explicit user confirmation before writing any files:

| Domain | Upstreams | Cadence | Scope boundary | Verifier | Secrets |
| --- | --- | --- | --- | --- | --- |
| `<domain>` | `<id (kind)>` | `<cron/manual>` | `<writable / protected>` | `<localChecks>` | `<env names>` |

Before emitting YAML, fetch the owning Mode 1 Markdown guides linked from `llms.txt` (`Taskpack` and `GitHub Action`). Verify exact `spec.execution`, `spec.preflight`, `command.v1` parameters, `spec.models[]`, `TaskpackSuite`, and Action `with:` input names rather than guessing.

Once approved, generate:

1. Two-space Pretty YAML taskpack manifests (`apiVersion: loopwright.dev/v1alpha1`, `kind: Taskpack`), plus one `kind: TaskpackSuite` manifest (`.auto-sync/suite.yaml` or `.loopwright/suite.yaml`) whenever the repository has `>= 2` domains.
2. Protected `spec.preflight` scripts, instruction files (with conditional `{ path, when }` rules when needed), and `command.v1` verification scripts (plus `digests.lock.json` via `loopwright digest sync` when `pinDigests: true`).
3. Workflow YAML (`.github/workflows/loopwright.yml` or per-domain workflows) using `suite-path` + `resolve-suite-only: 'true'` for multi-domain suites, `mode: auto`, and least-privilege permissions.
4. Lean, decoupled repo-side checks (`bash -n`, `shellcheck`, YAML/JSON/path integrity, schedule-set parity, and fail-closed contract guards) — avoid multi-thousand-line mock-repo selftests, hardcoded current version literals, or ad-hoc counterexample tests.

## Stage 6: Tiered qualification

Qualify the generated configuration in three ordered tiers and report exact observed outcomes at each tier:

1. **Tier 1 (Local offline)**: Run lean repository checks, `loopwright suite check --suite <suite-path> --verify-digests` (and `suite resolve`) for multi-domain suites or `loopwright digest sync --taskpack ... --check` for single-taskpack repos, plus `dry-run: 'true'` compilation.
2. **Tier 2 (GitHub Actions dry run)**: Dispatch the live workflow with `dry-run=true` to verify suite matrix resolution, preflight, App token minting, and compilation on the runner.
3. **Tier 3 (Live per-domain qualification)**: Dispatch each domain with `dry-run=false` (add `force=true` to test candidate authoring). Verify the opened PR and test `/auto-sync status` or `/auto-sync retry`.

## Managed Controller mode

When Stage 1 selects Mode 2, keep `registry.yaml` and `controller.yaml` outside the target repository (`0600` permissions) instead of committing `.loopwright/taskpack.yaml`:

1. Fetch the Mode 2 Markdown guides linked from `llms.txt` (`Managed Controller`, `Task Contract`, and `Controller and Registry`) before authoring schemas.
2. Confirm `scope.writable`, `scope.protected`, `budgets`, `steps`, and `acceptance.checks` one question at a time.
3. Confirm the Stage 5 summary table before writing any out-of-repo files.
4. Compute installed handler and runtime graph SHA-256 digests (`installedHandlerDigests()`, `describePiAdapterFiles()`, `package-lock.json` SHA-256).
5. Write `TrustedRegistry` (`registry.yaml`), compute its SHA-256, and bind it in `ControllerConfig` (`controller.yaml`) with embedded `TaskContract`.
6. Qualify locally with `loopwright check --config ... --registry ... --registry-sha256 ... --json` before running `loopwright run` or `loopwright step`.

## Evolutionary campaign mode

When Stage 1 selects Mode 3, keep campaign state (`--state`) strictly outside `--repo` and bind every mutable region to `evolve-block-guard.v1`:

1. Fetch the Mode 3 Markdown guides linked from `llms.txt` (`Evolutionary Campaigns`, `Evolution Campaign`, `Taskpack`, and `CLI`) before authoring schemas.
2. Confirm guarded `EVOLVE-BLOCK` source files (`allowedBlockIds`, `maxBlockBytes`), hardware `target.matrix` cell (`accelerator`, `isolationMode`, `driverConstraint`, Stage A static audit bounds), and held-out `benchmark-gate.v1` workloads plus `runner relay|worker` topology one question at a time.
3. Confirm search `stages` (`single-target` or `specialist-then-portfolio`), `population` islands and `nicheAxes`, multi-objective `objectives`, `budgets`, optional read-only `teamEvolution`, `export` format (`dir` or `oci-layout`), and required secrets (`LOOPWRIGHT_PROVIDER_TOKEN`, `LOOPWRIGHT_BENCHMARK_GATE_URL`, `LOOPWRIGHT_GATE_SIGNING_SECRET`).
4. Confirm the Stage 5 summary table before writing `.loopwright/taskpack.yaml` and `.loopwright/campaign.yaml`.
5. Validate offline with `loopwright evolve check --campaign .loopwright/campaign.yaml --repo . --json`.
6. Qualify locally with a loopback `runner relay` + `runner worker` (`probeMode: synthetic_fixture`, `--allow-synthetic-probe`) before running against live physical hardware (`loopwright evolve run|resume|status|inspect|export`).

---

**See also** — [Declarative Taskpack](../latest/docs/walkthroughs/declarative-taskpack/index.md) (author and run a repository taskpack) · [Taskpack](../latest/docs/configuration/taskpack/index.md) (complete manifest field dictionary) · [Evolutionary Campaigns](../latest/docs/walkthroughs/evolutionary-campaigns/index.md) (end-to-end evolutionary campaign setup) · [Evolution Campaign](../latest/docs/configuration/evolution-campaign/index.md) (`EvolutionCampaign` schema and bundle contract) · [GitHub Action](../latest/docs/operations/github-action/index.md) (Action inputs, preflight `source-revision`, and secrets) · [Managed Controller](../latest/docs/walkthroughs/managed-controller/index.md) (out-of-repo `TrustedRegistry` and CLI governance)
