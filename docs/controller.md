# Local controller and CLI

The private `@loopwright/controller` workspace compiles an explicit trusted configuration and runs a finite task graph.
Core constructs the acceptance result, state owns the original admission/budget/clock, and the Pi adapter owns request
and contained-tool dispatch. Controller progress stores identities and evidence references; it grants no extra calls,
tokens, repair attempts or time. The qualified state profile remains macOS arm64, Node26.13.0/SQLite3.54.1 on one boot.

S02 charges repair allowances per admitted SDK request. One implementation repair command can require a write turn
and a submission turn, consuming two implementation repair requests. The controller separately bounds commands
with `maxAttempts`; disabling implementation repair preserves the independently observed failed acceptance result.
A counted 429 retry can leave the original token charge unknown. Under the current S02/S03 contract, the controller
retains that charge and returns `RECOVERY_REQUIRED` (CLI exit7); it cannot capture or resume unresolved accounting.

## Public API and configuration envelopes

`@loopwright/controller` exports `CONTROLLER_API_VERSION` (`loopwright.dev/controller/v1alpha1`) and:

- `loadTrustedConfiguration({ configPath, registryPath, registrySha256, untrustedRoots })`
- `compilePlan(loadedConfiguration)`
- `runCycle({ configuration, repository, runRoot, runId, signal?, onEvent? })`
- `resumeCycle({ configuration, repository, runRoot, runId, signal?, onEvent? })`
- `reconcileCycle({ configuration, runRoot, runId, receipt })`
- `readStatus({ runRoot, runId })` and `inspectRun({ runRoot, runId, output? })`

`ControllerConfig` and `TrustedRegistry` envelopes both use that `apiVersion`. The registry's
`spec.environmentBindings` approves variable names, their `credential` or `nonsecret` classification, and exact
JSON-Pointer `paths` in configuration string values. Interpolation is single-pass: `${NAME}` substitutes an approved
environment variable without rescanning its value, `$$` produces `$`, and `$${NAME}` produces literal `${NAME}`.
A bare `$` is literal. Names match `^[A-Za-z_][A-Za-z0-9_]*$`; malformed `${...}` and shell defaults such as
`${NAME:-x}` fail with `CONFIG_ENV_SYNTAX`. A `$` followed by something other than `$` or `{`, including `$(...)`,
is literal.

