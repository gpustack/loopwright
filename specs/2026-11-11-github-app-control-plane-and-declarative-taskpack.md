# Spec: GitHub App control plane, reusable Action entrypoint, and declarative taskpacks

Status: Shipped
Type: Feature

## Summary

Add a private `@loopwright/github-app` workspace package (`packages/github-app`), a root `action.yml` reusable GitHub
Action metadata entrypoint, and architecture documentation (`docs/github-app.md`) that together provide:
(1) a repository-agnostic declarative `.loopwright/taskpack.yaml` manifest schema, loader, compiler, and generic intake
primitives so target repositories can adopt Loopwright through configuration without copying Loopwright code;
(2) an authenticated GitHub App webhook receiver with constant-time HMAC-SHA256 verification, delivery replay and
failed-redelivery deduplication, and authorized pull-request comment command parsing;
(3) a tenant-isolated per-repository and per-taskpack concurrency queue with monotonic lease epochs and installation
revocation fencing;
(4) a short-lived GitHub App installation token broker with RS256 JWT signing, repository/permission scoping, and
multi-encoding secret scrubbing; and
(5) explicit deployment host clock/storage qualification and interactive MCP OAuth refusal guards.

## Motivation

### Goals

`@loopwright/core`, `@loopwright/state`, `@loopwright/agent-pi`, `@loopwright/controller`, `@loopwright/cli`,
`@loopwright/taskpack-runner`, and `@loopwright/memory` establish the local task-execution and memory lifecycle:

1. Immutable `TaskContract` and `TaskLock` documents bind target repositories, base and source revisions, writable and
   protected scopes, pinned `trustedContext.resources`, budgets, and required acceptance checks
   ([`packages/core/src/contracts.ts`](../packages/core/src/contracts.ts),
   [`packages/core/src/identity.ts`](../packages/core/src/identity.ts)).
2. `LocalRunStore` enforces single-writer lease epochs, monotonic and wall-clock drift checks (`<= 1000ms`), and
   intent-before-dispatch operation journals ([`packages/state/src/clock.ts`](../packages/state/src/clock.ts),
   [`packages/state/src/store.ts`](../packages/state/src/store.ts)).
3. `@loopwright/controller` loads trusted host configurations outside untrusted repository roots, interpolates `${NAME}`
   environment variables once into a `CredentialVault`, executes bounded repair and external gate/publication protocols,
   and refuses interactive MCP authentication ([`packages/controller/src/config.ts`](../packages/controller/src/config.ts),
   [`packages/controller/src/credentials.ts`](../packages/controller/src/credentials.ts),
   [`packages/controller/src/gate.ts`](../packages/controller/src/gate.ts),
   [`packages/controller/src/publication.ts`](../packages/controller/src/publication.ts)).
4. `@loopwright/taskpack-runner` compiles Runner synchronization cycles and validates comment guidance and Actions diagnostic
   URLs ([`packages/taskpack-runner/src/compile-taskpack.ts`](../packages/taskpack-runner/src/compile-taskpack.ts),
   [`packages/taskpack-runner/src/intake.ts`](../packages/taskpack-runner/src/intake.ts)), while `@loopwright/memory`
   manages post-run reviewed memory proposals and compare-and-swap (CAS) updates
   ([`packages/memory/src/index.ts`](../packages/memory/src/index.ts)).

However, onboarding multiple repositories and operating unattended in GitHub Actions or a multi-repository GitHub App
service requires a dedicated control-plane and declarative onboarding layer:

- **Declarative `.loopwright/taskpack.yaml` onboarding and repository-agnostic intake**: Target repositories need to
  declare their update goals, watched upstream sources, writable and protected path scopes, proposal artifact rules,
  verification gates, publication settings, and memory directory in a declarative `.loopwright/taskpack.yaml` (or
  `.json`) manifest without copying Loopwright orchestrator code or embedding repository-specific Python scripts inside
  Loopwright. At the same time, untrusted repository manifests must never override protected automation paths
  (`.github`, `.loopwright/policies`, `AGENTS.md`, `CLAUDE.md`), inject arbitrary shell handlers, or expand host
  environment variables.
- **Reusable GitHub Action entrypoint without repository CI workflows**: External repositories need a root `action.yml`
  entrypoint (and programmatic runner) that accepts injected runtime, model, and credential bindings from the calling
  workflow, loads the target repository's `.loopwright/taskpack.yaml`, compiles the `TrustedRegistry` and
  `ControllerConfiguration` in a trusted temporary directory outside `untrustedRoots`, and invokes the controller cycle
  while keeping zero `.github/workflows/` files inside Loopwright's own repository.
- **Webhook authentication, delivery deduplication, and authorized command intake**: A GitHub App receiver must verify
  `X-Hub-Signature-256` over raw request bytes using constant-time comparison, deduplicate `X-GitHub-Delivery` IDs
  while distinguishing already-succeeded or in-flight deliveries from failed deliveries that GitHub redelivers for
  retry, and parse pull-request comment commands (`/loopwright retry|revise|status`) only from authorized maintainers
  or collaborators (`OWNER`, `MEMBER`, `COLLABORATOR`, or an explicit operator allowlist) with strict guidance bounds.
- **Tenant isolation and per-repository / per-taskpack concurrency queueing**: Multi-repository installations must
  partition all queue state, leases, run directories, and receipts by `(installationId, repositoryId, repositoryFullName, taskpackId)`.
  Each `(repositoryFullName, taskpackId)` concurrency group must allow at most one active cycle and a bounded pending
  queue (default `100`), coalesce redundant pending schedule/discovery triggers for the same base revision while
  preserving distinct `revise` command bindings, enforce monotonic `leaseEpoch` fencing across worker renewals, and
  immediately fence active leases and cancel pending items when an installation or repository grant is revoked.
- **Short-lived installation token broker and zero token persistence**: GitHub App installation access tokens expire
  within one hour and must be minted on demand via RS256 App JWTs, scoped to the single target repository and minimum
  required permissions (read-only for discovery/validation; pull-request write only at the publication boundary),
  refreshed before expiry, and scrubbed in raw, JSON-escaped, URL-encoded, and base64-encoded forms so installation
  tokens and private keys never enter `TaskContract`, `TaskLock`, `LocalRunStore`, `RunResult` bundles, `MemoryProposal`
  artifacts, or logs.
- **Qualified host clock/storage profile and explicit MCP OAuth refusal**: Before admitting a GitHub Action or GitHub
  App worker run, the control plane must verify that the deployment host's OS/architecture, Node runtime, local POSIX
  filesystem semantics, and monotonic clock drift (`<= 1000ms`) match an explicitly qualified profile, refuse
  `actions-basic` automatic host-loss budget resets (`STORAGE_PROFILE_INSUFFICIENT`), and reject interactive MCP OAuth
  configurations or runtime challenges (`MCP_OAUTH_UNSUPPORTED` / `MCP_AUTHENTICATION_REQUIRED`) with no browser spawn
  or anonymous fallback.

### Non-Goals

- Adding any `.github/workflows/` CI/CD workflow files to the Loopwright repository.
- Registering or deploying a live GitHub App, provisioning cloud queues, or calling live `api.github.com` endpoints
  during offline unit and integration tests.
- Implementing interactive browser-based or device-code MCP OAuth sign-in, callback listeners, or background refresh-token
  stores.
