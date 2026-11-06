# Spec: Isolated Pi adapter and controlled execution

Status: Shipped
Type: Feature

## Summary

Add a Pi adapter that executes an admitted role under a frozen resource and execution policy.
Compare the coding-agent SDK and pi-durable runtimes before selecting the implementation route.
Every model request must pass the persistent state authority before transmission.
Tools must execute within verified filesystem, process, network and credential boundaries.
The adapter reports bound events, usage and outcomes to its caller. It does not decide task acceptance.

## Motivation

### Goals

The task contract states what is allowed. Persistent state retains ownership, budgets and uncertain requests.
Neither package currently enforces these rules at a real model or tool execution boundary.
This adapter connects those contracts to Pi without granting the model control over its own authority.

Target users are controller authors and operators running bounded coding tasks on a trusted local host.
Success means the actual SDK path rejects unauthorized requests and tools, survives defined interruptions,
and reports uncertainty without replaying effects or claiming that a task passed.
Context assessment defaults to proven_bound. Explicit estimated_guard opt-in accepts possible post-send context overflow or curtailed output;
it does not change budget authority or advertise a proven input-token bound.

### Non-Goals

- Business DAG scheduling, implementation repair policy, a product CLI or final acceptance orchestration.
- GitHub publication, external side-effect reconciliation services or deployed multi-tenant infrastructure.
- Host-loss recovery, portable state storage, transparent session migration or exactly-once remote execution.
- Arbitrary third-party extension loading, arbitrary remote MCP servers or autonomous package installation.
- Memory curation, semantic compaction quality, optional decision models or benchmark performance claims.
- GPU workloads, image publication, GitHub Actions workflows or CI/CD configuration.

## Proposal

Provide a private workspace package, `@loopwright/agent-pi`, with a small validated host interface.
It consumes a core TaskLock, a selected role and step, current state authority, and a frozen adapter policy.
The SDK reference route uses one isolated SDK host per active session.
The implementation plan compares this route with a pi-durable runtime under the same state authority.
Trusted host services retain state and execution authority in either route.
Untrusted repository code and model-selected commands cannot access those services as privileged callers.

The plan must define precise process placement and transport before implementation.
The SDK host may be trusted code outside a tool container if all untrusted execution is separately contained.
Running a Node subprocess alone does not qualify it as a sandbox.
No untrusted extension may share a process with the state owner or credential authority.

The state store remains on its qualified macOS arm64 host and boot.
Linux tool containers do not open the state database or interpret the host's monotonic clock directly.
The adapter must not expand the state's runtime allowlist to make a container test pass.

### User Stories

#### Story 1
As an operator, I want exact model, thinking, context and tool selection, so that runs use the admitted policy.

#### Story 2
As a controller author, I want every provider attempt recorded before transmission, so that retries cannot reset budgets.

#### Story 3
As a repository owner, I want generated commands contained, so that task code cannot read credentials or alter host files.

#### Story 4
As a controller author, I want final session events and uncertain outcomes distinguished, so that I do not resume work twice.

#### Story 5
As an operator, I want optional retry extensions evaluated against the same contract, so that recovery does not bypass limits.

### Core Features & Acceptance Criteria

#### A01: Frozen runtime and explicit capability checks

- Pin the SDK package, direct companion packages, dependency lock, runtime and selected execution image identity.
- Adopt `@earendil-works/pi-coding-agent@1.5.0` as the candidate artifact. Verify its registry integrity before use.
- The observed candidate integrity is `sha512-xNDZ5kqowO6Z03FS2gwAkPEGk1ssxVcYKQ6qZId84mFEvwACvvyc2l0vAMOS+c5zvxLRMLBE9r4y44IGYkMJaQ==`.
- Freeze resource contents, extension sources, configuration, licenses and compatibility assumptions in a versioned adapter policy.
- Resolve the requested provider/model explicitly. Missing catalog entries fail before session creation or network transmission.
- Compare requested selection with the effective session model and thinking. Reject fallback, clamping and unapproved switching.
- Verify the outbound request's applicable model/output/thinking settings at the trusted transmission boundary.
- Separate requested, catalog-supported, session-effective and outbound-observed facts. Provider-internal effort remains unknown.
- Advertise hard token admission only when the supported route proves complete billable-token bounds and output enforcement.
- Otherwise advertise soft accounting. A hard-token contract must fail preflight without a provider request.
- Unsupported tool, MCP, extension, platform or model combinations fail explicitly. There is no permissive fallback.

#### A02: Explicit resources and immutable authority

- Load only the TaskLock's admitted context resources and the frozen host policy. Verify content bytes against their digests.
- Disable implicit global, parent-directory and project discovery for instructions, skills, prompts, themes and extensions.
- The sole exception is a one-time public native inline-factory compilation in a controlled empty container namespace.
  Project trust is false; all automatic roots are empty or immutable trusted image content before loading.
  The final role loader does not discover resources. Post-load filtering cannot compensate for untrusted execution.
- Include `AGENTS.md`, `CLAUDE.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`, settings, package resources and model catalogs in the controls.
- In-memory settings alone do not prove that an extension stopped reading settings files itself.
- Use a private controlled agent directory and session location. Do not inherit the operator's HOME or credential stores into tools.
- Treat repository text, tool output, MCP metadata and session content as data. None may change the lock, caps or authorization.
- Do not expose commands that switch models, load packages, replace policy, reset persistent counters or widen tools.
- Keep runtime resources immutable relative to the writable candidate. Reject changed resources on a new or restored session.
- Hostile resource canaries must be observed by a discovery-positive control and absent from the real restricted session and request.
- A legitimate declared resource must still appear. An empty session is not an adequate positive control.

#### A03: Complete request admission and accountable retry

- Intercept the actual provider transmission path. A wrapper around only the first `prompt()` is insufficient.
- Inventory ordinary turns, follow-ups, internal retry, compaction, reviewer/judge and child-model paths.
- Every enabled path creates a distinct attempt identity, bound digest and target, then reserves and authorizes through state.
- An unsupported path must be disabled at its actual call boundary and tested as denied.
- Each actual retry uses a new request/attempt and the prior request relationship. Reusing a recorded dispatch never resends it.
- Preserve repair and purpose attribution supplied by the trusted host. A hidden continuation cannot become a free request.
- Automatic continuation consumes the parent call/token/concurrency/deadline budget even when it is not a transport retry.
- Enforce the dedicated transport retry cap independently from call caps. Retries cannot silently change to ordinary task attempts.
- Disable unaccounted SDK/provider transport retries, or intercept each physical attempt before it can transmit.
- Admit after finalized request bytes, context-mode assessment and reservation quantities are known. In estimated_guard, input reservations are estimates; bind those facts and transmitted bytes to admission.
- The trusted sender consumes each newly committed permit once and checks current ownership and host-clock expiry at dispatch.
- A stale owner, expired permit, state error, exhausted budget, or committed marker without its original permit must send nothing.
- Define the check-to-send race and interruption behavior explicitly. Do not promise remote fencing after transmission has begun.
- Cancellation or local process death must not refund an uncertain provider attempt. Preserve its charge and required live slot.
- Normalize provider usage with documented cache/reasoning overlap rules. Unknown fields stay unknown; estimates remain estimates.
- Commit a receipt once, bound to the actual attempt. Duplicated events must not double-settle or release another attempt's slot.
- A controlled endpoint must count physical requests and compare them with real persistent state records.
- Crash tests must cover before send, after send before receipt, and receipt persistence before acknowledgement.

#### A04: Actual tool containment and credential separation

- Default-deny every tool not granted by the role and frozen policy, including indirect invocation paths.
- Use the core scope semantics for exported repository changes. Protected paths take precedence over writable patterns.
- Enforce host access boundaries during execution. Checking a final diff alone is not filesystem containment.
- Repository commands run in an owned disposable environment with explicit mounts, user, process, memory and storage limits.
- Keep the root filesystem read-only where the selected profile permits writes only in declared scratch/workspace locations.
- Never mount the Docker socket, host HOME, credential directories, state store or unrestricted host filesystem.
- Deny host namespace, privileged mode, device access and privilege escalation. Freeze the effective runtime configuration.
- Protected candidate paths must remain unmodifiable through shell, native tools, symlinks, hard links or rename tricks.
- Prevent path traversal and symlink escapes in both direct tools and artifact collection.
- The plan must explain how contract globs map to enforceable writable scope, including newly created paths.
- Arbitrary shell execution may require a restricted workspace layout. Do not silently widen scope for convenience.
- Deny unapproved egress from untrusted execution. Test direct IP, DNS, IPv6 where available, loopback/host gateways and subprocess access.
- Approved provider or MCP access occurs through narrow trusted mediation. Do not expose a generic credential-bearing HTTP proxy.
- Bind mediation to run, role, operation and current authority. Caller-supplied IDs are not authentication.
- Restrict methods, destinations and redirects. Forward no credential to a changed or unapproved destination.
- Keep provider/publisher credentials out of model context, tool environment, arguments, output, sessions and events.
- Trusted host configuration loading may resolve operator-approved credential references from its launching environment before destination validation and policy freezing. This grants no environment access to repository files, model output or MCP metadata; it does not authorize a new transport or effect. Never inherit the whole environment or ambient Pi authentication stores.
- Use synthetic canaries to prove denial. Do not expose real secrets as test payloads.
- Demonstrate an allowed write and allowed mediated operation alongside denied host access and egress.
- If the execution environment or required enforcement is absent, fail preflight. No native unsandboxed fallback is allowed.

#### A05: MCP and codemode preserve the same tool policy

- Explicitly configure supported MCP transports, server identities, exact external tool names and permitted effects.
- Visibility, searchability and permission to execute are separate. A hidden or searched tool still requires authorization.
- Exercise the real Pi MCP integration and native nested/codemode paths, rather than a replacement mock dispatcher.
- Denied nested calls must produce no tool side effect. Allowed nested calls must retain argument/result bounds and identity.
- Freeze idle timeout units and behavior from the pinned package. Progress may reset idle time but never the absolute deadline.
- Abort local calls and reclaim owned server descendants on cancellation. Record exact exit/cleanup evidence.
- Distinguish local termination from remote execution status. MCP timeout cannot establish remote non-execution.
- No external-write MCP tool is enabled in this spec. The later publisher/gate work owns authenticated external effects.
- Large or malformed tool arguments/results, progress floods and hung servers must not create unbounded buffering or waiting.
- Stdio MCP subprocesses receive only the intended environment and workspace access, under the same containment policy.
- S03 supports only the frozen local read-only workspace server. Trusted configuration interpolation belongs to S04; token-bearing MCP transport requires a separately approved mediation and containment plan. Remote MCP and OAuth remain unsupported here, with preflight refusal rather than browser interaction, anonymous fallback or indefinite authentication waits.

#### A06: Settled events, bounded output and session lifecycle

- Normalize Pi events into a versioned adapter event stream bound to lock, run, role, step, attempt and sequence.
- Use completed messages as usage candidates. The first `agent_end` is not final when Pi or an approved extension can continue.
- Report final adapter settlement only after no enabled continuation can transmit and owned local work is accounted for.
- Pi settlement is execution state, never deterministic task acceptance or proof of provider billing finality.
- Expose request start/receipt/uncertainty, tool start/end, retry wait, cancellation, resource identity and final outcome.
- Keep raw content and credentials out of normal logs. Private artifacts require explicit policy and access controls.
- Sanitize untrusted newlines, ANSI sequences and workflow-command syntax before emitting human-readable diagnostics.
- Bound event size, queued events, tool results, transcript storage and diagnostic text. Define overflow and backpressure behavior.
- A slow or disconnected consumer must not allow unbounded memory growth or lose authoritative state silently.
- Cancellation has a finite grace period followed by termination of the exact owned process/container group.
- A child that ignores cancellation or creates descendants must not survive successful cleanup reporting.
- Record process exit separately from adapter outcome and provider outcome. Missing exit evidence is not success.
- Session capture must bind runtime, resources, lock and artifact digests. Verify bytes before reuse.
- Restore only at a defined safe boundary. No restored session may auto-resend an uncertain provider or tool operation.
- If continuation is not safe, return a typed recovery requirement and preserve state. Do not manufacture an empty successful session.

#### A07: Context safety without a second memory system

- Before every request, assess finalized system/messages/tools input and explicit output/thinking/tool headroom under a frozen context mode.
- The default `proven_bound` mode requires a supported complete conservative bound. If it is unavailable, fail before transmission.
- An operator may explicitly select `estimated_guard` for a supported soft-accounting route in the immutable adapter policy.
- That mode uses a versioned full-payload estimator and fixed headroom limits. Record estimated provenance and uncertainty; never advertise a proven context or billable-token bound.
- If the assessment plus output/tool reserve and policy margin exceeds the model context limit, refuse before send or use a separately admitted compaction that passes the same guard.
- Unknown input kinds, changed model/policy/resources, malformed counts, or missing required estimator coverage still fail before send.
- Require explicit host opt-in. A caller requiring a proven bound cannot be silently downgraded, including after restore or failure.
- Keep context mode separate from accounting enforcement. Hard-token admission remains denied for the selected live route.
- Freeze estimator identity, final serialized-body coverage, safety margin, model/catalog identity, reserves and byte ceilings.
- A byte or character heuristic is an estimate, not a proof. The opted-in mode accepts possible post-send overflow or curtailed output.
- A post-send context error, context-limit stop, output truncation or incomplete tool call cannot produce successful execution settlement or task acceptance.
- Never automatically repeat an oversized request. Compaction and any explicit later attempt use the same mode, request broker and parent budgets.
- Preserve raw-response-bound usage, original unknown charges/live slots, tool call/result pairing and immutable authority outside summaries.
- Missing context, altered lock/resource versions or failed compaction cannot authorize continued execution.
- This spec implements bounded adapter behavior and accounting. Semantic memory policies and quality evaluation remain later work.

#### A08: Controlled evaluation of pi-retry

Evaluate `@monotykamary/pi-retry@0.11.4` as an optional retry policy integration.
It is a retry-policy candidate, not the persistent budget authority.

The inspected registry artifact has integrity
`sha512-5Q83Ci8dr5jckEHocXbK80O7nFePzg5uhXotxd63E3ZBFHwt80so5pOsThH4zYboqL4S+7UU3Sw6Sx+YeBpluA==`.
Its manifest declares MIT and Pi 1.5.0 development dependencies, with wildcard host peer dependencies.
Those declarations do not establish compatibility with this adapter.

The package supplies error classification, backoff, hidden continuation messages and session lifecycle integration.
Its ordinary retry cutoff is distinct from a run-wide retry budget. Output-length continuations have no package-level count cap.
Its in-memory counters reset on lifecycle events and explicit reset commands.
It reads global/project settings directly and patches AgentSession prototype hooks, including `_prepareRetry`.
Its native-retry suppression and inline SDK mode therefore need exact-host conformance tests.

- Keep the package disabled until its enabled paths pass A01-A07 through the production adapter.
- Freeze configuration from the trusted host. Repository settings, prompt regex matches and reset commands cannot widen authority.
- Exactly one layer schedules a transport retry. Verify native retry suppression on the actual pinned SDK and package identities.
- Count every retry, output-length continuation and empty-response nudge at the physical send boundary.
- Stop the extension on persistent cap refusal, deadline, stale owner, cancellation or unsupported context.
- Do not rely on matching error strings to enforce these host decisions.
- Plugin resets, successful intervening turns and session recreation must not reset persistent calls, retries or charges.
- A lost response remains an unresolved original attempt. A later attempt cannot imply the original used zero tokens.
- Repeated 400/413 errors must respect context safety and bounded policy. Repeating an oversized request does not fix its size.
- Test repeated `length`, empty stop, ordinary errors, original-request interruption, budget refusal and cancellation during backoff.
- Test event settlement, two distinct sessions, reload/module identity and the private hooks used by the package.
- The plan must choose direct controlled integration, a narrowly maintained adaptation, or an explicit unsupported result with evidence.
- Do not silently vendor a fork or claim a source-only inspection proves integration. Any adaptation requires a plan ruling and license record.
- This acceptance item requires the evaluation and a justified disposition. It does not require enabling a package that violates the contract.

#### A09: Runtime selection with pi-durable and persistent host authority

