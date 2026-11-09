# Spec: Bounded controller and trusted configuration

Status: Shipped
Type: Feature

## Summary

Add a local controller and CLI that turn an admitted task into a bounded execution, verification and repair cycle.
Use the existing core contracts, persistent state and isolated Pi adapter. Provide trusted configuration loading,
explicit run identity, safe resume and inspectable run artifacts. Configuration supports environment references for
approved credentials, including a qualified token-bearing read-only MCP route. Execution completion alone never
establishes task acceptance. No publication or hosted service is included.

## Motivation

### Goals

Operators can validate a task, inspect its frozen plan, execute it under one parent allowance, and inspect a result
without reconstructing a conversation. Controller authors get deterministic transitions, separate repair categories,
and retained progress that cannot replay uncertain effects or reset budgets.

The existing packages define acceptance, retain authority and execute a role. They do not yet schedule task steps,
normalize submitted results, collect independent verifier evidence, manage bounded repair, load operator configuration,
or expose a product CLI. The controller supplies these missing responsibilities without replacing those packages.

Success requires an actual local CLI cycle, actual Pi execution through the controller, trusted verification of its
candidate, bounded failure and repair behavior, safe interruption/resume, and usable redacted artifacts. Scripted
provider responses can qualify local integration; they cannot establish live-provider, billing or deployment facts.

### Non-Goals

- Remote publication, PR/ref/comment/release writes, authenticated external gates or hosted queues.
- GitHub Actions workflows, CI/CD configuration, GitHub App deployment or external resource provisioning.
- Business taskpacks, Runner parity, hardware/GPU execution or production performance claims.
- Active-memory curation, automatic memory application, runtime Jev policy or model-routing optimization.
- OAuth consent, browser login, token refresh, ambient credential discovery or authentication-store import.
- A new direct/OS-sandbox/Kubernetes backend, Linux state owner, host-loss recovery or state migration.
- Arbitrary shell commands, package names, endpoints or privileged validators supplied by an untrusted task file.

## Proposal

Provide private controller and CLI workspace packages over the existing public core/state/adapter interfaces.
A trusted operator selects configuration and a trusted handler registry. The controller validates the configuration,
compiles a stable plan, freezes task/resource/handler identities, obtains current state authority and runs only admitted
steps. It collects artifacts and independent evidence, then asks core to construct the final result.

Task data and submitted model claims cannot become trusted configuration, verifier observations or policy.
A resumed run selects the exact retained run and verifies its current state and artifacts before considering more work.
Unknown effects remain unresolved. Bounded deterministic finalization preserves the primary outcome even when a
secondary report or memory-observation action fails.

### User Stories

#### Story 1
As an operator, I want check and dry-run commands that show the admitted plan and missing capabilities, so that I can
identify configuration failures before model requests, tool processes or external effects begin.

#### Story 2
As a task author, I want a controller that verifies the actual candidate and performs bounded repairs, so that a
model's completion message cannot pass a task or create an endless retry loop.

#### Story 3
As an operator, I want status, inspection and explicit-ID resume, so that interruption does not lose known work,
restore an old allowance or repeat an uncertain effect.

#### Story 4
As an operator, I want environment references in approved configuration for MCP tokens, so that credentials reach
only their authorized server and never appear in model context, ordinary events or public artifacts.

#### Story 5
As a maintainer, I want a result bundle with check statuses, usage provenance and artifact identities, so that I can
review what happened and distinguish local fixture proof from live or deployed acceptance.

### Core Features & Acceptance Criteria

#### A01: Trusted configuration and deterministic compilation

- Accept bounded JSON and YAML documents through an explicit operator-selected configuration entrypoint.
  The plan must define a versioned closed schema, file precedence, trust roots, size/depth/collection limits and
  stable diagnostics before implementation. Reject duplicate keys, unsupported YAML tags/alias expansion and unknown fields.
- Keep authoring configuration distinct from the existing TaskContract. Compile into validated core documents;
  do not introduce a competing acceptance schema or silently mutate the already merged contract format.
- Resolve step uses, roles, tools, validators, resources and credential references only against a trusted registry.
  Unknown or mismatched references, cycles and unsupported dependencies fail before execution.
- Repository/candidate files and model or MCP output have no authority to select arbitrary host commands,
  handlers, environment names, endpoints or credential bindings. Explicit file selection alone is not approval
  of every declaration in that file. The concrete plan must define the operator approval/registry boundary.
- Freeze the exact target repository/base/source, task hash, resource bytes, handler versions, effective nonsecret
  policy, requested roles and capabilities. A later input or source change invalidates the affected plan and evidence.
- `check` and `run --dry-run` perform no model call, credential exchange, tool/container start, verifier execution,
  external write, run admission or budget reservation. Explicit local output is allowed. Report unavailable runtime
  readiness as unknown/not checked when it requires effects; never label a static plan executable-qualified.
- A refused check has a stable code and safe field location. Do not echo raw input, resolved credentials or parser
  snippets containing secrets. Keep invalid input, unsupported capability and runtime failure distinguishable.

#### A02: Single-owner bounded scheduling

- Use the TaskContract step DAG and trusted handlers. Start only dependency-ready steps and do not infer a pass
  for skipped descendants. Define failure propagation and terminal-state precedence in the plan.
- Execute agent steps through the production Pi adapter and deterministic check steps through a registered
  verifier boundary. Initial sequential scheduling is acceptable; maxConcurrency remains a ceiling, not a throughput promise.
- Maintain stable run/node/attempt/operation identities. Freeze intent before starting effects and retain the
  current candidate/artifact identity at each transition. No duplicate invocation follows from a repeated command.
- S02 remains the only persistent allowance, request/effect journal and owner authority. Every agent purpose,
  reviewer, format repair, implementation repair and compaction uses the same original parent budget and deadline.
- Use public S02 APIs and original adapter permits. Do not add a second token/call ledger, reset counters on a new
  role/session, reconstruct a saved dispatch permit, or bypass a refusal through another execution route.
- Recheck contract, target, candidate, current authority, remaining deadline and unresolved work before each next
  step or repair. A clock/owner failure revokes execution; no fallback owner may silently continue.
- Every non-model effect, including trusted verifier execution, has explicit current authority, bounded lifecycle
  and retained evidence. Executing candidate code on the privileged host is prohibited. A trusted verifier plugin
  must not turn an untrusted command string into host execution.
- The plan must specify controller progress persistence and crash ordering with S02 and immutable artifacts.
  A progress record is not another budget authority, and separate files/stores are not an atomic transaction.
- Required external gates/publication handlers remain unsupported in this release and block dependent work
  before an external request. No fake approval or in-process stand-in may satisfy a real gate requirement.

#### A03: Submitted-result normalization and independent verification

- Prefer a designated bounded result artifact or structured submission from an admitted role. The plan must
  identify how the actual Pi adapter exposes those bytes; ordinary metadata events do not contain assistant text.
- Preserve original bytes and their digest in the proper private boundary. If text extraction is supported,
  specify deterministic whole-document/fenced/unique-object rules. Multiple conflicting candidates fail; do not guess.
- Parse and validate a unique candidate against its closed schema, then cross-check it against actual artifacts,
  scope, source and execution facts. A schema-valid claim is still untrusted.
- Authenticate and bind registered verifier output to the current lock/candidate/target and original bytes before
  selecting it as eligible core evidence. A file called verification.json or a model-authored pass is not eligibility.
- Use core evaluateAcceptance and constructRunResult. Required failed/blocked/not_run rows remain visible.
  `completed` requires all required checks and passing implicit scope. `no_change` also requires passing implicit
  equality and a separate original required declared `no-change.v1` check allowing `local_execution`, with its own
  authenticated current Worker evidence using method `verify_no_change`. Select the lexically first qualifying
  original required ID before observing outcomes. No fallback to another passing check or implicit evidence is allowed.
- Agent execution_settled, exit0, a report saying tests passed, or a well-formed serialized result cannot substitute
  for independent current evidence. Changing the candidate invalidates prior candidate-bound results, including reviews.
- Show local, synthetic, static, external and hardware evidence levels honestly. A synthetic provider fixture is not
  a live-provider observation; a local check cannot satisfy a required hardware level unless the contract permits it.

#### A04: Separate finite repair paths

- Treat format/schema failure, implementation-check failure, transport failure, missing evidence, authentication
  failure and unknown effects as different categories with deterministic actions.
- Format repair may only rearrange the original submission under its schema and diagnostics. It cannot invent
  test evidence, approval, usage, effects or successful outcomes. Revalidate both structure and independent facts afterward.
- Implementation repair requires a scoped, actionable verifier finding bound to the current candidate. Pass only
  allowed edit scope and safe diagnostics to the admitted role, then rerun all acceptance affected by its new candidate.
- Respect separate maxFormatRepairs, maxImplementationRepairs and maxTransportRetries, including zero.
  Model requests also consume S02 parent calls/tokens/time; controller iteration caps must not weaken those counters.
- Define persisted attempt-level bounds and a repeated-failure-signature rule. Repeated identical failures without
  new evidence must stop, rather than continue with differently worded prompts or a new session.
- Adapter-owned transport retry remains the sole physical retry scheduler. The controller must not retry an
  ambiguous command as a fresh task attempt or compound hidden retries across layers.
- Explicit compaction, if needed, has a distinct admitted purpose and unchanged context policy. Failed compaction,
  unsupported context, hard-token refusal or insufficient remaining allowance cannot trigger an implicit downgrade.

#### A05: Recovery, cancellation and deterministic finalization

- `resume` requires an explicit stable run ID and retained location. Never select the latest session in the cwd.
  Reopen the same authoritative state, original clock/deadline, frozen registry/runtime/resources and artifact bytes.
- Verify controller ownership in addition to S02 authority. Lease expiry alone is not old-process death. Preserve
  the adapter's exact owner/child/daemon guard and cleanup semantics; do not remove a guard on timeout.
- Resume at an accounted safe step boundary. Reuse verified completed results; do not rerun a completed model
  or effect because a later progress/ACK write was lost. Uncertain state requires reconciliation, not replay.
- Missing/corrupt state, mismatched source/config/runtime, unsafe snapshots, clock drift, old-owner liveness or
  missing artifact bytes must fail closed with a typed diagnostic. No empty replacement store or fresh parent allowance.
- Test real owned process interruptions before effect, after effect before receipt, and after receipt before
  progress/ACK, plus safe capture/resume and duplicate concurrent resume on the qualified local host/boot.
- SIGINT/SIGTERM revoke new work first, then perform bounded drain/cleanup and finalization. Local cancellation
  does not prove provider termination or remote non-execution. Failed cleanup or unresolved effects stay explicit.
- Every admitted cycle attempts a bounded deterministic result/observation finalizer under the original wall-time
  budget with a reserved drain allowance. It must not make an unbudgeted model call or grant execution after expiry.
- Finalizer/report/memory-observation failures cannot rewrite the primary acceptance or manufacture a pass.
  Represent memory as not_requested or unavailable/pending as appropriate; memory proposals/application belong later.
- If corrupt/unavailable authority prevents a valid core RunResult, return a separate typed incident with known
  identities and unavailable fields. Do not fabricate usage, a candidate manifest or an empty successful result.

#### A06: Environment interpolation with a credential boundary

- Parse JSON/YAML before interpolation. Interpolate string values once, including nested arrays/objects; never
  object keys. `${NAME}` uses `[A-Za-z_][A-Za-z0-9_]*`; `$$` escapes a dollar, so `$${NAME}` is literal `${NAME}`.
- Bare `$NAME` is unchanged. Shell expressions and default operators are not evaluated. Reject malformed or
  unsupported `${...}` expressions. No command substitution, reparsing, recursive expansion or implicit dotenv loading.
- Resolve only from the trusted launching environment under the approved configuration/credential binding.
  Candidate files, prompts, model output and server metadata cannot trigger arbitrary environment lookup.
- Missing variables fail before process/container spawn or network activity. Empty substitution stays a string;
  required auth fields reject empty credentials. Bound both source documents and substituted output.
- Quotes, newlines and `${...}` inside an environment value stay data. Destination-specific validation rejects
  invalid header/argument values without echoing them. Substitution never coerces a boolean or number.
- Separate nonsecret effective configuration from credential material. Public display, policy fingerprints, task
  locks, logs, exceptions, model context, events, checkpoints and distributable bundles contain only approved
  nonsecret values, references or redaction. Never hash raw credentials into public identities.
- On resume, re-resolve the same authorized references and server/destination binding. A rotated credential may
  be used only within that binding; missing/invalid credentials block before effect. Never persist the resolved secret.
- Exercise production loader behavior with embedded/nested substitution, escaping, special characters,
  nonrecursion, missing/empty values, malformed syntax, duplicate keys, type/size limits and secret-safe errors.
  Include canary absence checks over every public diagnostic/artifact/event sink.

#### A07: A qualified token-bearing MCP route

- The implementation plan must propose at least one real supported token-bearing read-only MCP transport and
  its exact containment/mediation design, or report that capability BLOCKED with a concrete reason. Parser-only
  interpolation tests cannot close this item or the operator's MCP-token use case.
- S03 currently supports a fixed local read-only server and a provider-only resolver. A new route requires an
  explicit additive policy/API version and scoped server credential seam approved at the plan gate. Preserve
  rejection of unsupported old-policy fields and do not overload the provider resolver with model-selected server identities.
- Bind credentials to approved server identity, transport, exact destination/method and permitted effects. For
  HTTP, trusted mediation attaches auth and denies redirects or changed targets; validate URL/address behavior
  and bound request, response, session, progress, cancellation and absolute-deadline behavior. No generic HTTP proxy.
- If stdio is selected instead, only the specifically approved isolated MCP server receives its explicit
  credential environment allowlist. Generic shell/SDK roles receive none. Never inherit the full host environment.
- All direct/hidden/search-selected/nested MCP calls need exact-name, current-owner and parent-call authorization.
  Server metadata cannot grant tools or widen effects. External-write tools remain unsupported and denied.
- Qualify the actual Pi MCP/native transport path, not a replacement mock dispatcher. A synthetic credential and
  controlled authenticated server must demonstrate an allowed read, denied unapproved server/destination/tool,
  no credential leakage, interruption, bounded auth failure and resume re-resolution.
