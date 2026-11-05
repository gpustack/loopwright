# Spec: Task contracts and evidence-bound acceptance

Status: Shipped
Type: Feature

## Summary

Add the first Loopwright TypeScript package for frozen task contracts, artifact identity, and explicit acceptance results.
Callers can validate inputs, obtain stable identities, and assess required checks against trusted evidence.
A model answer, an empty result list, or a digest alone cannot establish success.
This package is a foundation for a later controller, Pi adapter, CLI, taskpacks, and publisher.

## Motivation

### Goals

- Give task authors and controller developers one versioned contract with explicit limits and required checks.
- Preserve the distinction between passed, failed, blocked, and unrun checks.
- Bind results to the exact task, source, candidate, and target matrix that were verified.
- Make incomplete or stale evidence visible without promoting it to success.
- Keep authority with the trusted host. Model output is an untrusted candidate.
- Establish a small, installable TypeScript project with reproducible local verification.

### Non-Goals

- Execute agents, tools, shell commands, task graphs, external gates, or GitHub operations.
- Implement a database, budget ledger, lease, sandbox, credential broker, or crash recovery.
- Implement YAML authoring, a CLI, remote storage, a GitHub App, or image/hardware validation.
- Adopt pi-durable, install Pi, or make live model calls for this package.
- Add GitHub Actions workflows or CI/CD configuration.
- Claim that lexical path validation provides filesystem containment or that hashes authenticate a producer.

## Proposal

Provide a public library boundary that accepts untrusted JSON data and returns validated, immutable domain values.
Use a versioned alpha contract. Reject unsupported versions and unknown policy fields instead of ignoring them.
Keep authoring input separate from an admitted task lock and from observations made during a run.
Only a trusted host can supply the expected admission identity and eligible verifier evidence.

The library does not decide that a caller is trusted. Its API must make that caller responsibility explicit.
It must never turn an actor-supplied object into eligible verification evidence merely because its schema is valid.

### User Stories

#### Story 1
As a task author, I want invalid scope, graph, role, and budget configuration rejected before execution.
This prevents a task from starting with ambiguous permissions or unlimited work.

#### Story 2
As a controller developer, I want a frozen task identity and explicit evidence bindings.
This prevents a result from another candidate, source revision, or target matrix from satisfying the current task.

#### Story 3
As an operator, I want missing and failed checks shown separately.
This lets me distinguish incomplete verification from a completed update.

#### Story 4
As an adapter developer, I want reported, estimated, and unknown usage represented separately.
This prevents a lost provider receipt from appearing as zero cost or a new budget.

### Core Features & Acceptance Criteria

#### A01: Versioned validated contracts

- Define TaskContract, TaskLock, ArtifactManifest, Evidence, VerificationResult, and RunResult domain contracts.
- Use apiVersion `loopwright.dev/v1alpha1` for the admitted task format and document version rules for other artifacts.
- Preserve the public hierarchy `metadata` and `spec`; avoid a second top-level inventory that repeats spec fields.
- Validate external objects and JSON text at the boundary. Return stable machine-readable error codes and field locations.
- Reject unsupported versions, unknown fields in closed records, malformed identifiers, invalid enum values, and wrong scalar types.
- Do not coerce strings to numbers, discard unknown permissions, or populate permissive policy defaults.
- Parsed values own their data. Later mutation of the input or returned nested collections cannot change a frozen lock.
- Errors must not echo raw input, prompts, credential values, or arbitrary payload fragments.

#### A02: Explicit task scope, roles, limits, and graph

- A task records its goal, taskpack identifier, target repository, destination base revision, and candidate source identity, writable/protected scope, and required acceptance IDs.
- Repository and source identity are data; validation performs no Git or network lookup.
- Roles identify an adapter, exact provider/model request, thinking setting, and explicit tool allowlist. Exact tool names support MCP double underscores and preserve case and bytes.
- Trusted context identifies an admitted revision and explicit resource inventory. Untrusted context discovery is not enabled by default.
- Budgets include finite positive wall time, total token allowance, per-call output allowance, model-call cap, and concurrency cap.
- Format repair, implementation repair, and transport retry caps are independent explicit non-negative integers.
- Each cap uses the shared parent model-call/token allowance. Zero disables that facility without resetting or reserving a parent budget.
- Numeric counters must be safe integers. Reject NaN, infinities, negative quantities, overflow, and inconsistent child/parent limits.
- Budget metadata distinguishes hard-admission requirements from soft accounting. A validated configuration does not certify adapter capability.
- Steps have unique IDs, known dependencies, known roles where required, and an acyclic graph. Reject missing references and duplicate edges.
- Acceptance IDs are unique and nonempty. Optional checks may exist, but cannot replace required checks.
- Define and test lexical repository-relative scope rules. Reject absolute paths, parent traversal, NUL, and platform-ambiguous forms.
- Document the supported path-pattern grammar. Reject unsupported patterns rather than guessing their meaning.
- Protected paths take precedence over writable paths in any exported scope-membership helper.
- Lexical checks do not resolve symlinks. Actual filesystem and process containment belongs to a later execution boundary.

#### A03: Stable task and artifact identity

- Produce a deterministic task lock from validated contract data and trusted admission identity.
- The lock binds schema version, repository, base/source revision, contract contents, and required acceptance set.
- Document the canonical JSON rules and hash domain. Reordered object properties preserve the same contract hash.
- Meaningful permission, budget, model, source, or acceptance changes produce a different contract hash.
- Preserve ordered arrays where order is meaningful. Do not silently normalize a changed plan into the old identity.
- Reject unsupported values, cyclic programmatic inputs, duplicate JSON member names, and excessive size/depth before expensive traversal.
- Artifact identity uses a byte digest with declared algorithm and byte length. Do not hash decoded or reformatted content as original bytes.
- Artifact manifests use normalized relative names and reject duplicate names or ambiguous entries.
- Separate content hashes from evidence authorization. Matching hashes never make an untrusted producer a verifier.

#### A04: Evidence binding and provenance

- Evidence records identify the observation, producer, method, artifact references, and subject binding.
- Verification evidence identifies the acceptance check and its observed outcome. A generic matching artifact is not evidence that a check passed.
- Subject binding includes contract hash, source revision, candidate digest, and target-matrix identity where applicable.
- Represent evidence levels explicitly: static inspection, synthetic fixture, local execution, external service, and hardware execution.
- Each required check declares its allowed evidence level or levels. Do not infer a universal ordering between these levels.
- Fixture evidence cannot satisfy a requirement for hardware execution or an external service.
- A verification function receives expected identity and eligible evidence from its trusted caller, separately from candidate verdict data.
- Reject missing, stale, mismatched, duplicate, or contradictory bindings. A supplied `passed` flag does not override these checks.
- Reference resolution and exact-byte digest checks must be possible without opening arbitrary filesystem paths or fetching URLs.
- Keep evidence data serializable. Do not embed secrets, full sessions, executable callbacks, or ambient global configuration.

#### A05: Deterministic acceptance coverage