Compare `coding-agent SDK + state` and `pi-durable + state` before the implementation plan is approved.
The comparison must identify useful existing runtime behavior and required host responsibilities separately.
Do not reject pi-durable merely because it does not supply the host's cross-process ownership or budget policy.

The inspected pi-durable design persists task phases, conversation entries, sleep state and typed JSON documents.
It supports compaction with retained history and historical document reads when the document retains history.
A task checkpoint resumes a declared phase; it does not restore an arbitrary JavaScript call stack.
A long-lived conversation still has finite request context, storage and run budgets.
The host owns a storage with one process and supplies any external wake service.
These are source-level capabilities. Their integration with this adapter remains to be qualified.

- Pin the evaluated durable artifact and companions independently of the SDK artifact. Check version and license identity.
- Compare task/checkpoint/resume, durable sleep, compaction/history, versioned documents, model access, tools/MCP, resources and events.
- For each row, separate existing upstream capability, required adapter work, measured behavior, and unsupported or untested conditions.
- Identify one owner for each model request, tool effect, retry, task phase and cancellation. Do not stack independent replay schedulers.
- Keep the state package authoritative for parent budgets, unknown charges and current dispatch authority in either route.
- Explain how runtime state and the separate state ledger recover after a crash between their commits.
- Do not imply that two stores share an atomic commit. Interrupted ordering must stop or reconcile without duplicate dispatch.
- Enforce single ownership of durable storage before any writable open, resume, submit or operation that starts its scheduler.
- A state lease alone does not stop an old durable process. Prove exclusion or fence all of its effects before allowing another owner.
- Interrupted model retries and compaction must pass the same physical-send boundary and retain the original uncertain charge.
- If durable orchestrates an external SDK worker, journal that worker's identity and receipt before any retry decision.
- Treat SDK-worker invocation as potentially effectful. Neither a durable phase rerun nor a new SDK session proves replay safety.
- Test the chosen route's recovery and bounded continuation with real local retained storage and controlled endpoints.
- Use the prior duplicate-owner probe as evidence of an unmet host precondition, not an upstream violation of its single-owner contract.
- State where retained document history is suitable for task-local state. It cannot replace reviewed active memory or contract authority.
- Return a concrete recommendation at the plan gate: SDK route, durable route with explicit qualification gates, or a bounded further qualification requirement.
- If recommending durable, reconcile every A01-A08 requirement against its real API before build approval.
- Do not claim coding-agent extensions, pi-retry, MCP or event names transfer unchanged to durable.
- Record any unsupported plugin as such and preserve equivalent required host behavior. No silent acceptance waiver is permitted.

### Notes / Constraints / Caveats

The SDK candidate was previously exercised with explicit model, thinking, tools and resource loading.
Its registry artifact matched the managed installation. It was not byte-identical to a separately inspected source commit.
Use package integrity and exact dependencies as runtime identity; do not claim source-commit equivalence.

Prior local probes observed two `agent_end` events before one `agent_settled` under a controlled continuation.
They also showed that `noContextFiles` alone still allowed an append-system resource to enter context.
An actual Pi MCP fixture enforced one hidden-tool denial and distinguished idle timeout from an absolute abort.
These were bounded SDK/local-fixture observations. They did not prove OS containment or complete interception.

Two bounded live model probes observed matching requested, session and outgoing settings.
The routes were GitHub Copilot `claude-opus-5.5` with `high` and `claude-sonnet-5.5` with `xhigh`.
One interrupted call retained unknown usage. No probe established provider-internal effort or billing limits.

The local state package supports macOS arm64, Node 26.13.0 and SQLite 3.54.1 on one host and boot.
Local Docker Desktop exposes a Linux arm64 daemon. Availability alone is not an isolation result.
Qualify the chosen tool image, mount/egress/process policy and broker arrangement with real negative controls.

### Boundaries

- **Always:** preserve existing core/state contracts and all current tests; use explicit capability and evidence boundaries.
- **Always:** stop unknown or unsupported execution paths before they gain authority; retain uncertain accounting.
- **Always:** preserve exact request, runtime, source, resource, event and cleanup identity in validation records.
- **Ask first:** before changing a merged contract, stored-state semantics, runtime allowlist, or required acceptance scope.
- **Ask first:** before adding a maintained SDK/plugin fork, external services, new paid resources or publication.
- **Never:** load user-global extensions implicitly, give task code host credentials, or silently fall back to unsandboxed execution.
- **Never:** use model output, session completion, cancellation or a timeout as proof of task acceptance or non-execution.
- **Never:** reset durable budgets, blindly replay uncertain effects, push Git commits, or edit CI/CD workflows.

### Risks and Mitigations

- SDK drift can change request paths and events. Pin artifacts and run upgrade conformance before changing them.
- SDK or plugin retries can escape accounting. Count physical sends and deny every unqualified path.
- File filtering can conceal a missing sandbox. Exercise host canaries, path escapes and native shell descendants.
- Credential mediation can become a confused deputy. Authenticate callers and bind each request to immutable authority.
- Process termination can be mistaken for remote cancellation. Preserve separate local and provider outcomes.
- Context estimates can understate usage or headroom. Permit estimated_guard only through explicit immutable opt-in; retain strict default refusal, bounded failure handling and hard-token denial.
- Private plugin hooks can break silently. Fail closed on incompatible shape and verify exact-host lifecycle behavior.
- Whole-run state validation can delay dispatch. Measure bounded integration behavior without claiming a throughput SLA.

## Design Details

### Commands

Existing repository checks remain mandatory:

```sh
npm ci
npm run build
npm run typecheck
npm run lint
npm test
```

The plan must extend these checks to include the adapter's deterministic tests.
It must define separate executable commands for real containment and bounded live-provider qualification.
Missing Docker, credentials or model access must produce explicit blocked results, never a passed skipped row.

### Project Structure

- `packages/core/`: existing contracts and deterministic acceptance; consume its public interface.
- `packages/state/`: existing persistent local authority and accounting; consume its public interface.
- `packages/agent-pi/`: new adapter, trusted mediation, resource controls, tool execution and conformance tests.
- `docs/` and `examples/`: local adapter operation, support matrix, evidence limits and a bounded host example.
- Root workspace/build/test metadata: include the new package and its pinned dependencies.

These are proposed ownership locations. The implementation plan chooses internal files and transport layout.
Do not add a competing controller, budget store or task-contract format.

### Code Style

Use TypeScript ESM and existing strict validation/error conventions.
Keep types readonly at public boundaries. Own input snapshots and use stable machine-readable failures.
For example, callers of the existing state API must handle refusal before using a store:

```ts
import { reopenLocalRun, type LocalRunIdentity } from '@loopwright/state';

function inspectRun(identity: LocalRunIdentity) {
  const opened = reopenLocalRun(identity);
  if (!opened.ok) return opened;
  try {
    return opened.value.inspect();
  } finally {
    opened.value.close();
  }
}
```

Do not expose raw SDK internals as the host contract.
Keep test-only clocks, fake transports and fault hooks constructor-injected and outside production exports.

### Approved implementation environment

Run core/state checks locally on macOS arm64, Node v26.13.0, bundled SQLite 3.54.1 and npm 11.20.0.
Run owned SDK/tool/MCP roles in the pinned Linux arm64 runtime profile. The state database stays on macOS.
Use serial auto-chain implementation in this worktree; no helper agents. Independent reviews occur only at ship.
The original T0 feasibility cap is 1,200 seconds. Its conservative consumed amount is 738.249 seconds; 461.751 seconds remain.
An additional 1,800 seconds of local qualification is approved. Total cap is 3,000 seconds; remaining allowance is 2,261.751 seconds. Neither counter resets.
The preceding figures describe the historical context replan. At that gate, drafting authorized no execution.
T0 subsequently closed at 4,083.913/4,200 seconds; the native-factory gate closed at 169.409730/360 seconds.
The completed prerequisite gates authorized the serial T1-T7 implementation and final conformance checks. Neither budget resets.
T0 is mandatory before T1-T7. A failed, unavailable or inconclusive prerequisite requires a technical ruling before dependent implementation.
T0 must qualify proven_bound refusal and explicit estimated_guard behavior, plus actual request output limits.
The approved estimated_guard acceptance permits an estimate; it does not require a complete tokenizer bound for that mode.
Other runtime, physical-send, containment, cleanup and accounting gates remain mandatory.
No durable D0 is authorized. Pi-retry remains unsupported and disabled.

Root deterministic checks will include the new package. Separate qualification commands are:

```sh
npm run qualify:pi -- --case context-guard
npm run qualify:pi -- --case parser-context-failures
npm run qualify:pi -- --case runtime-image
npm run qualify:pi -- --case runtime-path
npm run qualify:pi -- --case physical-sends
npm run qualify:pi -- --case admission-mutations
npm run qualify:pi -- --case containment
npm run qualify:pi -- --case mcp
npm run qualify:pi -- --case recovery
npm run qualify:pi -- --case limits
npm run qualify:pi -- --case all
npm run qualify:pi:live
```

These executable targets separate deterministic, native local and live evidence.
`--case all` builds the derived image and runs every registered non-live case, including both model selections.
Live remains separate and blocked without the explicit ready-token prerequisite. See the acceptance map for current results.
A qualifier with missing prerequisites returns nonzero and machine-readable blocked status.
The total live-call allowance persists across restarts: at most eight calls, 90 seconds each, output at most 1024 where enforceable.
A missing supported context mode/coverage or enforced output limit means no live probe.
Explicit estimated_guard does not require a complete live tokenizer bound; its guard and disclosed uncertainty must pass qualification first. Auxiliary credential/count operations need explicit endpoint/method/body limits and accounting.
The current baseline has 219 passing core/state tests. This is not adapter acceptance.

### Runtime comparison and selected route


Evaluated package identities:

| Candidate | Version | Registry integrity | Declared license |
| --- | --- | --- | --- |
| `@earendil-works/pi-coding-agent` | 1.5.0 | `sha512-xNDZ5kqowO6Z03FS2gwAkPEGk1ssxVcYKQ6qZId84mFEvwACvvyc2l0vAMOS+c5zvxLRMLBE9r4y44IGYkMJaQ==` | MIT |
| `@earendil-works/pi-durable` | 1.5.0 | `sha512-xeBP2vIo5NvsCMQ4Y/V+Z164xQEi9JWiBWHdjn4Z15EnFqV3c0FxJAX26FqyyyintrYyk+Enre94GNcvRlBA5g==` | MIT |
| `@monotykamary/pi-retry` | 0.11.4 | `sha512-5Q83Ci8dr5jckEHocXbK80O7nFePzg5uhXotxd63E3ZBFHwt80so5pOsThH4zYboqL4S+7UU3Sw6Sx+YeBpluA==` | MIT |

These are independent artifacts. Durable is Experimental and is not an SDK storage backend.
SDK companions are pi-ai, pi-agent-core, pi-mcp, pi-codemode and pi-tui 1.5.0.
Durable companions include pi-ai, pi-codemode, pi-schema, pi-telemetry and chord 1.5.0.
T0 freezes every installed transitive identity in the lock and records included license files.
The root minimatch override currently selects 11.0.1; SDK declares 11.0.3.
Retain the root override initially, record the effective resolution, and qualify the actual locked combination.
Do not claim that the tarball alone proves the overridden dependency graph compatible.

| Concern | SDK + S02 | Direct durable + S02 | Durable orchestrating an SDK child + S02 |
| --- | --- | --- | --- |
| Task/checkpoint/resume | Session entries and explicit safe capture; host phase control remains S04 | Built-in persisted task phases and requestId deduplication; phase resumes from its top | Durable phases can checkpoint orchestration, but child invocation is an effect |
| Sleep/wake | Host owns finite retry wait; no general scheduler added in S03 | Stored sleep/checkpoint and wake hints; host must provide external wake when needed | Same benefit, plus child-liveness and result reconciliation before wake/replay |
| Conversation | Session tree, explicit compaction, retained entries | Immutable conversation entries and task graph | Two conversations/transcripts need one authoritative relationship |
| Long context | Finite model context; explicit, brokered compaction | Native foreground/background compaction with retained raw history | SDK child compaction and durable compaction must not both schedule model work |
| Versioned documents | No typed durable-document system; no second memory store added here | Typed documents; historical reads only with retained history, e.g. rewindable | Good phase-local records; cannot prove SDK effects completed |
| Model access | `ModelRuntime`, provider wrapper and injected physical `fetch` | `Models`/provider methods; generation, compaction, hooks and internal model tools need interception | Every durable and SDK model path needs the same broker; two runtime inventories |
| Tools/MCP | Existing SDK custom tools, real MCP extension and codemode factories | Durable tools/environment/ToolTask hooks; MCP bridge requires separate integration | Must distinguish durable tools from tools inside the child; inherited APIs are insufficient |
| Resources | SDK ResourceLoader interface, fully explicit getters | Explicit registry/sections/agent settings; SDK resource switches do not transfer | Must freeze both registries and both resource worlds |
| Events | `agent_end` versus `agent_settled`, request/tool/session events | Committed entry/submission/task events and reports; no SDK settlement event contract | Durable completion is insufficient until exact child receipt/exit is known |
| Retry/cancellation | Disable SDK/provider retry; one host retry scheduler; owner cancels real work | Native interrupted generation/retry/sleep behavior must reconcile with S02 first; cancelling wait cancels only the wait | Two potential replay/cancel schedulers; define one effect owner, never retry child invocation blindly |
| Storage | S02 authoritative; optional immutable session artifacts published at safe boundary | Separate S02 and durable stores; no atomic shared transaction | Separate stores plus worker lifecycle journal and SDK artifacts |
| Exclusive writable open | Adapter owner mutex and exact child cleanup | Lifetime exclusion required before opening durable writable storage, not only before `resume()` | Same requirement, plus child execution fencing |
| Existing observations | Prior actual SDK/fake-model, MCP fixture and two live selections; containment unproved | Prior local retained sleep/version tests; unknown-usage gap and unguarded duplicate writer | Source-level possibility only; no integrated probe |
| Maintenance bill | One runtime adapter plus broker, tool sandbox and safe artifacts | All common security work plus new durable model/tool/resource/event/recovery bridges and experimental API upgrade tests | Largest bill: both bridges, child receipts and every cross-store/child crash ordering |

Durable's retained phase checkpoints, sleep and document history are real useful upstream features.
They can reduce S04 task-lifecycle work if a later runtime gate chooses them.
They cannot replace S02 parent counters, uncertainty, ownership or reviewed active memory.
The earlier duplicate-writer experiment omitted durable's documented single-owner host precondition.
It demonstrates missing host exclusion, not a violation of an upstream cross-process guarantee.
The earlier interrupted-request observation likewise identifies an S02/broker integration obligation.
It is not a reason to disregard durable's other capabilities.

**Recommendation:** qualify and implement only SDK+S02 in S03.
It already has the exact SDK/MCP/codemode interfaces required by A01-A08 and prior narrow executable evidence.
The shared host interface keeps runtime internals private, so later selection need not change core/state authority.
Durable would add at least five separate bridges: resources, tools/MCP, model paths, settlement, and two-store recovery.
The hybrid adds a third lifecycle and an effectful child journal; it has no demonstrated safety advantage for this scope.
No unsupported estimate of engineering days or runtime throughput is offered.

SDK+S02 is selected. No durable D0 or production durable integration is authorized in this tranche.

#### Required crash ordering if durable is selected later

1. Acquire the host's exclusive execution/storage-owner guard before any writable durable open, submit or scheduler-starting call.
2. Persist durable phase identity/intent, then persist the corresponding S02 reservation and dispatch marker before transmission.
3. A crash before reservation permits inspection of the phase but no effect until a fresh S02 admission succeeds.
4. A crash after S02 authorization requires reconciliation; reopening durable never recovers the lost one-use permit.
5. Persist the authenticated provider/tool receipt in S02 before acknowledging it into durable phase completion.
6. If S02 has the receipt and durable lacks completion, return the stored result; do not send again.
7. If durable has an apparent completion and S02 lacks its matching receipt, stop for reconciliation; do not infer zero usage.
8. A lease expiry does not kill the previous process. Confirm that process and its exact children exited, or keep effects fenced.
9. If a durable phase invokes an SDK child, S02 must journal worker/container identity before start and record result plus exit before replay decisions.

