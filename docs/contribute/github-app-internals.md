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

| Module | Responsibility |
| --- | --- |
| `src/types.ts` | Public interfaces, closed error-code union, `GitHubAppError` |
| `src/schema.ts` | Bounded YAML-subset/JSON parser and the `TaskpackManifest` validator |
| `src/taskpack.ts` | `loadDeclarativeTaskpack`, `compileDeclarativeTaskpack`, generic intake helpers |
| `src/sandbox.ts` | Native macOS Seatbelt, Linux Bubblewrap/Landlock compilers, capability negotiation, and execution |
| `src/webhook.ts` | Constant-time HMAC-SHA256 verification, `WebhookDeliveryStore`, event/comment intake |
| `src/tenant-queue.ts` | `TenantAdmissionQueue`: tenant partitioning, concurrency 1, lease-epoch fencing |
| `src/token-broker.ts` | RS256 App JWTs, `InstallationTokenBroker`, multi-encoding `SecretScrubber` |
| `src/qualification.ts` | Deployment host qualification and interactive MCP OAuth refusal |
| `src/action.ts` | `runGitHubActionEntrypoint` and the `INPUT_*` CLI shim |
| `src/upstreams.ts` | Native upstream discovery and GitHub token resolution |
| `src/turnkey.ts` | Local HMAC command gate, detached worktree publisher, and host-session cycle delegate |
| `src/output-format.ts` | Action output sinks and step outputs |
| `src/service.ts` | `startGitHubAppControlPlane` loopback HTTP receiver and queue dispatcher |

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

The loader enforces the hard invariants before anything compiles:

- Manifests are read with a bounded (`65536`-byte) `O_NOFOLLOW` file read; symlinks, `..` traversal,
  `__proto__`/`constructor`/`prototype` keys, and any `${...}` interpolation expression are refused.
- Effective protected paths include the control root, manifest, instructions, scripts, `.github`, `.claude`, `.agents`, `AGENTS.md`, and `CLAUDE.md`.
- Omitted writable scope defaults to `**`; protected paths take precedence over writable ancestors.
- The proposal must be writable. Memory must stay under the control root's `memory` directory.

`compileDeclarativeTaskpack` combines the manifest with trusted host bindings into a `TrustedRegistry` and
`ControllerConfiguration` that pass `@loopwright/core` `validateDocument` and `@loopwright/controller`
`loadTrustedConfiguration` + `compilePlan`. Signing secrets appear only as `${NAME}` templates resolved
from explicitly bound environment variables.

## OS sandbox backends

`src/sandbox.ts` provides kernel-enforced OS sandbox execution backends (`macos-seatbelt`, `linux-bwrap`,
`linux-landlock`, `docker`, and `direct-dedicated`) with fail-closed capability negotiation:

- **macOS Seatbelt (`macos-seatbelt`)**: `compileMacosSeatbeltProfile` canonicalizes paths with `realpath` and denies sensitive credential directories, including `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.config/gh`, and `deniedReadPaths`.
- **Seatbelt writes**: The profile denies writes globally, then grants writes to canonicalized `writablePaths` and scratch directories.
- **Seatbelt masks**: Protected paths include `.git`, `.github`, `.loopwright`, `.claude`, `.agents`, `AGENTS.md`, `CLAUDE.md`, and manifest `scope.protected`. Overrides follow writable grants, so last-match-wins precedence blocks modifications inside writable roots.
- **Linux Bubblewrap (`linux-bwrap`)**: `compileLinuxBwrapCommand` applies namespace isolation, a read-only root, credential masks, writable binds, protected-path masks, and the `computeSandboxSeccompProfile` syscall filter.
- **Linux Landlock (`linux-landlock`)**: Without unprivileged user namespaces or `bwrap`, Landlock enforces `PR_SET_NO_NEW_PRIVS` and `LANDLOCK_RULE_PATH_BENEATH` rules through recursive tree-splitting.
- **Fail-closed negotiation (`negotiateSandboxBackend`)**: refuses missing or untrusted binaries
  (`SANDBOX_BACKEND_UNAVAILABLE`) and backends that lack required isolation capabilities
  (`SANDBOX_CAPABILITY_INSUFFICIENT`); `direct-dedicated` is refused unless
  `allowDedicatedDirectOverride: true` is supplied. Actions enable it for an omitted sandbox policy.

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

`turnkey.ts` runs `command.v1` through a loopback HMAC gate and verifies script and candidate digests.
It publishes from a detached `git worktree` with `--force-with-lease` and uses `openPiHostSessionAdapterV2` for the cycle.
The local command runs on the host, not in an OS sandbox.
`output-format.ts` writes configured reports and Action step outputs.

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

`startGitHubAppControlPlane` binds loopback-only HTTP and serves:

- `POST /webhooks/github` — verifies `X-Hub-Signature-256` with `crypto.timingSafeEqual` over the raw
  bytes, deduplicates `X-GitHub-Delivery` (failed deliveries retry on redelivery, payload mismatches fail
  closed), parses comment and review commands for authorized actors, and enqueues actionable triggers.
- `POST /tenants/:installationId/:repositoryId/:taskpackId/lease` — leases the next pending item with a
  monotonic `leaseEpoch` plus a single-repository `'read_only'` installation token.
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
