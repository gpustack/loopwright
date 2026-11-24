# Declarative Taskpack

Declarative taskpack mode is Loopwright's automated workflow for repository maintainers and local CLI operators. Author one `.loopwright/taskpack.yaml` file in your repository, and `loopwright run --taskpack`, `loopwright step`, or the GitHub Action compiles contracts, handler digests, preflight stages, and credential bindings automatically.

For out-of-repo `TrustedRegistry` governance or manual CLI controller configs, follow [Managed Controller](managed-controller.md) instead.

## Contents

- [Overview](#overview)
- [Prompt bootstrap](#prompt-bootstrap)
- [Step 1: Author taskpack](#step-1-author-taskpack)
- [Step 2: Validate taskpack](#step-2-validate-taskpack)
- [Step 3: Configure workflow](#step-3-configure-workflow)
- [Step 4: Review outcomes](#step-4-review-outcomes)

## Overview

![Declarative taskpack flow](../assets/diagrams/taskpack-sync-flow.svg)

<!-- flowchart LR
  Watch["01 Watch upstream"] -> Compile["02 Auto-compile taskpack"] -> Verify["03 Verify checks"] -> Publish["04 Publish PR"]
-->

Declarative taskpack mode eliminates boilerplate while preserving every Loopwright safety boundary:

| Responsibility | Authored in taskpack | Compiled by Loopwright |
| --- | --- | --- |
| Work scope | Explicit `dir/**`, exact files, or `*`/`?` globs | Adds control paths, scripts, and built-in masks; protected wins |
| Execution | `spec.execution`, `spec.preflight`, `upstreams`, `proposal` | Runs preflight post-auth and compiles `0600` runtime configs |
| Digests | Optional `digests.pinDigests` (`digests.lock.json`) | Computes SHA-256 digests for handlers, check dirs, and instructions |
| Secrets | Pass GitHub Secrets to Action or App env | Generates scoped `${ENV}` bindings and scrubs logs |
| Settlement | Choose `pull_request` or `disabled` | Opens head-pinned PRs or settles check-only `no_change` runs |

## Prompt bootstrap

`loopwright init` scaffolds low-level controller drafts and does not inspect your repository. To run an interview-first setup or migrate an existing sync workflow, paste this prompt into your coding agent inside the target repository:

```text
Read https://docs.gpustack.ai/loopwright/llms.txt and its Bootstrap Interview Reference (https://docs.gpustack.ai/loopwright/references/bootstrap-interview.md). Inspect this repository first WITHOUT editing any files yet, then interview me one question at a time with repository-grounded defaults to agree on which modules to automate or exclude, domain boundaries, update cadence, version/promotion holds, bounded host preflight -> offline sandbox -> independent verifier design, model pool (LOOPWRIGHT_PROVIDER_TOKEN), and workflow panel. Wait for my approval on the design summary before generating Loopwright config (apiVersion: loopwright.dev/v1alpha1) and running dry-run verification.
```

The agent scans your repository, interviews you one question at a time, waits for summary approval, and writes taskpacks, `TaskpackSuite` manifests (for multi-domain repos), bounded verifiers, and workflows.

## Step 1: Author taskpack

Create `.loopwright/taskpack.yaml` in the target repository (Loopwright derives `.loopwright` as the control root; pass `--taskpack <dir>/taskpack.yaml` for a custom root):

```yaml
apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: docs-sync
spec:
  goal:
    candidate: Refresh documentation from upstream releases and pass local checks.
    noChange: Confirm upstream documentation needs no update and settle as no change.
  execution: # Optional trust mode and lockfile pinning
    mode: strict # Optional (defaults to strict)
    digests:
      pinDigests: true
  preflight: # Optional post-auth host preflight hook
    script: scripts/prepare-docs-sync.mjs
    timeoutSeconds: 120 # Optional
  scope: # Optional
    writable:
      - docs/**
    protected:
      - docs/protected-notes.md
      - scripts/**
  upstreams:
    - id: engine
      kind: github-release
      source: octocat/engine
      watchedPaths:
        - docs
  proposal: # Optional structured proposal ledger
    path: docs/proposal.json
    requiredFields:
      - schema_version
      - candidates
    schemaVersion: 1
  verification:
    localChecks:
      - id: docs-proposal-json
        implementation: json-artifact.v1
      - id: verify-docs
        implementation: command.v1
        parameters:
          script: .loopwright/checks/verify.sh
          timeoutSeconds: 30 # Optional
    externalGates: [] # Optional
  publication:
    mode: pull_request
    targetBranch: main
    headBranchPrefix: loopwright-docs-
    titleTemplate: "docs - sync upstream documentation"
  memory:
    directory: .loopwright/memory/docs-sync
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
  models: # Optional ordered model pool
    - provider: zai
      id: glm-5.3
      thinking: high # Optional
      apiKeyEnv: ZAI_API_KEY # Optional
```

- **Field reference**: See [Taskpack](../configuration/taskpack.md) for `roles`, `steps`, `decisions`, `sandbox`, and `TaskpackSuite`.
- **Local manifests**: Local CLI runs (`run --taskpack` and `step`) can omit `triggers`, `publication`, and `memory`.
- **Protected inputs**: Place instructions, `preflight.script`, and `command.v1` scripts under protected paths.
- **Zero embedded secrets**: Never put tokens or `${ENV}` templates in `taskpack.yaml`; use `spec.vars` for static non-secret values.

### Delegated role DAG

Add `spec.roles` (`author` + read-only `review`) and optional `spec.steps` to run zero-secret local step loops (see [Taskpack](../configuration/taskpack.md#roles-and-steps) and [Coding Agents](../operations/coding-agents.md)):

```sh
loopwright step next --taskpack .loopwright/taskpack.yaml --repo . --run-root ../runs --run-id demo-1 --json
loopwright step submit --run-root ../runs --run-id demo-1 --lease TOKEN --status completed --json
```

## Step 2: Validate taskpack

Confirm the [runtime baseline](../getting-started/architecture.md#runtime-baseline), sync `digests.lock.json` when `pinDigests: true`, and dry-run locally before enabling Actions:

```sh
loopwright digest sync --taskpack .loopwright/taskpack.yaml --repo .
loopwright digest sync --taskpack .loopwright/taskpack.yaml --repo . --check --json
loopwright run --taskpack .loopwright/taskpack.yaml --repo . --dry-run --json
loopwright run --taskpack .loopwright/taskpack.yaml --repo . --run-root ../runs --run-id demo-1 --json
```

`--dry-run` validates the manifest, verifies `digests.lock.json`, negotiates sandboxes, and compiles artifacts without running preflight, models, or pushes.

## Step 3: Configure workflow

Add `.github/workflows/loopwright.yml` to run on `schedule`, `workflow_dispatch`, or `/loopwright` comments with `mode: auto`:

```yaml
name: Loopwright Sync
on:
  schedule:
    - cron: '0 4 * * *'
  workflow_dispatch:
  issue_comment:
    types:
      - created
permissions:
  contents: read
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: gpustack/loopwright@main
        with:
          taskpack-path: .loopwright/taskpack.yaml # Optional
          mode: auto # Optional
          github-app-id: ${{ secrets.LOOPWRIGHT_APP_ID }}
          github-app-private-key: ${{ secrets.LOOPWRIGHT_APP_PRIVATE_KEY }}
          event-name: ${{ github.event_name }}
          event-path: ${{ github.event_path }}
          dry-run: 'false' # Optional
        env:
          ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}
```

### Bootstrap provenance

- **Trusted checkout**: Check out `refs/heads/main` with `persist-credentials: false`, gate `issue_comment` to authorized collaborators, and fetch `+refs/pull/<number>/head` without checking out untrusted PR heads.
- **Commit SHA pinning**: Pin third-party Actions and `gpustack/loopwright` to 40-character commit SHAs instead of `uses: ./` during self-upgrades so candidate branches cannot replace control-plane code.

## Step 4: Review outcomes

1. **Candidate pull request**: Opens or updates a head-pinned PR matching `headBranchPrefix` after all checks pass.
2. **Verified no-change**: Runs check-only `no-change.v1` verification without model calls when `mode: auto` finds no change.
3. **Slash-command iteration**: Authorized collaborators comment `/loopwright status`, `retry`, or `revise`.
4. **Reviewed memory**: Persists active entries under `<controlRoot>/memory/<name>` per `spec.memory.apply` without blocking task completion.

---

**See also** — [Taskpack](../configuration/taskpack.md) (manifest schema, limits, and `TaskpackSuite`) · [Managed Controller](managed-controller.md) (out-of-repo contract and registry workflow)

**Next** → [GitHub Action](../operations/github-action.md) — configure Action inputs, permissions, and secrets.
