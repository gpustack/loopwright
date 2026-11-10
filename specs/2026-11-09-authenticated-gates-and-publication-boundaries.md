# Spec: Authenticated gates, receipts, and publication boundaries

Status: Shipped
Type: Feature

## Summary

Add authenticated external gates, cryptographic receipt verification, controlled publication boundaries, and explicit
operation reconciliation to the controller and CLI. External gate checks emit bound operation intents and verify
HMAC-SHA256 receipts before producing `external_service` acceptance evidence. Controlled publication executes only after
all required acceptance checks pass, records an `external_write` intent and dispatch permit before any remote write,
writes `publication.json` into the run bundle, and transitions interrupted or ambiguous writes to `reconcile_required`
without blind replay. A new `reconcile` workflow resolves uncertain gate or publication operations from authenticated
remote state receipts.

## Motivation

### Goals

Tasks that build images, await external verification services, or propose pull requests cross process and network
boundaries where local process exit or HTTP status codes alone do not prove what happened. Aborting a client request or
timing out a wait does not prove that a remote build or pull-request write did not execute, and an unauthenticated
`HTTP 200` payload does not prove that an external service approved the current candidate tree.

The existing packages (`@loopwright/core`, `@loopwright/state`, `@loopwright/agent-pi`, `@loopwright/controller`, and
`@loopwright/cli`) already provide:

1. `external_service` evidence levels and `externalEffects: 'none' | 'confirmed' | 'unknown'` in
   [`packages/core/src/contracts.ts`](../packages/core/src/contracts.ts) and
   [`packages/core/src/results.ts`](../packages/core/src/results.ts).
2. Standalone operation journals (`putIntent`, `authorizeOperationDispatch`, `markOperationUnresolved`,
   `recordOperationReceipt`, `reconcileOperation`) with `effect: 'read_only' | 'local_write' | 'external_write'` in
   [`packages/state/src/store.ts`](../packages/state/src/store.ts) and
   [`packages/state/src/journal.ts`](../packages/state/src/journal.ts).
3. Bounded cycle execution, isolated byte verifiers, and artifact bundles in
   [`packages/controller/src/controller.ts`](../packages/controller/src/controller.ts) and
   [`packages/controller/src/inspect.ts`](../packages/controller/src/inspect.ts), where `publication.json` is currently
   marked `outside_scope`.

This specification closes the boundary between local verification and external effects:

1. Operators can configure allowlisted gate and publication endpoints with dedicated signing and authentication
   credentials in `TrustedRegistry` and `ControllerConfiguration`.
2. Controller check steps using `gate.v1` submit bound gate requests, support bounded polling with backoff and jitter or
   signed receipt ingestion, and produce `external_service` evidence only when an authenticated receipt matches the
   current run lock, dispatch permit, source revision, and candidate manifest digest.
3. Controlled publication runs only after deterministic acceptance and scope checks succeed, fences writes with the
   current store owner generation and deterministic idempotency key, and never exposes publisher credentials to agent or
   verifier processes.
4. Any post-dispatch timeout, cancellation, network failure, or unverified response on an `external_write` operation
   marks the operation `unresolved`, forces `RunResult.spec.status = 'reconcile_required'`, prevents automatic replay on
   `resume`, and requires an authenticated reconciliation receipt via `reconcileCycle` / `loopwright reconcile`.

### Non-Goals

- Live GitHub App webhook receivers, installation token brokers, multi-tenant queues, or hosted RunStore daemons.
- Executing `.github/workflows` or modifying repository CI/CD pipelines.
- Taskpack-specific domain validators (`runner-release-sync`, `llm-router`, `mirrored-mooncake`).
- Active memory curation, memory pull-request creation, or Jev routing decisions.
- Automatic retry or blind replay of uncertain `external_write` operations after timeout, crash, or connection loss.
- Arbitrary webhook URLs derived from untrusted task descriptions, model outputs, or repository files.

## Proposal

Extend `@loopwright/controller` and `@loopwright/cli` so external gate verification, post-acceptance publication, and
post-interruption reconciliation operate under the same single-writer `LocalRunStore` journal and `TaskLock` subject
binding established in [`packages/core/src/identity.ts`](../packages/core/src/identity.ts) and
[`packages/state/src/store.ts`](../packages/state/src/store.ts).

### User Stories

#### Story 1

As an operator, I want a task step to wait on an allowlisted external gate endpoint and verify a signed receipt bound to
the candidate manifest and dispatch generation, so that external build or approval services can satisfy
`external_service` acceptance checks without trusting unauthenticated HTTP responses or stale runs.

#### Story 2

As an operator, I want publication to execute only after all required acceptance checks pass and to record an
`external_write` operation intent and dispatch permit before sending the request, so that model processes never hold
publication credentials and unverified candidates can never be published.

#### Story 3

As an operator, I want interrupted or ambiguous publication operations to enter `reconcile_required` and be resolved
through an explicit `loopwright reconcile` command with an authenticated remote state receipt, so that a crash or
network failure after dispatch never causes duplicate pull requests or false completion claims.