- No anonymous fallback, credential switching, ambient-store import, interactive browser or refresh occurs on
  authentication challenge. OAuth configuration is explicitly unsupported; return a bounded authentication-required
  or unsupported result. Interactive OAuth remains an open later capability.
- Local controlled-server evidence does not establish a real third-party server, OAuth or deployed-host acceptance.
  Failure of the prerequisite mediation gate blocks this capability and dependent integration; do not silently omit it.

#### A08: CLI and observable bundles

- Supply a local executable with `init`, `check`, `run --dry-run`, `run`, `status`, `inspect` and explicit-ID `resume`.
  Freeze exact flags, exit codes, stdout/stderr modes and machine schemas at the plan gate. No global install is required.
- `init` writes a reviewable draft with explicit missing capabilities and finite sample limits, and never overwrites
  existing files without an explicit option. Draft examples must not silently enable estimated context or credentials.
- A checked plan exposes graph/order, identities, scope, role/capability selection, effective nonsecret configuration,
  budgets, refusal reasons and evidence needs without leaking SDK internals into ordinary user flow.
- Provide stable bounded JSONL plus safe human-readable progress, status and final summaries. Include run/node/attempt,
  stage, remaining budget/deadline and artifact references; distinguish heartbeat from actual progress.
- Keep raw prompts, thinking, credentials, MCP auth and full untrusted output out of ordinary console/events.
  Escape control/newline/ANSI/workflow-command text before display. Bound event/diagnostic storage and backpressure.
- Export a byte-bound manifest for task.lock.json, plan.json, candidate changes, verification, result, events,
  usage and checkpoint metadata. Use core-compatible limits; explicitly report absent/not-run artifacts instead
  of inventing empty proof. Do not include a live SQLite copy or private native session in a distributable bundle.
- Retained private recovery artifacts and distributable outputs have separate access and retention policies.
  Bundle integrity hashes detect corruption; they do not authenticate an untrusted bundle as current authority.
- `status`/`inspect` do not claim ownership, refresh credentials, spawn agents or make network calls. Report
  missing/current/unavailable facts without silently repairing state. A bundle import cannot create run authority.
- For rejected input before admission, return safe diagnostics without claiming that a run completed. For admitted
  terminal outcomes, report all core statuses and usage provenance. Non-success cannot return the documented success exit.

#### A09: Local end-to-end acceptance and evidence limits

- Preserve all 350 current core/state/adapter tests. Add behavioral controller/loader/CLI tests, real retained-state
  interruption tests and separate native integration commands with clear nonzero BLOCKED for missing prerequisites.
- Run at least one actual CLI-controlled Pi cycle using the real SDK, controlled counted HTTP, real S02, isolated
  candidate and independent verifier. Demonstrate a legitimate completed result, false model pass rejection,
  required-check failure, bounded repair, no_change proof, budget exhaustion and explicit blocked evidence.
- Exercise fresh and resumed production CLI paths, safe zero-send restore, stale candidate/evidence rejection,
  repeated-error termination, cancellation/cleanup failure and unknown-effect refusal. Private injection stays
  outside public exports; no fixture mode may silently satisfy a normal live task.
- Include the authenticated MCP positive/negative route and secret-canary scans in its own qualification gate.
  Missing provider credentials may block live observation without blocking controlled local integration.
- Record exact source/merge tree, runtime, commands, exit codes, check counts, logs and owned cleanup identities.
  Never generalize local/CPU/fixture success into live provider, external gate, hardware or deployment acceptance.

### Notes / Constraints / Caveats

Use TypeScript ESM, the existing strict validation/result conventions, Node 26.13.0 and npm 11.20.0.
S02 is qualified only on macOS arm64 with bundled SQLite 3.54.1, one host/boot and retained local storage.
S03 uses pinned Linux arm64 Docker roles under that trusted host. Its current native route is local-qualified;
no ready-token source was supplied for live observation. Unknown usage, billing and remote effects remain unknown.

Docker is the current Pi execution backend, not a universal product prerequisite. Check/compile/inspect and common
controller semantics must not require a running Docker daemon. Live Pi execution still requires its qualified
backend and refuses missing containment. Do not ship a global isolation-off fallback or claim a new executor abstraction.
A separately planned direct mode for dedicated operator environments is prioritized before lightweight OS sandboxing.

Keep SDK/dependency/runtime pins fixed unless a concrete compatibility proposal is approved. The plan may propose
one minimal parser dependency if needed, with exact version, license and bounded-input behavior. Do not expand
core/state formats or runtime allowlists merely to simplify controller storage or CLI tests.

### Boundaries

- **Always:** use current trusted identity, independent verifier evidence, original budgets and fail-closed recovery.
- **Always:** keep authority, submitted claims, private secrets and distributable observations distinct.
- **Always:** label missing capabilities and evidence explicitly; retain exact local cleanup and failure records.
- **Ask first:** before changing merged core/state contracts, stored formats, runtime qualification or required acceptance.
- **Ask first:** before activating the new MCP policy/transport, adding an execution backend, paid resources or external effects.
- **Never:** execute untrusted candidate code on the credential/state host, load ambient config, reset allowance or replay uncertainty.
- **Never:** push Git commits, create remote PRs, publish artifacts, implement CI/CD or treat OAuth as implicitly supported.

### Risks and Mitigations

- Controller progress can disagree with the effect journal. Define write/ACK ordering and test each interruption boundary.
- An actor can forge a verification file. Authenticate registered verifier output and rebind original bytes to the current candidate.
- Repair loops can multiply requests. Use separate persisted iteration caps, original S02 accounting and repeated-error termination.
- Interpolation can leak secrets through unrelated fields or errors. Keep approved bindings and redaction provenance through every sink.
- A remote MCP route can become a confused deputy. Require exact destination/effect/caller binding and a prerequisite native qualification.
- A finalizer can overrun or overwrite a result. Reserve finite drain time and preserve primary acceptance independently of secondary writes.
- CLI convenience can hide unsupported execution. Separate static capability display from actual qualified runtime readiness.
- Additive adapter APIs increase compatibility obligations. Keep v1 closed and qualify both factories against baseline cases.
- Passive snapshot decoding couples the controller to native capture details. Keep decoding inside the adapter and refuse unknown versions.
- A trusted data verifier cannot qualify arbitrary candidate programs. Declare that capability unsupported before work starts.
- Worker-thread limits do not isolate hostile code. Run only fixed trusted byte handlers; never import or evaluate candidate code.
- A sessionless HTTP subset excludes some MCP servers. Report the required protocol capabilities before sending credentials.
- Repeated verification can exhaust checkpoint capacity. Retain the full phase schedule and terminal reserve; refuse plans over 64.
- Candidate bodies can exceed worker packets. Use complete authenticated inventories or exact selected-file byte preflight, never truncation.
- HTTP evidence cannot establish TLS behavior. Qualify local trusted/untrusted/name/address cases through the same production boundary.

## Design Details

### Commands

Run the commands below within the approved local stage ceilings. Static plan approval is not runtime acceptance.
The build environment is the existing qualified local macOS arm64 host,
Node 26.13.0, npm 11.20.0 and SQLite 3.54.1. Actual Pi roles use the pinned Linux arm64 Docker profile.
Static configuration commands require neither a Docker daemon nor model access. No remote build host is selected.

Preserve the existing checks and all 350 baseline test cases:

```sh
npm ci
npm run build
npm run typecheck
npm run lint
npm test
```

Add these root scripts. Each focused runner compiles the registered test tree before selecting its group:

```sh
npm run test:controller -- --case config
npm run test:controller -- --case progress
npm run test:controller -- --case verification
npm run test:controller -- --case scheduling
npm run test:controller -- --case recovery
npm run test:controller -- --case artifacts
npm run test:controller -- --case cli
npm run test:pi -- --case mcp
npm run qualify:controller -- --case feasibility
npm run qualify:controller -- --case parser-descriptor
npm run qualify:controller -- --case capture-binding
npm run qualify:controller -- --case mcp-auth
npm run qualify:controller -- --case cycle
npm run qualify:controller -- --case repair
npm run qualify:controller -- --case recovery
npm run qualify:controller -- --case cancellation
npm run qualify:controller -- --case secrets
```

Once budget.json migrates to the v2 qualificationReservations ledger, the direct run.mjs native leaves
(cycle, repair, recovery, cancellation, secrets) remain fenced with NATIVE_ACTIVATION_HELD (--case all
is not used under the per-group v2 reservation ledger); controller-owned native qualification uses these launchers:

```sh
node packages/controller/qualification/delivery-native.mjs --case cycle --phase initial|finalController
node packages/controller/qualification/delivery-native.mjs --case repair --phase initial|finalController
node packages/controller/qualification/delivery-preflight.mjs
node packages/controller/qualification/delivery-s03.mjs --case <group> --owner controller
```

Qualification exits 0 only for a passed selected group, 1 for a failed assertion, and 2 for a blocked prerequisite.
Its bounded JSON result names the evidence level, reason, exact head and cleanup disposition. A missing group is an error.
The `feasibility` alias selects parser-descriptor and capture-binding. T0 also requires mcp-auth.
The `all` controller group expands these aliases and runs each non-live leaf once, without duplicate auth probes.
Its runner has an absolute supervisor deadline. Retain a separate result for each T0 subcheckpoint.
Live provider qualification is not part of `all` and is not authorized by this plan.

Invoke the CLI through `node packages/cli/dist/main.js`; also register the workspace `loopwright` bin.
No global installation is needed. Product syntax is:

```text
loopwright init --directory DIR [--force] [--json]
loopwright check --config FILE --registry FILE --registry-sha256 HEX [--json] [--output FILE]
loopwright run --dry-run --config FILE --registry FILE --registry-sha256 HEX [--json] [--output FILE]
loopwright run --config FILE --registry FILE --registry-sha256 HEX --repo DIR --run-root DIR --run-id ID [--json]
loopwright status --run-root DIR --run-id ID [--json]
loopwright inspect --run-root DIR --run-id ID [--json] [--output DIR]
loopwright resume --run-root DIR --run-id ID --config FILE --registry FILE --registry-sha256 HEX --repo DIR [--json]
```

Unknown flags, duplicate flags, missing values and extra positional arguments return usage errors. There are no implicit
configuration files, environment-selected config paths, provider flags, commands in task files, or latest-run aliases.
`--output` uses no-overwrite creation. `init --force` permits replacement of only the named generated draft files.
The draft sets strict context mode, no credentials, explicit unsupported execution readiness, and finite sample limits.
It does not grant estimated context or approve its registry.

Product exit codes are 0 for successful static commands or completed/no_change runs, 2 for usage/configuration rejection,
3 for unsupported capability or blocked task, 4 for failed acceptance/execution, 5 for exhausted allowance,
6 for expired deadline, 7 for reconcile_required, 8 for an incident/unavailable authoritative result,
130 for accounted SIGINT cancellation, and 143 for accounted SIGTERM cancellation. Uncertainty takes precedence over
signal exits. Status/inspect can exit 0 when they successfully describe a failed run; their JSON retains that run's status.
If state is unavailable, status/inspect emit the unavailable view and exit 8.

`--json` writes versioned JSONL envelopes to stdout. Envelopes have `version:1`, `kind`, `sequence`, `runId`, and `data`.
Kinds are `plan`, `event`, `status`, `inspection`, `result`, `diagnostic`, and `incident`.
Static responses have null runId and never claim admission. Each invocation emits one terminal envelope.
Without `--json`, stdout contains an escaped summary; stderr contains safe progress and diagnostics.
Help and version are deterministic and perform no configuration discovery.
The data field is discriminated by kind: plan is CompiledPlan, result is core RunResult plus observation references,
diagnostic is ControllerDiagnostic, and incident is ControllerIncident. Status contains `{runId,source,stage,status,
currentState,checkpoint,cleanup,unavailable}`; source is current/retained/unavailable, and unknown facts are null
with their field names in unavailable. Inspection contains that status and the export manifest. Event follows the
closed event contract below. Unknown fields and unsupported envelope versions are rejected by machine readers.

### Project Structure

- `packages/core/`: existing document, scope, identity and acceptance authority; consume public exports.
- `packages/state/`: existing local owner, budget, journal and checkpoint authority; consume public exports.
- `packages/agent-pi/`: existing role execution; only a specifically approved additive MCP/controller integration change.
- `packages/controller/`: proposed trusted configuration, compiled plans, transitions, repair and run artifacts.
- `packages/cli/`: proposed argument parsing, operator commands, safe display and stable machine output.
- `docs/`, `examples/`, root workspace/build/test metadata: document and validate the new public behavior.

The plan chooses internal file layout, exact schemas and handler APIs. Do not add a generic privileged plugin loader,
competing scheduler service or business taskpack in order to demonstrate this local controller.

### Code Style

Use readonly public types and stable closed error codes. Handle refusal before using authoritative data.
For example, a controller must check core validation instead of treating a parsed object as a TaskContract:

```ts
import { validateDocument, type TaskContract } from '@loopwright/core';

export function checkedTask(input: unknown): TaskContract | null {
  const result = validateDocument(input, 'TaskContract');
  return result.ok ? result.value : null;
}
```

Production callers retain the returned diagnostics instead of discarding them as this short example does.
Validation of shape does not establish producer trust, runtime capability or acceptance. Private test ports stay
outside public package exports. Untrusted text is data and never shell source.

### Public contracts and trust roots

These contracts are approved for serial implementation, subject to the retained T0 feasibility gates.
No core/state format, runtime allowlist, default context rule, model route or existing v1 adapter contract changes.

`@loopwright/controller` exports readonly data types and `loadTrustedConfiguration`, `compilePlan`, `runCycle`,
`resumeCycle`, `readStatus`, and `inspectRun`. Each returns `ControllerResult<T>`, a closed ok/value or error union.
Execution functions return either a core RunResult with observations or a typed ControllerIncident.
No fixture ports, raw credential map, arbitrary module loader or generic execution function is exported.
The CLI only translates arguments, trusted file selection, signals and output; it owns no scheduling or allowance logic.
Compiled/public plans represent each private role command by its domain-labelled SHA256 placeholder. The original
approved registry digest still binds its complete parameters; execution obtains the original command only from the
validated loaded registry and checks its hash against that placeholder before retaining or dispatching it. Plan and
bundle output therefore contains no raw role command body, while original private command artifacts support recovery.

