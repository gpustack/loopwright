# Pi Runtime Evaluation

Loopwright selects the Pi coding-agent SDK 1.5.0 under state authority. Pi durable 1.5.0 was evaluated and remains unselected. The optional pi-retry 0.11.4 package is disabled and is not installed or imported by this adapter.

This is a private local adapter qualification. State authority remains on its qualified macOS arm64, Node 26.13.0, SQLite 3.54.1 host/boot. SDK, native tools and the fixed workspace MCP server run in separate Linux arm64 containers. The selected graph, image and effective restrictions must match before use.

## Contents

- [Runtime choice](#runtime-choice)
- [pi-retry disposition](#pi-retry-disposition)
- [Finite limits and costs](#finite-limits-and-costs)
- [Qualification commands](#qualification-commands)
- [Live observations](#live-observations)
- [Acceptance map](#acceptance-map)

## Runtime choice

| Concern | SDK selected | Durable evaluated | SDK child evaluated |
| --- | --- | --- | --- |
| Conversation | Native in-memory entries and explicit compaction | Durable tasks and persisted phase context | Durable phases plus a separate SDK transcript |
| Checkpoint/resume | Byte-bound native/workspace snapshot at a settled boundary; caller owns task phases | A declared phase resumes from its start | Restarting the phase cannot imply a new child invocation |
| Sleep/wake | Finite owner retry wait; controller scheduling belongs to later work | Useful durable sleep/checkpoint/wake mechanisms | Child lifetime and receipts still need reconciliation before wake/replay |
| Versioned documents | Host data and later reviewed memory proposals | Useful typed/versioned documents | Document versions do not authorize child/tool effects |
| Admission | Original state authority permits at each physical send/effect | Every durable model/tool path needs the same bridge | Child invocation is itself an effect with original authority and receipts |
| Ownership | Persistent owner/PID/birth guard and exact child cleanup | Exclusive writable durable ownership remains a host precondition | Both stores and old child execution need fencing |
| Crash ordering | Artifacts sync before state authority checkpoint; raw receipt before parser ACK | Durable state and state authority are separate commits | A phase record and child receipt are also separate commits |
| Selected qualification | Native SDK/VM/MCP, controlled HTTP, real state authority and process/container recovery | Source comparison only | Source comparison only |

Durable has useful task, checkpoint, sleep, conversation and document features. Its phase replay does not restore an arbitrary JavaScript call stack or create an atomic transaction with state authority. A resumed phase cannot replace a lost one-use dispatch permit. A state authority lease also does not kill a stale durable process or SDK child.

The selected route closes the required local adapter boundaries with one runtime. This evaluation is not a claim that durable is generally unsuitable. Adoption would require its own physical-send bridge, exclusive storage ownership and cross-store/child crash qualification.

## pi-retry disposition

The package schedules retries, output-length continuations and empty-stop nudges. Its resettable counters and session lifecycle state are not the persistent parent budget. This version does not install an adaptation or fork, import its private hooks, or claim its full hook/reset/reload/backoff matrix passed.

A policy request to enable pi-retry or durable as an extension returns `EXTENSION_UNSUPPORTED` before credentials, environment setup or session startup. A durable adapter selector returns `RUNTIME_UNSUPPORTED`; an undeclared durable/reset field is invalid input. Repository settings and resource metadata cannot add these routes.

The native SDK's own retries are disabled. A terminal 429 may be retried only by the owner, with a new persistent attempt and retained uncertainty for the original request. Length and empty responses create no automatic continuation. Three explicit empty-response commands produced three requests. Length responses in separate SDK sessions retained the same parent count. A second session under an exhausted one-call parent budget sent zero requests. Ordinary errors and oversized responses retained unresolved facts and blocked a new session.

An empty settled response is not useful-output or task acceptance evidence. The controller/verifier still decides whether the task meets its contract.

## Finite limits and costs

| Boundary | Limit |
| --- | --- |
| Public input | Core 1 MiB metadata/shape validation and owned byte copies |
| Final request | 64 KiB and the stricter estimated context check |
| Provider response | 1 MiB per attempt, enforced during read |
| Channel | 64 KiB frames; one active assembly; 256 KiB queued channel/response work |
| Events | 4 KiB each, 128 queued and at most 512 KiB; finite backpressure then terminal `EVENT_OVERFLOW` |
| Tool/MCP arguments and owner-delivered results | 64 KiB each; independent MCP frame/progress/absolute limits |
| Private snapshot | 8 MiB, streamed in acknowledged chunks of at most 32 KiB |
| Resolved artifact inventory | 16 MiB including candidate, resources and snapshots; insufficient capture headroom fails |
| Candidate | At most 256 entries, 8 MiB per file, subject to aggregate/headroom limits |
| Diagnostics | 1 KiB encoded metadata/content with explicit truncation; no raw control/workflow text |
| Retained local state | 1,024 requests, 2,048 operations, 64 checkpoints; no pruning/reset |
| Contained role | 512 MiB memory, one CPU, 64 PIDs; candidate read-only, network none |
| Native VM | 256 MiB heap inside the SDK role; internal output ceiling is 16,777,216 characters, not UTF-8 bytes |

The final owner result limit is distinct from native VM internal buffering. Capture validates rows incrementally and does not retain a second full parsed transcript on the owner. An overflowing transcript fails before another model invocation or safe capture. These are finite data/role bounds, not a claim that the trusted Node host uses only 8 MiB of memory.

At least five fresh-connection samples were taken at 1, 128 and 1,024 retained requests on real local SQLite. Records were populated through public state authority APIs. Capacity samples use exact existing identities and issue no new permit. Population cost and idempotent validation cost are separate measurements.

| Requests | Sample range | Reopen range |
| --- | --- | --- |
| 1 | 0.46–0.77 ms | 0.79–1.22 ms |
| 128 | 14.91–15.51 ms | 15.53–16.11 ms |
| 1,024 | 129.73–138.19 ms | 133.19–135.93 ms |

The retained-state checks grow with the ledger. The measured 1,024-record samples used about 204–213 MB RSS; population sampling reached about 299 MB. Results are local samples, with synthetic usage metadata and no provider throughput or latency SLA. No ledger cache, private SQLite seed, uncertainty pruning or allowance reset was added. A later takeover may use the public terminal-reconciliation lookup instead of the old generation's observe API; that path is labeled separately in each measurement.

## Qualification commands

Build and compile the deterministic tests first. The normal test suite needs no model credentials or Docker.

```sh
npm run test:pi -- --case dispositions
npm run qualify:pi -- --case dispositions
npm run qualify:pi -- --case limits
```

The limits command measures the retained fixture and runs real native queue/response/transcript/diagnostic/deadline and MCP flood controls. If population is incomplete, it returns nonzero with `RETAINED_POPULATION_PENDING`. Repeating the same command continues the same owned store at a complete receipt boundary. It never recreates or prunes the ledger. An explicit `--ledger-dir` selects an already owned fixture. A private local limits-location record can retain that operator selection for later runs.

## Live observations

Live provider acceptance is **BLOCKED: no explicit ready-token source was supplied**. No live/model/count/auth call has been used; the eight-call allowance remains unused. Controlled HTTP proves local serialization/accounting and is not live-provider acceptance.

The optional driver requires both `--estimated-guard` and an explicit `--token-file`. The file must already contain one ready Copilot bearer token, be a regular owner-only file with no links, and pass bounded local validation. The driver does not search environment credentials or auth stores, exchange tokens, refresh credentials, call a token-count endpoint, open a browser or log the token. The token stays on the host; SDK workers receive only a non-secret placeholder.

```sh
npm run qualify:pi:live
npm run qualify:pi:live -- --estimated-guard
```

Both commands currently return exit 2 and a machine-readable BLOCKED reason before transport. A trusted operator can supply the explicit ready-token file and choose `--model claude-sonnet-5.5` or `--model claude-opus-5.5`, and `--case selection|tool|compact|cancel`.

The live driver retains one state authority parent and an independent append-only eight-attempt allowance in private local storage. It spends a conservative attempt before credential delivery, has no reset flag, and preserves uncertainty on interruption. A command allows one potential send, or at most two for the tool-loop probe. Each actual send still uses the original owner permit, at most 90 seconds and a serialized output cap of 1,024. A new session or process cannot refund a prior spend.

Successful cases capture known safe entries for the same model/role. Compaction requires existing suitable history and never creates hidden warm-up prompts. Unknown provider/tool state blocks later probes until explicit evidence-based reconciliation. Preserve the retained live directory; deleting it is not a retry mechanism.

Requested/catalog/session/outgoing settings, transport invocations, declared response identity, usage provenance and local cleanup remain separate observations. A public parser's selected model is not proof of provider-internal execution or billing finality. An abort is not evidence of remote non-execution or zero charge.

## Acceptance map

| Acceptance | Local evidence | Live/source boundary |
| --- | --- | --- |
| A01 | Pinned artifact/catalog, native session and actual finalized request selection | Live blocked; internal model/effort unknown |
| A02 | Empty native compiler namespace, discovery-positive poisoning controls, immutable loader and byte-bound restore | No ambient configuration acceptance |
| A03 | Actual serializer/parser, real controlled HTTP, original state authority permits, retries and SIGKILL receipt gaps | Synthetic fixture counts are not bills |
| A04 | Real read-only mounts, denied host/credential/egress/process paths and exact descendant cleanup | No deployed-host/kernel/tenant/hardware acceptance |
| A05 | Real native MCP/codemode, allowed nested reads, denied hidden/search writes, helper denial and idle/absolute/flood controls | Local fixed read-only server only |
| A06 | Actual final settle, bounded events, safe native capture/restore, PID/birth guard and owned crashes | No arbitrary call-stack or remote host-loss recovery |
| A07 | Strict default refusal, explicit immutable estimate, complete final-body coverage, failure latches and same-mode compaction | Estimated context fit remains unproven; live blocked |
| A08 | Production enablement refusal and native empty/length/error/no-reset controls with plugin absent | Full pi-retry integration deliberately not claimed |
| A09 | SDK route selected and locally qualified under state authority | Durable alternatives are source-evaluated and unselected |

Remote authenticated sinks and deployed/host-loss recovery belong to later owners. Token-bearing MCP configuration interpolation remains state authority work. Interactive MCP OAuth remains open; this local read-only MCP route does not implement login or refresh.

The [state authority specification](../specs/2026-11-05-isolated-pi-adapter.md) contains the frozen API, trust boundaries and acceptance requirements. The [state protocol](state.md) defines the persistent authority consumed by all these routes.

**See also**: [Documentation index](README.md)

**Next**: [Architecture](getting-started/architecture.md)