### Core Features & Acceptance Criteria

#### 1. Trusted Gate and Publication Configuration (`config.ts`, `registry.ts`, `compile.ts`, `types.ts`)

- `TrustedRegistry` supports two new optional endpoint tables and two new credential consumers:
  - `gateEndpoints`: array of `{ id, url, signingCredentialRef, authCredentialRef, timeoutMs, maxPollMs, pollInitialMs, pollMaxMs, jitter }`.
  - `publicationEndpoints`: array of `{ id, url, signingCredentialRef, authCredentialRef, timeoutMs }`.
  - `CredentialBinding.consumer` extends from `'provider' | 'mcp'` to `'provider' | 'mcp' | 'gate' | 'publisher'`.
  - `Handler.implementation` extends to include `'gate.v1'` (with `kind: 'check'`).
- `ControllerConfiguration.spec` supports an optional `publication` block:
  - `{ mode: 'disabled' } | { mode: 'pull_request'; endpointRef: string; targetBranch: string; headBranchPrefix: string; titleTemplate: string }`.
  - Default when omitted is `{ mode: 'disabled' }`.
- Outbound URL validation:
  - Every `gateEndpoints[].url` and `publicationEndpoints[].url` must parse as an `https://` URL, or `http://127.0.0.1:<port>/...` / `http://[::1]:<port>/...` for local loopback services.
  - Credentials, query strings, fragments, userinfo, and relative paths in endpoint URLs are rejected with `CONFIG_SCHEMA`.
- Plan compilation (`compilePlan`):
  - Validates that every `gate.v1` handler references a declared `checkId` whose `allowedEvidenceLevels` in `TaskContract` includes `'external_service'`, and references a valid `endpointRef` in `gateEndpoints`.
  - Validates that when `publication.mode === 'pull_request'`, `endpointRef` resolves in `publicationEndpoints` and its required `signingCredentialRef` and `authCredentialRef` are present in `configuration.spec.credentials`.
  - Accounts for gate check slots and at most one publication operation in `checkpointCapacity` and operation budget checks without exceeding `LocalRunStore` operation limits (`2048`).
  - Ensures resolved gate and publisher secrets never appear in `CompiledPlan`, checkpoints, events, or bundle artifacts.

#### 2. Authenticated External Gate Protocol (`gate.ts`, `verification.ts`, `acceptance.ts`)

- When the controller executes a `check` node backed by `gate.v1` (or evaluates its verifier slot):
  1. It binds the current candidate manifest to the `TaskLock` (`bindSubject(lock, candidate)`).
  2. It records a standalone `OperationIntent` in `LocalRunStore` with `effect: 'read_only'`, `nodeId`, `attemptId`, `targetIdentity: 'gate:<slotId>:<generation>:<candidateDigest>'`, and `requestDigest` over the canonical gate request payload.
  3. It calls `store.authorizeOperationDispatch(authority, operationId)` to obtain a `DispatchPermit` (`dispatchId`, `generation`, `notAfterMonotonicMs`).
  4. It sends a signed `POST` request (`redirect: 'error'`) to the allowlisted gate endpoint containing a
     `gate_request` document `{ version: 1, kind: 'gate_request', gateId, checkId, storeId, runId, lockHash, operationId, dispatchId, dispatchGeneration, candidateDigest, subject, requestDigest }`
     with header `x-loopwright-signature: <hex>` (or `sha256=<hex>`) computed via HMAC-SHA256 using the gate's resolved signing secret over the canonical JSON request body, and optional `authorization: Bearer <token>` when `authCredentialRef` is configured.
- Gate response and receipt rules:
  - The endpoint responds with a `gate_verdict` document `{ version: 1, kind: 'gate_verdict', storeId, runId, lockHash, operationId, dispatchId, dispatchGeneration, gateId, checkId, candidateDigest, status: 'pending' | 'approved' | 'denied' | 'expired', reason, expiresAtMs }` and header `x-loopwright-signature: <hex>` (or `sha256=<hex>`) signing the exact wire body bytes.
  - The controller verifies the HMAC-SHA256 signature using `crypto.timingSafeEqual`. Any missing or invalid signature, HTTP redirect, non-JSON body, mismatched `storeId` / `runId` / `lockHash` / `operationId` / `dispatchId` / `dispatchGeneration` / `checkId`, mismatched `candidateDigest` (the `gate_request` carries the full `subject`; the `gate_verdict` echoes `candidateDigest` alongside `storeId`, `runId`, `lockHash`, `operationId`, `dispatchId`, `dispatchGeneration`, `gateId`, and `checkId`), or expired receipt (`expiresAtMs < sampledWallMs`) is rejected immediately.
  - While `status === 'pending'` and the effective poll window `min(endpoint.maxPollMs, permitLease - 2000ms, remainingTaskTime - drainReserveMs - 2000ms)` has not expired:
    - The controller emits a `gate_waiting` event (`ControllerEvent`) recording `operationId`, `gateId`, `elapsedMs`, `nextPollMs`, and `deadlineMs`, sleeps with bounded exponential backoff (`pollInitialMs` to `pollMaxMs`, deterministic or bounded jitter), renews the store lease as needed, and polls the gate endpoint.
  - Terminal gate states:
    - `approved`: records `OperationReceipt` (`outcome: 'succeeded'`) in `LocalRunStore`, persists the authenticated gate receipt artifact, and produces an `Evidence` document with `level: 'external_service'`, `observedStatus: 'passed'`, and `method: 'verify_external_gate'`.
    - `denied`: records `OperationReceipt` (`outcome: 'succeeded'`, since the check operation completed with a negative verdict), and produces `Evidence` with `level: 'external_service'`, `observedStatus: 'failed'`.
    - `expired` or poll deadline reached or invalid/unreachable response: marks the gate check `blocked` (`EVIDENCE_UNAVAILABLE` / `GATE_TIMEOUT`) without fabricating `passed` evidence.