Controller diagnostics have `version`, `code`, `phase`, `path`, `stateCode`, `piCode`, `effect`, and `retryable`.
`effect` is none/possible/confirmed. Codes are CONFIG_SYNTAX, CONFIG_DUPLICATE_KEY, CONFIG_LIMIT,
CONFIG_SCHEMA, CONFIG_REFERENCE, CONFIG_ENV_MISSING, CONFIG_ENV_SYNTAX, CONFIG_ENV_DENIED,
CONFIG_CREDENTIAL_INVALID, REGISTRY_UNTRUSTED, TARGET_MISMATCH, CAPABILITY_UNSUPPORTED,
MCP_AUTHENTICATION_REQUIRED, SUBMISSION_INVALID, SUBMISSION_AMBIGUOUS, VERIFICATION_FAILED,
EVIDENCE_UNAVAILABLE, REPEAT_FAILURE, ATTEMPT_LIMIT, BUDGET_EXHAUSTED, DEADLINE, CANCELLED,
OWNER_BUSY, AUTHORITY_REFUSED, RECOVERY_REQUIRED, ARTIFACT_INVALID, OUTPUT_LIMIT, CLEANUP_FAILED,
and STATE_UNAVAILABLE. Unknown native exceptions map to a safe code, never their raw message.
Locations use known schema fields and numeric indices. Unknown keys are blamed at their parent location.
Only approved environment names may appear in diagnostics; substituted strings and parser excerpts never do.
The CLI usage vocabulary is separate. A retryable diagnostic grants no execution or replay permission.

The closed authoring envelope is `apiVersion:loopwright.dev/controller/v1alpha1`, `kind:ControllerConfig`,
`metadata:{id}`, and `spec:{task,registry,profiles,credentials,controls}`. There are no extension fields.

| Field | Required shape and authority |
| --- | --- |
| task | One embedded existing TaskContract. Validate it through core after approved interpolation. |
| registry | `{id,digest}` matching the explicitly approved registry bytes. |
| profiles | Arrays `roles:[{roleId,profileRef}]` and `steps:[{stepId,handlerRef}]`; exactly one match per declared role/step. |
| credentials | `[{ref,template}]`; ref must match a registry binding and template must match its approved field and environment names. |
| controls | `{drainReserveMs,maxAttempts,repeatFailureLimit,submission}`. Submission is `{mode:'artifact_or_assistant',path:string|null}`. |

`maxAttempts` is 1..16 across controller role commands, including repair and explicit compaction.
`repeatFailureLimit` is exactly 2 in this release. `drainReserveMs` is 120000..300000 and less than task wallTimeMs.
The sample task uses a 600000 ms cycle, 120000 ms drain reserve, 8 attempts and soft token accounting.
It remains a draft until approved runtime/resources, credentials and explicit estimated context are supplied.

The separate closed `TrustedRegistry` envelope uses the same controller API version and `{metadata:{id},spec}`.
Its spec contains `version`, `resourceVersion`, `handlers`, `roleProfiles`, `resources`, `runtimeProfiles`,
`credentialBindings`, and `environmentBindings`. Each collection has unique bounded IDs.
Handler entries contain `{id,version,digest,kind,implementation,parameters,capabilities}`.
`implementation` selects a shipped built-in, never a module path, shell string or package.
Role profiles contain the approved model/thinking/tools, context policy and runtime reference.
Resource entries contain `{id,kind,path,digest}` under the registry's approved resource root.
Runtime profiles contain the existing Pi RuntimeIdentity and explicit Docker executable/socket paths.
Credential bindings contain `{id,consumer,destinationRef,environmentNames,template}`.
Environment bindings contain `{name,classification,paths}`; classification is nonsecret or credential.
Server destinations are part of an approved role profile's v2 MCP policy, not task-selected URLs.

The operator supplies an owner-controlled registry outside the candidate, repository and task-writable roots.
Require a canonical path, owner UID, owner-only permissions, regular single-link files, no symlink components,
and an explicit SHA256 approval argument for its exact source bytes. Check these before environment lookup.
An explicit config path alone grants no handler, destination or environment access. The task can only request
registered identities and a subset of each grant. Resume requires the same registry digest and handler versions.
Changing the approved registry requires a new plan/run; rotating a credential within one frozen binding does not.
Built-in handler digests come from the installed build's bounded file inventory, not a task's assertion.

JSON and YAML are UTF-8 single documents. Source and expanded documents are each at most 1 MiB.
Limits are depth 32, 8192 nodes, 128 properties per map, 128 entries per ordinary collection and 16384 characters
per string; preserve tighter core field limits. Bound total resolved resource/candidate bytes at 16 MiB,
each file at 8 MiB and manifests at 256 entries. Refuse unsupported topology before materializing candidate files.
For executable controller plans, tighten total candidate bytes to 4 MiB, resources to 1 MiB and private session capture
to 2 MiB. Require each source/candidate canonical manifest to fit the adapter capture's existing 32768-byte ceiling.
Check encoded workspace/framing headroom within the adapter's 8-MiB file and 16-MiB artifact ceilings.
Overflow is an explicit refusal, not permission to truncate a candidate or native history.
The first controller profile accepts at most 16 DAG nodes and 16 verifier slots, including implicit acceptance handlers.
Static check/dry-run reports `noChangeEligibility` with the selected original required check ID or the fixed reason
`original_required_no_change_check_missing`. A missing binding does not invalidate an ordinary completed graph.
Compile the complete checkpoint emission bound below before admission. It includes repeated verification and three
terminal slots under S02's unchanged 64-record cap. Enforce request/operation caps too; capacity is not model allowance.

Use exact `yaml@2.9.0`, ISC, already present in the locked dependency graph, as a direct controller dependency.
Parse YAML with strict YAML 1.2/core semantics, uniqueKeys true, merge false and no custom tags.
Walk the bounded public AST before toJS. Reject tags, anchors, aliases, merge keys, non-string keys,
multiple documents, unsafe numeric values and non-JSON scalars. Disable alias conversion with maxAliasCount 0.
For JSON, use a bounded duplicate-key-aware lexical pass followed by JSON.parse; YAML syntax is not accepted as JSON.
Neither parser's raw error text is public. Fail if a parser cannot enforce its input bounds in the feasibility gate.

Interpolation first validates the envelope and registry-approved destination paths without looking up variables.
Then scan string values once, including arrays; never scan keys or inserted environment values.
`${NAME}`, `$$`, `$${NAME}`, bare dollars and malformed expressions follow A06 exactly.
Reject an environment reference at an unapproved path before lookup. A credential-class variable can only enter
its approved credential slot. Nonsecret environment fields may enter approved model/resource labels after validation.
Credential templates permit only registry-approved literal prefix/suffix plus approved references.
Credential resolution is local memory only; check/dry-run may validate its presence without an exchange.
Return a nonsecret configuration and opaque resolver closure. Freeze reference/template provenance, not resolved values.
Never serialize, publicly hash, log or put resolved secrets into any TaskContract or plan.

`compilePlan` returns a closed `CompiledPlan` with version, source-document digest, task byte digest, registry digest,
handler/resource/runtime identities, ordered DAG, scope, grants, budgets, controls, credential references,
capability dispositions, checkpoint/job capacity proof and evidence needs. It contains no Authority or DispatchPermit.
Check/dry-run return `runId:null`, `lock:null`, `admission:'not_performed'`, and effectful readiness `not_checked`.
They read bounded local files only, and never open S02 or start Git, validators, workers or Docker.
Declared repository/base/source values are frozen; actual Git object availability/readiness remains not_checked until run.
At run admission, verify the actual target and resource bytes, then call core admitTask once with explicit stable IDs.
Use sanitized bounded Git object reads, disable hooks/fsmonitor/config helpers/lazy fetching, and never checkout
candidate code or execute its filters/hooks on the host. Missing local objects block; do not fetch them.

### Progress persistence and recovery ordering

Use a retained owner-only run root outside the repository. Its private area contains the S02 directory,
immutable controller artifacts, original configuration references, Pi snapshots and a controller owner guard.
Distributable output is a separate explicit export. A bundle never creates authority.
Controller snapshots are bounded immutable files referenced by S02 checkpoint additionalArtifacts.
They retain node states, controller attempt ordinal/IDs, command-byte refs, request/operation sequence watermarks,
Pi checkpoint pointers, submission/candidate refs, failure signatures, verifier receipts, event sequence and terminal intent.
They contain no token/call balances or reusable dispatch permits. S02 remains the sole accounting authority.
The closed private ControllerProgress v2 fields are version, runId, lockHash, sequence, previous, stage, nodes, attempts,
nativeCheckpoints, submission, candidate, failures, verifierReceipts, verifierRefusals, eventSequence and terminalIntent.
Historical v1 progress is unsupported, with no migration or allowance/clock reset; its evidence remains tied to its
original implementation. Core, state and Pi document/API versions remain unchanged.
Bound one snapshot at 64 KiB, nodes/attempts/failures at 16 each and receipt/checkpoint refs at the compiled capacity.
Command/submission bytes use separate private refs and the adapter's prompt/submission size bounds.

Use domain-separated hashes for controller artifact identities. Stable node-attempt/command/operation/checkpoint IDs
derive from run, node, purpose, repair kind and persisted ordinal. Native Pi request/attempt IDs remain adapter-owned;
associate their authoritative records with the serial command interval, never replace them with controller IDs.
Pagination stops at an unchanged S02 revision; pause renewal during a synchronous bounded read or restart the page walk.

1. Validate current target/candidate/registry, controller lifetime guard, S02 owner and original remaining time.
2. Sync an immutable pre-command progress snapshot. Publish its refs through writeCheckpoint with the exact revision.
   A lost checkpoint ACK is looked up by the same ID and exact refs. A file alone cannot authorize dispatch.
3. For agent work, call the real adapter once. It owns model request permits and all transport retries.
   For verifier work, write a read_only S02 intent and obtain one new original operation permit.
4. Record authentic outcome/receipt bytes and sync them before the corresponding S02 receipt/checkpoint acknowledgement.
   A successful role must capture through Pi before its candidate/submission can become reusable progress.
5. Publish a new immutable controller snapshot and S02 checkpoint. An optional pointer file is only an index.
   The authoritative checkpoint chain and journal always win over that pointer or an interrupted file write.

Pi capture publishes its own checkpoint with empty additionalArtifacts. Do not mutate it or rename its ID.
Publish a distinct controller checkpoint referencing progress plus the original Pi checkpoint ID and refs.
Restore Pi using that original Pi checkpoint, not the controller checkpoint: its session envelope binds its own ID
and historical accounting. Current later charges remain in S02. This composition needs no state schema change.
Initial/check-only snapshots use a passive bounded workspace artifact and null privateSession.

#### Complete checkpoint emission schedule

Let A be controls.maxAttempts, N the number of ordinary agent DAG nodes, I the original TaskContract
maxImplementationRepairs, and C the number of registered verifier slots. Count implicit scope/no-change checks in C.
Each slot identifies one check and one complete job, not a hidden per-file loop. Compile these nonnegative bounds:

```text
V = 1 + min(A, N + I)              maximum captured candidate generations, including the frozen source
J = C * V                         maximum verifier jobs across all generations
D = 1 + 3*A + 2*J + 3            maximum checkpoint records, including terminal reserve
```

Require D <= 64. Format repair and compaction cannot mutate the candidate; enforce that rule through their grants
and compare the captured candidate digest. Every potentially modifying ordinary agent node counts in N.
I bounds implementation repair commands conservatively because S02 also charges each physical repair request.
A includes every ordinary role, format/implementation repair and explicit compaction command. An unclassified
candidate-changing action is unsupported. A digest change within a command becomes visible only at its safe capture.
Consecutive captures with identical bytes retain the current generation. Returning to an older digest after an
intervening change creates a new generation with fresh affected jobs, still within V. A new receipt ID alone
cannot create a generation or evade repeat bounds.

| Emission | Maximum records | Durable facts and crash ordering |
| --- | --- | --- |
| Bootstrap | 1 | Frozen plan/source, initial node states, original attempt/signature state and complete emission schedule. |
| Each role/repair/compaction command | 3 per A | Controller pre-intent, at most one original Pi capture checkpoint, controller post-outcome. The post snapshot includes normalized submission, failure signature and any format-repair decision. Implementation-repair decisions bind to verifier post snapshots. Failed commands may omit capture; the capacity bound still charges its slot. |
| Each verifier slot/candidate generation | 2 per J | Controller pre-job intent and controller post-receipt/failure snapshot. Bind the current signature and affected-check disposition in that same post snapshot. |
| Terminal intent | 1 reserved | Freeze primary facts, pending cleanup and deterministic finalizer inputs before drain/finalization. |
| Terminal result | 1 reserved | Bind the immutable core result or incident and known artifact/usage references. |
| Terminal observations | 1 reserved | Retain cleanup/finalizer/export observations without rewriting the primary result. Missing authority may prevent this write; preserve the reserve and report the incident. |

There is at most one verifier dispatch per slot and captured candidate generation, whether it passes, fails or times out.
An unchanged candidate reuses only authenticated byte-bound observations. A format repair revalidates structure and
current facts using those observations; it does not start new verifier jobs. Candidate-changing implementation repair
reruns every affected slot, conservatively bounded by all C slots for each of V generations. Failed/timed-out jobs
are not retried against the same generation. Missing/unverifiable receipts require reconciliation, not a fresh job.

Normalization, failure-signature computation and repair classification are deterministic parts of the corresponding
post-command/post-job transition. Sync their immutable artifacts before publishing that post snapshot. If interrupted,
recompute them from the already authenticated capture/receipt and publish the same predefined checkpoint ID.
They do not emit separate checkpoints. Heartbeats/events, owner renewals/claims, credential re-resolution,
pointer repair, snapshot reads and resume itself emit no checkpoints. Resume may finish an already planned transition
using its original ID; it cannot allocate a new slot or reduce a previous ordinal/signature.

