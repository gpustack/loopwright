# GitHub App control plane, reusable Action entrypoint, and declarative taskpacks

`@loopwright/github-app` is the control-plane and declarative-onboarding layer of Loopwright. It lets a target
repository adopt Loopwright through a `.loopwright/taskpack.yaml` manifest, drives runs through a reusable
GitHub Action or CLI entrypoint, and operates a loopback HTTP control plane with webhook admission,
tenant-isolated queueing, and short-lived installation tokens.

## Module map

| Module | Responsibility |
| --- | --- |
| `src/types.ts` | Public interfaces, closed error-code union, `GitHubAppError` |
| `src/schema.ts` | Bounded YAML-subset/JSON parser and the `TaskpackManifest` validator |
| `src/taskpack.ts` | `loadDeclarativeTaskpack`, `compileDeclarativeTaskpack`, generic intake helpers |
| `src/webhook.ts` | Constant-time HMAC-SHA256 verification, `WebhookDeliveryStore`, event/comment intake |
| `src/tenant-queue.ts` | `TenantAdmissionQueue`: tenant partitioning, concurrency 1, lease-epoch fencing |
| `src/token-broker.ts` | RS256 App JWTs, `InstallationTokenBroker`, multi-encoding `SecretScrubber` |
| `src/qualification.ts` | Deployment host qualification and interactive MCP OAuth refusal |
| `src/action.ts` | `runGitHubActionEntrypoint` and the `INPUT_*` CLI shim |
| `src/service.ts` | `startGitHubAppControlPlane` loopback HTTP receiver and queue dispatcher |

The package uses Node.js built-in modules plus workspace packages only; it adds no third-party runtime
dependency, and it never registers `.github/workflows/` files in this repository.

## Declarative taskpack onboarding

A target repository declares its update surface in `.loopwright/taskpack.yaml`:

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
```

The loader enforces the hard invariants before anything compiles:

- Manifests are read with a bounded (`65536`-byte) `O_NOFOLLOW` file read; symlinks, `..` traversal,
  `__proto__`/`constructor`/`prototype` keys, and any `${...}` interpolation expression are refused.
- The effective protected scope always contains `.github`, `.loopwright/policies`, `AGENTS.md`, and
  `CLAUDE.md`; a writable path that overlaps that set fails with `TASKPACK_SCOPE_VIOLATION`.
- The proposal path must live inside the writable scope, and the memory directory must stay under
  `.loopwright/memory/<id>` and disjoint from the writable scope.

`compileDeclarativeTaskpack` combines the manifest with trusted host bindings into a `TrustedRegistry` and
`ControllerConfiguration` that pass `@loopwright/core` `validateDocument` and `@loopwright/controller`
`loadTrustedConfiguration` + `compilePlan`. Signing secrets appear only as `${NAME}` templates resolved
from explicitly bound environment variables.

## Reusable Action entrypoint

The root `action.yml` exposes the entrypoint at repository root — never under `.github/workflows/`.
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
      - uses: loopwright/loopwright@main
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

`runGitHubActionEntrypoint` qualifies the deployment host first (platform/arch allowlist, qualified 26.x
Node runtime, non-network filesystem, clock drift within 1000ms, an exclusive fsync-plus-rename storage
probe, and storage-profile budget rules), refuses interactive MCP authentication, evaluates trigger intake,
compiles, and writes the registry and configuration into a trusted directory outside the checkout with
`untrustedRoots: [<checkout>]`. Every compiled artifact passes `assertCleanArtifact` before the run
delegate (or dry run) sees it.

## Control plane

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