#### 3. Controlled Publication Boundary (`publication.ts`, `controller.ts`, `inspect.ts`)

- Eligibility gate before publication:
  - If `publication.mode === 'disabled'`, the cycle skips publication and records `observations.publication = { status: 'not_run', reason: 'disabled', receipt: null }`.
  - If `publication.mode === 'pull_request'`, publication is eligible **only** when:
    1. All DAG steps completed and `evaluateControllerAcceptance` produced `status === 'completed'` (never on `no_change`, `failed`, `blocked`, `exhausted`, `expired`, `cancelled`, or `reconcile_required`).
    2. `VerificationResult.spec.satisfied === true` and implicit `controller.scope` check status is `'passed'`.
    3. The current repository `HEAD` and `baseRevision` still match `lock.spec.contract.spec.target` (verified via `git-reader.ts`), and the candidate manifest digest matches `VerificationResult.spec.subject.candidateDigest`.
    4. `store.inspect()` reports `clockStatus === 'trusted'`, zero unresolved requests/operations, and zero ledger violations.
- Intent-before-write execution:
  1. Compute deterministic `operationId = 'publish.' + hash(runId, lockHash)` and `idempotencyKey = 'pub.' + sha256("loopwright.dev/publication/v1\0" + canonical({ storeId, runId, lockHash, candidateDigest, targetBranch, operationId })).slice(0, 40)` (where `candidateDigest` is the `{ algorithm, hex }` `Digest` object).
  2. Persist the pre-publication progress checkpoint (`publication.pre`, `publication: { status: 'pending', operationId, receipt: null }`) so `resumeCycle` knows an `external_write` is about to be authorized.
  3. Call `store.putIntent(authority, { operationId, nodeId: firstDagNodeId, attemptId: idempotencyKey, effect: 'external_write', requestDigest, targetIdentity: 'publication:<runId>:<candidateDigest>' })`, renew the store lease, and call `store.authorizeOperationDispatch(authority, operationId)` to obtain `permit`.
  4. Send the signed `POST` request (`redirect: 'error'`) to `publicationEndpoints[endpointRef].url` with a `publication_request` document `{ version: 1, kind: 'publication_request', idempotencyKey, storeId, runId, lockHash, operationId, dispatchId: permit.dispatchId, dispatchGeneration: permit.generation, targetBranch, headBranch, title, candidateDigest, baseRevision, sourceRevision, requestDigest }`, clamped to `min(endpoint.timeoutMs, permit.notAfterMonotonicMs - 2000ms, taskDeadlineMonotonicMs - drainReserveMs - 2000ms)`; a window at or below zero skips the POST and settles unresolved with `reason: 'timeout'`.
- Publication receipt verification:
  - A valid response is a `publication_receipt` document `{ version: 1, kind: 'publication_receipt', storeId, runId, lockHash, operationId, dispatchId, dispatchGeneration, idempotencyKey, outcome: 'succeeded' | 'not_executed' | 'failed', externalUrl, reason }` carrying a valid HMAC-SHA256 signature (`timingSafeEqual`) over the exact wire bytes; a matching `candidateDigest` field is verified when present.
  - When `outcome === 'succeeded'` and all bindings (`storeId`, `runId`, `lockHash`, `operationId`, `dispatchId`, `dispatchGeneration`, `idempotencyKey`, `candidateDigest`) match:
    - Store the verified receipt artifact and call `store.recordOperationReceipt(authority, operationId, { receiptId, outcome: 'succeeded', evidence })`.
    - Re-evaluate acceptance so `RunResult.spec.externalEffects === 'confirmed'` and `RunResult.spec.status === 'completed'`.
    - Export `publication.json` in `inspectRun` / bundle containing the verified publication receipt and metadata.
  - When `outcome === 'not_executed'` (authenticated proof from the publication service that no remote write occurred):
    - Call `store.recordOperationReceipt(authority, operationId, { receiptId, outcome: 'not_executed', evidence })`.
    - Settle `RunResult.spec.externalEffects === 'none'` and `RunResult.spec.status === 'failed'` (`PUBLICATION_FAILED`).
  - When the request times out, errors, is aborted, returns an invalid signature, or returns `outcome === 'failed'` without proof of non-execution:
    - Call `store.markOperationUnresolved(authority, operationId, reason)`.
    - Re-evaluate acceptance so `RunResult.spec.externalEffects === 'unknown'` and `RunResult.spec.status === 'reconcile_required'`.
    - `resumeCycle` on a run with an unresolved `external_write` operation must **never** re-dispatch the publication request; it returns the retained `reconcile_required` result until explicit reconciliation occurs.