Example: A=3, N=1, I=2 and C=3 gives V=4, J=12 and D=37.
One ordinary implementation plus two candidate-changing repairs may verify source and all three captured candidates.
The bound includes 1 bootstrap, 9 role records, 24 verifier records and 3 terminal records.
An exact-fit compile case uses A=2, N=1, I=1 and C=9: V=3, J=27, D=64.
A one-over case uses A=3, N=1, I=0 and C=13: V=2, J=26, D=65; refuse before admission.
Both graphs fit the 16-node profile. The latter may use format/compaction attempts but cannot gain extra candidate
generations. Other parent allowance limits remain independent and must also pass.

Persist the schedule, original A/N/I/C/V/J/D and each committed phase ID in bootstrap progress.
On resume, compare actual S02 checkpoint IDs/counts with that retained schedule. Remaining capacity is the unconsumed
scheduled phases, including terminal reserve; never recompute a fresh D=64 allowance. Unexpected checkpoints,
additional verifier jobs or inconsistent later phase/signature history refuse before any new effect.
An existing same-ID checkpoint consumes its slot once despite repeated lookups or lost ACKs.
No record pruning, state cap increase or unplanned periodic checkpoint is permitted.

Every controller checkpoint has exactly four additional refs: progress, receipt index, frozen plan and source inventory.
Workspace and optional privateSession remain their separate S02 fields, giving at most six required recovery refs,
below S02's limit of 18; Pi capture retains its existing zero-additional-ref shape.
Progress/receipt-index files are each at most 64 KiB. The receipt index has at most 2*J+A+4 entries, which is at most
62 when D <= 64 and A >= 1. Each entry is at most 768 encoded bytes; its header is at most 4096 bytes.
Count one role-outcome wrapper per A, two verifier output/receipt refs per J, and four root index refs for plan,
source, terminal result and observations. Role wrappers point to original Pi checkpoint IDs; do not duplicate each
native child ref in this index. Validate their bounded transitive refs separately. Entries never embed outputs.
S02 model/tool records remain in its journal.
Generated artifact names are bounded ASCII at most 128 bytes, and each encoded ArtifactRef is at most 512 bytes.
With the 32768-byte candidate manifest and six refs, checkpoint input stays within a 40960-byte controller ceiling,
including a 1024-byte framing allowance, below S02's 65536-byte input bound. Check actual encoded bytes too.
Do not append one additionalArtifacts item per verifier/attempt. Replaced/colliding refs or an over-limit index refuse.

Resume selects the explicit run directory/ID and validates the complete referenced checkpoint chain and current journal.
Acquire a controller lifetime guard with O_EXCL and PID/birth/boot/nonce before claiming S02 active ownership.
The guard persists across crashes. Archive its bounded private journal before normal removal so exact reader
start/exit and cleanup observations remain reviewable without reconstructing history. A live or unverifiable previous owner blocks replacement despite lease expiry.
Serialize dead-owner recovery with its own exclusive guard. Do not remove a retained recovery guard on timeout.
The Pi adapter separately verifies its original exact daemon/child/attach guard; do not weaken or replace it.
Verifier workers are threads in the guarded controller process; they cannot survive proven process exit.
Claim recovery-only authority when reconciling an expired cycle; it grants no new work.

| Interruption window | Recovery decision |
| --- | --- |
| Progress file exists, S02 checkpoint absent | Ignore orphan bytes. No command was authorized by that file. |
| Pre-command checkpoint committed, no new requests/operations | Safe boundary; resume may issue the original not-started command once. |
| Request/effect dispatched without trusted terminal receipt | Retain unknown charges/effects and refuse replay. |
| Request accounted but no candidate/session capture exists | Return RECOVERY_REQUIRED; no inferred result and no repeat request. |
| Pi capture committed, controller completion ACK absent | Look up its predeclared ID; validate artifacts and adopt the known capture without sending. |
| Verifier receipt bytes exist, S02 receipt ACK absent | Reconcile the original operation only if its private producer/dispatch/byte binding is proven. Otherwise refuse. |
| Controller checkpoint committed, pointer/event ACK absent | Rebuild its index/observations from committed refs; do not rerun work. |
| Final result bytes synced, terminal checkpoint ACK absent | Reuse identical byte-bound finalization or return an incident; never repeat the task. |

Any extra unassigned request, missing chain element, divergent candidate, replaced store, corrupt progress, stale producer,
clock drift or unavailable original bytes fails closed. An old snapshot cannot erase later attempts or failure signatures.
Detect later started work through S02 sequence watermarks and its receipt-linked artifacts; ambiguity is reconciliation,
not restoration of a smaller attempt counter. Unknown read effects also require explicit reconciliation before new work.

### Submission, verifier and repair contracts

Add these two narrow passive adapter exports:

- `describePiAdapterFiles()` returns SDK integrity, built-in preamble identity, local MCP script digest,
  restriction digest and supported limit ceilings. It reads installed trusted bytes only. It does not attest an image,
  call Docker, resolve credentials or return runtime-ready capabilities. This avoids importing private source constants.
- `decodePiCapture(input)` accepts the trusted expected lock/policy, authoritative CheckpointRecord,
  command binding and workspace/session refs with bytes. It returns validated candidate manifest/file bytes and
  the final assistant text bytes, or a typed refusal. It performs no replay or native session startup.
  The caller obtains the checkpoint from current S02; a caller-supplied file cannot authenticate itself.

The decoder reuses the adapter's strict passive snapshot validation. Validate the v1 session_snapshot/workspace_snapshot
envelopes, exact original checkpoint/role/session/runtime/resources/clock/accounting binding, native session version 3,
row graph/tool pairs, canonical base64 chunks, file lengths/digests, complete manifest and final end row.
Bind the final assistant stop message to the current command's user boundary and captured request interval.
Return only text blocks after that boundary, never thinking, tools or a previous command's text.
Retain the native session privately. Refuse an unidentifiable command boundary; do not guess from the last message.
This export preserves existing snapshot bytes and accepts both approved policy versions through a discriminated input.
If public native declarations cannot support this binding, stop the feasibility gate and return the incompatibility.

