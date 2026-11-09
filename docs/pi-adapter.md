# Isolated Pi adapter

`@loopwright/agent-pi` is a private workspace package. It preserves v1 `openPiAdapter` with fixed local stdio MCP and adds v2 exports for S04 controller integration.
It executes one admitted role under the original TaskLock and S02 owner. The caller evaluates task acceptance.
SDK 1.5.0 is selected; durable is unselected and pi-retry is disabled. See the [runtime evaluation](pi-runtime-evaluation.md).
The [architecture decision](adr/0002-isolated-pi-sdk.md) records the alternatives and accepted costs.

## Supported profile

| Component | Qualified boundary |
| --- | --- |
| Trusted owner and S02 | macOS arm64, Node 26.13.0, bundled SQLite 3.54.1; one host/boot, retained local disk |
| SDK, native VM, tool and MCP roles | Pinned Linux arm64 image under Docker Desktop; separate containers |
| Provider route | GitHub Copilot, Anthropic messages HTTP; Sonnet 5.5/xhigh or Opus 5.5/high |
| Context | Strict `proven_bound` default refuses; explicit immutable `estimated_guard` is available |
| Accounting | `soft_only`; hard token admission and hard money limits are unsupported |
| Tools | Exact role/policy intersection of read, bash, write, edit, codemode and `mcp__workspace__read_file` |
| MCP | v1: fixed local read-only stdio server; v2: approved sessionless HTTP JSON route |

Requested, catalog-supported, session-effective and outbound-observed selection are separate capability fields.
Outbound identity remains null until an admitted request is observed. These fields do not attest provider-internal effort.
Local controlled HTTP and container qualifications passed. Live provider observations remain blocked without an explicit ready-token source.

## S04 v2 controller and HTTP MCP exports

`openPiAdapterV2(host, input)` opens the v2 adapter. `PiHostV2.resolveMcpCredential(binding)` is the dedicated
host callback for an MCP bearer token, separate from the provider's `resolveCredential` callback.

The `sessionless-http-json-v1` MCP policy specifies `destinationRef`, `endpoint`, `approvedAddresses` and
`credentialRef`. Loopback `http://127.0.0.1:<port>/...` or `https://<dns-hostname>/...` (using SNI equal to the
endpoint hostname and system trust roots) is required. Connections use a pinned approved IP; redirects,
SSE, OAuth and session headers are unsupported. The host retains credentials and mediates the HTTP route.

`describePiAdapterFiles()` returns `sdkIntegrity`, `restrictionDigest` and `localMcpScriptDigest` for static registry
authoring. `decodePiCapture(input)` verifies and decodes retained native checkpoint workspace/session artifacts offline,
without opening Docker or an adapter session. Neither static description nor decoding qualifies a live provider.

## Trust and execution

The trusted host opens state, supplies current Authority, resolves a ready credential, controls exact containers and sends HTTP.
SDK workers serialize requests and propose effects. They have network none and no state, credential or Docker socket access.
The sender admits only POST to `https://api.individual.githubcopilot.com/v1/messages?beta=true`, without redirects.
Every physical attempt receives its own original one-use S02 permit after final bytes and current authority are checked.
Native retries are disabled. The owner's bounded terminal-429 retry consumes a new parent attempt and preserves the original charge.

All roles mount the entire candidate read-only. `read` and `bash` use separate tool containers and fresh scratch per call.
Shell output is never promoted into candidate files. Only mediated write/edit can change allowed paths, using core scope rules,
protected-path checks, no-follow regular files, synced atomic replacement and a separately admitted local-write operation.
No repository command or package hook runs on macOS.

Containers use UID/GID 1000, read-only root, no capabilities, no-new-privileges, explicit seccomp, one CPU, 512 MiB memory,
64 PIDs and bounded noexec tmpfs. Host HOME, credentials, state and engine sockets are absent. The trusted host and daemon remain prerequisites.
This profile does not establish hostile-kernel, deployed tenant or remote host-loss isolation.

Native factories compile once in an owned empty namespace with private HOME and project trust false.
All discovery roots must already be empty or trusted before package resolution. The final admitted cwd and ResourceLoader
retain the actual native runtime/event bus and immutable declared resources. Filtering after load cannot undo code execution.

