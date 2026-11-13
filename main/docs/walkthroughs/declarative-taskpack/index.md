# Declarative Taskpack

Declarative taskpack mode is Loopwright's simple automated workflow for repository maintainers. Author one `.loopwright/taskpack.yaml` file in your repository, and the GitHub Action or App compiles contracts, handler digests, and registry bindings automatically.

For strict separation between task authors and platform-owned `TrustedRegistry` files, custom multi-step DAGs, or local CLI execution, follow [Managed Controller](/loopwright/main/docs/walkthroughs/managed-controller/index.md) instead.

## Contents

- [Overview](#overview)
- [Prompt bootstrap](#prompt-bootstrap)
- [Step 1: Author taskpack](#step-1-author-taskpack)
- [Step 2: Validate taskpack](#step-2-validate-taskpack)
- [Step 3: Configure workflow](#step-3-configure-workflow)
- [Step 4: Review outcomes](#step-4-review-outcomes)

## Overview

![Declarative taskpack flow](/loopwright/main/docs/assets/diagrams/taskpack-sync-flow.svg)

<!-- flowchart LR
  Watch["01 Watch upstream"] -> Compile["02 Auto-compile taskpack"] -> Verify["03 Verify checks"] -> Publish["04 Publish PR"]
-->

Declarative taskpack mode eliminates manual boilerplate while preserving every Loopwright safety boundary:

| Responsibility | Authored in taskpack | Compiled by Loopwright |
| --- | --- | --- |
| Work scope | Optionally declare `writable` and `protected` paths | Adds control paths and built-in masks; protected paths take precedence |
| Execution | Declare `upstreams` and `proposal` artifact | Compiles `TaskContract`, `ControllerConfig`, and `TrustedRegistry` (`0600`) |
| Digests | None required | Computes SHA-256 digests for installed handlers and `package-lock.json` |
| Secrets | Pass GitHub Secrets to Action or App env | Generates scoped `${ENV}` credential bindings and scrubs logs |
| Settlement | Choose `pull_request` or `disabled` | Opens head-pinned PRs or settles verified `no_change` runs |

## Prompt bootstrap

`loopwright init` only scaffolds low-level controller drafts; it does not inspect your repository. To initialize `.loopwright/taskpack.yaml` from scratch or migrate an existing automatic synchronized workflow, paste this prompt into your coding agent inside the target repository:

```text
Read https://docs.gpustack.ai/loopwright/llms.txt and follow the Markdown links for Declarative Taskpack, Taskpack, and GitHub Action. Inspect this repository (especially existing automatic synchronized workflows, scripts, version manifests, and docs/config directories), ask me to confirm any ambiguous upstream sources, writable/protected scope, or checks, and generate .loopwright/taskpack.yaml plus .github/workflows/loopwright.yml using apiVersion: loopwright.dev/v1alpha1.
```

Through normal back-and-forth conversation, the agent reads the live Loopwright specification from `llms.txt`, maps your existing sync logic into `upstreams`, `scope`, `proposal`, and `verification`, and tells you which GitHub Secrets to configure.

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
  scope: # Optional
    protected:
      - docs/protected-notes.md
  instructions: # Optional
    - .auto-sync/prompts/instructions.md
  upstreams:
    - id: engine
      kind: github-release
      source: octocat/engine
      watchedPaths:
        - docs
      allowPrerelease: false # Optional (defaults to false)
  proposal:
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
  decisions: # Optional System-One triage policy
    enabled: true
    provider: typesafe-jev # Optional
    disclosurePolicy: public-metadata-only # Optional
    minConfidence: 0.8 # Optional
    confirmThreshold: 0.6 # Optional
    hardDeadlineMs: 5000 # Optional
    maxAttempts: 1 # Optional
    allowImages: false # Optional
```

- **Field dictionary**: Inspect every field, bound, and enum in [Taskpack](/loopwright/main/docs/configuration/taskpack/index.md).
- **Scope**: Omitted `writable` permits `**`, except effective protected paths. Protected paths always win.
- **Inputs**: Create the instruction file and verification script before running. Loopwright pins and protects both files.
- **Proposal**: The proposal must be writable and end in `.yaml`, `.yml`, or `.json`.
- **Secrets**: Never place tokens or `${ENV}` templates inside `taskpack.yaml`; the parser rejects untrusted interpolation.

## Step 2: Validate taskpack

Verify your host meets the [runtime baseline](/loopwright/main/docs/getting-started/architecture/index.md#runtime-baseline), then test compilation in dry-run mode before enabling live mutations.

Run the GitHub Action with `dry-run: 'true'` in a pull request workflow, or call `loadDeclarativeTaskpack` and `compileDeclarativeTaskpack` in a local check script. Dry-run mode validates the manifest, negotiates sandbox capabilities, and compiles `config.yaml` and `registry.yaml` without invoking model providers or pushing branches.

## Step 3: Configure workflow

Add `.github/workflows/loopwright.yml` to your repository to run on `schedule`, `workflow_dispatch`, or `/loopwright` issue comments:

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
          github-token: ${{ steps.app-token.outputs.token }}
          event-name: ${{ github.event_name }} # Optional (defaults to GITHUB_EVENT_NAME)
          event-path: ${{ github.event_path }} # Optional for schedule/manual; needed on comments
          dry-run: 'false' # Optional (defaults to 'false')
        env:
          ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }} # Optional in dry-run mode
          LOOPWRIGHT_GATE_SIGNING_SECRET: ${{ secrets.LOOPWRIGHT_GATE_SIGNING_SECRET }} # Optional when externalGates is empty
```

- **Action inputs and secrets**: Review every input, output, and secret variable in [GitHub Action](/loopwright/main/docs/operations/github-action/index.md).
- **Centralized webhook server**: Deploy a multi-repository intake server via [GitHub App](/loopwright/main/docs/operations/github-app/index.md).

## Step 4: Review outcomes

Reports include total tokens, with input and output breakdowns. Cost appears in human-readable summaries only when reported or estimated.

1. **Candidate pull request**: When upstream changes require edits and every check passes, Loopwright opens or updates a head-pinned pull request matching `headBranchPrefix`.
2. **Verified no-change**: When no update is needed, the compiled `no-change.v1` check verifies an untouched tree and settles cleanly without opening an empty PR.
3. **Slash-command iteration**: Collaborators with write access comment `/loopwright status`, `/loopwright retry`, or `/loopwright revise` on managed issues or pull requests.
4. **Reviewed memory**: Memory proposals target `.loopwright/memory/<name>` via a separate pull request so candidate diffs never self-approve retained memory.

---

**See also** — [Taskpack](/loopwright/main/docs/configuration/taskpack/index.md) (every `Taskpack` field and enum) · [Managed Controller](/loopwright/main/docs/walkthroughs/managed-controller/index.md) (fine-grained out-of-repo contract and registry workflow)

**Next** → [GitHub Action](/loopwright/main/docs/operations/github-action/index.md) — configure Action inputs, permissions, and secrets.