Prefer the configured bounded submission artifact when present. Otherwise use the decoded current assistant text.
If both exist and differ, return SUBMISSION_AMBIGUOUS. Keep original bytes/digest privately.
Accept either one whole JSON document or one exact outer ```json fence containing the entire document.
Do not search arbitrary prose for braces or select among competing objects.
The closed submission is `{version:1,status,checks,reason}`. Status is completed/no_change/failed/blocked;
checks are bounded existing SubmittedCheck shapes and reason is null or safe bounded text.
Submission status and evidence IDs are claims. They cannot determine usage, grants, effect status or trusted evidence.

Only shipped verifier implementations are supported: `scope.v1`, `json-artifact.v1`, and `no-change.v1`.
The registry binds check IDs, paths and expectations to those implementations before admission.
`json-artifact.v1` validates bounded inert JSON against registered required top-level property names and scalar values;
it accepts no executable schema, remote ref, expression or task-supplied program. `scope.v1` checks manifest differences
against core scope and frozen source bytes. `no-change.v1` compares the complete source/candidate inventories and emits
method verify_no_change. It is required acceptance for a no_change result. Implicit scope/no-change slots remain
separate honest controller observations; only original declared IDs enter core claims/eligibleEvidence. Scope must
pass for either success status. Failed implicit equality on a legitimately changed candidate does not itself reject
completed, unless an original required declared predicate also fails. Never relabel a failed comparison as passed.
An author who needs no_change includes an original required registered no-change.v1 check permitting local_execution.
That declared slot and the implicit equality slot execute independently and both count in C. All other required checks
must pass. Optional-only, wrong-handler or disallowed-level declarations do not grant no_change eligibility.
This supports generic artifact validation without introducing a business taskpack.

Execute the fixed trusted verifier module in a bounded worker thread with an empty environment and byte-only input.
Do not mount a repository, import its modules, evaluate its code, or run its commands. Files are read as inert bytes
by the owner before dispatch. Code-executing validators, shell/test/build handlers and external gates are unsupported
and refuse before invocation. This is a verifier containment choice, not a new agent execution backend.
Worker input is at most 1048576 bytes and output at most 65536 bytes, using the complete job representation below.
Set resourceLimits.maxOldGenerationSizeMb to 64, maxYoungGenerationSizeMb to 8 and stackSizeMb to 2.
These bound JavaScript heap spaces/stack, not process RSS, external ArrayBuffers, native allocations or an OS sandbox.
Use empty environment/execArgv, fixed trusted code and a 2000 ms wall cap within the work deadline.
All application-controlled Buffer/ArrayBuffer allocations use checked lengths and an 8-MiB per-job allocation quota.
Transfer one dedicated packet buffer; use bounded views, 64-KiB streaming hash buffers and at most one decoded JSON
text/parsed tree. Bound JSON depth/nodes/strings before evaluation; do not copy complete 4-MiB candidate bodies into the worker.
The allocation quota is a trusted-code guard, not a claim to cap V8/crypto/runtime RSS. Runtime/host OOM remains an
unqualified failure requiring guarded recovery. No adversarial candidate code is admitted to the thread.
Terminate and await worker exit on timeout/cancellation. A worker that cannot be confirmed stopped blocks new work.

#### Complete verifier jobs and byte preflight

Every job is one transferred Uint8Array packet. It starts with a four-byte unsigned big-endian header length,
then H UTF-8 canonical JSON header bytes, zero padding to a fixed 16384-byte header window, then binary payload.
H <= 16384; nonzero padding refuses. The fixed window makes complete packet capacity known before an operation
permit exists. Preflight uses maximum bounded identity/dispatch fields; the actual binding must fit the same window.
No base64 or structured-cloned content string is added outside this packet. The common closed header contains version,
jobId, handler/version, checkId, producerNonce, operationId, dispatchId, candidate generation, current subject, source/candidate manifest
descriptors, parameters and payloadKind. Each descriptor contains the manifest metadata ID, complete-document
ArtifactRef and entry count. Scope parameters include the full existing TaskContract for public core scope checks;
JSON parameters include one path, expected file ref (or null for absence), registered property/scalar expectations,
and both complete original source/candidate ArtifactManifest documents. These documents are sealed job data inside H,
not extra structured-cloned data. Validate their closed core schemas, metadata IDs, counts and original entry order;
canonical UTF-8 byte length/raw SHA256 must match each descriptor, and the separately domain-separated core candidate
digest must match the trusted current subject. The Worker derives selected path/ref membership from that full manifest.
Original owner/source/candidate/job/nonce/operation anchors authenticate the packet; coherent replacement documents and
subject cannot authenticate themselves. No arbitrary code.
If the header, including the complete contract/expectations, exceeds its cap, refuse rather than omit fields.

The owner reads complete source/candidate files as inert bytes with no-follow descriptors, verifies regular-file/link
identity and streams their byte lengths/SHA256 against the frozen/captured manifests. This produces byte identity,
never a pass/fail decision. The worker independently reconstructs each supplied complete manifest, validates it through
core and verifies its exact document digest against the authenticated header. For the candidate, also check its core
candidate digest against the current subject. Preserve original manifest entry order for those identity checks.

| Handler | Complete payload and exact encoded size | Preflight and independent decision |
| --- | --- | --- |
| scope.v1 | Full source inventory then full candidate inventory. Each starts with u32 entry count. Each entry is u16 UTF-8 path length, path bytes, u64 byteLength and 32 raw SHA256 bytes. Packet size is `16396 + sum(42 + pathUtf8Bytes)` over both inventories, including both counts and fixed framing. | Include all entries, including unchanged and deleted paths. Worker validates complete inventories and compares path/length/digest; check every actual addition/deletion/change against the supplied contract through core. No host-supplied changed-file list can replace the comparison. |
| no-change.v1 | The same two complete inventories and size calculation. Source and candidate body sizes do not enter the packet. | After byte/manifest/subject binding, the worker compares every normalized path, length and digest and both counts. All must match to emit verify_no_change. No sampling, selected-path comparison, same-size shortcut or host-authored boolean. SHA256 equality has the same cryptographic assumption as core artifact identity. |
| json-artifact.v1 | u32 file length followed by exactly those raw candidate bytes. Packet size is `16392 + F`. Both complete manifest documents fit inside H; no source body is required. Null expected-ref plus F=0 encodes absence; a present empty file has its actual non-null ref plus F=0. | Require `F <= 1032184` and the complete header to fit. Independently validate manifest/document/subject identities and selected membership, then hash all F bytes before bounded JSON parsing. Null expected-ref is valid only when the path is absent from the full candidate manifest and F=0; emit failed missing-file. A present empty file proceeds to JSON parsing and fails as invalid JSON. No prefix parsing, truncation, executable schema or host substitute result. |

Each source and candidate inventory has at most 256 entries and a complete canonical manifest <=32768 bytes.
Path framing admits at most 4096 UTF-8 bytes and must also satisfy every existing core path/type/topology bound.
The binary encoding removes the textual digest/field overhead and preserves every path/length/digest. Therefore
both inventory payloads together are at most 65536+8 bytes; including the largest header/prefix gives at most
81932 packet bytes. The 4-MiB source and 4-MiB candidate bodies stay outside the job and are streamed/hashed completely.
Manifest/body sizes are separate limits. Check actual canonical manifest and packet bytes, not only this upper bound.
A manifest over the native capture limit refuses capture/verification; it cannot be partially represented.

The JSON handler can validate a selected file up to 1032184 bytes with the full fixed header reservation. A larger file may exist in a supported
4-MiB candidate, but that file cannot be selected by this handler. If the initial scheduled job is already too large,
reject it before admission. Recompute complete header bounds/F/packet bytes for every later candidate before any verifier intent,
Worker creation or dispatch. A model-produced oversize selection yields a typed blocked check and zero verifier
dispatches; it does not cause truncation or a format-repair fallback. Other handlers can still inspect its full inventory.
One JSON file is one verifier slot; a multi-file request needs explicit distinct slots counted in C and the schedule.
JSON header eligibility is independently stricter: two full manifests, expectations and maximal identity/dispatch
framing must fit H<=16384. A supported 4-MiB/256-file inventory can therefore have an unsupported JSON job even with
a small selected file. Static readiness/help/examples report this condition; initial overflow refuses before admission,
and later overflow is a typed blocked check with zero verifier intent/Worker dispatch and no repair fallback.
Header documents are bounded parsed trees in addition to the one bounded candidate JSON body tree. Account for header
buffers and canonical manifest materialization within the application allocation quota; no additional unbounded copy.

Plan controls include maximal complete source/candidate manifest jobs, missing/duplicate/omitted entry rejection,
over-limit path framing refusal, a 32769-byte manifest refusal, and exact 1048576/1048577-byte
JSON packet cases with correct digests. The one-byte-over cases must refuse before verifier dispatch.
Also test valid exact/one-byte-over complete headers with maximal framing, full multi-file membership/document/core
digest checks, omitted/duplicate entries and selected-ref mismatch, coherent replacement against original job anchors,
and distinct missing/present-empty paths. No header padding is interpreted as valid document content.
Retain positive controls for 4-MiB complete source/candidate no-change equality and a last-byte candidate mutation.
An unchanged prefix or matching file length cannot pass the mutation case. These are planned checks, not run evidence.

Obtain a fresh S02 read_only operation permit for each verifier run. Before Worker creation and before accepting output,
check original permit/current owner, clock, target and candidate. The private worker channel receives one bounded job
with a producer nonce and operation/dispatch/handler/subject binding. Validate its original response bytes and digest.
The owner creates a core Evidence document only from that authenticated channel and a matching committed receipt.
Persist this producer binding outside candidate writable roots for recovery. A candidate-created verification.json,
copied prior evidence or matching digest without producer authority remains ineligible.
Persist only original dispatch receipt identity (generation, dispatch ID/revision and clock epoch), not a dispatch-permit
object, owner token or permit expiry. Compare the original store/lock and lifetime guard/plan before any verifier intent.
Required failed/blocked/not_run checks are explicit. Rebind all affected checks after candidate changes.

A recognized pure sizing refusal after complete input validation can create only a negative private observation.
Private progress v2 retains verifierRefusals rows `{slot,generation,prospectiveOperationId,producerNonce,subject,record}`;
record is a bounded immutable controller_preflight_refusal artifact with plan/handler/source/candidate identities,
closed sizing reason and actual/allowed lengths. It is neither Evidence nor an OperationReceipt. Joint slot/generation
uniqueness across refusals and physical receipts and total <=J are mandatory. The prospective S02 operation must be
exactly RECORD_NOT_FOUND; existing intents, dispatches, receipts and uncertainty cannot be converted to refusals.
Sync the record before the same reserved pre/post checkpoint pair; orphan records grant no authority. Include its
one ref as ReceiptIndex kind preflight-refusal, replacing job refs within the unchanged 2*J+A+4 bound/four extra refs.
Only opaque privately branded current-subject/generation handles can derive blocked/null-evidence claims, with explicit
refusal provenance separate from eligible Worker evidence. Other inventory jobs continue and unavailable sizing never
enters repair. Restore verifies original checkpoint/index/record anchors, full original bytes, identical pure sizing
refusal and operation absence, without Worker/intent/permit/model call or another checkpoint slot. A fitting, stale,
forged or missing input/record refuses; no negative observation can satisfy scope, no-change or any passed check.
Initial known sizing overflow still refuses before S02 create/claim. Arbitrary quota/persistence/event/authentication/
integrity exceptions must not be caught as sizing refusals.
Keep submitted claims and verifier-derived claims in separate records. Detect false submitted passes as a submission
contradiction, then construct the core evaluation input from authenticated verifier dispositions. Never alter core's
contradiction rules or pass a forged submission into eligibleEvidence.
Call both evaluateAcceptance and constructRunResult with current subject, original artifact bytes and S02-derived usage.

Before each role pre-intent/open, fresh original S02 facts can revoke scheduling when admittedCalls reaches the
original model-call ceiling or chargedTokens reaches totalTokens. No local allowance/reservation/grant is created.
A Pi BUDGET_EXHAUSTED/effect-none refusal may preserve the prior candidate only when exact original request/operation
facts and ledger, watermarks, candidate/body identities and confirmed cleanup all agree. Same counts alone are not
proof. New/accounted/changed work or missing required capture remains unresolved/incident, with charges retained.
Uninvoked pending descendants become not_run in the existing terminal intent; started/uncertain work is not rewritten.
Scheduling is sequential in stable topological order; maxConcurrency is still enforced by S02.
Node states are pending/running/passed/failed/blocked/not_run. A non-passed dependency prevents descendants from running.
Independent ready branches may continue only while authority, allowance, deadline and uncertainty checks pass.
Required unavailable handlers block preflight. An admitted missing-evidence check is blocked, not a fabricated pass.
Terminal precedence is reconcile_required, expired, cancelled, exhausted, failed, blocked, then no_change/completed.
Requested no_change without its original required binding is blocked EVIDENCE_UNAVAILABLE, subject to that precedence;
an actual failed predicate remains failed. Retain requested status, missing-proof diagnosis and all implicit outcomes
in exported observations. Do not reinterpret it as completed, start repair, transform the original TaskContract/lock,
collapse jobs or allocate new allowance. Core schemas/APIs and subjects remain unchanged.
Loss of trustworthy state yields an incident instead of forcing any core status. Required not_run rows prevent success.

Format repair uses the original submission bytes, fixed schema and safe structural diagnostics only.
It has an empty tool grant and returns assistant text, preserving candidate bytes and any original designated artifact.
Its persisted intent explicitly binds the original submission and proposed repaired representation as different versions;
do not mistake that declared lineage for two competing outputs of one command. Recheck all claims against current
authenticated evidence. Changed candidate bytes during format repair or compaction are a capability violation, not
an extra candidate generation. Eligibility also checks the current generation, so an older same-digest receipt cannot
satisfy a new generation after an intervening candidate change.
Implementation repair uses authenticated current-candidate actionable verifier findings and approved edit scope.
Missing evidence, auth failure, unsupported capability and ambiguous effects do not enter either repair path.
Transport retry stays inside the adapter. Never call execute again to retry a failed/ambiguous transport attempt.
Explicit compaction is opt-in through a registered handler, consumes an attempt and purpose compaction, and uses
the same policy/model/parent allowance. There is no automatic compaction/context downgrade on refusal.

Retain at most 16 distinct failure-signature rows. Before another verifier dispatch when that history is full,
refuse OUTPUT_LIMIT with no new intent/Worker; do not prune rows, reset history or turn missing jobs into passes.
This may stop a failing run before its maximum compiled schedule, while preserving the full nominal checkpoint bound.
Persist attempt intent and failure signature before considering a next repair. The signature hashes category,
stable diagnostic codes/locations, handler/version, target, candidate digest and relevant trusted evidence digests.
Prompt wording, sessions, timing and byte-identical repeated verifier receipts do not count as new evidence.
Two consecutive identical signatures without changed candidate or substantive evidence stop before a third invocation.
Controller attempts cap scheduling only; read actual format/implementation/retry counts from S02 on every decision.
Zero repair caps refuse the first repair. Reopening a role/session never resets any cap.

### Token-bearing MCP seam and qualification barrier

The selected route is sessionless MCP Streamable HTTP with JSON responses through trusted host mediation.
SDK/tool containers retain network none and receive no token. The existing fixed local stdio route remains supported.
The new route is not activated by parsing a token or seeing a server metadata declaration.

Preserve AdapterPolicy/PiHost/PiOpenInput version 1 and openPiAdapter exactly. Add AdapterPolicyV2, PiHostV2,
PiOpenInputV2 and openPiAdapterV2 with separate closed validation and shared guarded implementation.
The v2 input version is 2. Existing v1 policy/input/host paths continue to reject all new fields.
No provider resolver overloading, optional permissive transport field or acceptance widening is permitted.
Add PiErrorV2/PiResultV2/PiAdapterV2 types for typed MCP authentication/transport refusal without changing the v1
closed error vocabulary. V2 methods retain the same lifecycle shape and existing authority/effect semantics.
The added v2 codes are MCP_AUTHENTICATION_REQUIRED and MCP_TRANSPORT_UNSUPPORTED. Preserve all v1 codes unchanged.

V2 keeps all v1 policy constraints except its explicit MCP transport union. Its MCP value is either the unchanged
workspace stdio descriptor or `{serverId:'workspace',transport:'sessionless-http-json-v1',destinationRef,
endpoint,approvedAddresses,credentialRef,names,effects,idleTimeoutSeconds,absoluteTimeoutSeconds}`.
Names are exactly `mcp__workspace__read_file`, effects are read_only, and the tool still reads only current candidate
paths. Compare returned bytes to the current approved candidate file digest before accepting them.
The approved server must serve that frozen read-only workspace; a general arbitrary remote tool server is unsupported.
Metadata cannot change the name/schema/effect or grant a different server. Empty MCP grants cause no HTTP startup.

PiHostV2 adds only `resolveMcpCredential(binding) -> Promise<{bearerToken:string}>`.
Its closed binding contains serverId, transport, destinationRef, canonical endpoint/method, credentialRef,
runId, roleId, stepId, purpose, parentRequestId or management operation identity, original monotonic expiry and signal.
The controller resolver matches the frozen registry/reference and re-resolves only the approved launching environment.
The existing resolveCredential remains provider-only. Enforce a 1000 ms resolver wall bound and check abort/current
authority again after resolution. Empty/invalid tokens refuse; do not persist or publicly fingerprint them.

Use the actual public `StreamableHttpTransport` from pinned pi-mcp 1.5.0 in the owner's MCP path.
Set openGetStream false, maxMessageBytes 65536, reconnect.maxRetries 0, and no authProvider.
Provide a one-use bounded McpFetch implementation. It permits only the exact frozen POST URL and supported protocol
headers/body, then attaches Authorization immediately before guarded dispatch. It uses no ambient proxy, cookies,
credentials or global fetch configuration. Native MCP client/factory and OwnerMcpTransport still run inside Pi.
The production fetch boundary handles real HTTP; replacing native client calls with a fixture dispatcher is insufficient.

Support HTTPS destinations with an approved canonical hostname and explicit address set. Connect only to those addresses
with normal hostname/certificate verification; no unchecked DNS rebinding, alternate spelling or redirect is permitted.
Also support explicit `http://127.0.0.1:PORT/mcp` for an operator-approved local server; never infer loopback permission
from a task. The controlled qualification uses this route and records local_execution/synthetic_fixture provenance.
Reject URL credentials, fragments, unapproved query/path/port, noncanonical addresses and destination changes before
credential resolution. Other plain HTTP and Unix/file/proxy schemes are unsupported.

HTTPS uses the production Node HTTPS boundary with rejectUnauthorized true, the original canonical hostname as
servername/SNI, and the standard tls.checkServerIdentity check. Production connections explicitly use the pinned
Node build's bundled tls.rootCertificates; no ambient trust-store/env override selects a different CA set.
The connection address comes only from approvedAddresses. A hostname resolver result cannot replace that set;
validate the final selected literal before dial, then validate the actual peer address before sending any HTTP header.
The port, Host header, TLS name and exact request target remain bound to the approved URL when dialing its pinned IP.
Bind the original operation/ticket to connection and POST; consume it once and never reconnect on failure.
After successful TLS verification, recheck current authority/deadline/abort immediately before setting Authorization
and ending the request. No asynchronous queue is inserted after that final check. A failed TLS/address check sends
no credential-bearing HTTP request. Destroy and await the original socket; never fall back to plain HTTP.

Qualify these claims with a controlled HTTPS MCP server at 127.0.0.1 and a synthetic DNS-form name
`mirror.loopwright.test`. Its fixture leaf certificate has that SAN and chains to a private qualification CA.
Inject that CA only into this exact controlled test connection through private qualification ports, not public exports,
config, policy, environment or global fetch settings. The production transport, permit, address, SNI, hostname,
auth, byte/deadline and redirect guards remain unchanged. No system CA/config change, browser, third-party DNS,
third-party request or NODE_TLS_REJECT_UNAUTHORIZED change is permitted. Public CA/trust-bypass fields refuse.
The synthetic certificate/key are fixture material, never an operator credential; bound their size and ownership.

| Controlled TLS case | Required observation through the production boundary |
| --- | --- |
| Valid destination | Frozen mirror.loopwright.test endpoint, approved 127.0.0.1 address and fixture CA succeed through real native MCP. Server observes correct SNI, exact target and synthetic bearer; returned candidate bytes match. |
| Wrong hostname | Approve the controlled URL with a different DNS-form name while the leaf retains only the mirror SAN. Normal hostname verification rejects it. Count one bounded connection attempt and zero HTTP requests/bearers; never suppress checkServerIdentity. |
| Untrusted certificate | Omit the fixture CA or serve a leaf from a different fixture CA on the same owned endpoint. Chain verification rejects it with zero HTTP requests/bearers and no alternate trust retry. |
| Unapproved address/rebinding | Inject a resolver/selection proposal of unapproved 127.0.0.2 or ::1 through the private probe while only 127.0.0.1 is approved. Reject before dial/credential attachment. Retain zero dial attempts to that proposal and zero HTTP/bearer requests; never contact a third party. Test changed peer identity refusal separately. |
| Redirect | The authenticated /mcp response points to an unapproved trap path on the same owned server. Count only the original credential-bearing POST and zero trap/follow-up requests. Do not open another service or issue a second ticket. |
| Trust-bypass attempt | Config/policy fields ca, rejectUnauthorized or insecure are rejected before startup. Qualification cannot mutate process TLS environment/system stores or disable certificate validation. |

Run HTTP and HTTPS services sequentially under the existing one provider/MCP pair ceiling, reusing the same
cumulative request/time budget. Count failed TLS/dial attempts against the 1024 MCP-attempt allowance even when
HTTP request count is zero. Log only safe failure codes/identities/counts, never auth/challenge/key bytes.
Failure or inability to implement these controls returns the HTTPS capability for ruling; HTTP evidence alone cannot pass it.