## Host construction

Create or explicitly reopen the same local run through the [state protocol](state.md#host-protocol), then claim current active authority.
Its compatibility binding must include adapter `pi` version `0.0.0` and the same resourceVersion as the adapter policy.
Do not discard an old store or replace its clock/deadline to start another session.

`PiHost` contains the opened store, Authority, absolute Docker executable/socket, exact RuntimeIdentity and two owned canonical
directories. Use a fresh runtime `directory` for each opened adapter and one stable private `artifactsDirectory` per retained run.
The directories must be owner-only and outside untrusted writable roots. Preserve artifacts and the execution-owner guard across crashes.
The caller releases its S02 owner only after adapter cleanup completes; closing the adapter does not release state authority.

`resolveCredential(binding)` is a trusted host callback. Its input includes provider, model, exact destination, purpose,
run/role/step, monotonic expiry and AbortSignal. Return one already-ready bearer token under those limits. The resolver must bound
its own work and honor abort; it cannot use repository text or model output to select a destination. The token remains on the host.
The adapter does not read environment credentials, refresh an auth store, open a browser or implement an auxiliary auth exchange.

`PiOpenInput` includes version, lock, role/step/session IDs, complete frozen policy, candidate manifest/bytes, declared resource
refs/bytes and optional restore artifacts. Metadata must be plain, alias-free data. Digests, path topology, source/base revisions
and role grants are validated; bytes are copied. Unknown fields, getters and shared buffers fail before startup.
The [public type source](../packages/agent-pi/src/types.ts) and [specification](../specs/2026-11-05-isolated-pi-adapter.md#host-contract-and-enforcement)
define every required policy field, fixed preamble identity and limit. There is no default permissive policy builder.

RuntimeIdentity binds the SDK integrity, SHA256 of exact package-lock bytes, derived image ID, canonical restrictions digest and
Linux arm64 profile. A trusted operator freezes these after image qualification. Hashes and paths supplied by a repository
cannot establish that trust. Frozen resources must contain exactly the built-in preamble followed by admitted context resources.
The matching resource bytes enter context as literal data and cannot install extensions or widen tools.

## Commands and outcomes

| Method | Caller responsibility and result |
| --- | --- |
| `capabilities()` | Inspect frozen selection, runtime, resources and supported restrictions; no send |
| `execute({commandId,text,purpose,repair})` | Supply a new bounded literal command and trusted attribution; includes separately admitted tool-loop requests |
| `compact({commandId})` | Explicit same-policy/model summary; one separately admitted compaction, no hidden warm-up |
| `events()` | Consume the single metadata iterator while work runs; no assistant text or raw SDK events |
| `capture({checkpointId})` | Require a settled, accounted boundary and retain returned private refs/bytes |
| `cancel({reason})` | Revoke further effects, abort and clean exact owned work; retain possible remote effects |
| `close()` | Idempotent cleanup; inspect the result before releasing state ownership |

Execute and compact use the remaining original task deadline for the whole command; each physical provider send still
has its own cap of 90 seconds. Tool/MCP limits are separate, and long waits rearm within Node timer bounds.
Execute, compact and capture are serialized; concurrent commands return `SESSION_BUSY`. Slash-command input is rejected.
An `execution_settled` execute outcome requires actual `agent_settled`, idle native state and all parser acknowledgements. Manual compact uses its
actual successful manual `compaction_end`, idle state and acknowledgements; the SDK emits no standalone settled event for it.
Empty output can settle execution without satisfying the task. Length, context, parser and incomplete-tool failures cannot settle successfully.

`PiResult` errors describe preflight/API misuse, such as an invalid command or a busy/closed handle.
After a valid command starts, its value is a `PiOutcome`: execution_settled, failed, cancelled, blocked or recovery_required.
Every outcome retains bounded request/operation ID lists, provider termination, usage and local cleanup. Its `error` preserves
the execution cause and underlying state code; `cleanupError` separately records a cleanup failure. `localCleanup` is complete,
pending or failed. A cleanup failure cannot replace the original cause or claim complete cleanup.
Token usage is complete only when every request in that command has accepted S02 input/output counts. Raw candidates or
a published final artifact alone do not prove accounting; rejected or uncertain observations remain incomplete. This says
nothing about final cost or billing, and does not include unrelated earlier requests.
Idle cancel preserves the prior terminal status, request facts and execution error, updating actual cleanup only. An active
cancel follows that exact command through drain; repeated calls cannot substitute an earlier turn. Unknown effects or failed
cleanup still require recovery. With no prior or active command, cancel returns an empty cancellation outcome.
A settled command may keep an idle SDK/MCP session open; `close()` separately verifies final container cleanup.
Keep execution, provider termination, usage and local cleanup separate. A retryable error grants no new permit or permission to replay.
Unknown cache/input/output/cost fields stay unknown. Local cancel, exit0 or container removal cannot establish zero billing or remote non-execution.
See the [host lifecycle example](../examples/pi-adapter.md) for result and cleanup handling through public imports.

Fresh endpoint canonicalization or Engine-query failure returns `CONTAINMENT_UNAVAILABLE` and removes the uninitialized
guard. A retained binding/legacy/identity refusal returns `RECOVERY_REQUIRED` and preserves its guard and state.

## Capture and recovery

Capture validates every bounded native session row and tool pair, writes synced immutable session/workspace artifacts, then
publishes their refs through S02. Unreferenced artifacts grant no restore authority. A committed checkpoint with a lost ACK is looked up by identity.

Restore supplies the retained checkpoint ID, workspace/session refs and authenticated bytes, plus candidate bytes matching the
captured manifest. Runtime, policy, resources, lock, role, original clock and authoritative current checkpoint must still match.
Restore uses public in-memory native session construction and never calls prompt/resume automatically.
Later known charges remain retained. Missing bytes, unresolved work, changed identity or expired original deadline blocks execution.

The persistent execution guard records owner PID/birth/boot and exact container/attach identities before delivery.
Private execution-owner header version 2 retains the canonical original socket and bounded Engine ID before any child starts.
Recovery rejects a changed/unknown/legacy binding before daemon calls. At the same endpoint, it checks public `info.ID`
through private config and bounded sanitized CLI, then rejects an identity mismatch or query failure before any container operation.
Original guard/state remain unchanged on refusal; legacy unbound guards require explicit safe intervention, not migration/reset.
Alias socket paths are refused. Engine ID is local consistency evidence, not attestation; the trusted operator must keep the
endpoint and daemon stable throughout each guarded operation. Malicious daemons or concurrent administrative retargeting are unqualified.
A live previous owner blocks replacement even after S02 lease expiry. Dead-owner recovery requires exact child exit and absence.
Missing birth/exit evidence requires explicit safe intervention; a TTL or broad name match never authorizes deletion.

## Context and finite limits

The omitted context mode is strict and currently returns `CONTEXT_UNSAFE` before startup. Explicit estimated mode uses final
HTTP JSON bytes B: B <= 65,536 and B + 32,768 + 16,384 + O <= min(model window, policy window, 98,304), with O <= 1,024.
At the default window and output cap, the inclusive B limit is 48,128 bytes. Each serialized system/message/tool/signature byte counts.
This is an estimate with operational headroom. It permits possible post-send overflow or curtailed output and supplies no billing bound.
An unrecognized shape refuses rather than stripping fields or switching modes. Explicit compaction must pass the same guard.

Every physical attempt persists a content-free ContextAssessment in immutable context/raw/final receipts and emits
`context_assessment` metadata. It contains estimator/version/provenance, B/I/O/C, margins, byte/headroom inequalities,
coverage, model/catalog/policy identity and the finalized-body digest. Refused covered bodies retain the same numbers
without gaining a request permit. Unsupported coverage records that refusal, with null assessment when safe assessment
is unavailable. Strict default preflight refusal occurs before a handle/event stream exists. Capabilities name the estimator;
these metadata records are available independently of their digest and contain no prompt, schema, signature or credential bytes.

Responses stop at 1 MiB; tool arguments/results at 64 KiB. Events are at most 4 KiB each, with 128 queued/512 KiB total and
finite backpressure, then terminal `EVENT_OVERFLOW`. Private session capture is at most 8 MiB in acknowledged 32 KiB chunks;
resolved artifacts together must fit 16 MiB. An overflowing history blocks another request and safe capture.
Transport frames and pending-channel work are fixed at 64 KiB and 256 KiB. Different requested values are unsupported;
other ceilings may be tightened within their validated minima. Diagnostics below 64 bytes are unsupported.
See [measured limits and costs](pi-runtime-evaluation.md#finite-limits-and-costs) for retained-state growth and native VM bounds.

## Qualification setup

Run installation, build, typecheck, lint and tests from the repository root on the qualified macOS profile.
The normal suite includes deterministic adapter tests and needs no Docker or model credential.
Native qualification expects Docker on PATH. All qualification execution and cleanup use one selected local socket:
`LOOPWRIGHT_PI_DOCKER_SOCKET` if explicitly set, otherwise the current user's `$HOME/.docker/run/docker.sock`.
The selection must be an absolute local path. New owned registries retain it before creation; cleanup uses that recorded
daemon and never substitutes a new default. Another host still needs qualification of its state/runtime profile.
Create an empty owner-only `.claude/s03-t0/docker-client` directory for these local fixtures. Do not copy the operator's Docker auth configuration.
Provision the exact Linux arm64 base `node@sha256:067b2d425f1204b5a898ae3d3145f7524c1425a4096a62b0f67dd4344a494440` through an approved artifact path first.
Image building is local, network none and pull false. The resulting image ID is written to `.claude/s03-t0/runtime-image.id`.
These are generated operator configuration/artifact locations, not portable evidence citations.

```sh
npm run qualify:pi -- --case all
npm run qualify:pi -- --case physical-sends
npm run qualify:pi -- --case containment
npm run qualify:pi -- --case mcp
npm run qualify:pi -- --case recovery
npm run qualify:pi -- --case dispositions
npm run qualify:pi -- --case limits
npm run qualify:pi -- --case admission-mutations
npm run qualify:pi:live
```

`all` runs the image build, both model selections and every non-live case in the registered runner. Each case has its own deadline;
the runner stops nonzero on failed or blocked prerequisites and retains owned identity records. Clean only exact registered IDs/nonces.
The retained limits fixture can require several bounded population invocations; repeat the same command and preserve its store.

The live command defaults to BLOCKED. An explicit estimated-mode/ready-token invocation is separately bounded by the original
eight-attempt allowance and 90-second per-send cap. It is excluded from all deterministic/native totals.
No live-provider, deployed-host, remote-sink, host-loss or billing-finality acceptance follows from local test success.

## Qualification inventory

`--case admission-mutations` is a bounded final check of the current compiled owner/send-once guards. It retains original
fingerprints, counts real controlled HTTP, proves each mutated guard changes behavior, and deletes its exact temporary modules.
It runs in `all` beside the four context/parser mutations. `session-mutations.mjs` is a historical T1 diagnostic, and
`factory-gate.mjs` preserves the closed native-factory investigation. They are not final entrypoints or newly executed proof;
the latter's legacy finish assertions predate structured outcomes. Current final native sessions still use the real factory path.

## Current backend and future execution modes

Docker is this adapter version's implemented backend. It is not a universal Loopwright product requirement.
The current public PiHost requires Docker executable/socket fields. RuntimeIdentity and snapshot/request policy bind an image,
Linux arm64 profile and restriction digest; cross-backend restore is therefore unavailable. Tool capability literals encode
read-only candidate, mediated writes and per-call scratch. Provider/MCP paths use `/workspace/candidate`, while retained execution
ownership uses macOS PID birth and boot observations. The existing environment/session constructor seam is internal.

A future direct mode for operator-provided dedicated environments is planned before lightweight OS sandboxing. No such backend,
Kubernetes/GPU execution or Linux state owner is implemented or qualified here, and no global sandbox-off default is selected.
Future capability design must distinguish GPU/toolchain access, filesystem/network isolation, cleanup and resource ceilings.
A task requiring isolation must refuse an incapable backend; direct execution alone cannot prevent same-privilege code from
bypassing mediation, reading credentials or changing state. Common admission, budgets, events, deadlines and recovery remain
separate responsibilities. These are later design constraints, not claims that an executor abstraction already exists.