- Every required check appears exactly once in the evaluated matrix as passed, failed, blocked, or not_run.
- A missing required check becomes not_run with an explicit reason. An empty submitted matrix never means success.
- Preserve failed and blocked observations. Do not repair them through a schema default or model claim.
- Missing eligible evidence for a claimed pass prevents that pass and produces a diagnostic bound to the check ID.
- Reject duplicate or contradictory submissions. Extra optional checks cannot hide a missing required check.
- A nonempty required set is satisfied only when every required row passes with matching eligible evidence.
- Results include the subject identity and remain deterministic for the same inputs. Ordering and error precedence are documented.
- Malformed input and an honestly failed verification are distinct outcomes; callers need not parse prose to distinguish them.

#### A06: Honest run outcome and usage representation

- Run status vocabulary is completed, no_change, blocked, exhausted, expired, cancelled, failed, or reconcile_required.
- Keep lifecycle status, business acceptance, and memory-proposal status separate.
- Reject a completed result when its required acceptance matrix is incomplete or not satisfied.
- Construct acceptance from trusted inputs for the same expected lock. An actor-supplied embedded matrix or serialized type brand is not trusted proof.
- no_change requires an explicit verified no-change reason and its own completed applicable acceptance; it is not an empty-result shortcut.
- Unknown external-effect status is represented as reconcile_required; it cannot be silently converted to cancelled or failed.
- Model/session completion is an observation, not sufficient evidence for completed business acceptance.
- Represent token components and costs with explicit reported, estimated, or unknown provenance.
- An unknown component remains unknown. An aggregate cannot present a known total that excludes unquantified requests without marking it partial.
- Do not implement budget spending or settlement here. These values only define the later ledger's interface requirements.
- Memory outcomes can remain pending or unavailable without rewriting the primary task's verification result.

#### A07: Bounded inputs and reproducible local checks

- Set and document finite limits for input bytes, nesting depth, strings, collection sizes, graph nodes/edges, and artifact manifests.
- Reject inputs beyond those limits deterministically; avoid recursive stack exhaustion and accidental quadratic graph traversal.
- Provide behavioral tests for malformed, conflicting, stale, oversized, and adversarial inputs through the public boundary.
- Include an end-to-end library fixture: author contract, lock it, bind candidate artifacts, evaluate evidence, and construct an honest RunResult.
- Include negative variants for an actor's fake pass, missing check, stale digest, changed source, wrong evidence level, and unknown usage.
- Document reproducible commands, actual environment, and measured test boundaries. No model, GPU, or deployed service is required for S01.

### Notes / Constraints / Caveats

- Start with TypeScript on Node.js, using ESM and strict type checking. Keep the dependency set small and lock it.
- The repository has no existing implementation or package conventions. Establish one core package before splitting additional packages.
- The initial public package is private/unpublished. This spec does not authorize registry publication.
- The exact schema fields, exported function signatures, error taxonomy, size limits, and hash rules must be fixed in the implementation plan.
- Pure validation and evaluation should not depend on Pi or remote services.
- Local feasibility probes used Pi SDK 1.5.0. Both requested model/thinking pairs were observable in session configuration and outbound requests.
- Those probes establish neither provider-internal reasoning behavior nor a hard billing guarantee.
- A live interrupted call had no final usage receipt. A local duplicate-owner experiment executed a task twice.
- These observations require explicit unknown/evidence/identity semantics; they do not establish any Loopwright recovery implementation.
- An installed package may differ from a source revision with the same advertised version. Record artifact integrity separately from source commit.

### Boundaries

- **Always:** Validate untrusted input, preserve evidence limits, and make all required-check outcomes explicit.
- **Always:** Keep state, publication authority, and actual execution outside this library.
- **Ask first:** Changes to the accepted outcome vocabulary, weakened evidence requirements, or expansion into execution and publication.
- **Never:** Treat a model assertion as trusted evidence, hide unknown usage, publish packages, push Git refs, or add CI/CD workflows.

### Risks and Mitigations

- False success from missing checks → evaluate the full required set and deny success on any non-passing row.
- Stale or substituted evidence → bind eligible evidence to the trusted current subject identity.
- Digest confused with authorization → expose separate content and producer-trust inputs; document the caller's obligation.
- Schema becomes an execution framework → limit this spec to contracts, pure evaluation, identity, and examples.
- Hash drift across parsing or serialization → define the canonical domain and cover independent order/byte-change cases.
- Malicious JSON or programmatic objects → enforce resource bounds and reject unsupported values without evaluating getters or custom serialization hooks.
- Usage loss hidden by aggregation → preserve unknown requests and partial-total provenance.
- Path checks mistaken for sandboxing → document lexical scope only; defer filesystem and OS enforcement to the execution spec.
- Premature schema compatibility promises → use a single explicit alpha version and reject unknown policy semantics.

## Design Details

### Commands

The following local commands must exist after implementation. They are requirements, not claims about an existing build system.

```sh
npm ci
npm run build
npm run typecheck
npm run lint
npm test
```

Pin the tested Node and package-manager environment in the plan and contributor documentation.
The coordinator's available host uses Node v26.13.0 on macOS arm64. S01 must run without credentials or network after installation.

### Project Structure

- `packages/core/src/`: public contracts, validation, identity, and acceptance evaluation.
- `packages/core/test/`: behavioral and integration tests for public entrypoints.
- `examples/`: small JSON fixtures showing satisfied, failed, missing, and unknown outcomes.
- `docs/`: schema/identity/evidence trust boundary and local development instructions.
- `specs/`: versioned specifications.
- Root package and TypeScript configuration: one reproducible development entrypoint.

These are proposed implementation locations, not references to existing files.
The plan may consolidate small modules while preserving the public boundary.

### Code Style

Use named exports, explicit domain types, stable error codes, and functions with explicit inputs.
Do not access process environment, clock, filesystem, or network inside pure evaluation functions.
There is no pre-existing project snippet. This valid TypeScript example states the intended style:

```ts
export type CheckStatus = "passed" | "failed" | "blocked" | "not_run";

export function isPassing(status: CheckStatus): boolean {
  return status === "passed";
}
```

Use readonly types for public values and runtime immutability for frozen contracts.
Return typed validation diagnostics for ordinary malformed data; do not make callers parse exception text.

### Approved contract design

### Package and maintenance choices

Create one private npm workspace, @loopwright/core, with ESM and strict TypeScript.
Use Node's test runner and node:assert/strict.
Use TypeScript, @types/node, ESLint, @eslint/js, and typescript-eslint as development dependencies only.
Resolve exact compatible development versions during bootstrap, save exact versions, and commit the lockfile.
Do not install a schema library, test framework, Pi SDK, or runtime dependency.
A small bounded JSON reader is necessary because JSON.parse alone cannot reject duplicate member names.
Keep that reader separate from schema validation, with direct negative tests.

Document Node v26.13.0 and npm 11.20.0 as the tested environment.
Set packageManager to npm@11.20.0.
Use engines matching Node 26 and npm 11; do not claim older-version qualification.
The package remains private and unpublished.