POST initialize/tools/list/initialized management messages require current session owner and distinct bounded read_only
operation intents/receipts. They grant no tool effect. Every tools/call additionally requires the actual current parent
model call, exact invocation/tool/argument binding and original single-use S02 operation permit.
Apply the same checks for direct, hidden, search-selected and native nested/codemode calls. Preserve rootTool checks.
Each physical HTTP send consumes its own journaled operation; a saved marker cannot be turned into another send ticket.

The route permits JSON-RPC JSON responses and bounded 202 notification acknowledgements only.
Reject SSE, session IDs, server-initiated requests, GET/DELETE, changed protocol, reconnect/resume cursors and extra
capabilities. Reject session headers before the transport can retain them; close must issue zero session DELETEs.
Idle cap is at most 2 seconds, absolute per operation at most 10 seconds, headers at most 8 KiB, body at most 64 KiB,
32 pending messages, and aggregate response storage at most 256 KiB. Slow body reads share the absolute deadline.
Progress cannot extend it. Cancellation aborts the underlying socket, awaits local closure and retains unknown outcomes.
Auth 401/403 yields MCP_AUTHENTICATION_REQUIRED after one bounded attempt. Do not expose response bodies/challenges.
No anonymous retry, alternate token, refresh, browser, OAuth callback or auth-store lookup is permitted.

Scan bounded incoming MCP data for the active credential and its JSON-escaped, URL-encoded and base64 canaries before
forwarding it to Pi. Refuse credential echoes without logging the body. This tests defined secret sinks and transforms;
it is not a claim to detect arbitrary malicious re-encoding by an approved server.
Re-resolve on resume under the same binding, permit rotation there, and prove old credentials are not retained.
Missing/empty credentials and OAuth declarations fail before any child or network activity.

The pivotal feasibility gate must use real Pi factories/native client, the owner transport, real HTTP,
real S02 and a controlled authenticated server that checks the synthetic bearer before serving candidate bytes.
Prove allowed direct/nested reads, zero-send server/destination/tool/owner/parent denials, old-policy rejection,
bad-auth one-attempt refusal, controlled TLS positive/negative behavior, redirect/session/SSE refusal, interruption,
cancellation and secret absence. Retain parser/descriptor, capture-binding and native-auth subcheckpoints separately.
A failed mediation or capture-binding probe blocks dependent implementation. Return evidence for a new ruling;
do not switch to a parser-only or generic-proxy demonstration.

### Deadlines, finalization and artifact privacy

Derive the work cutoff from S02's original taskDeadlineMonotonicMs minus the immutable drain reserve.
No new node, repair, compaction, verifier or MCP management work begins at or after that cutoff.
An independent controller timer initiates adapter cancellation and verifier termination at the cutoff or signal.
It does not rearm from heartbeat/progress. Current original S02/Pi clock checks still guard every physical effect.
Reject execution if the remaining budget cannot cover the declared drain reserve. Renew ownership only within
the existing lease rules; clock/owner errors revoke execution. Do not abandon a live child after Promise.race.

Drain revokes new work, awaits bounded local shutdown and attempts deterministic finalization before the original
task deadline. Finalization syncs the selected immutable core result/incident and references it in terminal intent before
secondary event/summary writes. The terminal result phase binds the same bytes. Without an authoritative intent,
return an incident; a loose result file cannot authenticate completion. Check-only graphs explicitly identify their
controller-origin requested status and have no submitted model claims. Absent captured status is null and cannot
fallback to completed/no_change. Finalization uses no model call and never grants additional time/tokens. Reserve at most 5 seconds
and 1 MiB for its result/observation writes within the drain allowance. At expiry, unfinished cleanup/finalization
stays pending in an incident; it cannot become completed. Retain guards until exact cleanup is proven.
Local cancellation never confirms remote provider termination or absence of billing.

Select the primary outcome once from authenticated facts. Secondary summary/event/export failures are observations,
not permission to overwrite acceptance. If a valid core result cannot be constructed because state, usage or artifacts
are unavailable, emit ControllerIncident `{version,code,runId,lockHash,stage,knownReferences,unavailable,cleanup}`.
Unavailable fields remain explicitly unavailable. No fabricated candidate, zero usage or empty successful matrix.
Memory is not_requested by default; requested later work is unavailable with a reason. No memory proposal/application runs.

Public controller events contain version, monotone sequence, run/node/controller attempt IDs, stage, code, current
S02 budget snapshot, original deadline and safe artifact refs. Budget snapshots are observations, never admission inputs.
Heartbeat is a distinct waiting event every 30 seconds. Bound each event at 4096 bytes, queued events at 128/512 KiB,
and retained public JSONL at 4 MiB. Backpressure has a 1000 ms limit. On overflow, stop new work and retain an incident.
Permit a bounded terminal record after ordinary event capacity is reached; never silently discard required progress.
Escape control/newline/ANSI/workflow-command text and allowlist safe fields before any console/JSONL sink.
Reserve one queued entry/4096 bytes and one retained terminal record from ordinary capacity. After a sink failure,
retain already accepted records and stop further sink callbacks. Sync the safe private JSONL stream during work;
seal its same inode as a final single-link immutable artifact, using a no-overwrite link then removing its original
private name. Do not rewrite up to 4 MiB of event bodies inside the 1-MiB deterministic finalizer allowance.
Interrupted/torn streams or uncertain sealing refuse recovery; an unsealed event file grants no execution authority.

The export manifest is `{version:1,runId,lockHash,entries}`. Entries are `{name,presence,ref,reason}`;
presence is present/absent/not_run, ref is a core ArtifactRef or null, and reason is a safe code or null.
Include task.lock.json, plan.json, candidate.patch or byte-bound candidate files, verification.json, result.json,
events.jsonl, usage.json, checkpoint.manifest.json and result.md when actually present.
Keep the manifest within core's 256-entry bound, each artifact within 8 MiB and resolved public bytes within 16 MiB.
Explicitly list unavailable optional review/memory/publication output; do not invent proof files.
Checkpoint metadata contains only public identities, safe boundary IDs and artifact digests; native workspace/session
contents, private prompts/submissions, secret references with access paths, ownership nonces and SQLite files are excluded.
Export takes an explicit destination and performs bounded no-overwrite writes. It never copies the live state directory.
Credential references are logical approved IDs; paths/environment values do not enter public output.
Inspect/status do not load environment credentials or claim/renew ownership, repair files, start workers or call a daemon.
They read current S02 through public reopen/inspect where supported and label stale cached observations explicitly.
Absent/corrupt/unqualified authority produces unavailable facts, not an inferred run status.

### Implementation Plan

Run implementation with one worker under the approved plan. These edges reflect shared public seams,
checkpoint protocols and integrated acceptance dependencies. Independent recovery and CLI source work may proceed
while an integrated native prerequisite remains blocked; its acceptance stays blocked or not_run.
Routine owned source fixes, focused offline tests, relevant reruns and coherent commits proceed without per-command
approval. Use ordinary bounded local tools for development, independently of failed native qualification accounting;
normally allow120seconds per command and up to300seconds for full build/test. Investigate hung work before repeating it.
Gate: review marks pivotal/authority/exported scope for ship review and does not authorize build helpers.
Escalate unsafe ownership/security/cleanup uncertainty, material API/acceptance changes, unavailable required resources
or actual resource limits. An actual native restart still requires its concrete incident disposition and approval.

- [x] **T0 · Qualify the public capture, parser and authenticated native MCP seams**
  Blocked by: None. All T0 subgates must pass before dependent implementation.
  Owns: narrow `packages/agent-pi/src/{index,types,adapter,policy,capture,recovery,mcp,mcp-transport}.ts` additions,
  new passive descriptor/decoder and HTTP boundary modules, narrow owner-tag plumbing in
  `packages/agent-pi/qualification/{run,runtime-image}.mjs`,
  `packages/controller/qualification/{feasibility,parser-descriptor,capture-binding,mcp-auth}.*`,
  `packages/controller/qualification/tls-fixtures/**`,
  minimal package/root runner wiring and lock update. Keep v1 behavior/source compatibility and no core/state edits.
  Gate: review.
  Acceptance: first reproduce 350 baseline cases on the unchanged base, then obtain positive/negative behavioral
  controls for duplicate-safe parsing, actual capture/current-command extraction, passive identity discovery,
  strict v1 rejection and real native token-bearing HTTP/HTTPS. Gate must fail on guard removal, not compile errors.
  Stop dependent work for any unsupported public API, native transport mismatch, credential leak or failed cleanup.
  Verify: `npm ci`; `npm run build`; `npm run typecheck`; `npm run lint`; `npm test`;
  `npm run qualify:controller -- --case feasibility`; `npm run qualify:controller -- --case mcp-auth`.
  Retained subcheckpoints: T0a parser/descriptor <=60 seconds, T0b capture binding <=180 seconds including any
  <=120-second image build, and T0c native auth <=480 seconds. T0c contains HTTP controls <=180, local TLS controls
  <=180 and auth interruption/re-resolution/canaries <=120 seconds. Each has its own source/exit/count/cleanup record.
  Run them serially, without helpers. Failure stops the dependent gate; a retained receipt is not permission to rerun.

- [x] **T1 · Compile a trusted static plan without effects**
  Blocked by: T0 parser and descriptor feasibility.
  Owns: `packages/controller/src/{config,registry,interpolation,credentials,compile,errors,types,index}.ts`,
  `packages/controller/test/config-*.test.ts`, controller package metadata and focused runner registration.
  Gate: review.
  Acceptance: bounded closed loader and explicit registry approval compile existing TaskContract references;
  missing/denied variables, cycles, handler mismatches and unsupported capabilities cause zero startup/network/state;
  check-ready data is redacted and distinguishes static validity from runtime qualification.
  Verify: `npm run test:controller -- --case config`; `npm run typecheck`; `npm run lint`.

- [x] **T2 · Retain one owned controller boundary and adopt known progress**
  Blocked by: T1 frozen plan and T0 capture decoder.
  Owns: `packages/controller/src/{storage,progress,ownership,source,capture}.ts`,
  `packages/controller/test/progress-*.test.ts`, retained-process fixtures.
  Gate: review.
  Acceptance: real S02/immutable artifacts, distinct controller/Pi checkpoint identities, original clock and
  PID/birth/boot exclusion work; a lost ACK adopts exact committed progress; unresolved or missing-capture work refuses replay.
  Persist attempt/signature history and the full phase capacity proof with authoritative anchors. Prove repeated
  verification/compaction/terminal emissions, exact-fit 64 versus refused 65, fixed four-ref checkpoints and non-reset
  remaining capacity after resume. No second accounting store or private state imports.
  Verify: `npm run test:controller -- --case progress`; `npm run test:controller -- --case recovery`.

- [x] **T3 · Independently verify a captured submission**
  Blocked by: T2 authenticated candidate/progress boundary.
  Owns: `packages/controller/src/{submission,verification,verifier-protocol,verifier-worker,acceptance}.ts`,
  `packages/controller/test/verification-*.test.ts` and worker containment fixtures.
  Gate: review.
  Acceptance: actual captured artifact/assistant bytes normalize uniquely; registered inert-data verifiers obtain
  original S02 permits, bounded workers and authenticated receipts; false pass/forged evidence/stale candidate cannot pass;
  real scope/JSON/no-change results reach unchanged core acceptance APIs with honest usage/effects. Complete inventory
  jobs and exact encoded JSON packet preflight handle 4-MiB candidates without truncation; one-byte-over cases dispatch zero.
  Qualify configured JS-heap and application-buffer guards without claiming an RSS bound.
  Static outputs/examples and positive no-change fixtures declare the original required check; absent/optional-only/
  disallowed-level/wrong-handler cases refuse no-change proof, lexical selection precedes outcomes, and legitimate
  changed completed retains honest failed implicit equality. No implicit evidence is renamed or reused in core.
  Verify: `npm run test:controller -- --case verification`; `npm run test:controller -- --case progress`.

- [x] **T4 · Execute and repair a finite admitted cycle**
  Blocked by: T3 current-candidate independent verification.
  Owns: `packages/controller/src/{controller,scheduler,repair,deadlines,finalize,events}.ts`,
  `packages/controller/test/scheduling-*.test.ts`, controller execution/repair qualification groups.
  Gate: review.
  Acceptance: sequential ready-node scheduling, actual Pi production execution, separate finite repairs,
  persistent repeat signatures, sender-only retry and reserved drain yield correct core statuses;
  required descendants stay not_run, missing evidence is blocked, and finalizer failure preserves primary outcome.
  Positive no-change cycles use the selected original required proof plus their own implicit equality job; missing
  eligibility blocks without repair/downgrade, and all required predicates plus scope still guard success.
  Verify: `npm run test:controller -- --case scheduling`; `node packages/controller/qualification/delivery-native.mjs --case cycle --phase finalController`;
  `node packages/controller/qualification/delivery-native.mjs --case repair --phase finalController`.

- [x] **T5 · Resume and cancel real retained execution without replay**
  Blocked by: T4 complete lifecycle and T2 retained protocol.
  Preserve the originally selected no-change check, separate job/producer identities and current-generation proofs;
  resume cannot select a different passing check or gain a missing binding.
  Owns: `packages/controller/src/recovery.ts`, integration fixes to owned controller lifecycle modules,
  `packages/controller/test/recovery-*.test.ts`, real process/qualification interruption groups.
  Gate: review.
  Acceptance: explicit-ID safe restore sends zero until new authorized work; exact process interruptions cover
  dispatch/receipt/capture/progress windows; concurrent/live-owner resume blocks; deadline/drift/unknown/corrupt cases
  retain authority/refusals; SIGINT/SIGTERM drain and cleanup failure remain honest.
  Verify: `npm run test:controller -- --case recovery`; `resume` verification in `delivery-native.mjs --case cycle|repair --phase finalController`
  (standalone native `recovery`/`cancellation` leaves in `run.mjs` and real SIGINT/SIGTERM subprocess delivery held as `not_run` under the v2 reservation fence;
  `pre_intent` and `post_dispatch_pre_receipt` process-crash windows plus `concurrent_resume_probe` refusal verified in `recovery-owner.test.ts`;
  in-process checkpoint interruption windows and `AbortSignal` cancellation verified in `recovery-cycle.test.ts`).