#### 4. Explicit Reconciliation (`reconcile.ts`, `cli/src/main.ts`, `cli/src/arguments.ts`)

- Export `reconcileCycle(input: ReconcileCycleInput)` from `@loopwright/controller` and add `loopwright reconcile` to `@loopwright/cli`:
  ```text
  loopwright reconcile --config <path> --registry <path> --registry-sha256 <hex> --repo <path> --run-root <path> --run-id <id> --receipt <path> [--output <path>]
  ```
- Behavior of `reconcileCycle`:
  1. Validates configuration, compiles plan, acquires `ControllerOwner` lock, reopens `LocalRunStore`, claims recovery/active authority, and restores the retained candidate and progress state. The operator receipt file must be a regular non-symlink file of at most 65536 bytes (ancestor symlinks such as `/tmp -> /private/tmp` canonicalize before the owned-file check).
  2. Reads and parses the operator-supplied reconciliation receipt JSON file (`--receipt <path>`) using `readBoundedFile` and `parsePrivateJson`. The file contains the exact signed receipt document plus a top-level `signature` field computed over the canonical document without the `signature` key.
  3. Identifies the target operation in `LocalRunStore` (`state === 'unresolved' || state === 'dispatch_uncertain'`, or already `'confirmed'` for idempotent replay, for either a `publication_receipt` or a `gate_verdict` receipt) and verifies the receipt's HMAC-SHA256 signature against the configured gate or publication `signingCredentialRef` in `TrustedRegistry`.
  4. Verifies that `storeId`, `runId`, `lockHash`, `operationId`, `intentDigest`, `dispatchId`, `dispatchGeneration`, and `candidateDigest` match the stored operation and candidate manifest.
  5. Calls `store.reconcileOperation(authority, operationId, operationReceipt)` in `LocalRunStore`, then resumes the remaining cycle for a reconciled gate (including publication when configured) or supersedes a retained `reconcile_required` terminal result in place through a `reconcile.result` checkpoint when publication settles after terminalization. Before terminalization `reconcileCycle` delegates to `resumeCycle` (which re-runs `evaluateControllerAcceptance`); after a `reconcile_required` `RunResult` has terminalized, the superseding `reconcile.result` checkpoint rewrites `spec.status` and `spec.externalEffects` on the validated `RunResult`; and if the run terminalized as an immutable `ControllerIncident`, `reconcileCycle` records the verified receipt in the journal and `reconcile.result` observations (exporting `publication.json`) while preserving the incident primary and returning `unresolved` with `reason: 'incident_retained'` (exit `7`).
  6. Re-runs `evaluateControllerAcceptance`:
     - If `outcome === 'succeeded'` on a publication operation (or an approved `gate_verdict` whose cycle completes, including publication) and all other checks/operations are clean, `externalEffects` becomes `'confirmed'`, `RunResult.spec.status` transitions from `'reconcile_required'` to `'completed'`, `publication.json` is written, and the CLI exits `0`.
     - If `outcome === 'not_executed'` on a publication operation (or a denied `gate_verdict`) and all other operations are clean, `externalEffects` becomes `'none'`, `RunResult.spec.status` transitions to `'failed'`, and the CLI exits `4`.
     - A blocked outcome (for example an expired gate verdict receipt) exits `3`.
     - If any operation or request remains unresolved, `RunResult.spec.status` remains `'reconcile_required'` and the CLI exits `7`.
  7. Idempotency: re-running `reconcileCycle` with the exact same valid receipt succeeds idempotently; supplying a conflicting receipt for an already-confirmed operation fails with `RECEIPT_CONFLICT` (exit `7`).

### Notes / Constraints / Caveats

- Node.js `>=26.13.0`, TypeScript strict ESM (`NodeNext`), and built-in `node:crypto`, `node:http`, `node:https`, and `fetch` only; do not add new external npm dependencies.
- Use `crypto.timingSafeEqual` for all HMAC-SHA256 comparisons.
- All new source and test filenames must use domain-descriptive `kebab-case` names (for example `gate.ts`, `publication.ts`, `reconcile.ts`, `gate-publication.test.ts`). Never use internal phase or incident numbers in filenames.
- `packages/core` and `packages/state` already support `external_service`, `external_write`, `reconcile_required`, and `reconcileOperation`. Prefer keeping changes scoped to `packages/controller`, `packages/cli`, `docs/`, and `examples/` unless a narrow additive export is required.

