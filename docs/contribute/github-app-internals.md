# GitHub App Control Plane Internals

The GitHub App accepts authenticated events and queues repository work by tenant. Operators use the control plane to compile taskpacks and lease work with scoped installation tokens.

## Contents

- [Module map](#module-map)
- [Declarative taskpack onboarding](#declarative-taskpack-onboarding)
- [OS sandbox backends](#os-sandbox-backends)
- [Reusable Action entrypoint](#reusable-action-entrypoint)
- [Control plane](#control-plane)
- [Offline testing](#offline-testing)

## Module map

Generic declarative `Taskpack` execution lives in `@loopwright/taskpack` (`packages/taskpack/src/`), while `@loopwright/github-app` owns GitHub intake, webhook control plane, and PR publication (re-exporting `@loopwright/taskpack` APIs and `TaskpackError as GitHubAppError` for `instanceof` compatibility):

| Module | Responsibility |
| --- | --- |
| `taskpack/src/types.ts` | Generic manifest, sandbox, preflight, and error types (`TaskpackError`) |
| `taskpack/src/schema.ts` | Bounded YAML 1.2 parser, `spec.vars` AST interpolator, policy-scoped `Taskpack` validator |
| `taskpack/src/taskpack.ts` | `loadDeclarativeTaskpack`, `compileDeclarativeTaskpack`, advisory decision wiring |
| `taskpack/src/sandbox.ts` | Native macOS Seatbelt, Linux Bubblewrap/Landlock compilers, capability negotiation |
| `taskpack/src/preflight.ts` | Post-auth host preflight runner and CoW / `1 MiB` streaming workspace staging |
| `taskpack/src/upstreams.ts` | Generic upstream discovery (`http-json`, `git-tag`, `git-commit`, `github-release`, `custom-table`) |
| `taskpack/src/turnkey.ts` | Local HMAC `command.v1` CAS gate, hybrid `mountReadOnlyGit`, and local turnkey cycle |
| `taskpack/src/qualification.ts` | Deployment host qualification and interactive MCP OAuth refusal |
| `github-app/src/webhook.ts` | Constant-time HMAC-SHA256 verification, `WebhookDeliveryStore`, pre-preflight trigger intake |
| `github-app/src/tenant-queue.ts` | `TenantAdmissionQueue`: tenant partitioning, concurrency 1, lease-epoch fencing |
| `github-app/src/token-broker.ts` | RS256 App JWTs and `InstallationTokenBroker` paired with `taskpack` `SecretScrubber` |
| `github-app/src/action.ts` | `runGitHubActionEntrypoint` (`policyProfile: 'github'`) and `INPUT_*` CLI shim |
| `github-app/src/publisher.ts` | Single-fd `1 MiB` streaming CAS PR publisher with 3-way carry and conflict guards |
| `github-app/src/suite-pr-lookup.ts` | Authenticated `issue_comment` PR branch ownership and same-repo verification |
| `github-app/src/turnkey-memory.ts` | Post-settlement `separate-pull-request` and `inline-with-candidate` CAS memory publication |
| `github-app/src/service.ts` | `startGitHubAppControlPlane` loopback HTTP receiver, suite routing, and `MULTI_TENANT_HOST_POLICY` |

Repository CI/CD runs from `.github/workflows/`. Configure consumer workflows separately and review the [Action limits](../operations/github-action.md).

## Declarative taskpack onboarding

A target repository declares its update surface in `.loopwright/taskpack.yaml`:

```yaml
apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: docs-sync
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
```

The loader enforces hard invariants before compilation under `'local'` (default in `@loopwright/taskpack`) or `'github'` (`@loopwright/github-app` entrypoints) policy profiles:

- Manifests use bounded (`65536`-byte) `O_NOFOLLOW` reads; symlinks, `..` traversal, `__proto__`/`constructor`/`prototype` keys, and undeclared `${...}` expressions fail closed.
- Under `'local'`, built-in protection covers `.git` and `<controlRoot>` (preserving the exact-file `spec.proposal.path` carve-out) plus manifest scripts, instructions, skills, lockfiles, and repository-declared `spec.scope.protected`; `triggers`, `publication`, and `memory` are optional.
- Under `'github'`, `.github` is protected by default (unlocking `.github/workflows/**` requires dual-key `allowWorkflowWrites`), `spec.triggers` validates events before `spec.preflight` or queue admission, and `hostPolicy` persists in `run.json` across recovery.
- Omitted writable scope defaults to `**`; protected paths override writable ancestors. Memory stays under `<controlRoot>/memory`.

`compileDeclarativeTaskpack` combines the manifest with trusted host bindings into a `TrustedRegistry` and
`ControllerConfiguration` that pass `@loopwright/core` `validateDocument` and `@loopwright/controller`
`loadTrustedConfiguration` + `compilePlan`. Signing secrets appear only as `${NAME}` templates resolved
from explicitly bound environment variables.

## OS sandbox backends

`packages/taskpack/src/sandbox.ts` provides kernel-enforced OS sandbox execution backends (`macos-seatbelt`, `linux-bwrap`,
`linux-landlock`, `docker`, and `direct-dedicated`) with fail-closed capability negotiation:

- **macOS Seatbelt (`macos-seatbelt`)**: `compileMacosSeatbeltProfile` canonicalizes paths with `realpath` and denies sensitive credential directories, including `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.config/gh`, and `deniedReadPaths`.
- **Seatbelt writes**: The profile denies writes globally, then grants writes to canonicalized `writablePaths` and scratch directories.
- **Seatbelt masks**: Built-in masks protect `.git` and `<controlRoot>` locally (adding `.github` on `'github'` profile) plus manifest `scope.protected`, without hardcoded tool directories. Overrides follow writable grants so last-match-wins precedence blocks writes inside writable roots.
- **Linux Bubblewrap (`linux-bwrap`)**: `compileLinuxBwrapCommand` applies namespace isolation, a read-only root, credential masks, writable binds, protected-path masks, `readOnlyBindMounts`, and the `computeSandboxSeccompProfile` syscall filter.
- **Linux Landlock (`linux-landlock`)**: Without unprivileged user namespaces or `bwrap`, Landlock enforces `PR_SET_NO_NEW_PRIVS`, `O_NOFOLLOW` `LANDLOCK_RULE_PATH_BENEATH` rules, and seccomp metadata/socket filters, declining policies with exclusions nested inside writable directories.
- **Fail-closed negotiation (`negotiateSandboxBackend`)**: refuses missing or untrusted binaries
  (`SANDBOX_BACKEND_UNAVAILABLE`) and backends that lack required isolation capabilities
  (`SANDBOX_CAPABILITY_INSUFFICIENT`); `direct-dedicated` is refused unless
  `allowDedicatedDirectOverride: true` is supplied. GitHub-hosted Actions runners enable it for an omitted sandbox policy.

## Reusable Action entrypoint

The root `action.yml` exposes the reusable entrypoint. The `.github/workflows/` directory runs Loopwright repository CI/CD.
A target repository wires it like this:

```yaml
name: loopwright
on:
  schedule:
    - cron: '0 3 * * *'
  workflow_dispatch: {}
permissions:
  contents: read
jobs:
  taskpack:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: gpustack/loopwright@main
        with:
          taskpack-path: .loopwright/taskpack.yaml
          mode: candidate
          event-name: schedule
          storage-profile: actions-basic
          dry-run: 'true'
        env:
          LOOPWRIGHT_PROVIDER_TOKEN: ${{ secrets.LOOPWRIGHT_PROVIDER_TOKEN }}
          LOOPWRIGHT_GATE_SIGNING_SECRET: ${{ secrets.LOOPWRIGHT_GATE_SIGNING_SECRET }}
          LOOPWRIGHT_PUBLICATION_SIGNING_SECRET: ${{ secrets.LOOPWRIGHT_PUBLICATION_SIGNING_SECRET }}
```

For live execution, `runActionCli` discovers upstreams and wires the turnkey delegate. See [GitHub Action](../operations/github-action.md) for inputs and qualification limits.

`packages/taskpack/src/turnkey.ts` runs `command.v1` through a loopback HMAC gate, resolving canonical `cas://sha256/<hex>` blobs under `<artifactsDir>/blobs/sha256/<hex>` and projecting them via single-descriptor `1 MiB` streaming (`O_NOFOLLOW`, `nlink === 1`, SHA-256 verified). Hybrid `mountReadOnlyGit` stages a sanitized `.git` skeleton (excluding `config`, `credentials`, and `hooks`) with `--ro-bind` (Linux `bwrap`/`docker`) or read-only `1 MiB` streaming (Seatbelt/Landlock) for `.git/objects`.

`packages/github-app/src/publisher.ts` builds commits with a temporary `GIT_INDEX_FILE`.
It consumes shared 3-way merged carry blobs (`ensureCarryBlobsInGitObjectStore`) and enforces extracted baseline conflict resolution (`verifyCandidateBaselinePrePublication`, `hasBaselineConflictResource`).

It opens each CAS blob once (`O_RDONLY | O_NOFOLLOW`, `nlink === 1`), verifies SHA-256 in `1 MiB` chunks, and commits via `read-tree`, `update-index`, `write-tree`, and `commit-tree`.
Publication uses `--force-with-lease`; the cycle uses `openPiHostSessionAdapterV2` and `output-format.ts` emits reports (`pr-url`, `memory-pr-url`).

Before authoring, `compileDeclarativeTaskpack` runs `selectActiveMemory` on `spec.memory.directory`.
Non-empty snapshots bound or omit the `0o400` `document` resource and `<active_memory>` excerpt within model request limits.

After settlement, `turnkey-memory.ts` runs `finalizeRunMemory` and `applyMemoryProposalCAS` in a scratch clone.
When `publication.mode` is `pull_request`, verified proposals claim a per-run `memory-publication.json` receipt, push with `--force-with-lease`, and sign off commits.
Squash or rebase merges resolve current entries first, while uncertain mutations stay `reconcile_required` without changing `RunResult`.

`runGitHubActionEntrypoint` qualifies the deployment host first (platform/arch allowlist, qualified 26.x Node runtime, non-network filesystem, clock drift within 1000ms, an exclusive fsync-plus-rename storage probe, and storage-profile budget rules), refuses interactive MCP authentication, evaluates trigger intake, compiles, and writes the registry and configuration into a trusted directory outside the checkout with `untrustedRoots: [<checkout>]`.

Every compiled artifact passes `assertCleanArtifact` before the run delegate (or dry run) sees it.

## Control plane

Intake checks the webhook signature before event processing. Comment commands use `/loopwright retry`, `/loopwright revise`, or `/loopwright status`; actor association or an operator allowlist controls admission.

| Stage | Boundary |
| --- | --- |
| Signature | Verify raw request bytes before parsing. |
| Admission | Check event, command, actor association, and guidance. |
| Queue | Deduplicate deliveries and fence tenant leases. |
| Token | Mint a short-lived installation token for one repository. |

`loadGitHubAppConfig` validates operator configuration and can resolve named environment secrets. `loadDeclarativeTaskpack` loads the repository manifest, and `compileDeclarativeTaskpack` combines it with trusted host bindings. `serializePrettyYaml` emits readable YAML for compiled documents.


`createGitHubRestTokenTransport` provides the GitHub REST token transport. `startConfiguredGitHubApp` starts the configured service only when `spec.listen.enabled === true`.

`startGitHubAppControlPlane` binds loopback-only HTTP, supports single-taskpack (`manifest` / `taskpackPath`) or multi-domain `TaskpackSuite` (`suite` / `suitePath`, mutually exclusive) routing, and serves:

- `POST /webhooks/github` — verifies `X-Hub-Signature-256` with `crypto.timingSafeEqual` over raw bytes, deduplicates `X-GitHub-Delivery` across multi-domain suite fan-out, runs `verifySuiteCommentPullRequest` on `issue_comment` events to enforce same-repo PR ownership, and enqueues actionable triggers.
- `POST /tenants/:installationId/:repositoryId/:taskpackId/lease` — leases the next pending item with a monotonic `leaseEpoch`, per-domain manifest SHA-256 binding, suite-wide mandatory protected union enforcement, and a single-repository `'read_only'` installation token.
- `POST /tenants/:installationId/:repositoryId/:taskpackId/settle` — settles the leased item
  (`completed`, `failed`, `blocked`, `reconcile_required`) and updates the delivery store.
- `GET /healthz` — `{ ok: true }` with queue and delivery summary counts.

Every response body passes the secret scrubber. `InstallationTokenBroker` mints tokens with
`repository_ids` pinned to the single tenant repository, carries only the `'read_only'` or
`'publish_pull_request'` permission profiles, refreshes within `refreshMarginMs`, and registers every
minted token with the scrubber in raw, JSON-escaped, URL-encoded, and base64 forms.

## Offline testing

All behavior is deterministic offline: webhook signatures use a shared test secret, App JWTs use
`generateKeyPairSync` RSA keypairs, installation-token transports are mock or loopback, and the queue runs
on injected monotonic clock samples. Run the suites with:

```bash
npm --workspace @loopwright/github-app test
npm test
```


---

**See also** — [GitHub App](../operations/github-app.md) (deployment and configuration)

**Next** → [Capability Closure Matrix and Failure Semantics](closure-matrix.md) — inspect capability evidence and failure outcomes.