SQLite file separation remains real even if both stores sit on the same disk.
Durable's SQLite WAL/NORMAL profile and S02's DELETE/EXTRA profile have different persistence claims.
Neither this ordering nor task phase replay creates one atomic transaction or remote exactly-once execution.
Document history is suitable for task-local facts, not machine authority or approved long-term memory.

### pi-retry disposition (A08)

**Unsupported and disabled for this adapter version.** The package remains an evaluated candidate, not a runtime dependency or extension.
No source is vendored, patched or silently replaced. Record MIT attribution with the evaluation.
An explicit request to enable it returns `EXTENSION_UNSUPPORTED` before session startup or model transmission.

Source evidence in the verified artifact:

- `src/config.ts` reads global/project settings itself through Node filesystem calls.
- `src/session-registry.ts` patches `AgentSession.prototype.bindExtensions` and `_prepareRetry` using shared symbols.
- Native retry takeover depends on matching actual session/module identities and supported private hook shapes.
- `retry.ts` owns detached retry state, lifecycle generations, reset controls and hidden continuation messages.
- Its length continuation is intentionally unbounded at package level; empty-stop nudging has a separate small count.
- Ordinary retry failure counters, successful turns and session lifecycle are not persistent run-wide limits.

These findings do not establish that the plugin is broken on the pinned host.
They establish that enabling it would add an unqualified scheduler, resource reader and private-hook compatibility surface.
A direct integration would need settings virtualization, precise session ownership, native retry suppression and every A01-A07 path.
A maintained adaptation would additionally require an explicit fork/license/upgrade ruling.
Neither cost is needed for this optional acceptance disposition.

T6 tests the real production rejection and actual SDK behavior with the plugin absent.
Repeated length, empty stop and errors cannot start plugin continuations; two sessions and restore retain S02 counters.
A package request via policy, ambient settings or resource metadata must still fail before any package import or side effect.
A future enablement must run the full specified hook/reload/reset/backoff/length/error matrix; it is not claimed passed here.
The host's bounded transport retry is adapter behavior required by A03, not a purported implementation of pi-retry.

### Host contract and enforcement


#### Public package boundary

Private package: `@loopwright/agent-pi`, TypeScript ESM.
Export one factory, readonly data types and a closed error-code union.
Do not export AgentSession, raw Provider/fetch, Docker clients, permit consumers, clocks or fault injection.

`openPiAdapter(host: PiHost, input: unknown): Promise<PiResult<PiAdapter>>` validates and owns all plain input.
`PiHost` is a trusted local construction boundary, not a serializable remote API.
It contains an already opened `LocalRunStore`, its current `Authority`, owned canonical directories and a narrow credential resolver.
The caller remains responsible for initial create/claim and for intentional state ownership release.
The adapter renews the supplied owner while active and stops on every renewal/clock/store refusal.
It neither creates replacement allowance nor silently claims a different run.
Test transports, clocks and crash hooks stay in internal test constructors, absent from production exports and policy JSON.

Input fields are exact, required and versioned:

- `version: 1`, validated `TaskLock`, `roleId`, `stepId`, `sessionId` and frozen `AdapterPolicy`.
- `candidate`: core `ArtifactManifest` plus bounded regular-file bytes; source/base identities must match the lock.
- `resources`: admitted resource bytes and their core artifact references; paths and SHA256 must match the lock.
- `restore`: null, or a safe session/checkpoint reference plus authenticated bytes.

The version-1 `AdapterPolicy` has these required fields. Unknown fields are errors:

- `version: 1`, `policyId`, `resourceVersion`, `adapterId: "pi"`, `adapterVersion: "0.0.0"`.
- `runtime`: exact SDK integrity, dependency-graph digest, derived image digest, runtime-config digest and `linux/arm64` profile.
- `selection`: provider, model, thinking and `anthropic-messages` API; all must match the lock role and frozen catalog snapshot.
- `resources`: ordered ID/kind/path/digest records, equal to admitted context plus the frozen host preamble digest.
- `tools`: exact subset of read/bash/write/edit/codemode/MCP names, intersected with the role grant.
- `mcp`: frozen workspace server identity, script digest, exact names/effects and seconds-based idle/absolute limits.
- `context`: canonical mode, estimator/proof identity, version, evidence level, working-window ceiling, byte ceiling, service margin, tool reserve and output ceiling.
  An omitted mode normalizes to proven_bound before hashing. Explicit estimated_guard requires its exact value; no error or restored session changes it.
  The selected live route has no qualified proven_bound proof. Its default mode therefore refuses before container/model startup.
- `accounting: "soft_only"`, `retry: "sender_only"`, `extensions: []` and `privateArtifacts: boolean`.
- `limits`: the fixed version-1 ceilings below; callers may tighten them, never exceed them or the TaskLock budgets.

The caller's S02 compatibility binding must already contain pi/0.0.0 and the same resourceVersion.
Changing the policy requires a matching binding/new qualified session; it cannot mutate an existing admitted run identity.
JSON metadata has a 1 MiB validation ceiling. Artifact bytes use separately validated owned Uint8Array slots and aggregate limits.
Host directory paths and credential resolver functions live only in PiHost; model-visible policy JSON cannot choose them.
The resolver is a trusted host seam, bound to approved purpose, server identity and destination; its resolved secrets never become public policy fields or policy-fingerprint inputs.
S04 may resolve approved environment references before invoking this seam, with safe references/redaction and resume re-resolution under the same binding.
No configuration loader or token-bearing MCP capability is implemented by S03. The closed version-1 MCP policy intentionally accepts only its local server.
A later authenticated transport therefore needs an explicit policy/API version amendment and qualification; createTransport and the private owner protocol provide integration seams, not permission to widen that policy.

Concrete version-1 host fields are `store`, `authority`, owned canonical `directory` and `artifactsDirectory`, absolute `dockerExecutable` and `dockerSocket`, frozen `runtime`, and `resolveCredential`.
The resolver receives `{provider,model,destination,purpose,runId,roleId,stepId,notAfterMonotonicMs,signal}` and returns `{bearerToken}`; only the trusted owner may call it.
The trusted implementation must bound credential readiness by the supplied expiry/AbortSignal. S03 performs no auxiliary auth exchange. It is not a serializable generic HTTP transport.
`RuntimeIdentity` contains `sdkIntegrity`, `graphDigest`, `imageDigest`, `configDigest` and `profile`.
The graph digest identifies exact package-lock bytes; configDigest identifies canonical versioned nonsecret runtime settings, distinct from the separately recorded image configuration digest.
Candidate input is `{manifest,baseRevision,sourceRevision,artifacts:[{name,bytes}]}`. Resource input is `[{id,kind,ref,bytes}]`.
Restore input is null or `{checkpointId,workspace:{ref,bytes},session:{ref,bytes}}`; byte identity alone does not authorize restore without the current S02 checkpoint and owner checks.
Metadata and byte slots are copied separately; reject aliases/accessors/proxies, shared buffers and unsupported prototypes without executing caller getters.
MCP policy fields are `serverId`, `scriptDigest`, `names`, `effects`, `idleTimeoutSeconds` and `absoluteTimeoutSeconds`; only workspace/read_only is accepted.
Context fields are `mode`, `estimator`, `proofId`, `version`, `evidence`, `workingWindowCeiling`, `maxRequestBytes`, `serviceMargin`, `toolReserve` and `maxOutputTokens`.
The current estimator has proofId=null and evidence=estimated. An omitted mode still normalizes to the unsupported strict default.
Later S04 authenticated MCP mediation needs a scoped server/transport credential-request extension in addition to the explicit policy amendment; the provider-only resolver must not be overloaded with model-selected server identities.

Methods on the returned handle:

| Operation | Input and behavior |
| --- | --- |
| `capabilities()` | Owned frozen selection/resource/runtime/capability facts; no send |
| `execute(input)` | Unique turn ID, bounded literal text, trusted purpose and repair classification; one admitted SDK turn including tool-loop requests |
| `compact(input)` | Unique host command ID; explicit same-model compaction; no automatic threshold/background compaction |
| `events()` | One bounded async iterator; metadata only, sequence-bound; no raw SDK objects |
| `cancel(input)` | Fixed reason enum; idempotent; revoke new sends/effects, abort work and perform bounded cleanup |
| `capture(input)` | Only settled/reconciled boundary; returns immutable candidate/session artifact refs; no implicit resume |
| `close()` | Idempotent revoke/abort/cleanup and local handle closure; does not declare remote non-execution or release uncertain charges |

The whole execute/compact command uses the original remaining task deadline, without an additional 90 second whole-turn cap.
Every physical provider send still has its own 90 second maximum; tools/MCP retain their smaller independent deadlines.
Long timers rearm within Node's supported delay range and recheck the same original state deadline.
One `execute` or `compact` command is active per session. A second command returns `SESSION_BUSY`.
Other role sessions still share S02 caps and owner authority. No public message steering, shell escape or SDK slash-command interface exists.
Treat literal input as data. Reject command-mode prefixes before calling Pi's command-aware prompt path.
The trusted host supplies `purpose` and `repair`; model content and child frames cannot change them.
This package never evaluates acceptance or emits a task `passed` result.

`PiResult<T>` is `{ok:true,value:T}` or `{ok:false,error:PiError}`.
Preflight, invalid command, busy/closed handle and other API refusals remain typed errors.
After a valid execute/compact command starts, failure is a PiOutcome value, not loss of its execution facts.
PiOutcome retains status, bounded requestIds/operationIds, providerTermination, usage and localCleanup.
Its error preserves the original closed cause and underlying S02 code. cleanupError separately records cleanup failure;
localCleanup is complete, pending or failed, and failed cleanup cannot overwrite the original execution cause.
A blocked outcome can have no admitted requests. An execution_settled outcome alone can establish safe capture.
Usage is complete only for the current command when each request has S02-accepted reported input/output counts.
Raw candidate counts and a published final artifact without a successful observation cannot promote incomplete usage.
This status does not establish final cost or billing and does not aggregate unrelated retained requests.
Idle cancel preserves a terminal prior outcome/status and execution error while updating actual shutdown/cleanup facts.
Active cancel follows the exact interrupted command through drain, including completion races and repeated cancellation;
it cannot borrow the earlier turn. Unknown effects or cleanup failure retain recovery semantics.
Without a prior or active command, cancel returns an empty cancellation outcome.
Normal command cleanup can leave an idle session open; close separately verifies final role/container cleanup.
`PiError` is `{code,path,phase,retryable,effect,requestId,operationId,stateErrorCode}`.
`effect` is `none | possible | confirmed`; it describes the adapter observation, not billing finality.
Phase is `preflight | admission | dispatch | tool | session | restore | cleanup`.
Identifiers/stateErrorCode are nullable. `path` is a JSON pointer into owned input.
Bound error detail is metadata only; SDK/provider exception messages never become raw public errors.

Closed code vocabulary:

`INPUT_INVALID`, `BINDING_MISMATCH`, `RUNTIME_UNSUPPORTED`, `RUNTIME_MISMATCH`, `RESOURCE_MISMATCH`,
`MODEL_UNAVAILABLE`, `THINKING_UNSUPPORTED`, `CAPABILITY_UNSUPPORTED`, `EXTENSION_UNSUPPORTED`,
`CONTAINMENT_UNAVAILABLE`, `CONTAINMENT_MISMATCH`, `SESSION_BUSY`, `AUTHORITY_REFUSED`, `STATE_REFUSED`,
`REQUEST_REFUSED`, `SEND_PATH_UNSUPPORTED`, `PAYLOAD_MISMATCH`, `CONTEXT_UNSAFE`, `CONTEXT_LIMIT`,
`PROVIDER_RESPONSE_INVALID`, `RESPONSE_INCOMPLETE`, `TOOL_DENIED`,
`MCP_FAILED`, `OUTPUT_LIMIT`, `EVENT_OVERFLOW`, `DEADLINE`, `CANCELLED`, `RECOVERY_REQUIRED`, `CLEANUP_FAILED`.

Errors never authorize an automatic alternate route.
A retryable state contention may be retried only with the same ID after inspecting state, under the original deadline.
`COMMIT_UNKNOWN` closes the state handle and yields `RECOVERY_REQUIRED`; no permit or replacement store is invented.
Authority and state failures preserve their underlying closed state code.
Input/identity/capability refusal precedes container startup, then resource/model checks, then containment, then requests.
An existing committed dispatch marker without its original live permit always sends zero requests.

#### Capability matrix

Return separate requested, catalog-supported, session-effective and outbound-observed model/thinking facts.
Initial live candidates are GitHub Copilot Claude Sonnet 5.5/xhigh and Opus 5.5/high, through their HTTP Anthropic message route only.
Controlled endpoints use the same actual provider serializer/parser, with test-only endpoint/credential injection.
No WebSocket, deferred/polling, image/classifier, remote MCP, virtual model or unapproved provider route is enabled.
Their low-level call boundaries refuse before network access.

Live token capability is `soft_only`, mapped to contract `soft_accounting`.
No current evidence proves complete provider-internal billable-token bounds, so a hard-token contract fails before a model send.
Even soft routes require finite request/context/output limits and persistent per-attempt reservation.
Context capability is independent: defaultMode=proven_bound, liveProvenBoundAvailable=false, optInMode=estimated_guard.
Capabilities and events identify estimated provenance, estimator version and accepted context uncertainty separately from soft accounting.
These context facts do not change the public core/state Capability type or its semantics.
A controlled endpoint's known synthetic counts do not upgrade a live-provider capability to `hard_bound`.
Calls, concurrency, transport retries and wall deadlines use the real persistent authority and host monotonic deadline.
Cost remains observe-only. It is never represented as a hard monetary cap.

#### Exact resource loader behavior

Implement the final role's public `ResourceLoader` interface directly; do not discover candidate/operator resources and filter the result.
The pinned package does not publicly export its inline-factory loader. Use public `DefaultResourceLoader` once as a native factory compiler.
Both compiler cwd and agentDir are a new owned empty container directory, outside candidate ancestry.
Control private HOME, SDK environment path overrides and every remaining automatic root before reload.
Use `SettingsManager.inMemory` with `projectTrusted:false`, empty package/resource settings, no trust callback,
empty additional paths, no builtins, all no-discovery flags, an inert literal system prompt and empty append list.
Package resolution precedes flag filtering; no untrusted or writable discovery root may be available during compilation.
Compile only frozen named host authorization and pinned native MCP/codemode closures. No installs, subprocesses or network requests occur.
Require exact extension path/order/count, zero errors/warnings/diagnostics and empty other resource outputs with unchanged inert prompt.
Unexpected outputs fail startup. No private imports, export-map bypass, ExtensionAPI shim, SDK fork or permissive filtering is allowed.
Keep the native extension result's matching runtime and event bus when binding the final session.
The final role keeps its admitted cwd and resources; bootstrap cwd cannot become a tool authority base.
Repeated role reload verifies the same snapshot without discovery or repeated factory side effects.
`getSystemPrompt` returns the frozen host preamble and admitted literal resource bytes, with stable IDs and data delimiters.
Instruction/skill/document kinds retain their metadata; skill/document text cannot load code or grant machine authority.
`getAgentsFiles`, `getSkills`, `getPrompts`, `getThemes` and append-system getters return empty explicit collections.
Their source-path getters return undefined/empty as appropriate. No ambient default prompt is accepted.
`getExtensions` returns only the verified native extension records from those frozen trusted factories.
`extendResources` refuses. `reload` verifies the same immutable snapshot and adds nothing.
Model catalogs and settings come from frozen in-memory values; disable initial/ongoing catalog network refresh.
A private SDK HOME/agent/session location has no operator credential files or user settings.
The unrestricted discovery-positive control runs separately with synthetic resources and cannot send a live model request.

### Trust, process and execution layout

Select three isolated Linux container roles under one trusted macOS owner.
This also puts native codemode's QuickJS worker inside a container, rather than relying on Node process separation.