- Deleting `vendor/runner-auto-sync` or modifying `@loopwright/taskpack-runner` parity suites in this specification
  (repository decoupling of legacy vendor assets occurs in the dedicated closure and target-repository migration
  specifications after these generic primitives land).

## Proposal

Introduce `@loopwright/github-app` (`packages/github-app`), root `action.yml`, and `docs/github-app.md`. All components
operate deterministically offline against local filesystem fixtures, synthetic RS256 keypairs, and loopback HTTP
servers.

### User Stories

#### Story 1
As a target repository maintainer, I want to declare my repository's update scope, upstream sources, verification
gates, and publication settings in `.loopwright/taskpack.yaml` and invoke Loopwright via a reusable GitHub Action or
CLI entrypoint, so that I can adopt Loopwright through configuration without copying orchestrator code into my
repository.

#### Story 2
As a GitHub App operator, I want every incoming GitHub webhook verified with constant-time HMAC-SHA256, deduplicated by
`X-GitHub-Delivery` with retry support for failed deliveries, and restricted to authorized maintainer comment commands,
so that forged, replayed, or unauthorized pull-request comments cannot trigger runs or override task contracts.

#### Story 3
As a multi-repository platform operator, I want strict tenant isolation, per-repository/per-taskpack concurrency
queueing with monotonic lease epochs, short-lived repository-scoped installation tokens that never persist to artifacts
or logs, and fail-closed host/storage/OAuth qualification checks, so that one repository or installation can never
access another tenant's state, leak credentials, or silently reset budgets after host loss.

### Core Features & Acceptance Criteria

#### Feature 1 — Declarative `.loopwright/taskpack.yaml` Schema, Loader, Compiler, and Generic Intake (`AC-1`)
- Define `TaskpackManifest` (`apiVersion: 'loopwright.dev/v1alpha1'`, `kind: 'TaskpackManifest'`) with strict validation:
  - `metadata`: `{ id: string, name: string, version: string }` (`id` matches `^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$`,
    length `<= 64`).
  - `spec.goal`: `{ candidate: string, noChange: string }` (each non-empty, `<= 1024` chars).
  - `spec.scope`: `{ writable: readonly string[], protected: readonly string[] }` (normalized relative paths; must
    always include `.github`, `.loopwright/policies`, `AGENTS.md`, and `CLAUDE.md` in the effective `protected` set and
    reject any manifest where a `writable` path overlaps or is nested inside an effective `protected` path with
    `TASKPACK_SCOPE_VIOLATION`).
  - `spec.upstreams`: `readonly TaskpackUpstreamDescriptor[]` (`1..32` entries), each with
    `{ id: string, kind: 'github-release' | 'git-tag' | 'git-commit' | 'http-json' | 'custom-table', source: string, watchedPaths: readonly string[], allowPrerelease?: boolean }`.
  - `spec.proposal`: `{ path: string, requiredFields: readonly string[], schemaVersion: number }` (`path` must be a
    relative path inside `spec.scope.writable`).
  - `spec.verification`:
    - `localChecks`: `readonly { id: string, implementation: 'json-artifact.v1' | 'scope.v1' | 'no-change.v1', parameters?: Readonly<Record<string, unknown>> }[]`
    - `externalGates`: `readonly { id: string, gateId: string, endpointId: string, required: boolean }[]`
  - `spec.publication`: `{ mode: 'pull_request' | 'disabled', targetBranch: string, headBranchPrefix: string, titleTemplate: string }`.
  - `spec.memory`: `{ directory: string, apply: 'separate-pull-request', onNoModelBudget: 'deterministic-observations-only' }`
    (`directory` must be under `.loopwright/memory/<id>` and disjoint from `spec.scope.writable`).
  - `spec.triggers`: `{ schedule: boolean, workflowDispatch: boolean, releasePublished: boolean, commentCommands: readonly ('retry' | 'revise' | 'status')[], commentPrefixes?: readonly string[] }`
    (default `commentPrefixes: ['/loopwright']`).
- `loadDeclarativeTaskpack(input)`:
  - Reads `.loopwright/taskpack.yaml` (or `.yml` / `.json`) up to `65536` bytes with `O_NOFOLLOW` when loaded from disk,
    rejecting symlinks, `..` traversal, prototype-pollution keys (`__proto__`, `constructor`, `prototype`), and any
    `${...}` environment interpolation expression inside untrusted repository manifest strings (`TASKPACK_UNTRUSTED_INTERPOLATION`).
- `compileDeclarativeTaskpack(manifest, hostBindings)`:
  - Combines the validated `TaskpackManifest` with trusted host-injected `HostTaskpackBindings` (`mode: 'candidate' | 'no-change'`,
    `repository`, `baseRevision`, `sourceRevision`, `targetMatrix`, `roleSelection`, `runtimeOptions`, `budgets`,
    `gateEndpoints`, `publicationEndpoint`, `credentialEnvMap`) to produce `{ registry: TrustedRegistry, config: ControllerConfiguration, registrySha256: string, registryBytes: Buffer }`
    that passes `@loopwright/core` `validateDocument(..., 'TaskContract')` and `@loopwright/controller`
    `loadTrustedConfiguration` + `compilePlan`.
- Generic repository-agnostic intake primitives (`prepareTaskpackIntake`, `validateCommentGuidance`,
  `authorizeRepositoryActor`, `parseActionsRunUrl`, `boundDiagnosticLog`):
  - Provide pure, deterministic TypeScript intake evaluation for `discover` (over declarative upstream version records
    and acquisition statuses), `revise` (actor authorization + guidance line/byte/sentinel/prefix validation +
    command digest binding), `run-url` (same-repository GitHub Actions URL validation + 4000-char sentinel-scrubbed tail),
    and `status` queries without invoking any repository-specific Python bridge.

#### Feature 2 — GitHub App Webhook Verification, Delivery Deduplication, and Event Intake (`AC-2`)
- `verifyWebhookSignature(rawBody, signatureHeader, secret)`:
  - Enforces `rawBody.byteLength <= 1048576` (`WEBHOOK_PAYLOAD_TOO_LARGE`), requires a `sha256=<64-hex>` header and
    non-empty secret, computes HMAC-SHA256 over the exact `rawBody` bytes, and compares digests with
    `crypto.timingSafeEqual`, returning `{ ok: true, payloadDigest }` or `{ ok: false, code: 'WEBHOOK_SIGNATURE_INVALID' | 'WEBHOOK_PAYLOAD_TOO_LARGE' }`.
- `WebhookDeliveryStore` (`recordDelivery`, `markDeliveryState`, `getDelivery`):
  - Keyed by `deliveryId` (`X-GitHub-Delivery`, matching `^[A-Za-z0-9-]{8,128}$`).
  - Tracks `{ deliveryId, eventName, payloadDigest, installationId, repositoryFullName, receivedAtMs, updatedAtMs, state: 'accepted' | 'processing' | 'succeeded' | 'failed', failureReason: string | null, attemptCount: number }`.
  - If `deliveryId` already exists with the same `payloadDigest` and `state` in `'accepted' | 'processing' | 'succeeded'`,
    returns `{ kind: 'duplicate', state, entry }` (idempotent 2XX acknowledgement without re-enqueueing).
  - If `deliveryId` already exists with a different `payloadDigest`, fails closed with `WEBHOOK_DELIVERY_CONFLICT`.
  - If `deliveryId` exists with `state === 'failed'` and the identical `payloadDigest`, transitions `state` back to
    `'accepted'`, increments `attemptCount`, and returns `{ kind: 'retry_failed', entry }` so transient queue/worker
    failures are not permanently dropped on GitHub redelivery.