Registry `spec.credentialBindings` ties each `id`, `consumer` (`provider`, `mcp`, `gate` or `publisher`), `destinationRef`,
`environmentNames` and `template` to a `{ ref, template }` entry in `ControllerConfig.spec.credentials`.
Resolved secrets stay in the private host vault and out of `CompiledPlan`. See the
[configuration example](../examples/controller.md#configuration-and-mcp-credential-authoring).

After `npm install` and `npm run build`, use `node packages/cli/dist/main.js` or the workspace `loopwright` bin:

```text
loopwright init --directory DIR [--force] [--json]
loopwright check --config FILE --registry FILE --registry-sha256 HEX [--json] [--output FILE]
loopwright run --dry-run --config FILE --registry FILE --registry-sha256 HEX [--json] [--output FILE]
loopwright run --config FILE --registry FILE --registry-sha256 HEX --repo DIR --run-root DIR --run-id ID [--json]
loopwright status --run-root DIR --run-id ID [--json]
loopwright inspect --run-root DIR --run-id ID [--json] [--output DIR]
loopwright resume --run-root DIR --run-id ID --config FILE --registry FILE --registry-sha256 HEX --repo DIR [--json]
loopwright reconcile --config FILE --registry FILE --registry-sha256 HEX --repo DIR --run-root DIR --run-id ID --receipt FILE [--json] [--output FILE]
```

Paths and stable IDs are explicit. There is no latest-run selection or configuration discovery. Registry bytes must be
owned/private and outside the repository, task directory and working directory, with an explicitly approved SHA256.
The run root is private and outside those writable roots. Unknown/duplicate flags and extra positional arguments fail.
`init` produces named review drafts with no credentials or approved runtime/handlers. Its strict proven_bound default
has no live proof. The draft README identifies the missing approvals; estimated context requires explicit operator opt-in.
`--force` replaces only named generated regular owned files. Other outputs use no-overwrite creation.

`check` and `run --dry-run` perform no admission, Docker query or network call. Their plans show ordered nodes, budgets,
capabilities and evidence needs. Private role command bytes are represented by SHA256 placeholders. The approved
registry digest binds the original bytes, and execution verifies the placeholder before retaining the original command
privately. Static support/readiness fields do not establish that a Docker runtime or provider is currently available.
See [controller acceptance authoring](../examples/controller.md) for required no-change proof and JSON header bounds.

Run/resume emit bounded public progress; JSON mode emits version1 envelopes with kind, sequence, runId and data.
A terminal envelope is result, diagnostic or incident. Human output escapes untrusted text and contains concise status.
Cancellation revokes new work and attempts bounded drain/cleanup under the original deadline. An uncertain request,
provider termination or cleanup remains reconcile_required or an incident even after SIGINT/SIGTERM.

| Exit | Meaning |
| --- | --- |
| 0 | Static command succeeded, or completed/no_change result |
| 2 | Usage/configuration rejection |
| 3 | Unsupported capability or blocked task |
| 4 | Failed acceptance/execution |
| 5 | Exhausted allowance |
| 6 | Expired deadline |
| 7 | Reconciliation/ownership needed |
| 8 | Authoritative result/state unavailable or incident |
| 130 /143 | Accounted SIGINT/SIGTERM cancellation, subject to uncertainty precedence |

Resume reopens the exact retained store and original clock, registry/runtime/source binding and artifacts. It refuses
live/unverifiable owners, torn or substituted artifacts and unaccounted effects. A completed native capture is adopted
without another model request. A verified original verifier receipt is reused. A pre-command boundary with no effect
may issue its original not-started command once. No saved dispatch marker becomes a new permit. Failure signatures and
consumed progress phases survive resume. Unsupported old progress versions remain unsupported; no migration resets caps.

`status`/`inspect` need no configuration or credentials and never claim/renew ownership, start a worker or query Docker.
They describe current state or label retained/unavailable facts. Successful inspection can describe a failed run and
exit0; unavailable authority exits8. An explicit inspect output directory receives a hash manifest and bounded public
lock/plan, candidate bytes, verification/result, usage, checkpoint metadata and events when available. Optional absent
or not-run artifacts are listed with reasons. SQLite, private native sessions, command bodies and ownership nonces
are excluded. Bundle hashes identify bytes; a bundle does not create run authority.

## Authenticated gates, publication and reconciliation

A `gate.v1` check handler delegates a required check to an operator-operated external gate. Its parameters bind
`checkId`, `endpointRef` and `gateId`; its capabilities are `external_service` and `read_only`. The referenced
check must allow the `external_service` evidence level. The controller sends one signed request per poll
(`x-loopwright-signature`, HMAC-SHA256 over the canonical body with the endpoint's `gate` signing credential),
with `redirect: 'error'`, a per-request `timeoutMs` bound and verdicts `pending`, `approved`, `denied` and `expired`.
Polling sleeps on deterministic exponential backoff between `pollInitialMs` and `pollMaxMs` plus bounded jitter, inside
a poll window of `min(maxPollMs, permitLease - 2000ms, remainingTaskTime - drainReserveMs - 2000ms)` (about 58s under
the 60s store lease), renewing the store lease and emitting `gate_waiting` events whose detail carries the effective
`deadlineMs`. `approved`
produces `external_service` evidence with `observedStatus: 'passed'`; `denied` produces `failed`; everything else
blocks with `EVIDENCE_UNAVAILABLE` or `GATE_TIMEOUT`. Verdict signatures, exact store/run/lock/operation/dispatch/
check/subject bindings and `expiresAtMs` are verified with constant-time comparison; any mismatch never produces
evidence. Endpoint URLs must be exact `https://` or loopback `http://127.0.0.1:<port>`/`http://[::1]:<port>` with
no userinfo, query, fragment or embedded credentials.

Publication is opt-in: `ControllerConfig.spec.publication` with mode `pull_request` names a registry
`publicationEndpoints` entry. It runs only after the acceptance result is `completed`, every graph node and the
implicit scope check passed, the trusted clock reports zero unresolved work and violations, and repository `HEAD`
still equals the lock's `baseRevision`. The controller records the deterministic idempotency key, persists the
`external_write` intent and a `publication.pre` checkpoint before authorizing the single dispatch, then sends one
signed request. A verified `succeeded` receipt confirms `externalEffects`; an authenticated `not_executed` receipt
settles the run as `failed`; a timeout, transport error, invalid signature or unproven `failed` outcome marks the
operation `unresolved` and forces `reconcile_required`. The POST timeout is clamped to
`min(timeoutMs, permitLease - 2000ms, remainingTaskTime - drainReserveMs - 2000ms)` so a slow publisher can never
outlive its dispatch permit. Resume replays retained receipts, never re-dispatches, and
`inspectRun` exports `publication.json` from the journal truth when a receipt is confirmed.

`loopwright reconcile` settles an unresolved publication with an operator-supplied receipt file: the exact signed
`publication_receipt` document plus its `signature`. It also settles an interrupted `gate.v1` check with a signed
`gate_verdict` receipt; a reconciled gate resumes the remaining cycle, including publication when configured, so
reconciling an interrupted gate must run before `resume` (which settles an interrupted read-only gate fail-closed as
`GATE_TIMEOUT`). `reconcileCycle` re-derives the idempotency key, verifies the
HMAC and every binding, and settles through the journal. Exit codes follow the table: `0` for a confirmed
publication or an approved gate, `3` for a blocked run, `4` for an authenticated `not_executed` or denied gate,
`7` for anything still unresolved. Re-running with the same
receipt succeeds idempotently; a different receipt for an already-settled operation refuses with `RECEIPT_CONFLICT`
(exit7). Reconciling an uncertain publication on a run that ended in an immutable incident records the verified
receipt in the journal and `publication.json` while retaining the incident and returning `unresolved`
(`reason: 'incident_retained'`, exit `7`). A publication whose response claims `failed` stays unresolved on purpose: the controller cannot prove that
nothing was created remotely.

Adding controller source files changes every installed handler digest, because digests cover the whole dist
inventory. Registries that embed handler digests must be re-derived after each build; fixtures and examples derive
them at runtime. See the
[configuration example](../examples/controller.md#configuration-and-mcp-credential-authoring) and the
[gate and publication example](../examples/controller.md#authenticated-gates-and-publication).

### Wire schemas and signatures

Gate requests and publication requests are JSON documents signed with the endpoint's signing credential:
`x-loopwright-signature` carries the lowercase hex HMAC-SHA256 of the exact request/response body bytes, optionally
prefixed with `sha256=`. Verification is constant time; uppercase hex, trailing garbage and short signatures fail.
A `gate_request` binds `storeId`, `runId`, `lockHash`, `operationId`, `dispatchId`, `dispatchGeneration`, `gateId`,
`checkId`, `candidateDigest`, the full `subject`, and a `requestDigest`. A `gate_verdict` echoes those bindings and
carries `status` (`pending`/`approved`/`denied`/`expired`), `reason` (null unless the verdict is final) and a
wall-clock `expiresAtMs`; `approved` verdicts must be within `[now, now + 24h]` of the controller's sampled wall
clock or they are discarded. A `publication_request` binds the same store/run/lock/operation/dispatch identity plus
`idempotencyKey`, `targetBranch`, `headBranch`, `title`, `candidateDigest`, `baseRevision` and `sourceRevision`.
A `publication_receipt` echoes those bindings and carries `outcome` (`succeeded`/`not_executed`/`failed`),
`externalUrl` (null or at most 512 characters) and `reason`; `candidateDigest` is optional on operator receipt
files (always bound through the idempotency key, and verified directly when present). Responses must be
`application/json` at most 16384
(request) or 65536 (publication) bytes with a matching signature header; anything else is refused or blocks the
check without evidence. Operator receipt files contain the exact signed receipt document plus a `signature` field;
the file must be a regular, non-symlink file of at most 65536 bytes. Live HTTP `x-loopwright-signature` headers
sign the exact wire JSON bytes (`<hex>` or `sha256=<hex>`), whereas operator receipt files carry a top-level
`signature` field computed over the canonical receipt document without the `signature` key.

Offline tests include public check-only run/resume, real Git/S02/Workers, CLI subprocesses and export integrity. They
establish those local behaviors. Native Pi/provider/MCP qualification is recorded separately and cannot be inferred
from the unit total or a static plan. Live-provider qualification requires its separate explicitly approved credential
source; no CLI command implicitly publishes or applies external changes.