- [x] **T6 · Deliver CLI commands and byte-bound redacted bundles**
  Blocked by: T5 product lifecycle/incident contracts.
  Owns: `packages/cli/**`, `packages/controller/src/{inspect,bundle}.ts`,
  `packages/controller/test/artifacts-*.test.ts`, controller secret qualification and final CLI test wiring.
  Gate: review.
  Acceptance: all frozen flags/exits/schemas run through public imports; static commands require no Docker;
  fresh/resumed execution uses production controller functions; bounded public sinks/bundles contain no canaries,
  raw sessions, state copy or fabricated evidence; default init cannot silently execute.
  Verify: `npm run test:controller -- --case cli`; `npm run test:controller -- --case artifacts`;
  `npm run test:controller -- --case config` and `t0` `mcp-credentials` (standalone `run.mjs` `secrets` leaf held as `not_run` under the v2 reservation fence).

- [x] **T7 · Document and ship the exact qualified local tree**
  Blocked by: T6 and every prerequisite qualification.
  Owns: `README.md`, `docs/{controller,development,pi-adapter}.md`,
  `examples/{README,controller}.md`, this spec, final root metadata and qualification wiring.
  Gate: review.
  Acceptance: docs/examples match implemented public imports/CLI; five root checks preserve all baseline cases;
  final actual S04 CLI/native/MCP and S03 qualification run on the frozen source/image. Self-contained references,
  signoffs, evidence inventory and exact cleanup are reviewable. Ship owns a frozen brief for the root-adopted
  independent Pi glm-5.3/max reviewer; verify its configured effective provider/model/thinking before dispatch.
  Coordinator separately accepts the result. No worker merge, push, PR, CI/CD or publication.
  Final no-change/4-MiB native positives contain the original selected required declared proof and a separate implicit
  equality job. Ship reviews this core composition; missing/forged/stale/wrong-producer proof and last-byte mutations
  cannot become success. Keep a changed completed case with honest failed implicit equality.
  Verify: `npm ci`; `npm run build`; `npm run typecheck`; `npm run lint`; `npm test`;
  `node packages/controller/qualification/delivery-native.mjs --case cycle|repair --phase finalController`; `node packages/controller/qualification/delivery-preflight.mjs`; `node packages/controller/qualification/delivery-s03.mjs --case <group> --owner controller`;
  public CLI help/example checks and spec/content/scope/signoff audits.

T0 is gated feasibility implementation. Its approval does not permit broadening the adapter.
T1 depends on its parser/descriptor result; T2 needs its real captured bytes and the compiled identity.
Verification requires retained producer/candidate identity, and scheduling requires that verifier boundary.
Recovery needs the complete execution/repair graph. CLI integration waits for stable lifecycle/incident behavior.
Overlapping ownership in later integration tasks is deliberate under the single serial worker.

### Local qualification budget and stop rules

Limit local installation/lock preparation to at most 600 seconds, at most 512 MiB downloads,
and 2 GiB dependency/build scratch. Keep SDK/runtime/parser versions fixed. No global install or credential-store copy.
Missing public dependencies or base-image availability is BLOCKED; no registry recovery/pull/substitution is authorized.

Limit cumulative effectful native qualification to at most 5400 seconds across all approved stages/restarts,
including a 300-second final cleanup reserve. T0 uses at most 320 seconds; later first qualification at most 1500;
final S03 suite at most 1900; final S04 suite at most 1380. These work limits total 5100 seconds.
Unused phase time remains inside the same total; a timeout never resets it.
Ordinary local offline development is separate from native admission and uses the bounded tool timeouts above.
Its historical1500-second deterministic-check ceiling is prospectively retired; preserve that ledger and every
prior failed/premature charge unchanged. Do not open, reconcile or reset a failed native context to run development
checks. Repeat focused checks after relevant changes or failure investigation, then run all required checks on the
final coherent candidate. Existing installation, native, image, container and send limits remain binding.

Use the already approved exact base image, private empty Docker client config and canonical selected daemon.
At most three source-bound derived image builds, each at most 120 seconds; no pull/network build.
At most four active owned containers and 896 new container identities across qualification, with one test group active.
Before create/spawn, sync the owned logical intent with name/nonce/labels/daemon/image and original parent
PID/birth/boot. Record the actual child PID/birth/exit after spawn; never claim its PID was known beforehand.
The app parent must complete its durable nonce/PID/birth/boot registration before a pre-module startup ACK.
Logical intent does not prove spawn/exit/absence, and missing stock attach identity still prevents recovery.
Add a qualification-only `--owner controller` option to the existing Pi runner. It supplies a recorded nonce-based
image tag to runtime-image and keeps all generated registries in this worktree's private qualification directory.
Final `qualify:pi -- --case all` invocations below include this option. Do not overwrite its fixed historical image tag.
Reuse its pinned Dockerfile/profile without changing base, user, mounts, seccomp, environment or network restrictions.
Retain image/source/config digests. Remove only exact S04-owned container/attach/service/scratch identities.
Keep the worktree, authoritative test stores and evidence until reviewed. Do not delete shared/base images or historical S03 resources.

The controlled provider and authenticated MCP services listen only on ephemeral 127.0.0.1 ports, one pair at a time.
Use synthetic tokens only. Cap total controlled provider sends at 960 and MCP HTTP requests at 1728, including negative
controls and final reruns. Each fixture TaskContract has at most 16 model calls, output cap 1024, a cycle at most 600 seconds,
and the same 120-second drain reserve. A deadline control can use a shorter explicitly frozen cycle exceeding the reserve;
for example 135000 ms gives a real 15000-ms work cutoff without changing the original S02 clock.
Clip each provider send at 90 seconds and MCP send at 10 seconds. Leaf cases are at most 180 seconds;
aggregate aliases have the sum of their explicitly registered leaf limits, never a reset deadline.
The final controller all limits are parser/descriptor 60, capture 180, native-auth 480, cycle 120, repair 120,
recovery 240, cancellation 120 and secrets 60 seconds, totaling 1380. Recovery contains bounded leaves rather than
an additional 600-second wait. TLS controls are inside native-auth's 480 seconds and existing MCP attempt ceiling.
All limits consume the cumulative budget. Verifier jobs retain 2 seconds and configured JS-heap/buffer bounds, not an RSS guarantee.
Register services/child identities before listening/spawn; await exact close/exit and verify owned port/container absence.

Public-default native cycle/repair activation additionally requires an accepted physical-handoff fencing protocol.
Synchronous counter lock/read/write/fsync blocks the event loop: a later AbortSignal check alone cannot establish
original S02 permit/deadline/owner validity. Qualifying instrumentation must preserve the original authority check at
fetch/http.request/create/start despite delayed persistence, or use explicitly approved conservative qualification
reservations distinguishable from observed attempts. Offline guard success cannot authorize native activation.
No production API/private-import/permit reconstruction or hidden fallback may fill that gap.

The private harness reserves finite provider/MCP/container capacity durably before app import, task admission or
leaf service creation. Keep legacy observations, held capacity and proven terminal actual counts separate. A crash,
torn/busy/foreign lock, uncertain commit or missing terminal proof keeps the full reservation charged and blocks
new work; no stale deletion, reset or replay. Only the original supervised parent can settle after complete synced
trace/counters, exact child/descendant exit and stock resource cleanup/absence. Keep prior caps and sealed actuals;
duplicate settlement is idempotent. Offline tests use disposable ledgers and leave the actual native ledger unchanged.

The original qualification parent alone holds the opaque reservation handle. One durably registered app child per
reservation may receive a once-only observation ticket over the owned pre-module startup channel. Bind parent/child
PID/birth/boot, reservation, finite caps, source/image, run/task/dispatch and immutable cutoffs. Authenticate that
channel and ticket before app imports; arbitrary decoded records, duplicate/foreign/altered/widened tickets, missing
ACK or uncertain delivery cannot provision another meter. The child cannot serialize/reconstruct the parent's handle,
write or settle the parent ledger, grant a task permit, override stock authorization or replay unknown work.
Shared qualification budget/time writers use common exclusion, including legacy writers and migration. A prior
existence check alone cannot protect a later write. Root command elapsed/exit/log evidence is persisted and charged
before fallible native reconciliation; ambiguous persistence blocks further work and retains original transition IDs.

Owned-child-only provider/MCP shims consume memory ordinals and preserve original live permits. No added filesystem,
process, await or logging step follows the stock final provider check. Preserve the MCP connect-time guard: expiry
before request creation means zero requests, whereas expiry after a socket exists means a counted attempt and zero
authorization/body writes. No container preload or ambient worker/coordinator mutation is allowed.

The qualification parent intercepts exact real-Docker execFile/spawn calls before product imports, preserving public
ESM bindings, callbacks, promisify.custom/PromiseWithChild and original argv/options. Finish durable observation and
all original public S02 inspect/close work before the final fence. Bind expected original owner/store/run/lock/basis;
then sample hrtime in the same boot epoch and check signal plus minimum original task/lease/work/leaf cutoff immediately
before the saved process call. This only revokes bootstrap work; it creates no task permit or allowance. Unknown child
identity/exit/cleanup remains occupied and prevents settlement/new create. Native cycle/repair remain explicitly held
until a separate frozen-source, original-runtime and complete offline-evidence activation ruling.

Dormant qualification integration binds one whole-leaf recipe to a versioned registered observation envelope, with
separate parent/application activation holds and no issuers. Offline tickets, copied ledgers and parsed observations
cannot activate native execution or brand native cleanup. Public S02/checkpoint/progress records bind the latest
unfinished role before stock adapter open; no private controller or adapter injection is used. Native cleanup requires
original process/stream/attach/service events, exact removal and absence, and a complete bounded reference graph.
Retain raw streams up to 64 MiB per leaf in at most 1-MiB chunks; at most 64 index shards of 64 refs and 4096 nested
refs preserve the existing 195 seal-root ref cap. Missing/overflow evidence retains full uncertainty. These private
qualification limits change no S02/checkpoint allowance. All twelve recipe load/compile checks remain static authoring
evidence. Actual image/runtime/payload/ownership/cleanup, application activation and native execution require a later
explicit ruling. The bounded dormant check sequence is one 30-second lint, one 60-second offline group and one
15-second complete original-proof reader, inside the unchanged cumulative root limit; no native or crypto rerun.
Before native activation, independently match receiver/process events to traces by original case/attempt/event
ordinal and bind saved observations to complete original product artifacts and reopened public S02 records. Equal
payload digests never collapse distinct sends. Parent preparation belongs inside its original timed envelope;
pending/unknown time acknowledgement blocks all grant writers through shared exclusion, including pre-migration
legacy paths. Before-migration failure preserves legacy bytes and available elapsed/intent evidence. No copied data,
unknown acknowledgement or new clock sample can mint authority, reconstruct an earlier observation or reset a budget.

The private image inspector has a separate unissuable preflight capability; it cannot satisfy parent/application holds.
Source-only controls preserve all prior cases and add closed Docker-save/OCI raw/gzip byte parsing, duplicate-key and
numeric/path refusal, complete builder-copy installed inventory, original layer/descriptor/diffID order, lower-layer
whiteouts and safe literal/link lineage. Never extract to the host, switch compression/layout, replay a save or infer a
deleted historical context manifest. Archive spool, selected chunks and reports share a 2-GiB disk ceiling; selected
regular bytes are at most 1 GiB, cumulative expanded bytes 4 GiB, a layer 1 GiB, a selected/general file 128 MiB, layers 256, members
200000, copied entries 65536, links 4096 and metadata 32 MiB. Streaming chunks are at most 1 MiB with an 8-MiB logical
buffer ceiling. Retain bounded partial originals on refusal. V8 heap limits are distinct from observed host RSS.
One extra local hardlink round reads only the same immutable owned spool; it creates no CLI/network replay authority.
The only parser per-file exception is nonselected normalized regular `usr/local/bin/node`, at most150328456bytes,
in digest-verified layer `a8095a8cfac3173101d798f43eceff12c9261ea4b1e82ec40dbfeef67a667fd5` reached through the
approved pinned-image chain. It is streamed/hashed without retaining its body. Selected hardlinks and deferred
restoration still have the128-MiB cap. Associated OCI attestation metadata is validated for exact descriptor/subject
association and remains opaque, with provenance NOT_VERIFIED. Nonselected absolute links are image-namespace data
only; selected absolute-link and ancestor-link traversal stay refused.
Private initial:image-preflight has a cumulative640-second suballocation within the unchanged1500initial/5100work/5400total caps. Each original attempt remains at most60seconds and is clipped to every remaining bound; previous failures and measurements are never reset. Its distinct
timing path preserves every original charge/reservation and records serialization/before/proposed/elapsed differences in
the original shared pending/CAS/commit/ack namespace. A migrated v2 book appends only its original time transition
and revision under that same opaque time handle; legacy books retain their original plain shape. Failure, timeout and overrun retain actual elapsed without
truncation or refund and block progression; original parent pre-migration refusal stays unchanged. No real transition,
issuer, image/daemon/absence/lsof read or native leaf is authorized by source-only acceptance. Serena project binding,
symbol navigation, full-file diagnostics and exact unavailable/incomplete limitations are retained alongside build
evidence; LSP does not replace required validation or supply runtime acceptance.

No live/provider/count/auth exchange with a third-party service, paid resource, new backend or review helper is requested
for build qualification. The synthetic server's bearer check is local authentication evidence only.
S03's eight unused live calls and closed historical qualification budgets remain untouched.
Stop the dependent gate on failed/inconclusive feasibility, security leakage, state corruption, uncertain cleanup,
resource exhaustion or an unapproved interface change. Retain the failure and ask for a ruling; do not auto-repeat it.