- `intakeWebhookDelivery(input, deliveryStore)`:
  - Verifies signature first (before JSON parsing), checks delivery deduplication, parses and validates structured
    GitHub events (`issue_comment.created` on pull requests only, `pull_request_review.submitted`, `release.published`,
    `schedule`, `workflow_dispatch`, `repository_dispatch`, `installation.suspend` / `installation.deleted` /
    `installation_repositories.removed`), and enforces `parseCommentCommand` + `authorizeRepositoryActor` +
    `validateCommentGuidance` for comment/review events.
  - Plain issue comments (without a `pull_request` object), edited or deleted comments, bot-authored comments
    (`user.type === 'Bot'`), and free-text comments without a configured command prefix (`/loopwright ...`) are
    classified as `{ kind: 'ignored', reason }` without error or queue admission.
  - Comments with a command prefix from an unauthorized actor (`NONE`, `FIRST_TIME_CONTRIBUTOR`, `CONTRIBUTOR` not in
    allowlist) or with invalid guidance return `{ kind: 'rejected', code: 'WEBHOOK_ACTOR_UNAUTHORIZED' | 'WEBHOOK_GUIDANCE_INVALID' }`.

#### Feature 3 — Tenant Isolation Boundary and Per-Repository / Per-Taskpack Queue (`AC-3`)
- `TenantIdentity`: `{ installationId: number, repositoryId: number, repositoryFullName: string, taskpackId: string }`
  where `repositoryFullName` matches `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`.
- `TenantAdmissionQueue`:
  - Enforces strict tenant partitioning: every queue operation (`enqueue`, `leaseNext`, `renewLease`, `settleLease`,
    `inspectTenantQueue`, `resolveTenantRunPaths`) validates the full `TenantIdentity`. Any attempt to access, lease,
    renew, settle, or reference a `queueItemId`, `runId`, or artifact path belonging to a different
    `installationId`, `repositoryId`, `repositoryFullName`, or `taskpackId` fails closed with
    `TENANT_BOUNDARY_VIOLATION`.
  - Enforces per-`(repositoryFullName, taskpackId)` concurrency:
    - At most `1` item in `state === 'leased'` (`running`) per `(repositoryFullName, taskpackId)` group at a time.
    - At most `maxPendingPerGroup` (default `100`, configurable `1..100`) items in `state === 'pending'` per group;
      exceeding the cap fails closed with `QUEUE_CAPACITY_EXCEEDED`.
    - Coalesces redundant pending `discover` / `schedule` items for the same `(tenant, baseRevision)` into the existing
      pending item (`coalesced: true`), while keeping `revise` items with distinct `(commandId, headSha, commandDigest)`
      separate.
  - Monotonic `leaseEpoch` fencing:
    - Each `leaseNext(tenant, workerId, nowSample)` increments a store-wide monotonic `leaseEpoch` integer (`1, 2, ...`)
      and binds `notAfterMonotonicMs = nowSample.monotonicMs + leaseDurationMs`.
    - `renewLease` and `settleLease` require the exact current `leaseEpoch` and `workerId` and verify clock validity via
      `@loopwright/state` `clockValid`; a stale `leaseEpoch` fails closed with `QUEUE_LEASE_FENCED`.
    - If a lease expires (`nowSample.monotonicMs >= notAfterMonotonicMs`) before settlement, the item transitions to
      `state === 'reconcile_required'` (or is only re-leasable after explicit `reconcileExpiredLease` records whether
      external effects were `not_executed` vs `reconcile_required`), preventing silent duplicate execution.
  - Installation and repository revocation (`revokeTenantScope`):
    - On `installation.suspend`, `installation.deleted`, or `installation_repositories.removed`, marks the affected
      tenant scope revoked, transitions all `pending` items for that scope to `cancelled` (`reason: 'installation_revoked'`),
      and fences any active `leased` item so subsequent `renewLease` or `settleLease` with publication effects is
      refused with `TENANT_INSTALLATION_REVOKED`.

#### Feature 4 — Short-Lived Installation Token Broker and Secret Scrubbing (`AC-4`)
- `createGitHubAppJwt({ appId, privateKeyPem, nowSeconds })`:
  - Signs an RS256 JWT (`alg: 'RS256'`, `typ: 'JWT'`) with `iss: String(appId)`, `iat: nowSeconds - 60`, and
    `exp: nowSeconds + 540` (`<= 600` seconds) using `node:crypto` (`createSign('RSA-SHA256')`), rejecting invalid PEM
    keys or non-positive `appId` values with `TOKEN_BROKER_CONFIG_INVALID`.
- `InstallationTokenBroker`:
  - Mints short-lived installation tokens via an injectable `InstallationTokenTransport` port (defaulting to an HTTPS
    client for `POST /app/installations/:installationId/access_tokens`, tested offline with deterministic mock/loopback
    transports).
  - Enforces least-privilege repository and permission scoping on every mint request:
    - Must bind `repository_ids: [tenant.repositoryId]` (single-repository scope; wildcard or multi-repository tokens
      are rejected with `TOKEN_SCOPE_VIOLATION`).
    - Supports two explicit permission profiles:
      1. `'read_only'`: `{ contents: 'read', metadata: 'read' }` for discovery, checkout, and validation.
      2. `'publish_pull_request'`: `{ contents: 'write', pull_requests: 'write', metadata: 'read' }` restricted strictly
         to the verified publication boundary.
      Requesting broader permissions (such as `administration`, `workflows`, `secrets`, or `organization_*`) is refused
      with `TOKEN_SCOPE_VIOLATION`.
  - Enforces TTL and automatic rotation: tokens with TTL `> 3600` seconds or already within `refreshMarginMs` (default
    `300_000` ms / 5 minutes) of `expiresAtMs` are rejected or refreshed on demand; `revokeInstallationTokens(installationId)`
    immediately evicts all cached tokens for that installation.
  - Secret scrubbing and non-persistence (`scrubSecrets(textOrObject)`, `assertCleanArtifact(value)`):
    - Tracks every minted installation token and the App private key (raw, JSON-escaped, URL-encoded, and base64-encoded
      forms, plus generic `ghs_[A-Za-z0-9]{20,}`, `ghu_[A-Za-z0-9]{20,}`, `github_pat_[A-Za-z0-9_]{20,}`, and PEM
      private key headers).
    - `assertCleanArtifact(value)` throws `TOKEN_SECRET_LEAK_DETECTED` if any tracked credential form appears in a
      serialized `TaskContract`, `TaskLock`, checkpoint, `RunResult`, `MemoryProposal`, queue snapshot, or event log.

