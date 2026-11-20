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

## Interview rules

Follow five rules throughout the bootstrap session:

1. **Read before asking**: Scan manifests, scripts, Dockerfiles, and workflows before posing the first question.
2. **One question at once**: Ask one focused question per turn and wait for the reply before continuing.
3. **Propose a default**: Include one `(Recommended)` option grounded in repository evidence on every question.
4. **Defer all writes**: Never write or modify repository or controller files before Stage 5 summary approval.
5. **Select operating mode**: Confirm Mode 1 (Declarative Taskpack) or Mode 2 (Managed Controller) in Stage 1.

## Stage 1: Inventory

Scan existing sync scripts, Dockerfiles, dependency manifests (`go.mod`, `package.json`, `pyproject.toml`), Helm charts, version tables, and `.github/workflows/` files before asking questions.

### Operating mode selection

Confirm whether the repository needs Mode 1 (`.loopwright/taskpack.yaml` or `.auto-sync/<domain>.taskpack.yaml` with Action or App) or Mode 2 (out-of-repo `TrustedRegistry` and `ControllerConfig`). When Mode 2 applies, jump to [Managed Controller mode](#managed-controller-mode) after Stage 1.

### Modular domain decomposition

Non-trivial repositories mix independent toolchains, release cadences, and ownership boundaries. Split automation into independent domains with mutually exclusive `scope.writable` directories instead of one monolith taskpack.

Place multi-domain manifests directly under `.auto-sync/` as `.auto-sync/<domain>.taskpack.yaml`. That keeps `.auto-sync` as the shared control root, protects all `.auto-sync/**` assets, and permits `.auto-sync/memory/<domain>-sync`.

| Repository shape | Recommended layout | Example domains |
| --- | --- | --- |
| Single-purpose repo | Single `.loopwright/taskpack.yaml` | `docs-sync` or `catalog-sync` |
| Multi-component repo | `.auto-sync/<domain>.taskpack.yaml` | `charts`, `router`, `kv-transfer`, `k8s-deps`, `priors` |

Ask one question at a time to confirm:

1. **Automation boundary**: Which discovered components to automate and which to exclude (for example vendored forks or manual releases).
2. **Domain split**: Whether the proposed mutually exclusive `scope.writable` directories match maintainer ownership.
3. **Schedule cadence**: Per-domain cadence such as weekly (`0 3 * * 1`), monthly or bimonthly, or `workflow_dispatch`-only.

## Stage 2: Upstream policy

Map each automated domain to explicit `spec.upstreams[]` entries and version promotion rules.

### Upstream source kinds

| Upstream kind | Use case | Guardrail |
| --- | --- | --- |
| `github-release` | GitHub repositories publishing Releases | Set `allowPrerelease: false`; avoids archive or branch git tags |
| `git-tag` | Repositories without Releases | Filter non-SemVer tags deterministically in preflight |
| `git-commit` | Path-scoped source synchronization | Set `watchedPaths`; filter path noise via preflight `upstream-records` |
| `http-json` | JSON catalogs, OCI registries, PyPI, npm | Parse deterministically on host preflight |
| `custom-table` | Repository-local version matrix | Keep source table outside `scope.writable` |

Prefer `github-release` with `allowPrerelease: false` over `git-tag` whenever an upstream repository carries non-SemVer branch or archive tags. Built-in `git-commit` queries `/commits?per_page=1`, so enforce path-scoped `git-commit` noise suppression in host preflight (`upstream-records`).

### Version policy and promotion

Confirm three version guardrails one question at a time:

1. **Lockstep constraints**: Same-minor lockstep (for example Kubernetes or Helm minor alignment) and cross-repo pin matching.
2. **Two-stage promotion**: Whether image consumers need Stage A (recipe or Dockerfile sync) separate from Stage B (promoting built image tags via `target_tag` after registry publish).
3. **Setting-image holds**: Whether to keep a protected hold list (for example `.auto-sync/setting-image-holds.json` outside `scope.writable`) so newer base images publish ahead of runtime default bumps.

## Stage 3: Bounded execution

Separate online deterministic preparation from offline agent authoring and independent verification.

```text
Host Preflight (online, clean repo_root)
  -> source-revision commit + upstream-records JSON
  -> Isolated Agent (networkMode: none, writable scope only)
  -> Independent command.v1 Verifier (ephemeral git + LFS hydration)
```

### Host preflight responsibilities

Run deterministic preparation on the host before invoking Loopwright so the isolated agent stays offline (`networkMode: none`):

- **Discovery and filtering**: Query upstreams, apply lockstep or hold filters, and pass precomputed `upstream-records` JSON to the Action.
- **Toolchain caching**: Pre-warm Go, `uv`, Hugo, or Helm caches outside the writable tree before isolation starts.
- **LFS and Go isolation**: Stage Git-LFS objects without smudging `repo_root`, and run `go mod download all` inside a temporary copy so `repo_root` remains clean.
- **Staged revision**: Build a clean `source-revision` commit parented on `GITHUB_SHA` when preflight prepares deterministic fixtures or lockfiles.

### Scope and verifier contract

Protected paths always override writable ancestors. Keep `.github/workflows/`, taskpacks, instruction files, `command.v1` scripts, hold files, and `.auto-sync/memory/**` (or `.loopwright/memory/**`) protected.

Configure `verification.localChecks` with `json-artifact.v1` for the proposal and `command.v1` scripts for repository invariants:

- **Zero-drift checks**: Verify `make generate`, `go mod tidy`, chart lint, schema validation, and unit tests inside an ephemeral copy of `$LOOPWRIGHT_CANDIDATE_DIR`.
- **Clean hydration**: Hydrate Git-LFS or vendor caches inside the verifier temp directory rather than mutating `repo_root`.

## Stage 4: Workflow governance

Standardize model declarations, GitHub Actions inputs, slash commands, memory mode, and repository secrets.

### Unified model configuration

Declare model pools exclusively inside `*taskpack.yaml` (`spec.models`) using unified `apiKeyEnv: LOOPWRIGHT_PROVIDER_TOKEN`. Never generate model-specific Python or JavaScript helper scripts (such as `write_models_json.py`) and never hardcode vendor names in workflows or scripts.

```yaml
apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: charts-sync
spec:
  goal:
    candidate: Sync Helm chart dependencies from upstream releases and pass checks.
    noChange: Confirm chart versions match upstream releases and settle cleanly.
  scope:
    writable:
      - charts
    protected:
      - .auto-sync
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
  models:
    - provider: zai
      id: glm-5.3
      thinking: high
      apiKeyEnv: LOOPWRIGHT_PROVIDER_TOKEN
  sandbox:
    networkMode: none
```

### Standard workflow panel

Use one `workflow_dispatch` panel across domains, adding `domain` for multi-domain repos and `target_tag` when Stage B promotion is enabled:

| Input | Type | Values or default | Purpose |
| --- | --- | --- | --- |
| `domain` | `choice` | Domain slugs | Selects target domain in multi-domain repositories |
| `runner_profile` | `choice` | `normal`, `4x`, `8x` | Maps runner size label cleanly |
| `dry-run` | `boolean` | `false` | Compiles and checks preflight without model calls or PR writes |
| `force` | `boolean` | `false` | Bypasses `no_change` and open-PR deduplication on dispatch |
| `target_tag` | `string` | `""` | Optional Stage B container image tag override |

Follow three operational rules when authoring `.github/workflows/loopwright.yml`:

- **Comment routing**: On `issue_comment`, GitHub omits `pull_request.head.ref` and `inputs.domain`. Resolve the PR head branch first and match each domain's `headBranchPrefix` to select `domain` and its `concurrency` group.
- **Revise checkout**: Check out `refs/heads/main` with `fetch-depth: 0` and `persist-credentials: false`. Fetch `+refs/pull/<number>/head` into `.git/objects` without checking it out so `/auto-sync revise` can materialize the PR head commit.
- **Action auth**: Prefer `github-app-id` and `github-app-private-key` (or explicit `with: github-token:`). `resolveGitHubAuth` ignores `GH_TOKEN`.

### Memory and secrets

Ask the maintainer to confirm `spec.memory.apply`:

- `separate-pull-request` (default for reviewed memory; remind maintainers to skip automated code review on `loopwright/memory/**` branches if desired)
- `local-only` (updates memory locally without opening remote PRs)
- `disabled` (stateless runs)

List required GitHub Secrets before leaving Stage 4: `LOOPWRIGHT_APP_ID`, `LOOPWRIGHT_APP_PRIVATE_KEY`, `LOOPWRIGHT_PROVIDER_TOKEN`, and optional `LOOPWRIGHT_GATE_SIGNING_SECRET` / `LOOPWRIGHT_PUBLICATION_SIGNING_SECRET` when external endpoints are used.

## Stage 5: Summary gate

Present a concise architecture summary table covering every confirmed decision and stop for explicit user confirmation before writing any files:

| Domain | Upstreams | Cadence | Scope boundary | Verifier | Secrets |
| --- | --- | --- | --- | --- | --- |
| `<domain>` | `<id (kind)>` | `<cron/manual>` | `<writable / protected>` | `<localChecks>` | `<env names>` |

Before emitting YAML, fetch the owning Mode 1 Markdown guides linked from `llms.txt` (`Taskpack` and `GitHub Action`). Verify exact `command.v1` parameters, `spec.models[]` custom gateway fields, and Action `with:` input names rather than guessing.

Once approved, generate:

1. Two-space Pretty YAML taskpack manifests (`apiVersion: loopwright.dev/v1alpha1`, `kind: Taskpack`).
2. Protected instruction files (`spec.instructions`) and `command.v1` verification scripts.
3. Workflow YAML (`.github/workflows/loopwright.yml` or per-domain workflows) with least-privilege permissions.
4. Deterministic offline fixture selftests exercising real contracts, schema validation, and fail-closed guards (never brittle workflow-text scraping assertions).

## Stage 6: Tiered qualification

Qualify the generated configuration in three ordered tiers and report exact observed outcomes at each tier:

1. **Tier 1 (Local offline)**: Run offline fixture selftests, taskpack schema validation, and `dry-run: 'true'` compilation.
2. **Tier 2 (GitHub Actions dry run)**: Dispatch the live workflow with `dry-run=true` to verify preflight, App token minting, and compilation on the runner.
3. **Tier 3 (Live per-domain qualification)**: Dispatch each domain with `dry-run=false` (add `force=true` to test candidate authoring). Verify the opened PR and test `/auto-sync status` or `/auto-sync retry`.

## Managed Controller mode

When Stage 1 selects Mode 2, keep `registry.yaml` and `controller.yaml` outside the target repository (`0600` permissions) instead of committing `.loopwright/taskpack.yaml`:

1. Fetch the Mode 2 Markdown guides linked from `llms.txt` (`Managed Controller`, `Task Contract`, and `Controller and Registry`) before authoring schemas.
2. Confirm `scope.writable`, `scope.protected`, `budgets`, `steps`, and `acceptance.checks` one question at a time.
3. Confirm the Stage 5 summary table before writing any out-of-repo files.
4. Compute installed handler and runtime graph SHA-256 digests (`installedHandlerDigests()`, `describePiAdapterFiles()`, `package-lock.json` SHA-256).
5. Write `TrustedRegistry` (`registry.yaml`), compute its SHA-256, and bind it in `ControllerConfig` (`controller.yaml`) with embedded `TaskContract`.
6. Qualify locally with `loopwright check --config ... --registry ... --registry-sha256 ... --json` before running `loopwright run` or `loopwright step`.

---

**See also** — [Declarative Taskpack](../docs/walkthroughs/declarative-taskpack/index.md) (author and run a repository taskpack) · [Taskpack](../docs/configuration/taskpack/index.md) (complete manifest field dictionary) · [GitHub Action](../docs/operations/github-action/index.md) (Action inputs, preflight `source-revision`, and secrets) · [Managed Controller](../docs/walkthroughs/managed-controller/index.md) (out-of-repo `TrustedRegistry` and CLI governance)