```text
trusted caller
  -> macOS adapter owner: S02, current Authority, execution guard, Docker controller,
       sole physical HTTP sender, credential resolver, candidate materializer, receipt writer
       | private host-held stdin/stdout protocol, bound to exact SDK container ID + launch nonce
       v
     SDK container: pinned Pi, explicit in-memory settings/resources/session, network none
       | custom fetch -> parent-owned protocol -> state admission -> host-only HTTP send
       | real codemode VM -> real Pi nested tool authorization
       | tool proposals -> parent-owned per-operation mediation
       v
     separate tool container / separate stdio MCP server container
       read-only candidate and runtime; bounded tmpfs scratch; no provider/state channel
```

Only the macOS owner opens S02, attaches credentials, dispatches HTTP, starts/stops containers or mutates retained candidate files.
The SDK container serializes requests and proposes tool work. It cannot issue network traffic or open the state database.
It receives a non-secret provider placeholder sufficient for serializer construction, never a real credential.
The owner strips placeholder/auth headers and constructs destination-specific authentication itself.
Only host-resolved configured credential material may reach that exact approved provider destination.
The pinned native Anthropic beta client uses `https://api.individual.githubcopilot.com/v1/messages?beta=true`.
Admit only POST to that exact URL, including the fixed query; reject alternate queries, paths, hosts, credentials and redirects.
If credential readiness needs an auxiliary exchange, it has a separate fixed endpoint/method/body allowlist and deadline.
It is not a generic proxy and cannot be selected by model input. T0 inventories it before any live qualification.
Do not give a raw GitHub token to the SDK merely to avoid implementing mediation.

The private protocol is an inherited pipe relationship, not authentication by run IDs in a request body.
Each attached SDK process has a unique launch nonce and monotonically increasing frame sequence.
The owner maps that channel to its immutable run/role/step/policy; it rejects caller-supplied identity changes.
No port, Docker socket, owner IPC path, credential file or state directory is mounted in any container.
Tool/MCP containers have separate pipes and can never request provider sends or candidate commits through the SDK channel.
MCP bytes and tool output are data; a frame-looking payload cannot cross the parser's channel boundary.
The owner's Docker CLI argv uses argument arrays. Repository strings never become host shell commands or mount flags.

#### Runtime pin and limits

Base candidate: `docker.io/library/node:26.13.0-bookworm-slim`.
Registry index: `sha256:26f1bff99274226f43ac0409abebde017f06d22079d8b1d5d011711f9e7dfa4a`.
Linux arm64/v8 child manifest: `sha256:067b2d425f1204b5a898ae3d3145f7524c1425a4096a62b0f67dd4344a494440`.
Pin the child digest in the owned runtime build. Never execute the mutable tag.
The derived image contains only frozen package files/lock, trusted adapter entries and required licenses.
Record its actual image/config digest after build and bind it into the versioned runtime policy.
No portable derived digest is invented before it exists.
T0 must import the actual SDK and run its QuickJS/MCP paths in this Linux image.
macOS node_modules are not presumed usable Linux runtime dependencies.

Use an allowlisted build context, excluding `.git`, `.claude`, credentials, retained state and unrelated user files.
Use task-local Docker client configuration if needed to avoid the observed credential-helper 401.
Do not change host Docker configuration or reuse unrelated images/resources as test fixtures.
An anonymous metadata lookup does not prove that pulling/building the pinned image succeeds.

Required runtime configuration for every owned container:

- Linux arm64, UID/GID 1000:1000, private PID/IPC/UTS namespaces, network none, no published ports.
- Read-only root filesystem; drop all Linux capabilities; no-new-privileges; explicit versioned seccomp policy.
- Deny mount, namespace escape, ptrace, privileged devices and host namespace/container-engine access.
- No host HOME, sockets, state, credential directories, parent workspace or devices mounted.
- One read-only candidate mount and read-only trusted runtime/resource mounts as required for that role.
- `/tmp` tmpfs 32 MiB and `/scratch` tmpfs 128 MiB, nosuid/nodev/noexec; no persistent writable volume.
- SDK: 512 MiB memory, no additional swap, one CPU, 64 PIDs; tool/MCP profiles use the same ceilings initially.
- Fixed PATH/LANG/HOME=/tmp/home/TERM=dumb; no inherited environment, NODE_OPTIONS, proxy variables or tokens.
- Bound stdio/log frames, disable unbounded Docker log retention, and drain pipes under the adapter's byte limits.

The engine/architecture and effective inspect output must match the policy before execution.
Daemon rootfs/mount/process/network controls require real negative tests; flags alone are not qualification.
If seccomp, limits, read-only mounts or network policy cannot be verified, return `CONTAINMENT_UNAVAILABLE`.
A trusted local host and Docker daemon remain prerequisites. This does not qualify a hostile kernel, daemon or tenant host.

#### Writable-path enforcement

Use a separate, owned candidate directory, never the worktree or a repository-controlled bind source.
Materialize the bounded regular-file manifest after checking source identity, bytes, case collisions and canonical relative paths.
Reject symlinks, hard links, devices, FIFOs, sockets and ambiguous file/directory topology at import.
Current core patterns are exact paths, subtree `path/**`, and `**`; do not implement a different glob language.

Mount the whole candidate read-only in SDK/tool/MCP containers.
Shell `bash` can read it and run commands into `/scratch`; it cannot modify even an allowed candidate path directly.
Explain this restriction to callers and include it in capability/policy output.
Each read/bash invocation owns a separate tool container and fresh scratch. Batch related shell commands in one call.
Scratch ends after that call; it is never persisted or automatically promoted into the candidate.
The capability reports `toolExecution={candidate:read_only,candidateWrites:mediated,scratch:per_call}`.
The supported `write` and `edit` tools perform candidate changes through trusted mediation:

1. Validate bounded arguments and normalize the exact target through public core `isWritablePath`.
2. Protected patterns always win; a denial happens before creating a file or dispatching an effect.
3. Serialize owner mutations, verify current authority, journal and authorize the local-write operation in S02.
4. Resolve each existing ancestor without following links. The candidate root is owner-only and inaccessible for untrusted writes.
5. Write an owner-created regular temporary file, verify expected old-content digest for edit, and atomically rename under that safe parent.
6. For a new path, create only canonical required directories under that root; no shell expands the target or chooses the parent.
7. Bind the committed bytes/digest to the operation receipt before returning success.

Host writes are trusted mediation of bounded data, not execution of repository code on macOS.
Do not run a host interpreter, package hook or Git filter during materialization/collection.
Ancestor checking is not claimed race-safe against a hostile host; the qualified directory has one trusted mutation owner and no untrusted writer.
No shell/native/rename/symlink route obtains a writable candidate mount.
Scratch contents are never promoted wholesale. Artifact collection accepts only authorized regular bytes and rechecks paths/digests.
If later work needs a writable shell checkout, it requires a new enforceable profile and qualification, not a silent widening here.

#### Execution ownership and cleanup

The adapter has an exclusive local execution guard per retained run, separate from budget authority.
Use an owner-only O_EXCL guard containing random owner identity, boot identity and exact registered child/container identities.
Private header version 2 binds the canonical selected local Docker socket and bounded Engine-reported ID before child creation.
Reject endpoint/header drift and legacy unbound headers before daemon calls. Same-endpoint recovery may make only the bounded
read-only Engine identity query before rejecting changed/unavailable identity; no container inspection/cleanup/start is allowed then.
Preserve the original guard and state on retained refusal, classified as RECOVERY_REQUIRED. Fresh endpoint/Engine binding
failure instead returns CONTAINMENT_UNAVAILABLE and removes its uninitialized guard; there is no retained execution to reconcile.
There is no automatic migration or reset, and no S02 format/API change.
Validate the public info.ID field through private Docker client config with sanitized environment and finite output/time limits.
A socket pathname identifies an endpoint, not a daemon. Engine ID is trusted-local consistency evidence, not cryptographic attestation.
The trusted operator must not replace or retarget the daemon/socket during a live guarded operation; arbitrary concurrent administrative
rewiring and a malicious daemon are outside this profile. Alias paths are refused so selected/recorded endpoint identities cannot drift.
It is a liveness mutex, not a replacement lease or budget store. A TTL never removes it.
A replacement owner may proceed only after verified old-owner death and exact child cleanup, or explicit safe recovery intervention.
PID reuse, EPERM, an unverifiable owner or missing birth/exit evidence must keep recovery blocked.
S02 claiming alone does not kill an old owner and never authorizes bypass of this guard.
A crash after container creation but before registry persistence is recovered by exact run/generation/nonce labels under the guard.
No broad name-prefix deletion or daemon pruning is allowed.
Persist Docker attach PID/birth facts before SDK initialization or tool/server delivery. Missing birth/exit evidence, including a crash before that registration, blocks automatic recovery and requires explicit safe intervention; it never implies process death.

Cancel revokes new sends/effects first, aborts HTTP and SDK/MCP work, then waits up to two seconds.
After grace, kill exact owned containers and verify `State.Running=false`, exit status, removal and EOF of owned pipes.
Container init and private PID namespaces own daemonized descendants; killing only the Docker CLI is inadequate.
A missing exit/inspection receipt yields `CLEANUP_FAILED` or `RECOVERY_REQUIRED`, never successful cleanup.
A dead SDK channel cannot send; an orphan scratch-only tool cannot mutate the candidate or use credentials.
An HTTP request already sent remains uncertain until definitive evidence settles it.

### Physical sends, admission and usage (A03)

#### Actual pinned request-path inventory

| Path in exact SDK artifact | Selected disposition and enforcement |
| --- | --- |
| `sdk.ts` Agent streamFn -> `ModelRuntime.streamSimple` | Install a guarded public Agent.streamFunction and selected provider via public registerNativeProvider; force injected fetch |
| Multi-turn tool loop and host follow-up | Each actual serializer invocation has a fresh logical request ID and physical-send admission |
| Session `_prepareRetry` | `retry.enabled=false`, `retry.maxRetries=0`, `setAutoRetryEnabled(false)`; no session scheduler owns retry |
| Provider client retry | Force `maxRetries=0`; injected fetch rejects a second invocation for one logical send envelope |
| Manual/threshold/overflow compaction | Disable automatic compaction; explicit host `compact` only; same provider/fetch path and purpose=compaction |
| Branch summary/tree navigation | Host interface exposes neither; deny at model-purpose boundary if reached |
| `CacheWarmer` streaming/idle refresh | `cacheWarming=off`; deny non-active turn/compaction request envelopes; test timer advance and extra-fetch refusal |
| Classifier/image/codemode model helpers | `createCodemodeExtension({models:false})`; selected provider methods refuse classify/images/deferred operations |
| Reviewer/judge/child models | No internal model launch APIs; trusted caller may open another admitted role handle under S02 |
| Virtual/fallback/switched models | Unregistered/denied; final outbound model/API/thinking must equal policy |
| pi-retry and arbitrary extensions | Disabled/rejected before import; no independent continuation/replay scheduler |
| HTTP redirects/WebSocket/deferred polling | redirect=error, HTTP-only; unsupported APIs fail before connection |
| Provider auth/catalog refresh | No ambient discovery or catalog refresh; explicitly bounded host credential-readiness service only |

The guarded `Agent.streamFunction` is the sole creator of an active private provider-invocation context.
It calls the wrapped provider with frozen options. Explicit SDK compaction uses that same public streamFunction.
The provider wrapper requires that context before allocating a broker-fetch slot.
A direct cache-warmer/runtime/classifier call has no such context and is denied, even while a normal turn is active.
Do not classify an unexpected provider call as a free task request merely because its model matches.
Source declarations expose Agent.streamFunction as a public writable property; T0 qualifies the exact actual behavior.

The wrapper is not a prompt-level budget check.
The injected fetch serializes the exact finalized Request bytes to the sole macOS sender.
The SDK container has no network, so a provider path that ignores injected fetch cannot reach the endpoint.
T0 must exercise the real provider serializer/parser with a controlled endpoint and physically count HTTP attempts.
Unexpected transport behavior is a failed qualification, not a reason to enable container egress.
Do not patch SDK prototypes or vendor a runtime fork to make the path work without a new ruling.

#### Send protocol

1. The owner binds an active turn/compaction envelope to immutable role, step, purpose, repair and model facts.
2. The provider wrapper creates one logical invocation ID and an opaque one-use broker-fetch slot.
3. The child materializes finite UTF-8 JSON bytes. Reject streams, multipart, images, unknown APIs and bodies over 64 KiB.
   Assess the exact final bytes on the host, with the current frozen context mode, before creating a S02 reservation.
4. The owner parses and validates the final method/origin/path/model/thinking/output cap and the exact frozen resource identity.
5. Compute a domain-separated SHA256 over method, normalized approved destination, semantic non-secret headers, exact body bytes, model/runtime/policy/lock identities and attempt attribution.
6. Allocate distinct S02 request, operation and attempt IDs. Reserve with actual target identity and declared upper/estimated bounds.
7. Call `authorizeRequestDispatch`. Only `new_dispatch` yields a consumable original permit.
8. Immediately re-inspect current owner and the qualified host clock; compare nonce/generation/clockEpoch and permit monotonic expiry.
9. Consume the original permit once, with no async queue between the last check and host fetch invocation. Force no redirect and no sender retry.
10. Return bounded response bytes to the SDK parser, authenticate the resulting usage against the counted physical response, and persist receipt before acknowledgement.

The consumed-permit set is local memory only. Persisted markers never reconstruct it after a crash.
The state journal supplies replay refusal when that memory is lost.
A changed payload, target, owner, generation, resource version, permit or input classification yields zero physical sends.
If `authorizeRequestDispatch` returns existing, a state failure or an unknown commit, send nothing.
A refusal after authorization preserves uncertainty conservatively; no automatic refund is allowed.

There is a real check-to-send race: another trusted process could change S02 immediately after the final check.
The execution guard prevents cooperating owner replacement while the old owner is live.
An already-begun send cannot be remotely fenced by a SQLite lease, JavaScript check or local kill.
Record this limitation. Tests prove refusals at deterministic before-send boundaries, not impossible distributed atomicity.

Exactly one scheduler owns transport retry: the macOS sender.
Retry only explicitly classified terminal HTTP failures permitted by policy; no automatic retry after ambiguous transmission.
Each retry reserves a new request/attempt, sets `transportRetryOf` to the original/prior physical request, and shares purpose/repair attribution.
Use bounded delay at most 1,000 ms, at most the persistent transport cap and remaining task deadline.
A second SDK/provider fetch in the same logical invocation is denied even if its exception text resembles a retryable failure.
Length/empty responses do not trigger automatic continuation. Tool-loop turns still require new admission.
A caller's later admitted continuation cannot reset calls/retries/charges or imply that an unknown original used zero tokens.

#### Normalization and context

Raw provider usage is private evidence, not a model claim or an unbound message-event number.
For the selected Anthropic-message route, normalize non-cache input plus cache-read plus cache-write as input.
Do not add `totalTokens` again. Output already includes provider-accounted reasoning; do not add a second thinking count.
T0 verifies the exact pinned parser's overlap rules and required raw fields.
Missing, malformed, contradictory or unsupported counts remain unknown; finite estimates remain estimated.
Use safe integer validation for each quantity. S02 retains exact large totals and violations.
Pricing from catalog tables is estimated cost. A cost is reported only when the provider explicitly reports that monetary quantity.
Duplicate completed-message/receipt events cannot settle twice or release another request's slot.
A terminal HTTP error may confirm request termination while usage remains unknown; preserve the reservation charge.
An abort, disconnect or host death does not confirm remote termination and retains the required live slot.

Before every physical attempt, assess the exact finalized body under the current immutable context mode.
The selected live route is soft_only. Default proven_bound has no qualified proof for this route and returns CONTEXT_UNSAFE before send.
Explicit estimated_guard uses the numerical policy below. Its absence of a complete tokenizer bound is accepted for that mode only.
A controlled endpoint's exact synthetic count does not upgrade live context or billable-token capabilities.

##### Estimated context policy v1