### Boundaries

- **Always:**
  - Persist `OperationIntent` and `authorizeOperationDispatch` in `LocalRunStore` before sending any network request to a gate or publication endpoint.
  - Verify HMAC-SHA256 signatures and exact `Subject` / `DispatchPermit` bindings before accepting any gate or publication receipt.
  - Redact and exclude gate and publication secrets from all logs, events, checkpoints, and bundles.
  - Transition ambiguous or interrupted `external_write` operations to `reconcile_required` (`exit 7`) and forbid automatic replay on `resume`.
- **Ask first:**
  - Changing any existing public signature in `@loopwright/core`, `@loopwright/state`, or `@loopwright/agent-pi`.
  - Adding any new third-party dependency to `package.json`.
- **Never:**
  - Publish when any required acceptance check is not `passed`, when `controller.scope` is not `passed`, or when `status` is `no_change`.
  - Follow HTTP `3xx` redirects or allow URLs outside `TrustedRegistry`.
  - Run `git push`, create remote GitHub pull requests against real repositories, or modify `.github/`.

### Risks and Mitigations

- **Forged or replayed gate/publication receipt unlocks acceptance or marks false publication** -> Require HMAC-SHA256 verification via `timingSafeEqual` over canonical JSON bound to `storeId`, `runId`, `lockHash`, `operationId`, `dispatchId`, `dispatchGeneration`, and `candidateDigest`.
- **Crash or timeout after `authorizeOperationDispatch` causes duplicate pull request on `resume`** -> Persist pre-dispatch state in `LocalRunStore`, transition interrupted `external_write` operations to `unresolved` (`reconcile_required`), and refuse re-dispatch in `resumeCycle`.
- **Confirmed `not_executed` reconciliation leaves `externalEffects` stuck at `'unknown'`** -> In `evaluateControllerAcceptance`, distinguish `outcome === 'not_executed'` (`externalEffects: 'none'`, `status: 'failed'`) from unverified failure or unresolved state (`externalEffects: 'unknown'`, `status: 'reconcile_required'`).
- **Secret leakage through URL or error diagnostics** -> Reject URLs with embedded credentials/query strings at config load time, bind secrets through `CredentialVault`, and scrub secret values from all diagnostics and events.
- **Added controller source files shift the `installedHandlerDigests` inventory and change every handler digest** -> Operator registries that embed handler digests must be re-derived after each build; test fixtures derive digests at runtime, and the documentation task records the regeneration requirement.
- **Event and checkpoint schema extensions must keep reopening runs written by earlier code** -> Extend only additively: new event stages, a bounded optional detail record, new phase entries, and a new receipt-index kind. Never mutate or reorder existing fields; recovery tests reopen fixtures written through the prior schema path.
- **Two extra publication phases consume headroom of the `D <= 64` checkpoint bound** -> The compile-time `CONFIG_LIMIT` refusal already guards the bound. The capacity formula change and its fixture expectations land in the same task.

## Design Details

### Commands

```bash
npm run build
npm run typecheck
npm run lint
npm test
npm --workspace @loopwright/controller test
npm --workspace @loopwright/cli test
```

### Project Structure

```text
packages/
  controller/
    src/
      acceptance.ts       # Update external_write / not_executed / gate evidence evaluation
      compile.ts          # Validate gate.v1 handlers, gateEndpoints, and publication config
      config.ts           # Validate gate/publication endpoints and credential consumers
      controller.ts       # Execute gate.v1 checks and post-acceptance publication boundary
      events.ts           # Add gate_waiting and publication event payloads
      gate.ts             # Authenticated external gate client, polling, and receipt verifier
      handlers.ts         # Register gate.v1 implementation digest
      index.ts            # Export reconcileCycle and gate/publication types
      inspect.ts          # Include publication.json in exported run bundle
      progress.ts         # Track gate and publication operation refs across checkpoints
      publication.ts      # Controlled publication client, idempotency key, and receipt verifier
      reconcile.ts        # Explicit operation reconciliation workflow (reconcileCycle)
      registry.ts         # Parse gateEndpoints, publicationEndpoints, and new consumers
      types.ts            # GateEndpoint, PublicationEndpoint, PublicationConfig, ReconcileCycleInput
    test/
      gate.test.ts        # Gate HMAC verification, pending poll, denied/expired, tamper tests
      publication.test.ts # Post-acceptance publication, crash-after-dispatch, reconcile tests
      reconcile.test.ts   # Reconciliation receipt verification, idempotency, conflict tests
  cli/
    src/
      arguments.ts        # Parse reconcile subcommand flags (--receipt, --run-id, etc.)
      main.ts             # Wire loopwright reconcile and exit code mapping
docs/
  controller.md           # Document gate.v1, publication boundary, and reconcile workflow
examples/
  controller.md           # Add authenticated gate, publication, and reconcile CLI examples
```