#### Feature 5 — Deployment Host Clock/Storage Qualification and Interactive MCP OAuth Refusal (`AC-5`)
- `qualifyDeploymentHostProfile(input)`:
  - Evaluates `{ platform, arch, nodeVersion, filesystemType, storageProfile, clockBasis, previousClockSample, currentClockSample, hasVerifiedCheckpointLedger, autoResumeOnHostLossRequested, probeDirectory }`:
    - Verifies `(platform, arch)` is in the qualified deployment allowlist (`darwin/arm64`, `linux/arm64`, `linux/x64`),
      `nodeVersion` matches `^v?26\.`, and `filesystemType` is not an unqualified network or pseudo-filesystem
      (`nfs`, `smb`, `cifs`, `fuse`, `sshfs`, `webdav`, `tmpfs-ephemeral-unverified`); otherwise returns
      `{ ok: false, code: 'HOST_PROFILE_UNQUALIFIED', reason }`.
    - Verifies clock continuity via `@loopwright/state` `clockValid(clockBasis, previousClockSample, currentClockSample)`
      (`<= 1000ms` adjacent and cumulative drift); on drift or backward clock jump, returns
      `{ ok: false, code: 'HOST_CLOCK_UNTRUSTED', reason }`.
    - When `probeDirectory` is supplied, performs a bounded `O_CREAT | O_EXCL | O_NOFOLLOW` lockfile creation, fsync,
      and atomic `rename` probe in `probeDirectory` and removes the probe file before returning.
    - Enforces storage profile capabilities (`storageProfile: 'actions-basic' | 'durable'`):
      - If `storageProfile === 'actions-basic'` and `autoResumeOnHostLossRequested === true`, or if resuming after an
        interrupted run when `hasVerifiedCheckpointLedger === false`, returns
        `{ ok: false, code: 'STORAGE_PROFILE_INSUFFICIENT', recommendedRunStatus: 'reconcile_required', reason }` so an
        `actions-basic` runner never silently restarts a cycle with a fresh full budget.
- `validateMcpAuthConfiguration(input)`:
  - Inspects MCP server configurations and runtime transport challenges.
  - If any server declares interactive or OAuth authentication (`auth.type === 'oauth' | 'oauth2' | 'browser' | 'device_code' | 'interactive'`),
    or if a runtime MCP response returns an interactive authentication challenge (`status === 401 | 403` with
    `WWW-Authenticate` containing `Bearer` / `OAuth` / `authorization_uri`), fails closed immediately with
    `{ ok: false, code: 'MCP_OAUTH_UNSUPPORTED' | 'MCP_AUTHENTICATION_REQUIRED', reason }`, performing zero browser
    launches, zero loopback HTTP listeners, and zero anonymous retry fallbacks.

#### Feature 6 — Reusable GitHub Action Entrypoint (`action.yml`) and Local Control-Plane Service (`AC-6`)
- Root `action.yml` metadata file:
  - Declares a reusable GitHub Action (`name: 'Loopwright Taskpack Action'`, `runs.using: 'node20'` or composite wrapper
    invoking the built CLI/entrypoint, **outside** `.github/workflows/` so zero CI workflows exist in Loopwright's
    repository) with explicit inputs: `taskpack-path` (default `.loopwright/taskpack.yaml`), `mode`, `event-name`,
    `event-path`, `run-root`, `run-id`, `storage-profile` (default `actions-basic`), `provider`, `model`, `thinking`,
    and endpoint URLs.
- `runGitHubActionEntrypoint(input)`:
  - Orchestrates a complete offline-testable Action execution flow:
    1. Runs `qualifyDeploymentHostProfile` and `validateMcpAuthConfiguration`.
    2. Loads and validates `.loopwright/taskpack.yaml` from the target repository (`loadDeclarativeTaskpack`).
    3. Evaluates trigger/event intake (`prepareTaskpackIntake` or `intakeWebhookDelivery`).
    4. Writes the compiled `TrustedRegistry` and `ControllerConfiguration` into a trusted directory outside the target
       repository checkout (`untrustedRoots: [repositoryRoot]`), verifies `assertCleanArtifact`, and returns the
       structured `ActionEntrypointResult` (with optional delegate hook to execute or dry-run `@loopwright/controller`).
- `startGitHubAppControlPlane(options)`:
  - Starts a bounded loopback HTTP server (`127.0.0.1`, ephemeral port `0` supported) exposing:
    - `POST /webhooks/github`: verifies `X-Hub-Signature-256`, records `X-GitHub-Delivery` in `WebhookDeliveryStore`,
      handles installation revocation events or enqueues actionable triggers into `TenantAdmissionQueue`, and responds
      with structured JSON and `assertCleanArtifact` scrubbing.
    - `POST /tenants/:installationId/:repositoryId/:taskpackId/lease`: leases the next pending item for that tenant with
      a monotonic `leaseEpoch` and a scoped `'read_only'` installation token from `InstallationTokenBroker`.
    - `POST /tenants/:installationId/:repositoryId/:taskpackId/settle`: validates `leaseEpoch`, settles the leased queue
      item (`completed`, `failed`, `blocked`, or `reconcile_required`), and updates `WebhookDeliveryStore`.
    - `GET /healthz`: returns `{ ok: true }` with queue and delivery summary counts.

### Notes / Constraints / Caveats

- **Zero `.github/workflows/` files**: The Loopwright repository must never contain `.github/workflows/` CI files.
  The reusable GitHub Action definition lives at root `action.yml` and in `packages/github-app`, and any workflow
  examples for target repositories are documented as fenced YAML blocks inside `docs/github-app.md`.
- **No external runtime dependencies**: Implement YAML subset / JSON parsing, HMAC-SHA256 webhook verification, RS256
  JWT signing, and loopback HTTP serving using Node.js `26.13.0` built-in modules (`node:crypto`, `node:http`,
  `node:fs/promises`, `node:path`) plus existing workspace packages (`@loopwright/core`, `@loopwright/state`,
  `@loopwright/agent-pi`, `@loopwright/controller`, `@loopwright/memory`).
- **Deterministic offline testing**: All webhook signatures, RS256 App JWTs, installation token exchanges, tenant
  queues, and Action entrypoint runs must be tested deterministically offline using generated RSA keypairs and loopback
  HTTP servers with zero external network calls.

### Boundaries

- **Always:**
  - Verify `X-Hub-Signature-256` with `crypto.timingSafeEqual` over raw request bytes before parsing webhook JSON.
  - Partition all queue items, leases, and run directories by `(installationId, repositoryId, repositoryFullName, taskpackId)`.
  - Enforce default protected paths (`.github`, `.loopwright/policies`, `AGENTS.md`, `CLAUDE.md`) and reject any
    `.loopwright/taskpack.yaml` that attempts to make protected paths writable or interpolate `${...}` host variables.
  - Scrub installation tokens and private keys in raw, JSON-escaped, URL-encoded, and base64-encoded forms before
    persisting any artifact, checkpoint, or log.
  - Keep `packages/github-app/src/` filenames in descriptive `kebab-case` without specification or task number prefixes.
- **Ask first:**
  - Changing public exports or wire schemas of `@loopwright/core`, `@loopwright/state`, `@loopwright/agent-pi`, or
    `@loopwright/controller`.
  - Adding third-party npm dependencies to `package.json`.
- **Never:**
  - Add `.github/workflows/` files or modify `.gitignore` exceptions.
  - Make live network calls to `api.github.com` or external endpoints in tests.
  - Persist GitHub App private keys or short-lived installation access tokens into `TaskContract`, `TaskLock`,
    `LocalRunStore`, `RunResult`, or `MemoryProposal` artifacts.
  - Allow `actions-basic` storage profile to silently reset budgets on host-loss recovery without a verified ledger.

### Risks and Mitigations

- **Risk: Untrusted `.loopwright/taskpack.yaml` in a target repository attempts to escalate privileges by adding `.github/**` to `scope.writable` or embedding `${SECRET}` interpolation.** ->
  **Mitigation:** `loadDeclarativeTaskpack` rejects any `${...}` syntax in repository manifests with
  `TASKPACK_UNTRUSTED_INTERPOLATION` and enforces that the union of built-in protected paths (`.github`,
  `.loopwright/policies`, `AGENTS.md`, `CLAUDE.md`) and manifest-declared protected paths never overlaps `scope.writable`
  (`TASKPACK_SCOPE_VIOLATION`).