Estimator ID: `lw-pi-final-json-bytes-v1`. Version: 1. Evidence: declared heuristic plus local qualification, never tokenizer proof.
Let B be the exact UTF-8 byte length of the finalized HTTP JSON body after every provider/extension transformation.
Estimate current input as `I = B + 32768` tokens. The one-byte-per-estimated-token coefficient deliberately charges every serialized byte.
It counts system, messages, retained thinking/signatures, tool definitions/schemas, arguments/results and structural fields.
The 32,768-token service/envelope margin is an operational safety allowance, not a bound on hidden provider input.
Reserve another 16,384 tokens for future tool/protocol headroom. Reassess all actual tool-result bytes on the next request.
Choose `O = min(contract.perCallOutputTokens, policy.maxOutputTokens, 1024)`, an integer from 1 through 1,024.
The final serialized max_tokens must equal O; thinking and visible output share that limit. A mismatch refuses before transmission.
Use `C = min(frozenModel.contextWindow, policy.workingWindowCeiling, 98304)`.
The host may tighten these limits, never widen them within v1: lower byte/window/output ceilings or increase margins/reserves.
Mode/estimator/limits/model/resource identities are part of the frozen policy digest, request identity and capture envelope.

Refuse unless B <= 65,536 and `B + 32768 + 16384 + O <= C`.
At the default C=98,304 and O=1,024, B=48,128 is the inclusive guard boundary; B=48,129 is refused.
The transport byte ceiling is separately 65,536. A schema-valid body between these limits can fail the headroom guard.
These thresholds bound local work and provide operational headroom. They are not empirically calibrated token upper bounds or billing promises.
A large advertised model window does not weaken the smaller working-window policy.

Validate coverage before estimating: fatal UTF-8 decode; one finite JSON object; maximum depth 32, nodes 8,192, 128 properties per object and 128 items per array.
Reject duplicate JSON object keys, non-finite/unsafe numeric fields, invalid surrogate strings and an unknown top-level input field.
Use the pinned final request schema: model, messages, system, tools, tool_choice, thinking, output_config, max_tokens and stream.
Require stream=true, exact model/effort/adaptive-thinking settings, a finite output cap and only granted tool names.
Temperature, server tools/connectors, images/documents/audio, remote references and unknown content-block kinds are unsupported in v1.
Known message blocks are text, thinking with bounded signatures, redacted_thinking data, tool_use and tool_result.
Encoded thinking/signature/redaction bytes are included in B without decoding or dropping them; their service interpretation remains estimated.
All strings, complete tool input_schema JSON, nested argument/result text and body punctuation count through their exact serialized bytes.
Qualify the exact final serializer shape, cache_control fields and supported mid-conversation structure on actual SDK requests.
If a mandatory emitted shape is incompatible, refuse and return evidence; never strip fields or silently widen the admitted schema.
Do not strip fields, omit schemas/signatures, reuse a prefix count, substitute a prompt-only count or ignore an unknown block to pass the guard.
Refuse external schema references and malformed tool-call/result pairing before effects. Schema content is data, never authority.

`ContextAssessment` records mode, estimator ID/version, model/catalog/policy digests, B, I with estimated provenance,
service margin, tool reserve, O, C, the inequality result, evidence level and contextFit=unproven for estimated_guard.
Each physical attempt persists its content-free assessment before admission and binds it into raw/final receipts.
A context_assessment event carries the same bounded record: estimator/version/provenance, B/I/O/C, margins,
byte/headroom inequalities, coverage and final-body/model/catalog/policy identities. The associated record remains available;
a digest alone is insufficient. Refused covered bodies retain their numerical assessment without authorizing a request.
Unsupported coverage remains explicitly unsupported; unavailable safe assessment is null. Strict preflight refusal precedes a handle.
Capabilities identify the estimator/version/provenance. No raw prompt, schema, signature or credential enters normal logs.
A tighter host requirement for proven_bound, changed policy, missing coverage, invalid limits or a failed inequality returns CONTEXT_UNSAFE with effect=none.
Never retry that refusal as a softer mode. The caller must obtain a new authorized policy; an existing run identity cannot be mutated.

For S02 soft_only reservation, set inputUpperBound=I, outputUpperBound=O and totalUpperBound=I+O.
These existing field names hold the declared soft reservation, not a new hard guarantee. Set coversAllBillableTokens=false.
Do not charge the speculative future-tool reserve as current usage; the next real attempt reserves its own finalized input estimate.
Capability output enforcement is claimed only after its actual serializer/transmission qualification passes.
Reported receipts remain separate from estimated reservations; no estimator value becomes reported provider usage.

Explicit compaction uses the identical mode, finalized-byte estimator, limits, sender and parent budgets, with purpose=compaction.
Frozen SDK settings keep approximately4096recent tokens for explicit compaction; automatic compaction remains disabled.
This is an SDK history heuristic, not a complete context bound. The native default20000-token tail exceeds the useful history
under the adapter's65536-byte request ceiling; the smaller fixed tail permits a separately admitted manual summary.
The stream wrapper freezes the selected reasoning level for both ordinary generation and summary requests.
If the compaction request cannot pass its own guard, return CONTEXT_UNSAFE; do not disable its schemas or drop tool pairs to fit.
No automatic compaction or continuation follows a context/output failure. Preserve the last safe session and original uncertain work.

##### Post-send context, truncation and parser failures

The host observes the original HTTP status and bounded SSE bytes. Child success or usage numbers cannot override them.
An authenticated complete provider context error or a raw model_context_window_exceeded stop returns CONTEXT_LIMIT, retryable=false.
A max_tokens/length stop returns OUTPUT_LIMIT; EOF without a complete terminal response returns RESPONSE_INCOMPLETE.
An unknown stop reason, malformed SSE/usage or actual pinned-parser error returns PROVIDER_RESPONSE_INVALID.
An unexpected pause_turn or unrequested stop_sequence is RESPONSE_INCOMPLETE, even if the SDK maps it to a normal stop.
Both set the failure latch and grant no automatic follow-up or tool effect.
All prevent successful execution settlement. Error-looking text in a model message alone is not a trusted context-limit signal.
If parser and raw response disagree, keep the failed outcome and conservative uncertainty; do not manufacture an SDK success message.

A recognized raw context-limit stop remains a failure even though the pinned parser treats that unknown stop reason as an exception.
Use the real unmodified parser. The native stream catches that internal exception and emits an error result. The host normalizes that actual result with raw evidence;
no SDK fork, fake parser exception or fabricated replacement stream is allowed.
On a parser failure, the owner may drain the same response for at most 250 ms, within the original deadline and 1 MiB aggregate cap.
This creates no second request and does not extend run deadlines. Missing definitive terminal evidence retains unknown termination and its slot.

Bind usage/termination to this physical request's raw response and S02 receipt subject.
Only confirmed final raw usage fields become reported totals; missing fields remain unknown unless the qualified route explicitly defines absent as zero.
Cache-read/write input fields are added once; reasoning is already part of output. Catalog cost remains estimated.
An HTTP error alone never proves zero tokens or authorizes a not_executed refund.
If authenticated evidence confirms termination but usage is incomplete, preserve the charge and release only the slot permitted by S02.
If termination is unknown, preserve the required charge and live slot. Local abort/process exit or parser rejection cannot refund them.
Completed raw usage plus a failed parser may settle usage while adapter execution still fails; accounting and execution outcomes are separate.
Duplicate receipt/event delivery must not double-settle or release another request's slot.

For a root model-origin tool call, require a complete, schema-valid raw tool_use stop and bound request/call ID/name/argument digest before effect.
A nested codemode/MCP invocation binds to that admitted complete parent invocation, then independently passes exact-name/effect/scope/current-authority checks.
Do not invent a separate provider tool_use entry for each nested call. A partial or failed parent grants no nested effects.
Length/context/unknown stops or incomplete JSON arguments grant no tool execution, even if the SDK exposes a partial call candidate.
Keep complete tool call/result pairing. Never capture/restore incomplete response/tool state as a successful safe session.
A context/length/parser failure sets a turn failure latch: later agent_settled cannot clear it or return execution_settled.
The next action requires a distinct explicit admitted host command under the same mode after required reconciliation.
Never automatically repeat the same oversized body, reclassify it as an ordinary attempt, reset counters or infer that its original cost was zero.

### MCP, native codemode and effect policy (A05)

Enable only the actual pinned SDK MCP extension plus its native codemode factory.
MCP config is supplied by `createMcpExtension({loadConfig,createTransport,...})`, with no file discovery or writable config management.
The custom transport is the supported integration seam, not a replacement tool dispatcher.
It carries real JSON-RPC over owner-held pipes to the actual owned stdio server container.
T0 tests the exact transport interface before choosing its final internal class.
No remote URL, shell command interpolation, environment expansion or OAuth interaction is accepted from repository config.
This restriction concerns untrusted inputs. S04 owns single-pass interpolation in operator-selected approved configuration from the trusted launching environment, followed by validation of exact server, destination, credential binding and permitted effects.
Explicit file selection or successful interpolation alone grants no server/transport permission. Missing or invalid credentials must fail before spawn/network; resolved secrets stay in trusted mediation, absent from model context, tool output, ordinary events and checkpoints.
For any later supported stdio credential route, only the designated server may receive explicitly allowlisted values; generic shell tools receive none. S03's local read-only server requires no such values.
Remote and OAuth configuration is rejected in preflight. An unexpected authentication challenge returns a bounded authentication-required failure, with no browser, credential-store discovery, scope escalation or anonymous retry. OAuth consent, refresh and interactive login remain unimplemented and explicitly open for the later configuration work.

Initial production MCP capability is a frozen local read-only workspace server:

| Name | Effect | Exposure/authorization |
| --- | --- | --- |
| `mcp__workspace__read_file` | read_only, bounded regular file under candidate | exact allowlist, fixed direct exposure; enabled native codemode can call the same granted tool |
| All other MCP names, including similarly prefixed tools | denied | hidden plus explicit owner authorization refusal |
| `codemode` | local computation plus individually admitted nested tools | real native QuickJS path, models=false, finite CPU/memory/output limits |
| `read`, `bash`, `write`, `edit` | read-only / scratch-local / mediated local_write | exact role tools intersect frozen policy; no builtin host filesystem fallback |

The negative server fixture additionally advertises denied_write, quiet and progress-flood controls.
These are test fixtures, not enabled external effects or production fallback tools.
A hidden tool, tool search result or nested call still passes the real Pi hook/pipeline and owner-side exact-name/effect check.
`tools` lists must contain exact `mcp__` entries when MCP is used; a builtin-only list can leave MCP names registered.
Use default hidden exposure and precise toolExposure overrides. Visibility alone never grants execution.

Native codemode tests must execute real scripts, real ctx.executeTool and real MCP JSON-RPC.
An allowed nested read must succeed; a denied direct/nested/search-selected write must produce zero effect markers.
Test attempted models.classify/generateImages, filesystem/process/network globals, infinite code and excessive output.
The VM and its worker remain in the SDK container. No promise of VM safety is based only on a mock nested dispatcher.

MCP timeout is **seconds**, and progress resets the idle timeout in the pinned implementation.
Use a 2-second idle timeout, 10-second absolute call limit and the smaller remaining task deadline initially.
A host monotonic watchdog enforces absolute time independent of progress and the SDK's timers.
Bound JSON-RPC argument/result messages to 64 KiB, progress frames to 4 KiB and total progress to 64 KiB per call.
Terminate a flooding/hung server and reclaim its exact descendants/container; drain and cap stderr separately.
No external-write tool is enabled. Local server exit proves local cleanup, not remote non-execution.

### Events, safe session capture and bounded cost (A06/A07)

Every event has version=1, lockHash, runId, roleId, stepId, sessionId, nullable attempt/request/operation IDs and a monotonic sequence.
Closed event kinds: resource_identity, context_assessment, request_start, request_receipt, request_uncertain, tool_start, tool_end,
retry_wait, cancellation, process_exit and settled.
A synced owner-only sequence file retains the last issued number across capture, close and restore; it grants no request or accounting authority.
The event carries typed metadata, counts, digests and bounded error codes; no prompt, thinking, raw arguments or credentials.
The normal event stream does not contain assistant content. Explicit private artifacts hold requested content under owner-only access.
Human diagnostics escape newline/control/ANSI/workflow syntax, rather than interpolating SDK exceptions into logs.

Execution settlement requires the actual `agent_settled`, no pending admitted commands/retries/compaction, all local tool work accounted for, and terminal local lifecycle facts.
Explicit manual compaction uses its actual successful manual `compaction_end`; it must also be idle with every provider parser acknowledgement complete and no pending work. The pinned SDK does not emit `agent_settled` for standalone manual compaction.
The first `agent_end` is an intermediate event.
Adapter outcomes are execution_settled, failed, cancelled, blocked or recovery_required.
Provider termination/usage status and process exit/cleanup remain separate fields.
An execution_settled result is not deterministic acceptance or billing finality.
The context/length/parser/incomplete-tool failure latch takes precedence over agent_settled and process exit0.
Expose failed or recovery_required according to termination/accounting facts; incomplete output never becomes successful execution.
An uncertain provider/tool effect yields recovery_required even if the SDK process exited cleanly.

| Item | Initial fixed bound and overflow behavior |
| --- | --- |
| Public input/lock validation | Existing core 1 MiB/shape limits; copied owned values; no getters/shared buffers |
| Prompt / diagnostic text | 16 KiB / 1 KiB; reject input or truncate escaped diagnostics with a flag |
| HTTP body | 64 KiB plus the stricter context guard; reject before reservation/send |
| Provider response | 1 MiB total per physical attempt; abort at limit and preserve uncertain/partial accounting |
| Protocol/event frame | 64 KiB / 4 KiB; reject oversized frame before JSON parse |
| Pending response/event queue | 256 KiB response channel / 128 events (at most 512 KiB) |
| Tool/MCP args and results | 64 KiB each; fail operation rather than buffer arbitrary output |
| Private session/transcript | 8 MiB artifact, at most 16 MiB resolved artifact total; preserve core limits |
| Candidate manifest | At most 256 entries, 8 MiB per file, 16 MiB resolved total, matching core |
| Tool wall deadline | At most 10 seconds and remaining run deadline; caller may request a smaller bound |
| S02 retained records | 1,024 requests, 2,048 operations, 64 checkpoints; no pruning/reset |

The frame and pending-response ceilings are fixed transport profile identities. A policy requesting different values fails with CAPABILITY_UNSUPPORTED before startup; it is never silently widened. Diagnostic bounds below the 64-byte encoded metadata minimum are likewise unsupported.
Apply byte limits while reading, before assembling JSON or complete streams.
A slow consumer first applies finite backpressure. Queue exhaustion revokes further execution, persists unresolved facts if needed,
then exposes `EVENT_OVERFLOW` through the command result/final bounded status; it never silently drops authoritative transitions.
A disconnected consumer follows the same cancellation policy. A terminal return does not depend on draining an unbounded event queue.
Do not keep two full copies of every transcript and provider stream without accounting for both in the measured bound.
The final core artifact inventory must fit 16 MiB including candidate, resources and private session artifacts.
A candidate that leaves insufficient capture headroom fails with OUTPUT_LIMIT; do not exceed core limits.

Use `SessionManager.inMemory(cwd, options, entries)` for fresh and restored sessions, with explicit trusted entries.
The factory's optional entries parameter is present in the exact 1.5.0 declarations.
Capture only after settled, no pending tool call/result pairing, and no unresolved request/operation in current S02 state.
Persist private snapshot bytes in a synced temporary inode, publish by no-overwrite hardlink/unlink and sync the parent,
then publish the reference through S02 writeCheckpoint(expectedRevision).
A crash before checkpoint commit leaves an unreferenced artifact; it supplies no restore permission.
A crash after commit before acknowledgement is resolved by identity lookup, not by rewriting an older ledger.
Bind runtime graph, image, resources, policy, lock, role/step, candidate manifest and session-entry digest in the envelope.
Restore verifies every byte, current ledger, original deadline and owner execution guard before session creation.
Never auto-call prompt/resume on restore. Unknown pending work requires explicit reconciliation, not an empty successful session.

#### Bounded integration measurements

S02 validates retained state on operations; adapter calls must not assume constant-time whole-ledger checks.
Measure reserve/authorize/receipt/inspect cost at 1, 128 and 1,024 retained requests on real local storage.
Measure event/HTTP/tool flood caps, wall-clock abort latency, process/container exit, heap/RSS samples and queue high-water marks.
Use at least five repeated local fixture runs per size, report sample count/range and exact environment.
The measurements set practical fixed limits and expose growth; they establish no throughput SLA or provider latency claim.
Do not add a ledger cache, bypass validation, prune uncertainty or change S02 limits for better numbers.
If the selected limits cannot coexist with S02's 64 KiB mutation/16 KiB row bounds, shorten metadata/digests and remeasure.
If a required larger limit changes a merged contract, ask for a ruling.