### Code Style

Follow the repository's strict TypeScript ESM style: explicit `.js` relative imports, `Object.create(null)` / closed
record validation at boundaries, `freeze(...)` on returned public structures, and `ControllerResult<T>` error envelopes.

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonical } from './schema.js';

export function verifySignedPayload(secret: string, payload: unknown, expectedHex: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(expectedHex)) return false;
  const actual = createHmac('sha256', secret).update(canonical(payload), 'utf8').digest();
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}
```

### Pinned design decisions

- **`gate.v1` handler shape.** Parameters are `{ checkId, endpointRef, gateId }`, kind is `check`, and capabilities are `['external_service', 'read_only']`. The new capability token states the truth: the step crosses a service boundary and writes nothing remotely. Reusing `['inert_bytes', 'read_only']` would misdescribe network I/O.
- **Gate operation identity.** Gate checks reuse `verifierOperationId(runId, slotId, generation)`. The scheme is deterministic per candidate generation, keeps `progress.verifierReceipts` validation and the acceptance operation lookup uniform, and makes restore reproducible. Fresh random ids would break the restore path.
- **Gate execution route.** `gate.ts` exports a `Gate` class that follows the `Verifier` discipline (intent, permit, receipt, authenticated artifact) but performs the signed fetch instead of a Worker run. `Cycle.runVerifier` branches on `slot.handler.implementation === 'gate.v1'` before byte preflight, and `prepareVerification` refuses `gate.v1`.
- **One HMAC verifier.** `gate.ts` exports `verifySignedPayload(secret, payload, expectedHex)` exactly as the Code Style sample shows; `publication.ts` and `reconcile.ts` import it. Duplicating security-critical comparison code would create two implementations to keep in sync.
- **Gate evidence identity.** Gate evidence carries `producerId: 'loopwright.gate-verifier.v1'`, `method: 'verify_external_gate'`, and `level: 'external_service'`. Core acceptance already matches evidence levels against `allowedEvidenceLevels`, so `packages/core` stays unchanged.
- **Credential resolution.** `CredentialVault` gains one accessor for gate and publisher credentials that refuses every other consumer. `compilePlan` counts those references among the needed credentials, so the existing `vault.references` equality check still proves the compiled plan is secret-free.
- **Publication phases.** When publication is enabled, `checkpointCapacity` reserves `publication.pre`, `publication.post`, and `reconcile.result` (`D = 7 + 3A + 2J`); disabled configurations keep `D = 4 + 3A + 2J` unchanged. The checkpoint frame stays at four refs; publication operation references live in the progress document, and the verified receipt artifact joins the `ReceiptIndex` as a `publication-receipt` entry. Modeling publication as a pseudo verifier slot was rejected because it would break phase-kind invariants.
- **Resume and reconcile split.** `progress.decision()` classifies an unresolved or dispatch-uncertain `external_write` operation as a distinct `reconcile_required` decision instead of refusing. `resumeCycle` returns the retained result and never re-dispatches. Only `reconcileCycle` settles such operations, through `store.reconcileOperation`, and a settled publication supersedes a retained `reconcile_required` result through a `reconcile.result` checkpoint with an updated `RunResult` and observations.
- **Event surface.** `ControllerEvent` gains the `gate_waiting` and publication stages plus a bounded detail record for `operationId`, `gateId`, `elapsedMs`, `nextPollMs`, and `deadlineMs`. Extensions are additive; lines written by earlier code stay valid on reopen.
- **Wire schemas.** `gate_request`/`gate_verdict` and `publication_request`/`publication_receipt` documents bind the store/run/lock/operation/dispatch identity, the check/subject/candidate fields, and the idempotency key; the `x-loopwright-signature` header carries the lowercase hex (optionally `sha256=`-prefixed) HMAC-SHA256 of the exact body bytes and is verified with constant-time comparison. Approved gate verdicts carry a wall-clock `expiresAtMs` that must fall within `[now, now + 24h]`. Operator receipt files are regular non-symlink files of at most 65536 bytes containing the signed receipt document plus its `signature`.

### Implementation Plan

Environment: local. Commands run in this worktree on Node.js 26.x and npm 11.x. A fresh checkout needs `npm ci` once. `npm run build` must precede `npm run typecheck` and `npm test`, because the workspace packages resolve their types from built `dist` output.

The DAG is strictly sequential. Each task depends on its predecessor: they share `controller.ts`, the acceptance evaluation, and the single HMAC verifier. No two tasks have disjoint `Owns:`, so `my-build` must not parallelize them.

- [x] **T1 · Endpoint and publication configuration foundation**
      Blocked by: None
      Owns: `packages/controller/src/types.ts`, `registry.ts`, `config.ts`, `credentials.ts`, `compile.ts`, `handlers.ts`, `progress.ts`, `packages/controller/test/config-loader.test.ts`, `config-parser.test.ts`, `progress-capacity.test.ts`, `scheduling-budget.test.ts`
      Gate: review
      Acceptance:
        - `TrustedRegistry` parses `gateEndpoints` and `publicationEndpoints`. Only `https://` or loopback `http://127.0.0.1:<port>` / `http://[::1]:<port>` URLs pass; userinfo, query strings, fragments, embedded credentials, and relative paths refuse with `CONFIG_SCHEMA`.
        - `CredentialBinding.consumer` accepts `'gate'` and `'publisher'`. The vault resolves those credentials only through a new network-credential accessor and keeps secret values out of every serialized artifact.
        - `ControllerConfiguration.spec.publication` parses both modes; omission defaults to `{ mode: 'disabled' }`.
        - `gate.v1` registers as a `check` implementation with parameters `{ checkId, endpointRef, gateId }` and capabilities `['external_service', 'read_only']`; its digest joins the installed-handler table.
        - `compilePlan` refuses a `gate.v1` handler whose `checkId` lacks `'external_service'` in `allowedEvidenceLevels` or whose `endpointRef` is undeclared. Publication mode `pull_request` without a resolvable endpoint or its signing and auth credentials refuses.
        - `checkpointCapacity` reserves the two publication phases (`D = 6 + 3A + 2J`), and `phaseSchedule` plus `ProgressKind` gain `publication.pre` / `publication.post` and `publication_pre` / `publication_post` as inert entries. Capacity fixtures state the new bounds.
      Verify: `npm run build && npm run typecheck && npm --workspace @loopwright/controller test`

