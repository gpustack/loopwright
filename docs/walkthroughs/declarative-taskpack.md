# Declarative Taskpack Walkthrough

A declarative taskpack describes a repository update surface and its verification. Trusted host bindings supply credentials and execution authority separately.

## Contents

- [Step 1: Author the manifest](#step-1-author-the-manifest)
- [Step 2: Validate locally](#step-2-validate-locally)
- [Step 3: Wire a trigger](#step-3-wire-a-trigger)
- [Step 4: Review and audit](#step-4-review-and-audit)

## Step 1: Author the manifest

```yaml
apiVersion: loopwright.dev/v1alpha1
kind: TaskpackManifest
metadata:
  id: docs-sync
  name: Documentation sync
  version: '1.0.0'
spec:
  goal:
    candidate: Refresh documentation from upstream sources and pass every local check.
    noChange: Confirm the documentation needs no change and settle as no change.
  scope:
    writable:
      - docs
    protected:
      - docs/protected-notes.md
  upstreams:
    - id: engine
      kind: github-release
      source: octocat/engine
      watchedPaths:
        - docs
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
    externalGates: []
  publication:
    mode: pull_request
    targetBranch: main
    headBranchPrefix: loopwright-docs-
    titleTemplate: 'docs: sync upstream documentation'
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
  sandbox:
    preferredBackends:
      - macos-seatbelt
      - linux-bwrap
      - linux-landlock
      - docker
    networkMode: none
    requiredCapabilities:
      - filesystemReadContainment
      - filesystemWriteContainment
      - protectedPathReadOnlyMask
      - networkIsolation
      - processTreeCleanup
    deniedReadPaths:
      - ~/.ssh
```

- Save this as `.loopwright/taskpack.yaml` in the target repository.
- Writable scope cannot overlap protected paths; proposal paths must stay writable and memory must stay under `.loopwright/memory/<id>` outside writable scope.
- Optional `spec.sandbox` pins preferred OS sandbox backends (`macos-seatbelt`, `linux-bwrap`, `linux-landlock`, `docker`, `direct-dedicated`), `networkMode` (`none`, `loopback-only`, `allow-outbound`), `requiredCapabilities`, and `deniedReadPaths`.
- The bounded parser refuses symlinks, traversal, unsafe keys and interpolation.

## Step 2: Validate locally

The declared Action runtime currently fails host qualification; compile using `loadDeclarativeTaskpack` and `compileDeclarativeTaskpack` with trusted host bindings. For generated trusted registry/configuration use `loopwright check` and `loopwright run --dry-run`; see [CLI operations](../operate/cli.md). A dry-run does not invoke the controller delegate.

## Step 3: Wire a trigger

Review the [consumer workflow limitations](../operate/github-action.md) or deploy the [App](../operate/github-app.md). Configure authorized comment commands and schedule in the manifest, provision external gate/publication services and secrets in the trusted host, and review the output and receipts.

## Step 4: Review and audit

Optional [System-One routing](../decisions.md) supports seven provider configurations and remains advisory under deterministic authority gates. [Reviewed memory](../memory.md) is applied separately with compare-and-swap after review. Run `loopwright closure --verify-failures` and inspect each capability disposition; external gaps remain gaps.

**See also**: [Taskpack reference](../github-app.md)

**Next**: [Closure matrix](../closure-matrix.md)