At retained counts 1, 128 and 1,024, five fresh-connection measurements use the public reserve, authorize, receipt and inspect paths with exact existing identities. The capacity measurement cannot issue a new permit. Report these idempotent validation timings separately from public fresh-record population cost; neither is a provider throughput measurement. No private SQLite seeding, retained-record pruning or ledger cache is used.

### Frame assembly and authenticated usage

Chunk bodies larger than a protocol frame into at most 32 KiB data frames, with an upfront aggregate length and digest.
Allow only one bounded assembly per active operation. The 64 KiB body, 1 MiB response and 256 KiB pending-channel ceilings remain distinct.
Reject out-of-order, duplicate, oversized, extra or digest-mismatched chunks before dispatch or usage settlement.
Do not relax the per-frame cap to accept a larger aggregate. Do not buffer unlimited partial assemblies.
The host captures the exact provider response and normalizes supported usage fields from those bytes.
Child events are comparison candidates only. A child-supplied number alone cannot become an authenticated provider receipt.
A discrepancy or unsupported response shape retains unknown usage and requires diagnosis.

### T0 feasibility checkpoint

The pinned SDK and locked graph ran in an owned Linux arm64 image, with macOS retaining state authority.
Actual SDK final serialization covered non-empty tools, eager_input_streaming, cache controls, thinking signatures, tool results and mid-conversation system messages.
Default proven_bound refused before the physical fixture send; explicit estimated_guard admitted its inclusive boundary and refused the next byte.
Controlled responses exercised HTTP and streamed context errors, output length, pause/stop-sequence, unknown stop, EOF, malformed/truncated streams and incomplete tool arguments.
The raw-response helper and irreversible failure latch denied failed-response tool admission; complete tool_use admitted its exact root ID.
Actual native codemode/MCP ran across separate network-none containers with an allowed read and denied hidden/failed-parent fixtures.
Positive scratch/read and negative protected/host/credential/IPv4/DNS/IPv6/known-reachable-host controls passed under inspected restrictions.
Owned intent/name/nonce was persisted before creation. A killed outer worker's TERM-ignoring detached child/grandchild tree was reclaimed by exact labeled ID;
a separate creation-to-ID-record interruption was recovered through its verified intent. Final exact absence receipts are retained.
Build, typecheck, lint and all 228 tests passed, preserving the existing 219. Four targeted production-guard mutations failed behaviorally as expected.
The final source was rebuilt into a separately identified runtime image and affected contained paths reran against its baked files, with no qualification-source bind mount.
These are local feasibility fixtures, not S02 production sender admission, authenticated production root/nested authority, live-provider, billing or deployed-host acceptance.
T0 is complete. T1 now adds the frozen factory, owned input/resources, isolated SDK boot and exact model/thinking checks. T2-T7 still own production send/tool/lifecycle integration and final A01-A09 closure. Eight authorized live calls remain unused.

### T1 implementation checkpoint

The package exports one factory plus readonly types; raw SDK, state constructors, Docker controllers and injected test ports remain internal.
The owner validates input/resource/role/capability identities before startup, uses the caller's original state authority, and renews it during SDK boot and while open.
The SDK runs in an owned network-none Linux container with inspected image/user/environment/namespaces/seccomp/mount/resource controls and an inherited nonce/sequence-bound pipe.
Actual local Sonnet/xhigh and Opus/high SDK sessions and finalized request fixtures matched the requested selection, included declared UTF-8 resources and excluded a repository APPEND_SYSTEM canary.
A separate actual default-loader control admitted its synthetic APPEND_SYSTEM, confirming the discovery-positive condition without a live send.
Runtime construction preserves relative workspace symlinks; the earlier dangling host-absolute links and failed import receipt remain distinguished.
At the T1 checkpoint, command dispatch was refused until T2 installed the production state-aware sender.
The historical T1 HTTP resource fixture had zero S02 request records and proved no production admission/accounting fact.
Capture/restore remain refused until T5. The T2 checkpoint below supersedes the earlier dispatch limitation.

### T2 implementation checkpoint

The production owner now connects RuntimeSession's private invocation, finalized-fetch, parser-ACK and root-tool messages to the same S02 sender.
Only original owner-local one-use tickets can transmit; saved dispatch markers, stale owners, expired permits and changed payloads send zero.
Actual HTTP mutations confirmed the final owner check and one-use check matter: removing them permitted a stale send and duplicate sends.
Raw metadata receipts precede native parsing acknowledgements; finalized usage is persisted before an admitted raw parent may authorize a root call.
Input includes cache-read and cache-write counts once. Missing counts, parser disagreement, unknown termination and cost remain unknown.
A terminal429 retry has a new persistent request/attempt and retains the original unknown charge. Native retries remain disabled/one-use blocked.
The contained public factory bootstrap passed native runtime/event-bus identity, final role cwd, repeated final-loader reload and poisoned-input controls.
The initial exact-URL refusal was reproduced, then fixed to the pinned native beta messages URL without accepting other paths or queries.
Actual native authorization produced one fixture effect after a complete raw tool parent and two physical attempts including its continuation.
Pause and stop-sequence parents reached the native hook but produced zero effects; context, length and incomplete parents also produced zero effects.
Each failed parent sent once, latched execution failure and could not trigger a further physical request. The effect marker is not OS tool containment.
The production adapter/RuntimeSession/S02 path also completed explicit compaction and a later turn, retaining task/task/compaction attribution.
HTTP context failure and partial summaries preserved failure/uncertainty and produced no extra request. A replaced owner sent zero and retained STALE_OWNER.
Declared resources reached the real controlled endpoint; the candidate APPEND_SYSTEM canary remained absent.
These are actual isolated SDK/parser and host SQLite/HTTP fixture observations, with a private constructor-injected local HTTP transport.
They prove no live-provider internal effort, billing bound, OS tool effect, recovery capture or deployed-host acceptance.
T3-T7 still own production tools/MCP, lifecycle/capture/restore, dispositions/live observations and final reviewed closure. No live call has been consumed.

### T3 production tool checkpoint

The production SDK uses native public tool descriptors and an official execution bridge for read/bash/write/edit.
The owner rechecks finalized tool arguments against the raw parent after native hooks, before any effect.
Actual S02 dispatches and final receipts bind each local operation, its parent request, target and result digest.
Host mediation committed an allowed new file and exact edit. Native read returned its new bytes from a separate Linux tool container.
Native bash created scratch output while candidate/root writes, link/rename tricks, host reads and credential environment access failed.
IPv4, IPv6, DNS and host-gateway controls failed to connect; the host control endpoint was independently reachable.
A later bash call received fresh scratch. A detached cancellation-ignoring descendant ended with its owned container.
Protected/new-protected paths, case aliases, traversal, absolute host reads and unsupported rename arguments produced no local operation.
An output flood failed with OUTPUT_LIMIT and no model follow-up. Normal and denied cases retained physical-request accounting.
All nine controlled-endpoint cases passed with fourteen exact container exits and verified absence; these are local execution observations.
The original final-arguments regression permitted a changed write after its hook. Revalidation now rejects it before the file effect.
Real filesystem tests also rejected ancestor symlinks, existing hard links, changed old bytes, ambiguous edits and repeated dispatch identities.
The qualifier's initial cleanup registry lost retained IDs; its fixed owner registry preserves them across cases and after fixture deletion.
No provider/auth call, live billing bound, capture/restore, complete MCP integration or deployed-host acceptance is claimed.
T4-T7 remain pending; the T0 and native-factory budgets remain closed.

### T4 native MCP and codemode checkpoint

The real public MCP and codemode factories compile once beside owner authorization in the trusted empty namespace.
The final role retains their native runtime/event-bus identity, its admitted cwd and frozen resources.
MCP configuration is literal and local. The exact compiled workspace-server digest is checked before startup.
The actual native MCP client uses the owner transport and a separate read-only stdio server container.
Native hook identity, final argument digest and RPC identity bind each actual read to a one-use original S02 dispatch.
The raw server result is checked and its receipt persisted before the native client receives it.
Malformed, changed, duplicate or ungranted requests cannot acquire a fresh read permission.
No implicit connection restart or uncertain-call replay is enabled by the owner.

Native codemode runs the real QuickJS worker with models=false. Pure VM computation has no host effect authority.
Every nested read/bash/write/edit/MCP effect still needs the active raw code parent and its own owner admission.
The owner bounds active roots and nested proposals, rechecks final arguments and cancels each bridged call on abort.
An independent host watchdog bounds each VM root by the smaller remaining task deadline and toolWallMs, at most10seconds.
The native VM has a256MiB heap limit within the512MiB SDK container.
Its internal output cap is16,777,216 characters or100,000 items; this is not a UTF-8 byte bound.
The owner channel admits at most64KiB tool results before a model continuation; oversized native results fail closed.
These are distinct internal/transport limits, not a claim that the SDK buffers only64KiB internally.

Twenty actual SDK/MCP/QuickJS/owner/S02/controlled-HTTP cases passed on the frozen image.
Direct and nested reads returned candidate bytes. Native nested read and MCP each retained their separate confirmed operation.
The VM exposed none of process, require, fetch, WebSocket or models; filesystem/process/network and model-helper attempts failed.
An independent contained fixture control proved denied_write could create its scratch marker.
Actual hidden direct, nested and search-selected calls sent zero server tool commands and left that marker absent.
An ungranted direct name also made finalized follow-up context fail closed before another physical request.
Infinite code and oversized native output produced no model follow-up and required conservative failure/cleanup.

The timeout fixtures tightened the allowed settings to2second idle,3second absolute and2second VM deadlines.
A quiet read timed out. Repeated progress exceeded the idle interval, then the independent absolute watchdog stopped it.
Oversized progress frames reached no native client; cumulative progress stopped within64KiB.
A real detached server child ignored SIGTERM and ended with its owned container.
All42 containers, including the independent fixture control, had exact-ID absence after verified cleanup.
The changed common tool/permission path also passed all nine T3 containment cases again.
These remain local execution and synthetic-count observations; no live/model/count/auth call was used.
T5-T7 still own lifecycle/events/capture/restore, final dispositions/live evidence and independent ship review.

### T5 lifecycle and recovery checkpoint

T5 supersedes the earlier lifecycle/capture/restore limitations. All 306 deterministic tests passed with zero skips.
Execution uses actual native `agent_settled`; standalone manual compaction uses successful manual `compaction_end`.
A native follow-up produced two intermediate `agent_end` events and one final settlement, with both parser receipts acknowledged.
Pending work, aborted state and incomplete tool pairing cannot create a safe capture boundary.

One persistent O_EXCL guard fences each retained run. It records boot, owner PID/birth and fsynced nonce/container/attach intents.
A live old owner blocked replacement even after its S02 lease expired and a new generation was claimed.
Recovery requires verified old-owner and attach-process death, exact labeled container exit/removal and final absence.
Missing or mismatched liveness evidence stays blocked for explicit safe intervention. Lease expiry never removes the guard.

Capture streams acknowledged chunks of at most 32 KiB into owner-only immutable artifacts before S02 checkpoint publication.
The workspace artifact contains the manifest and bounded file chunks; the private native artifact contains validated session rows.
Runtime, policy, resources, role/step, original clock basis and candidate identity are bound to both envelopes.
S02 atomically retains the checkpoint ledger root; the adapter does not import a private state API or duplicate that root computation.
Same-ID lookup resolves a committed capture acknowledgement gap. Unreferenced files grant no recovery authority.
Restore rechecks all bytes/current S02 facts and passes trusted entries to public SessionManager.inMemory, with no prompt or resume call.
The original counts and deadline remain current when restoring an older known checkpoint.

Five native capture/restore cases passed: ordinary execution, queued follow-up, manual compaction, committed candidate write/tool pairing,
and native codemode with separate MCP/native-read operations. Restore sent zero requests until an explicit new command.
Seven native lifecycle controls covered finite slow-consumer backpressure, terminal EVENT_OVERFLOW, disconnect uncertainty,
a 1,267,525-byte private snapshot, transcript overflow, encoded/truncated diagnostics and idle task-deadline cleanup.
Six actual SIGKILL cases covered pre-artifact publication, pre-checkpoint commit, post-commit acknowledgement loss,
provider send before receipt, receipt before SDK acknowledgement and candidate write before its operation receipt.
Unknown provider/tool effects stayed charged or unresolved and blocked automatic recovery. Known receipts were not replayed.
All 30 recovery-matrix containers had exact-ID absence. The same final image also passed all 20 MCP/codemode and nine tool-isolation cases.

The ordered event queue retains prior transitions before terminal overflow; a synced counter prevents sequence reuse after restore.
A behavioral mutation reproduced an acknowledgement race that cleared the next snapshot sink guard; the final guard rejects overlapping chunks.
Liveness exclusion, settled-only capture and restored-policy identity mutations also failed behaviorally, then passed after restoration.
Diagnostics retained 1009 encoded bytes under the 1024-byte ceiling, with a truncation flag and no raw control/workflow text.
These remain local native execution with controlled HTTP and synthetic reported counts. No live/model/count/auth call was consumed.
T6-T7 still own final optional-runtime dispositions, live-route accounting, documentation and independent ship review.

### T6 dispositions and integration-limit checkpoint

T6 rejects pi-retry/durable selectors before credentials, environment setup or session startup.
No optional package is installed/imported, and no upstream private-hook/reset matrix is claimed passed.
Five native disposition cases passed with the plugin absent. Explicit empty requests did not nudge themselves;
length stops did not continue automatically; separate SDK sessions retained shared S02 counts.
A new SDK session under an exhausted one-call parent budget sent zero additional requests.
Ordinary failures and oversized responses retained uncertainty and blocked reopening.

The limits command passed eight native queue/response/transcript/diagnostic/deadline cases and all 20 MCP controls.
Five fresh-connection capacity samples reused the same publicly populated 1,024-record store and original clock basis.
After the original deadline, recovery ownership permitted exact existing-identity validation but granted no new execution permit.
Receipt lookups through a later generation used public terminal reconciliation and retained the same charges.
Historical 1/128/1,024 samples and current samples remain distinct; no state reset, private seeding, pruning or cache was added.

Live qualification remains BLOCKED: no explicit ready-token source was supplied. Zero live/model/count/auth calls were consumed.
The live CLI requires explicit estimated_guard and a bounded owner-only ready-token file; environment/auth-store discovery,
refresh, token-count requests and browser login are absent. Missing prerequisites return nonzero structured BLOCKED before transport.
An append-only independent eight-attempt counter spends before credential delivery, retains spends across processes and refuses a ninth.
The driver also retains one S02 parent, enforces per-command limits, uses safe prior snapshots and has no reset command or hidden compaction warm-up.
Local counter/readiness tests use synthetic files and establish no live provider acceptance.
The runtime evaluation document records A01-A09 levels, alternatives, measured ranges and remaining owners.
T7 still owns final documentation/wiring/audits and independent my-ship review.

### T7 initial validation candidate before ship corrections

The root overview, adapter/development guides, host lifecycle example and architecture decision now describe the implemented boundaries.
The public-import lifecycle example typechecks against the actual exported declarations.
At that initial candidate, the non-live `all` runner included 14 registered groups: derived image, both model selections, physical sends,
context/parser controls, runtime path, containment, MCP, recovery, dispositions, limits, descendant cleanup and mutations.
Its complete precommit run passed. Missing compiled fixtures, Docker profile/configuration or pinned image returns structured BLOCKED.
An older session fixture's empty-tool expectation was corrected to the admitted read-tool list; production enforcement did not change.
All 311 deterministic tests passed with zero skips and the original 219 retained.
The final committed tree still needs exact-head checks, recursive committed-reference audit and independent my-ship review.
T7 remains pending until review findings and exact completion/close/exit receipts are resolved.

### Ship correction candidate