- [x] **T2 · Authenticated gate.v1 protocol**
      Blocked by: T1
      Owns: `packages/controller/src/gate.ts`, `verification.ts`, `acceptance.ts`, `events.ts`, `controller.ts`, `packages/controller/test/gate.test.ts`
      Gate: review
      Acceptance:
        - A `gate.v1` check binds the current candidate subject, records a `read_only` `OperationIntent` with a request digest over the canonical payload, obtains a `DispatchPermit`, and sends a signed `POST` with `redirect: 'error'` to the allowlisted endpoint.
        - Responses verify HMAC-SHA256 through `crypto.timingSafeEqual` plus exact `storeId` / `runId` / `lockHash` / `operationId` / `dispatchId` / `dispatchGeneration` / `checkId` / subject bindings and `expiresAtMs`. Any mismatch, redirect, or non-JSON body refuses without evidence.
        - `pending` polls emit `gate_waiting` events, sleep on bounded deterministic backoff inside `min(maxPollMs, remaining cycle work)`, and renew the store lease.
        - `approved` produces `external_service` evidence (`producerId: 'loopwright.gate-verifier.v1'`, `method: 'verify_external_gate'`, `observedStatus: 'passed'`) plus a persisted receipt artifact. `denied` produces the same evidence with `observedStatus: 'failed'`. `expired`, the poll deadline, and unreachable responses block with `EVIDENCE_UNAVAILABLE` / `GATE_TIMEOUT` and never fabricate `passed`.
        - Tampered, truncated, wrong-key, stale-generation, and cross-run receipts refuse. An interrupted gate poll restores through the retained receipt without a replacement request.
      Verify: `npm run build && npm run typecheck && npm --workspace @loopwright/controller test`

- [x] **T3 · Controlled publication boundary**
      Blocked by: T2
      Owns: `packages/controller/src/publication.ts`, `inspect.ts`, `acceptance.ts`, `progress.ts`, `controller.ts`, `packages/controller/test/publication.test.ts`
      Gate: review
      Acceptance:
        - Publication runs only when `publication.mode === 'pull_request'`, every DAG step completed, acceptance status is `completed`, verification is satisfied with the implicit scope check passed, repository `HEAD` and `baseRevision` still match the lock target, the candidate digest matches the verification subject, and the store reports a trusted clock with zero unresolved requests and operations and zero violations.
        - Disabled mode records `observations.publication = { status: 'not_run', reason: 'disabled', receipt: null }` and never dispatches.
        - Eligible publication computes the deterministic `idempotencyKey`, persists the `external_write` intent and the `publication.pre` checkpoint, obtains the dispatch permit, then sends the signed request.
        - A verified `succeeded` receipt records the operation receipt, re-evaluates acceptance to `externalEffects: 'confirmed'` with status `completed`, and exports `publication.json` through `inspectRun`.
        - An authenticated `not_executed` receipt settles `externalEffects: 'none'` with status `failed` (`PUBLICATION_FAILED`).
        - A timeout, transport error, invalid signature, or unproven `failed` outcome marks the operation `unresolved`, forces `reconcile_required`, and `resumeCycle` never re-dispatches: it returns the retained `reconcile_required` result until reconciliation.
      Verify: `npm run build && npm run typecheck && npm --workspace @loopwright/controller test`