- **Risk: Transient worker or queue failure causes a webhook delivery to be permanently ignored when GitHub redelivers the same `X-GitHub-Delivery` GUID.** ->
  **Mitigation:** `WebhookDeliveryStore` distinguishes `'accepted' | 'processing' | 'succeeded'` from `'failed'`.
  Redeliveries of `'failed'` records with an identical `payloadDigest` transition back to `'accepted'` and increment
  `attemptCount`, while payload mismatches fail closed with `WEBHOOK_DELIVERY_CONFLICT`.
- **Risk: Stale worker whose lease expired attempts to publish a pull request or overwrite queue settlement after another worker took over.** ->
  **Mitigation:** `TenantAdmissionQueue` assigns a strictly increasing `leaseEpoch` on every lease acquisition and
  requires the matching `leaseEpoch` and valid monotonic clock sample on every renewal and settlement (`QUEUE_LEASE_FENCED`).
  Expired leases enter `reconcile_required` rather than immediately re-running side effects.
- **Risk: Short-lived installation token leaks into an error message, event log, or artifact bundle.** ->
  **Mitigation:** `InstallationTokenBroker` registers every minted token and private key in raw, JSON-escaped,
  URL-encoded, and base64-encoded forms and enforces `assertCleanArtifact` across all control-plane responses and
  compiled configurations.

## Design Details

### Commands

```bash
npm run build
npm run typecheck
npm run lint
npm --workspace @loopwright/github-app test
npm test
```

### Project Structure

```text
action.yml                                # Reusable GitHub Action metadata entrypoint (outside .github/workflows/)
packages/github-app/
  package.json                            # @loopwright/github-app workspace package manifest
  tsconfig.json                           # TypeScript build configuration extending root tsconfig.json
  src/
    types.ts                              # Public interfaces, error codes, and diagnostic types
    schema.ts                             # Bounded YAML/JSON parser and TaskpackManifest validator
    taskpack.ts                           # loadDeclarativeTaskpack, compileDeclarativeTaskpack, generic intake helpers
    webhook.ts                            # Constant-time HMAC-SHA256 verifier, WebhookDeliveryStore, event/comment intake
    tenant-queue.ts                       # TenantAdmissionQueue, concurrency groups, leaseEpoch fencing, revocation
    token-broker.ts                       # RS256 App JWT signer, InstallationTokenBroker, multi-encoding secret scrubber
    qualification.ts                      # qualifyDeploymentHostProfile and validateMcpAuthConfiguration
    action.ts                             # runGitHubActionEntrypoint for target repository CI / CLI execution
    service.ts                            # startGitHubAppControlPlane loopback HTTP receiver and queue dispatcher
    index.ts                              # Public barrel exports for @loopwright/github-app
  test/
    taskpack-intake.test.ts               # Declarative taskpack.yaml loading, scope/interpolation guards, compilation, intake
    webhook-delivery.test.ts              # HMAC-SHA256 timing-safe verification, replay/redelivery states, comment commands
    tenant-queue.test.ts                  # Tenant isolation, concurrency=1, pending cap=100, coalescing, leaseEpoch, revocation
    token-broker-qualification.test.ts    # RS256 JWT, scoped tokens, secret scrubbing, host qualification, MCP OAuth refusal
    control-plane-action.test.ts          # End-to-end loopback HTTP control plane and reusable GitHub Action entrypoint
docs/
  github-app.md                           # Architecture documentation and target-repository onboarding examples
```

### Code Style

Follow the workspace's strict TypeScript conventions (`ES2023`, `NodeNext`, `strict: true`, `exactOptionalPropertyTypes: true`,
`noUncheckedIndexedAccess: true`):

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';

export const MAX_WEBHOOK_BODY_BYTES = 1_048_576;

export type WebhookSignatureVerification =
  | { readonly ok: true; readonly payloadDigest: string }
  | { readonly ok: false; readonly code: 'WEBHOOK_SIGNATURE_INVALID' | 'WEBHOOK_PAYLOAD_TOO_LARGE'; readonly detail: string };

