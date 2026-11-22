# Declarative Taskpack

Declarative taskpack mode is Loopwright's automated workflow for repository maintainers and local CLI operators. Author one `.loopwright/taskpack.yaml` file in your repository, and `loopwright run --taskpack`, `loopwright step`, or the GitHub Action compiles contracts, handler digests, preflight stages, and credential bindings automatically.

For strict separation between task authors and out-of-repo `TrustedRegistry` files, or local CLI controller configs, follow [Managed Controller](/loopwright/0.0/docs/walkthroughs/managed-controller/index.md) instead.

## Contents

- [Overview](#overview)
- [Prompt bootstrap](#prompt-bootstrap)
- [Step 1: Author taskpack](#step-1-author-taskpack)
- [Step 2: Validate taskpack](#step-2-validate-taskpack)
- [Step 3: Configure workflow](#step-3-configure-workflow)
- [Step 4: Review outcomes](#step-4-review-outcomes)

## Overview

![Declarative taskpack flow](/loopwright/0.0/docs/assets/diagrams/taskpack-sync-flow.svg)

<!-- flowchart LR
  Watch["01 Watch upstream"] -> Compile["02 Auto-compile taskpack"] -> Verify["03 Verify checks"] -> Publish["04 Publish PR"]
-->

Declarative taskpack mode eliminates manual boilerplate while preserving every Loopwright safety boundary:

| Responsibility | Authored in taskpack | Compiled by Loopwright |
| --- | --- | --- |
| Work scope | Explicit `dir/**`, exact files, or `*`/`?` `writable` and `protected` paths | Adds control paths, scripts, and built-in masks; protected paths win |
| Execution | Declare `spec.execution`, `spec.preflight`, `upstreams`, and optional `proposal` | Runs preflight post-auth and compiles `TaskContract`, `ControllerConfig`, and `TrustedRegistry` (`0600`) |
| Digests | Optional `digests.pinDigests` (`digests.lock.json`) | Computes runtime SHA-256 digests for handlers, check directories, instructions, and skills |
| Secrets | Pass GitHub Secrets to Action or App env | Generates scoped `${ENV}` credential bindings and scrubs preflight and run logs |
| Settlement | Choose `pull_request` or `disabled` | Opens head-pinned PRs or settles check-only `no_change` runs |

## Prompt bootstrap

`loopwright init` only scaffolds low-level controller drafts; it does not inspect your repository. To run an interview-first setup or migrate an existing automatic synchronized workflow, paste this prompt into your coding agent inside the target repository:

```text
Read https://docs.gpustack.ai/loopwright/llms.txt and its Bootstrap Interview Reference (https://docs.gpustack.ai/loopwright/references/bootstrap-interview.md). Inspect this repository first WITHOUT editing any files yet, then interview me one question at a time with repository-grounded defaults to agree on which modules to automate or exclude, domain boundaries, update cadence, version/promotion holds, bounded host preflight -> offline sandbox -> independent verifier design, model pool (LOOPWRIGHT_PROVIDER_TOKEN), and workflow panel. Wait for my approval on the design summary before generating Loopwright config (apiVersion: loopwright.dev/v1alpha1) and running dry-run verification.
```

The agent scans your repository first, interviews you one question at a time with repository-grounded defaults, waits for summary approval, and then writes taskpacks (plus a `TaskpackSuite` manifest for multi-domain repos), bounded preflight/verifier hooks, and workflows.

## Step 1: Author taskpack

Create `.auto-sync/taskpack.yaml` in the target repository. Loopwright derives `.auto-sync` as the control root.

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
  instructions: # Optional
    - .auto-sync/prompts/instructions.md
  upstreams:
    - id: engine
      kind: github-release
      source: octocat/engine
      watchedPaths:
        - docs
      allowPrerelease: false # Optional (defaults to false)
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
          script: .auto-sync/checks/verify.sh
          timeoutSeconds: 30 # Optional
    externalGates: [] # Optional remote gate checks
  publication:
    mode: pull_request
    targetBranch: main
    headBranchPrefix: loopwright-docs-
    titleTemplate: "docs - sync upstream documentation"
  memory:
    directory: .auto-sync/memory/docs-sync
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
    commentPrefixes: # Optional (defaults to ['/loopwright'])
      - /loopwright
  models: # Optional ordered model pool
    - provider: zai
      id: glm-5.3
      thinking: high # Optional
      apiKeyEnv: ZAI_API_KEY # Optional
    - provider: zai-coding-cn # Optional fallback candidate
      id: glm-5.3
      thinking: high # Optional
      apiKeyEnv: ZAI_CODING_CN_API_KEY # Optional
  output: # Optional
    formats:
      - json
      - github-step-summary
  decisions: # Optional live System-One triage policy
    enabled: true
    provider: typesafe-jev # Optional
    disclosurePolicy: public-metadata-only # Optional
    minConfidence: 0.8 # Optional
    confirmThreshold: 0.6 # Optional
    hardDeadlineMs: 5000 # Optional
    maxAttempts: 1 # Optional
    allowImages: false # Optional
```

- **Field dictionary**: Inspect every field, bound, and enum in [Taskpack](/loopwright/0.0/docs/configuration/taskpack/index.md).
- **Concise local manifests**: Local CLI runs (`loopwright run --taskpack` and `loopwright step`) can omit `triggers`, `publication` (defaults to `disabled`), and `memory` (defaults to `disabled`).
- **Explicit scopes**: Write `docs/**` for recursive directories and exact paths (or single-segment `*`/`?` globs) for files. Local runs protect `.git` and `<controlRoot>` by default without hardcoded tool directories; declare extra protected paths in `scope.protected`.
- **Inputs**: Create instruction files, `preflight.script`, and `command.v1` scripts under protected paths before running. When configuring `spec.proposal.path`, place it inside a writable path with a `.yaml`, `.yml`, or `.json` extension.
- **Secrets**: Never place tokens or ambient `${ENV}` templates inside `taskpack.yaml`; use `spec.vars` only for non-secret static values.

### Delegated role DAG

Add roles and optional `spec.steps` to the taskpack from Step 1. This example runs a read-only review after the author:

```yaml
apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: example
spec:
  roles:
    - id: author
      provider: example
      model: author-model
    - id: review
      purpose: review
      provider: example
      model: review-model
      tools: [read]
      dependsOn: [author]
```

Merge these roles into the complete taskpack above; this excerpt omits its other required fields. Run the local delegated loop without Loopwright provider secrets:

```sh
loopwright step next --taskpack .loopwright/taskpack.yaml --repo . --run-root ../runs --run-id demo-1 --json
loopwright step submit --run-root ../runs --run-id demo-1 --lease TOKEN --status completed --json
```

Work in the yielded candidate directory and obey its allowed tools. Repeat until the run settles. See [CLI](/loopwright/0.0/docs/operations/cli/index.md) for leases and [Taskpack](/loopwright/0.0/docs/configuration/taskpack/index.md#roles-and-steps) for role and step bounds.

## Step 2: Validate taskpack

Verify your host meets the [runtime baseline](/loopwright/0.0/docs/getting-started/architecture/index.md#runtime-baseline), sync `digests.lock.json` when `pinDigests: true`, and validate or execute locally via `@loopwright/taskpack` before enabling GitHub Actions:

```sh
loopwright digest sync --taskpack .loopwright/taskpack.yaml --repo .
loopwright digest sync --taskpack .loopwright/taskpack.yaml --repo . --check --json
loopwright run --taskpack .loopwright/taskpack.yaml --repo . --dry-run --json
loopwright run --taskpack .loopwright/taskpack.yaml --repo . --run-root ../runs --run-id demo-1 --json
```

Run `loopwright run --taskpack ... --dry-run` locally or run the GitHub Action with `dry-run: 'true'` in a pull request workflow to validate the manifest, verify `digests.lock.json`, negotiate sandbox capabilities, and compile artifacts without invoking preflight, model providers, or branch pushes.

## Step 3: Configure workflow

Add `.github/workflows/loopwright.yml` to your repository to run on `schedule`, `workflow_dispatch`, or `/loopwright` issue comments with `mode: auto`:

```yaml
name: Loopwright Sync
on:
  schedule:
    - cron: '0 4 * * *'
  workflow_dispatch:
  issue_comment:
    types: [created]

permissions:
  contents: read

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/create-github-app-token@v1 # Optional when minting App PR tokens
        id: app-token
        with:
          app-id: ${{ secrets.LOOPWRIGHT_APP_ID }}
          private-key: ${{ secrets.LOOPWRIGHT_APP_PRIVATE_KEY }}
      - uses: gpustack/loopwright@main
        with:
          taskpack-path: .auto-sync/taskpack.yaml # Optional custom control root
          mode: auto # Optional (candidate or check-only no-change via preflight)
          github-token: ${{ steps.app-token.outputs.token }}
          event-name: ${{ github.event_name }} # Optional (defaults to GITHUB_EVENT_NAME)
          event-path: ${{ github.event_path }} # Optional for schedule/manual; needed on comments
          dry-run: 'false' # Optional (defaults to 'false')
        env:
          ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }} # Optional in dry-run mode
          LOOPWRIGHT_GATE_SIGNING_SECRET: ${{ secrets.LOOPWRIGHT_GATE_SIGNING_SECRET }} # Optional when externalGates is empty
```

- **Action inputs and secrets**: Review every input, output, and secret variable in [GitHub Action](/loopwright/0.0/docs/operations/github-action/index.md).
- **Centralized webhook server**: Deploy a multi-repository intake server via [GitHub App](/loopwright/0.0/docs/operations/github-app/index.md).

### Bootstrap provenance

Enforce two provenance rules in comment-driven and self-upgrading workflows:

- **Trusted checkout**: Check out `ref: refs/heads/main` with `persist-credentials: false`, pass explicit `event-name` and `event-path`, and gate `issue_comment` jobs to `/loopwright` pull-request comments from `OWNER`, `MEMBER`, or `COLLABORATOR` actors. Fetch `+refs/pull/<number>/head` into `.git/objects` without checking out unreviewed pull-request heads.
- **Commit SHA pinning**: Pin every third-party Action and the bootstrap `gpustack/loopwright` revision to full 40-character commit SHAs instead of `uses: ./` when Loopwright upgrades itself, so candidate branches cannot replace control-plane code or `command.v1` verification scripts.

## Step 4: Review outcomes

Reports include total tokens, with input and output breakdowns. Cost appears in human-readable summaries only when reported or estimated.

1. **Candidate pull request**: When upstream changes require edits and every check passes, Loopwright opens or updates a head-pinned pull request matching `headBranchPrefix`.
2. **Verified no-change**: When preflight or upstream discovery reports `no_change` under `mode: auto`, Loopwright runs check-only `no-change.v1` verification without invoking agent models.
3. **Slash-command iteration**: Collaborators with write access comment `/loopwright status`, `/loopwright retry`, or `/loopwright revise` on managed issues or pull requests.
4. **Reviewed memory**: Active entries live under `.loopwright/memory/<name>`. Separate PRs skip non-passing runs (`publishOnFailure: false`) and add `[skip ci]` (`skipCi: true`). Use `local-only` or `disabled` without blocking task completion.

---

**See also** — [Taskpack](/loopwright/0.0/docs/configuration/taskpack/index.md) (every `Taskpack` field and enum) · [Managed Controller](/loopwright/0.0/docs/walkthroughs/managed-controller/index.md) (fine-grained out-of-repo contract and registry workflow)

**Next** → [GitHub Action](/loopwright/0.0/docs/operations/github-action/index.md) — configure Action inputs, permissions, and secrets.