Failed execution facts now remain explicit outcomes with separate original and cleanup errors. Context assessment metadata
is retained per attempt and on covered refusal; the actual validated catalog window replaces literal sender assumptions.
Whole-command timing follows the original task deadline while per-send/tool/MCP caps remain separate.
Current source has deterministic regressions for these behaviors, generated filesystem paths with spaces, and per-user socket selection.
Qualification cleanup retains its selected endpoint. The private execution guard additionally binds Engine identity;
controlled retained-guard tests are separate from the required real one-daemon SIGKILL/recovery reruns.
The final qualification runner now has 15 groups and registers bounded owner/send-once mutations and inventories historical closed diagnostics.
New-source native validation, final committed-head checks and the next independent review remain pending at this candidate stage.

### T7 completed local branch preparation

All 350 deterministic tests passed with zero skips and the original 219 retained. The final executable source passed all
15 non-live qualification groups in 208.579 seconds, including both selections, counted sends, native tool/MCP/codemode,
recovery, finite limits, watchdog and context/owner/send-once mutations. All 159 registered containers from that run were
confirmed absent by exact-ID inspection on the same verified daemon. This is local fixture/container evidence.
Three root-adopted independent Pi review rounds completed; the last Spec and Standards axes were clean.
Accepted corrections preserve S02-accepted per-command usage, truthful cancellation, fresh-versus-retained refusal,
context metadata, catalog windows, original deadlines, resource selection, path handling and daemon binding.
The later-active-turn and completion-race cases also passed before the last correction; they preserve behavior rather
than prove those exact cases needed a fix. The executed race covers cancel before finish; finish before cancel was source-inspected only.
Idle cancellation keeps the prior terminal status; localCleanup and cleanupError describe its actual shutdown.
Status Shipped and checked T7 mean completed local branch preparation. Coordinator final acceptance and local merge
remain separate; no remote publication occurred. A clerical-only final status commit retains the qualified executable
inputs, with final root/content/signoff checks and source-equivalence evidence. No unchanged native matrix is rerun.
Live remains BLOCKED before transport without an explicit ready-token source; all eight calls remain unused.

### Approved additional local qualification budget

The current continuation adds 1,200 seconds to the previous cap of 3,000. Total is 4,200, with 2,954.192 consumed and 1,245.808 remaining at the new start. All further qualification work counts. Current command deadlines are rebuild 30, typecheck 60, lint 60, tests 90, added serializer/parser/context 180, mutations 60, runtime refresh 120, contained rerun 60, descendant/watchdog 60, plus exact cleanup 120 seconds reserved (840 total). Preserve ownership intent/name/nonce before spawn and verify exact labels/IDs, including create-to-ID-record interruption. The earlier budget chronology below is retained rather than reset.

Original conservative T0 consumption is 738.249 of 1,200 seconds. Remaining original allowance is 461.751 seconds.
The approved additional 1,800 seconds makes the cap 3,000 and the remaining allowance 2,261.751 seconds at resumption.
The prior 738.249 seconds remains consumed. Keep eight live calls unused and separately bounded; this local extension authorizes no model/count/auth operation.
Each command has an independent deadline and also stops at the remaining aggregate budget. No retry loop may reset either.
Reserve 120 seconds for exact owned cleanup before starting an action that creates a resource.

| Approved command/stage | Deadline | Required result and cleanup |
| --- | --- | --- |
| npm ci | 120 seconds | Frozen approved dependencies only, in this worktree; no global installs |
| npm run build | 90 seconds | T0 package/runner builds; preserve core/state |
| npm run typecheck; npm run lint (separate commands) | 60 seconds each | No new shared-contract errors or unrelated edits |
| npm test | 90 seconds | Existing 219 tests plus the implemented T0 checks; no skipped qualification disguised as success |
| runtime-image: pinned base pull | 240 seconds | Exact base digest; task-local Docker client config, no host settings change |
| runtime-image: owned derived image build/import | 480 seconds | Frozen graph/image/config identity; Linux SDK/native import; owned build context only |
| context-guard plus parser-context-failures | 180 seconds total | Exact boundary/default/opt-in/refusal and actual SDK parser/error receipts |
| runtime-path physical fetch/compaction/MCP/codemode | 240 seconds total | Actual SDK paths, counted local endpoint, second-fetch denial and positive nested control |
| containment qualification | 180 seconds | Real positive/negative path/credential/egress/process controls |
| cleanup qualification | 120 seconds reserved | Exact owned descendants/containers exited and removed; preserve evidence |

These command deadlines total 1,860 seconds, below the approved remaining 2,261.751 seconds at resumption.
T0 context/parser/runtime-image/runtime-path/containment/cleanup/mutations runners are executable and qualified at the local feasibility boundary. Later physical-sends/mcp/recovery/limits/live integration runners remain pending. Runtime-image sub-stages keep separate deadline receipts.
On any failed/inconclusive prerequisite, stop new work, clean exact owned resources and request a ruling.
A registry/daemon failure is blocked, never a passed skipped row. No image pruning, global cleanup or alternate unpinned image is allowed.
No model/count/auth operation is part of this additional local budget request.

### Implementation Plan


Every task uses behavioral RED assertions on its real production seam before its fix.
A module compile failure does not count as RED. Use a minimal compilable seam, observe the unauthorized send/effect or wrong outcome,
then implement the guard and restore the test. Record a targeted production-guard mutation after GREEN for pivotal controls.
No helper agents run these tasks. Edges below reflect shared state/interfaces and real qualification barriers.
Tasks do not claim passed containment from ordinary root tests.

- [x] **T0 · Qualify the pinned runtime path and containment substrate**
  Blocked by: None.
  Owns: `packages/agent-pi/package.json`, `packages/agent-pi/runtime/**`, `packages/agent-pi/src/{context,response}.ts`,
  `packages/agent-pi/qualification/{context-guard,parser-context-failures,runtime-image,runtime-path,cleanup}.*`, root workspace metadata/lock.
  Gate: review (coordinator qualification ruling when a pivotal assumption fails; independent review remains ship-only).
  Acceptance: Freeze Linux image and lock; actual SDK serializer/parser fetch is mediated; denied native second fetch sends zero;
  actual MCP/custom transport and native codemode import/run; Linux container controls, default strict refusal and explicit estimated_guard are executable.
  Pin derived image/config digest; show positive SDK response and allowed read plus denied direct network/host canaries.
  Qualify default proven_bound zero-send refusal, explicit estimated_guard coverage/inequality and actual-parser post-send context/output failure handling.
  A missing complete tokenizer bound does not block estimated_guard. Missing guard/serializer/output/effect/cleanup evidence still blocks T0.
  Verify: `npm ci`; `npm run build`; `npm run qualify:pi -- --case context-guard`; `npm run qualify:pi -- --case parser-context-failures`;
  `npm run qualify:pi -- --case runtime-image`; `npm run qualify:pi -- --case runtime-path`; `npm run qualify:pi -- --case containment`; `npm run qualify:pi -- --case cleanup`.
  Checkpoint: first bounded feasibility receipt. No broad adapter implementation before this barrier resolves.

- [x] **T1 · Open a frozen, capability-checked role session**
  Blocked by: T0.
  Owns: `packages/agent-pi/src/{index,types,errors,boundary,policy,resources,session-host,protocol}.ts`, corresponding `test/session-*.test.ts`, package tsconfig.
  Gate: review (new exported host contract and resource boundary).
  Acceptance: Implement factory/owned snapshots/errors; exact role/step/model/thinking and resource checks; approved loader getters only;
  reject missing model, clamp, ambient append-system and extension config; valid declared resource reaches actual SDK request.
  Verify: `npm run test:pi -- --case session`; `npm run typecheck`; `npm run lint`.

- [x] **T2 · Broker physical sends through current S02 authority**
  Blocked by: T1.
  Owns: `packages/agent-pi/src/{sender,admission,provider,usage,receipt,broker-channel,factory-bootstrap,docker-absence}.ts`,
  production wiring in `adapter.ts`, `session-host.ts`, `sdk-worker.ts`, `resources.ts` and `protocol.ts`,
  `test/request-*.test.ts`, affected session regressions, request/native qualification scripts and root test registration.
  Gate: review (credential, budget and actual dispatch boundary).
  Acceptance: Real SDK plus real counted local endpoint; unique S02 record per physical attempt; denied/stale/expired/changed/existing permit sends zero;
  sender-only retry counts 429/terminal error attempts; native retries denied; actual compaction uses same path;
  incomplete usage remains unknown and hard-token requests fail preflight; context opt-in is immutable;
  actual HTTP/streamed context/length/parser failures cannot trigger a repeat, a tool effect or successful execution settlement.
  Qualify the contained public factory compiler with actual native authorization, poisoned non-bootstrap roots,
  exact runtime/event-bus identity, unexpected-output refusal and repeated final reload without factory re-execution.
  This additional qualification allows image build<=120seconds, combined native cases<=120seconds and cleanup<=120seconds,
  aggregate<=360seconds with cleanup reserve. It adds no dependency, live/auth call or T0 allowance.
  Verify: `npm run test:pi -- --case requests`; `npm run qualify:pi -- --case physical-sends`.

- [x] **T3 · Execute tools within read-only candidate scope and isolated scratch**
  Blocked by: T2.
  Owns: `packages/agent-pi/src/{execution,containers,candidate,tools}.ts`, `test/tool-*.test.ts`, `qualification/containment.*`.
  Gate: review (filesystem/process/network authority).
  Acceptance: Real allowed read/write/edit and scratch shell; protected/new/traversal/case/link/rename cases denied during execution;
  credentials and host canaries absent; IP/DNS/IPv6/host-gateway egress denied; no host shell or writable worktree mount;
  container inspect and descendant cleanup receipts pass.
  Verify: `npm run test:pi -- --case tools`; `npm run qualify:pi -- --case containment`.

- [x] **T4 · Enforce real MCP and native nested/codemode authorization**
  Blocked by: T3.
  Owns: `packages/agent-pi/src/{mcp,mcp-transport}.ts`, `test/mcp-*.test.ts`, `runtime/workspace-mcp.*`, `qualification/mcp.*`.
  Gate: review (nested authorization and timeout boundary).
  Acceptance: Actual createMcpExtension + actual protocol + native codemode; allowed nested read succeeds;
  denied direct/hidden/search/nested write has zero side effects; model helpers denied; idle/progress/absolute deadline and flood caps verified;
  stubborn owned server descendants exit under container cleanup.
  Verify: `npm run test:pi -- --case mcp`; `npm run qualify:pi -- --case mcp`.

- [x] **T5 · Settle, capture and restore without replay**
  Blocked by: T4.
  Owns: `packages/agent-pi/src/{events,lifecycle,capture,recovery,execution-guard}.ts`, `test/lifecycle-*.test.ts`, `test/fixtures/crash-*`, `qualification/recovery.*`.
  Gate: review (crash ordering, ownership and uncertainty).
  Acceptance: Last settlement only; bounded queue overflow; current owner and qualified clock retained; real retained store and owned SIGKILL boundaries;
  safely restored session emits no request until an explicit new command; uncertain provider/tool paths cannot auto-resend;
  byte/identity mismatch fails restore; exact local cleanup receipts separate remote status.
  Verify: `npm run test:pi -- --case lifecycle`; `npm run qualify:pi -- --case recovery`.

- [x] **T6 · Record optional-plugin/runtime dispositions and integration limits**
  Blocked by: T5.
  Owns: `packages/agent-pi/test/disposition-*.test.ts`, `packages/agent-pi/qualification/{limits,live,live-input,live-budget,dispositions}.mjs`, `docs/pi-runtime-evaluation.md`.
  Gate: review (plugin compatibility and capability evidence).
  Acceptance: Explicit pi-retry and durable rejection routes tested; no ambient plugin import/reset/length/empty continuation;
  measured finite buffering and ledger growth; opted-in live route passes its estimated guard/output/call checks and bounded evidence or remains explicitly blocked;
  A01-A09 matrix separates actual SDK/fake model, real endpoints/containers, live provider and source inspection.
  Verify: `npm run test:pi -- --case dispositions`; `npm run qualify:pi -- --case limits`; `npm run qualify:pi:live`.

- [x] **T7 · Document, validate and ship the exact frozen tree**
  Blocked by: T6.
  Owns: `README.md`, `docs/{pi-adapter,development}.md`, `docs/adr/0002-isolated-pi-sdk.md`, `examples/{README,pi-adapter}.md`, `specs/2026-11-05-isolated-pi-adapter.md`, final root check script wiring.
  Gate: review (my-ship independent Pi review and coordinator final gate).
  Acceptance: Preserve 219 existing tests; adapter deterministic tests included in all root checks;
  exact-head root checks plus separate qualifications; self-contained spec/content/reference audit; focused signed-off commits;
  Jev-routed root-adopted Pi review closed with completion/close/exit receipts; no CI/CD, push, merge or publication.
  Verify: `npm ci`; `npm run build`; `npm run typecheck`; `npm run lint`; `npm test`;
  `npm run qualify:pi -- --case all`; `npm run qualify:pi:live`; exact base-to-HEAD scope/signoff/spec audits.

The ownership ranges are sequential: T0 registers root/package runners and the narrow production context helper; T2 integrates that helper into its sender; T7 reconciles final wiring.
T0 actual-SDK transport/parser probes establish feasibility only. T2 and final qualification must still prove the production host path.
T2's sender is required by T3 for journaled tool effects and by T4/T5 for shared cancellation/uncertainty.
T3 is required by T4's real contained stdio servers. T5 needs the actual tool/MCP cleanup graph.
T6 depends on the finished lifecycle so reset/restore and bounded resource measurements test the final path.
No false parallelism is offered; the assigned worker and shared host protocol make this a serial DAG.

### Test Plan


[x] The component owners may require updates to existing tests before committing implementation.

#### Prerequisite testing updates

Add a private internal test constructor for transport, clock and fault seams; do not export them from the package root.
Use Node's existing test runner, strict TypeScript and deterministic constructor injection, not module-global mode switches.
Extend root workspace build/typecheck/lint/test includes to agent-pi.
Root tests use actual pinned SDK with scripted provider responses and actual S02 files on macOS.
Real Docker and live-provider qualification are separate executable commands, never conditional skipped unit tests.
The qualification runner returns nonzero with machine-readable `blocked` when prerequisites are unavailable.
All test artifacts live under exact owned temporary directories; preserve program evidence outside versioned source.

#### Unit tests

- `@loopwright/agent-pi`: implementation date and measured coverage recorded at build; not measured at plan time.
- Boundary copying: own valid bytes; reject getters, shared buffers, cycles, excess fields/depth/size and mutation after construction.
- Selection/resource policy: missing model, thinking clamp, changed digest, implicit resource classes and unsupported plugin routes.
- Scope validation: public core exact/subtree/protected precedence; new files, invalid ancestor topology and optimistic edit digest refusal.
- Request canonical identity: method/origin/path/body/resource/classification differences cannot reuse permit or request ID.
- Usage: input/cache overlap, reasoning-inclusive output, missing fields, contradictory totals, estimated cost, duplicates and overflow.
- Context: strict default zero-send refusal; explicit estimated opt-in; full final UTF-8 schema coverage and exact 48,128/48,129-byte boundary;
  service/tool/output reserves; malformed or unsupported input; immutable mode/digest; same-mode compaction and soft-only reservation arithmetic.
- Lifecycle: final settlement, sequence and bindings, overflow/backpressure, cancellation grace and typed recovery outcomes.
- No invented numeric coverage target; inspect branch coverage for every refusal and crash branch, plus behavioral mutations on pivotal guards.

##### Context and parser behavioral cases

Use the internal production context helper and final sender path, never a public test-mode policy.
Test omitted/default proven_bound and explicit proven_bound with unavailable proof: zero physical requests, no reservation and no container startup.
Test explicit estimated_guard with a small covered payload: one physical send, estimated assessment and matching soft reservation/receipt.
At O=1,024 and C=98,304, construct exact finalized bodies of 48,128 and 48,129 bytes. The latter sends zero and creates no reservation.
Test the 65,536/65,537-byte transport ceiling independently on the production byte-validation helper, then assert the full production sender applies both byte and headroom checks.
No public mode or policy can disable/widen either ceiling.
Change only a system block, tool schema, signature, nested argument/result or multibyte text and verify that its exact final bytes affect B/digest.
Test failed UTF-8, duplicate keys, unknown content/top-level fields, external schema references, invalid numbers and shape limits.
Change mode, margin, output, estimator or resource identity after capture/admission: fail before send or restore; no policy downgrade.
Exercise an allowed explicit compaction and a refusal/partial summary through the same mode, sender and parent budget.