Root scripts:
- build: tsc -p packages/core/tsconfig.json
- typecheck: tsc -p tsconfig.test.json --noEmit
- lint: eslint .
- test: tsc -p tsconfig.test.json && node --test .test-build/packages/core/test/*.test.js

Use root tsconfig.json for strict shared options.
Use packages/core/tsconfig.json to emit src to packages/core/dist.
Use tsconfig.test.json to compile source and tests into .test-build.
Use .js extensions in TypeScript relative imports.
Enable strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, useUnknownInCatchVariables, and declaration emission for the library.
Ignore node_modules, dist, .test-build, coverage, and root .claude scratch.
Use .claude/* with exceptions !.claude/skills and !.claude/settings.json.
Reports, handoffs, and worktrees remain ignored; this task never stages local coordination records.
Do not add CI configuration.

Maintenance bill:
- A hand-written JSON reader needs dedicated grammar, duplicate-key, Unicode, depth, and size tests.
- Strict alpha records require a new supported version or an explicit additive schema change for new fields.
- Whole-byte hashing is intentionally bounded; streaming large artifacts is a later extension.
- No runtime dependency or adapter capability is implied by a valid contract.

### Input domain, diagnostics, and immutability

All public validation/evaluation boundaries accept unknown input.
A string at a document boundary means JSON text.
Otherwise the supported domain is an acyclic JSON tree of primitives, ordinary arrays, and ordinary or null-prototype records.
Every own property must be an enumerable data property, except array length.
Reject accessor properties, symbol keys, sparse arrays, extra array properties, functions, undefined, bigint, class instances, non-finite numbers, negative zero, cycles, and shared object aliases.
Reject own toJSON functions as unsupported values without calling them.
Reject inherited policy data through prototype checks.
Return owned, deeply frozen records and arrays.

Use descriptors to inspect object values.
Do not read arbitrary input properties directly and do not call custom serialization.
Use iterative traversal with fixed counters.
Enumerate own keys once per record, check the count before reading descriptors/children, then visit bounded keys deterministically.
The library cannot bound allocation already performed by the caller or the engine's initial own-key enumeration.

Proxies and concurrent hostile mutation are outside the supported object-input domain.
JavaScript cannot reliably identify arbitrary proxies without running proxy traps.
Catch reflection failures and return a fixed INPUT_UNSUPPORTED diagnostic.
Do not claim this same-process API isolates hostile code.
Use JSON text across a process or trust boundary when that distinction matters.
Built-in prototype tampering is also outside this library's threat boundary.

Public result convention:
- Result<T> = { ok: true, value: T } | { ok: false, errors: readonly Diagnostic[] }.
- Diagnostic = { code: DiagnosticCode, path: string, checkId: string | null }.
- Validation returns one deterministic first error.
- Evaluation can succeed as an API operation while returning satisfied=false and per-check diagnostics.
- Ordinary failed/blocked/not_run checks are valid domain observations, not malformed input.
- Never include raw values, arbitrary property names, exception text, prompts, or payload fragments in errors.
- Paths are JSON Pointers made from known schema field names and numeric indexes.
- Claims use /claims in evaluateAcceptance and /candidate/checks in constructRunResult.
- Usage uses /trusted/usage in construction and /spec/usage/requests in serialized RunResult validation.
- aggregateUsage takes an array directly: its empty root pointer and numeric indexes refer to that array.
- The separate byte-inventory argument uses the reserved /artifacts namespace.
- For an unknown key, report its containing record path rather than echoing the unknown key.
- checkId is populated only for a validated identifier belonging to the admitted check set.

Error families are fixed named codes, not prose:
INPUT_TYPE, INPUT_UNSUPPORTED, INPUT_CYCLE, INPUT_ALIAS, LIMIT_BYTES, LIMIT_DEPTH, LIMIT_STRING, LIMIT_COLLECTION, LIMIT_NODES, JSON_SYNTAX, JSON_DUPLICATE_MEMBER, VERSION_UNSUPPORTED, KIND_MISMATCH, FIELD_REQUIRED, FIELD_UNKNOWN, VALUE_TYPE, VALUE_ENUM, VALUE_RANGE, IDENTIFIER_INVALID, PATH_INVALID, PATTERN_UNSUPPORTED, DUPLICATE_ID, DUPLICATE_EDGE, REFERENCE_UNKNOWN, GRAPH_CYCLE, LIMIT_GRAPH_NODES, LIMIT_GRAPH_EDGES, BUDGET_INCONSISTENT, HASH_MISMATCH, MANIFEST_AMBIGUOUS, IDENTITY_MISMATCH, EVIDENCE_DUPLICATE, EVIDENCE_CONTRADICTORY, ARTIFACT_DUPLICATE, LIMIT_ARTIFACT_BYTES, LIMIT_RESOLVED_BYTES, USAGE_OVERFLOW, RUN_ACCEPTANCE_REQUIRED, RUN_NO_CHANGE_REQUIRED, RUN_RECONCILIATION_REQUIRED.
Coverage diagnostics use CHECK_MISSING, EVIDENCE_MISSING, EVIDENCE_LEVEL_DISALLOWED, ARTIFACT_MISSING, ARTIFACT_LENGTH_MISMATCH, and ARTIFACT_DIGEST_MISMATCH.

### Exact schema conventions

Every persisted document has exactly:
- apiVersion: literal loopwright.dev/v1alpha1.
- kind: one of TaskContract, TaskLock, ArtifactManifest, Evidence, VerificationResult, RunResult.
- metadata: exactly { id: Identifier }.
- spec: the kind-specific closed record below.

All six kinds use the same alpha apiVersion.
Reject any unsupported version or unknown field.
No optional policy fields and no permissive defaults exist.
Nullable fields are explicitly present and use null.
All number fields are safe integers; each field has the range stated below.
Strings must contain valid Unicode scalar values; reject unpaired UTF-16 surrogates.
Arrays retain author order in identities.
Every record below is closed, including nested records.

Shared scalar shapes:
- Identifier: 1-64 ASCII characters; [a-z][a-z0-9]*(?:[._-][a-z0-9]+)*.
- ToolName: 1-128 ASCII bytes; [A-Za-z_][A-Za-z0-9_]*(?:[.:-][A-Za-z0-9_]+)*.
  This separate external-name grammar permits consecutive underscores, including mcp__probe__allowed.
  Preserve exact case and bytes; never trim, rename, expand, or normalize a tool name.
  Examples: read, bash, repo.read, mcp__probe__allowed, and MCP__Probe__Allowed.
  Reject whitespace, controls, wildcards, braces, brackets, dollar/backtick expansion, slash, backslash,
  leading digits, leading dot/colon/hyphen, empty separator segments, and trailing dot/colon/hyphen.
  Internal Identifier keeps its original grammar and does not gain double underscores.
- Revision: 1-128 ASCII characters; [A-Za-z0-9][A-Za-z0-9._:/-]*.
  Revisions are opaque identities. The host must supply immutable admitted revisions.
- Repository: 1-256 ASCII characters; [A-Za-z0-9][A-Za-z0-9._/-]*.
  This is an identity, not a URL, filesystem path, or authorization decision.
- Label: nonempty printable string, at most 128 UTF-16 code units, excluding whitespace and Unicode category C.
  Category C includes controls, format characters, surrogates, private-use, and unassigned code points.
  Printable letters, symbols, and combining marks remain exact and are never normalized.
- Digest: exactly { algorithm: "sha256", hex: 64 lowercase hexadecimal characters }.
- ArtifactRef: exactly { name: RelativeName, digest: Digest, byteLength: nonnegative safe integer }.
- CheckStatus: passed | failed | blocked | not_run.
- EvidenceLevel: static_inspection | synthetic_fixture | local_execution | external_service | hardware_execution.

#### TaskContract

metadata.id identifies the authored task.
spec has exactly:
- goal: nonempty string, maximum 4,096 characters.
- taskpack: Identifier.
- target: { repository: Repository, baseRevision: Revision, sourceRevision: Revision, matrix: null | TargetCell[] }.
  baseRevision identifies the destination baseline against which the candidate change is considered.
  sourceRevision identifies the source tree from which the candidate was derived.
  Both are explicit immutable identities selected by the host; they may be equal.
  Validation does not resolve Git refs, inspect ancestry, or perform filesystem/network lookup.
- scope: { writable: ScopePattern[], protected: ScopePattern[] }.
- roles: Role[].
- trustedContext: { revision: Revision, discovery: "disabled", resources: ContextResource[] }.
- budgets: Budgets.
- steps: Step[].
- acceptance: { required: Identifier[], checks: CheckRequirement[] }.

TargetCell = { id: Identifier, platform: Label, variant: Label }.
Matrix, when present, has 1-64 cells with unique IDs.
Null explicitly means no target matrix.
Writable has 1-128 patterns; protected has 0-128 patterns.
Role = { id: Identifier, adapter: Label, provider: Label, model: Label, thinking: Label, tools: ToolName[] }.
Roles have 1-64 unique IDs.
Tool allowlists contain 0-128 unique exact ToolName values; no wildcards or expansion.
Reject exact duplicate names; differently cased names remain distinct exact requests.
Do not weaken internal task/role/check/action IDs to accommodate runtime tool names.
Provider/model/thinking values are exact requests, not adapter capability certification.

ContextResource = { id: Identifier, kind: "instruction" | "skill" | "document", path: RelativeName, digest: Digest }.
Resources have 0-128 entries with unique IDs and normalized names.
No discovery or environment expansion is enabled.

Budgets has:
- wallTimeMs, totalTokens, perCallOutputTokens, maxModelCalls, maxConcurrency: positive safe integers.
- maxFormatRepairs, maxImplementationRepairs, maxTransportRetries: nonnegative safe integers.
  Zero disables that facility independently of the other caps.
- enforcement: { wallTime, tokens, modelCalls, concurrency, formatRepairs, implementationRepairs, transportRetries }.
Each enforcement value is hard_admission | soft_accounting.
The tokens mode covers total and per-call output allowances.
Require perCallOutputTokens <= totalTokens and maxConcurrency <= maxModelCalls.
Each of maxFormatRepairs, maxImplementationRepairs, and maxTransportRetries must be <= maxModelCalls.
Reject an unsafe integer, negative value, overflow, or an individual cap above the model-call parent.
These independent caps are upper bounds, not reserved slices of maxModelCalls or totalTokens.
Their sum may exceed maxModelCalls; execution must stop at whichever applicable bound is reached first.
Any provider request initiated by format repair, implementation repair, or transport retry draws from the same
parent maxModelCalls and totalTokens allowance; none creates a fresh parent allowance.
A future executor must count every admitted provider request attempt, including a retry, toward that shared call cap.
For example, maxModelCalls=10 and repair/retry caps of 6 each do not authorize 18 requests.
The library validates configuration only and does not implement counters, reservations, retries, or repairs.
Do not multiply per-call caps into a claim that the parent token allowance covers every possible call.
Do not implement spending, admission, provider capability checks, or billing guarantees.

Step = { id: Identifier, kind: "agent" | "check", uses: Identifier, roleId: Identifier | null, dependsOn: Identifier[] }.
Steps have 1-256 unique IDs.
Agent steps require a roleId; any non-null roleId must refer to a known role.
Check steps may use null to represent a later deterministic taskpack verifier.
uses is a taskpack action identity, never a command or executable callback.
Dependencies must name known steps, contain no duplicates, and form an acyclic graph.
Use iterative Kahn traversal with adjacency lists, O(V+E).
The library validates the graph; it does not execute it or resolve taskpack registrations.

CheckRequirement = { id: Identifier, allowedEvidenceLevels: EvidenceLevel[] }.
Checks have 1-256 unique IDs and 1-5 unique allowed levels.
Required contains 1-256 unique IDs, each declared in checks.
Declared checks outside required are optional; unknown submitted checks are malformed.

#### TaskLock

metadata.id is the trusted admissionId.
spec = { runId: Identifier, contract: TaskContract, contractHash: Digest, lockHash: Digest }.
admitTask receives { admissionId: Identifier, runId: Identifier } separately from the author contract.
Validation recomputes both hashes; an input lock's stored digest is never accepted without recomputation.
A parsed lock remains ordinary serializable data, not a trust capability.
The caller must obtain the expected lock from trusted admission state.
Freezing a lock or parsing a serialized brand cannot authenticate it.

#### ArtifactManifest

metadata.id identifies the manifest.
spec = { entries: ArtifactRef[] }.
Entries contain 0-256 normalized relative file names.
Reject duplicate names, ASCII case-fold collisions, and file/descendant conflicts such as a and a/b.
Retain entry order in manifest identity.
An empty candidate manifest can describe no output, but cannot establish no_change or successful acceptance.
Declared byteLength may use any nonnegative safe integer.
The bounded whole-byte helpers and evaluator only consume the byte limits below.
This does not claim large image/weight artifact verification.

#### Subject and Evidence

Subject = {
  lockHash: Digest,
  contractHash: Digest,
  repository: Repository,
  baseRevision: Revision,
  sourceRevision: Revision,
  candidateDigest: Digest,
  targetMatrixDigest: Digest | null
}.
candidateDigest is the canonical ArtifactManifest identity, not a reformatted patch hash.
Each manifest entry separately identifies its original bytes.

Evidence metadata.id is a unique observation ID.
spec = {
  checkId: Identifier,
  observedStatus: CheckStatus,
  producerId: Identifier,
  method: Identifier,
  level: EvidenceLevel,
  subject: Subject,
  artifacts: ArtifactRef[],
  reason: string | null
}.
Artifacts have 0-256 references; a passed observation must have at least one.
A failed, blocked, or not_run observation requires a nonempty bounded reason.
A passed observation uses reason=null.
Evidence for not_run may describe an explicit absence; it does not count as a pass.
Producer/method identities and content hashes do not authenticate a producer.

#### Claims and VerificationResult

SubmittedCheck = { checkId: Identifier, status: CheckStatus, evidenceId: Identifier | null, reason: string | null }.
Passed submissions use reason=null; other statuses require a nonempty bounded reason.
not_run requires evidenceId=null.
A pass may omit evidenceId only so evaluation can explicitly report EVIDENCE_MISSING and blocked.
This is not a schema default.
Candidate input cannot contain a VerificationResult or a satisfied/passed matrix field.

VerificationResult metadata.id equals the expected admissionId.
spec = {
  subject: Subject,
  required: EvaluatedCheck[],
  optional: EvaluatedCheck[],
  satisfied: boolean,
  diagnostics: Diagnostic[]
}.
EvaluatedCheck = { checkId, status, evidenceId, reason, detail }.
checkId/status/evidenceId use the types above.
reason is one of observed_pass, submitted_failed, submitted_blocked, submitted_not_run,
missing_submission, missing_evidence, evidence_level_disallowed, artifact_missing,
artifact_length_mismatch, artifact_digest_mismatch.
detail is the validated bounded submitted reason for non-passes, or null.
Missing/invalid pass evidence becomes blocked with a fixed reason and check-bound diagnostic.
A missing required submission becomes not_run with reason=missing_submission.
Required rows use contract acceptance.required order.
Optional rows use contract acceptance.checks order and include only submitted optional checks.
Required is always nonempty, and satisfied is true only when every required row passed.
An optional pass cannot cover a missing required check.

#### Usage

RequestUsage = {
  requestId: Identifier,
  inputTokens: Quantity,
  outputTokens: Quantity,
  costMicrousd: Quantity
}.
Quantity is exactly { provenance: "reported" | "estimated", value: nonnegative safe integer }
or exactly { provenance: "unknown" }.
Unknown cannot carry value=0.
Request IDs are unique; input and output quantities must already be normalized without provider category overlap.
Cache/reasoning normalization and missing-request discovery belong to the later adapter/ledger.

UsageSummary = {
  requests: RequestUsage[],
  inputTokens: Aggregate,
  outputTokens: Aggregate,
  totalTokens: Aggregate,
  costMicrousd: Aggregate
}.
Aggregate = {
  knownSubtotal: nonnegative safe integer,
  unknownCount: nonnegative safe integer,
  completeness: "complete" | "partial",
  provenance: "reported" | "estimated" | "unknown"
}.
Compute aggregates; never accept caller-provided totals as authority.
For totalTokens, unknownCount counts unknown input/output components.
For the other aggregates, unknownCount counts unknown components of that metric.
Partial means unknownCount > 0.
Provenance is estimated when any known component is estimated.
Otherwise it is reported when any known component exists.
It is unknown when the metric has observations but all are unknown.
An empty trusted request inventory is a complete reported zero; the host is responsible for inventory completeness.
Reject safe-integer overflow before summing.
No quota reservation, balance, settlement, or price lookup exists here.

#### RunResult

Status is exactly completed | no_change | blocked | exhausted | expired | cancelled | failed | reconcile_required.
MemoryObservation = { status: "not_requested" | "pending" | "proposed" | "unavailable", reason: string | null }.
Pending and unavailable require a nonempty bounded reason.
No memory observation can change verification satisfaction.

NoChangeVerification = {
  checkId: Identifier,
  evidenceId: Identifier,
  reason: "candidate_equals_source" | "no_applicable_update"
}.
This input is selected by the trusted host.
Its check must be required and passed in the computed matrix.
Its evidence must match that check and subject, and use method=verify_no_change.
The host is responsible for collecting the actual no-change observation; schema shape cannot prove it.

RunResult metadata.id equals the lock's runId.
spec = {
  status: RunStatus,
  subject: Subject,
  verification: VerificationResult,
  usage: UsageSummary,
  externalEffects: "none" | "confirmed" | "unknown",
  noChange: NoChangeVerification | null,
  memory: MemoryObservation
}.
A completed result requires satisfied=true and noChange=null.
A no_change result requires satisfied=true and a valid trusted NoChangeVerification.
Other statuses cannot carry a noChange proof.
If trusted externalEffects=unknown, only reconcile_required is permitted.
For other effects states, reconcile_required remains permitted as a conservative host-selected status.
Completed and no_change cannot coexist with unknown effects.
Failed/blocked/exhausted/expired/cancelled may preserve an incomplete or even passing verification matrix.
Lifecycle and business acceptance remain separate.

Parsing serialized VerificationResult/RunResult checks structure and internal arithmetic/coverage consistency only.
It does not certify evidence eligibility.
constructRunResult always recomputes verification using the expected lock and current trusted evidence.
It never accepts a precomputed matrix, boolean, symbol brand, or actor-supplied result as a substitute.

### Hash and byte rules

Use SHA-256 from node:crypto.
Hash only validated owned data; do not stringify arbitrary caller objects.
Canonical JSON uses:
- No insignificant whitespace.
- Object keys sorted by UTF-16 code-unit order.
- Arrays in original order, including all permission, requirement, step, and manifest arrays.
- Standard JSON string escaping for valid Unicode scalar values.
- Safe-integer decimal representation only; no negative zero.
- null, true, and false as their literal spellings.
- No undefined, bigint, function, accessors, custom classes, symbols, cycles, or aliases.

These are a restricted canonical domain, not a claim to support every RFC 8785 number.
Property order is irrelevant; array order is deliberately meaningful.
Use explicit UTF-8 domain prefixes including their terminating NUL:
- contractHash: sha256("loopwright.dev/task-contract/v1alpha1\0" || canonical(TaskContract)).
- lockHash: sha256("loopwright.dev/task-lock/v1alpha1\0" || canonical({ admissionId, runId, contractHash })).
- candidateDigest: sha256("loopwright.dev/artifact-manifest/v1alpha1\0" || canonical(ArtifactManifest)).
- targetMatrixDigest: null when matrix=null; otherwise sha256("loopwright.dev/target-matrix/v1alpha1\0" || canonical(matrix)).
- ArtifactRef.digest: sha256(original bytes), with no JSON transformation or domain prefix.
- ArtifactRef.byteLength: original byte count.

Contract contents already bind repository, baseRevision, sourceRevision, matrix, policy, and required IDs.
Changing only baseRevision while retaining sourceRevision and candidate bytes changes contractHash and lockHash.
It leaves the original-byte candidate manifest identity unchanged but invalidates evidence for the old subject.
Changing either independent repair cap or an exact ToolName value/order also changes contractHash and lockHash.
The lock adds admission/run identity to prevent reuse across identical-contract runs.
Use independent fixed byte/hash vectors and a pinned canonical text fixture in tests.
Do not hash decoded or reformatted artifact content.

### Scope grammar

RelativeName is a nonempty POSIX relative name, maximum 1,024 characters and 64 segments.
Each segment contains only ASCII letters, digits, dot, underscore, or hyphen.
Reject empty segments, dot, dot-dot, NUL, controls, whitespace, percent escapes, colon, backslash, absolute forms, and trailing slash.
Reject trailing-dot segments and case-insensitive Windows device names, including names with extensions.
Names are not decoded, case-folded, normalized, or silently rewritten.

ScopePattern is either a RelativeName, a RelativeName followed by /**, or **.
No other wildcard, brace, bracket, question-mark, or negation syntax is supported.
dir/** matches dir and descendants of dir; ** matches every valid RelativeName.
Matching is case-sensitive and lexical.
A protected match always wins over any writable match.
An invalid candidate name produces a diagnostic, not a writable answer.
This is not symlink, filesystem, mount, process, or case-insensitive-host containment.

### Public API

The public root export contains these functions and readonly domain types.
All malformed-data outcomes use Result; no ordinary validation error requires catching an exception.

- validateDocument<K extends DocumentKind>(input: unknown, kind: K): Result<DocumentByKind[K]>.
  Shape and internal consistency validation only; never admission or verifier authority.
- admitTask(contract: unknown, admission: unknown): Result<TaskLock>.
  admission has exactly { admissionId, runId }.
- digestArtifact(name: unknown, bytes: Uint8Array): Result<ArtifactRef>.
  Byte API supports ordinary Uint8Array and Node Buffer, copied into owned bytes before hashing.
  Reject SharedArrayBuffer-backed, detached, or unsupported views.
  Use intrinsic typed-array brand, buffer, offset, and length access; never invoke shadowed instance getters or methods.
  This byte leaf is the only exception to the JSON-tree input domain.
- identifyManifest(input: unknown): Result<{ manifest: ArtifactManifest, digest: Digest }>.
- bindSubject(expectedLock: unknown, candidateManifest: unknown): Result<Subject>.
  Derive all fields from the revalidated lock and manifest.
- isWritablePath(contract: unknown, path: unknown): Result<boolean>.
- aggregateUsage(input: unknown): Result<UsageSummary>.
  input is the bounded RequestUsage array.
- evaluateAcceptance(input: unknown, artifacts: readonly ResolvedArtifact[]): Result<VerificationResult>.
- constructRunResult(input: unknown, artifacts: readonly ResolvedArtifact[]): Result<RunResult>.

ResolvedArtifact = { name: RelativeName, bytes: Uint8Array }.
It is a caller-provided, already-loaded inventory, not a path or URL resolver.
Inspect inventory descriptors and byte-view type; do not invoke user callbacks.
Reject duplicate normalized names and copy bounded bytes before hashing.
Candidate manifest entries and every eligible evidence reference must resolve to matching original bytes.
An unavailable or mismatched artifact prevents a pass.
If candidate bytes are unavailable or wrong, every claimed pass is blocked with the relevant artifact diagnostic.
An empty manifest has no entries to resolve.

evaluateAcceptance input is exactly:
{
  trusted: { expectedLock, candidateManifest, eligibleEvidence: Evidence[] },
  claims: SubmittedCheck[]
}.
constructRunResult input is exactly:
{
  trusted: {
    expectedLock, candidateManifest, eligibleEvidence: Evidence[],
    usage: RequestUsage[], externalEffects, noChange: NoChangeVerification | null
  },
  candidate: { status: RunStatus, checks: SubmittedCheck[], memory: MemoryObservation }
}.
These are closed, bounded input records.
No ambient trust registry, global allowlist, clock, executable callback, environment lookup, or filesystem read exists.
The trusted caller must authenticate producers and select eligible observations before calling.
Passing actor data in a trusted parameter violates the caller contract; same-process code cannot prevent that.
Neither a matching digest nor validateDocument changes eligibility.

Evidence is limited to one eligible observation per declared check in one evaluation.
Reject duplicate observation IDs, duplicate check observations, contradictory outcomes, unknown check IDs, and cross-check evidence references.
This strict initial cardinality avoids silently choosing between receipts.
A later multi-observation policy requires an explicit schema decision.
Require every supplied eligible observation to match the current subject; stale surplus evidence is malformed, not ignored.
Compare each submitted status to the eligible observation for the same check, even when evidenceId is null or unresolved.
A status conflict is malformed EVIDENCE_CONTRADICTORY at the claim's status field.
Also require any resolved evidenceId to refer to the same check and observed status.
A claimed pass with missing evidence becomes blocked.
A disallowed evidence level becomes blocked.
Failed and blocked submissions may use evidenceId=null when no eligible observation contradicts them.
An unresolved non-null reference on a failed or blocked submission is malformed REFERENCE_UNKNOWN at evidenceId.
For a claimed pass, a null or unresolved reference stays blocked with a check-bound EVIDENCE_MISSING diagnostic.
An eligible observation cannot satisfy a pass through a different unresolved reference.
If supplied evidence contradicts the submitted status, reject the input rather than silently selecting a winner.
No submission plus a trusted observation still yields not_run; the evaluator does not invent a candidate submission.

### Resource limits

| Resource | Limit |
| --- | --- |
| External document JSON UTF-8 bytes or owned object equivalent | 1,048,576 |
| Nesting depth | 64 |
| Single string, decoded UTF-16 code units | 16,384 |
| Total tree nodes per document/API control envelope | 65,536 |
| Own record properties | 128 |
| General array entries | 1,024 |
| Identifier length | 64 |
| Exact ToolName length | 128 ASCII bytes |
| Goal length | 4,096 |
| Relative name length / segment count | 1,024 / 64 |
| Roles / resources / tools per role | 64 / 128 / 128 |
| Writable / protected patterns | 128 / 128 |
| Target cells | 64 |
| Graph nodes / total edges | 256 / 2,048 |
| Declared / required / submitted checks | 256 each |
| Eligible observations | 256 |
| Manifest entries / references per observation | 256 each |
| Trusted usage request records | 1,024 |
| Explicit resolved artifact records | 512 |
| Bytes per digest helper / resolved artifact | 8,388,608 |
| Aggregate resolved bytes per evaluator call | 16,777,216 |

Limits are exported as a frozen constants record and are not caller-overridable.
For object inputs, count the canonical JSON byte equivalent during snapshotting without invoking JSON.stringify on the caller.
Reject string length, array length, depth, node, or record-key overflow before traversing descendants.
For text, check a cheap code-unit bound before counting UTF-8 bytes.
The byte budget includes parsed keys, punctuation, and primitive spellings.
All evaluation control input, including nested lock/contract, shares one document node/byte allowance.
Byte leaves use their separate per-artifact and aggregate bounds.
Account for duplicate inventory bytes before copying/hashing.
Process only bounded evidence/ref collections; cache hashes by inventory name within the call.
Graph construction and cycle detection use adjacency lists and bounded counters.
Tests exercise exact limits and one-over-limit cases, not elapsed-time thresholds.

### Deterministic order and precedence

Return one malformed-input diagnostic at the first applicable validation boundary.
For fixed entrypoint arguments, validate the control input before the resolved artifact inventory.
Run construction validates and aggregates usage before evaluating evidence or processing inventory bytes.
Nested persisted documents validate their schema and internal invariants when their parent field is visited.
For example, a bad nested lock hash precedes a malformed later claims field.
The following order applies within each validator and then to cross-document evaluation.

1. Input kind and cheap size/type limits.
2. JSON lexical/syntax/duplicate-member and structural limits in source order.
   For object inputs, use depth-first traversal with sorted record keys and ascending array indexes.
3. Envelope version, kind, then closed-record required/unknown fields.
   Visit known schema fields in the order listed in this plan.
4. Scalar, enum, number, name/pattern, and local collection validation in declared-field order.
5. Duplicate IDs/edges, missing references, graph/budget relationships.
   Check duplicate IDs before missing references, then cycles; enforce node/edge limits while building.
6. Recomputed contract, lock, manifest, and expected subject identities.
7. Duplicate eligible evidence IDs/checks, unknown checks, subject comparisons, claim/evidence outcome contradictions.
   Complete each phase across the entire collection before entering the next phase.
   Check unknown claims in submission order, then unknown observations in eligible-evidence order.
   Only then compare any subject, followed by claim status/reference consistency.
   For subjects compare lockHash, contractHash, repository, baseRevision, sourceRevision, candidateDigest, targetMatrixDigest in that order.
8. Artifact inventory duplicates/resource limits, then per-reference length and byte digest checks.
9. Coverage rows in required order, then submitted optional rows in declared-check order.
   For one pass row choose missing evidence before disallowed level, candidate artifact failures before evidence artifact failures.
   For an artifact choose missing, then wrong length, then wrong digest.
10. Run consistency: unknown effects/status conflict, no-change proof, then required acceptance satisfaction.
    No-change proof includes the eligible observation's method, not only its matrix row and reference.
    Usage validation/aggregation occurs before run consistency and cannot be bypassed by a failed lifecycle status.

Boundary resource errors can precede a schema error whose node has not yet been visited.
Object property reorder preserves valid identities; parser syntax-error positions need not match object traversal.
Do not claim every malformed JSON string has the same first error as an equivalent object.
Diagnostic paths/codes and row ordering remain stable for the same supported input.


### Implementation Plan

The task DAG covers this package. Exported API and reliability tasks require final independent review.
Small src/index.ts export additions are a shared integration edit and must be serialized.
They do not create fake semantic dependency edges between otherwise independent tasks.

- [x] T01 · Bootstrap an installable private core package
  Blocked by: None.
  Owns: package.json, package-lock.json, tsconfig.json, tsconfig.test.json, eslint.config.mjs, .gitignore,
  packages/core/package.json, packages/core/tsconfig.json, packages/core/src/index.ts,
  packages/core/test/bootstrap.test.ts, README.md.
  Acceptance: locked local install; ESM build/types/lint/test scripts run; package import/export smoke works.
  Verify: npm ci; npm run build; npm run typecheck; npm run lint; npm test.
  Checkpoint: project tooling green; no placeholder implementation counted as accepted behavior.

- [x] T02 · Bounded external input and frozen contract validation
  Blocked by: T01.
  Owns: packages/core/src/boundary.ts, diagnostics.ts, limits.ts, contracts.ts, scope.ts, graph.ts;
  packages/core/test/boundary.test.ts, contracts.test.ts, scope.test.ts, graph.test.ts, fixtures.ts;
  serialized root-export additions.
  Gate: review.
  Acceptance: TaskContract public validation rejects hostile/malformed domain input, unsafe shared-parent/independent repair budgets, invalid scope and graphs;
  exact ToolName builtin/MCP names work while wildcard/malformed/duplicate exact names fail;
  returned data is owned and frozen; no getter/toJSON invocation.
  Verify: npm exec -- tsc -p tsconfig.test.json; node --test --test-name-pattern='boundary|contract|scope|graph' .test-build/packages/core/test/*.test.js;
  then npm test and npm run typecheck.
  Checkpoint: A01/A02 plus bounded parsing portions of A03/A07.

- [x] T03 · Task locks and exact artifact identities
  Blocked by: T02.
  Owns: packages/core/src/identity.ts, artifacts.ts; packages/core/test/identity.test.ts, artifacts.test.ts;
  serialized root-export additions.
  Gate: review.
  Acceptance: stable property-order hashes, preserved array order, immutable admitted locks, admission/run separation,
  independent base/source identities and independent repair-cap/tool-name changes alter contract and lock identities;
  exact-byte digests, unambiguous manifests, derived subject identity.
  Verify: npm test; npm run build; npm run typecheck.
  Checkpoint: A03 with independent canonical and byte vectors.

- [x] T04 · Evidence-bound required-check acceptance
  Blocked by: T03.
  Owns: packages/core/src/evidence.ts, acceptance.ts; packages/core/test/evidence.test.ts, acceptance.test.ts;
  serialized root-export additions.
  Gate: review.
  Acceptance: expected base/source/lock subject and host-selected receipts drive evaluation; duplicate/stale/contradictory data rejected;
  a changed base with fixed source/candidate bytes invalidates old evidence;
  missing/failed/blocked/unrun checks remain explicit; bytes, levels, IDs and observed outcomes are enforced.
  Verify: npm test and focused behavioral/mutation RED controls, then restored npm test.
  Checkpoint: A04/A05; no generic artifact or actor passed flag can satisfy a check.

- [x] T05 · Honest usage summaries
  Blocked by: T02.
  Owns: packages/core/src/usage.ts; packages/core/test/usage.test.ts; serialized root-export additions.
  Gate: review.
  Acceptance: reported/estimated/unknown components aggregate deterministically; mixed unknowns remain partial;
  duplicate requests and overflow rejected.
  Verify: npm test; npm run typecheck.
  Checkpoint: usage portion of A06; this is independent of artifact/evidence algorithms.
  Shared index edits prohibit simultaneous application with T03/T04, though the semantic dependencies differ.

- [x] T06 · Construct results from current trusted verification
  Blocked by: T04, T05.
  Owns: packages/core/src/results.ts; packages/core/test/results.test.ts; serialized root-export additions.
  Gate: review.
  Acceptance: run construction recomputes verification; serialized/forged passed matrices rejected;
  no_change has verified reason and full acceptance; unknown effects require reconciliation; memory stays separate.
  Verify: npm test and focused forged-matrix/unknown-effect RED controls, then restored npm test.
  Checkpoint: all A06 outcome semantics.

- [x] T07 · Public fixture, examples, and complete documentation
  Blocked by: T06.
  Owns: packages/core/test/integration.test.ts,
  examples/task.json, examples/README.md, examples/satisfied.json, examples/failed.json,
  examples/missing.json, examples/unknown-usage.json,
  docs/contracts.md, docs/identity.md, docs/evidence.md, docs/development.md, README.md,
  specs/2026-11-05-task-contracts-and-evidence.md.
  Gate: review.
  Acceptance: public author-to-result flow and negative variants pass;
  examples are exercised as data by integration tests; schema/hash/trust/limits and local commands are self-contained.
  Verify: npm ci; npm run build; npm run typecheck; npm run lint; npm test; spec-content self-audit.
  Checkpoint: A01-A07 coverage matrix and exact local test boundaries recorded.

- [x] T08 · Freeze, independent review, fixes, and local ship handback
  Blocked by: T07.
  Owns: targeted fixes within the files above, assigned spec status, local review and validation records.
  Gate: review.
  Acceptance: Jev screens the actual frozen branch diff; mandatory read-only Pi review covers final scope;
  findings resolved or explicitly ruled on; all five required commands pass on exact final head.
  Verify: frozen base/head/diff hashes, review receipt and release/exit evidence, exact-head command logs,
  git status, scoped commit paths/signoffs, spec-content audit.
  Checkpoint: local reviewable branch; no merge or external mutation.

Commit groups follow completed tracer bullets; include the authorized spec in the first relevant scoped commit.
Use signed-off focused commits.
Stage explicit known paths only.
Never stage .claude scratch or local validation records.
Do not create another branch or checkout.
If a required file outside this inventory becomes necessary, obtain an explicit scope ruling.
Ordinary fixes within these files can proceed under the approved acceptance contract.



### Test Plan

[x] I/we understand the owners of the involved components may require updates to existing tests to make this
code solid enough prior to committing the changes necessary to implement this enhancement.

Prerequisite testing:
- Bootstrap built-in Node test runner, typed fixture builder, and exact exported-module import smoke test.
- Use valid baseline inputs, then alter one fact at a time.
- Use public entrypoints for acceptance assertions.
- Internal parser helpers may receive unit tests, but those cannot replace public rejection tests.
- No coverage percentage is promised before measurements exist.
- Target: every A01-A07 positive path and listed negative family exercised; report observed test counts and limits.

| Acceptance | Positive behavior | Required negative controls |
| --- | --- | --- |
| A01 | Every persisted kind round-trips as owned frozen data | Wrong version/kind/scalar/enum; nested unknown fields; missing policy; secret sentinel absent from diagnostics; mutation attempts cannot alter locks |
| A02 | Exact builtin/MCP ToolName values; roles/context; independent repair caps under shared model-call/token parents; valid bounded DAG; protected precedence | Malformed/wildcard/expansion tool names; exact duplicate tools; unknown roles/dependencies; duplicate IDs/edges; cycle/self-cycle; NaN/infinity/negative/overflow; format=0 with implementation>0 and vice versa; individual cap above parent; sum of independent caps above parent remains valid; absolute/traversal/backslash/device/unsupported pattern |
| A03 | Fixed hash vectors, key-order equivalence, byte digest, admission/run separation; equal base/source valid | Base-only change with fixed source/candidate; source-only change; independent format/implementation repair-cap change; exact ToolName/case/order change; changed permission/model/budget/required set; ordered-array changes; duplicate escaped JSON keys; cycle/alias/custom serializer/getter; Unicode edge; manifest case/prefix collision; same text different original bytes |
| A04 | Host-selected check outcome and matching base/source subject, level, and bytes | Actor receipt not supplied as eligible; another check's pass; stale lock/contract/base/source/candidate/matrix; base changed while source/candidate fixed; duplicate observation ID/check; contradictory outcome; fixture offered for hardware; missing/wrong bytes |
| A05 | Every required ID once; failed/blocked/not_run preserved | Empty matrix; missing required with optional pass; duplicate/unknown claims; pass without evidence; evidence but no submission; stable rows and reason precedence |
| A06 | Construct completed/no_change from recomputed verification; separate memory; honest aggregates | Forged serialized pass/brand; completed with incomplete matrix; unverified no_change; unknown effects plus cancelled/failed/completed; mixed unknown usage; missing price; overflow; memory unavailable does not rewrite acceptance |
| A07 | Full public library fixture, bounded near-limit documents/graphs/manifests | Every exact limit and one-over-limit; deep nested JSON and objects without stack exhaustion; dense/long bounded graph; malformed/oversized/duplicate-member input rejected without timing assumptions |

Unit coverage by package:
- @loopwright/core: 2026-11-05 planned; target 100% of exported functions and the acceptance families above.
- Measured line/branch percentage: None; there is no numerical line-coverage gate.
- Exercise public boundary, contract, scope, graph, identity, artifact, evidence, acceptance, usage, and result behavior.
- Record counts from actual Node test output; do not invent a percentage or use compiler success as behavioral evidence.

Integration tests:
- Author a contract, admit a lock, identify candidate bytes, derive subject, supply host-selected evidence/bytes,
  evaluate all required checks, and construct completed.
- Repeat with fake actor pass, absent check, stale digest, changed base only, changed source only, wrong evidence level, and unknown usage.
- For base-only change, hold sourceRevision, candidate manifest, and candidate bytes fixed; assert different contract/lock hashes and rejected old evidence.
- Also alter only evidence.subject.baseRevision with all other subject fields fixed to test the direct base comparison.
- Exercise builtin and exact MCP tool names, exact duplicate rejection, and independently disabled format/implementation repair caps.
- Test no_change with its own verified reason and same complete applicable required set.
- Test failed, blocked, exhausted, expired, cancelled, and reconcile_required result construction.
- Test example JSON through the same public entrypoints.
- Prove serialized VerificationResult cannot bypass constructRunResult.

End-to-end scope:
- The public library integration fixture is S01 end-to-end acceptance.
- It does not invoke an agent, Git, shell verifier, provider, deployment, accelerator, or operating-system sandbox.
- No broader runtime e2e result is claimed.

Behavioral RED evidence:
- Preserve a failing public-boundary acceptance assertion, not just a compilation failure.
- Use controlled temporary mutations in real production acceptance paths after the baseline is green:
  disable subject matching, allow missing required rows to satisfy, or suppress unknown usage partialness.
- Run the relevant negative controls; require assertion failures demonstrating false acceptance would be detected.
- Restore exact file bytes, rerun those controls green, and record before/after hashes and exit codes.
- No mutation remains in a commit.
- This is regression sensitivity evidence, not hostile-process security qualification.

Resource tests:
- Generate bounded fixtures for parser/array/property/string/node/depth/graph/manifest limits.
- Test exact limit and one-over-limit independently where combined limits otherwise obscure the intended case.
- Include chains and branching graphs at the supported node cap with edge cap cases.
- Use deterministic outcomes and data sizes, never wall-clock microbenchmark gates.
- Small fixed-seed input variations may exercise canonical key order and bounded graph shapes.



## Alternatives

- Start with the Pi adapter: rejected because adapter success cannot define task authority or business acceptance.
- Reuse model output directly: rejected because schema validity and a final answer do not prove tests ran.
- Rely only on hashes: rejected because a producer can hash a false statement.
- Adopt pi-durable as the state backend now: rejected because its runtime does not supply the required admission and owner guarantees.
- Design every future deployment field now: rejected because it would lock untested implementation details into the first schema.
- Accept unknown fields for convenience: rejected for policy records because misspelled restrictions would silently disappear.

## Open Questions

No user decision blocks this bounded foundation spec.
The approved design above fixes schemas, function signatures, error precedence, scope grammar, hash rules, and finite input limits.
Remote recovery, execution containment, deployed App operation, and hardware validation remain later acceptance gates.