export function verifyWebhookSignature(
  rawBody: Uint8Array,
  signatureHeader: string | undefined,
  secret: string,
): WebhookSignatureVerification {
  if (rawBody.byteLength > MAX_WEBHOOK_BODY_BYTES) {
    return { ok: false, code: 'WEBHOOK_PAYLOAD_TOO_LARGE', detail: `webhook body exceeds ${MAX_WEBHOOK_BODY_BYTES} bytes` };
  }
  if (!secret || typeof signatureHeader !== 'string' || !/^sha256=[0-9a-f]{64}$/.test(signatureHeader)) {
    return { ok: false, code: 'WEBHOOK_SIGNATURE_INVALID', detail: 'missing or malformed X-Hub-Signature-256 header' };
  }
  const expectedHex = createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(`sha256=${expectedHex}`, 'utf8');
  const actualBuf = Buffer.from(signatureHeader, 'utf8');
  if (expectedBuf.byteLength !== actualBuf.byteLength || !timingSafeEqual(expectedBuf, actualBuf)) {
    return { ok: false, code: 'WEBHOOK_SIGNATURE_INVALID', detail: 'webhook HMAC-SHA256 signature mismatch' };
  }
  return { ok: true, payloadDigest: expectedHex };
}
```

### Implementation Plan

Task DAG for `@loopwright/github-app`, root `action.yml`, and `docs/github-app.md`. T1 wires the workspace and
lands the type and schema skeleton, then leaves the full suite green as the first checkpoint. T2, T4, and T5 run
in parallel on disjoint `Owns:` sets. T3 follows T2 because its comment intake consumes the generic guidance and
actor helpers from `src/taskpack.ts`. T6 integrates every component into the Action entrypoint, loopback control
plane, and documentation, and is the release checkpoint. No task changes the public exports or wire schemas of
`@loopwright/core`, `@loopwright/state`, `@loopwright/agent-pi`, or `@loopwright/controller`; every task consumes
them as workspace dependencies. Every task adds zero third-party runtime dependencies. T1 carries `Gate: review`
because it edits the shared root workspace manifests every package builds through.

- [x] **T1 · Workspace wiring, manifest types, and bounded schema validator**
      Blocked by: None
      Owns: `package.json`, `tsconfig.test.json`, `packages/github-app/package.json`, `packages/github-app/tsconfig.json`, `packages/github-app/src/types.ts`, `packages/github-app/src/schema.ts`
      Gate: review
      Acceptance: `@loopwright/github-app` joins the root `workspaces` array with a private manifest matching
      `@loopwright/memory` conventions (`type: 'module'`, `engines.node` `26.13.0`, `exports` to `dist/`,
      `pretest`/`test` scripts), a `tsconfig.json` extending the root strict options, and root `build`, `test`, and
      `tsconfig.test.json` wiring covering the new package. `src/types.ts` exports every public interface and result
      shape, the closed error-code unions named across Features 1–5, and a `GitHubAppError` class following the
      `RunnerTaskpackError` convention. `src/schema.ts` exports the bounded YAML-subset/JSON parser (`65536`-byte
      cap, duplicate-key and depth limits, no external dependency) and the `TaskpackManifest` validator enforcing
      every Feature 1 constraint: `apiVersion: 'loopwright.dev/v1alpha1'`, `kind: 'TaskpackManifest'`, metadata `id`
      pattern and length, goal bounds, upstreams `1..32`, the effective protected union (`.github`,
      `.loopwright/policies`, `AGENTS.md`, `CLAUDE.md`), writable/protected overlap refusal, proposal path inside
      `writable`, memory directory under `.loopwright/memory/<id>` disjoint from `writable`, and `commentPrefixes`
      defaulting to `['/loopwright']`.
      Verify: `npm run build && npm run typecheck && npm run lint && npm test`

- [x] **T2 · Declarative taskpack loader, compiler, and generic intake helpers**
      Blocked by: T1
      Owns: `packages/github-app/src/taskpack.ts`, `packages/github-app/test/taskpack-intake.test.ts`
      Acceptance: `loadDeclarativeTaskpack` reads `.loopwright/taskpack.yaml` / `.yml` / `.json` through the bounded
      parser with `O_NOFOLLOW`, refusing symlinks, `..` traversal, `__proto__` / `constructor` / `prototype` keys,
      oversized input, and any `${...}` interpolation (`TASKPACK_UNTRUSTED_INTERPOLATION`).
      `compileDeclarativeTaskpack(manifest, hostBindings)` emits `{ registry, config, registrySha256, registryBytes }`
      from `HostTaskpackBindings` (`mode: 'candidate' | 'no-change'`, `repository`, `baseRevision`, `sourceRevision`,
      `targetMatrix`, `roleSelection`, `runtimeOptions`, `budgets`, `gateEndpoints`, `publicationEndpoint`,
      `credentialEnvMap`) such that `validateDocument(..., 'TaskContract')` passes and `loadTrustedConfiguration` +
      `compilePlan` accept the emitted pair against registry bytes in a trusted directory outside the fixture
      checkout. `prepareTaskpackIntake`, `validateCommentGuidance`, `authorizeRepositoryActor`,
      `parseActionsRunUrl`, and `boundDiagnosticLog` evaluate `discover`, `revise`, `run-url`, and `status`
      dispositions purely and deterministically over declarative upstream records, with guidance line/byte/sentinel/prefix
      bounds mirroring `@loopwright/taskpack-runner` intake constants, `OWNER`/`MEMBER`/`COLLABORATOR`-or-allowlist
      authorization, same-repository Actions run-URL validation, and the `4000`-character sentinel-scrubbed
      diagnostic tail, with no Python bridge.
      Verify: `npm --workspace @loopwright/github-app test && npm run typecheck && npm test`

- [x] **T3 · Webhook verification, delivery deduplication, and command intake**
      Blocked by: T1, T2
      Owns: `packages/github-app/src/webhook.ts`, `packages/github-app/test/webhook-delivery.test.ts`
      Acceptance: `verifyWebhookSignature` enforces the `1048576`-byte cap (`WEBHOOK_PAYLOAD_TOO_LARGE`), the
      `sha256=<64-hex>` header shape, a non-empty secret, HMAC-SHA256 over the exact raw bytes, and
      `crypto.timingSafeEqual` digest comparison. `WebhookDeliveryStore` keys on `X-GitHub-Delivery` matching
      `^[A-Za-z0-9-]{8,128}$`, records `accepted | processing | succeeded | failed` state with `payloadDigest`,
      `attemptCount`, and timestamps, returns `{ kind: 'duplicate' }` for replays of in-flight or succeeded
      deliveries, fails closed with `WEBHOOK_DELIVERY_CONFLICT` on payload mismatch, and re-admits a `'failed'`
      redelivery with identical digest as `{ kind: 'retry_failed' }` with incremented `attemptCount`.
      `intakeWebhookDelivery` verifies the signature before JSON parsing, deduplicates through the store, accepts
      only the structured events from Feature 2, and applies `parseCommentCommand` (configurable prefixes, default
      `/loopwright`), `authorizeRepositoryActor`, and `validateCommentGuidance` to comment and review events. Plain
      issue comments, edited or deleted comments, `user.type === 'Bot'` authors, and unprefixed text return
      `{ kind: 'ignored' }` without queue admission; unauthorized actors and invalid guidance return
      `WEBHOOK_ACTOR_UNAUTHORIZED` and `WEBHOOK_GUIDANCE_INVALID`.
      Verify: `npm --workspace @loopwright/github-app test && npm run typecheck && npm test`

- [x] **T4 · Tenant isolation boundary and per-group admission queue**
      Blocked by: T1
      Owns: `packages/github-app/src/tenant-queue.ts`, `packages/github-app/test/tenant-queue.test.ts`
      Acceptance: `TenantIdentity` validates `installationId`, `repositoryId`, `repositoryFullName` against
      `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`, and `taskpackId`, and partitions every queue operation (`enqueue`,
      `leaseNext`, `renewLease`, `settleLease`, `inspectTenantQueue`, `resolveTenantRunPaths`); any cross-tenant
      reference to a `queueItemId`, `runId`, or artifact path fails closed with `TENANT_BOUNDARY_VIOLATION`.
      `TenantAdmissionQueue` enforces per-`(repositoryFullName, taskpackId)` concurrency of at most one `leased`
      item, a `maxPendingPerGroup` cap (default `100`, configurable `1..100`) with `QUEUE_CAPACITY_EXCEEDED`,
      coalescing of pending `discover`/`schedule` items for the same `(tenant, baseRevision)` (`coalesced: true`)
      while keeping `revise` items with distinct `(commandId, headSha, commandDigest)` separate, and a store-wide
      monotonic `leaseEpoch` that binds `notAfterMonotonicMs`. `renewLease` and `settleLease` require the exact
      current `leaseEpoch` and `workerId` and validate the clock sample with `@loopwright/state` `clockValid`;
      violations fail closed with `QUEUE_LEASE_FENCED`. An expired lease transitions the item to
      `reconcile_required`; `reconcileExpiredLease` records whether external effects were `not_executed` or
      `reconcile_required` before re-leasing. `revokeTenantScope` cancels pending items with
      `reason: 'installation_revoked'` and fences active leases so later renewals or settlements with publication
      effects fail with `TENANT_INSTALLATION_REVOKED`.
      Verify: `npm --workspace @loopwright/github-app test && npm run typecheck && npm test`

- [x] **T5 · Installation token broker, secret scrubbing, and host qualification**
      Blocked by: T1
      Owns: `packages/github-app/src/token-broker.ts`, `packages/github-app/src/qualification.ts`, `packages/github-app/test/token-broker-qualification.test.ts`
      Acceptance: `createGitHubAppJwt` signs RS256 with `iss: String(appId)`, `iat: nowSeconds - 60`, and
      `exp: nowSeconds + 540` using `node:crypto` `createSign('RSA-SHA256')`, refusing invalid PEM keys or
      non-positive `appId` values with `TOKEN_BROKER_CONFIG_INVALID`. `InstallationTokenBroker` mints through an
      injectable `InstallationTokenTransport`, binds single-repository `repository_ids: [tenant.repositoryId]`,
      supports only the `'read_only'` (`contents: read`, `metadata: read`) and `'publish_pull_request'`
      (`contents: write`, `pull_requests: write`, `metadata: read`) permission profiles, refuses wildcard,
      multi-repository, or broader scopes with `TOKEN_SCOPE_VIOLATION`, refuses TTL above `3600` seconds, refreshes
      within `refreshMarginMs` (default `300000`), evicts on `revokeInstallationTokens`, and tracks every minted
      token plus the App private key in `scrubSecrets` / `assertCleanArtifact` across raw, JSON-escaped,
      URL-encoded, and base64 forms with `ghs_`, `ghu_`, `github_pat_`, and PEM-header patterns
      (`TOKEN_SECRET_LEAK_DETECTED`). `qualifyDeploymentHostProfile` enforces the `darwin/arm64`, `linux/arm64`,
      `linux/x64` allowlist, `^v?26\.` Node versions, the `nfs`, `smb`, `cifs`, `fuse`, `sshfs`, `webdav`,
      `tmpfs-ephemeral-unverified` filesystem denylist (`HOST_PROFILE_UNQUALIFIED`), clock continuity through
      `clockValid` (`HOST_CLOCK_UNTRUSTED`), a bounded `O_CREAT | O_EXCL | O_NOFOLLOW` fsync + atomic-rename probe
      when `probeDirectory` is supplied, and `STORAGE_PROFILE_INSUFFICIENT` with
      `recommendedRunStatus: 'reconcile_required'` for `actions-basic` auto-resume or unverified-ledger resume.
      `validateMcpAuthConfiguration` refuses `oauth` / `oauth2` / `browser` / `device_code` / `interactive`
      declarations and `401` / `403` `WWW-Authenticate` challenges with `MCP_OAUTH_UNSUPPORTED` /
      `MCP_AUTHENTICATION_REQUIRED`, with zero browser launches, zero loopback listeners, and zero anonymous
      fallbacks.
      Verify: `npm --workspace @loopwright/github-app test && npm run typecheck && npm test`

- [x] **T6 · Reusable Action entrypoint, loopback control plane, barrel, and docs**
      Blocked by: T2, T3, T4, T5
      Owns: `action.yml`, `packages/github-app/src/action.ts`, `packages/github-app/src/service.ts`, `packages/github-app/src/index.ts`, `docs/github-app.md`, `packages/github-app/test/control-plane-action.test.ts`
      Acceptance: Root `action.yml` (never under `.github/workflows/`) declares
      `name: 'Loopwright Taskpack Action'`, `runs.using: 'node20'`, and the inputs `taskpack-path` (default
      `.loopwright/taskpack.yaml`), `mode`, `event-name`, `event-path`, `run-root`, `run-id`, `storage-profile`
      (default `actions-basic`), `provider`, `model`, `thinking`, and endpoint URLs. `runGitHubActionEntrypoint`
      runs `qualifyDeploymentHostProfile` and `validateMcpAuthConfiguration`, loads the target manifest, evaluates
      trigger intake, compiles, writes the `TrustedRegistry` and `ControllerConfiguration` into a trusted directory
      with `untrustedRoots: [repositoryRoot]`, passes `assertCleanArtifact`, and returns the structured
      `ActionEntrypointResult` with an optional delegate hook for dry-run or `@loopwright/controller` execution.
      `startGitHubAppControlPlane` serves loopback-only HTTP (`127.0.0.1`, ephemeral port `0` supported) with
      `POST /webhooks/github`, `POST /tenants/:installationId/:repositoryId/:taskpackId/lease` (monotonic
      `leaseEpoch` plus a scoped `'read_only'` token),
      `POST /tenants/:installationId/:repositoryId/:taskpackId/settle`, and `GET /healthz`, all responses scrubbed
      through `assertCleanArtifact`. `src/index.ts` exports the public barrel. `docs/github-app.md` documents the
      architecture and target-repository onboarding with workflow examples as fenced YAML blocks.
      Verify: `npm test`

### Test Plan
- [x] I/we understand the owners of the involved components may require updates to existing tests to make this code solid enough prior to committing the changes necessary to implement this enhancement.

#### Prerequisite testing updates
None. No existing test file changes. The root `npm test` suite (all seven existing package suites plus the three
qualification suites) must stay green after every task; `packages/github-app/test/*.test.ts` join it through the
T1 workspace wiring.

#### Unit tests
`@loopwright/github-app`: 2026-11-11 - every exported symbol exercised by the suites below. The workspace has no
coverage reporter, so the gate is full-suite green plus this assertion matrix. All tests are deterministic and
offline: synthetic RS256 keypairs from `node:crypto` `generateKeyPairSync`, loopback HTTP only, and zero live
`api.github.com` calls.

- `test/taskpack-intake.test.ts` (AC-1):
  - Loading `.loopwright/taskpack.yaml`, `.yml`, and `.json` fixtures returns the validated `TaskpackManifest`;
    `commentPrefixes` defaults to `['/loopwright']`.
  - Negative: input over `65536` bytes refused; a symlinked manifest refused (`O_NOFOLLOW`); `..` traversal,
    `__proto__` / `constructor` / `prototype` keys, and any `${...}` string refused with
    `TASKPACK_UNTRUSTED_INTERPOLATION`.
  - Negative: `metadata.id` outside `^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$` or over `64` characters, empty or
    over-long goal fields, and upstream counts outside `1..32` refused.
  - Negative: a `writable` path overlapping or nested inside an effective protected path fails with
    `TASKPACK_SCOPE_VIOLATION`; `proposal.path` outside `writable`; a memory directory outside
    `.loopwright/memory/<id>` or overlapping `writable`.
  - `compileDeclarativeTaskpack` output passes `validateDocument(..., 'TaskContract')`, and
    `loadTrustedConfiguration` + `compilePlan` accept the emitted registry/config pair from a trusted directory
    with `untrustedRoots: [<fixture checkout>]`; `registrySha256` matches `registryBytes`.
  - `prepareTaskpackIntake` discover returns ready, `no_change`, and blocked dispositions over declarative
    upstream records; `revise` rejects unauthorized actors and invalid guidance and binds
    `(commandId, headSha, commandDigest)`; `parseActionsRunUrl` rejects cross-repository and malformed URLs;
    `boundDiagnosticLog` caps and scrubs the `4000`-character tail.
- `test/webhook-delivery.test.ts` (AC-2):
  - A valid `sha256=` signature over raw bytes returns `{ ok: true, payloadDigest }`; negative: malformed header,
    wrong digest, missing secret, and empty secret return `WEBHOOK_SIGNATURE_INVALID`; a body over `1048576` bytes
    returns `WEBHOOK_PAYLOAD_TOO_LARGE`; comparison uses `crypto.timingSafeEqual`.
  - Delivery store: the same digest in `accepted` / `processing` / `succeeded` returns `{ kind: 'duplicate' }`;
    a different digest fails closed with `WEBHOOK_DELIVERY_CONFLICT`; `'failed'` with an identical digest returns
    `{ kind: 'retry_failed' }` with `attemptCount` incremented; delivery IDs outside
    `^[A-Za-z0-9-]{8,128}$` refused.
  - Negative intake: `issue_comment.created` without a `pull_request` object, edited or deleted comments,
    `user.type === 'Bot'` authors, and comments without a configured prefix return `{ kind: 'ignored' }` with no
    queue admission.
  - Negative: a prefixed command from `NONE`, `FIRST_TIME_CONTRIBUTOR`, or an unallowlisted `CONTRIBUTOR` returns
    `WEBHOOK_ACTOR_UNAUTHORIZED`; over-long, sentinel-bearing, or contract-override guidance returns
    `WEBHOOK_GUIDANCE_INVALID`.
  - `pull_request_review.submitted`, `release.published`, `schedule`, `workflow_dispatch`, `repository_dispatch`,
    and `installation.suspend` / `installation.deleted` / `installation_repositories.removed` route to their
    documented dispositions, with revocation events reaching `revokeTenantScope`.
- `test/tenant-queue.test.ts` (AC-3):
  - Negative: `leaseNext` / `renewLease` / `settleLease` / `inspectTenantQueue` / `resolveTenantRunPaths` with
    mismatched `installationId`, `repositoryId`, `repositoryFullName`, or `taskpackId` fail with
    `TENANT_BOUNDARY_VIOLATION`; a `repositoryFullName` outside its pattern is refused at identity validation.
  - A second concurrent lease in one `(repositoryFullName, taskpackId)` group is not granted until settlement;
    the `101st` pending item fails with `QUEUE_CAPACITY_EXCEEDED`; `maxPendingPerGroup` accepts only `1..100`.
  - Duplicate pending `discover` / `schedule` items for the same `(tenant, baseRevision)` coalesce with
    `coalesced: true`; two `revise` commands with distinct `(commandId, headSha, commandDigest)` both queue.
  - `leaseEpoch` increments strictly monotonically across leases; renewal or settlement with a stale epoch or a
    wrong `workerId` fails with `QUEUE_LEASE_FENCED`; an invalid clock sample fails closed through `clockValid`.
  - Lease expiry transitions the item to `reconcile_required`; `reconcileExpiredLease` records `not_executed`
    versus `reconcile_required` and gates re-leasing on that record.
  - `revokeTenantScope` cancels pending items with `reason: 'installation_revoked'`, fences the active lease, and
    subsequent renewal or settlement fails with `TENANT_INSTALLATION_REVOKED`.
- `test/token-broker-qualification.test.ts` (AC-4, AC-5):
  - A generated RSA keypair signs a JWT that `crypto.verify('RSA-SHA256', ...)` validates with `iss`,
    `iat: nowSeconds - 60`, and `exp: nowSeconds + 540`; negative: an invalid PEM and `appId <= 0` return
    `TOKEN_BROKER_CONFIG_INVALID`.
  - The mock transport receives `repository_ids: [<single repositoryId>]`; negative: wildcard or multi-repository
    scope and `administration` / `workflows` / `secrets` / `organization_*` permission requests return
    `TOKEN_SCOPE_VIOLATION`; profiles map exactly to `'read_only'` and `'publish_pull_request'`.
  - A token within `refreshMarginMs` (default `300000`) refreshes on demand; a TTL over `3600` seconds is
    refused; `revokeInstallationTokens` evicts every cached token for the installation.
  - `scrubSecrets` removes raw, JSON-escaped, URL-encoded, and base64 forms of minted tokens and the private key;
    negative: `assertCleanArtifact` throws `TOKEN_SECRET_LEAK_DETECTED` on contaminated contract, lock, result,
    and log payloads and passes clean ones; `ghs_`, `ghu_`, `github_pat_`, and PEM-header patterns are caught.
  - Negative: non-allowlisted `(platform, arch)`, Node outside `^v?26\.`, and denylisted filesystems (`nfs`, `smb`,
    `cifs`, `fuse`, `sshfs`, `webdav`, `tmpfs-ephemeral-unverified`) return `HOST_PROFILE_UNQUALIFIED`; adjacent or
    cumulative drift and backward clock jumps return `HOST_CLOCK_UNTRUSTED` through `clockValid`.
  - The probe file is created with `O_CREAT | O_EXCL | O_NOFOLLOW`, fsynced, atomically renamed, and removed with
    no residue; an existing probe path is refused.
  - Negative: `actions-basic` with `autoResumeOnHostLossRequested`, or resume without a verified checkpoint ledger,
    returns `STORAGE_PROFILE_INSUFFICIENT` with `recommendedRunStatus: 'reconcile_required'`; `durable` passes.
  - Negative: `auth.type` in `oauth` / `oauth2` / `browser` / `device_code` / `interactive` returns
    `MCP_OAUTH_UNSUPPORTED`; a `401` / `403` MCP response with `WWW-Authenticate` containing `Bearer`, `OAuth`, or
    `authorization_uri` returns `MCP_AUTHENTICATION_REQUIRED`; the function performs no I/O, so no listener opens
    and no process spawns.

#### Integration tests
`test/control-plane-action.test.ts` (AC-6) drives the real components over a loopback server bound to
`127.0.0.1:0`:
- `POST /webhooks/github` with a validly signed payload returns structured JSON and enqueues the trigger;
  negative: an invalid signature returns a scrubbed error, redelivery of a succeeded delivery is an idempotent
  `2XX` duplicate, and a payload-mismatch redelivery fails closed with `WEBHOOK_DELIVERY_CONFLICT`; an
  installation revocation event revokes the tenant scope.
- `POST /tenants/:installationId/:repositoryId/:taskpackId/lease` returns a monotonic `leaseEpoch` and a
  `'read_only'`-scoped token from the mock transport; a second lease for the same group waits; negative: settle
  with a stale epoch fails fenced.
- `POST /tenants/:installationId/:repositoryId/:taskpackId/settle` settles `completed` / `failed` / `blocked` /
  `reconcile_required` and updates the delivery store; `GET /healthz` returns `{ ok: true }` with queue and
  delivery summary counts; every response passes `assertCleanArtifact`.

#### e2e tests
- `test/control-plane-action.test.ts` also drives `runGitHubActionEntrypoint` end-to-end offline: host
  qualification, an unqualified-profile refusal and an MCP OAuth refusal, fixture `.loopwright/taskpack.yaml`
  load, compile, write of `TrustedRegistry` and `ControllerConfiguration` into a trusted directory outside the
  checkout, `assertCleanArtifact`, and `ActionEntrypointResult` with the dry-run delegate invoked. A filesystem
  scan asserts zero `.github/workflows/` files in the repository.
- No live-App e2e exists by constraint: the Non-Goals forbid live `api.github.com` calls and App registration, so
  all credential exchanges run through deterministic mock and loopback transports, and target-repository workflow
  examples remain fenced YAML blocks in `docs/github-app.md`.

## Alternatives

- **Require every target repository to write a custom TypeScript `@loopwright/taskpack-<repo>` package**: Rejected
  because onboarding a new repository or external-update surface should only require a declarative
  `.loopwright/taskpack.yaml` manifest and standard workflow/App configuration, keeping repository-specific business
  data out of Loopwright's core packages.
- **Deduplicate `X-GitHub-Delivery` with an append-only set that permanently drops any seen delivery ID**: Rejected
  because a transient local disk or worker failure after webhook receipt would cause GitHub's manual or automatic
  redelivery of the same `X-GitHub-Delivery` ID to be silently ignored forever. Tracking delivery state
  (`accepted | processing | succeeded | failed`) safely ignores duplicates of in-flight or succeeded deliveries while
  allowing redelivery retries of failed ones.
- **Pass long-lived Personal Access Tokens (PATs) or unscoped installation tokens into the controller workspace**:
  Rejected because a compromised tool or prompt-injection payload could exfiltrate broad credentials or push to
  unrelated repositories. Minting short-lived, single-repository installation tokens with separate `'read_only'` and
  `'publish_pull_request'` permission profiles and scrubbing all encoded forms preserves least privilege.

## Open Questions

None.