Feed the actual unmodified pinned SDK HTTP/SSE parser: normal end_turn, complete tool_use, HTTP400 context error,
streamed model_context_window_exceeded, max_tokens, pause_turn, unknown stop, malformed frame, EOF and incomplete tool arguments.
For each failure, assert one counted request, no automatic repeated request, no partial-tool effect and no execution_settled result.
Test a complete admitted parent with an allowed real nested read, plus partial/failed-parent zero nested effects.
Nested calls use their parent binding and separate exact-name/effect/scope/current-authority authorization, without fabricated provider entries.
Host raw terminal/usage evidence, including missing message_stop or incomplete usage, determines the S02 termination/charge/slot outcome.
Test completed raw usage with native-parser error: accounting may be settled, but execution remains failed.
Inject contradictory child success/usage and duplicate receipts: neither overrides host evidence nor double-settles/releases a different slot.
Mutate the production mode check, byte accounting, guard comparison and failure latch separately; each must cause a behavioral send/effect/outcome failure.
Restore exact source fingerprints and rerun GREEN. Compiler failures are not valid RED evidence.

#### Integration tests

Use actual SDK, public core/state APIs, retained local SQLite and an owned physically counted HTTP endpoint.
Specific test names are proposed here; final exact names and commands enter the build handback.

| Production path | Positive control | Negative / RED assertion |
| --- | --- | --- |
| Resource loading | Declared instruction/document appears in final request | Global/project/parent AGENTS/CLAUDE/SYSTEM/APPEND_SYSTEM/skills/prompts/themes/packages/models/settings canaries discovered by unrestricted control, absent in restricted request |
| Model/thinking | Exact effective selection and serialized HTTP settings | Missing model/clamp/fallback/switch rejects before physical count increases |
| Admission | Counted endpoint receives one send and S02 has matching intent/dispatch/receipt | Budget exhaustion, stale owner, expired permit, payload mutation, reused marker and commit-unknown yield zero extra requests |
| Retry/continuation | One allowed sender retry has distinct IDs and transportRetryOf | Native/provider retry, cache warming, length/empty nudge and forbidden model helper do not send |
| Context mode | Explicit estimated_guard admits a covered finalized body and reports estimated provenance | Default proven_bound, implicit downgrade, changed policy or unknown coverage sends zero |
| Context threshold | At O=1,024 and C=98,304, finalized B=48,128 is admitted | B=48,129 refuses before reservation or send; byte ceiling is checked separately |
| Parser/overflow | Actual pinned SDK handles normal successful and complete tool-use streams | HTTP context error, streamed context stop, unknown stop, max_tokens, EOF or incomplete tool args prevents success/repeat/effects and preserves bound accounting |
| Compaction | Explicit same-model compact uses purpose=compaction, same context mode and parent caps | Failed guard, mismatch or partial summary sends no follow-up; no silent mode change |
| Journaled write | Allowed existing/new file committed with exact digest | Protected/escape/link/rename/case targets create no candidate mutation |
| Settlement | Actual two agent_end then one agent_settled fixture | First end cannot settle; late retry/tool activity prevents finalization |
| Restore | Safe captured entries restored under same identities with zero automatic sends | Tampered artifact/lock/runtime/image/resources/deadline or unknown pending effect returns recovery_required |

Crash matrix, using separate owned processes and actual S02 storage:

1. Before reservation: zero request and no dispatched record.
2. After reservation before authorization: no send; retained reservation; only explicit guarded release may refund reservation.
3. Authorization commit before sender receives permit: no resend from saved marker; recovery required.
4. Final owner/expiry check before send: injected authority change refuses; acknowledge residual check-to-send race separately.
5. Endpoint records request before receipt: SIGKILL owner; count remains one, unknown charge/live slot retained, restore sends zero.
6. S02 receipt commit before SDK acknowledgement: restore uses bound receipt and does not send again.
7. Session artifact persisted before checkpoint: orphan artifact does not grant restore authority.
8. Checkpoint commit before acknowledgement: current S02 facts win; old capture cannot reset counters.
9. Local-write commit before receipt: recover by authenticated target/digest inspection under same exclusive owner; never blindly rerun edit.
10. Old owner still alive/old containers orphaned: takeover/restore blocked until exact exit/cleanup, even after S02 lease expiration.

Crash hooks are private test seams at actual production commit/send points.
Synthetic clocks isolate expiry tests. Separate actual-process/real-clock tests establish this one host/boot profile only.
The registered `admission-mutations` final command removes the production current-owner/send-once guard and must produce a behavioral unauthorized-send failure.
Restore the original source fingerprint and rerun GREEN; do not count a compiler error as that failure.

#### e2e tests and executable qualification

`npm run qualify:pi -- --case all` runs owned Linux containers with a real HTTP fixture and actual SDK/MCP/codemode.
Run cases independently too: runtime-path, physical-sends, containment, mcp, recovery, limits.
It records actual image/config hashes, runtime inspect, physical counts, S02 record IDs, exit codes and cleanup receipts.
A missing image/daemon/required control returns blocked with nonzero exit. No fallback or passed skipped row.

Containment controls include:

- Allowed read, scope-checked write/edit, new file and shell scratch output.
- Denied host synthetic file and credential canaries, parent worktree/state/HOME/socket paths and environment leakage.
- Denied protected file writes from shell, native Node fs, rename, unlink, symlink, hardlink and new protected descendants.
- Denied direct IPv4/DNS/IPv6 where the profile supports it, host-gateway/container-loopback attacks and child-process network attempts.
- A local known-reachable control endpoint establishes that denial is due to the container profile, not an absent target.
- Positive allowed mediated provider/MCP operation through authenticated pipe; forged identity/channel/opcode/body and redirect denied.
- Process limit/memory limit/read-only root/scratch bounds, cancellation-ignoring child plus daemonized grandchild, exact final exits.
- Real native codemode allowed/denied nested MCP, model helper denial, malicious metadata, progress flood and absolute timeout.

`npm run qualify:pi:live` is opt-in and separate from npm test.
It first checks explicit immutable estimated_guard policy, covered finalized-body guard, actual credential readiness and enforced request output limits.
The default proven_bound request still fails before a live send. An estimated_guard result carries unproven context fit; it is not a billing/context guarantee.
Only then may it send at most eight calls, each at most 90 seconds and at most 1,024 output tokens where enforceable.
Enforce a local run-wide counter too, so restarting the qualifier cannot silently reset the eight-call allowance.
Planned allocation: two selection/usage calls (Sonnet/Opus), one normal continuation/tool return, one explicit compaction,
one bounded cancellation observation, with at most three remaining calls reserved for necessary conformance corrections.
If a call's route cannot enforce its selected guard, output/call/deadline caps or input coverage, that row is blocked and consumes no uncapped probe.
The live matrix records requested/catalog/session/outgoing settings, response identity, reported/estimated/unknown usage and local cleanup.
No live fault sends a secret canary. No inference of zero bill or remote cancellation follows from abort.
No hardware/deployed App/external-write qualification is included.

### Acceptance closure and remaining evidence


| Acceptance | Main tasks / commands | Required evidence before closure | Present state |
| --- | --- | --- | --- |
| A01 | T0/T1/T6; runtime-path, session, live | Exact graph/image/resource/selection identity; hard-token refusal; live claims separated | T1 native sessions and T2-T6 controlled production paths passed; live BLOCKED without explicit ready-token source |
| A02 | T1/T5; session, recovery | Real discovery-positive and restricted resource controls; immutable restore | T1/T2 native resource/bootstrap/poison controls and T5 immutable byte-bound native restore passed |
| A03 | T2/T5; requests, physical-sends, recovery | Actual SDK serializer + counted HTTP + S02; distinct retries and crash gaps | T2 native broker/ACK/compaction/admission and T5 real retained-store SIGKILL/recovery controls passed |
| A04 | T0/T3/T5; containment, recovery | Real positive/negative filesystem/egress/process/credential controls and exact cleanup | T0/T3/T4/T5 local role/descendant/cleanup controls passed; deployed-host acceptance remains unknown |
| A05 | T4; mcp | Actual Pi MCP + native codemode/nested effects/timeouts/flood/cleanup | T4/T5/T6 actual native MCP/codemode, denied nested/hidden effects, deadlines/floods and exact cleanup passed |
| A06 | T5; lifecycle, recovery, limits | Final settlement, bounded queue/transcript, safe byte-bound capture and exact exits | T5 native final barriers, bounded events, capture/restore, owned SIGKILL and exact cleanup passed |
| A07 | T0/T2/T5/T6; context-guard, parser-context-failures, requests, live | Strict default refusal; explicit immutable estimated guard, complete serialized coverage, same-mode compaction and post-send failure/accounting tests | T0-T6 guarded serialization/accounting/compaction/recovery passed; live BLOCKED without explicit ready-token source |
| A08 | T6; dispositions | Explicit unsupported enablement rejection and no unqualified plugin paths | Explicit pi-retry/durable enablement refusal and native empty/length/error/no-reset controls passed; plugin integration unsupported |
| A09 | This gate/T5/T6; recovery, dispositions | Coordinator runtime selection, chosen-route recovery, comparison and unsupported API facts | SDK+S02 selected and locally qualified; durable source comparison and explicit rejection delivered; no durable execution claim |

Execution ownership: S03 owns adapter execution guard, persistent physical-send accounting and no replay. Remote sink reconciliation stays later S05/S10/S12.
Local containment: S03 owns local Docker qualification; host-loss and deployed multi-tenant containment remain blocked for later provisioned owners.
Artifact and resources: S03 owns exact artifact/locked graph and explicit resource controls. Source drift remains a recorded fact.
Runtime qualification: S03 uses only current macOS state profile; Linux SDK/tool execution does not extend S02's runtime allowlist.
Real suspension/reboot/host-loss and additional deployment hosts require separate S10/S12 qualification.

Current qualifications and remaining unknowns:

| Item | Current evidence / owner | Fail-closed behavior |
| --- | --- | --- |
| Derived image, native dependencies and restrictions | T0-T7 actual digest-pinned Linux arm64 controls and final 15-group rerun passed | Reject missing or mismatched image/graph/profile before session startup |
| Actual provider fetch/compaction over private container pipes | T2/T5 real serializer/parser, controlled HTTP and native ACK/crash controls passed | Network none; unsupported call paths cannot transmit |
| Default proven_bound on Copilot | Unestablished; strict default remains | CONTEXT_UNSAFE before startup/send; no implicit downgrade |
| Explicit estimated_guard | T0-T6 complete-final-body local coverage and actual parser/failure controls passed | Unknown coverage, cap or identity mismatch refuses; context fit stays unproven |
| Live output/thinking/model observation | S03 live driver is available; no explicit ready-token source supplied | BLOCKED before provider transport; all eight live calls unused |
| Stubborn descendants and exact local cleanup | T0/T3/T4/T5/T6 actual owned child/container controls passed | Missing exit/absence yields CLEANUP_FAILED or recovery_required |
| Provider-internal effort, complete billing and billing finality | Provider evidence, later owners if attainable | soft_accounting; missing quantities unknown; hard token contract denied |
| Remote host-loss, external authenticated sink, hardware and deployed App | S05/S07-S10/S12; resources/user scope | blocked/not_run with named owner; never inferred from local tests |
| Token-bearing MCP configuration and interactive OAuth | S04 owns trusted interpolation/mediation; OAuth remains open | Current local read-only policy refuses unsupported server/transport/auth routes |
| Independent review and final acceptance | Three completed T7/my-ship rounds; last Spec/Standards clean with exact completion/close/exit | Local branch preparation complete; coordinator final acceptance and merge remain pending |



## Alternatives

- Use Pi SDK defaults. Rejected because ambient resources, tools and settings vary across hosts.
- Run everything in the controller process. Rejected because session faults and untrusted execution need separate boundaries.
- Treat a subprocess or a tool-name allowlist as isolation. Rejected because neither limits OS filesystem or network authority.
- Move the existing state store into Linux immediately. Rejected because its selected runtime profile is not qualified there.
- Use pi-durable under S02. Evaluated under A09; unselected for S03 due the additional runtime bridges and crash qualification. Its task/checkpoint/sleep/history/document capabilities remain useful.
- Use pi-durable alone as the shared budget and cross-process authority. Rejected because those host guarantees remain unprovided.
- Reimplement Pi's entire session IPC. Avoid unless the plan identifies a necessary missing boundary in supported integration paths.
- Enable pi-retry unchanged as the budget policy. Rejected because its counters and continuation policy do not enforce the persistent contract.
- Enable pi-retry through direct integration or a maintained fork. Unselected; this version explicitly rejects enablement without importing it.
- Require proven input-token bounds on every live context route. Retain as the default mode; explicit estimated_guard is approved for the selected soft-accounting route with context-fit uncertainty.
- Infer pre-send safety or zero charge from post-send overflow/byte-size errors. Rejected; failures consume their actual admitted attempts and preserve unknown accounting.

## Open Questions

Runtime selection, the restricted shell profile and the serial local plan are approved and implemented through T7.
T0 qualified the pinned transport/compaction/native imports, real containment controls, strict default refusal,
explicit estimated guard and serialized output limits. T1-T6 qualified the production sender/tool/MCP/lifecycle/recovery paths.
The final T7 native rerun and three independent review rounds are complete; the last review was clean.
Clerical finalization preserves those executable bytes. Coordinator final acceptance and merged-tree checks remain separate.
The derived image is built from owned allowlisted files and is checked by exact ID/graph/restrictions before startup.

No explicit ready-token source was provided, so live model/output/thinking/usage observations remain BLOCKED with all eight calls unused.
Provider-internal effort, complete billing, billing finality, host-loss and deployed/hardware proof remain outside local acceptance.
S04 owns trusted token-bearing MCP configuration mediation; interactive OAuth remains open.
No missing evidence authorizes an alternate runtime, credential search, reset or acceptance waiver.

## Reference Boundaries

The existing [state contract](2026-11-05-persistent-state-and-admission.md) defines the persistent authority consumed here.
The [core contract](2026-11-05-task-contracts-and-evidence.md) defines lock, scope, usage provenance and acceptance semantics.
The [Pi SDK documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
describes session/resource controls and distinguishes `agent_end` from `agent_settled`.
Current upstream documentation supplements the exact installed declarations; it does not replace artifact qualification.
The [Docker run documentation](https://docs.docker.com/engine/containers/run/) describes runtime configuration controls.
Tests must establish their actual effect in the selected local profile.
The [pi-retry package page](https://pi.dev/packages/@monotykamary/pi-retry) describes retry and continuation policy.
The pinned registry artifact, rather than mutable upstream main, is the candidate evaluated by A08.

The [pi-durable design](https://github.com/earendil-works/pi/blob/4c992154d91a85f837b73374a86b8e73eefd0745/packages/durable/README.md)
describes task phases, storage ownership, compaction and typed document history.
The evaluated package must be identified separately; source documentation is not runtime qualification.


### Current backend and later execution direction

S03 implements its existing Docker/macOS-owner backend only. Docker is not a universal Loopwright product requirement.
Current public host fields require Docker executable/socket; image/profile/restriction identities bind requests and snapshots,
so cross-backend restore is unsupported. Tool capability literals, fixed candidate cwd and macOS PID/boot observations are
current-backend limits. The existing environment/session seam is internal, not a completed executor abstraction.
A separate direct-execution mode for operator-provided dedicated environments is planned before lightweight OS sandboxing.
No global sandbox-off default, Kubernetes/GPU executor or Linux state owner is implemented or qualified by S03.
A future incapable backend must refuse a task that requires isolation. Direct same-privilege execution alone cannot ensure
that task code cannot bypass mediation, access credentials or alter state. Common admission/budgets/events/deadlines/recovery
remain distinct from backend isolation; future GPU/toolchain, filesystem/network, cleanup and resource capabilities need separate design.