The historical private preflight source-only preparation retained one builtin-only Node bootstrap, continuous common exclusion
through the existing pending-time fence, one unchanged original monotonic start and an exclusive no-reissue marker.
Python root elapsed is separate and never converted into a native start. Source/control proof must cover duplicate
handoff, lock/path substitution, post-I/O expiry, delayed preparation with zero lower actions and a killed copied
bootstrap leaving durable uncertainty. Historical identity views retain whole-budget and original-intent references,
raw rows/labels and explicit direct-or-label nonce provenance; present invalid or conflicting fields refuse without
rewriting originals or inferring values from names. The future single daemon read may establish only a new current
local anchor, with historical equality unknown and continuity unproven. At that source-only checkpoint all
parent/app/preflight activation sets remained unissued and the future enable deltas were retained inert.
The source-only sequence preserves all71 existing Node/sixPython controls and appends four groups (75Node total)
within one serial30/60/15-second lint/group/original-proof allowance, clipped to the unchanged cumulative root.
That historical preparation alone did not complete T4 or supply native/image/full350/CLI/recovery/live acceptance.
Subsequent explicit execution rulings and original cycle003/repair009 evidence support the accepted local T4
milestone. The current root suite passes504tests with no skips; this does not complete T5/T6 or live qualification.
REVIEW064/065/066 separately authorize the fixed S03 same-book debit-only wrapper and prospective192container/
224provider/448MCP envelope. It retains original scripts, raw precharges, exact registered descendants, original
absolute clocks and full nonrefundable allocated_unknown closure; no S02 permit or actual settlement is invented.
Current source/compiled/pinned-image checks and final S03 native results remain separately required before ship.

Private initial:repair has a cumulative240-second suballocation inside the unchanged initial/global limits. Each original attempt remains at most120seconds, with its20-second drain inside that cutoff: min(120,240 minus previously spent repair seconds,remaining phase/work/total time). Final-controller repair retains its original120-second cumulative limit. Prior failed charges and allocations remain; no phase relabel or clock reset is allowed.

### Test Plan

[x] I understand that the component owners may require changes to existing tests before committing implementation.
All test names below are planned behavioral cases, not evidence of execution. Coverage is not yet measured.

#### Prerequisite testing updates

- First reproduce the 350 unchanged core/state/adapter cases after approved installation. Retain their test-name inventory;
  a larger total alone cannot prove baseline preservation. Never replace, skip or weaken those assertions.
- Register controller/CLI build/test paths in existing strict TypeScript/ESLint/root scripts. Use deterministic node:test
  groups. Keep native/runtime imports lazy so static commands work without Docker or native startup.
- Add a private counted provider fixture and controlled authenticated HTTP/HTTPS MCP server to separate qualification entrypoints.
  Public CLI has no fixture flag or production credential bypass. Private injection selects only controlled endpoints
  and a fixture CA for the exact local TLS connection. Retain production admission, sender, factories, native client,
  hostname/address/auth guards, state, verifier and CLI parsing paths. Never inject a global trust bypass.
- For pivotal guards, retain a behavioral RED or restored production-guard mutation that changes unauthorized effects
  or acceptance. Syntax/type errors and a second mock implementation do not qualify the guard.
- Capture argv, cwd, frozen head/tree, runtime, exit, counts, log hashes, ownership and cleanup for every executed group.

#### Unit tests

- `@loopwright/controller`: planned 2026-11-06; line/branch coverage unmeasured, no invented percentage.
  Cover all diagnostic/refusal/repair transitions rather than an arbitrary numeric target.
- `@loopwright/cli`: planned 2026-11-06; coverage unmeasured. Assert documented stdout/stderr and exit behavior.
- `@loopwright/agent-pi` additions: planned 2026-11-06; coverage unmeasured. Preserve v1 cases and test v2 separation.

| Group | Positive and negative behavioral cases |
| --- | --- |
| config | JSON/YAML nested/embedded interpolation; empty string; quotes/newline data; $$ and $${NAME}; bare dollars; no recursion/coercion; missing/denied names; malformed/default/shell expressions; duplicate escaped keys; tags/aliases/merge/multiple docs; key/object/prototype/size/depth limits; secret-safe errors. |
| registry/compile | Explicit approval hash/path/permissions; malicious config selecting env/handler/URL; unknown/duplicate/mismatched references; DAG cycles; unsupported gate/code validator/hard-token/direct backend; resource changes; complete A/N/I/C/V/J/D checkpoint calculation with repeated validation, compaction and terminal reserve; worked 37-record repair case, exact-fit 64 and refused 65; actual checkpoint/receipt-index bytes and ref caps; strict default and explicit estimated opt-in; zero effect static checks. |
| capture/progress | Current command final assistant/artifact selection; no thinking/old output; malformed/forked/missing native rows and chunks; refs/digest/role/checkpoint/runtime mismatch; conflicting submissions; distinct Pi/controller checkpoints; orphan file; committed lost ACK; unchanged original deadline; no permit serialization. |
| verification | Real registered scope/JSON/no-change pass/fail; full source and candidate inventories with manifest/subject byte binding; 4-MiB inventories including last-byte change; omitted/duplicate/truncated inventory rejection; maximal complete manifest jobs; exact 1-MiB JSON packet and one-byte-over zero dispatch; oversized selected file inside an otherwise supported candidate; header/encoding/buffer guards; forged model/file evidence; wrong producer/nonce/dispatch; stale subject/bytes; evidence levels; blocked/not_run visibility; worker heap/overflow/timeouts/termination with no RSS claim; no candidate-code evaluation or privileged command path. |
| scheduling/repair | Dependency readiness and descendants; independent branches; terminal precedence; format versus implementation/missing/auth/transport/unknown categories; zero/exact/exhausted caps; shared S02 charges; persisted attempt/repeat signatures; identical evidence with a new receipt ID; compaction purpose and unchanged context; no controller transport retry. |
| recovery/deadlines | Same-run re-resolution/rotation; explicit IDs; live/dead/unverifiable controller owner; concurrent resume; original clock drift/expiry; vanished/corrupt/mismatched state/artifacts; each ordering window; late ledger/signature history; consumed checkpoint slots/reserved terminal phases cannot reset; same-ID ACK loss consumes once; drain work cutoff; independent timeout despite progress; failed cleanup/finalization; incident without invented fields. |
| artifacts/CLI | Every flag and exit; draft overwrite refusal; no latest/config discovery; JSONL schemas; display escape/control/ANSI/workflow text; queue/byte caps and bounded backpressure; manifest hashes/absent rows; no live SQLite/native session export; status/inspect with no auth/claim/daemon; symlink/path replacement and no-overwrite output. |
| MCP v2 | v1 rejects v2 fields; exact approved URL/server/name/effect/parent/current owner; post-resolver abort; one-use dispatch; no shared provider resolver; real local TLS pinned-address success with expected SNI/hostname; wrong hostname/untrusted chain; denied address/rebinding proposal and changed peer; redirect trap receives zero follow-up bearer; no public/env/global trust bypass; body/header/idle/absolute bounds; 401/403 once; zero GET/DELETE/reconnect/refresh; session/SSE refusal; no anonymous fallback; private canaries absent. |

#### Integration tests

- Real LocalRunStore and controller checkpoint files with process-controlled interruption at pre-intent,
  post-dispatch/pre-receipt, receipt-bytes/pre-S02-ACK, Pi-capture/pre-progress, progress/pre-index and final-result/pre-ACK.
  Record actual child exits. Unknown windows retain charges and cannot produce a second effect marker.
- Spawn two explicit-ID resume processes. Keep the first live beyond a lease boundary; the second must refuse.
  Then prove dead-owner recovery on the same boot with exact cleanup. Missing death evidence stays blocked.
- Use trusted byte verifiers through real Worker channels and S02 operation receipts. A fake producer/file or altered
  candidate must fail eligibility. Required failures must reach core as failed/blocked/not_run, never success.
- Exercise the 37-record repair schedule and exact-fit 64-record schedule against real S02 after approval, including
  all affected verifier reruns, failure signatures and terminal phases. Interrupt before a post transition, reopen
  the same state, and show that completed phases/attempts are not reallocated. The 65-record plan refuses before create.
- Pass largest supported complete inventory/JSON packets through real Worker channels. One-byte-over packet/manifest
  preflight must show zero Worker/S02 verifier dispatch. Complete 4-MiB source/candidate hashing and a last-byte mutation
  must affect the independent worker's no-change outcome; parent-calculated booleans cannot satisfy it.
- Exercise CLI subprocesses for init/check/dry-run/status/inspect without Docker or credentials. Instrument private
  counters to prove zero model/network/worker/daemon/S02-admission effects for static commands and missing variables.
- Reopen the same real state and immutable progress after a lost completion ACK; core result/candidate/usage remain identical.
  Do not repair progress by launching a new agent. A completed receipt without required capture blocks safely.
- Canary scan every ordinary diagnostic, JSONL/event, public configuration/plan/lock, checkpoint metadata and exported
  artifact. Inspect private snapshots separately to prove no credential reached model/tool/native context.

#### e2e tests

These commands consume the approved stage/resource ceilings. Missing native prerequisites return nonzero BLOCKED.

| Qualification | Required observations |
| --- | --- |
| feasibility | Separate retained parser/descriptor and capture-binding subcheckpoints on exact source/runtime; actual captured current response/candidate and unchanged v1 refusals. T0 additionally requires native-auth. No helper or substituted artifact. Failure stops dependent tasks. |
| mcp-auth | Actual native direct/codemode authenticated HTTP reads plus controlled local HTTPS positive with correct hostname/SNI/CA/address; wrong hostname/untrusted leaf/address-rebinding/changed peer denials; redirect has zero credential follow-up; private per-test-connection CA only; denied server/tool/effect/owner/parent; invalid auth one request; no GET/DELETE/session/SSE/retry/refresh; cancellation/deadline/rotated reference and all secret sinks. HTTP alone cannot qualify HTTPS. |
| cycle | Real product CLI/controller + S02 + Pi SDK + counted HTTP + isolated candidate + independent byte verifier: legitimate changed completed with honest failed implicit equality, false submitted pass, required-check failure, verify_no_change with its original selected required declared proof and separate implicit job, missing-binding blocked without repair/downgrade, exhausted allowance and blocked evidence. Counts separate synthetic provider replies from local native execution. |
| repair | One successful format repair preserving original facts; one scoped implementation repair with changed candidate and rerun evidence; zero/exact parent limits; repeated identical signature stops across retained resume; adapter-only counted 429 retry and no repeat after uncertainty. A terminal 429 retains its unknown token charge under the frozen S02/S03 contract, so the controller emits RECOVERY_REQUIRED and refuses capture/resume even after the second send succeeds; this is the required safety outcome, never a completed task or zero usage. |
| recovery | Standalone `run.mjs` native leaf held `not_run` under the v2 reservation fence; resumed CLI/controller execution verified in `delivery-native.mjs --case cycle\|repair --phase finalController`, real `pre_intent`/`post_dispatch_pre_receipt` SIGKILL windows and `concurrent_resume_probe` refusal in `recovery-owner.test.ts`, and in-process checkpoint windows, stale candidate/runtime/source rejection and unknown-effect refusal in `recovery-cycle.test.ts`. |
| cancellation | Standalone `run.mjs` native leaf and real SIGINT/SIGTERM subprocess delivery held `not_run` under the v2 reservation fence; in-process `AbortSignal` cancellation, reserve drain, independent absolute deadline under progress, and stubborn/failed cleanup incident retention verified in `recovery-cycle.test.ts` and `arguments.test.ts`. |
| secrets | Standalone `run.mjs` native leaf held `not_run` under the v2 reservation fence; production loader special-character/nonrecursive tokens, zero-spawn missing/empty/denied variables, rotation, and public/bundle canary redaction verified in `test:controller -- --case config\|artifacts` and T0 `mcp-credentials`. |
| final S03 regression | Run the existing full non-live native matrix on final image/source. Retain failures and per-group status; historical native totals are not an S04 pass. |

No third-party live server, provider billing, OAuth, remote publication, candidate-code test suite, hardware,
reboot/suspend/host-loss or deployed-host acceptance is claimed. Those are unsupported/blocked/not_run as applicable.
Keep static/unit/native-local/synthetic/live evidence in separate matrix rows. A blocked or skipped row never counts as passed.

## Alternatives

- A shell script around prompt and exit0 is smaller, but cannot retain step/effect identity or independently verify acceptance.
- A second controller budget store appears convenient, but introduces contradictory authority and unsafe replay after partial commits.
- Mutating S02/core formats immediately would couple CLI design to durable contracts; first propose composition through public APIs.
- Parser-only environment substitution leaves the MCP-token use case unproved and is not sufficient acceptance.
- Passing secrets to SDK/shell environments is simple but crosses the established credential boundary; use scoped trusted mediation.
- Implicit latest-session resume removes an argument but can choose the wrong run and reset identity. Require an explicit retained run.
- Enabling durable, a new backend or remote publication now expands independent qualification surfaces. Keep those later scopes explicit.

## Open Questions

No design decision blocks entry into implementation. The passive/v2 interfaces, credential seam, sessionless
workspace mirror, inert-data verifiers, CLI/config/parser/checkpoint choices, complete capacity schedule, complete job
packets and controlled TLS qualification are approved. The serial dependencies and local ceilings below are active.

Actual parser/descriptor, capture-binding and native HTTP/TLS authentication remain independent T0 feasibility gates.
Retain each result. All must pass before T1-T7; success permits the serial chain without another routine approval.
Failed/inconclusive feasibility, security/state/cleanup problems, exhausted ceilings or unapproved interface changes
require a new ruling. Do not reset resources, weaken an invariant or substitute another route.
No core/state schema or API change is approved. A newly discovered incompatibility returns before editing it.
Plan closure never supplies missing native, live or deployment evidence.

Interactive OAuth, new execution backends, external publication/gates, host-loss and deployed/hardware acceptance
remain intentionally outside this release. No available credential is assumed; controlled fixtures establish only
local integration. No missing evidence may be relabeled as passed to close the specification.

## References

The [core contract](2026-11-05-task-contracts-and-evidence.md),
[state contract](2026-11-05-persistent-state-and-admission.md) and
[Pi adapter contract](2026-11-05-isolated-pi-adapter.md) define the existing boundaries consumed here.
The [state guide](../docs/state.md), [acceptance guide](../docs/evidence.md) and
[Pi adapter guide](../docs/pi-adapter.md) provide their operational evidence limits.