- [x] **T4 · Explicit reconciliation workflow and CLI**
      Blocked by: T3
      Owns: `packages/controller/src/reconcile.ts`, `types.ts`, `index.ts`, `packages/cli/src/arguments.ts`, `main.ts`, `packages/cli/test/arguments.test.ts`, `packages/controller/test/reconcile.test.ts`
      Acceptance:
        - `reconcileCycle` validates configuration, compiles the plan, acquires the owner and recovery authority, restores retained state, and reads the operator receipt file through `readBoundedFile` and `parsePrivateJson`.
        - It verifies the receipt HMAC against the configured signing credential and the exact `storeId` / `runId` / `lockHash` / `operationId` / `intentDigest` / `dispatchId` / `dispatchGeneration` / `candidateDigest` bindings, then calls `store.reconcileOperation`.
        - Confirmed publication reconciliation writes `publication.json`, transitions to `completed`, and exits `0`. Authenticated `not_executed` transitions to `failed` and exits `4`. Any remaining unresolved operation keeps `reconcile_required` and exits `7`.
        - Re-running with the identical receipt succeeds idempotently. A conflicting receipt for an already-confirmed operation refuses with `RECEIPT_CONFLICT` and exits `7`.
        - `loopwright reconcile` parses the documented flags and maps outcomes through the existing exit-code table.
      Verify: `npm run build && npm run typecheck && npm --workspace @loopwright/controller test && npm --workspace @loopwright/cli test`

- [x] **T5 · Documentation and examples**
      Blocked by: T4
      Owns: `docs/controller.md`, `examples/controller.md`
      Acceptance:
        - `docs/controller.md` documents the `gate.v1` protocol, the publication boundary, and the reconcile workflow, including the requirement to re-derive handler digests after each build.
        - `examples/controller.md` shows a registry with gate and publication endpoints, a configuration with the publication block, and the reconcile CLI invocation.
        - No citation references anything outside the repository tree.
      Verify: `npm run build && npm run typecheck && npm run lint && npm test`

### Test Plan
[ ] I/we understand the owners of the involved components may require updates to existing tests to make this
code solid enough prior to committing the changes necessary to implement this enhancement.

#### Prerequisite testing updates
- Capacity-pinned fixtures (`progress-capacity.test.ts`, `scheduling-budget.test.ts`) and the check-only cycle assertions assert derived checkpoint counts. The T1 capacity change updates the derived expectations in the same task. Existing check-only assertions stay valid because disabled publication consumes no phases.

#### Unit tests
- `@loopwright/controller`: 2026-11-09 - every new branch in `gate.ts`, `publication.ts`, `reconcile.ts`, `registry.ts`, `config.ts`, `compile.ts`, `credentials.ts`, and the touched `controller.ts` / `acceptance.ts` / `events.ts` / `progress.ts` / `inspect.ts` paths is covered by `gate.test.ts`, `publication.test.ts`, `reconcile.test.ts`, and the extended config fixtures. The repository has no coverage tool; the target is branch completeness, not a percentage.
- `@loopwright/cli`: 2026-11-09 - `arguments.test.ts` covers the `reconcile` command table, required flags, unknown flags, and invalid combinations. Exit-code mapping stays covered through the existing mapping table.

#### Integration tests
- Gate end-to-end: a loopback `node:http` gate fixture signs `pending`, `approved`, `denied`, and `expired` responses; `runCycle` completes a check-only graph whose required check allows only `external_service`.
- Publication end-to-end: a loopback publication fixture answers `succeeded`, `not_executed`, `failed`, timeout, and invalid signature. Assertions cover `externalEffects`, run status, `observations.publication`, and `publication.json` in the inspect bundle.
- Interrupted publication: the dispatch persists, the store reopens without a response, `resumeCycle` sends no second request and reports `reconcile_required`.
- Reconciliation: `reconcileCycle` resolves confirmed, `not_executed`, and partially unresolved runs. Idempotent replay succeeds, a conflicting receipt refuses, and the CLI exit codes assert `0` / `4` / `7`.

#### e2e tests
None. The controller qualification harness (`npm run test:controller`) already exercises the production CLI against real Git, state, and Workers on this host, and gate or publication endpoints are external services the tests must not contact for real; loopback fixtures inside the integration suites cover the remaining distance. Real remote writes stay prohibited by the Boundaries section.

## Alternatives

- **Use MCP tools inside the agent container to perform pull-request publication**: Rejected because agent processes
  must never hold write credentials or bypass deterministic host-side acceptance verification.
- **Automatically retry failed or timed-out publication requests on `resume`**: Rejected because an interrupted HTTP
  `POST` may have succeeded remotely; only authenticated state reconciliation can determine whether the effect occurred.
- **Trust HTTP 200 status codes from gate endpoints without HMAC receipts**: Rejected because local proxies,
  misconfigured mocks, or stale responses could accidentally approve an unverified candidate tree.

## Open Questions

None.
